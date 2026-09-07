interface Env {
  CAPABILITY_KEY_V1: string;
  CAPABILITY_KEY_V2?: string;
  PUBLIC_ORIGIN?: string;
  PAYMENT_MODE?: string;
  MOCK_PAYMENT_KEY?: string;
  X402_FACILITATOR_URL?: string;
  X402_NETWORK?: string;
  X402_ASSET?: string;
  X402_AMOUNT_ATOMIC?: string;
  X402_PAY_TO?: string;
  X402_ASSET_NAME?: string;
  X402_ASSET_VERSION?: string;
  X402_CDP_API_KEY_ID?: string;
  X402_CDP_API_KEY_SECRET?: string;
}

interface DeliveryWorkflowParams {
  wait_id: string;
}

declare module "cloudflare:workers" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: Parameters<typeof import("cloudflare:test").applyD1Migrations>[1];
  }
}
