import { describe, expect, it, vi } from "vitest";
import { logSafeTelemetry, makeSafeTelemetryEvent } from "../src/telemetry";

describe("safe telemetry", () => {
  it("A/B-124 retains only bounded operational metadata", () => {
    expect(makeSafeTelemetryEvent({
      operation: "deliver_callback",
      outcome: "retryable_failure",
      opaque_id: "wait_opaque_123",
      state: "delivering",
      latency_ms: 123.9,
      retry_count: 2,
      http_status: 503,
      error_code: "callback_unavailable",
    })).toEqual({
      operation: "deliver_callback",
      outcome: "retryable_failure",
      opaque_id: "wait_opaque_123",
      state: "delivering",
      latency_ms: 123,
      retry_count: 2,
      http_status: 503,
      error_code: "callback_unavailable",
    });
  });

  it("does not expose a generic bag for raw URLs, event bodies, headers, or capability tokens", () => {
    const event = makeSafeTelemetryEvent({ operation: "receive_event", outcome: "accepted" });
    expect(Object.keys(event).sort()).toEqual(["operation", "outcome"]);
    expect(event).not.toHaveProperty("url");
    expect(event).not.toHaveProperty("body");
    expect(event).not.toHaveProperty("headers");
    expect(event).not.toHaveProperty("capability");
  });

  it("can be routed to a controlled writer without logging content", () => {
    const write = vi.fn();
    logSafeTelemetry({ operation: "create_wait", outcome: "rejected", error_code: "invalid_request" }, write);
    expect(write).toHaveBeenCalledWith({ operation: "create_wait", outcome: "rejected", error_code: "invalid_request" });
  });
});
