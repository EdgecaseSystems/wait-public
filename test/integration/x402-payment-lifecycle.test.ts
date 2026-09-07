import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../../src/index";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER } from "../../src/payment-adapter";
import { getPaymentRow, getWaitByRequestId } from "../../src/repository";
import type { CreateWaitResponse } from "../../src/types";
import {
  WAIT_PAYMENT_AMOUNT_ATOMIC,
  X402_BASE_SEPOLIA,
  X402_ORG_FACILITATOR,
  X402BaseSepoliaPaymentAdapter,
} from "../../src/x402-payment-adapter";

const testEnv = env as unknown as Env;
const now = new Date("2026-09-02T16:00:00.000Z");
const asset = "0x1111111111111111111111111111111111111111";
const payTo = "0x2222222222222222222222222222222222222222";
const payer = "0x3333333333333333333333333333333333333333";
const transaction = `0x${"44".repeat(32)}`;
const createBody = {
  callback_url: "https://agent.example.com/callback",
  timeout_seconds: 3_600,
  client_reference: "x402-sepolia-adapter-test",
};

function liveConfiguration(): Env {
  return {
    ...testEnv,
    PAYMENT_MODE: "x402-base-sepolia",
    X402_FACILITATOR_URL: X402_ORG_FACILITATOR,
    X402_NETWORK: X402_BASE_SEPOLIA,
    X402_ASSET: asset,
    X402_AMOUNT_ATOMIC: WAIT_PAYMENT_AMOUNT_ATOMIC,
    X402_PAY_TO: payTo,
    X402_ASSET_NAME: "USDC",
    X402_ASSET_VERSION: "2",
  };
}

function request(signature?: string, idempotencyKey = "a0000000-0000-4000-8000-000000000001"): Request {
  return new Request("https://wait.example/v1/waits", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Idempotency-Key": idempotencyKey,
      ...(signature ? { [PAYMENT_SIGNATURE_HEADER]: signature } : {}),
    },
    body: JSON.stringify(createBody),
  });
}

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function signedPayload(paymentRequired: Record<string, unknown>, nonceByte = "77"): string {
  return encode({
    x402Version: 2,
    resource: paymentRequired.resource,
    accepted: (paymentRequired.accepts as unknown[])[0],
    payload: {
      signature: `0x${"66".repeat(65)}`,
      authorization: {
        from: payer,
        to: payTo,
        value: WAIT_PAYMENT_AMOUNT_ATOMIC,
        validAfter: "0",
        validBefore: "2000000000",
        nonce: `0x${nonceByte.repeat(32)}`,
      },
    },
    extensions: paymentRequired.extensions,
  });
}

beforeEach(async () => {
  await testEnv.DB.prepare(
    `UPDATE service_controls
        SET new_sales_enabled = 1, callback_delivery_enabled = 1,
            max_active_waits = 100, max_paid_waits_per_day = 100,
            max_ambiguous_payment_honors = 100
      WHERE id = 1`,
  ).run();
});

describe("public lifecycle with the dormant Base Sepolia adapter", () => {
  it("negotiates, settles once, creates one wait, and replays without a second facilitator call", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      success: true,
      transaction,
      network: X402_BASE_SEPOLIA,
      payer,
      amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
    }));
    const adapter = new X402BaseSepoliaPaymentAdapter(liveConfiguration(), fetcher);
    const unsigned = await handleRequest(request(), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(unsigned.status).toBe(402);
    const requiredHeader = unsigned.headers.get(PAYMENT_REQUIRED_HEADER);
    expect(requiredHeader).not.toBeNull();
    const paymentRequired = JSON.parse(atob(requiredHeader!)) as Record<string, unknown>;
    const signature = signedPayload(paymentRequired, "88");

    const paid = await handleRequest(request(signature), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(paid.status).toBe(201);
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).not.toBeNull();
    const created = await paid.json() as CreateWaitResponse;
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({
      state: "accepted", network: X402_BASE_SEPOLIA, asset, amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
      pay_to: payTo, payer_identity: payer, transaction_id: transaction,
    });
    expect(await getWaitByRequestId(testEnv.DB, created.wait_id)).toMatchObject({ state: "waiting" });

    const replay = await handleRequest(request(signature), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("honors a lost settlement response as ambiguous and never calls settlement again", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => { throw new Error("lost response"); });
    const adapter = new X402BaseSepoliaPaymentAdapter(liveConfiguration(), fetcher);
    const key = "a0000000-0000-4000-8000-000000000002";
    const unsigned = await handleRequest(request(undefined, key), testEnv, { paymentAdapter: adapter, now: () => now });
    const paymentRequired = JSON.parse(atob(unsigned.headers.get(PAYMENT_REQUIRED_HEADER)!)) as Record<string, unknown>;
    const signature = signedPayload(paymentRequired);

    const paid = await handleRequest(request(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(paid.status).toBe(201);
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    const created = await paid.json() as CreateWaitResponse;
    expect(await getPaymentRow(testEnv.DB, created.wait_id)).toMatchObject({
      state: "ambiguous", accepted_at: null, transaction_id: null, ambiguity_honored_at: now.toISOString(),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const replay = await handleRequest(request(signature, key), testEnv, { paymentAdapter: adapter, now: () => now });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(created);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
