import { describe, expect, it } from "vitest";
import {
  CAPABILITY_HEX_LENGTH,
  constantTimeEqual,
  deriveCapability,
  generateCapability,
  hashCapability,
} from "../src/capabilities";

describe("bearer capabilities", () => {
  it("A-050 through A-053 can generate independent 256-bit URL-safe capabilities", () => {
    const eventCapability = generateCapability();
    const statusCapability = generateCapability();
    const callbackToken = generateCapability();

    for (const value of [eventCapability, statusCapability, callbackToken]) {
      expect(value).toHaveLength(CAPABILITY_HEX_LENGTH);
      expect(value).toMatch(/^[0-9a-f]+$/u);
    }
    expect(new Set([eventCapability, statusCapability, callbackToken]).size).toBe(3);
  });

  it("derives replayable capabilities deterministically from a versioned server secret", async () => {
    const key = new Uint8Array(32).fill(7);
    const first = await deriveCapability(key, "wait-123", "event");
    const second = await deriveCapability(key, "wait-123", "event");
    expect(first).toBe(second);
    expect(first).toHaveLength(CAPABILITY_HEX_LENGTH);
  });

  it("cryptographically separates event, status and callback capability purposes", async () => {
    const key = new Uint8Array(32).fill(9);
    const capabilities = await Promise.all([
      deriveCapability(key, "wait-123", "event"),
      deriveCapability(key, "wait-123", "status"),
      deriveCapability(key, "wait-123", "callback"),
      deriveCapability(key, "wait-456", "event"),
    ]);
    expect(new Set(capabilities).size).toBe(capabilities.length);
  });

  it("rejects undersized derivation keys", async () => {
    await expect(deriveCapability(new Uint8Array(16), "wait-123", "event")).rejects.toThrow(/at least 32 bytes/u);
  });

  it("A-054 hashes capability lookup material without preserving plaintext", async () => {
    const capability = generateCapability();
    const hash = await hashCapability(capability);
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(capability);
    expect(await hashCapability(capability)).toBe(hash);
  });

  it("provides equality checking for same-length secret-derived values", () => {
    expect(constantTimeEqual("abc123", "abc123")).toBe(true);
    expect(constantTimeEqual("abc123", "abc124")).toBe(false);
    expect(constantTimeEqual("abc123", "short")).toBe(false);
  });
});
