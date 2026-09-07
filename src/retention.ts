export const EVENT_RECOVERY_RETENTION_MS = 72 * 60 * 60 * 1000;
export const ACCEPTED_EVENT_SAFETY_CEILING_MS = 7 * 24 * 60 * 60 * 1000;
export const WAIT_METADATA_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const CUSTOM_LOG_RETENTION_DAYS = 7;
export const PAYMENT_EVIDENCE_RETENTION_YEARS = 7;
export const CAPABILITY_KEY_RETIREMENT_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const WORKFLOW_INSTANCE_RETENTION = "1 day" as const;

export function retentionDeadline(now: Date, retentionMs: number): string {
  if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new RangeError("retentionMs must be positive.");
  return new Date(now.getTime() + retentionMs).toISOString();
}
