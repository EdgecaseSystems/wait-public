-- Add explicit markers and indexes for deterministic retention cleanup.
-- Payment evidence remains independent from the shorter application windows.

ALTER TABLE idempotent_requests ADD COLUMN replay_purged_at TEXT;
ALTER TABLE waits ADD COLUMN event_content_purged_at TEXT;
ALTER TABLE request_payments ADD COLUMN settlement_authorized_at TEXT;
ALTER TABLE request_payments ADD COLUMN failure_code TEXT;

CREATE INDEX idx_idempotent_requests_replay_cleanup
  ON idempotent_requests(replay_purged_at, replay_expires_at);

CREATE INDEX idx_waits_terminal_cleanup
  ON waits(terminal_at);

CREATE INDEX idx_waits_event_cleanup
  ON waits(event_content_purged_at, terminal_at);

CREATE INDEX idx_request_payments_accepted_cleanup
  ON request_payments(accepted_at)
  WHERE state = 'accepted';
