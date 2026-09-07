import { describe, expect, it } from "vitest";
import {
  CALLBACK_ATTEMPT_TIMEOUT_MS,
  CALLBACK_MAX_ATTEMPTS,
  CALLBACK_MAX_RETRY_DELAY_MS,
  CALLBACK_RETRY_DELAYS_MS,
  callbackRetryDelayMs,
  classifyCallbackHttpStatus,
} from "../src/callback-policy";

describe("callback delivery policy", () => {
  it("freezes a short per-attempt timeout and five-attempt maximum", () => {
    expect(CALLBACK_ATTEMPT_TIMEOUT_MS).toBe(10_000);
    expect(CALLBACK_MAX_ATTEMPTS).toBe(5);
    expect(CALLBACK_RETRY_DELAYS_MS).toEqual([10_000, 30_000, 120_000, 600_000]);
  });

  it("treats only observed 2xx responses as successful", () => {
    expect(classifyCallbackHttpStatus(200)).toBe("success");
    expect(classifyCallbackHttpStatus(204)).toBe("success");
    expect(classifyCallbackHttpStatus(299)).toBe("success");
    expect(classifyCallbackHttpStatus(302)).toBe("terminal");
  });

  it("retries bounded transient HTTP classes and terminates ordinary client errors", () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(classifyCallbackHttpStatus(status)).toBe("retry");
    }
    for (const status of [400, 401, 403, 404, 409, 410, 422]) {
      expect(classifyCallbackHttpStatus(status)).toBe("terminal");
    }
  });

  it("uses the fixed retry schedule for network failures and retryable responses", () => {
    expect(callbackRetryDelayMs(1, null)).toBe(10_000);
    expect(callbackRetryDelayMs(2, 503)).toBe(30_000);
    expect(callbackRetryDelayMs(3, 504)).toBe(120_000);
    expect(callbackRetryDelayMs(4, 408)).toBe(600_000);
    expect(callbackRetryDelayMs(5, 503)).toBeNull();
    expect(callbackRetryDelayMs(1, 404)).toBeNull();
  });

  it("honors Retry-After for 429 without allowing unbounded delay", () => {
    const now = Date.parse("2026-09-01T18:00:00Z");
    expect(callbackRetryDelayMs(1, 429, "45", now)).toBe(45_000);
    expect(callbackRetryDelayMs(1, 429, "3600", now)).toBe(CALLBACK_MAX_RETRY_DELAY_MS);
    expect(callbackRetryDelayMs(1, 429, "Tue, 01 Sep 2026 18:02:00 GMT", now)).toBe(120_000);
    expect(callbackRetryDelayMs(1, 429, "nonsense", now)).toBe(10_000);
  });
});
