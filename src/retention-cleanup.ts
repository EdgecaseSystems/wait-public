import {
  ACCEPTED_EVENT_SAFETY_CEILING_MS,
  EVENT_RECOVERY_RETENTION_MS,
  PAYMENT_EVIDENCE_RETENTION_YEARS,
  WAIT_METADATA_RETENTION_MS,
} from "./retention";

export interface RetentionCleanupResult {
  expired_waits: number;
  active_capacity_released: number;
  abandoned_admissions_released: number;
  inactive_admissions_deleted: number;
  abandoned_payment_reservations_deleted: number;
  abandoned_request_reservations_deleted: number;
  stuck_events_flagged: number;
  event_content_purged: number;
  wait_metadata_deleted: number;
  replay_metadata_purged: number;
  payment_evidence_deleted: number;
  request_skeletons_deleted: number;
}

function isoBefore(now: Date, milliseconds: number): string {
  return new Date(now.getTime() - milliseconds).toISOString();
}

function yearsBefore(now: Date, years: number): string {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - years);
  return cutoff.toISOString();
}

function changed(result: D1Result<unknown>): number {
  return Number(result.meta?.changes ?? 0);
}

/**
 * Runs the frozen retention policy as one ordered D1 batch. Every mutation is
 * conditional, so concurrent lifecycle operations either win before cleanup
 * or observe the already-durable cleanup result. Accepted payment evidence is
 * never selected by the 72-hour or 30-day application windows.
 */
