import { WAIT_DESCRIPTION } from "./buyer-guide";
import { canonicalJson } from "./canonical";
import { sha256Hex } from "./capabilities";
import { ClientInputError } from "./errors";
import {
  type PaymentAdapter,
  type PaymentAttemptResult,
  type PaymentAuthorization,
  type PaymentBinding,
  type PaymentReconciliationResult,
} from "./payment-adapter";

export const X402_BASE_MAINNET = "eip155:8453";
export const X402_BASE_SEPOLIA = "eip155:84532";
export const X402_BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// Synthetic test recipient only. Never send funds to this address.
export const SYNTHETIC_RECEIVING_WALLET = "0x0000000000000000000000000000000000000001";
export const X402_ORG_FACILITATOR = "https://x402.org/facilitator";
export const X402_CDP_FACILITATOR = "https://api.cdp.coinbase.com/platform/v2/x402";
export const WAIT_PAYMENT_AMOUNT_ATOMIC = "10000";
const MAX_PAYMENT_HEADER_CHARACTERS = 16_384;
const MAX_FACILITATOR_RESPONSE_BYTES = 16_384;
const FACILITATOR_TIMEOUT_MS = 10_000;

type JsonObject = Record<string, unknown>;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface X402Requirements {
  scheme: "exact";
  network: typeof X402_BASE_SEPOLIA | typeof X402_BASE_MAINNET;
  amount: typeof WAIT_PAYMENT_AMOUNT_ATOMIC;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: 60;
  extra: {
    assetTransferMethod: "eip3009";
    paymentFlow: "upfront";
    name: string;
    version: string;
  };
}

interface X402PaymentPayload {
  x402Version: 2;
  resource: JsonObject;
  accepted: X402Requirements;
  payload: {
    signature: string;
    authorization: {
      from: string;
      to: string;
      value: string;
      validAfter: string;
      validBefore: string;
      nonce: string;
    };
  };
  extensions: JsonObject;
}

type Facilitator =
  | { kind: "x402_org"; url: typeof X402_ORG_FACILITATOR }
  | { kind: "cdp"; url: typeof X402_CDP_FACILITATOR; apiKeyId: string; apiKeySecret: string };

interface X402AdapterConfiguration {
  facilitator: Facilitator;
  requirements: X402Requirements;
}

function makeWaitRequestExample(): JsonObject {
  return {
    callback_url: "https://your-agent.example.com/wait-callback",
    timeout_seconds: 600,
    client_reference: "example-wait",
  };
}

function makeWaitResponseExample(resourceUrl: string): JsonObject {
  const origin = new URL(resourceUrl).origin;
  const waitId = "00000000-0000-4000-8000-000000000000";
  const capability = "0".repeat(64);
  return {
    wait_id: waitId,
    status: "waiting",
    event_url: `${origin}/e/${capability}`,
    status_url: `${origin}/s/${capability}`,
    callback_token: capability,
    client_reference: "example-wait",
    created_at: "2026-09-04T00:00:00.000Z",
    expires_at: "2026-09-04T00:10:00.000Z",
  };
}

