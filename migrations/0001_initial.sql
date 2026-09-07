-- Edgecase Wait initial schema.
--
-- DESIGN STATUS: reviewed migration candidate only. Do not apply remotely until
-- the explicit predeployment D1 gate. Local development may apply this migration.
--
-- Bearer capabilities are not stored in plaintext. Event, status, and callback
-- credentials are derived from a versioned runtime secret plus wait_id. D1 stores
-- only lookup hashes for event/status credentials and the derivation-key version.
--
-- A wait does not own a long-lived Workflow while idle. D1 is the durable wait
-- ledger. When the first event is accepted, D1 deterministically records the
-- intended callback-delivery Workflow ID (`delivery-` || wait_id). The Worker then
-- uses Cloudflare Workflows createBatch with that stable ID, which is idempotent
-- when an instance with the same ID already exists within retention.

PRAGMA foreign_keys = ON;

CREATE TABLE idempotent_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  idempotency_key_hash TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'reserved',
      'settling',
      'ambiguous',
      'payment_accepted',
      'provisioning',
      'provisioning_failed_paid',
      'fulfilled'
    )
  ),
  replay_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_idempotent_requests_state
  ON idempotent_requests(state);

CREATE INDEX idx_idempotent_requests_replay_expiry
  ON idempotent_requests(replay_expires_at);

CREATE TABLE request_payments (
  request_id TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'reserved',
      'settling',
      'accepted',
      'rejected',
      'ambiguous'
    )
  ),
  network TEXT,
  asset TEXT,
  amount TEXT,
  pay_to TEXT,
  payment_proof_fingerprint TEXT,
  payer_identity TEXT,
  transaction_id TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id)
    REFERENCES idempotent_requests(request_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX idx_request_payments_proof_fingerprint
  ON request_payments(payment_proof_fingerprint)
  WHERE payment_proof_fingerprint IS NOT NULL;

CREATE INDEX idx_request_payments_state
  ON request_payments(state);

CREATE TABLE waits (
  wait_id TEXT PRIMARY KEY NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  delivery_workflow_instance_id TEXT UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN (
      'provisioning',
      'waiting',
      'event_received',
      'delivering',
      'delivered',
      'delivery_failed',
      'expired',
      'cancelled',
      'provisioning_failed_paid',
      'ambiguous'
    )
  ),
  public_origin TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  client_reference TEXT,
  capability_key_version INTEGER NOT NULL DEFAULT 1 CHECK (capability_key_version >= 1),
  event_token_hash TEXT NOT NULL UNIQUE,
  status_token_hash TEXT NOT NULL UNIQUE,
  event_fingerprint TEXT,
  event_json TEXT,
  event_received_at TEXT,
  callback_attempts INTEGER NOT NULL DEFAULT 0 CHECK (callback_attempts >= 0),
  callback_last_status INTEGER,
  callback_last_error_code TEXT,
  callback_delivered_at TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  terminal_at TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (request_id)
    REFERENCES idempotent_requests(request_id)
    ON DELETE RESTRICT
);

CREATE INDEX idx_waits_state
  ON waits(state);

CREATE INDEX idx_waits_expires_at
  ON waits(expires_at);

CREATE INDEX idx_waits_active_expiry
  ON waits(state, expires_at);

CREATE INDEX idx_waits_delivery_recovery
  ON waits(state, delivery_workflow_instance_id)
  WHERE state IN ('event_received', 'delivering');

CREATE TABLE service_controls (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  new_sales_enabled INTEGER NOT NULL DEFAULT 0 CHECK (new_sales_enabled IN (0, 1)),
  callback_delivery_enabled INTEGER NOT NULL DEFAULT 1 CHECK (callback_delivery_enabled IN (0, 1)),
  max_active_waits INTEGER NOT NULL DEFAULT 100 CHECK (max_active_waits >= 0),
  max_paid_waits_per_day INTEGER NOT NULL DEFAULT 100 CHECK (max_paid_waits_per_day >= 0),
  updated_at TEXT NOT NULL
);

INSERT INTO service_controls (
  id,
  new_sales_enabled,
  callback_delivery_enabled,
  max_active_waits,
  max_paid_waits_per_day,
  updated_at
) VALUES (
  1,
  0,
  1,
  100,
  100,
  CURRENT_TIMESTAMP
);
