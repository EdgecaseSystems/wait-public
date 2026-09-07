import { reportIncident, reportSalesFuseState } from "./monitoring";
import { canonicalJson, fingerprint } from "./canonical";
import { LifecycleError } from "./errors";
import { assertPaymentTransition, assertRequestTransition, assertWaitTransition } from "./state";
import type { IdempotentRequestState, JsonValue, PaymentState, WaitState } from "./types";

export interface IdempotentRequestRow {
  request_id: string;
  idempotency_key_hash: string;
  request_fingerprint: string;
  state: IdempotentRequestState;
  replay_expires_at: string | null;
  replay_purged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentRow {
  request_id: string;
  state: PaymentState;
  network: string | null;
  asset: string | null;
  amount: string | null;
  pay_to: string | null;
  payment_proof_fingerprint: string | null;
  payer_identity: string | null;
  transaction_id: string | null;
  accepted_at: string | null;
  settlement_authorized_at: string | null;
  external_operation_id: string | null;
  external_call_started_at: string | null;
  reconciliation_checked_at: string | null;
  reconciliation_status: string | null;
  failure_code: string | null;
  ambiguity_honored_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WaitRow {
  wait_id: string;
  request_id: string;
  delivery_workflow_instance_id: string | null;
  state: WaitState;
  public_origin: string;
  callback_url: string;
  client_reference: string | null;
  capability_key_version: number;
  event_token_hash: string;
  status_token_hash: string;
  event_fingerprint: string | null;
  event_json: string | null;
  event_received_at: string | null;
  callback_attempts: number;
  callback_last_status: number | null;
  callback_last_error_code: string | null;
  callback_delivered_at: string | null;
  created_at: string;
  expires_at: string;
  terminal_at: string | null;
  event_content_purged_at: string | null;
  callback_success_observed_at: string | null;
  updated_at: string;
}

export interface ServiceControlsRow {
  id: 1;
  new_sales_enabled: 0 | 1;
  callback_delivery_enabled: 0 | 1;
  max_active_waits: number;
  max_paid_waits_per_day: number;
  max_ambiguous_payment_honors: number;
  updated_at: string;
}

export type RequestReservation =
  | { kind: "acquired"; requestId: string }
  | { kind: "existing"; row: IdempotentRequestRow };

function changes(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

export function deliveryWorkflowInstanceId(waitId: string): string {
  const value = `delivery-${waitId}`;
  if (value.length > 100) throw new RangeError("Derived Workflow instance ID exceeds Cloudflare's 100-character limit.");
  return value;
}

export async function reserveRequest(
  db: D1Database,
  idempotencyKeyHash: string,
  requestFingerprint: string,
  now: Date,
  replayExpiresAt: string | null = null,
  requestId: string = crypto.randomUUID(),
): Promise<RequestReservation> {
  const timestamp = now.toISOString();
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO idempotent_requests (
      request_id, idempotency_key_hash, request_fingerprint, state,
      replay_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'reserved', ?, ?, ?)`,
  ).bind(requestId, idempotencyKeyHash, requestFingerprint, replayExpiresAt, timestamp, timestamp).run();

  if (changes(inserted) === 1) return { kind: "acquired", requestId };

  const row = await db.prepare(
    `SELECT request_id, idempotency_key_hash, request_fingerprint, state,
            replay_expires_at, replay_purged_at, created_at, updated_at
       FROM idempotent_requests
      WHERE idempotency_key_hash = ?`,
  ).bind(idempotencyKeyHash).first<IdempotentRequestRow>();

  if (!row) throw new LifecycleError("idempotency_state_ambiguous", "Idempotency reservation exists but cannot be recovered.");
  if (row.request_fingerprint !== requestFingerprint) {
    throw new LifecycleError("idempotency_key_conflict", "The Idempotency-Key is already bound to a different logical request.");
  }
  return { kind: "existing", row };
}

export async function transitionRequestState(
  db: D1Database,
  requestId: string,
  from: IdempotentRequestState,
  to: IdempotentRequestState,
  now: Date,
): Promise<void> {
  assertRequestTransition(from, to);
  const result = await db.prepare(
    `UPDATE idempotent_requests
        SET state = ?, updated_at = ?
      WHERE request_id = ? AND state = ?`,
  ).bind(to, now.toISOString(), requestId, from).run();
  if (changes(result) !== 1) {
    throw new LifecycleError("idempotency_state_ambiguous", `Lost request-state transition ${from} -> ${to}.`);
  }
}

export async function getRequestById(db: D1Database, requestId: string): Promise<IdempotentRequestRow | null> {
  return db.prepare(
    `SELECT request_id, idempotency_key_hash, request_fingerprint, state,
            replay_expires_at, replay_purged_at, created_at, updated_at
       FROM idempotent_requests WHERE request_id = ?`,
  ).bind(requestId).first<IdempotentRequestRow>();
}

export async function ensurePaymentRow(db: D1Database, requestId: string, now: Date): Promise<PaymentRow> {
  const timestamp = now.toISOString();
  await db.prepare(
    `INSERT OR IGNORE INTO request_payments (
      request_id, state, created_at, updated_at
    ) VALUES (?, 'reserved', ?, ?)`,
  ).bind(requestId, timestamp, timestamp).run();
  const row = await db.prepare(
    `SELECT request_id, state, network, asset, amount, pay_to,
            payment_proof_fingerprint, payer_identity, transaction_id,
            accepted_at, settlement_authorized_at, external_operation_id,
            external_call_started_at, reconciliation_checked_at, reconciliation_status,
            failure_code, ambiguity_honored_at, created_at, updated_at
       FROM request_payments WHERE request_id = ?`,
  ).bind(requestId).first<PaymentRow>();
  if (!row) throw new LifecycleError("idempotency_state_ambiguous", "Payment row could not be recovered.");
  return row;
}

export async function transitionPaymentState(
  db: D1Database,
  requestId: string,
  from: PaymentState,
  to: PaymentState,
  now: Date,
): Promise<void> {
  assertPaymentTransition(from, to);
  const result = await db.prepare(
    `UPDATE request_payments SET state = ?, updated_at = ?
      WHERE request_id = ? AND state = ?`,
  ).bind(to, now.toISOString(), requestId, from).run();
  if (changes(result) !== 1) {
    throw new LifecycleError("idempotency_state_ambiguous", `Lost payment-state transition ${from} -> ${to}.`);
  }
}

export interface AcceptedPaymentEvidence {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  paymentProofFingerprint: string;
  payerIdentity: string;
  transactionId: string;
}

export async function acceptSettledPayment(
  db: D1Database,
  requestId: string,
  evidence: AcceptedPaymentEvidence,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE request_payments
        SET state = 'accepted', network = ?, asset = ?, amount = ?, pay_to = ?,
            payment_proof_fingerprint = ?, payer_identity = ?, transaction_id = ?,
            accepted_at = ?, updated_at = ?
      WHERE request_id = ? AND state = 'settling'`,
  ).bind(
    evidence.network,
    evidence.asset,
    evidence.amount,
    evidence.payTo,
    evidence.paymentProofFingerprint,
    evidence.payerIdentity,
    evidence.transactionId,
    timestamp,
    timestamp,
    requestId,
  ).run();
  if (changes(result) !== 1) {
    throw new LifecycleError("idempotency_state_ambiguous", "Accepted payment could not be bound from the unique settling state.");
  }
}

export async function getPaymentRow(db: D1Database, requestId: string): Promise<PaymentRow | null> {
  return db.prepare(
    `SELECT request_id, state, network, asset, amount, pay_to,
            payment_proof_fingerprint, payer_identity, transaction_id,
            accepted_at, settlement_authorized_at, external_operation_id,
            external_call_started_at, reconciliation_checked_at, reconciliation_status,
            failure_code, ambiguity_honored_at, created_at, updated_at
       FROM request_payments WHERE request_id = ?`,
  ).bind(requestId).first<PaymentRow>();
}

export interface ProvisioningWaitInput {
  waitId: string;
  requestId: string;
  publicOrigin: string;
  callbackUrl: string;
  clientReference: string | null;
  capabilityKeyVersion: number;
  eventTokenHash: string;
  statusTokenHash: string;
  createdAt: string;
  expiresAt: string;
}

export async function createProvisioningWait(db: D1Database, input: ProvisioningWaitInput): Promise<void> {
  const result = await db.prepare(
    `INSERT INTO waits (
      wait_id, request_id, delivery_workflow_instance_id, state, public_origin,
      callback_url, client_reference, capability_key_version,
      event_token_hash, status_token_hash, event_fingerprint,
      created_at, expires_at, updated_at
    ) VALUES (?, ?, NULL, 'provisioning', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
  ).bind(
    input.waitId,
    input.requestId,
    input.publicOrigin,
    input.callbackUrl,
    input.clientReference,
    input.capabilityKeyVersion,
    input.eventTokenHash,
    input.statusTokenHash,
    input.createdAt,
    input.expiresAt,
    input.createdAt,
  ).run();
  if (changes(result) !== 1) {
    throw new LifecycleError("idempotency_state_ambiguous", "Wait entitlement could not be created uniquely.");
  }
}

/**
 * Activates the durable D1 entitlement. There is intentionally no Workflow at
 * this point. A delivery Workflow is created only after an event wins.
 */
export async function activateWait(db: D1Database, waitId: string, now: Date): Promise<void> {
  assertWaitTransition("provisioning", "waiting");
  const result = await db.prepare(
    `UPDATE waits SET state = 'waiting', updated_at = ?
      WHERE wait_id = ? AND state = 'provisioning' AND delivery_workflow_instance_id IS NULL`,
  ).bind(now.toISOString(), waitId).run();
  if (changes(result) !== 1) {
    throw new LifecycleError("idempotency_state_ambiguous", "Wait activation lost its unique provisioning state.");
  }
}

export async function getWaitByRequestId(db: D1Database, requestId: string): Promise<WaitRow | null> {
  return db.prepare(`SELECT * FROM waits WHERE request_id = ?`).bind(requestId).first<WaitRow>();
}

export async function getWaitByStatusTokenHash(db: D1Database, statusTokenHash: string): Promise<WaitRow | null> {
  return db.prepare(`SELECT * FROM waits WHERE status_token_hash = ?`).bind(statusTokenHash).first<WaitRow>();
}

export type EventAcceptanceResult =
  | { kind: "accepted"; waitId: string; deliveryWorkflowInstanceId: string }
  | { kind: "same_event_retry"; waitId: string; deliveryWorkflowInstanceId: string; state: WaitState }
  | { kind: "different_event_conflict"; waitId: string; state: WaitState }
  | { kind: "not_found" }
  | { kind: "not_waiting"; waitId: string; state: WaitState };

/**
 * D1 is the authoritative first-event-wins boundary. The accepted event is
 * canonicalized and fingerprinted so a semantically identical JSON retry can
 * safely resume delivery-Workflow provisioning, while a different later event
 * is classified as a conflict rather than misreported as accepted.
 */
export async function acceptFirstEvent(
  db: D1Database,
  eventTokenHash: string,
  event: JsonValue,
  now: Date,
): Promise<EventAcceptanceResult> {
  const timestamp = now.toISOString();
  const eventJson = canonicalJson(event);
  const eventFingerprint = await fingerprint(event, "edgecase-wait-event-v1");
  const result = await db.prepare(
    `UPDATE waits
        SET state = 'event_received', event_fingerprint = ?, event_json = ?, event_received_at = ?,
            delivery_workflow_instance_id = 'delivery-' || wait_id,
            updated_at = ?
      WHERE event_token_hash = ? AND state = 'waiting' AND expires_at > ?`,
  ).bind(eventFingerprint, eventJson, timestamp, timestamp, eventTokenHash, timestamp).run();

  const row = await db.prepare(
    `SELECT wait_id, delivery_workflow_instance_id, state, expires_at, event_fingerprint
       FROM waits WHERE event_token_hash = ?`,
  ).bind(eventTokenHash).first<Pick<WaitRow, "wait_id" | "delivery_workflow_instance_id" | "state" | "expires_at" | "event_fingerprint">>();

  if (changes(result) === 1) {
    if (!row?.delivery_workflow_instance_id || row.state !== "event_received" || row.event_fingerprint !== eventFingerprint) {
      throw new LifecycleError("idempotency_state_ambiguous", "Event was accepted but its durable event/Workflow identity cannot be proven.");
    }
    const expected = deliveryWorkflowInstanceId(row.wait_id);
    if (row.delivery_workflow_instance_id !== expected) {
      throw new LifecycleError("idempotency_state_ambiguous", "Durable delivery Workflow identity does not match the deterministic Wait mapping.");
    }
    return { kind: "accepted", waitId: row.wait_id, deliveryWorkflowInstanceId: expected };
  }
  if (!row) return { kind: "not_found" };

  if (
    row.delivery_workflow_instance_id &&
    row.event_fingerprint === eventFingerprint &&
    ["event_received", "delivering", "delivered", "delivery_failed"].includes(row.state)
  ) {
    return {
      kind: "same_event_retry",
      waitId: row.wait_id,
      deliveryWorkflowInstanceId: row.delivery_workflow_instance_id,
      state: row.state,
    };
  }

  if (
    row.event_fingerprint !== null &&
    row.event_fingerprint !== eventFingerprint &&
    ["event_received", "delivering", "delivered", "delivery_failed"].includes(row.state)
  ) {
    return { kind: "different_event_conflict", waitId: row.wait_id, state: row.state };
  }

  return { kind: "not_waiting", waitId: row.wait_id, state: row.state };
}

/**
 * Called by the delivery Workflow when it begins. Re-entry with the same stable
 * Workflow ID is idempotent, which lets createBatch/recovery safely converge.
 */
export async function markDeliveryWorkflowStarted(
  db: D1Database,
  waitId: string,
  workflowInstanceId: string,
  now: Date,
): Promise<"started" | "already_started"> {
  const expected = deliveryWorkflowInstanceId(waitId);
  if (workflowInstanceId !== expected) {
    throw new LifecycleError("idempotency_state_ambiguous", "Unexpected delivery Workflow identity.");
  }
  assertWaitTransition("event_received", "delivering");
  const result = await db.prepare(
    `UPDATE waits SET state = 'delivering', updated_at = ?
      WHERE wait_id = ? AND state = 'event_received' AND delivery_workflow_instance_id = ?`,
  ).bind(now.toISOString(), waitId, workflowInstanceId).run();
  if (changes(result) === 1) return "started";

  const row = await db.prepare(
    `SELECT state, delivery_workflow_instance_id FROM waits WHERE wait_id = ?`,
  ).bind(waitId).first<Pick<WaitRow, "state" | "delivery_workflow_instance_id">>();
  if (row?.state === "delivering" && row.delivery_workflow_instance_id === workflowInstanceId) return "already_started";
  throw new LifecycleError("idempotency_state_ambiguous", "Delivery Workflow could not prove ownership of the accepted event.");
}

export async function getRequestByIdempotencyKeyHash(
  db: D1Database,
  idempotencyKeyHash: string,
): Promise<IdempotentRequestRow | null> {
  return db.prepare(
    `SELECT request_id, idempotency_key_hash, request_fingerprint, state,
            replay_expires_at, replay_purged_at, created_at, updated_at
       FROM idempotent_requests WHERE idempotency_key_hash = ?`,
  ).bind(idempotencyKeyHash).first<IdempotentRequestRow>();
}

export async function getPaymentByProofFingerprint(db: D1Database, proofFingerprint: string): Promise<PaymentRow | null> {
  return db.prepare(
    `SELECT request_id, state, network, asset, amount, pay_to,
            payment_proof_fingerprint, payer_identity, transaction_id,
            accepted_at, settlement_authorized_at, external_operation_id,
            external_call_started_at, reconciliation_checked_at, reconciliation_status,
            failure_code, ambiguity_honored_at, created_at, updated_at
       FROM request_payments WHERE payment_proof_fingerprint = ?`,
  ).bind(proofFingerprint).first<PaymentRow>();
}

export interface PaymentAuthorizationEvidence {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  paymentProofFingerprint: string;
  externalOperationId: string;
}

/**
 * The only settlement-authorization boundary. Request and payment facts enter
 * settling together before an adapter can be called. A retry can therefore
 * never infer authority to call the adapter again from a partial in-memory fact.
 */
export async function authorizePaymentAttempt(
  db: D1Database,
  requestId: string,
  evidence: PaymentAuthorizationEvidence,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE idempotent_requests SET state = 'settling', updated_at = ?
        WHERE request_id = ? AND state = 'reserved'
          AND EXISTS (
            SELECT 1 FROM commercial_admissions
             WHERE request_id = ? AND state = 'reserved'
               AND counts_daily = 1 AND active_held = 1
          )`,
    ).bind(timestamp, requestId, requestId),
    db.prepare(
      `UPDATE request_payments
          SET state = 'settling', network = ?, asset = ?, amount = ?, pay_to = ?,
              payment_proof_fingerprint = ?, external_operation_id = ?,
              settlement_authorized_at = ?, updated_at = ?
        WHERE request_id = ? AND state = 'reserved'
          AND EXISTS (
            SELECT 1 FROM commercial_admissions
             WHERE request_id = ? AND state = 'reserved'
               AND counts_daily = 1 AND active_held = 1
          )`,
    ).bind(
      evidence.network,
      evidence.asset,
      evidence.amount,
      evidence.payTo,
      evidence.paymentProofFingerprint,
      evidence.externalOperationId,
      timestamp,
      timestamp,
      requestId,
      requestId,
    ),
  ]);
  if (results.length !== 2 || results.some((result) => changes(result) !== 1)) {
    throw new LifecycleError("idempotency_state_ambiguous", "Payment settlement authorization did not own one request/payment pair.");
  }
}

