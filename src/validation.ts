import { ClientInputError } from "./errors";
import type { CreateWaitRequest } from "./types";

export const MIN_WAIT_SECONDS = 60;
export const MAX_WAIT_SECONDS = 24 * 60 * 60;
export const MAX_CREATE_BODY_BYTES = 8 * 1024;
export const MAX_EVENT_BODY_BYTES = 65_536;
export const MAX_CALLBACK_URL_LENGTH = 2_048;
export const MAX_CLIENT_REFERENCE_LENGTH = 200;

const CREATE_WAIT_FIELDS = new Set(["callback_url", "timeout_seconds", "client_reference"]);
const NON_PUBLIC_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".invalid", ".test"];
// Preserve the DNS syntax gate formerly enforced by operator host configuration.
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" || (mediaType.startsWith("application/") && mediaType.endsWith("+json"));
}

function looksLikeIpLiteral(hostname: string): boolean {
  if (hostname.includes(":")) return true;
  return /^[0-9.]+$/.test(hostname);
}

export function validateCallbackUrl(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CALLBACK_URL_LENGTH) {
    throw new ClientInputError("invalid_callback_url", "callback_url must be a nonempty HTTPS URL within the supported length limit.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ClientInputError("invalid_callback_url", "callback_url must be a valid absolute HTTPS URL.");
  }

  if (url.protocol !== "https:") {
    throw new ClientInputError("invalid_callback_url", "callback_url must use HTTPS.");
  }
  if (url.username || url.password) {
    throw new ClientInputError("invalid_callback_url", "callback_url must not contain username or password information.");
  }
  if (url.hash) {
    throw new ClientInputError("invalid_callback_url", "callback_url must not contain a URL fragment.");
  }
  if (url.port && url.port !== "443") {
    throw new ClientInputError("invalid_callback_url", "callback_url must use the default HTTPS port.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/u, "");
  if (!hostname || hostname === "localhost" || !hostname.includes(".")) {
    throw new ClientInputError("invalid_callback_url", "callback_url must use a public-style DNS hostname.");
  }
  if (looksLikeIpLiteral(hostname)) {
    throw new ClientInputError("invalid_callback_url", "IP-literal callback hosts are not supported.");
  }
  if (NON_PUBLIC_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new ClientInputError("invalid_callback_url", "Local or reserved callback hostnames are not supported.");
  }
  if (!HOSTNAME.test(hostname)) {
    throw new ClientInputError("invalid_callback_url", "callback_url must use a valid DNS hostname.");
  }

  // This is intentionally only the deterministic URL-layer gate. It is not claimed
  // to solve DNS rebinding/private-address SSRF by itself. Global fetch with
  // global_fetch_strictly_public supplies the network boundary; no local DNS pinning.
  url.hostname = hostname;
  return url.toString();
}

export function validateCreateWaitRequest(value: unknown): CreateWaitRequest {
  if (!isRecord(value)) {
    throw new ClientInputError("invalid_create_wait_request", "Request body must be a JSON object.");
  }

  for (const key of Object.keys(value)) {
    if (!CREATE_WAIT_FIELDS.has(key)) {
      throw new ClientInputError("unknown_request_field", "Request contains an unsupported field.");
    }
  }

  const callback_url = validateCallbackUrl(value.callback_url);
  const timeout = value.timeout_seconds;
  if (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout < MIN_WAIT_SECONDS || timeout > MAX_WAIT_SECONDS) {
    throw new ClientInputError(
      "invalid_timeout",
      `timeout_seconds must be an integer from ${MIN_WAIT_SECONDS} through ${MAX_WAIT_SECONDS}.`,
    );
  }

  let client_reference: string | undefined;
  if (value.client_reference !== undefined) {
    if (
      typeof value.client_reference !== "string" ||
      value.client_reference.length < 1 ||
      value.client_reference.length > MAX_CLIENT_REFERENCE_LENGTH ||
      /[\u0000-\u001f\u007f]/u.test(value.client_reference)
    ) {
      throw new ClientInputError(
        "invalid_client_reference",
        `client_reference must be 1-${MAX_CLIENT_REFERENCE_LENGTH} characters and contain no control characters.`,
      );
    }
    client_reference = value.client_reference;
  }

  return {
    callback_url,
    timeout_seconds: timeout,
    ...(client_reference === undefined ? {} : { client_reference }),
  };
}

async function readBoundedUtf8(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ClientInputError("request_too_large", `Request body exceeds ${maxBytes} bytes.`, 413);
    }
  }

  const contentEncoding = request.headers.get("content-encoding")?.trim().toLowerCase();
  if (contentEncoding && contentEncoding !== "identity") {
    throw new ClientInputError("unsupported_media_type", "Compressed request bodies are not supported.", 415);
  }

  if (request.body === null) {
    throw new ClientInputError("invalid_json_body", "A JSON request body is required.");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("body limit exceeded");
        throw new ClientInputError("request_too_large", `Request body exceeds ${maxBytes} bytes.`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(joined);
}

export async function readJsonRequest(request: Request, maxBytes: number): Promise<unknown> {
  if (!isJsonContentType(request.headers.get("content-type"))) {
    throw new ClientInputError("unsupported_media_type", "Content-Type must be application/json or an application/*+json media type.", 415);
  }

  let text: string;
  try {
    text = await readBoundedUtf8(request, maxBytes);
  } catch (error) {
    if (error instanceof ClientInputError) throw error;
    throw new ClientInputError("invalid_json_body", "Request body must be valid UTF-8 JSON.");
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ClientInputError("invalid_json_body", "Request body must be valid JSON.");
  }
}

export async function parseCreateWaitRequest(request: Request): Promise<CreateWaitRequest> {
  return validateCreateWaitRequest(await readJsonRequest(request, MAX_CREATE_BODY_BYTES));
}

export async function parseEventJson(request: Request): Promise<unknown> {
  return readJsonRequest(request, MAX_EVENT_BODY_BYTES);
}
