import { reconcileIncidentMonitoring } from "../../src/monitoring";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { fingerprint } from "../../src/canonical";
import {
  acceptFirstEvent,
  cancelWaitingWait,
  completeCallbackDelivery,
  getPaymentRow,
  getWaitByRequestId,
  getWaitByStatusTokenHash,
  reserveRequest,
  reserveCommercialAdmission,
} from "../../src/repository";
import { runRetentionCleanup } from "../../src/retention-cleanup";
import type { PaymentState, WaitState } from "../../src/types";

const testEnv = env as unknown as Env;
const now = new Date("2026-09-01T20:00:00.000Z");
const days = (value: number) => value * 24 * 60 * 60 * 1000;
const before = (milliseconds: number) => new Date(now.getTime() - milliseconds).toISOString();

interface SeedOptions {
  suffix: string;
  waitState?: WaitState;
  terminalAt?: string | null;
  eventReceivedAt?: string | null;
  expiresAt?: string;
  createdAt?: string;
  replayExpiresAt?: string | null;
  paymentState?: PaymentState;
  paymentAcceptedAt?: string | null;
  ambiguityHonoredAt?: string | null;
  replayPurgedAt?: string | null;
  includeWait?: boolean;
}

async function seedLifecycle(options: SeedOptions) {
  const requestId = `request-${options.suffix}`;
  const waitId = `wait-${options.suffix}`;
  const waitState = options.waitState ?? "delivered";
  const createdAt = options.createdAt ?? before(days(40));
  const terminalAt = options.terminalAt === undefined ? before(days(4)) : options.terminalAt;
  const eventReceivedAt = options.eventReceivedAt === undefined ? before(days(5)) : options.eventReceivedAt;
  const paymentState = options.paymentState ?? "accepted";
  const paymentAcceptedAt = options.paymentAcceptedAt === undefined ? createdAt : options.paymentAcceptedAt;
  const ambiguityHonoredAt = options.ambiguityHonoredAt ?? null;
  const event = { status: "complete", suffix: options.suffix };
  const eventFingerprint = eventReceivedAt === null ? null : await fingerprint(event, "edgecase-wait-event-v1");
  const replayPurgedAt = options.replayPurgedAt ?? null;
  const replayExpiresAt = options.replayExpiresAt === undefined ? before(days(10)) : options.replayExpiresAt;
  const idempotencyHash = replayPurgedAt === null ? `key-${options.suffix}` : `purged:${requestId}`;

  await testEnv.DB.prepare(
    `INSERT INTO idempotent_requests (
       request_id, idempotency_key_hash, request_fingerprint, state,
       replay_expires_at, replay_purged_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'fulfilled', ?, ?, ?, ?)`,
  ).bind(
    requestId,
    idempotencyHash,
    replayPurgedAt === null ? `fingerprint-${options.suffix}` : "purged",
    replayExpiresAt,
    replayPurgedAt,
    createdAt,
    createdAt,
  ).run();

  await testEnv.DB.prepare(
    `INSERT INTO request_payments (
       request_id, state, network, asset, amount, pay_to,
       payment_proof_fingerprint, payer_identity, transaction_id,
       accepted_at, ambiguity_honored_at, created_at, updated_at
     ) VALUES (?, ?, 'eip155:84532', 'mock-usdc', '10000', 'mock-recipient',
       ?, 'mock-payer', ?, ?, ?, ?, ?)`,
  ).bind(
    requestId,
    paymentState,
    `proof-${options.suffix}`,
    `transaction-${options.suffix}`,
    paymentAcceptedAt,
    ambiguityHonoredAt,
    createdAt,
    createdAt,
  ).run();

  if (options.includeWait !== false) {
    const hasEvent = eventReceivedAt !== null;
    const hasWorkflow = ["event_received", "delivering", "delivered", "delivery_failed", "ambiguous"].includes(waitState);
    await testEnv.DB.prepare(
      `INSERT INTO waits (
         wait_id, request_id, delivery_workflow_instance_id, state, public_origin,
         callback_url, client_reference, capability_key_version,
         event_token_hash, status_token_hash, event_fingerprint, event_json,
         event_received_at, callback_attempts, callback_delivered_at,
         created_at, expires_at, terminal_at, updated_at
       ) VALUES (?, ?, ?, ?, 'https://wait.example', 'https://agent.example.com/callback', ?, 1,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      waitId,
      requestId,
      hasWorkflow ? `delivery-${waitId}` : null,
      waitState,
      `job-${options.suffix}`,
      `event-${options.suffix}`,
      `status-${options.suffix}`,
      eventFingerprint,
      hasEvent ? JSON.stringify(event) : null,
      eventReceivedAt,
      waitState === "delivered" ? 1 : 0,
      waitState === "delivered" ? terminalAt : null,
      createdAt,
      options.expiresAt ?? before(days(39)),
      terminalAt,
      terminalAt ?? eventReceivedAt ?? createdAt,
    ).run();
  }

  return { requestId, waitId, event, idempotencyHash };
}

describe("retention cleanup against actual local D1", () => {
  it("redacts event/callback material after 72 hours but preserves payment evidence", async () => {
    const seeded = await seedLifecycle({ suffix: "redact" });
    const result = await runRetentionCleanup(testEnv.DB, now);
    expect(result.event_content_purged).toBe(1);
    const wait = await getWaitByRequestId(testEnv.DB, seeded.requestId);
    expect(wait).toMatchObject({
      state: "delivered",
      callback_url: "https://purged.invalid/",
      client_reference: null,
      event_token_hash: `purged:${seeded.waitId}`,
      event_json: null,
      event_fingerprint: null,
      event_content_purged_at: now.toISOString(),
    });
    expect(await getPaymentRow(testEnv.DB, seeded.requestId)).toMatchObject({ state: "accepted" });
  });

  it("makes status-read versus 30-day metadata cleanup an atomic before-or-after result", async () => {
    const seeded = await seedLifecycle({ suffix: "status-race", terminalAt: before(days(31)) });
    const [cleanup, read] = await Promise.all([
      runRetentionCleanup(testEnv.DB, now),
      getWaitByStatusTokenHash(testEnv.DB, `status-status-race`),
    ]);
    expect(cleanup.wait_metadata_deleted).toBe(1);
    expect(read === null || read.wait_id === seeded.waitId).toBe(true);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toBeNull();
    expect(await getPaymentRow(testEnv.DB, seeded.requestId)).toMatchObject({ state: "accepted" });
  });

  it("makes event retry versus event redaction safe without creating a new delivery identity", async () => {
    const seeded = await seedLifecycle({ suffix: "event-race" });
    const [cleanup, retry] = await Promise.all([
      runRetentionCleanup(testEnv.DB, now),
      acceptFirstEvent(testEnv.DB, `event-event-race`, seeded.event, now),
    ]);
    expect(cleanup.event_content_purged).toBe(1);
    expect(["same_event_retry", "not_found"]).toContain(retry.kind);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      delivery_workflow_instance_id: `delivery-${seeded.waitId}`,
      event_json: null,
    });
  });

  it("gives delivery completion and the seven-day stuck-event incident marker one durable winner", async () => {
    const seeded = await seedLifecycle({
      suffix: "delivery-race",
      waitState: "delivering",
      terminalAt: null,
      eventReceivedAt: before(days(8)),
    });
    const [completion, cleanup] = await Promise.allSettled([
      completeCallbackDelivery(testEnv.DB, seeded.waitId, `delivery-${seeded.waitId}`, now),
      runRetentionCleanup(testEnv.DB, now),
    ]);
    const row = await getWaitByRequestId(testEnv.DB, seeded.requestId);
    expect(["delivered", "ambiguous"]).toContain(row?.state);
    expect(completion.status === "fulfilled" || cleanup.status === "fulfilled").toBe(true);
    if (row?.state === "delivered") expect(completion.status).toBe("fulfilled");
    if (row?.state === "ambiguous") expect(cleanup.status).toBe("fulfilled");
  });

  it("gives cancellation and opportunistic expiration one terminal winner", async () => {
    const expiresAt = new Date(now.getTime() - 1_000).toISOString();
    const cancelTime = new Date(now.getTime() - 2_000);
    const seeded = await seedLifecycle({
      suffix: "cancel-race",
      waitState: "waiting",
      terminalAt: null,
      eventReceivedAt: null,
      expiresAt,
    });
    const [cancel, cleanup] = await Promise.all([
      cancelWaitingWait(testEnv.DB, `status-cancel-race`, cancelTime),
      runRetentionCleanup(testEnv.DB, now),
    ]);
    expect(["cancelled", "not_cancellable"]).toContain(cancel.kind);
    expect(cleanup.expired_waits === 0 || cleanup.expired_waits === 1).toBe(true);
    expect(["cancelled", "expired"]).toContain((await getWaitByRequestId(testEnv.DB, seeded.requestId))?.state);
  });

  it("expires an unread waiting entitlement and releases its active capacity in the same cleanup", async () => {
    const seeded = await seedLifecycle({
      suffix: "unread-expiration-capacity",
      waitState: "waiting",
      terminalAt: null,
      eventReceivedAt: null,
      expiresAt: before(1_000),
    });
    await testEnv.DB.prepare(
      `INSERT INTO commercial_admissions (
         request_id, capacity_day, state, counts_daily, active_held, created_at, updated_at
       ) VALUES (?, ?, 'accepted', 1, 1, ?, ?)`,
    ).bind(seeded.requestId, now.toISOString().slice(0, 10), before(days(1)), before(days(1))).run();

    const cleanup = await runRetentionCleanup(testEnv.DB, now);
    expect(cleanup.expired_waits).toBe(1);
    expect(cleanup.active_capacity_released).toBe(1);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({ state: "expired" });
    expect(await testEnv.DB.prepare(
      "SELECT state, counts_daily, active_held FROM commercial_admissions WHERE request_id = ?",
    ).bind(seeded.requestId).first()).toEqual({ state: "accepted", counts_daily: 1, active_held: 0 });
  });

  it("retires fulfilled replay lookup without applying the 30-day window to payment evidence", async () => {
    const seeded = await seedLifecycle({ suffix: "replay-race", includeWait: false });
    const [cleanup, replay] = await Promise.all([
      runRetentionCleanup(testEnv.DB, now),
      reserveRequest(testEnv.DB, seeded.idempotencyHash, `fingerprint-replay-race`, now, null, "request-replay-new"),
    ]);
    expect(cleanup.replay_metadata_purged === 0 || cleanup.replay_metadata_purged === 1).toBe(true);
    expect(["acquired", "existing"]).toContain(replay.kind);
    expect(await getPaymentRow(testEnv.DB, seeded.requestId)).toMatchObject({ state: "accepted" });
  });

  it("deletes accepted payment evidence only after seven years and retains ambiguity", async () => {
    const recent = await seedLifecycle({ suffix: "payment-recent", includeWait: false });
    const old = await seedLifecycle({
      suffix: "payment-old",
      includeWait: false,
      createdAt: "2018-08-31T00:00:00.000Z",
      paymentAcceptedAt: "2018-08-31T00:00:00.000Z",
      replayExpiresAt: null,
      replayPurgedAt: "2018-09-30T00:00:00.000Z",
    });
    const ambiguous = await seedLifecycle({
      suffix: "payment-ambiguous",
      includeWait: false,
      createdAt: "2018-08-31T00:00:00.000Z",
      paymentState: "ambiguous",
      paymentAcceptedAt: null,
      replayExpiresAt: null,
      replayPurgedAt: "2018-09-30T00:00:00.000Z",
    });
    const result = await runRetentionCleanup(testEnv.DB, now);
    expect(result.payment_evidence_deleted).toBe(1);
    expect(await getPaymentRow(testEnv.DB, recent.requestId)).toMatchObject({ state: "accepted" });
    expect(await getPaymentRow(testEnv.DB, old.requestId)).toBeNull();
    expect(await getPaymentRow(testEnv.DB, ambiguous.requestId)).toMatchObject({ state: "ambiguous" });
  });

  it("retains callback, event, and replay repair data for an unresolved ambiguous wait", async () => {
    const seeded = await seedLifecycle({
      suffix: "unresolved-ambiguous",
      waitState: "ambiguous",
      terminalAt: before(days(40)),
      eventReceivedAt: before(days(41)),
      replayExpiresAt: before(days(10)),
    });
    await runRetentionCleanup(testEnv.DB, now);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "ambiguous",
      callback_url: "https://agent.example.com/callback",
      client_reference: "job-unresolved-ambiguous",
      event_json: JSON.stringify(seeded.event),
      event_content_purged_at: null,
    });
    expect(await testEnv.DB.prepare(
      "SELECT replay_purged_at, request_fingerprint FROM idempotent_requests WHERE request_id = ?",
    ).bind(seeded.requestId).first()).toEqual({
      replay_purged_at: null,
      request_fingerprint: "fingerprint-unresolved-ambiguous",
    });
  });

  it("applies ordinary terminal cleanup to an ambiguity-honored wait while retaining payment truth", async () => {
    const honoredAt = before(days(4));
    const seeded = await seedLifecycle({
      suffix: "honored-ambiguity-terminal",
      paymentState: "ambiguous",
      paymentAcceptedAt: null,
      ambiguityHonoredAt: honoredAt,
    });
    const result = await runRetentionCleanup(testEnv.DB, now);
    expect(result.event_content_purged).toBe(1);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "delivered",
      callback_url: "https://purged.invalid/",
      event_json: null,
    });
    expect(await getPaymentRow(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "ambiguous",
      accepted_at: null,
      ambiguity_honored_at: honoredAt,
    });
  });

  it("releases only a stale pre-settlement admission and can atomically re-admit it", async () => {
    const requestId = "request-stale-admission";
    const old = before(10 * 60 * 1000);
    await testEnv.DB.prepare(
      `INSERT INTO idempotent_requests (
         request_id, idempotency_key_hash, request_fingerprint, state,
         replay_expires_at, created_at, updated_at
       ) VALUES (?, 'key-stale-admission', 'fingerprint-stale-admission', 'reserved', NULL, ?, ?)`,
    ).bind(requestId, old, old).run();
    await testEnv.DB.prepare(
      `INSERT INTO request_payments (request_id, state, created_at, updated_at)
       VALUES (?, 'reserved', ?, ?)`,
    ).bind(requestId, old, old).run();
    await testEnv.DB.prepare(
      `INSERT INTO commercial_admissions (
         request_id, capacity_day, state, counts_daily, active_held, created_at, updated_at
       ) VALUES (?, ?, 'reserved', 1, 1, ?, ?)`,
    ).bind(requestId, now.toISOString().slice(0, 10), old, old).run();
    const cleanup = await runRetentionCleanup(testEnv.DB, now);
    expect(cleanup.abandoned_admissions_released).toBe(1);
    expect(await testEnv.DB.prepare(
      "SELECT state, counts_daily, active_held FROM commercial_admissions WHERE request_id = ?",
    ).bind(requestId).first()).toEqual({ state: "released", counts_daily: 0, active_held: 0 });

    await testEnv.DB.prepare("UPDATE service_controls SET new_sales_enabled = 1 WHERE id = 1").run();
    await expect(reserveCommercialAdmission(testEnv.DB, requestId, now)).resolves.toMatchObject({
      state: "reserved",
      counts_daily: 1,
      active_held: 1,
    });
  });

  it("deletes only abandoned pre-settlement reservations with no commercial or financial boundary", async () => {
    const old = before(10 * 60 * 1000);
    const abandoned = "request-abandoned-pre-settlement";
    const requestOnly = "request-abandoned-before-payment-row";
    const attempted = "request-financial-boundary-crossed";
    for (const [requestId, state] of [[abandoned, "reserved"], [requestOnly, "reserved"], [attempted, "settling"]] as const) {
      await testEnv.DB.prepare(
        `INSERT INTO idempotent_requests (
           request_id, idempotency_key_hash, request_fingerprint, state,
           replay_expires_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      ).bind(requestId, `key-${requestId}`, `fingerprint-${requestId}`, state, old, old).run();
    }
    await testEnv.DB.prepare(
      `INSERT INTO request_payments (request_id, state, created_at, updated_at)
       VALUES (?, 'reserved', ?, ?)`,
    ).bind(abandoned, old, old).run();
    await testEnv.DB.prepare(
      `INSERT INTO request_payments (
         request_id, state, settlement_authorized_at, external_operation_id,
         external_call_started_at, created_at, updated_at
       ) VALUES (?, 'settling', ?, 'wait-payment-attempted', ?, ?, ?)`,
    ).bind(attempted, old, old, old, old).run();

    const cleanup = await runRetentionCleanup(testEnv.DB, now);
    expect(cleanup.abandoned_payment_reservations_deleted).toBe(1);
    expect(cleanup.abandoned_request_reservations_deleted).toBe(2);
    expect(await getPaymentRow(testEnv.DB, abandoned)).toBeNull();
    expect(await testEnv.DB.prepare(
      "SELECT request_id FROM idempotent_requests WHERE request_id IN (?, ?)",
    ).bind(abandoned, requestOnly).all()).toMatchObject({ results: [] });
    expect(await getPaymentRow(testEnv.DB, attempted)).toMatchObject({
      state: "settling",
      external_call_started_at: old,
    });
    expect(await testEnv.DB.prepare(
      "SELECT state FROM idempotent_requests WHERE request_id = ?",
    ).bind(attempted).first()).toEqual({ state: "settling" });
  });

  it("makes overlapping scheduled cleanup invocations converge idempotently", async () => {
    const seeded = await seedLifecycle({ suffix: "overlapping-cleanup" });
    const [first, second] = await Promise.all([
      runRetentionCleanup(testEnv.DB, now),
      runRetentionCleanup(testEnv.DB, now),
    ]);
    expect(first.event_content_purged + second.event_content_purged).toBe(1);
    expect(first.wait_metadata_deleted + second.wait_metadata_deleted).toBe(0);
    expect(await getWaitByRequestId(testEnv.DB, seeded.requestId)).toMatchObject({
      state: "delivered",
      callback_url: "https://purged.invalid/",
      event_json: null,
      event_content_purged_at: now.toISOString(),
    });
    expect(await getPaymentRow(testEnv.DB, seeded.requestId)).toMatchObject({ state: "accepted" });
  });
});


