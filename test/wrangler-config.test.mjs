import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

describe("Wrangler security configuration", () => {
  it("uses the Worker entrypoint that exports the delivery Workflow class", () => {
    expect(config.main).toBe("src/worker.ts");
  });

  it("keeps preview deployment disabled and routes global fetch through the public Internet path", () => {
    expect(config.preview_urls).toBe(false);
    expect(config.workers_dev).toBe(false);
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
  });

  it("requires the public callback network boundary without a host registry", () => {
    expect(config.compatibility_flags).toContain("global_fetch_strictly_public");
    expect(config.vars).not.toHaveProperty("CALLBACK_HOST_ALLOWLIST");
  });

  it("does not allow Cloudflare invocation logs or traces to record bearer-capability paths", () => {
    expect(config.observability?.enabled).toBe(true);
    expect(config.observability?.logs?.enabled).toBe(true);
    expect(config.observability?.logs?.invocation_logs).toBe(false);
    expect(config.observability?.traces?.enabled).toBe(false);
  });

  it("contains placeholder D1 and portfolio delivery Workflow bindings", () => {
    expect(config.d1_databases).toEqual([
      {
        binding: "DB",
        database_name: "wait-portfolio-db",
        database_id: "00000000-0000-0000-0000-000000000000",
        migrations_dir: "migrations",
      },
    ]);
    expect(config.workflows).toEqual([
      {
        binding: "DELIVERY_WORKFLOW",
        name: "wait-portfolio-delivery",
        class_name: "DeliveryWorkflow",
      },
    ]);
    for (const key of ["ai", "kv_namespaces", "r2_buckets", "queues", "durable_objects"]) {
      expect(config[key]).toBeUndefined();
    }
  });

  it("keeps payment configuration incomplete with a zero recipient and no credentials", () => {
    expect(config.vars).toEqual({
      PUBLIC_ORIGIN: "https://wait.example.com",
      PAYMENT_MODE: "x402-base-mainnet",
      X402_FACILITATOR_URL: "https://api.cdp.coinbase.com/platform/v2/x402",
      X402_NETWORK: "eip155:8453",
      X402_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      X402_AMOUNT_ATOMIC: "10000",
      X402_PAY_TO: "0x0000000000000000000000000000000000000000",
      X402_ASSET_NAME: "USD Coin",
      X402_ASSET_VERSION: "2",
    });
    expect(config.vars.MOCK_PAYMENT_KEY).toBeUndefined();
  });

  it("declares only the inert predeployment intent for hourly cleanup at minute 17 UTC", () => {
    expect(config.triggers).toEqual({ crons: ["17 * * * *"] });
  });
});