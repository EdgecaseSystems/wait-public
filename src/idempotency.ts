import { sha256Hex } from "./capabilities";
import { fingerprint } from "./canonical";
import { ClientInputError } from "./errors";
import type { CreateWaitRequest } from "./types";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidV4(value: string): boolean {
  return UUID_V4_PATTERN.test(value);
}

export function readPaidIdempotencyKey(request: Request): string {
  const value = request.headers.get(IDEMPOTENCY_KEY_HEADER);
  if (value === null) {
    throw new ClientInputError("missing_idempotency_key", "Paid wait creation requires an Idempotency-Key UUIDv4.");
  }
  if (!isUuidV4(value)) {
    throw new ClientInputError("invalid_idempotency_key", "Idempotency-Key must be a UUIDv4.");
  }
  return value.toLowerCase();
}

export async function hashIdempotencyKey(value: string): Promise<string> {
  if (!isUuidV4(value)) {
    throw new ClientInputError("invalid_idempotency_key", "Idempotency-Key must be a UUIDv4.");
  }
  return sha256Hex(`edgecase-wait-idempotency-v1:${value.toLowerCase()}`);
}

export async function fingerprintCreateWaitRequest(input: CreateWaitRequest): Promise<string> {
  return fingerprint(input, "edgecase-wait-create-v1");
}
