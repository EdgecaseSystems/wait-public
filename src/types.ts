export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface CreateWaitRequest {
  callback_url: string;
  timeout_seconds: number;
  client_reference?: string;
}

export interface CreateWaitResponse {
  wait_id: string;
  status: "waiting";
  event_url: string;
  status_url: string;
  callback_token: string;
  client_reference: string | null;
  created_at: string;
  expires_at: string;
}

export type WaitState =
  | "provisioning"
  | "waiting"
  | "event_received"
  | "delivering"
  | "delivered"
  | "delivery_failed"
  | "expired"
  | "cancelled"
  | "provisioning_failed_paid"
  | "ambiguous";

export type PublicWaitStatus =
  | "waiting"
  | "event_received"
  | "delivering"
  | "delivered"
  | "delivery_failed"
  | "expired"
  | "cancelled"
  | "service_attention_required";

export type IdempotentRequestState =
  | "reserved"
  | "settling"
  | "ambiguous"
  | "payment_accepted"
  | "provisioning"
  | "provisioning_failed_paid"
  | "fulfilled";

export type PaymentState = "reserved" | "settling" | "accepted" | "rejected" | "ambiguous";

export interface WaitStatusResponse {
  wait_id: string;
  status: PublicWaitStatus;
  client_reference: string | null;
  created_at: string;
  expires_at: string;
  event_received_at?: string | null;
  callback_delivered_at?: string | null;
  callback_attempts?: number;
  event?: JsonValue | null;
}

export interface ErrorResponse {
  error: string;
  code?: string;
  message?: string;
  retryable?: boolean;
  retry_after_seconds?: number;
}
