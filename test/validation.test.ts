import { describe, expect, it } from "vitest";
import { ClientInputError } from "../src/errors";
import {
  MAX_EVENT_BODY_BYTES,
  parseEventJson,
  validateCallbackUrl,
  validateCreateWaitRequest,
} from "../src/validation";

describe("create-wait validation", () => {
  it("A-001 accepts and normalizes a valid request", () => {
    expect(validateCreateWaitRequest({
      callback_url: "https://Agent.Example.com/events",
      timeout_seconds: 3600,
      client_reference: "job-7218",
    })).toEqual({
      callback_url: "https://agent.example.com/events",
      timeout_seconds: 3600,
      client_reference: "job-7218",
    });
  });

  it("A-002 rejects a missing callback URL", () => {
    expect(() => validateCreateWaitRequest({ timeout_seconds: 3600 })).toThrowError(ClientInputError);
  });

  it.each([
    "http://agent.example.com/events",
    "https://user:secret@agent.example.com/events",
    "https://127.0.0.1/events",
    "https://[::1]/events",
    "https://localhost/events",
    "https://worker/events",
    "https://*.example.com/events",
    "https://bad_name.example.com/events",
    "https://-bad.example.com/events",
    ...["localhost", "local", "internal", "lan", "home", "invalid", "test"].map((suffix) => `https://agent.${suffix}/events`),
    "https://agent.example.com:8443/events",
    "https://agent.example.com/events#fragment",
  ])("A-003 through A-007 reject unsafe callback target %s", (url) => {
    expect(() => validateCallbackUrl(url)).toThrowError(ClientInputError);
  });

  it("rejects timeout below the 60-second minimum", () => {
    expect(() => validateCreateWaitRequest({
      callback_url: "https://agent.example.com/events",
      timeout_seconds: 59,
    })).toThrowError(/timeout_seconds/u);
  });

  it("rejects timeout above 24 hours", () => {
    expect(() => validateCreateWaitRequest({
      callback_url: "https://agent.example.com/events",
      timeout_seconds: 86401,
    })).toThrowError(/timeout_seconds/u);
  });

  it("A-010 rejects unknown request fields", () => {
    const sensitiveFieldName = "event-or-status-capability-must-not-echo";
    let caught: unknown;
    try {
      validateCreateWaitRequest({
        callback_url: "https://agent.example.com/events",
        timeout_seconds: 3600,
        [sensitiveFieldName]: "secret",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "unknown_request_field", message: "Request contains an unsupported field." });
    expect((caught as Error).message).not.toContain(sensitiveFieldName);
  });
});

describe("bounded event JSON", () => {
  it("accepts application/*+json event bodies", async () => {
    const request = new Request("https://wait.example/e/test", {
      method: "POST",
      headers: { "content-type": "application/problem+json" },
      body: JSON.stringify({ status: "complete" }),
    });
    await expect(parseEventJson(request)).resolves.toEqual({ status: "complete" });
  });

  it("A-011 rejects an event body over 65,536 bytes", async () => {
    const request = new Request("https://wait.example/e/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("x".repeat(MAX_EVENT_BODY_BYTES)),
    });
    await expect(parseEventJson(request)).rejects.toMatchObject({ code: "request_too_large", status: 413 });
  });

  it("A-012 rejects malformed JSON", async () => {
    const request = new Request("https://wait.example/e/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    await expect(parseEventJson(request)).rejects.toMatchObject({ code: "invalid_json_body" });
  });

  it("A-013 rejects unsupported content types", async () => {
    const request = new Request("https://wait.example/e/test", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    await expect(parseEventJson(request)).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
  });

  it("rejects compressed request bodies in the MVP", async () => {
    const request = new Request("https://wait.example/e/test", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: "{}",
    });
    await expect(parseEventJson(request)).rejects.toMatchObject({ code: "unsupported_media_type", status: 415 });
  });
});