export async function markExternalPaymentCallStarted(db: D1Database, requestId: string, now: Date): Promise<void> {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE request_payments
        SET external_call_started_at = ?, updated_at = ?
      WHERE request_id = ? AND state = 'settling'
        AND settlement_authorized_at IS NOT NULL
        AND external_operation_id IS NOT NULL
        AND external_call_started_at IS NULL
        AND EXISTS (
          SELECT 1 FROM commercial_admissions
           WHERE request_id = ? AND state = 'reserved'
             AND counts_daily = 1 AND active_held = 1
        )`,
  ).bind(timestamp, timestamp, requestId, requestId).run();
  if (changes(result) !== 1) {
    throw new LifecycleError("idempotency_state_ambiguous", "External payment call boundary is not uniquely claimable.");
  }
}

export async function recordPaymentReconciliation(
  db: D1Database,
  requestId: string,
  status: "accepted" | "rejected" | "not_attempted" | "unknown",
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE request_payments
        SET reconciliation_checked_at = ?, reconciliation_status = ?, updated_at = ?
      WHERE request_id = ? AND state = 'settling'
        AND external_call_started_at IS NOT NULL`,
  ).bind(timestamp, status, timestamp, requestId).run();
  if (changes(result) !== 1) {
    throw new LifecycleError("idempotency_state_ambiguous", "Payment reconciliation result lost its settling lifecycle.");
  }
}

