import { reportIncident } from "./monitoring";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";
import {
  CALLBACK_ATTEMPT_TIMEOUT_MS,
  CALLBACK_MAX_ATTEMPTS,
  callbackRetryDelayMs,
  classifyCallbackHttpStatus,
} from "./callback-policy";
import { validateCallbackUrl } from "./validation";
import { deriveCapability } from "./capabilities";
import { resolveCapabilityKey } from "./capability-keys";
import {
  completeCallbackDelivery,
  failCallbackDelivery,
  getDeliveryPayload,
  getServiceControls,
  markDeliveryWorkflowStarted,
  recordCallbackAttempt,
  recoverObservedCallbackSuccess,
} from "./repository";
import type { JsonValue } from "./types";

interface CallbackOutcome {
  disposition: "success" | "retry" | "terminal";
  status: number | null;
  error_code: string | null;
  retry_after: string | null;
}

function boundedNetworkError(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "callback_timeout";
  return "callback_network_error";
}

async function sendCallback(
  callbackUrl: string,
  callbackToken: string,
  waitId: string,
  clientReference: string | null,
  eventReceivedAt: string,
  event: JsonValue,
): Promise<CallbackOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_ATTEMPT_TIMEOUT_MS);
  try {
    // Security boundary: buyer callbacks MUST use global fetch with
    // global_fetch_strictly_public. Cloudflare enforces public destinations after
    // DNS resolution; do not substitute VPC/service bindings, sockets, or other
    // private-network-capable egress without a new security review.
    const response = await fetch(callbackUrl, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "Edgecase-Wait-Token": callbackToken,
        "Edgecase-Wait-Id": waitId,
        "Idempotency-Key": waitId,
      },
      body: JSON.stringify({
        wait_id: waitId,
        client_reference: clientReference,
        event_received_at: eventReceivedAt,
        event,
      }),
    });
    return {
      disposition: classifyCallbackHttpStatus(response.status),
      status: response.status,
      error_code: response.ok ? null : "callback_http_status",
      retry_after: response.headers.get("Retry-After"),
    };
  } catch (error) {
    return {
      disposition: "retry",
      status: null,
      error_code: boundedNetworkError(error),
      retry_after: null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class DeliveryWorkflow extends WorkflowEntrypoint<Env, DeliveryWorkflowParams> {
  async run(event: WorkflowEvent<DeliveryWorkflowParams>, step: WorkflowStep): Promise<{ status: "delivered" | "delivery_failed" }> {
    try { return await this.runDelivery(event, step); }
    catch (error) { reportIncident("worker_error", "workflow"); throw error; }
  }

  private async runDelivery(event: WorkflowEvent<DeliveryWorkflowParams>, step: WorkflowStep): Promise<{ status: "delivered" | "delivery_failed" }> {
    const waitId = event.payload.wait_id;
    if (!waitId || event.instanceId !== `delivery-${waitId}`) throw new Error("invalid_delivery_workflow_identity");

    await step.do("claim accepted event", { retries: { limit: 0, delay: 0 } }, async () => {
      const controls = await getServiceControls(this.env.DB);
      if (controls.callback_delivery_enabled !== 1) throw new Error("callback_delivery_disabled");
      await markDeliveryWorkflowStarted(this.env.DB, waitId, event.instanceId, new Date());
      return { wait_id: waitId, state: "delivering" };
    });

    const row = await getDeliveryPayload(this.env.DB, waitId, event.instanceId);
    if (row.state === "delivered") return { status: "delivered" };
    if (row.state === "delivery_failed") return { status: "delivery_failed" };
    if (await recoverObservedCallbackSuccess(this.env.DB, waitId, event.instanceId, new Date())) {
      return { status: "delivered" };
    }
    const callbackToken = await deriveCapability(resolveCapabilityKey(this.env, row.capability_key_version), waitId, "callback");
    const acceptedEvent = JSON.parse(row.event_json) as JsonValue;

    for (let attempt = row.callback_attempts + 1; attempt <= CALLBACK_MAX_ATTEMPTS; attempt += 1) {
      const outcome = await step.do<CallbackOutcome>(
        `callback attempt ${attempt}`,
        { retries: { limit: 0, delay: 0 }, timeout: "15 seconds", sensitive: "output" },
        async () => {
          const controls = await getServiceControls(this.env.DB);
          if (controls.callback_delivery_enabled !== 1) throw new Error("callback_delivery_disabled");
          const callbackUrl = validateCallbackUrl(row.callback_url);
          const result = await sendCallback(
            callbackUrl,
            callbackToken,
            waitId,
            row.client_reference,
            row.event_received_at,
            acceptedEvent,
          );
          await recordCallbackAttempt(
            this.env.DB,
            waitId,
            event.instanceId,
            attempt,
            result.status,
            result.error_code,
            new Date(),
          );
          return result;
        },
      );

      if (outcome.disposition === "success") {
        await step.do("commit delivery success", { retries: { limit: 3, delay: "1 second", backoff: "linear" } }, async () => {
          await completeCallbackDelivery(this.env.DB, waitId, event.instanceId, new Date());
          return { status: "delivered" };
        });
        return { status: "delivered" };
      }

      const delay = outcome.disposition === "retry"
        ? callbackRetryDelayMs(attempt, outcome.status, outcome.retry_after)
        : null;
      if (delay === null) break;
      await step.sleep(`delay after callback attempt ${attempt}`, delay);
    }

    await step.do("commit delivery failure", { retries: { limit: 3, delay: "1 second", backoff: "linear" } }, async () => {
      await failCallbackDelivery(this.env.DB, waitId, event.instanceId, new Date());
      return { status: "delivery_failed" };
    });
    return { status: "delivery_failed" };
  }
}
