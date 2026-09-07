export const CAPABILITY_BYTES = 32;
export const CAPABILITY_HEX_LENGTH = CAPABILITY_BYTES * 2;

export type CapabilityPurpose = "event" | "status" | "callback";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateCapability(byteLength = CAPABILITY_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new RangeError("Capability byte length must be an integer between 16 and 128.");
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function deriveCapability(
  secretKey: Uint8Array,
  waitId: string,
  purpose: CapabilityPurpose,
): Promise<string> {
  if (secretKey.byteLength < CAPABILITY_BYTES) {
    throw new RangeError("Capability derivation key must contain at least 32 bytes.");
  }
  if (waitId.length === 0) {
    throw new RangeError("waitId must not be empty.");
  }

  const keyMaterial = new Uint8Array(secretKey);
  const key = await crypto.subtle.importKey(
    "raw",
    keyMaterial.buffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const message = new TextEncoder().encode(`edgecase-wait-capability-v1:${purpose}:${waitId}`);
  const mac = await crypto.subtle.sign("HMAC", key, message);
  return bytesToHex(new Uint8Array(mac));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export async function hashCapability(capability: string): Promise<string> {
  return sha256Hex(`edgecase-wait-capability-v1:${capability}`);
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