export async function commitAcceptedPayment(
  db: D1Database,
  requestId: string,
  evidence: AcceptedPaymentEvidence,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE request_payments
          SET state = 'accepted', payer_identity = ?, transaction_id = ?,
              accepted_at = ?, failure_code = NULL, updated_at = ?
        WHERE request_id = ? AND state = 'settling'
          AND network = ? AND asset = ? AND amount = ? AND pay_to = ?
          AND payment_proof_fingerprint = ?`,
    ).bind(
      evidence.payerIdentity,
      evidence.transactionId,
      timestamp,
      timestamp,
      requestId,
      evidence.network,
      evidence.asset,
      evidence.amount,
      evidence.payTo,
      evidence.paymentProofFingerprint,
    ),
    db.prepare(
      `UPDATE idempotent_requests SET state = 'payment_accepted', updated_at = ?
        WHERE request_id = ? AND state = 'settling'`,
    ).bind(timestamp, requestId),
    db.prepare(
      `UPDATE commercial_admissions
          SET state = 'accepted', counts_daily = 1, active_held = 1, updated_at = ?
        WHERE request_id = ? AND state = 'reserved' AND active_held = 1`,
    ).bind(timestamp, requestId),
  ]);
  if (results.length !== 3 || results.some((result) => changes(result) !== 1)) {
    throw new LifecycleError("idempotency_state_ambiguous", "Accepted payment could not become one durable request/payment fact.");
  }
}

export async function commitUnacceptedPayment(
  db: D1Database,
  requestId: string,
  outcome: "rejected",
  failureCode: string,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE request_payments SET state = ?, failure_code = ?, updated_at = ?
        WHERE request_id = ? AND state = 'settling'`,
    ).bind(outcome, failureCode, timestamp, requestId),
    db.prepare(
      `UPDATE idempotent_requests SET state = 'ambiguous', updated_at = ?
        WHERE request_id = ? AND state = 'settling'`,
    ).bind(timestamp, requestId),
    db.prepare(
      `UPDATE commercial_admissions
          SET state = ?, counts_daily = ?, active_held = ?, updated_at = ?
        WHERE request_id = ? AND state = 'reserved'`,
    ).bind(
      "released",
      0,
      0,
      timestamp,
      requestId,
    ),
  ]);
  if (results.length !== 3 || results.some((result) => changes(result) !== 1)) {
    throw new LifecycleError("idempotency_state_ambiguous", "Unaccepted payment result could not be committed conservatively.");
  }
}

