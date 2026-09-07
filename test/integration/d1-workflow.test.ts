import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { deriveCapability, hashCapability } from "../../src/capabilities";
import { provisionDeliveryWorkflow } from "../../src/delivery-provisioning";
import {
  acceptFirstEvent,
  activateWait,
  cancelWaitingWait,
  createProvisioningWait,
  expireWaitingWait,
  getWaitByRequestId,
  markDeliveryWorkflowStarted,
  recordCallbackAttempt,
  reserveRequest,
} from "../../src/repository";
import { network } from "./network";

const now = new Date("2026-09-01T19:00:00.000Z");
const testEnv = env as unknown as Env;

async function seedWaitingWait(suffix: string, expiresAt = "2026-09-01T20:00:00.000Z") {
  const requestId = `request-${suffix}`;
  const waitId = `wait-${suffix}`;
  const eventToken = `event-${suffix}`;
  const statusToken = `status-${suffix}`;
  const eventTokenHash = await hashCapability(eventToken);
  const statusTokenHash = await hashCapability(statusToken);
  const reservation = await reserveRequest(testEnv.DB, `key-${suffix}`, `fingerprint-${suffix}`, now, null, requestId);
  expect(reservation).toEqual({ kind: "acquired", requestId });
  await createProvisioningWait(testEnv.DB, {
    waitId,
    requestId,
    publicOrigin: "https://wait.example",
    callbackUrl: "https://agent.example.com/callback",
    clientReference: `job-${suffix}`,
    capabilityKeyVersion: 1,
    eventTokenHash,
    statusTokenHash,
    createdAt: now.toISOString(),
    expiresAt,
  });
  await activateWait(testEnv.DB, waitId, now);
  return { requestId, waitId, eventTokenHash, statusTokenHash };
}

describe("real local D1 migration and race boundaries", () => {
  it("applies every reviewed migration with sales and callback delivery disabled", async () => {
    const tables = await testEnv.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((row) => row.name)).toEqual(expect.arrayContaining([
      "d1_migrations",
      "commercial_admissions",
      "idempotent_requests",
      "request_payments",
      "service_controls",
      "waits",
    ]));
    expect(await testEnv.DB.prepare(
      `SELECT new_sales_enabled, callback_delivery_enabled,
              max_ambiguous_payment_honors
         FROM service_controls WHERE id = 1`,
    ).first()).toEqual({
      new_sales_enabled: 0,
      callback_delivery_enabled: 0,
      max_ambiguous_payment_honors: 3,
    });
    const migrations = await testEnv.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    expect(migrations.results.map((row) => row.name)).toEqual([
      "0001_initial.sql",
      "0002_add_retention_cleanup_markers.sql",
      "0003_add_crash_reconciliation.sql",
      "0004_close_service_controls.sql",
      "0005_add_ambiguity_honor_fuse.sql",
    ]);
  });

  it("lets only one concurrent idempotency reservation acquire the key", async () => {
    const results = await Promise.all([
      reserveRequest(testEnv.DB, "same-key", "same-request", now, null, "request-a"),
      reserveRequest(testEnv.DB, "same-key", "same-request", now, null, "request-b"),
    ]);
    expect(results.filter((result) => result.kind === "acquired")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "existing")).toHaveLength(1);
    const ids = results.map((result) => result.kind === "acquired" ? result.requestId : result.row.request_id);
    expect(new Set(ids).size).toBe(1);
  });

  it("has one durable winner when event acceptance races cancellation", async () => {
    const seeded = await seedWaitingWait("race");
    const [eventResult, cancelResult] = await Promise.all([
      acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { status: "complete" }, now),
      cancelWaitingWait(testEnv.DB, seeded.statusTokenHash, now),
    ]);
    const row = await getWaitByRequestId(testEnv.DB, seeded.requestId);
    expect(["event_received", "cancelled"]).toContain(row?.state);
    if (row?.state === "event_received") {
      expect(eventResult.kind).toBe("accepted");
      expect(cancelResult.kind).toBe("not_cancellable");
      expect(row.delivery_workflow_instance_id).toBe(`delivery-${seeded.waitId}`);
    } else {
      expect(cancelResult.kind).toBe("cancelled");
      expect(eventResult.kind).toBe("not_waiting");
      expect(row?.delivery_workflow_instance_id).toBeNull();
    }
  });

  it("does not accept an event at or after the fixed expiration boundary", async () => {
    const seeded = await seedWaitingWait("expired", now.toISOString());
    const [eventResult, expired] = await Promise.all([
      acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { status: "too-late" }, now),
      expireWaitingWait(testEnv.DB, seeded.waitId, now),
    ]);
    expect(eventResult.kind).not.toBe("accepted");
    expect(expired).toBe(true);
    expect((await getWaitByRequestId(testEnv.DB, seeded.requestId))?.state).toBe("expired");
  });

  it("classifies semantic retries without overwriting the accepted event", async () => {
    const seeded = await seedWaitingWait("semantic");
    expect((await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { nested: { b: 2, a: 1 } }, now)).kind)
      .toBe("accepted");
    expect((await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { nested: { a: 1, b: 2 } }, now)).kind)
      .toBe("same_event_retry");
    expect((await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { nested: { a: 9, b: 2 } }, now)).kind)
      .toBe("different_event_conflict");
    expect(JSON.parse((await getWaitByRequestId(testEnv.DB, seeded.requestId))?.event_json ?? "null"))
      .toEqual({ nested: { a: 1, b: 2 } });
  });
});

