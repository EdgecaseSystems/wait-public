import { WAIT_DESCRIPTION, waitBuyerGuide } from "./buyer-guide";
import { reportIncident, reconcileIncidentMonitoring } from "./monitoring";
import { directoryDiscovery, apiCatalog, catalogHeaders } from "./discovery";
import { jsonResponse } from "./http";
import { openApiDocument, recoveryRetention, callbackAcknowledgment, supportContact, serviceAttentionGuidance } from "./openapi";
import { publicOfferCatalog } from "./offers";
import { runRetentionCleanup } from "./retention-cleanup";
import { handleProductRoute, type RouteDependencies } from "./routes";
import { getServiceControls } from "./repository";

export const SERVICE_VERSION = "0.1.0";

export async function handleRequest(request: Request, env?: Env, dependencies: RouteDependencies = {}): Promise<Response> {
  const url = new URL(request.url);

  if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/.well-known/api-catalog") {
    return new Response(request.method === "HEAD" ? null : JSON.stringify(apiCatalog), { headers: catalogHeaders });
  }

  if (request.method === "GET" && url.pathname === "/health") {
    return jsonResponse({ status: "ok", service: "wait", version: SERVICE_VERSION });
  }

  if (request.method === "GET" && url.pathname === "/") {
    let availability: { sales_status?: "open" | "closed"; callback_delivery_status?: "enabled" | "disabled" } = {};
    if (env?.DB) {
      try {
        const controls = await getServiceControls(env.DB);
        availability = {
          sales_status: controls.new_sales_enabled === 1 ? "open" : "closed",
          callback_delivery_status: controls.callback_delivery_enabled === 1 ? "enabled" : "disabled",
        };
      } catch {
        // Keep discovery available without inventing a control state.
      }
    }
    return jsonResponse({
      service: "Edgecase Wait",
      version: SERVICE_VERSION,
      capability: "wait_for_event",
      description: WAIT_DESCRIPTION,
      buyer_guide: waitBuyerGuide,
      pricing: publicOfferCatalog(),
      openapi_path: "/openapi.json",
      ...availability,
      availability_guidance: "sales_status and callback_delivery_status are current snapshots, omitted when unavailable. Open sales do not guarantee purchase availability; use unsigned POST /v1/waits for current requirements.",
      semantics: {
        event_driven: true,
        polling: false,
        one_logical_event_per_wait: true,
        callback_delivery: "bounded_at_least_once",
        callback_deduplication_key: "wait_id",
      },
      use_when: "Use when work is blocked on a job result, approval decision, or another external event that a producer can POST as JSON. Your callback handler resumes your agent or workflow; Wait does not run the agent or check another service for changes.",
      limits: {
        timeout_seconds: { minimum: 60, maximum: 86_400 },
        event_bytes: 65_536,
        callback_attempts: 5,
      },
      purchase: {
        unsigned_request: "When new sales are enabled, POST /v1/waits without PAYMENT-SIGNATURE returns stateless HTTP 402 requirements. When sales are disabled, it returns a non-retryable HTTP 503 without payment requirements.",
        paid_retry_headers: ["PAYMENT-SIGNATURE", "Idempotency-Key (UUIDv4)"],
        save_response: "Persist the complete successful HTTP 201 creation response immediately. event_url, status_url, and callback_token are bearer credentials; keep them secret and out of logs.",
        exact_replay: "For recovery within the supported retention window, retain the original request body, Idempotency-Key, and PAYMENT-SIGNATURE securely. Exact replay to the same create endpoint requires the same logical request body, the same Idempotency-Key, and the original PAYMENT-SIGNATURE. The Idempotency-Key alone is not sufficient to recover capabilities. A retained accepted or ambiguity-honored entitlement is reconstructed without another settlement; do not create a new payment authorization or blindly resend after an ambiguous result.",
        payment_disposition: {
          rejected: "No wait is created.",
          accepted: "One wait is created and PAYMENT-RESPONSE reports success.",
          ambiguous: "For the one-cent v0.1 offer, a post-boundary irrecoverable ambiguity receives one wait without another settlement attempt; payment remains ambiguous and PAYMENT-RESPONSE is omitted.",
          fuse: "Three cumulative ambiguity-honored purchases close new sales by default; active/day limits bound already-admitted exposure.",
        },
      },
      event_delivery: {
        method: "POST",
        url: "event_url returned by wait creation",
        content_type: "application/json",
        first_event_wins: true,
        same_event_retry: "Re-submit semantically identical JSON to reconcile the same wait; different JSON conflicts.",
      },
      recovery_retention: recoveryRetention,
      status_recovery: {
        method: "GET",
        url: "status_url returned by wait creation",
        bearer_secret: true,
      },
      cancellation: {
        method: "POST",
        url: "status_url plus /cancel",
        allowed_while: "waiting",
        replay: "A successfully cancelled wait remains cancelled; later cancellation cannot override an accepted event or another terminal state.",
      },
      callback: {
        method: "POST",
        content_type: "application/json",
        body_schema: "/openapi.json#/components/schemas/CallbackPayload",
        body_fields: ["wait_id", "client_reference", "event_received_at", "event"],
        acknowledgment: callbackAcknowledgment,
        authentication: {
          token_header: "Edgecase-Wait-Token",
          token_value: "callback_token returned by wait creation",
          wait_id_headers: ["Edgecase-Wait-Id", "Idempotency-Key"],
        },
        host_policy: {
          model: "public_https_dns_hosts",
          arbitrary_public_hosts: true,
          pre_registration_required: false,
          https_port: 443,
          rejected: ["IP literals", "localhost", "single-label hosts", ".localhost", ".local", ".internal", ".lan", ".home", ".invalid", ".test", "credentials", "fragments"],
          redirects_followed: false,
          network_boundary: "Cloudflare global fetch public outbound HTTP boundary with global_fetch_strictly_public",
          delivery_semantics: "bounded_at_least_once",
        },
      },
      service_attention: {
        status: "service_attention_required",
        contact: supportContact,
        action: serviceAttentionGuidance,
      },
      retry_guidance: {
        rule: "Retry only when an error response sets retryable=true; preserve the same logical request and obey retry_after_seconds or Retry-After.",
        signed_payment_exception: "Never automatically resend a payment-bearing request after an ambiguous response.",
      },
      discovery: {
        known_origin: "GET / and GET /openapi.json are sufficient to use the service.",
          global_listing: false,
        directory: directoryDiscovery,
        api_catalog: "/.well-known/api-catalog",
      },
    }, 200, { link: catalogHeaders.link });
  }

  if (request.method === "GET" && url.pathname === "/openapi.json") {
    return jsonResponse(openApiDocument, 200, { link: catalogHeaders.link });
  }

  return handleProductRoute(request, env, dependencies);
}

export const worker: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try { return await handleRequest(request, env); }
    catch (error) { reportIncident("worker_error", "fetch"); throw error; }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date();
    try { await runRetentionCleanup(env.DB, now); }
    catch (error) { reportIncident("worker_error", "scheduled"); throw error; }
    finally { await reconcileIncidentMonitoring(env.DB, now); }
  },
};

export default worker;