export async function commitAmbiguousPaymentAndHonor(
  db: D1Database,
  requestId: string,
  failureCode: string,
  now: Date,
): Promise<void> {
  const timestamp = now.toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE request_payments
          SET state = 'ambiguous', failure_code = ?, ambiguity_honored_at = ?, updated_at = ?
        WHERE request_id = ? AND state = 'settling'
          AND settlement_authorized_at IS NOT NULL
          AND external_operation_id IS NOT NULL
          AND external_call_started_at IS NOT NULL`,
    ).bind(failureCode, timestamp, timestamp, requestId),
    db.prepare(
      `UPDATE idempotent_requests SET state = 'provisioning', updated_at = ?
        WHERE request_id = ? AND state = 'settling'`,
    ).bind(timestamp, requestId),
    db.prepare(
      `UPDATE commercial_admissions
          SET state = 'ambiguous', counts_daily = 1, active_held = 1, updated_at = ?
        WHERE request_id = ? AND state = 'reserved' AND active_held = 1`,
    ).bind(timestamp, requestId),
    db.prepare(
      `UPDATE service_controls
          SET new_sales_enabled = CASE
                WHEN (
                  SELECT COUNT(*) FROM request_payments
                   WHERE state = 'ambiguous' AND ambiguity_honored_at IS NOT NULL
                ) >= max_ambiguous_payment_honors THEN 0
                ELSE new_sales_enabled
              END,
              updated_at = CASE
                WHEN new_sales_enabled = 1 AND (
                  SELECT COUNT(*) FROM request_payments
                   WHERE state = 'ambiguous' AND ambiguity_honored_at IS NOT NULL
                ) >= max_ambiguous_payment_honors THEN ?
                ELSE updated_at
              END
        WHERE id = 1`,
    ).bind(timestamp),
  ]);
  if (results.length !== 4 || results.some((result) => changes(result) !== 1)) {
    throw new LifecycleError(
      "idempotency_state_ambiguous",
      "Ambiguous payment could not become one bounded, durable wait entitlement.",
    );
  }
  reportIncident("payment_ambiguity", "transition");
  await reportSalesFuseState(db);
}

export interface DeliveryPayloadRow {
  wait_id: string;
  delivery_workflow_instance_id: string;
  state: "delivering" | "delivered" | "delivery_failed";
  callback_url: string;
  client_reference: string | null;
  capability_key_version: number;
  event_json: string;
  event_received_at: string;
  callback_attempts: number;
}

export async function getDeliveryPayload(
  db: D1Database,
  waitId: string,
  workflowInstanceId: string,
): Promise<DeliveryPayloadRow> {
  const row = await db.prepare(
    `SELECT wait_id, delivery_workflow_instance_id, state, callback_url,
            client_reference, capability_key_version, event_json,
            event_received_at, callback_attempts
       FROM waits
      WHERE wait_id = ? AND delivery_workflow_instance_id = ?`,
  ).bind(waitId, workflowInstanceId).first<DeliveryPayloadRow>();
  if (
    !row ||
    !["delivering", "delivered", "delivery_failed"].includes(row.state) ||
    !row.callback_url ||
    !row.event_json ||
    !row.event_received_at
  ) {
    throw new LifecycleError("idempotency_state_ambiguous", "Delivery Workflow cannot recover its accepted event payload.");
  }
  return row;
}

export async function recordCallbackAttempt(
  db: D1Database,
  waitId: string,
  workflowInstanceId: string,
  attempt: number,
  status: number | null,
  errorCode: string | null,
  now: Date,
): Promise<void> {
  const result = await db.prepare(
      `UPDATE waits
        SET callback_attempts = ?, callback_last_status = ?,
            callback_last_error_code = ?,
            callback_success_observed_at = CASE WHEN ? BETWEEN 200 AND 299 THEN ? ELSE callback_success_observed_at END,
            updated_at = ?
      WHERE wait_id = ? AND state = 'delivering'
        AND delivery_workflow_instance_id = ? AND callback_attempts < ?`,
  ).bind(attempt, status, errorCode, status, now.toISOString(), now.toISOString(), waitId, workflowInstanceId, attempt).run();
  if (changes(result) === 1) return;

  const row = await db.prepare(
    `SELECT state, delivery_workflow_instance_id, callback_attempts
       FROM waits WHERE wait_id = ?`,
  ).bind(waitId).first<Pick<WaitRow, "state" | "delivery_workflow_instance_id" | "callback_attempts">>();
  if (
    row?.state === "delivering" &&
    row.delivery_workflow_instance_id === workflowInstanceId &&
    row.callback_attempts >= attempt
  ) return;
  throw new LifecycleError("idempotency_state_ambiguous", "Callback attempt could not prove delivery Workflow ownership.");
}

export async function recoverObservedCallbackSuccess(
  db: D1Database,
  waitId: string,
  workflowInstanceId: string,
  now: Date,
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT state, delivery_workflow_instance_id, callback_attempts,
            callback_last_status, callback_success_observed_at
       FROM waits WHERE wait_id = ?`,
  ).bind(waitId).first<Pick<
    WaitRow,
    "state" | "delivery_workflow_instance_id" | "callback_attempts" |
    "callback_last_status" | "callback_success_observed_at"
  >>();
  if (row?.state === "delivered" && row.delivery_workflow_instance_id === workflowInstanceId) return true;
  if (
    row?.state !== "delivering" || row.delivery_workflow_instance_id !== workflowInstanceId ||
    row.callback_attempts < 1 || row.callback_success_observed_at === null ||
    row.callback_last_status === null || row.callback_last_status < 200 || row.callback_last_status > 299
  ) return false;
  await completeCallbackDelivery(db, waitId, workflowInstanceId, now);
  return true;
}

