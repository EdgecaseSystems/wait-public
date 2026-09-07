import { WAIT_DESCRIPTION } from "./buyer-guide";
import { canonicalJson } from "./canonical";
import { constantTimeEqual, sha256Hex } from "./capabilities";
import { ClientInputError } from "./errors";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";
export const MOCK_PAYMENT_NETWORK = "mock:offline";
export const MOCK_PAYMENT_ASSET = "mock-usdc";
export const MOCK_PAYMENT_AMOUNT = "10000";
export const MOCK_PAYMENT_RECIPIENT = "mock-recipient";
const MAX_PAYMENT_HEADER_LENGTH = 8_192;

export interface PaymentBinding {
  resource: string;
  offerId: string;
  requestFingerprint: string;
}

export interface MockPaymentPayload extends PaymentBinding {
  x402Version: 2;
  scheme: "mock-exact";
  network: typeof MOCK_PAYMENT_NETWORK;
  asset: typeof MOCK_PAYMENT_ASSET;
  amount: typeof MOCK_PAYMENT_AMOUNT;
  payTo: typeof MOCK_PAYMENT_RECIPIENT;
  payer: string;
  nonce: string;
  outcome: "accepted" | "rejected" | "ambiguous";
}

export interface PaymentAuthorization {
  proofFingerprint: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  payerIdentity: string;
  nonce: string;
  outcome?: MockPaymentPayload["outcome"];
  providerPayload?: unknown;
}

export type PaymentAttemptResult =
  | { outcome: "accepted"; payerIdentity: string; transactionId: string }
  | { outcome: "rejected"; failureCode: string }
  | { outcome: "ambiguous"; failureCode: string };

export type PaymentReconciliationResult =
  | { outcome: "accepted"; payerIdentity: string; transactionId: string }
  | { outcome: "rejected"; failureCode: string }
  | { outcome: "not_attempted" }
  | { outcome: "unknown"; failureCode: string };

export interface PaymentAdapter {
  paymentRequired(binding: PaymentBinding): Record<string, unknown>;
  encodePaymentRequired(requirements: Record<string, unknown>): string;
  encodePaymentResponse(response: Record<string, unknown>): string;
  authorize(signature: string, binding: PaymentBinding): Promise<PaymentAuthorization>;
  attemptAcceptance(authorization: PaymentAuthorization, externalOperationId: string): Promise<PaymentAttemptResult>;
  reconcileAcceptance(
    authorization: PaymentAuthorization,
    externalOperationId: string,
  ): Promise<PaymentReconciliationResult>;
}

export function paymentExternalOperationId(requestId: string): string {
  if (!/^[0-9a-f-]{36}$/iu.test(requestId)) throw new Error("invalid_payment_operation_request_id");
  return `wait-payment-${requestId.toLowerCase()}`;
}

export class InMemoryMockPaymentProvider {
  readonly attempts: string[] = [];
  private readonly outcomes = new Map<string, {
    proofFingerprint: string;
    result: PaymentReconciliationResult;
  }>();

  settle(externalOperationId: string, authorization: PaymentAuthorization): PaymentAttemptResult {
    this.attempts.push(externalOperationId);
    const existingOperation = this.outcomes.get(externalOperationId);
    if (existingOperation && existingOperation.proofFingerprint !== authorization.proofFingerprint) {
      return { outcome: "ambiguous", failureCode: "mock_operation_binding_conflict" };
    }
    const existing = existingOperation?.result;
    if (existing?.outcome === "accepted") {
      return { outcome: "accepted", payerIdentity: existing.payerIdentity, transactionId: existing.transactionId };
    }
    if (existing?.outcome === "rejected") return { outcome: "rejected", failureCode: existing.failureCode };
    if (authorization.outcome === "rejected") {
      const result = { outcome: "rejected", failureCode: "mock_payment_rejected" } as const;
      this.outcomes.set(externalOperationId, { proofFingerprint: authorization.proofFingerprint, result });
      return result;
    }
    if (authorization.outcome === "ambiguous") {
      const result = { outcome: "unknown", failureCode: "mock_payment_ambiguous" } as const;
      this.outcomes.set(externalOperationId, { proofFingerprint: authorization.proofFingerprint, result });
      return { outcome: "ambiguous", failureCode: result.failureCode };
    }
    const result = {
      outcome: "accepted",
      payerIdentity: authorization.payerIdentity,
      transactionId: `mock:${authorization.proofFingerprint}`,
    } as const;
    this.outcomes.set(externalOperationId, { proofFingerprint: authorization.proofFingerprint, result });
    return result;
  }

  reconcile(externalOperationId: string, authorization: PaymentAuthorization): PaymentReconciliationResult {
    const operation = this.outcomes.get(externalOperationId);
    if (!operation) return { outcome: "not_attempted" };
    if (operation.proofFingerprint !== authorization.proofFingerprint) {
      return { outcome: "unknown", failureCode: "mock_operation_binding_conflict" };
    }
    return operation.result;
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new ClientInputError("malformed_payment_proof", "PAYMENT-SIGNATURE is malformed.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const binary = atob(padded);
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  } catch {
    throw new ClientInputError("malformed_payment_proof", "PAYMENT-SIGNATURE is malformed.");
  }
}

async function hmacHex(secret: Uint8Array, value: string): Promise<string> {
  const keyBytes = new Uint8Array(secret);
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))));
}

