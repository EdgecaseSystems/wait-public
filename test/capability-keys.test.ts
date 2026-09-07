import { describe, expect, it } from "vitest";
import { deriveCapability } from "../src/capabilities";
import { resolveCapabilityKey, selectCapabilityKey } from "../src/capability-keys";
import { reconstructCreateWaitResponse } from "../src/wait-response";

const v1 = { CAPABILITY_KEY_V1: "11".repeat(32) };
const both = { ...v1, CAPABILITY_KEY_V2: "22".repeat(32) };
const row = {
  wait_id: "wait-rotation", public_origin: "https://wait.example", client_reference: null,
  capability_key_version: 1, created_at: "2026-09-01T18:00:00.000Z", expires_at: "2026-09-01T19:00:00.000Z",
};

describe("capability key rotation", () => {
  it("preserves V1-only selection and identical V1 reconstruction after adding V2", async () => {
    expect(selectCapabilityKey(v1)).toEqual({ version: 1, key: new Uint8Array(32).fill(17) });
    const original = await reconstructCreateWaitResponse(row, () => new Uint8Array(32).fill(17));
    for (const config of [v1, both]) {
      expect(await reconstructCreateWaitResponse(row, (version) => resolveCapabilityKey(config, version))).toEqual(original);
    }
  });

  it("selects and reconstructs V2 using its own key", async () => {
    expect(selectCapabilityKey(both)).toEqual({ version: 2, key: new Uint8Array(32).fill(34) });
    const version2 = { ...row, capability_key_version: 2 };
    expect(await reconstructCreateWaitResponse(version2, (version) => resolveCapabilityKey(both, version)))
      .toEqual(await reconstructCreateWaitResponse(version2, () => new Uint8Array(32).fill(34)));
  });

  it.each([1, 2])("fails safely when stored version %i is missing, even with the other key present", async (version) => {
    const config = version === 1 ? { ...both, CAPABILITY_KEY_V1: "" } : v1;
    await expect(reconstructCreateWaitResponse({ ...row, capability_key_version: version }, (stored) => resolveCapabilityKey(config, stored)))
      .rejects.toThrow("capability_key_unavailable");
  });

  it.each(["", "invalid", "AA".repeat(32), "22".repeat(31)])("rejects malformed V2 without falling back to V1 (%s)", (value) => {
    expect(() => selectCapabilityKey({ ...v1, CAPABILITY_KEY_V2: value })).toThrow("capability_key_unavailable");
    expect(() => resolveCapabilityKey({ ...v1, CAPABILITY_KEY_V2: value }, 2)).toThrow("capability_key_unavailable");
  });

  it("rejects unsupported versions", () => {
    expect(() => resolveCapabilityKey(both, 3)).toThrow("capability_key_version_unavailable");
  });

  it.each(["event", "status", "callback"] as const)("separates %s outputs across different keys for the same wait", async (purpose) => {
    expect(await deriveCapability(resolveCapabilityKey(both, 1), row.wait_id, purpose))
      .not.toBe(await deriveCapability(resolveCapabilityKey(both, 2), row.wait_id, purpose));
  });
});
