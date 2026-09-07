import { ClientInputError, LifecycleError } from "./errors";
import type { ErrorResponse } from "./types";

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ClientInputError) {
    const body: ErrorResponse = {
      error: error.errorName,
      code: error.code,
      message: error.message,
      retryable: false,
    };
    return jsonResponse(body, error.status);
  }

  if (error instanceof LifecycleError) {
    const body: ErrorResponse = {
      error: "lifecycle_conflict",
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.retryAfterSeconds === undefined ? {} : { retry_after_seconds: error.retryAfterSeconds }),
    };
    const headers = error.retryAfterSeconds === undefined ? undefined : { "retry-after": String(error.retryAfterSeconds) };
    return jsonResponse(body, error.code === "commercial_capacity_reached" ? 429 : 409, headers);
  }

  return jsonResponse(
    {
      error: "internal_error",
      message: "The service could not safely complete the request.",
      retryable: false,
    },
    500,
  );
}