function isPayload(value: unknown): value is MockPaymentPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.x402Version === 2 && candidate.scheme === "mock-exact" &&
    candidate.network === MOCK_PAYMENT_NETWORK && candidate.asset === MOCK_PAYMENT_ASSET &&
    candidate.amount === MOCK_PAYMENT_AMOUNT && candidate.payTo === MOCK_PAYMENT_RECIPIENT &&
    typeof candidate.resource === "string" && typeof candidate.offerId === "string" &&
    typeof candidate.requestFingerprint === "string" && typeof candidate.payer === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/u.test(candidate.payer) &&
    typeof candidate.nonce === "string" && /^[0-9a-f-]{36}$/iu.test(candidate.nonce) &&
    ["accepted", "rejected", "ambiguous"].includes(String(candidate.outcome));
}

export function makePaymentRequired(binding: PaymentBinding): Record<string, unknown> {
  return {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: binding.resource,
      description: WAIT_DESCRIPTION,
      mimeType: "application/json",
    },
    accepts: [{
      scheme: "mock-exact",
      network: MOCK_PAYMENT_NETWORK,
      asset: MOCK_PAYMENT_ASSET,
      amount: MOCK_PAYMENT_AMOUNT,
      payTo: MOCK_PAYMENT_RECIPIENT,
      offerId: binding.offerId,
      requestFingerprint: binding.requestFingerprint,
    }],
  };
}

export function encodePaymentHeader(value: unknown): string {
  return base64UrlEncode(canonicalJson(value));
}

export function decodePaymentHeader(value: string): unknown {
  return JSON.parse(base64UrlDecode(value)) as unknown;
}

export async function createMockPaymentSignature(
  secret: Uint8Array,
  binding: PaymentBinding,
  input: Pick<MockPaymentPayload, "payer" | "nonce" | "outcome">,
): Promise<string> {
  const payload: MockPaymentPayload = {
    x402Version: 2,
    scheme: "mock-exact",
    network: MOCK_PAYMENT_NETWORK,
    asset: MOCK_PAYMENT_ASSET,
    amount: MOCK_PAYMENT_AMOUNT,
    payTo: MOCK_PAYMENT_RECIPIENT,
    ...binding,
    ...input,
  };
  const encoded = base64UrlEncode(canonicalJson(payload));
  return `${encoded}.${await hmacHex(secret, encoded)}`;
}

export class MockPaymentAdapter implements PaymentAdapter {
  constructor(
    private readonly secret: Uint8Array,
    private readonly provider?: InMemoryMockPaymentProvider,
  ) {
    if (secret.byteLength < 32) throw new Error("mock_payment_key_unavailable");
  }

  paymentRequired(binding: PaymentBinding): Record<string, unknown> {
    return makePaymentRequired(binding);
  }

  encodePaymentRequired(requirements: Record<string, unknown>): string {
    return encodePaymentHeader(requirements);
  }

  encodePaymentResponse(response: Record<string, unknown>): string {
    return encodePaymentHeader(response);
  }

  async authorize(signature: string, binding: PaymentBinding): Promise<PaymentAuthorization> {
    if (signature.length === 0 || signature.length > MAX_PAYMENT_HEADER_LENGTH) {
      throw new ClientInputError("malformed_payment_proof", "PAYMENT-SIGNATURE is malformed.");
    }
    const pieces = signature.split(".");
    if (pieces.length !== 2 || !/^[0-9a-f]{64}$/u.test(pieces[1])) {
      throw new ClientInputError("malformed_payment_proof", "PAYMENT-SIGNATURE is malformed.");
    }
    const expected = await hmacHex(this.secret, pieces[0]);
    if (!constantTimeEqual(expected, pieces[1])) {
      throw new ClientInputError("invalid_payment_proof", "Payment proof signature is invalid.");
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(base64UrlDecode(pieces[0])) as unknown;
    } catch (error) {
      if (error instanceof ClientInputError) throw error;
      throw new ClientInputError("malformed_payment_proof", "PAYMENT-SIGNATURE is malformed.");
    }
    if (!isPayload(decoded)) throw new ClientInputError("malformed_payment_proof", "Payment proof fields are invalid.");
    if (
      decoded.resource !== binding.resource || decoded.offerId !== binding.offerId ||
      decoded.requestFingerprint !== binding.requestFingerprint
    ) {
      throw new ClientInputError("payment_binding_mismatch", "Payment proof is bound to a different resource, offer, or request.");
    }
    return {
      proofFingerprint: await sha256Hex(`edgecase-wait-payment-proof-v1:${signature}`),
      network: decoded.network,
      asset: decoded.asset,
      amount: decoded.amount,
      payTo: decoded.payTo,
      payerIdentity: decoded.payer,
      nonce: decoded.nonce,
      outcome: decoded.outcome,
    };
  }

  async attemptAcceptance(
    authorization: PaymentAuthorization,
    externalOperationId: string,
  ): Promise<PaymentAttemptResult> {
    if (!authorization.outcome) return { outcome: "ambiguous", failureCode: "invalid_mock_authorization" };
    if (this.provider) return this.provider.settle(externalOperationId, authorization);
    if (authorization.outcome === "rejected") return { outcome: "rejected", failureCode: "mock_payment_rejected" };
    if (authorization.outcome === "ambiguous") return { outcome: "ambiguous", failureCode: "mock_payment_ambiguous" };
    return {
      outcome: "accepted",
      payerIdentity: authorization.payerIdentity,
      transactionId: `mock:${authorization.proofFingerprint}`,
    };
  }

  async reconcileAcceptance(
    authorization: PaymentAuthorization,
    externalOperationId: string,
  ): Promise<PaymentReconciliationResult> {
    return this.provider?.reconcile(externalOperationId, authorization) ?? {
      outcome: "unknown",
      failureCode: "mock_reconciliation_unavailable",
    };
  }
}

export function paymentResponse(result: { success: boolean; transaction?: string; network?: string }): Record<string, unknown> {
  return { x402Version: 2, ...result };
}