export async function runRetentionCleanup(db: D1Database, now: Date): Promise<RetentionCleanupResult> {
  const timestamp = now.toISOString();
  const eventCutoff = isoBefore(now, EVENT_RECOVERY_RETENTION_MS);
  const stuckCutoff = isoBefore(now, ACCEPTED_EVENT_SAFETY_CEILING_MS);
  const metadataCutoff = isoBefore(now, WAIT_METADATA_RETENTION_MS);
  const paymentCutoff = yearsBefore(now, PAYMENT_EVIDENCE_RETENTION_YEARS);
  const admissionCutoff = isoBefore(now, 5 * 60 * 1000);
  const currentDay = timestamp.slice(0, 10);

  const results = await db.batch([
    db.prepare(
      `UPDATE waits
          SET state = 'expired', terminal_at = expires_at, updated_at = ?
        WHERE state = 'waiting' AND expires_at <= ?`,
    ).bind(timestamp, timestamp),
    db.prepare(
      `UPDATE commercial_admissions
          SET active_held = 0, updated_at = ?
        WHERE active_held = 1
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
          )
          AND EXISTS (
            SELECT 1 FROM waits
             WHERE waits.request_id = commercial_admissions.request_id
               AND waits.state IN ('delivered', 'delivery_failed', 'expired', 'cancelled')
          )`,
    ).bind(timestamp),
    db.prepare(
      `UPDATE commercial_admissions
          SET state = 'released', counts_daily = 0, active_held = 0, updated_at = ?
        WHERE state = 'reserved' AND updated_at <= ?
          AND EXISTS (
            SELECT 1 FROM idempotent_requests
             WHERE idempotent_requests.request_id = commercial_admissions.request_id
               AND idempotent_requests.state = 'reserved'
          )
          AND NOT EXISTS (
            SELECT 1 FROM request_payments
             WHERE request_payments.request_id = commercial_admissions.request_id
               AND request_payments.state <> 'reserved'
          )`,
    ).bind(timestamp, admissionCutoff),
    db.prepare(
      `DELETE FROM commercial_admissions
        WHERE active_held = 0 AND capacity_day < ?`,
    ).bind(currentDay),
    db.prepare(
      `DELETE FROM request_payments
        WHERE state = 'reserved' AND updated_at <= ?
          AND settlement_authorized_at IS NULL
          AND external_operation_id IS NULL
          AND external_call_started_at IS NULL
          AND accepted_at IS NULL
          AND payment_proof_fingerprint IS NULL
          AND EXISTS (
            SELECT 1 FROM idempotent_requests
             WHERE idempotent_requests.request_id = request_payments.request_id
               AND idempotent_requests.state = 'reserved'
               AND idempotent_requests.updated_at <= ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM commercial_admissions
             WHERE commercial_admissions.request_id = request_payments.request_id
          )`,
    ).bind(admissionCutoff, admissionCutoff),
    db.prepare(
      `DELETE FROM idempotent_requests
        WHERE state = 'reserved' AND updated_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM request_payments
             WHERE request_payments.request_id = idempotent_requests.request_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM commercial_admissions
             WHERE commercial_admissions.request_id = idempotent_requests.request_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM waits
             WHERE waits.request_id = idempotent_requests.request_id
          )`,
    ).bind(admissionCutoff),
    db.prepare(
      `UPDATE waits
          SET state = 'ambiguous', terminal_at = ?, updated_at = ?
        WHERE state IN ('event_received', 'delivering')
          AND terminal_at IS NULL AND event_received_at <= ?`,
    ).bind(timestamp, timestamp, stuckCutoff),
    db.prepare(
      `UPDATE waits
          SET callback_url = 'https://purged.invalid/',
              client_reference = NULL,
              event_token_hash = 'purged:' || wait_id,
              event_fingerprint = NULL,
              event_json = NULL,
              event_content_purged_at = ?,
              updated_at = ?
        WHERE state IN ('delivered', 'delivery_failed', 'expired', 'cancelled')
          AND terminal_at IS NOT NULL AND terminal_at <= ?
          AND event_content_purged_at IS NULL
          AND EXISTS (
            SELECT 1 FROM request_payments
             WHERE request_payments.request_id = waits.request_id
               AND (
                 request_payments.state = 'accepted'
                 OR (
                   request_payments.state = 'ambiguous'
                   AND request_payments.ambiguity_honored_at IS NOT NULL
                 )
               )
          )
          AND EXISTS (
            SELECT 1 FROM idempotent_requests
             WHERE idempotent_requests.request_id = waits.request_id
               AND idempotent_requests.state = 'fulfilled'
          )`,
    ).bind(timestamp, timestamp, eventCutoff),
    db.prepare(
      `DELETE FROM waits
        WHERE state IN ('delivered', 'delivery_failed', 'expired', 'cancelled')
          AND terminal_at IS NOT NULL AND terminal_at <= ?`,
    ).bind(metadataCutoff),
    db.prepare(
      `UPDATE idempotent_requests
          SET idempotency_key_hash = 'purged:' || request_id,
              request_fingerprint = 'purged',
              replay_expires_at = NULL,
              replay_purged_at = ?,
              updated_at = ?
        WHERE state = 'fulfilled'
          AND replay_purged_at IS NULL
          AND replay_expires_at IS NOT NULL
          AND replay_expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM waits
             WHERE waits.request_id = idempotent_requests.request_id
               AND waits.state IN ('event_received', 'delivering', 'ambiguous', 'provisioning_failed_paid')
          )`,
    ).bind(timestamp, timestamp, timestamp),
    db.prepare(
      `DELETE FROM request_payments
        WHERE state = 'accepted'
          AND accepted_at IS NOT NULL
          AND accepted_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM waits WHERE waits.request_id = request_payments.request_id
          )`,
    ).bind(paymentCutoff),
    db.prepare(
      `DELETE FROM idempotent_requests
        WHERE replay_purged_at IS NOT NULL
          AND created_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM waits WHERE waits.request_id = idempotent_requests.request_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM request_payments WHERE request_payments.request_id = idempotent_requests.request_id
          )`,
    ).bind(paymentCutoff),
  ]);

  if (results.length !== 12) throw new Error("retention_cleanup_incomplete");
  return {
    expired_waits: changed(results[0]),
    active_capacity_released: changed(results[1]),
    abandoned_admissions_released: changed(results[2]),
    inactive_admissions_deleted: changed(results[3]),
    abandoned_payment_reservations_deleted: changed(results[4]),
    abandoned_request_reservations_deleted: changed(results[5]),
    stuck_events_flagged: changed(results[6]),
    event_content_purged: changed(results[7]),
    wait_metadata_deleted: changed(results[8]),
    replay_metadata_purged: changed(results[9]),
    payment_evidence_deleted: changed(results[10]),
    request_skeletons_deleted: changed(results[11]),
  };
}