function makeWaitExtensions(binding: PaymentBinding): JsonObject {
  const requestExample = makeWaitRequestExample();
  const responseExample = makeWaitResponseExample(binding.resource);
  return {
    bazaar: {
      info: {
        input: { type: "http", method: "POST", bodyType: "json", body: requestExample },
        output: { type: "json", example: responseExample },
      },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["input", "output"],
        properties: {
          input: {
            type: "object",
            additionalProperties: false,
            required: ["type", "method", "bodyType", "body"],
            properties: {
              type: { type: "string", const: "http" },
              method: { type: "string", enum: ["POST"] },
              bodyType: { type: "string", enum: ["json"] },
              body: {
                type: "object",
                additionalProperties: false,
                required: ["callback_url", "timeout_seconds"],
                properties: {
                  callback_url: { type: "string", format: "uri" },
                  timeout_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
                  client_reference: { type: "string", minLength: 1, maxLength: 200 },
                },
              },
            },
          },
          output: {
            type: "object",
            additionalProperties: false,
            required: ["type", "example"],
            properties: {
              type: { type: "string", const: "json" },
              example: {
                type: "object",
                additionalProperties: false,
                required: ["wait_id", "status", "event_url", "status_url", "callback_token", "created_at", "expires_at"],
                properties: {
                  wait_id: { type: "string", format: "uuid" },
                  status: { type: "string", const: "waiting" },
                  event_url: { type: "string", format: "uri" },
                  status_url: { type: "string", format: "uri" },
                  callback_token: { type: "string", pattern: "^[0-9a-f]{64}$" },
                  client_reference: { type: ["string", "null"] },
                  created_at: { type: "string", format: "date-time" },
                  expires_at: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
      },
    },
    edgecaseWait: {
      info: { offerId: binding.offerId, requestFingerprint: binding.requestFingerprint },
      schema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["offerId", "requestFingerprint"],
        properties: {
          offerId: { type: "string", const: binding.offerId },
          requestFingerprint: { type: "string", pattern: "^[0-9a-f]{64}$" },
        },
      },
    },
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: JsonObject, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value);
}

function isSupportedNetwork(value: unknown): value is typeof X402_BASE_SEPOLIA | typeof X402_BASE_MAINNET {
  return value === X402_BASE_SEPOLIA || value === X402_BASE_MAINNET;
}

function isCanonicalUint(value: unknown, maximumLength = 78): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) && value.length <= maximumLength;
}

function isHexByteString(value: unknown): value is string {
  return typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})+$/u.test(value);
}

function invalidProof(message: string): never {
  throw new ClientInputError("malformed_payment_proof", message);
}

function bindingMismatch(message: string): never {
  throw new ClientInputError("payment_binding_mismatch", message);
}

function decodeBase64Json(value: string): unknown {
  if (
    value.length === 0 || value.length > MAX_PAYMENT_HEADER_CHARACTERS || value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) invalidProof("PAYMENT-SIGNATURE must contain bounded Base64-encoded JSON.");
  try {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return invalidProof("PAYMENT-SIGNATURE must contain valid UTF-8 JSON.");
  }
}

