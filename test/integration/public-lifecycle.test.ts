import { env } from "cloudflare:workers";
import { introspectWorkflowInstance } from "cloudflare:test";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { fingerprintCreateWaitRequest, hashIdempotencyKey } from "../../src/idempotency";
import { handleRequest } from "../../src/index";
import { selectWaitOffer } from "../../src/offers";
import {
  MockPaymentAdapter,
  InMemoryMockPaymentProvider,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createMockPaymentSignature,
  type PaymentAdapter,
  type PaymentAttemptResult,
  type PaymentAuthorization,
} from "../../src/payment-adapter";
import { getPaymentRow, getWaitByRequestId, reserveRequest } from "../../src/repository";
import type { CreateWaitResponse, WaitStatusResponse } from "../../src/types";
import { validateCreateWaitRequest } from "../../src/validation";
import { network } from "./network";
import { deriveCapability, hashCapability } from "../../src/capabilities";

const testEnv = env as unknown as Env;
const now = new Date("2026-09-01T20:00:00.000Z");
const mockSecret = new Uint8Array(32).fill(34);
const idempotencyKey = "bcc3a6aa-d49d-44fc-8d72-0cd92f1fdf35";
const createBody = {
  callback_url: "https://agent.example.com/callback",
  timeout_seconds: 3_600,
  client_reference: "job-public-lifecycle",
};

class CountingAdapter implements PaymentAdapter {
  authorizations = 0;
  attempts = 0;
  readonly provider = new InMemoryMockPaymentProvider();
  private readonly inner: MockPaymentAdapter;
  constructor(reconciliationAvailable = true) {
    this.inner = new MockPaymentAdapter(mockSecret, reconciliationAvailable ? this.provider : undefined);
  }
  paymentRequired(binding: Parameters<PaymentAdapter["paymentRequired"]>[0]) {
    return this.inner.paymentRequired(binding);
  }
  encodePaymentRequired(requirements: Record<string, unknown>) {
    return this.inner.encodePaymentRequired(requirements);
  }
  encodePaymentResponse(response: Record<string, unknown>) {
    return this.inner.encodePaymentResponse(response);
  }
  authorize(signature: string, binding: Parameters<PaymentAdapter["authorize"]>[1]) {
    this.authorizations += 1;
    return this.inner.authorize(signature, binding);
  }
  async attemptAcceptance(authorization: PaymentAuthorization, externalOperationId: string): Promise<PaymentAttemptResult> {
    this.attempts += 1;
    return this.inner.attemptAcceptance(authorization, externalOperationId);
  }
  reconcileAcceptance(authorization: PaymentAuthorization, externalOperationId: string) {
    return this.inner.reconcileAcceptance(authorization, externalOperationId);
  }
}

function createRequest(signature?: string, key = idempotencyKey): Request {
  return new Request("https://wait.example/v1/waits", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": key,
      ...(signature ? { [PAYMENT_SIGNATURE_HEADER]: signature } : {}),
    },
    body: JSON.stringify(createBody),
  });
}

async function acceptedSignature(
  outcome: "accepted" | "rejected" | "ambiguous" = "accepted",
  nonce = "4f539b8e-8ca8-46c2-bc36-2d9f76088fd8",
) {
  const validated = validateCreateWaitRequest(createBody);
  return createMockPaymentSignature(mockSecret, {
    resource: "https://wait.example/v1/waits",
    offerId: selectWaitOffer(validated.timeout_seconds).offer_id,
    requestFingerprint: await fingerprintCreateWaitRequest(validated),
  }, {
    payer: "mock-payer",
    nonce,
    outcome,
  });
}

