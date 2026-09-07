import { describe, expect, it } from "vitest";
import {
  ACCEPTED_EVENT_SAFETY_CEILING_MS,
  CAPABILITY_KEY_RETIREMENT_GRACE_MS,
  CUSTOM_LOG_RETENTION_DAYS,
  EVENT_RECOVERY_RETENTION_MS,
  IDEMPOTENCY_REPLAY_RETENTION_MS,
  PAYMENT_EVIDENCE_RETENTION_YEARS,
  WAIT_METADATA_RETENTION_MS,
  WORKFLOW_INSTANCE_RETENTION,
  retentionDeadline,
} from "../src/retention";

describe("frozen retention policy", () => {
  it("keeps content short-lived and metadata windows explicit", () => {
    expect(EVENT_RECOVERY_RETENTION_MS).toBe(72 * 60 * 60 * 1000);
    expect(ACCEPTED_EVENT_SAFETY_CEILING_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(WAIT_METADATA_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(IDEMPOTENCY_REPLAY_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(CAPABILITY_KEY_RETIREMENT_GRACE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("keeps Workflow/log state short and payment evidence separately bounded", () => {
    expect(WORKFLOW_INSTANCE_RETENTION).toBe("1 day");
    expect(CUSTOM_LOG_RETENTION_DAYS).toBe(7);
    expect(PAYMENT_EVIDENCE_RETENTION_YEARS).toBe(7);
  });

  it("computes UTC cleanup deadlines deterministically", () => {
    expect(retentionDeadline(new Date("2026-09-01T00:00:00.000Z"), EVENT_RECOVERY_RETENTION_MS))
      .toBe("2026-09-04T00:00:00.000Z");
  });
});
