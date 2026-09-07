import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

describe("ordinary logging and public-error security contract", () => {
  it("keeps product handlers free of ordinary console or safe-telemetry logging", async () => {
    const productSources = await Promise.all([
      source("src/index.ts"),
      source("src/routes.ts"),
      source("src/delivery-workflow.ts"),
    ]);
    for (const text of productSources) {
      expect(text).not.toMatch(/\bconsole\s*\./u);
      expect(text).not.toMatch(/\blogSafeTelemetry\s*\(/u);
    }
  });

  it("uses a fixed unknown-field response without interpolating the supplied field name", async () => {
    const validation = await source("src/validation.ts");
    expect(validation).toContain('"unknown_request_field", "Request contains an unsupported field."');
    expect(validation).not.toMatch(/unknown_request_field[^\n]+(?:unknown|field)\s*[})]/iu);
  });

  it("keeps mock and local implementation wording out of public payment errors", async () => {
    const publicSources = await Promise.all([
      source("src/payment-adapter.ts"),
      source("src/routes.ts"),
      source("src/openapi.ts"),
    ]);
    expect(publicSources.join("\n")).not.toMatch(/Mock payment|mock local|required local|local\/offline/u);
  });
});
