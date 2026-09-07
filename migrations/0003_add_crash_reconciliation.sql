-- Durable crash-reconciliation and commercial-admission boundaries.
-- This migration is local-only until an explicit remote setup gate.

ALTER TABLE request_payments ADD COLUMN external_operation_id TEXT;
ALTER TABLE request_payments ADD COLUMN external_call_started_at TEXT;
ALTER TABLE request_payments ADD COLUMN reconciliation_checked_at TEXT;
ALTER TABLE request_payments ADD COLUMN reconciliation_status TEXT;

CREATE UNIQUE INDEX idx_request_payments_external_operation
  ON request_payments(external_operation_id)
  WHERE external_operation_id IS NOT NULL;

ALTER TABLE waits ADD COLUMN callback_success_observed_at TEXT;

CREATE TABLE commercial_admissions (
  request_id TEXT PRIMARY KEY NOT NULL,
  capacity_day TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'accepted', 'released', 'ambiguous')),
  counts_daily INTEGER NOT NULL CHECK (counts_daily IN (0, 1)),
  active_held INTEGER NOT NULL CHECK (active_held IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id)
    REFERENCES idempotent_requests(request_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_commercial_admissions_daily
  ON commercial_admissions(capacity_day, counts_daily);

CREATE INDEX idx_commercial_admissions_active
  ON commercial_admissions(active_held);
