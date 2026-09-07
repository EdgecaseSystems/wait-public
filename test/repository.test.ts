import { describe, expect, it, vi } from "vitest";
import {
  acceptFirstEvent,
  acceptSettledPayment,
  activateWait,
  cancelWaitingWait,
  createProvisioningWait,
  deliveryWorkflowInstanceId,
  ensurePaymentRow,
  expireWaitingWait,
  getPaymentRow,
  getRequestById,
  getWaitByRequestId,
  markDeliveryWorkflowStarted,
  reserveRequest,
  transitionPaymentState,
  transitionRequestState,
  type IdempotentRequestRow,
  type PaymentRow,
  type WaitRow,
} from "../src/repository";

function repositoryDb(): D1Database {
  const requestsByKey = new Map<string, IdempotentRequestRow>();
  const payments = new Map<string, PaymentRow>();
  const waits = new Map<string, WaitRow>();

  const findWait = (predicate: (row: WaitRow) => boolean) => [...waits.values()].find(predicate);
  const normalized = (sql: string) => sql.replace(/\s+/gu, " ").trim();

  const prepare = vi.fn((rawSql: string) => {
    const sql = normalized(rawSql);
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => { values = bound; return statement; },
      first: async () => {
        if (sql.includes("FROM idempotent_requests") && sql.includes("idempotency_key_hash = ?")) {
          const row = requestsByKey.get(values[0] as string);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM idempotent_requests") && sql.includes("request_id = ?")) {
          const row = [...requestsByKey.values()].find((candidate) => candidate.request_id === values[0]);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM request_payments")) {
          const row = payments.get(values[0] as string);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM waits") && sql.includes("request_id = ?")) {
          const row = findWait((candidate) => candidate.request_id === values[0]);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM waits") && sql.includes("status_token_hash = ?")) {
          const row = findWait((candidate) => candidate.status_token_hash === values[0]);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM waits") && sql.includes("event_token_hash = ?")) {
          const row = findWait((candidate) => candidate.event_token_hash === values[0]);
          if (!row) return null;
          if (sql.startsWith("SELECT wait_id, delivery_workflow_instance_id")) {
            return {
              wait_id: row.wait_id,
              delivery_workflow_instance_id: row.delivery_workflow_instance_id,
              state: row.state,
              expires_at: row.expires_at,
              event_fingerprint: row.event_fingerprint,
            };
          }
          return { ...row };
        }
        if (sql.includes("FROM waits") && sql.includes("wait_id = ?")) {
          const row = waits.get(values[0] as string);
          return row ? { ...row } : null;
        }
        if (sql.includes("FROM service_controls")) {
          return {
            id: 1,
            new_sales_enabled: 0,
            callback_delivery_enabled: 1,
            max_active_waits: 100,
            max_paid_waits_per_day: 100,
            max_ambiguous_payment_honors: 3,
            updated_at: "2026-09-01T00:00:00.000Z",
          };
        }
        return null;
      },
      run: async () => {
        let changes = 0;
        if (sql.startsWith("INSERT OR IGNORE INTO idempotent_requests")) {
          const [requestId, keyHash, fingerprint, replayExpiresAt, createdAt, updatedAt] = values as [string, string, string, string | null, string, string];
          if (!requestsByKey.has(keyHash)) {
            requestsByKey.set(keyHash, {
              request_id: requestId,
              idempotency_key_hash: keyHash,
              request_fingerprint: fingerprint,
              state: "reserved",
              replay_expires_at: replayExpiresAt,
              replay_purged_at: null,
              created_at: createdAt,
              updated_at: updatedAt,
            });
            changes = 1;
          }
        } else if (sql.startsWith("UPDATE idempotent_requests")) {
          const [to, updatedAt, requestId, from] = values as [IdempotentRequestRow["state"], string, string, IdempotentRequestRow["state"]];
          const row = [...requestsByKey.values()].find((candidate) => candidate.request_id === requestId);
          if (row?.state === from) {
            row.state = to;
            row.updated_at = updatedAt;
            changes = 1;
          }
        } else if (sql.startsWith("INSERT OR IGNORE INTO request_payments")) {
          const [requestId, createdAt, updatedAt] = values as [string, string, string];
          if (!payments.has(requestId)) {
            payments.set(requestId, {
              request_id: requestId,
              state: "reserved",
              network: null,
              asset: null,
              amount: null,
              pay_to: null,
              payment_proof_fingerprint: null,
              payer_identity: null,
              transaction_id: null,
              accepted_at: null,
              settlement_authorized_at: null,
              external_operation_id: null,
              external_call_started_at: null,
              reconciliation_checked_at: null,
              reconciliation_status: null,
              failure_code: null,
              ambiguity_honored_at: null,
              created_at: createdAt,
              updated_at: updatedAt,
            });
            changes = 1;
          }
        } else if (sql.startsWith("UPDATE request_payments SET state = ?")) {
          const [to, updatedAt, requestId, from] = values as [PaymentRow["state"], string, string, PaymentRow["state"]];
          const row = payments.get(requestId);
          if (row?.state === from) {
            row.state = to;
            row.updated_at = updatedAt;
            changes = 1;
          }
        } else if (sql.startsWith("UPDATE request_payments SET state = 'accepted'")) {
          const [network, asset, amount, payTo, proof, payer, transaction, acceptedAt, updatedAt, requestId] = values as string[];
          const row = payments.get(requestId);
          if (row?.state === "settling") {
            Object.assign(row, {
              state: "accepted",
              network,
              asset,
              amount,
              pay_to: payTo,
              payment_proof_fingerprint: proof,
              payer_identity: payer,
              transaction_id: transaction,
              accepted_at: acceptedAt,
              updated_at: updatedAt,
            });
            changes = 1;
          }
        } else if (sql.startsWith("INSERT INTO waits")) {
          const [waitId, requestId, publicOrigin, callbackUrl, clientReference, keyVersion, eventHash, statusHash, createdAt, expiresAt, updatedAt] = values as [string, string, string, string, string | null, number, string, string, string, string, string];
          if (!waits.has(waitId) && !findWait((row) => row.request_id === requestId)) {
            waits.set(waitId, {
              wait_id: waitId,
              request_id: requestId,
              delivery_workflow_instance_id: null,
              state: "provisioning",
              public_origin: publicOrigin,
              callback_url: callbackUrl,
              client_reference: clientReference,
              capability_key_version: keyVersion,
              event_token_hash: eventHash,
              status_token_hash: statusHash,
              event_fingerprint: null,
              event_json: null,
              event_received_at: null,
              callback_attempts: 0,
              callback_last_status: null,
              callback_last_error_code: null,
              callback_delivered_at: null,
              created_at: createdAt,
              expires_at: expiresAt,
              terminal_at: null,
              event_content_purged_at: null,
              callback_success_observed_at: null,
              updated_at: updatedAt,
            });
            changes = 1;
          }
        } else if (sql.startsWith("UPDATE waits SET state = 'waiting'")) {
          const [updatedAt, waitId] = values as string[];
          const row = waits.get(waitId);
          if (row?.state === "provisioning" && row.delivery_workflow_instance_id === null) {
            row.state = "waiting";
            row.updated_at = updatedAt;
            changes = 1;
          }
        } else if (sql.includes("SET state = 'event_received'")) {
          const [eventFingerprint, eventJson, receivedAt, updatedAt, eventHash, currentTime] = values as string[];
          const row = findWait((candidate) => candidate.event_token_hash === eventHash);
          if (row?.state === "waiting" && row.expires_at > currentTime) {
            row.state = "event_received";
            row.event_fingerprint = eventFingerprint;
            row.event_json = eventJson;
            row.event_received_at = receivedAt;
            row.delivery_workflow_instance_id = `delivery-${row.wait_id}`;
            row.updated_at = updatedAt;
            changes = 1;
          }
        } else if (sql.startsWith("UPDATE waits SET state = 'delivering'")) {
          const [updatedAt, waitId, workflowId] = values as string[];
          const row = waits.get(waitId);
          if (row?.state === "event_received" && row.delivery_workflow_instance_id === workflowId) {
            row.state = "delivering";
            row.updated_at = updatedAt;
            changes = 1;
          }
        } else if (sql.includes("SET state = 'cancelled'")) {
          const [terminalAt, updatedAt, statusHash, currentTime] = values as string[];
          const row = findWait((candidate) => candidate.status_token_hash === statusHash);
          if (row?.state === "waiting" && row.expires_at > currentTime) {
            row.state = "cancelled";
            row.terminal_at = terminalAt;
            row.updated_at = updatedAt;
            changes = 1;
          }
        } else if (sql.includes("SET state = 'expired'")) {
          const [terminalAt, updatedAt, waitId, currentTime] = values as string[];
          const row = waits.get(waitId);
          if (row?.state === "waiting" && row.expires_at <= currentTime) {
            row.state = "expired";
            row.terminal_at = terminalAt;
            row.updated_at = updatedAt;
            changes = 1;
          }
        }
        return { success: true, meta: { changes } };
      },
    };
    return statement;
  });

  const db = Object.create(null) as D1Database;
  Object.defineProperty(db, "prepare", { value: prepare });
  return db;
}