export async function completeCallbackDelivery(
  db: D1Database,
  waitId: string,
  workflowInstanceId: string,
  now: Date,
): Promise<"delivered" | "already_delivered"> {
  assertWaitTransition("delivering", "delivered");
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE waits
        SET state = 'delivered', callback_delivered_at = ?, terminal_at = ?, updated_at = ?
      WHERE wait_id = ? AND state = 'delivering' AND delivery_workflow_instance_id = ?`,
  ).bind(timestamp, timestamp, timestamp, waitId, workflowInstanceId).run();
  if (changes(result) === 1) {
    await releaseCommercialActiveCapacityForWait(db, waitId, now);
    return "delivered";
  }
  const row = await db.prepare(
    `SELECT state, delivery_workflow_instance_id FROM waits WHERE wait_id = ?`,
  ).bind(waitId).first<Pick<WaitRow, "state" | "delivery_workflow_instance_id">>();
  if (row?.state === "delivered" && row.delivery_workflow_instance_id === workflowInstanceId) {
    await releaseCommercialActiveCapacityForWait(db, waitId, now);
    return "already_delivered";
  }
  throw new LifecycleError("idempotency_state_ambiguous", "Callback success could not be committed by its delivery Workflow.");
}

export async function failCallbackDelivery(
  db: D1Database,
  waitId: string,
  workflowInstanceId: string,
  now: Date,
): Promise<"delivery_failed" | "already_failed"> {
  assertWaitTransition("delivering", "delivery_failed");
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE waits SET state = 'delivery_failed', terminal_at = ?, updated_at = ?
      WHERE wait_id = ? AND state = 'delivering' AND delivery_workflow_instance_id = ?`,
  ).bind(timestamp, timestamp, waitId, workflowInstanceId).run();
  if (changes(result) === 1) {
    reportIncident("callback_failure", "transition");
    await releaseCommercialActiveCapacityForWait(db, waitId, now);
    return "delivery_failed";
  }
  const row = await db.prepare(
    `SELECT state, delivery_workflow_instance_id FROM waits WHERE wait_id = ?`,
  ).bind(waitId).first<Pick<WaitRow, "state" | "delivery_workflow_instance_id">>();
  if (row?.state === "delivery_failed" && row.delivery_workflow_instance_id === workflowInstanceId) {
    await releaseCommercialActiveCapacityForWait(db, waitId, now);
    return "already_failed";
  }
  throw new LifecycleError("idempotency_state_ambiguous", "Callback failure could not be committed by its delivery Workflow.");
}