async function count(table: "idempotent_requests" | "request_payments" | "waits"): Promise<number> {
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function commercialCount(predicate: string): Promise<number> {
  const row = await testEnv.DB.prepare(
    `SELECT COUNT(*) AS count FROM commercial_admissions WHERE ${predicate}`,
  ).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

beforeEach(async () => {
  await testEnv.DB.prepare(
    `UPDATE service_controls
        SET new_sales_enabled = 1, callback_delivery_enabled = 1,
            max_active_waits = 100, max_paid_waits_per_day = 100,
            max_ambiguous_payment_honors = 100
      WHERE id = 1`,
  ).run();
});

describe("public local lifecycle with mocked payment", () => {
  it("accepts an arbitrary public HTTPS hostname without operator configuration", async () => {
    const request = new Request("https://wait.example/v1/waits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...createBody, callback_url: "https://arbitrary.buyer.example.org/callback" }),
    });
    const response = await handleRequest(request, testEnv, { now: () => now });
    expect(response.status).toBe(402);
  });

  it("keeps unsigned negotiation stateless and returns canonical requirements", async () => {
    const response = await handleRequest(createRequest(), testEnv, { now: () => now });
    expect(response.status).toBe(402);
    expect(response.headers.get(PAYMENT_REQUIRED_HEADER)).toBeTruthy();
    expect(await Promise.all([count("idempotent_requests"), count("request_payments"), count("waits")]))
      .toEqual([0, 0, 0]);
  });

  it("fails a new paid purchase before financial admission when commercial admission is closed", async () => {
    const before = await count("idempotent_requests");
    await testEnv.DB.prepare("UPDATE service_controls SET new_sales_enabled = 0 WHERE id = 1").run();
    const signature = await acceptedSignature("accepted", "a4748d92-c196-4fa5-bc4b-a52220de67aa");
    const response = await handleRequest(
      createRequest(signature, "3d486ef7-1094-40f5-b71c-d7744094b5d7"),
      testEnv,
      { paymentAdapter: new CountingAdapter(), now: () => now },
    );
    expect(response.status).toBe(503);
    expect(await count("idempotent_requests")).toBe(before + 1);
  });

  it("cannot authorize or call payment after its durable commercial admission is lost", async () => {
    const adapter = new CountingAdapter();
    const key = "cd5d1517-2cde-43a9-8587-323fb0ea400e";
    const keyHash = await hashIdempotencyKey(key);
    const signature = await acceptedSignature("accepted", "7109a7c7-ffce-466a-a158-ce891e44579c");
    const response = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
      afterCommercialAdmission: async () => {
        await testEnv.DB.prepare(
          `UPDATE commercial_admissions
              SET state = 'released', counts_daily = 0, active_held = 0, updated_at = ?
            WHERE request_id = (
              SELECT request_id FROM idempotent_requests WHERE idempotency_key_hash = ?
            )`,
        ).bind(now.toISOString(), keyHash).run();
      },
    });
    expect(response.status).toBe(409);
    expect(adapter.attempts).toBe(0);
    expect(await commercialCount("state = 'released' AND counts_daily = 0 AND active_held = 0")).toBeGreaterThan(0);
  });

  it("atomically admits only one of two concurrent purchases at a one-slot limit", async () => {
    await testEnv.DB.prepare(
      "UPDATE service_controls SET max_active_waits = 1, max_paid_waits_per_day = 1 WHERE id = 1",
    ).run();
    const adapter = new CountingAdapter();
    const [signatureA, signatureB] = await Promise.all([
      acceptedSignature("accepted", "f6402ff0-13ec-46f4-9915-5ce6283cb82e"),
      acceptedSignature("accepted", "723d26bc-a483-4f73-b88f-6f89c47722f7"),
    ]);
    const responses = await Promise.all([
      handleRequest(createRequest(signatureA, "eb4c3653-d449-489c-a8ad-54f99ae6a086"), testEnv, { paymentAdapter: adapter, now: () => now }),
      handleRequest(createRequest(signatureB, "9762576c-8cd9-4835-9b8e-147228648505"), testEnv, { paymentAdapter: adapter, now: () => now }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 429]);
    expect(adapter.attempts).toBe(1);
    expect(await commercialCount("active_held = 1")).toBe(1);
    expect(await commercialCount(`capacity_day = '${now.toISOString().slice(0, 10)}' AND counts_daily = 1`)).toBe(1);
  });

  it("runs unsigned to paid creation, event, callback, status, and payment-free replay end to end", async () => {
    const before = await Promise.all([count("idempotent_requests"), count("request_payments"), count("waits")]);
    const adapter = new CountingAdapter();
    const signature = await acceptedSignature();
    const paid = await handleRequest(createRequest(signature), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(paid.status).toBe(201);
    const created = await paid.json() as CreateWaitResponse;
    expect(created).toMatchObject({ status: "waiting", client_reference: createBody.client_reference });
    expect(adapter.attempts).toBe(1);

    const initialRow = await getWaitByRequestId(testEnv.DB, created.wait_id);
    expect(initialRow).toMatchObject({ state: "waiting", delivery_workflow_instance_id: null });
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({ state: "accepted" });

    let callbackCalls = 0;
    let releaseCallback: (() => void) | undefined;
    const callbackGate = new Promise<void>((resolve) => { releaseCallback = resolve; });
    let callbackBody: unknown;
    network.use(http.post(createBody.callback_url, async ({ request }) => {
      callbackCalls += 1;
      callbackBody = await request.json();
      await callbackGate;
      return HttpResponse.json({ accepted: true });
    }));

    await using instance = await introspectWorkflowInstance(testEnv.DELIVERY_WORKFLOW, `delivery-${created.wait_id}`);
    await instance.modify(async (modifier) => modifier.disableSleeps());
    const eventRequest = new Request(created.event_url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "must-not-forward", cookie: "must-not-forward" },
      body: JSON.stringify({ status: "complete", value: 42 }),
    });
    const eventResponse = await handleRequest(eventRequest, testEnv, { now: () => now });
    expect(eventResponse.status).toBe(202);
    expect(await eventResponse.json()).toEqual({ accepted: true, wait_id: created.wait_id });
    releaseCallback?.();

    await expect(instance.waitForStatus("complete")).resolves.not.toThrow();
    expect(callbackCalls).toBe(1);
    expect(callbackBody).toMatchObject({
      wait_id: created.wait_id,
      client_reference: createBody.client_reference,
      event: { status: "complete", value: 42 },
    });

    const status = await handleRequest(new Request(created.status_url), testEnv, { now: () => now });
    expect(status.status).toBe(200);
    expect(await status.json() as WaitStatusResponse).toMatchObject({
      wait_id: created.wait_id,
      status: "delivered",
      callback_attempts: 1,
      event: { status: "complete", value: 42 },
    });

    const sameEvent = await handleRequest(new Request(created.event_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: 42, status: "complete" }),
    }), testEnv, { now: () => now });
    expect(sameEvent.status).toBe(202);
    const differentEvent = await handleRequest(new Request(created.event_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "different" }),
    }), testEnv, { now: () => now });
    expect(differentEvent.status).toBe(409);
    expect(callbackCalls).toBe(1);

    const replay = await handleRequest(createRequest(signature), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);
    expect(adapter.attempts).toBe(1);
    expect(await Promise.all([count("idempotent_requests"), count("request_payments"), count("waits")]))
      .toEqual(before.map((value) => value + 1));
  });

  it("exposes private status and cancellation without permitting a cancelled event", async () => {
    const adapter = new CountingAdapter();
    const key = "69e5e677-38f7-4d8c-82fc-577b9c789ac6";
    const signature = await acceptedSignature("accepted", "74cdcd08-33d9-4d94-9500-22fb810deae9");
    const createdResponse = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
    });
    const created = await createdResponse.json() as CreateWaitResponse;
    const cancelled = await handleRequest(new Request(`${created.status_url}/cancel`, { method: "POST" }), testEnv, {
      now: () => now,
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({ wait_id: created.wait_id, status: "cancelled" });
    const status = await handleRequest(new Request(created.status_url), testEnv, { now: () => now });
    expect(await status.json()).toMatchObject({ wait_id: created.wait_id, status: "cancelled" });
    const event = await handleRequest(new Request(created.event_url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "too-late" }),
    }), testEnv, { now: () => now });
    expect(event.status).toBe(409);
    expect(adapter.attempts).toBe(1);
  });

  it("creates no wait when settlement is definitely rejected", async () => {
    const beforeWaits = await count("waits");
    const adapter = new CountingAdapter();
    const key = "b0000000-0000-4000-8000-000000000001";
    const signature = await acceptedSignature("rejected", "b0000000-0000-4000-8000-000000000002");
    const response = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
    });
    expect(response.status).toBe(402);
    const rejection = await response.json();
    expect(rejection).toMatchObject({ error: "payment_rejected", retryable: false });
    const required = response.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(adapter.attempts).toBe(1);
    expect(adapter.authorizations).toBe(1);
    expect(await count("waits")).toBe(beforeWaits);
    const row = await testEnv.DB.prepare(
      `SELECT state, accepted_at, ambiguity_honored_at
         FROM request_payments
        WHERE request_id = (
          SELECT request_id FROM idempotent_requests
           WHERE idempotency_key_hash = ?
        )`,
    ).bind(await hashIdempotencyKey(key)).first();
    expect(row).toEqual({ state: "rejected", accepted_at: null, ambiguity_honored_at: null });

    const replay = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => new Date(now.getTime() + 60_000),
    });
    expect(replay.status).toBe(402);
    expect(await replay.json()).toEqual(rejection);
    expect(replay.headers.get(PAYMENT_REQUIRED_HEADER)).toBe(required);
    expect(adapter.authorizations).toBe(1);
    expect(adapter.attempts).toBe(1);
  });

  it("starts a newly materialized wait at payment resolution and keeps those timestamps on replay", async () => {
    const key = "b0000000-0000-4000-8000-000000000011";
    const nonce = "b0000000-0000-4000-8000-000000000012";
    const reservationTime = new Date(now.getTime() - 30 * 60 * 1000);
    const validated = validateCreateWaitRequest(createBody);
    const requestFingerprint = await fingerprintCreateWaitRequest(validated);
    await reserveRequest(
      testEnv.DB,
      await hashIdempotencyKey(key),
      requestFingerprint,
      reservationTime,
      new Date(reservationTime.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    );
    const adapter = new CountingAdapter();
    const signature = await acceptedSignature("accepted", nonce);
    const createdResponse = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as CreateWaitResponse;
    expect(created.created_at).toBe(now.toISOString());
    expect(created.expires_at).toBe(new Date(now.getTime() + createBody.timeout_seconds * 1_000).toISOString());

    const replay = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => new Date(now.getTime() + 10 * 60 * 1000),
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);
    expect(adapter.attempts).toBe(1);
  });

  it("honors an ambiguous one-cent settlement without claiming acceptance or calling the adapter again", async () => {
    const adapter = new CountingAdapter();
    const key = "42e66294-bb5e-4dfb-a49f-2c78052dfcf8";
    const signature = await acceptedSignature("ambiguous", "d7917dcb-5233-48cb-8a8a-44e2819604cd");
    const first = await handleRequest(createRequest(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(first.status).toBe(201);
    expect(first.headers.get("PAYMENT-RESPONSE")).toBeNull();
    const created = await first.json() as CreateWaitResponse;
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({
      state: "ambiguous",
      accepted_at: null,
      transaction_id: null,
      ambiguity_honored_at: now.toISOString(),
    });
    expect(await getWaitByRequestId(testEnv.DB, created.wait_id)).toMatchObject({ state: "waiting" });
    expect(adapter.attempts).toBe(1);
    const replay = await handleRequest(createRequest(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);
    expect(replay.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(adapter.attempts).toBe(1);
  });

  it("honors the threshold ambiguity then atomically closes new sales before another financial call", async () => {
    const beforeHonored = Number((await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM request_payments
        WHERE state = 'ambiguous' AND ambiguity_honored_at IS NOT NULL`,
    ).first<{ count: number }>())?.count ?? 0);
    const fuseLimit = beforeHonored + 3;
    await testEnv.DB.prepare(
      "UPDATE service_controls SET max_ambiguous_payment_honors = ? WHERE id = 1",
    ).bind(fuseLimit).run();
    const adapter = new CountingAdapter();
    for (let index = 0; index < 3; index += 1) {
      const signature = await acceptedSignature(
        "ambiguous",
        `00000000-0000-4000-8000-00000000000${index}`,
      );
      const response = await handleRequest(
        createRequest(signature, `10000000-0000-4000-8000-00000000000${index}`),
        testEnv,
        { paymentAdapter: adapter, now: () => now },
      );
      expect(response.status).toBe(201);
    }
    expect(adapter.attempts).toBe(3);
    expect(await testEnv.DB.prepare(
      "SELECT new_sales_enabled, max_ambiguous_payment_honors FROM service_controls WHERE id = 1",
    ).first()).toEqual({ new_sales_enabled: 0, max_ambiguous_payment_honors: fuseLimit });
    expect(await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM request_payments
        WHERE state = 'ambiguous' AND ambiguity_honored_at IS NOT NULL`,
    ).first()).toEqual({ count: beforeHonored + 3 });

    const blockedSignature = await acceptedSignature(
      "ambiguous",
      "00000000-0000-4000-8000-000000000009",
    );
    const blocked = await handleRequest(
      createRequest(blockedSignature, "10000000-0000-4000-8000-000000000009"),
      testEnv,
      { paymentAdapter: adapter, now: () => now },
    );
    expect(blocked.status).toBe(503);
    expect(adapter.attempts).toBe(3);
  });

  it("recovers an honored ambiguity after entitlement provisioning response loss without another financial call", async () => {
    const adapter = new CountingAdapter();
    const key = "c0000000-0000-4000-8000-000000000001";
    const signature = await acceptedSignature("ambiguous", "d0000000-0000-4000-8000-000000000001");
    const interrupted = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
      afterAmbiguityHonored: () => { throw new Error("simulated_response_loss_after_ambiguity_honor"); },
    });
    expect(interrupted.status).toBe(500);
    expect(adapter.attempts).toBe(1);

    const recovered = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
    });
    expect(recovered.status).toBe(201);
    const created = await recovered.json() as CreateWaitResponse;
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({
      state: "ambiguous",
      ambiguity_honored_at: now.toISOString(),
    });
    expect(adapter.attempts).toBe(1);
  });

  it("recovers a durable accepted payment after response loss without settling again", async () => {
    const adapter = new CountingAdapter();
    const key = "554869e5-aa4f-48ac-a636-bde94b63bd68";
    const signature = await acceptedSignature("accepted", "ee47d631-5fca-4d46-845c-c1d6eeec440b");
    const interrupted = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
      afterPaymentAccepted: () => { throw new Error("simulated_response_loss_after_accepted_payment"); },
    });
    expect(interrupted.status).toBe(500);
    expect(adapter.attempts).toBe(1);

    const recovered = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
    });
    expect(recovered.status).toBe(201);
    expect(adapter.attempts).toBe(1);
    const created = await recovered.json() as CreateWaitResponse;
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({ state: "accepted" });
    expect(await getWaitByRequestId(testEnv.DB, created.wait_id)).toMatchObject({ state: "waiting" });
  });

  it("recovers a crash after settlement authorization but before arming the external call", async () => {
    const adapter = new CountingAdapter();
    const key = "2cf9cc62-cc02-4abd-a418-a05e13596271";
    const signature = await acceptedSignature("accepted", "e95f0176-82c9-498d-ae42-ebfbfdb46e4a");
    const interrupted = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
      afterSettlementAuthorized: () => { throw new Error("simulated_crash_before_external_call_arm"); },
    });
    expect(interrupted.status).toBe(500);
    expect(adapter.attempts).toBe(0);
    const recovered = await handleRequest(createRequest(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(recovered.status).toBe(201);
    expect(adapter.attempts).toBe(1);
  });

  it("queries the deterministic operation after a crash at the armed-call boundary", async () => {
    const adapter = new CountingAdapter();
    const key = "c8c6f136-995e-4873-86cb-8dc225b81bee";
    const signature = await acceptedSignature("accepted", "0ef05230-36fa-4b4b-99df-c74ba09aaad9");
    const interrupted = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
      afterExternalCallStarted: () => { throw new Error("simulated_crash_after_call_arm"); },
    });
    expect(interrupted.status).toBe(500);
    expect(adapter.attempts).toBe(0);
    const recovered = await handleRequest(createRequest(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(recovered.status).toBe(201);
    expect(adapter.attempts).toBe(1);
  });

  it("reconciles external acceptance lost before D1 without a second financial call", async () => {
    const adapter = new CountingAdapter();
    const key = "9ccf1bc6-a808-43bd-9366-acdcfca65565";
    const signature = await acceptedSignature("accepted", "a47ed9eb-200d-46fa-8d52-ad0ddf6b8053");
    const interrupted = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
      afterExternalAcceptance: () => { throw new Error("simulated_crash_before_d1_acceptance"); },
    });
    expect(interrupted.status).toBe(500);
    expect(adapter.attempts).toBe(1);
    const recovered = await handleRequest(createRequest(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(recovered.status).toBe(201);
    expect(adapter.attempts).toBe(1);
    const created = await recovered.json() as CreateWaitResponse;
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({
      state: "accepted",
      reconciliation_status: "accepted",
    });
  });

  it("honors unavailable reconciliation without resubmitting settlement or claiming acceptance", async () => {
    const adapter = new CountingAdapter(false);
    const key = "ae6b174a-3666-4e15-8704-3bcb407d489c";
    const signature = await acceptedSignature("accepted", "a805c365-36cf-4893-ae8d-fd2e3274b5b6");
    const interrupted = await handleRequest(createRequest(signature, key), testEnv, {
      paymentAdapter: adapter,
      now: () => now,
      afterExternalAcceptance: () => { throw new Error("simulated_unreconciled_external_acceptance"); },
    });
    expect(interrupted.status).toBe(500);
    expect(adapter.attempts).toBe(1);
    const retry = await handleRequest(createRequest(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(retry.status).toBe(201);
    const created = await retry.json() as CreateWaitResponse;
    expect(retry.headers.get("PAYMENT-RESPONSE")).toBeNull();
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({
      state: "ambiguous",
      accepted_at: null,
      ambiguity_honored_at: now.toISOString(),
    });
    expect(await getWaitByRequestId(testEnv.DB, created.wait_id)).toMatchObject({ state: "waiting" });
    expect(adapter.attempts).toBe(1);
  });

  it("rejects one accepted proof on a second idempotency lifecycle without another adapter call", async () => {
    const adapter = new CountingAdapter();
    const signature = await acceptedSignature("accepted", "3ea331d0-f221-48c1-bd28-04454912409e");
    expect((await handleRequest(
      createRequest(signature, "996e2c77-b470-4c55-b7c0-01e2934767a8"),
      testEnv,
      { paymentAdapter: adapter, now: () => now },
    )).status).toBe(201);
    const reused = await handleRequest(
      createRequest(signature, "6adfda3f-c6d1-4f44-bfb1-ae6a66480092"),
      testEnv,
      { paymentAdapter: adapter, now: () => now },
    );
    expect(reused.status).toBe(409);
    expect(adapter.attempts).toBe(1);
  });
  it.each([1, 2])("creates and replays a wait with capability key version %i", async (version) => {
    const config = version === 1 ? testEnv : { ...testEnv, CAPABILITY_KEY_V2: "33".repeat(32) };
    const adapter = new CountingAdapter();
    const purchaseKey = crypto.randomUUID();
    const signature = await acceptedSignature("accepted", crypto.randomUUID());
    const waitsBefore = await count("waits");
    const dependencies = { paymentAdapter: adapter, now: () => now };
    const response = await handleRequest(createRequest(signature, purchaseKey), config, dependencies);
    expect(response.status).toBe(201);
    const body = await response.json() as CreateWaitResponse;
    const key = new Uint8Array(32).fill(version === 1 ? 17 : 51);
    const eventToken = await deriveCapability(key, body.wait_id, "event");
    const statusToken = await deriveCapability(key, body.wait_id, "status");
    expect(body.event_url).toBe(`https://wait.example/e/${eventToken}`);
    expect(body.status_url).toBe(`https://wait.example/s/${statusToken}`);
    expect(body.callback_token).toBe(await deriveCapability(key, body.wait_id, "callback"));
    expect(await getWaitByRequestId(testEnv.DB, body.wait_id)).toMatchObject({
      capability_key_version: version,
      event_token_hash: await hashCapability(eventToken),
      status_token_hash: await hashCapability(statusToken),
    });
    const rotated = { ...config, CAPABILITY_KEY_V2: "33".repeat(32) };
    const replay = await handleRequest(createRequest(signature, purchaseKey), rotated, dependencies);
    expect(await replay.json()).toEqual(body);
    const status = await handleRequest(new Request(body.status_url), rotated, dependencies);
    expect(status.status).toBe(200);
    const missing = version === 1 ? { ...rotated, CAPABILITY_KEY_V1: "" } : { ...rotated, CAPABILITY_KEY_V2: undefined };
    const failed = await handleRequest(createRequest(signature, purchaseKey), missing, dependencies);
    expect(failed.status).toBe(503);
    expect(adapter.attempts).toBe(1);
    expect(await count("waits")).toBe(waitsBefore + 1);
  });


});
