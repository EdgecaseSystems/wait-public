export type ClientErrorCode =
  | "invalid_json_body"
  | "unsupported_media_type"
  | "request_too_large"
  | "invalid_create_wait_request"
  | "invalid_callback_url"
  | "invalid_timeout"
  | "invalid_client_reference"
  | "unknown_request_field"
  | "missing_idempotency_key"
  | "invalid_idempotency_key"
  | "malformed_payment_proof"
  | "invalid_payment_proof"
  | "payment_binding_mismatch";

export class ClientInputError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
    readonly status: 400 | 413 | 415 = 400,
    readonly errorName = "invalid_request",
  ) {
    super(message);
    this.name = "ClientInputError";
  }
}

export type LifecycleErrorCode =
  | "illegal_wait_transition"
  | "illegal_payment_transition"
  | "illegal_request_transition"
  | "idempotency_key_conflict"
  | "idempotency_in_progress"
  | "commercial_capacity_reached"
  | "payment_proof_conflict"
  | "payment_ambiguous"
  | "idempotency_state_ambiguous";

export class LifecycleError extends Error {
  constructor(
    readonly code: LifecycleErrorCode,
    message: string,
    readonly retryable = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "LifecycleError";
  }
}
