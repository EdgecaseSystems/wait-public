import { deriveCapability } from "./capabilities";
import type { CreateWaitResponse } from "./types";

export interface ReplayableWaitRecord {
  wait_id: string;
  public_origin: string;
  client_reference: string | null;
  capability_key_version: number;
  created_at: string;
  expires_at: string;
}

export type CapabilityKeyResolver = (version: number) => Uint8Array | Promise<Uint8Array>;

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Stored public origin is invalid.");
  }
  return url.origin;
}

export async function reconstructCreateWaitResponse(
  row: ReplayableWaitRecord,
  resolveKey: CapabilityKeyResolver,
): Promise<CreateWaitResponse> {
  if (!Number.isInteger(row.capability_key_version) || row.capability_key_version < 1) {
    throw new Error("Stored capability key version is invalid.");
  }
  const key = await resolveKey(row.capability_key_version);
  const [eventToken, statusToken, callbackToken] = await Promise.all([
    deriveCapability(key, row.wait_id, "event"),
    deriveCapability(key, row.wait_id, "status"),
    deriveCapability(key, row.wait_id, "callback"),
  ]);
  const origin = normalizeOrigin(row.public_origin);
  return {
    wait_id: row.wait_id,
    status: "waiting",
    event_url: `${origin}/e/${eventToken}`,
    status_url: `${origin}/s/${statusToken}`,
    callback_token: callbackToken,
    client_reference: row.client_reference,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}