function encodeBase64Json(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function parseResource(value: unknown): JsonObject {
  if (!isObject(value) || !hasOnlyKeys(value, ["url", "description", "mimeType", "serviceName", "tags"])) {
    invalidProof("The x402 resource object is invalid.");
  }
  if (typeof value.url !== "string" || value.url.length > 2_048) invalidProof("The x402 resource URL is invalid.");
  for (const key of ["description", "mimeType", "serviceName"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") invalidProof("The x402 resource metadata is invalid.");
  }
  if (value.tags !== undefined && (
    !Array.isArray(value.tags) || value.tags.length > 5 ||
    value.tags.some((tag) => typeof tag !== "string" || tag.length > 32)
  )) invalidProof("The x402 resource tags are invalid.");
  return value;
}

function parseRequirements(value: unknown): X402Requirements {
  if (!isObject(value) || !hasOnlyKeys(value, ["scheme", "network", "amount", "asset", "payTo", "maxTimeoutSeconds", "extra"])) {
    invalidProof("The accepted x402 payment requirements are invalid.");
  }
  if (
    value.scheme !== "exact" || !isSupportedNetwork(value.network) || value.amount !== WAIT_PAYMENT_AMOUNT_ATOMIC ||
    !isAddress(value.asset) || !isAddress(value.payTo) || value.maxTimeoutSeconds !== 60 ||
    !isObject(value.extra) || !hasOnlyKeys(value.extra, ["assetTransferMethod", "paymentFlow", "name", "version"]) ||
    value.extra.assetTransferMethod !== "eip3009" || value.extra.paymentFlow !== "upfront" ||
    typeof value.extra.name !== "string" || value.extra.name.length === 0 || value.extra.name.length > 64 ||
    typeof value.extra.version !== "string" || value.extra.version.length === 0 || value.extra.version.length > 32
  ) invalidProof("The accepted x402 payment requirements are invalid.");
  return value as unknown as X402Requirements;
}

function parsePayload(value: unknown): X402PaymentPayload["payload"] {
  if (!isObject(value) || !hasOnlyKeys(value, ["signature", "authorization"]) ||
    !isHexByteString(value.signature)) {
    invalidProof("The exact EVM payment payload is invalid.");
  }
  const authorization = value.authorization;
  if (
    !isObject(authorization) || !hasOnlyKeys(authorization, ["from", "to", "value", "validAfter", "validBefore", "nonce"]) ||
    !isAddress(authorization.from) || !isAddress(authorization.to) || !isCanonicalUint(authorization.value) ||
    !isCanonicalUint(authorization.validAfter, 20) || !isCanonicalUint(authorization.validBefore, 20) ||
    typeof authorization.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/u.test(authorization.nonce)
  ) invalidProof("The exact EVM authorization is invalid.");
  return value as unknown as X402PaymentPayload["payload"];
}

function readConfiguration(env: Env): X402AdapterConfiguration {
  const mode = env.PAYMENT_MODE?.trim() ?? "";
  const facilitatorUrl = env.X402_FACILITATOR_URL?.trim() ?? "";
  const network = env.X402_NETWORK?.trim() ?? "";
  const asset = env.X402_ASSET?.trim() ?? "";
  const amount = env.X402_AMOUNT_ATOMIC?.trim() ?? "";
  const payTo = env.X402_PAY_TO?.trim() ?? "";
  const name = env.X402_ASSET_NAME?.trim() ?? "";
  const version = env.X402_ASSET_VERSION?.trim() ?? "";
  const apiKeyId = env.X402_CDP_API_KEY_ID?.trim() ?? "";
  const apiKeySecret = env.X402_CDP_API_KEY_SECRET?.trim() ?? "";
  const isMainnet = mode === "x402-base-mainnet";
  const isSepolia = mode === "x402-base-sepolia";
  if (!isMainnet && !isSepolia) throw new Error("payment_adapter_unavailable");

  let facilitator: Facilitator;
  if (facilitatorUrl === X402_ORG_FACILITATOR) {
    if (isMainnet || apiKeyId || apiKeySecret) throw new Error("payment_adapter_unavailable");
    facilitator = { kind: "x402_org", url: X402_ORG_FACILITATOR };
  } else if (facilitatorUrl === X402_CDP_FACILITATOR) {
    if (!apiKeyId || !apiKeySecret) throw new Error("payment_adapter_unavailable");
    try {
      decodeCdpKeySecret(apiKeySecret);
    } catch {
      throw new Error("payment_adapter_unavailable");
    }
    facilitator = { kind: "cdp", url: X402_CDP_FACILITATOR, apiKeyId, apiKeySecret };
  } else {
    throw new Error("payment_adapter_unavailable");
  }

  const expectedNetwork = isMainnet ? X402_BASE_MAINNET : X402_BASE_SEPOLIA;
  if (
    network !== expectedNetwork || amount !== WAIT_PAYMENT_AMOUNT_ATOMIC || !isAddress(asset) || !isAddress(payTo) ||
    payTo.toLowerCase() === "0x0000000000000000000000000000000000000000" ||
    name.length === 0 || name.length > 64 || version.length === 0 || version.length > 32
  ) throw new Error("payment_adapter_unavailable");

  if (isMainnet && (
    asset.toLowerCase() !== X402_BASE_MAINNET_USDC.toLowerCase() ||
    payTo.toLowerCase() !== SYNTHETIC_RECEIVING_WALLET.toLowerCase() ||
    name !== "USD Coin" || version !== "2" || facilitator.kind !== "cdp"
  )) throw new Error("payment_adapter_unavailable");

  return {
    facilitator,
    requirements: {
      scheme: "exact",
      network: expectedNetwork,
      amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
      asset: isMainnet ? X402_BASE_MAINNET_USDC : asset,
      payTo: isMainnet ? SYNTHETIC_RECEIVING_WALLET : payTo,
      maxTimeoutSeconds: 60,
      extra: { assetTransferMethod: "eip3009", paymentFlow: "upfront", name, version },
    },
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeCdpKeySecret(value: string): Uint8Array {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new Error("invalid_cdp_api_key_secret");
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 64) throw new Error("invalid_cdp_api_key_secret");
  return bytes;
}

async function cdpAuthorizationHeader(facilitator: Extract<Facilitator, { kind: "cdp" }>, endpoint: string): Promise<string> {
  const keyBytes = decodeCdpKeySecret(facilitator.apiKeySecret);
  const now = Math.floor(Date.now() / 1_000);
  const target = new URL(endpoint);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({
    alg: "EdDSA", typ: "JWT", kid: facilitator.apiKeyId, nonce: crypto.randomUUID().replaceAll("-", ""),
  })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    sub: facilitator.apiKeyId, iss: "cdp", aud: ["cdp_service"], nbf: now, exp: now + 120,
    uri: `POST ${target.host}${target.pathname}`,
  })));
  const key = await crypto.subtle.importKey("jwk", {
    kty: "OKP", crv: "Ed25519", d: base64Url(keyBytes.slice(0, 32)), x: base64Url(keyBytes.slice(32)),
  }, { name: "Ed25519" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(`${header}.${claims}`)));
  return `Bearer ${header}.${claims}.${base64Url(signature)}`;
}

type BoundedJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; failureCode: string };

async function readBoundedJson(response: Response): Promise<BoundedJsonResult> {
  const declared = response.headers.get("content-length");
  if (declared && /^\d+$/u.test(declared) && Number(declared) > MAX_FACILITATOR_RESPONSE_BYTES) {
    return { ok: false, failureCode: "payment_settlement_response_too_large" };
  }
  if (!response.body) return { ok: false, failureCode: "payment_settlement_response_body_unavailable" };
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    return { ok: false, failureCode: "payment_settlement_response_read_failed" };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FACILITATOR_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, failureCode: "payment_settlement_response_too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, failureCode: "payment_settlement_response_read_failed" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown };
  } catch {
    return { ok: false, failureCode: "payment_settlement_response_invalid_json" };
  }
}

function boundedFailureCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : fallback;
}

function boundedDiagnosticText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const sanitized = value.trim().replace(/[\u0000-\u001F\u007F]/gu, " ").trim();
  return sanitized.length === 0 ? undefined : Array.from(sanitized).slice(0, 256).join("");
}

function coinbaseResponseIdentifier(headers: Headers): string | undefined {
  for (const name of ["x-request-id", "x-correlation-id", "correlation-id", "cb-request-id"]) {
    const identifier = boundedDiagnosticText(headers.get(name));
    if (identifier !== undefined) return identifier;
  }
  return undefined;
}

function structuredCoinbaseFailureCode(value: JsonObject): string | undefined {
  if (typeof value.errorType === "string") {
    return `coinbase_${boundedFailureCode(value.errorType, "api_error")}`.slice(0, 128);
  }
  if (value.success === false && (typeof value.errorReason === "string" || typeof value.errorMessage === "string")) {
    return boundedFailureCode(value.errorReason, "coinbase_settlement_failed");
  }
  return undefined;
}

function logCoinbaseSettlementDiagnostic(response: Response, value: JsonObject): void {
  const hasSuccess = Object.prototype.hasOwnProperty.call(value, "success");
  const success = typeof value.success === "boolean" ? value.success : undefined;
  console.warn("Wait CDP settlement response", {
    upstream_http_status: response.status,
    ...(boundedDiagnosticText(value.errorType) === undefined ? {} : { coinbase_error_type: boundedDiagnosticText(value.errorType) }),
    ...(boundedDiagnosticText(value.errorReason) === undefined ? {} : { coinbase_error_reason: boundedDiagnosticText(value.errorReason) }),
    ...(boundedDiagnosticText(value.errorMessage) === undefined ? {} : { coinbase_error_message: boundedDiagnosticText(value.errorMessage) }),
    ...(coinbaseResponseIdentifier(response.headers) === undefined ? {} : { coinbase_request_id: coinbaseResponseIdentifier(response.headers) }),
    json_has_success: hasSuccess,
    ...(success === undefined ? {} : { json_success: success }),
  });
}