export type CancellationResult =
  | { kind: "cancelled"; waitId: string }
  | { kind: "not_found" }
  | { kind: "not_cancellable"; waitId: string; state: WaitState };

export async function cancelWaitingWait(
  db: D1Database,
  statusTokenHash: string,
  now: Date,
): Promise<CancellationResult> {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE waits
        SET state = 'cancelled', terminal_at = ?, updated_at = ?
      WHERE status_token_hash = ? AND state = 'waiting' AND expires_at > ?`,
  ).bind(timestamp, timestamp, statusTokenHash, timestamp).run();
  const row = await db.prepare(
    `SELECT wait_id, state FROM waits WHERE status_token_hash = ?`,
  ).bind(statusTokenHash).first<Pick<WaitRow, "wait_id" | "state">>();

  if (changes(result) === 1) {
    if (!row || row.state !== "cancelled") {
      throw new LifecycleError("idempotency_state_ambiguous", "Cancellation succeeded but the durable state cannot be proven.");
    }
    await releaseCommercialActiveCapacityForWait(db, row.wait_id, now);
    return { kind: "cancelled", waitId: row.wait_id };
  }
  if (!row) return { kind: "not_found" };
  return { kind: "not_cancellable", waitId: row.wait_id, state: row.state };
}

export async function expireWaitingWait(db: D1Database, waitId: string, now: Date): Promise<boolean> {
  const timestamp = now.toISOString();
  const result = await db.prepare(
    `UPDATE waits
        SET state = 'expired', terminal_at = ?, updated_at = ?
      WHERE wait_id = ? AND state = 'waiting' AND expires_at <= ?`,
  ).bind(timestamp, timestamp, waitId, timestamp).run();
  if (changes(result) !== 1) return false;
  await releaseCommercialActiveCapacityForWait(db, waitId, now);
  return true;
}

export async function getServiceControls(db: D1Database): Promise<ServiceControlsRow> {
  const row = await db.prepare(
    `SELECT id, new_sales_enabled, callback_delivery_enabled,
            max_active_waits, max_paid_waits_per_day,
            max_ambiguous_payment_honors, updated_at
       FROM service_controls WHERE id = 1`,
  ).first<ServiceControlsRow>();
  if (!row) throw new LifecycleError("idempotency_state_ambiguous", "Service controls are missing.");
  return row;
}

export interface CommercialAdmissionRow {
  request_id: string;
  capacity_day: string;
  state: "reserved" | "accepted" | "released" | "ambiguous";
  counts_daily: 0 | 1;
  active_held: 0 | 1;
  created_at: string;
  updated_at: string;
}

export async function reserveCommercialAdmission(
  db: D1Database,
  requestId: string,
  now: Date,
): Promise<CommercialAdmissionRow> {
  const timestamp = now.toISOString();
  const day = timestamp.slice(0, 10);
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO commercial_admissions (
       request_id, capacity_day, state, counts_daily, active_held, created_at, updated_at
     )
     SELECT ?, ?, 'reserved', 1, 1, ?, ?
      WHERE (SELECT new_sales_enabled FROM service_controls WHERE id = 1) = 1
        AND (SELECT COUNT(*) FROM commercial_admissions WHERE active_held = 1) <
            (SELECT max_active_waits FROM service_controls WHERE id = 1)
        AND (SELECT COUNT(*) FROM commercial_admissions WHERE capacity_day = ? AND counts_daily = 1) <
            (SELECT max_paid_waits_per_day FROM service_controls WHERE id = 1)`,
  ).bind(requestId, day, timestamp, timestamp, day).run();

  const row = await db.prepare(
    `SELECT request_id, capacity_day, state, counts_daily, active_held, created_at, updated_at
       FROM commercial_admissions WHERE request_id = ?`,
  ).bind(requestId).first<CommercialAdmissionRow>();
  if (changes(inserted) === 1 && row?.state === "reserved") return row;
  if (row && row.state !== "released") return row;
  const controls = await getServiceControls(db);
  if (controls.new_sales_enabled !== 1) throw new Error("new_sales_disabled");
  if (row?.state === "released") {
    const recycled = await db.prepare(
      `UPDATE commercial_admissions
          SET capacity_day = ?, state = 'reserved', counts_daily = 1, active_held = 1, updated_at = ?
        WHERE request_id = ? AND state = 'released'
          AND EXISTS (
            SELECT 1 FROM idempotent_requests
             WHERE request_id = ? AND state = 'reserved'
          )
          AND NOT EXISTS (
            SELECT 1 FROM request_payments
             WHERE request_id = ? AND state <> 'reserved'
          )
          AND (SELECT COUNT(*) FROM commercial_admissions WHERE active_held = 1) < ?
          AND (SELECT COUNT(*) FROM commercial_admissions WHERE capacity_day = ? AND counts_daily = 1) < ?`,
    ).bind(
      day,
      timestamp,
      requestId,
      requestId,
      requestId,
      controls.max_active_waits,
      day,
      controls.max_paid_waits_per_day,
    ).run();
    if (changes(recycled) === 1) {
      const refreshed = await db.prepare(
        `SELECT request_id, capacity_day, state, counts_daily, active_held, created_at, updated_at
           FROM commercial_admissions WHERE request_id = ?`,
      ).bind(requestId).first<CommercialAdmissionRow>();
      if (refreshed?.state === "reserved") return refreshed;
    }
  }
  throw new LifecycleError("commercial_capacity_reached", "Commercial capacity is currently exhausted.", true, 60);
}

