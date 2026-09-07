export const CALLBACK_MAX_ATTEMPTS = 5;
export const CALLBACK_ATTEMPT_TIMEOUT_MS = 10_000;
export const CALLBACK_MAX_RETRY_DELAY_MS = 10 * 60 * 1000;

// Delays after failed attempts 1 through 4. Attempt 5 is terminal.
export const CALLBACK_RETRY_DELAYS_MS = Object.freeze([
  10_000,
  30_000,
  2 * 60 * 1000,
  10 * 60 * 1000,
] as const);

export type CallbackHttpDisposition = "success" | "retry" | "terminal";

const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export function classifyCallbackHttpStatus(status: number): CallbackHttpDisposition {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new RangeError("HTTP status must be an integer from 100 through 599.");
  }
  if (status >= 200 && status <= 299) return "success";
  if (RETRYABLE_HTTP_STATUSES.has(status)) return "retry";
  // Redirects are intentionally terminal because callback fetch uses redirect: manual.
  // Most other 4xx responses represent a bad/unauthorized callback contract and should
  // not consume repeated attempts.
  return "terminal";
}

function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/u.test(trimmed)) {
    return Math.max(0, Number(trimmed) * 1000);
  }
  const parsedDate = Date.parse(trimmed);
  if (!Number.isFinite(parsedDate)) return null;
  return Math.max(0, parsedDate - nowMs);
}

/**
 * Returns the delay before the next callback attempt, or null when no retry is
 * permitted. failedAttempt is 1-indexed and refers to the attempt that just failed.
 */
export function callbackRetryDelayMs(
  failedAttempt: number,
  status: number | null,
  retryAfterHeader: string | null = null,
  nowMs = Date.now(),
): number | null {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1 || failedAttempt > CALLBACK_MAX_ATTEMPTS) {
    throw new RangeError(`failedAttempt must be an integer from 1 through ${CALLBACK_MAX_ATTEMPTS}.`);
  }
  if (failedAttempt >= CALLBACK_MAX_ATTEMPTS) return null;
  if (status !== null && classifyCallbackHttpStatus(status) !== "retry") return null;

  const baseDelay = CALLBACK_RETRY_DELAYS_MS[failedAttempt - 1];
  if (baseDelay === undefined) return null;

  // Network errors and timeouts do not have an HTTP status and use the normal schedule.
  if (status !== 429) return baseDelay;

  const requestedDelay = parseRetryAfterMs(retryAfterHeader, nowMs);
  if (requestedDelay === null) return baseDelay;
  return Math.min(Math.max(baseDelay, requestedDelay), CALLBACK_MAX_RETRY_DELAY_MS);
}