export class X402BaseSepoliaPaymentAdapter implements PaymentAdapter {
  private readonly configuration: X402AdapterConfiguration;

  constructor(env: Env, private readonly fetcher: Fetcher = fetch) {
    this.configuration = readConfiguration(env);
  }

  paymentRequired(binding: PaymentBinding): Record<string, unknown> {
    return {
      x402Version: 2,
      error: "PAYMENT-SIGNATURE header is required",
      resource: {
        url: binding.resource,
        description: WAIT_DESCRIPTION,
        mimeType: "application/json",
        serviceName: "Edgecase Wait",
        tags: ["agent", "wait", "event", "callback"],
      },
      accepts: [{ ...this.configuration.requirements, extra: { ...this.configuration.requirements.extra } }],
      extensions: makeWaitExtensions(binding),
    };
  }

  encodePaymentRequired(requirements: Record<string, unknown>): string {
    return encodeBase64Json(requirements);
  }

  encodePaymentResponse(response: Record<string, unknown>): string {
    return encodeBase64Json(response);
  }

  async authorize(signature: string, binding: PaymentBinding): Promise<PaymentAuthorization> {
    const expected = this.paymentRequired(binding);
    const value = decodeBase64Json(signature);
    if (!isObject(value) || !hasOnlyKeys(value, ["x402Version", "resource", "accepted", "payload", "extensions"]) || value.x402Version !== 2) {
      invalidProof("The PAYMENT-SIGNATURE payload must use x402 version 2.");
    }
    const accepted = parseRequirements(value.accepted);
    const expectedAccepted = (expected.accepts as X402Requirements[])[0];
    if (canonicalJson(accepted) !== canonicalJson(expectedAccepted)) bindingMismatch("Payment proof requirements do not match this purchase.");
    const resource = parseResource(value.resource);
    if (canonicalJson(resource) !== canonicalJson(expected.resource)) bindingMismatch("Payment proof resource does not match this purchase.");
    if (!isObject(value.extensions) ||
      canonicalJson(value.extensions.bazaar) !== canonicalJson((expected.extensions as JsonObject).bazaar) ||
      canonicalJson(value.extensions.edgecaseWait) !== canonicalJson((expected.extensions as JsonObject).edgecaseWait)) {
      bindingMismatch("Payment proof offer or request fingerprint does not match this purchase.");
    }
    const payload = parsePayload(value.payload);
    if (payload.authorization.to.toLowerCase() !== accepted.payTo.toLowerCase() || payload.authorization.value !== accepted.amount) {
      bindingMismatch("Signed payment authorization does not match this purchase.");
    }
    const expectedExtensions = expected.extensions as JsonObject;
    const parsed: X402PaymentPayload = {
      x402Version: 2,
      resource,
      accepted,
      payload,
      // edgecaseWait is a server-consumed request-binding extension. CDP only
      // receives the standardized Bazaar extension that it implements.
      extensions: { bazaar: expectedExtensions.bazaar },
    };
    return {
      proofFingerprint: await sha256Hex(`edgecase-wait-x402-payment-proof-v1:${canonicalJson({ accepted, payload })}`),
      network: accepted.network,
      asset: accepted.asset,
      amount: accepted.amount,
      payTo: accepted.payTo,
      payerIdentity: payload.authorization.from,
      nonce: payload.authorization.nonce,
      providerPayload: parsed,
    };
  }

