-- Bound the v0.1 policy that honors an irrecoverably ambiguous one-cent
-- payment without recording it as accepted. This migration remains local-only
-- until the explicit remote D1 gate.

ALTER TABLE request_payments ADD COLUMN ambiguity_honored_at TEXT;

ALTER TABLE service_controls ADD COLUMN max_ambiguous_payment_honors INTEGER NOT NULL DEFAULT 3
  CHECK (max_ambiguous_payment_honors >= 1);

CREATE INDEX idx_request_payments_ambiguity_honored
  ON request_payments(ambiguity_honored_at)
  WHERE state = 'ambiguous' AND ambiguity_honored_at IS NOT NULL;
