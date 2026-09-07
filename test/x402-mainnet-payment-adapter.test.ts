import { describe, expect, it } from "vitest";
import type { PaymentBinding } from "../src/payment-adapter";
import {
  SYNTHETIC_RECEIVING_WALLET,
  WAIT_PAYMENT_AMOUNT_ATOMIC,
  X402_BASE_MAINNET,
  X402_BASE_MAINNET_USDC,
  X402_CDP_FACILITATOR,
  X402_ORG_FACILITATOR,
  X402PaymentAdapter,
} from "../src/x402-payment-adapter";

const binding: PaymentBinding = {
  resource: "https://wait.example/v1/waits",
  offerId: "event-24h-v1",
  requestFingerprint: "55".repeat(32),
};

function generatedTestCdpSecret(): string {
  return btoa(String.fromCharCode(...new Uint8Array(64).fill(7)));
}

function mainnetConfiguration(overrides: Partial<Env> = {}): Env {
  return {
    CAPABILITY_KEY_V1: "11".repeat(32),
    PAYMENT_MODE: "x402-base-mainnet",
    X402_FACILITATOR_URL: X402_CDP_FACILITATOR,
    X402_NETWORK: X402_BASE_MAINNET,
    X402_ASSET: X402_BASE_MAINNET_USDC,
    X402_AMOUNT_ATOMIC: WAIT_PAYMENT_AMOUNT_ATOMIC,
    X402_PAY_TO: SYNTHETIC_RECEIVING_WALLET,
    X402_ASSET_NAME: "USD Coin",
    X402_ASSET_VERSION: "2",
    X402_CDP_API_KEY_ID: "test-key-id",
    X402_CDP_API_KEY_SECRET: generatedTestCdpSecret(),
    ...overrides,
  } as unknown as Env;
}

describe("Base mainnet x402 payment configuration", () => {
  it("stays fail-closed unless the exact one-cent Base/USDC/recipient configuration is present", () => {
    expect(() => new X402PaymentAdapter(mainnetConfiguration())).not.toThrow();
    expect(() => new X402PaymentAdapter(mainnetConfiguration({ X402_NETWORK: "eip155:84532" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402PaymentAdapter(mainnetConfiguration({ X402_ASSET: "0x1111111111111111111111111111111111111111" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402PaymentAdapter(mainnetConfiguration({ X402_PAY_TO: "0x2222222222222222222222222222222222222222" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402PaymentAdapter(mainnetConfiguration({ X402_AMOUNT_ATOMIC: "10001" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402PaymentAdapter(mainnetConfiguration({ X402_ASSET_NAME: "USDC" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402PaymentAdapter(mainnetConfiguration({ X402_ASSET_VERSION: "1" }))).toThrow("payment_adapter_unavailable");
    expect(() => new X402PaymentAdapter(mainnetConfiguration({ X402_FACILITATOR_URL: X402_ORG_FACILITATOR }))).toThrow("payment_adapter_unavailable");
  });

  it("publishes the exact Base mainnet payment requirement", () => {
    const adapter = new X402PaymentAdapter(mainnetConfiguration());
    const required = adapter.paymentRequired(binding);
    expect(required).toMatchObject({
      x402Version: 2,
      accepts: [{
        scheme: "exact",
        network: X402_BASE_MAINNET,
        amount: WAIT_PAYMENT_AMOUNT_ATOMIC,
        asset: X402_BASE_MAINNET_USDC,
        payTo: SYNTHETIC_RECEIVING_WALLET,
        extra: {
          assetTransferMethod: "eip3009",
          paymentFlow: "upfront",
          name: "USD Coin",
          version: "2",
        },
      }],
    });
  });
});