  async attemptAcceptance(authorization: PaymentAuthorization, externalOperationId: string): Promise<PaymentAttemptResult> {
    if (!/^wait-payment-[0-9a-f-]{36}$/u.test(externalOperationId) || !isObject(authorization.providerPayload)) {
      return { outcome: "ambiguous", failureCode: "invalid_durable_payment_authorization" };
    }
    const settlementBody = {
      x402Version: 2,
      paymentPayload: authorization.providerPayload,
      paymentRequirements: this.configuration.requirements,
    };
    const settleUrl = `${this.configuration.facilitator.url}/settle`;
    let bearer: string | undefined;
    try {
      bearer = this.configuration.facilitator.kind === "cdp"
        ? await cdpAuthorizationHeader(this.configuration.facilitator, settleUrl)
        : undefined;
    } catch {
      return { outcome: "ambiguous", failureCode: "payment_settlement_request_preparation_failed" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FACILITATOR_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        const fetcher = this.fetcher;
        response = await fetcher(settleUrl, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...(bearer ? { authorization: bearer } : {}) },
          body: JSON.stringify(settlementBody),
          redirect: "manual",
          signal: controller.signal,
        });
      } catch {
        return {
          outcome: "ambiguous",
          failureCode: controller.signal.aborted ? "payment_settlement_timeout" : "payment_settlement_transport_error",
        };
      }
      const settlementHttpStatus = response.status;
      if (settlementHttpStatus >= 300 && settlementHttpStatus < 400) {
        return { outcome: "ambiguous", failureCode: "payment_settlement_redirect_response" };
      }
      const parsed = await readBoundedJson(response);
      if (controller.signal.aborted) return { outcome: "ambiguous", failureCode: "payment_settlement_timeout" };
      if (!parsed.ok) return { outcome: "ambiguous", failureCode: parsed.failureCode };
      const settlement = parsed.value;
      const coinbaseError = this.configuration.facilitator.kind === "cdp" && isObject(settlement)
        ? structuredCoinbaseFailureCode(settlement)
        : undefined;
      if (this.configuration.facilitator.kind === "cdp" && isObject(settlement) &&
        (!response.ok || settlement.success !== true)) {
        logCoinbaseSettlementDiagnostic(response, settlement);
      }
      if (!isObject(settlement) || typeof settlement.success !== "boolean" ||
        typeof settlement.transaction !== "string" || typeof settlement.network !== "string") {
        return { outcome: "ambiguous", failureCode: coinbaseError ?? "payment_settlement_invalid_response" };
      }
      const successfulHttpStatus = settlementHttpStatus >= 200 && settlementHttpStatus < 300;
      const definiteRejectionHttpStatus = settlementHttpStatus >= 400 && settlementHttpStatus < 500 &&
        ![408, 425, 429].includes(settlementHttpStatus);
      if (!settlement.success) {
        const reason = boundedFailureCode(settlement.errorReason, "payment_settlement_failed");
        const payerContradiction = settlement.payer !== undefined && (
          !isAddress(settlement.payer) || settlement.payer.toLowerCase() !== authorization.payerIdentity.toLowerCase()
        );
        const amountContradiction = settlement.amount !== undefined && settlement.amount !== authorization.amount;
        if (!definiteRejectionHttpStatus || settlement.transaction.length > 0 || reason === "settlement_pending" ||
          settlement.network !== authorization.network || payerContradiction || amountContradiction) {
          return {
            outcome: "ambiguous",
            failureCode: definiteRejectionHttpStatus ? reason : "payment_settlement_http_uncertain",
          };
        }
        return { outcome: "rejected", failureCode: reason };
      }
      if (!successfulHttpStatus || !/^0x[0-9a-fA-F]{64}$/u.test(settlement.transaction) || settlement.network !== authorization.network ||
        !isAddress(settlement.payer) || settlement.payer.toLowerCase() !== authorization.payerIdentity.toLowerCase() ||
        (settlement.amount !== undefined && settlement.amount !== authorization.amount)) {
        return { outcome: "ambiguous", failureCode: "payment_settlement_evidence_mismatch" };
      }
      return { outcome: "accepted", payerIdentity: settlement.payer, transactionId: settlement.transaction };
    } finally {
      clearTimeout(timeout);
    }
  }

  async reconcileAcceptance(): Promise<PaymentReconciliationResult> {
    return { outcome: "unknown", failureCode: "facilitator_reconciliation_unavailable" };
  }
}

export { X402BaseSepoliaPaymentAdapter as X402PaymentAdapter };