describe("local delivery Workflow", () => {
  it("revalidates the persisted callback URL before any outbound attempt", async () => {
    await testEnv.DB.prepare("UPDATE service_controls SET callback_delivery_enabled = 1 WHERE id = 1").run();
    const seeded = await seedWaitingWait("invalid-persisted-callback");
    await testEnv.DB.prepare("UPDATE waits SET callback_url = ? WHERE wait_id = ?")
      .bind("https://localhost/callback", seeded.waitId).run();
    const accepted = await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { status: "complete" }, now);
    if (accepted.kind !== "accepted") throw new Error("test setup failed");
    let calls = 0;
    network.use(http.post("*", () => { calls += 1; return HttpResponse.json({}); }));
    await using instance = await introspectWorkflowInstance(testEnv.DELIVERY_WORKFLOW, accepted.deliveryWorkflowInstanceId);
    await provisionDeliveryWorkflow(testEnv.DELIVERY_WORKFLOW, accepted.waitId, accepted.deliveryWorkflowInstanceId);
    await instance.waitForStatus("errored");
    expect(calls).toBe(0);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "delivering", callback_attempts: 0, callback_last_status: null,
    });
  });

  it.each([302, 503])("preserves terminal redirect and bounded retry behavior for HTTP %s", async (status) => {
    await testEnv.DB.prepare("UPDATE service_controls SET callback_delivery_enabled = 1 WHERE id = 1").run();
    const seeded = await seedWaitingWait(`callback-status-${status}`);
    const accepted = await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { status: "complete" }, now);
    if (accepted.kind !== "accepted") throw new Error("test setup failed");
    let calls = 0;
    let redirectCalls = 0;
    network.use(
      http.post("https://agent.example.com/callback", ({ request }) => {
        calls += 1;
        expect(request.redirect).toBe("manual");
        return new HttpResponse(null, { status, headers: { Location: "https://redirect.example.com/target" } });
      }),
      http.all("https://redirect.example.com/target", () => { redirectCalls += 1; return HttpResponse.json({}); }),
    );
    await using instance = await introspectWorkflowInstance(testEnv.DELIVERY_WORKFLOW, accepted.deliveryWorkflowInstanceId);
    await instance.modify(async (modifier) => modifier.disableSleeps());
    await provisionDeliveryWorkflow(testEnv.DELIVERY_WORKFLOW, accepted.waitId, accepted.deliveryWorkflowInstanceId);
    await instance.waitForStatus("complete");
    expect(await instance.getOutput()).toEqual({ status: "delivery_failed" });
    expect(calls).toBe(status === 302 ? 1 : 5);
    expect(redirectCalls).toBe(0);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "delivery_failed", callback_attempts: calls, callback_last_status: status,
      callback_last_error_code: "callback_http_status", callback_delivered_at: null,
    });
  });

  it("rechecks the callback delivery switch before a retry can send", async () => {
    await testEnv.DB.prepare(
      "UPDATE service_controls SET callback_delivery_enabled = 1 WHERE id = 1",
    ).run();
    const seeded = await seedWaitingWait("workflow-switch-off");
    const accepted = await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { status: "retry" }, now);
    if (accepted.kind !== "accepted") throw new Error("test setup failed");

    let calls = 0;
    network.use(http.post("https://agent.example.com/callback", async () => {
      calls += 1;
      await testEnv.DB.prepare(
        "UPDATE service_controls SET callback_delivery_enabled = 0 WHERE id = 1",
      ).run();
      return new HttpResponse(null, { status: 503 });
    }));

    await using instance = await introspectWorkflowInstance(testEnv.DELIVERY_WORKFLOW, accepted.deliveryWorkflowInstanceId);
    await instance.modify(async (modifier) => modifier.disableSleeps());
    expect(await provisionDeliveryWorkflow(
      testEnv.DELIVERY_WORKFLOW,
      accepted.waitId,
      accepted.deliveryWorkflowInstanceId,
    )).toBe("provisioned");
    await expect(instance.waitForStatus("errored")).resolves.not.toThrow();
    expect(calls).toBe(1);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "delivering",
      callback_attempts: 1,
      callback_last_status: 503,
    });
  });

  it("uses one deterministic createBatch identity and recovers through a transient callback failure", async () => {
    await testEnv.DB.prepare(
      "UPDATE service_controls SET callback_delivery_enabled = 1 WHERE id = 1",
    ).run();
    const seeded = await seedWaitingWait("workflow");
    const accepted = await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { status: "complete", value: 42 }, now);
    expect(accepted.kind).toBe("accepted");
    if (accepted.kind !== "accepted") throw new Error("test setup failed");

    let calls = 0;
    let observedBody: unknown;
    let observedToken: string | null = null;
    network.use(http.post("https://agent.example.com/callback", async ({ request }) => {
      calls += 1;
      observedToken = request.headers.get("Edgecase-Wait-Token");
      expect(request.redirect).toBe("manual");
      expect(request.headers.get("Content-Type")).toBe("application/json");
      expect(request.headers.get("Edgecase-Wait-Id")).toBe(seeded.waitId);
      expect(request.headers.get("Idempotency-Key")).toBe(seeded.waitId);
      observedBody = await request.json();
      return calls === 1 ? new HttpResponse(null, { status: 503 }) : HttpResponse.json({ accepted: true });
    }));

    await using instance = await introspectWorkflowInstance(testEnv.DELIVERY_WORKFLOW, accepted.deliveryWorkflowInstanceId);
    await instance.modify(async (modifier) => modifier.disableSleeps());

    expect(await provisionDeliveryWorkflow(
      testEnv.DELIVERY_WORKFLOW,
      accepted.waitId,
      accepted.deliveryWorkflowInstanceId,
    )).toBe("provisioned");
    expect(await provisionDeliveryWorkflow(
      testEnv.DELIVERY_WORKFLOW,
      accepted.waitId,
      accepted.deliveryWorkflowInstanceId,
      true,
    )).toBe("existing");

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
    expect(await instance.getOutput()).toEqual({ status: "delivered" });
    expect(calls).toBe(2);
    expect(observedToken).toBe(await deriveCapability(new Uint8Array(32).fill(17), seeded.waitId, "callback"));
    expect(observedToken).not.toBe(testEnv.CAPABILITY_KEY_V1);
    expect(observedBody).toEqual({
      wait_id: seeded.waitId,
      client_reference: "job-workflow",
      event_received_at: expect.any(String),
      event: { status: "complete", value: 42 },
    });
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "delivered",
      callback_attempts: 2,
      callback_last_status: 200,
    });
  });

  it("commits an already-recorded callback 2xx after a crash without resending", async () => {
    await testEnv.DB.prepare(
      "UPDATE service_controls SET callback_delivery_enabled = 1 WHERE id = 1",
    ).run();
    const seeded = await seedWaitingWait("callback-success-recovery");
    const accepted = await acceptFirstEvent(testEnv.DB, seeded.eventTokenHash, { status: "observed" }, now);
    if (accepted.kind !== "accepted") throw new Error("test setup failed");
    await markDeliveryWorkflowStarted(testEnv.DB, accepted.waitId, accepted.deliveryWorkflowInstanceId, now);
    await recordCallbackAttempt(testEnv.DB, accepted.waitId, accepted.deliveryWorkflowInstanceId, 1, 204, null, now);

    let calls = 0;
    network.use(http.post("https://agent.example.com/callback", () => {
      calls += 1;
      return HttpResponse.json({ accepted: true });
    }));
    await using instance = await introspectWorkflowInstance(testEnv.DELIVERY_WORKFLOW, accepted.deliveryWorkflowInstanceId);
    expect(await provisionDeliveryWorkflow(
      testEnv.DELIVERY_WORKFLOW,
      accepted.waitId,
      accepted.deliveryWorkflowInstanceId,
    )).toBe("provisioned");
    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
    expect(calls).toBe(0);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "delivered",
      callback_attempts: 1,
      callback_last_status: 204,
      callback_success_observed_at: now.toISOString(),
    });
  });
});
