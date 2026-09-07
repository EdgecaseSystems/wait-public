import { describe, expect, it } from "vitest";
import {
  fingerprintCreateWaitRequest,
  hashIdempotencyKey,
  isUuidV4,
  readPaidIdempotencyKey,
} from "../src/idempotency";
import { validateCreateWaitRequest } from "../src/validation";

describe("idempotency identity", () => {
  const key = "bcc3a6aa-d49d-44fc-8d72-0cd92f1fdf35";

  it("A-030 recognizes UUIDv4 keys and rejects other UUID versions/forms", () => {
    expect(isUuidV4(key)).toBe(true);
    expect(isUuidV4("bcc3a6aa-d49d-14fc-8d72-0cd92f1fdf35")).toBe(false);
    expect(isUuidV4("not-a-uuid")).toBe(false);
  });

  it("requires a UUIDv4 on a paid request", () => {
    expect(() => readPaidIdempotencyKey(new Request("https://wait.example/v1/waits"))).toThrowError(/requires an Idempotency-Key/u);
    expect(() => readPaidIdempotencyKey(new Request("https://wait.example/v1/waits", {
      headers: { "Idempotency-Key": "wrong" },
    }))).toThrowError(/UUIDv4/u);
  });

  it("normalizes UUID case and hashes the key before durable lookup", async () => {
    const request = new Request("https://wait.example/v1/waits", {
      headers: { "Idempotency-Key": key.toUpperCase() },
    });
    expect(readPaidIdempotencyKey(request)).toBe(key);
    expect(await hashIdempotencyKey(key)).toBe(await hashIdempotencyKey(key.toUpperCase()));
  });

  it("same canonical logical request produces the same fingerprint", async () => {
    const first = validateCreateWaitRequest({
      callback_url: "https://AGENT.example.com/events",
      timeout_seconds: 3600,
      client_reference: "job-7218",
    });
    const second = validateCreateWaitRequest({
      client_reference: "job-7218",
      timeout_seconds: 3600,
      callback_url: "https://agent.example.com/events",
    });
    expect(await fingerprintCreateWaitRequest(first)).toBe(await fingerprintCreateWaitRequest(second));
  });

  it("A-035/A-036 changed callback or timeout produces a different fingerprint", async () => {
    const base = validateCreateWaitRequest({
      callback_url: "https://agent.example.com/events",
      timeout_seconds: 3600,
    });
    const changedCallback = validateCreateWaitRequest({
      callback_url: "https://other.example.com/events",
      timeout_seconds: 3600,
    });
    const changedTimeout = validateCreateWaitRequest({
      callback_url: "https://agent.example.com/events",
      timeout_seconds: 7200,
    });
    const baseHash = await fingerprintCreateWaitRequest(base);
    expect(await fingerprintCreateWaitRequest(changedCallback)).not.toBe(baseHash);
    expect(await fingerprintCreateWaitRequest(changedTimeout)).not.toBe(baseHash);
  });
});