describe("durable monitoring reconciliation against local D1", () => {
  it("detects recent failures and exhausted closed fuse while preserving historical ambiguity", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (let i = 0; i < 5; i++) await seedLifecycle({ suffix: "historical-" + i, paymentState: "ambiguous", ambiguityHonoredAt: before(days(10)), includeWait: false });
      const recent = await seedLifecycle({ suffix: "recent-failure", paymentState: "ambiguous", ambiguityHonoredAt: now.toISOString(), createdAt: now.toISOString(), waitState: "delivery_failed", terminalAt: now.toISOString() });
      await testEnv.DB.prepare("UPDATE service_controls SET new_sales_enabled = 0, max_ambiguous_payment_honors = 6 WHERE id = 1").run();
      await reconcileIncidentMonitoring(testEnv.DB, now);
      expect(log.mock.calls.map(call => call[0])).toEqual([
        { service: "wait", event: "wait_incident", incident: "payment_ambiguity", source: "reconciliation", count: 1 },
        { service: "wait", event: "wait_incident", incident: "callback_failure", source: "reconciliation", count: 1 },
        { service: "wait", event: "wait_incident", incident: "sales_fuse_closed", source: "reconciliation", count: 1 },
      ]);
      expect(await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM request_payments WHERE state = 'ambiguous' AND request_id LIKE 'request-historical-%'").first()).toEqual({ n: 5 });
      expect((await getWaitByRequestId(testEnv.DB, recent.requestId))?.state).toBe("delivery_failed");
      log.mockClear();
      await testEnv.DB.prepare("UPDATE service_controls SET new_sales_enabled = 1 WHERE id = 1").run();
      await reconcileIncidentMonitoring(testEnv.DB, new Date(now.getTime() + days(1)));
      expect(log).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });
});
