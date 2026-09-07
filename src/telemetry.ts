export type TelemetryOperation =
  | "create_wait"
  | "receive_event"
  | "get_status"
  | "cancel_wait"
  | "deliver_callback"
  | "workflow";

export interface SafeTelemetryEvent {
  operation: TelemetryOperation;
  outcome: string;
  opaque_id?: string;
  state?: string;
  latency_ms?: number;
  retry_count?: number;
  http_status?: number;
  error_code?: string;
}

const MAX_TEXT_FIELD_LENGTH = 80;

function boundedText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.slice(0, MAX_TEXT_FIELD_LENGTH);
}

export function makeSafeTelemetryEvent(input: SafeTelemetryEvent): SafeTelemetryEvent {
  return {
    operation: input.operation,
    outcome: boundedText(input.outcome) ?? "unknown",
    ...(input.opaque_id === undefined ? {} : { opaque_id: boundedText(input.opaque_id) }),
    ...(input.state === undefined ? {} : { state: boundedText(input.state) }),
    ...(input.latency_ms === undefined ? {} : { latency_ms: Math.max(0, Math.floor(input.latency_ms)) }),
    ...(input.retry_count === undefined ? {} : { retry_count: Math.max(0, Math.floor(input.retry_count)) }),
    ...(input.http_status === undefined ? {} : { http_status: Math.floor(input.http_status) }),
    ...(input.error_code === undefined ? {} : { error_code: boundedText(input.error_code) }),
  };
}

/**
 * Deliberately accepts only the safe telemetry shape. Raw URLs, request headers,
 * event bodies, payment signatures, and bearer capabilities have no place in
 * this interface and should never be added merely for debugging convenience.
 */
export function logSafeTelemetry(event: SafeTelemetryEvent, write: (value: SafeTelemetryEvent) => void = console.log): void {
  write(makeSafeTelemetryEvent(event));
}
