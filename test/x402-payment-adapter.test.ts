import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import type { PaymentBinding } from "../src/payment-adapter";
import {
  WAIT_PAYMENT_AMOUNT_ATOMIC,
  X402_BASE_SEPOLIA,
  X402_CDP_FACILITATOR,
  X402_ORG_FACILITATOR,
  X402BaseSepoliaPaymentAdapter,
} from "../src/x402-payment-adapter";

const asset = "0x1111111111111111111111111111111111111111";
const payTo = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const transaction = `0x${"44".repeat(32)}`;
const binding: PaymentBinding = {
  resource: "https://wait.example/v1/waits",
  offerId: "event-24h-v1",
  requestFingerprint: "55".repeat(32),
};

function configuration(overrides: Partial<Env> = {}): Env {
  return {
    CAPABILITY_KEY_V1: "11".repeat(32),
    PAYMENT_MODE: "x402-base-sepolia",
    X402_FACILITATOR_URL: X402_ORG_FACILITATOR,
    X402_NETWORK: X402_BASE_SEPOLIA,
    X402_ASSET: asset,
    X402_AMOUNT_ATOMIC: WAIT_PAYMENT_AMOUNT_ATOMIC,
    X402_PAY_TO: payTo,
    X402_ASSET_NAME: "USDC",
    X402_ASSET_VERSION: "2",
    ...overrides,
  } as unknown as Env;
}

// Ephemeral valid Ed25519 keypair: generated locally and used only with mocked fetch.
function generatedSigningFixture(): string {
  const { privateKey } = generateKeyPairSync("ed25519");
  const jwk = privateKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from(jwk.d!, "base64url"), Buffer.from(jwk.x!, "base64url")]).toString("base64");
}

function cdpConfiguration(overrides: Partial<Env> = {}): Env {
  return configuration({
    X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
    X402_CDP_API_KEY_ID: "test-key",
    X402_CDP_API_KEY_SECRET: generatedSigningFixture(),
    ...overrides,
  });
}

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64UrlJson(value: string): Record<string, unknown> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return JSON.parse(atob(base64)) as Record<string, unknown>;
}

function paymentPayload(adapter: X402BaseSepoliaPaymentAdapter, overrides: Record<string, unknown> = {}) {
  const required = adapter.paymentRequired(binding);
  return {
    x402Version: 2,
    resource: required.resource,
    accepted: (required.accepts as unknown[])[0],
    payload: {
      signature: `0x${"66".repeat(65)}`,
      authorization: {
        from: payer,
        to: payTo,
        value: WAIT_PAYMENT_AMOUNT_ATOMIC,
        validAfter: "0",
        validBefore: "2000000000",
        nonce: `0x${"77".repeat(32)}`,
      },
    },
    extensions: required.extensions,
    ...overrides,
  };
}

async function attemptSettlementResponse(body: unknown, status = 400) {
  const adapter = new X402BaseSepoliaPaymentAdapter(configuration(), async () => Response.json(body, { status }));
  const authorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);
  return adapter.attemptAcceptance(authorization, "wait-payment-00000000-0000-4000-8000-000000000002");
}

async function attemptWithFetcher(fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const adapter = new X402BaseSepoliaPaymentAdapter(configuration(), fetcher);
  const authorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);
  return adapter.attemptAcceptance(authorization, "wait-payment-00000000-0000-4000-8000-000000000003");
}