const now = new Date("2026-09-01T18:00:00.000Z");

async function provisionWaitingWait(db: D1Database, suffix: string, expiresAt = "2026-09-01T19:00:00.000Z") {
  await createProvisioningWait(db, {
    waitId: `wait-${suffix}`,
    requestId: `request-${suffix}`,
    publicOrigin: "https://wait.example.com",
    callbackUrl: "https://agent.example.com/events",
    clientReference: `job-${suffix}`,
    capabilityKeyVersion: 1,
    eventTokenHash: `event-${suffix}`,
    statusTokenHash: `status-${suffix}`,
    createdAt: now.toISOString(),
    expiresAt,
  });
  await activateWait(db, `wait-${suffix}`, now);
}

describe("D1 repository primitives", () => {
  it("reserves one logical request and returns the existing row for a same-key retry", async () => {
    const db = repositoryDb();
    const first = await reserveRequest(db, "key-hash", "request-hash", now, null, "request-1");
    const second = await reserveRequest(db, "key-hash", "request-hash", now, null, "request-2");
    expect(first).toEqual({ kind: "acquired", requestId: "request-1" });
    expect(second.kind).toBe("existing");
    if (second.kind === "existing") expect(second.row.request_id).toBe("request-1");
  });

  it("rejects reuse of the same idempotency key for a different request fingerprint", async () => {
    const db = repositoryDb();
    await reserveRequest(db, "key-hash", "request-a", now, null, "request-1");
    await expect(reserveRequest(db, "key-hash", "request-b", now, null, "request-2"))
      .rejects.toMatchObject({ code: "idempotency_key_conflict" });
  });

  it("uses conditional request transitions so stale writers cannot win", async () => {
    const db = repositoryDb();
    await reserveRequest(db, "key-hash", "request-hash", now, null, "request-1");
    await transitionRequestState(db, "request-1", "reserved", "settling", now);
    expect((await getRequestById(db, "request-1"))?.state).toBe("settling");
    await expect(transitionRequestState(db, "request-1", "reserved", "settling", now))
      .rejects.toMatchObject({ code: "idempotency_state_ambiguous" });
  });

  it("binds accepted payment evidence only from the unique settling state", async () => {
    const db = repositoryDb();
    await reserveRequest(db, "key-hash", "request-hash", now, null, "request-1");
    await ensurePaymentRow(db, "request-1", now);
    await transitionPaymentState(db, "request-1", "reserved", "settling", now);
    await acceptSettledPayment(db, "request-1", {
      network: "eip155:84532",
      asset: "test-usdc",
      amount: "10000",
      payTo: "0xrecipient",
      paymentProofFingerprint: "proof-hash",
      payerIdentity: "0xpayer",
      transactionId: "0xtx",
    }, now);
    const row = await getPaymentRow(db, "request-1");
    expect(row).toMatchObject({ state: "accepted", payment_proof_fingerprint: "proof-hash", transaction_id: "0xtx" });
    await expect(acceptSettledPayment(db, "request-1", {
      network: "eip155:84532",
      asset: "test-usdc",
      amount: "10000",
      payTo: "0xrecipient",
      paymentProofFingerprint: "proof-hash",
      payerIdentity: "0xpayer",
      transactionId: "0xtx",
    }, now)).rejects.toMatchObject({ code: "idempotency_state_ambiguous" });
  });

  it("creates no Workflow merely because a paid wait is waiting", async () => {
    const db = repositoryDb();
    await provisionWaitingWait(db, "idle");
    const row = await getWaitByRequestId(db, "request-idle");
    expect(row?.state).toBe("waiting");
    expect(row?.delivery_workflow_instance_id).toBeNull();
    expect(row?.event_fingerprint).toBeNull();
  });

  it("first event wins and a semantic retry with reordered JSON keys identifies the same accepted event", async () => {
    const db = repositoryDb();
    await provisionWaitingWait(db, "1");
    const first = await acceptFirstEvent(db, "event-1", { status: "complete", nested: { b: 2, a: 1 } }, now);
    const retry = await acceptFirstEvent(db, "event-1", { nested: { a: 1, b: 2 }, status: "complete" }, now);
    expect(first).toEqual({ kind: "accepted", waitId: "wait-1", deliveryWorkflowInstanceId: "delivery-wait-1" });
    expect(retry).toEqual({
      kind: "same_event_retry",
      waitId: "wait-1",
      deliveryWorkflowInstanceId: "delivery-wait-1",
      state: "event_received",
    });
    const row = await getWaitByRequestId(db, "request-1");
    expect(JSON.parse(row?.event_json ?? "null")).toEqual({ nested: { a: 1, b: 2 }, status: "complete" });
    expect(row?.event_fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(row?.delivery_workflow_instance_id).toBe(deliveryWorkflowInstanceId("wait-1"));
  });

  it("different later event is a conflict and cannot overwrite the accepted event", async () => {
    const db = repositoryDb();
    await provisionWaitingWait(db, "different");
    await acceptFirstEvent(db, "event-different", { status: "complete", value: 1 }, now);
    const different = await acceptFirstEvent(db, "event-different", { status: "complete", value: 2 }, now);
    expect(different).toEqual({ kind: "different_event_conflict", waitId: "wait-different", state: "event_received" });
    expect(JSON.parse((await getWaitByRequestId(db, "request-different"))?.event_json ?? "null"))
      .toEqual({ status: "complete", value: 1 });
  });

  it("lets the delivery Workflow prove its deterministic identity and enter delivering idempotently", async () => {
    const db = repositoryDb();
    await provisionWaitingWait(db, "delivery");
    await acceptFirstEvent(db, "event-delivery", { status: "complete" }, now);
    expect(await markDeliveryWorkflowStarted(db, "wait-delivery", "delivery-wait-delivery", now)).toBe("started");
    expect(await markDeliveryWorkflowStarted(db, "wait-delivery", "delivery-wait-delivery", now)).toBe("already_started");
    await expect(markDeliveryWorkflowStarted(db, "wait-delivery", "delivery-wrong", now))
      .rejects.toMatchObject({ code: "idempotency_state_ambiguous" });
  });

  it("cancellation wins cleanly when it commits before the event", async () => {
    const db = repositoryDb();
    await provisionWaitingWait(db, "2");
    expect(await cancelWaitingWait(db, "status-2", now)).toEqual({ kind: "cancelled", waitId: "wait-2" });
    expect(await acceptFirstEvent(db, "event-2", { status: "complete" }, now))
      .toEqual({ kind: "not_waiting", waitId: "wait-2", state: "cancelled" });
  });

  it("event acceptance wins cleanly when it commits before cancellation", async () => {
    const db = repositoryDb();
    await provisionWaitingWait(db, "3");
    await acceptFirstEvent(db, "event-3", { status: "complete" }, now);
    expect(await cancelWaitingWait(db, "status-3", now))
      .toEqual({ kind: "not_cancellable", waitId: "wait-3", state: "event_received" });
  });

  it("expires only a still-waiting entitlement whose deadline has arrived", async () => {
    const db = repositoryDb();
    await provisionWaitingWait(db, "4", "2026-09-01T17:59:59.000Z");
    expect(await expireWaitingWait(db, "wait-4", now)).toBe(true);
    expect((await getWaitByRequestId(db, "request-4"))?.state).toBe("expired");
    expect(await expireWaitingWait(db, "wait-4", now)).toBe(false);
  });
});
