import { describe, expect, it, vi } from "vitest";
import { reconstructCreateWaitResponse } from "../src/wait-response";

describe("creation response reconstruction", () => {
  const row = {
    wait_id: "wait-123",
    public_origin: "https://wait.example.com",
    client_reference: "job-7218",
    capability_key_version: 3,
    created_at: "2026-09-01T18:00:00.000Z",
    expires_at: "2026-09-01T19:00:00.000Z",
  };

  it("reconstructs exactly the same bearer response from non-secret D1 metadata plus the versioned runtime key", async () => {
    const resolve = vi.fn(async (version: number) => {
      expect(version).toBe(3);
      return new Uint8Array(32).fill(17);
    });
    const first = await reconstructCreateWaitResponse(row, resolve);
    const second = await reconstructCreateWaitResponse(row, resolve);
    expect(second).toEqual(first);
    expect(first.wait_id).toBe("wait-123");
    expect(first.event_url).toMatch(/^https:\/\/wait\.example\.com\/e\/[0-9a-f]{64}$/u);
    expect(first.status_url).toMatch(/^https:\/\/wait\.example\.com\/s\/[0-9a-f]{64}$/u);
    expect(first.callback_token).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set([
      first.event_url.split("/").at(-1),
      first.status_url.split("/").at(-1),
      first.callback_token,
    ]).size).toBe(3);
  });

  it("rejects an invalid stored public origin rather than creating a malformed replay", async () => {
    await expect(reconstructCreateWaitResponse({ ...row, public_origin: "http://wait.example" }, async () => new Uint8Array(32).fill(1)))
      .rejects.toThrow(/Stored public origin is invalid/u);
  });
});