async function releaseCommercialActiveCapacityForWait(
  db: D1Database,
  waitId: string,
  now: Date,
): Promise<void> {
  await db.prepare(
    `UPDATE commercial_admissions
        SET active_held = 0, updated_at = ?
      WHERE request_id = (SELECT request_id FROM waits WHERE wait_id = ?)
        AND active_held = 1
        AND (
          state = 'accepted'
          OR (
            state = 'ambiguous'
            AND EXISTS (
              SELECT 1 FROM request_payments
               WHERE request_payments.request_id = commercial_admissions.request_id
                 AND request_payments.state = 'ambiguous'
                 AND request_payments.ambiguity_honored_at IS NOT NULL
            )
          )
        )`,
  ).bind(now.toISOString(), waitId).run();
}

export interface CommercialCapacitySnapshot {
  active_waits: number;
  paid_waits_today: number;
}

export async function getCommercialCapacity(db: D1Database, now: Date): Promise<CommercialCapacitySnapshot> {
  const day = now.toISOString().slice(0, 10);
  const [active, daily] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS count FROM commercial_admissions WHERE active_held = 1`,
    ),
    db.prepare(
      `SELECT COUNT(*) AS count FROM commercial_admissions
        WHERE capacity_day = ? AND counts_daily = 1`,
    ).bind(day),
  ]);
  return {
    active_waits: Number((active.results?.[0] as { count?: number } | undefined)?.count ?? 0),
    paid_waits_today: Number((daily.results?.[0] as { count?: number } | undefined)?.count ?? 0),
  };
}