describe("Base Sepolia x402 payment adapter", () => {
  it("stays fail-closed unless its exact Base Sepolia one-cent configuration is complete", () => {
    expect(() => new X402BaseSepoliaPaymentAdapter(configuration({ X402_NETWORK: "eip155:8453" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402BaseSepoliaPaymentAdapter(configuration({ X402_AMOUNT_ATOMIC: "10001" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402BaseSepoliaPaymentAdapter(configuration({ X402_FACILITATOR_URL: "https://facilitator.example" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402BaseSepoliaPaymentAdapter(configuration({
      X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
      X402_CDP_API_KEY_ID: "test-key",
    }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402BaseSepoliaPaymentAdapter(configuration({
      X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
      X402_CDP_API_KEY_ID: "test-key",
      X402_CDP_API_KEY_SECRET: "not-a-valid-key",
    }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402BaseSepoliaPaymentAdapter(configuration())).not.toThrow();
  });

  it("publishes standard-Base64 x402 v2 requirements bound to the exact Wait purchase", () => {
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration());
    const required = adapter.paymentRequired(binding);
    expect(required).toMatchObject({
      x402Version: 2,
      resource: { url: binding.resource, serviceName: "Edgecase Wait" },
      accepts: [{ scheme: "exact", network: X402_BASE_SEPOLIA, amount: WAIT_PAYMENT_AMOUNT_ATOMIC, asset, payTo }],
      extensions: {
        bazaar: {
          info: { input: { type: "http", method: "POST", bodyType: "json" }, output: { type: "json" } },
          schema: { $schema: "https://json-schema.org/draft/2020-12/schema", required: ["input", "output"] },
        },
        edgecaseWait: {
          info: { offerId: binding.offerId, requestFingerprint: binding.requestFingerprint },
          schema: { $schema: "https://json-schema.org/draft/2020-12/schema", required: ["offerId", "requestFingerprint"] },
        },
      },
    });
    expect(JSON.parse(atob(adapter.encodePaymentRequired(required)))).toEqual(required);
  });

  it("strictly binds and fingerprints an exact EIP-3009 authorization", async () => {
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration());
    const payload = paymentPayload(adapter);
    const authorization = await adapter.authorize(encode(payload), binding);
    expect(authorization).toMatchObject({
      network: X402_BASE_SEPOLIA,
      asset,
      amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
      payTo,
      payerIdentity: payer,
      nonce: `0x${"77".repeat(32)}`,
    });
    const sameFinancialProof = await adapter.authorize(encode({
      ...payload,
      extensions: { ...(payload.extensions as Record<string, unknown>), unrelated: { value: true } },
    }), binding);
    expect(sameFinancialProof.proofFingerprint).toBe(authorization.proofFingerprint);
    await expect(adapter.authorize(encode({
      ...payload,
      extensions: {
        ...(payload.extensions as Record<string, unknown>),
        edgecaseWait: {
          ...((payload.extensions as { edgecaseWait: Record<string, unknown> }).edgecaseWait),
          info: { offerId: "different", requestFingerprint: binding.requestFingerprint },
        },
      },
    }), binding)).rejects.toMatchObject({ code: "payment_binding_mismatch" });
  });

  it("consumes its binding extension locally and sends only Bazaar metadata to the facilitator", async () => {
    let settlementBody: Record<string, unknown> | undefined;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      settlementBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ success: true, transaction, network: X402_BASE_SEPOLIA, payer, amount: WAIT_PAYMENT_AMOUNT_ATOMIC });
    });
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration(), fetcher);
    const signed = paymentPayload(adapter);
    signed.extensions = {
      ...(signed.extensions as Record<string, unknown>),
      unrelated: { info: { value: true }, schema: { type: "object" } },
    };
    const authorization = await adapter.authorize(encode(signed), binding);

    await adapter.attemptAcceptance(authorization, "wait-payment-00000000-0000-4000-8000-000000000005");

    const providerPayload = settlementBody?.paymentPayload as { extensions: Record<string, { info: unknown; schema: unknown }> };
    expect(Object.keys(providerPayload.extensions)).toEqual(["bazaar"]);
    for (const extension of Object.values(providerPayload.extensions)) {
      expect(extension).toEqual(expect.objectContaining({ info: expect.any(Object), schema: expect.any(Object) }));
    }
  });

  it.each([
    ["65-byte EOA", 65],
    ["variable-length smart-account", 160],
  ])("accepts an opaque %s signature for facilitator verification", async (_kind, byteLength) => {
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration());
    const payload = paymentPayload(adapter);
    (payload.payload as { signature: string }).signature = `0x${"ab".repeat(byteLength)}`;

    await expect(adapter.authorize(encode(payload), binding)).resolves.toMatchObject({ payerIdentity: payer });
  });

  it.each([
    ["empty", "0x"],
    ["odd-length", "0xabc"],
    ["non-hex", "0xzz"],
  ])("rejects a structurally malformed %s EVM signature", async (_kind, signature) => {
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration());
    const payload = paymentPayload(adapter);
    (payload.payload as { signature: string }).signature = signature;

    await expect(adapter.authorize(encode(payload), binding)).rejects.toMatchObject({ code: "malformed_payment_proof" });
  });

  it("makes exactly one bounded settle call and accepts matching facilitator evidence", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      success: true,
      transaction,
      network: X402_BASE_SEPOLIA,
      payer,
      amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
    }));
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration(), fetcher);
    const authorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);
    await expect(adapter.attemptAcceptance(
      authorization,
      "wait-payment-00000000-0000-4000-8000-000000000001",
    )).resolves.toEqual({ outcome: "accepted", payerIdentity: payer, transactionId: transaction });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`${X402_ORG_FACILITATOR}/settle`);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", redirect: "manual" });
  });

  it("signs the CDP settle request with the documented resource-bound JWT claims", async () => {
    let authorizationHeader: string | null = null;
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      authorizationHeader = new Headers(init?.headers).get("authorization");
      return Response.json({
        success: true,
        transaction,
        network: X402_BASE_SEPOLIA,
        payer,
        amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
      });
    });
    const adapter = new X402BaseSepoliaPaymentAdapter(cdpConfiguration(), fetcher);
    const paymentAuthorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);

    await expect(adapter.attemptAcceptance(
      paymentAuthorization,
      "wait-payment-00000000-0000-4000-8000-000000000001",
    )).resolves.toMatchObject({ outcome: "accepted" });

    expect(authorizationHeader).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/u);
    const claims = decodeBase64UrlJson(authorizationHeader!.slice("Bearer ".length).split(".")[1]!);
    expect(claims).toMatchObject({
      sub: "test-key",
      iss: "cdp",
      aud: ["cdp_service"],
      uri: "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    });
    expect(claims).not.toHaveProperty("iat");
    expect(claims).not.toHaveProperty("uris");
    expect(claims.nbf).toEqual(expect.any(Number));
    expect(claims.exp).toBe((claims.nbf as number) + 120);
  });

  it("preserves a documented x402 settlement error as bounded Coinbase diagnostics", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => Response.json({
      success: false,
      errorReason: "invalid_payload",
      errorMessage: "The payment payload is invalid.",
      payer,
    }, { status: 400, headers: { "x-request-id": "coinbase-request-123" } }));
    const adapter = new X402BaseSepoliaPaymentAdapter(cdpConfiguration(), fetcher);
    const paymentAuthorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);

    await expect(adapter.attemptAcceptance(
      paymentAuthorization,
      "wait-payment-00000000-0000-4000-8000-000000000006",
    )).resolves.toEqual({ outcome: "ambiguous", failureCode: "invalid_payload" });
    expect(warning).toHaveBeenCalledWith("Wait CDP settlement response", {
      upstream_http_status: 400,
      coinbase_error_reason: "invalid_payload",
      coinbase_error_message: "The payment payload is invalid.",
      coinbase_request_id: "coinbase-request-123",
      json_has_success: true,
      json_success: false,
    });
    warning.mockRestore();
  });

  it("preserves a documented Coinbase API error as bounded diagnostics", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetcher = vi.fn(async () => Response.json({
      errorType: "unauthorized",
      errorMessage: "The request is not properly authenticated.",
    }, { status: 401, headers: { "x-correlation-id": "coinbase-correlation-456" } }));
    const adapter = new X402BaseSepoliaPaymentAdapter(cdpConfiguration(), fetcher);
    const paymentAuthorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);

    await expect(adapter.attemptAcceptance(
      paymentAuthorization,
      "wait-payment-00000000-0000-4000-8000-000000000007",
    )).resolves.toEqual({ outcome: "ambiguous", failureCode: "coinbase_unauthorized" });
    expect(warning).toHaveBeenCalledWith("Wait CDP settlement response", {
      upstream_http_status: 401,
      coinbase_error_type: "unauthorized",
      coinbase_error_message: "The request is not properly authenticated.",
      coinbase_request_id: "coinbase-correlation-456",
      json_has_success: false,
    });
    warning.mockRestore();
  });

  it("invokes the facilitator fetch function without an adapter receiver", async () => {
    let receiver: unknown = "not-called";
    const fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = async function (this: unknown) {
      receiver = this;
      return Response.json({
        success: true,
        transaction,
        network: X402_BASE_SEPOLIA,
        payer,
        amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
      });
    };
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration(), fetcher);
    const authorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);

    await expect(adapter.attemptAcceptance(
      authorization,
      "wait-payment-00000000-0000-4000-8000-000000000001",
    )).resolves.toMatchObject({ outcome: "accepted" });
    expect(receiver).toBeUndefined();
  });

  it("separates definite rejection from pending, contradictory, and lost outcomes", async () => {
    await expect(attemptSettlementResponse({ success: false, transaction: "", network: X402_BASE_SEPOLIA, errorReason: "invalid_signature" }))
      .resolves.toEqual({ outcome: "rejected", failureCode: "invalid_signature" });
    await expect(attemptSettlementResponse({ success: false, transaction: "", network: X402_BASE_SEPOLIA, errorReason: "settlement_pending" }))
      .resolves.toEqual({ outcome: "ambiguous", failureCode: "settlement_pending" });
    await expect(attemptSettlementResponse({ success: true, transaction, network: X402_BASE_SEPOLIA, payer: payTo }, 200))
      .resolves.toEqual({ outcome: "ambiguous", failureCode: "payment_settlement_evidence_mismatch" });

    await expect(attemptWithFetcher(async () => { throw new Error("lost response"); }))
      .resolves.toEqual({ outcome: "ambiguous", failureCode: "payment_settlement_transport_error" });
  });

  it.each([
    ["redirect", async () => new Response(null, { status: 302 }), "payment_settlement_redirect_response"],
    ["missing body", async () => new Response(null, { status: 200 }), "payment_settlement_response_body_unavailable"],
    ["oversized body", async () => new Response("ignored", { headers: { "content-length": "1000000" } }), "payment_settlement_response_too_large"],
    ["invalid JSON", async () => new Response("not-json"), "payment_settlement_response_invalid_json"],
    ["failed body read", async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("stream failed")); },
    })), "payment_settlement_response_read_failed"],
  ])("classifies a facilitator %s without exposing response content", async (_kind, fetcher, failureCode) => {
    await expect(attemptWithFetcher(fetcher))
      .resolves.toEqual({ outcome: "ambiguous", failureCode });
  });

  it.each(["before response headers", "while reading the response body"])("distinguishes a facilitator timeout %s", async (stage) => {
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration(), async (_input, init) => {
      if (stage === "before response headers") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      }));
    });
    const authorization = await adapter.authorize(encode(paymentPayload(adapter)), binding);
    vi.useFakeTimers();
    try {
      const attempt = adapter.attemptAcceptance(
        authorization,
        "wait-payment-00000000-0000-4000-8000-000000000004",
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(attempt).resolves.toEqual({ outcome: "ambiguous", failureCode: "payment_settlement_timeout" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never treats an HTTP 500 failure body as definite rejection", async () => {
    await expect(attemptSettlementResponse(
      { success: false, transaction: "", network: X402_BASE_SEPOLIA, errorReason: "invalid_signature" },
      500,
    )).resolves.toEqual({ outcome: "ambiguous", failureCode: "payment_settlement_http_uncertain" });
  });

  it("never treats an HTTP 429 failure body as definite rejection", async () => {
    await expect(attemptSettlementResponse(
      { success: false, transaction: "", network: X402_BASE_SEPOLIA, errorReason: "invalid_signature" },
      429,
    )).resolves.toEqual({ outcome: "ambiguous", failureCode: "payment_settlement_http_uncertain" });
  });

  it("never calls the facilitator while reconciling an armed operation", async () => {
    const fetcher = vi.fn(async () => { throw new Error("must not be called"); });
    const adapter = new X402BaseSepoliaPaymentAdapter(configuration(), fetcher);
    await expect(adapter.reconcileAcceptance()).resolves.toEqual({
      outcome: "unknown",
      failureCode: "facilitator_reconciliation_unavailable",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
