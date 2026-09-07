import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function migration() {
  return readFile(path.join(root, "migrations", "0001_initial.sql"), "utf8");
}

async function retentionMigration() {
  return readFile(path.join(root, "migrations", "0002_add_retention_cleanup_markers.sql"), "utf8");
}

async function reconciliationMigration() {
  return readFile(path.join(root, "migrations", "0003_add_crash_reconciliation.sql"), "utf8");
}

async function closedControlsMigration() {
  return readFile(path.join(root, "migrations", "0004_close_service_controls.sql"), "utf8");
}

async function ambiguityHonorMigration() {
  return readFile(path.join(root, "migrations", "0005_add_ambiguity_honor_fuse.sql"), "utf8");
}

describe("initial D1 migration candidate", () => {
  it("stores hashed idempotency/capability lookup material and a derivation-key version", async () => {
    const sql = await migration();
    expect(sql).toContain("idempotency_key_hash TEXT NOT NULL UNIQUE");
    expect(sql).toContain("event_token_hash TEXT NOT NULL UNIQUE");
    expect(sql).toContain("status_token_hash TEXT NOT NULL UNIQUE");
    expect(sql).toContain("capability_key_version INTEGER NOT NULL DEFAULT 1");
  });

  it("does not persist plaintext callback tokens or replay blobs containing bearer capabilities", async () => {
    const sql = await migration();
    expect(sql).not.toMatch(/callback_token_secret\s+TEXT/iu);
    expect(sql).not.toMatch(/response_json\s+TEXT/iu);
    expect(sql).not.toMatch(/\bidempotency_key\s+TEXT/iu);
  });

  it("starts commercial sales disabled", async () => {
    const sql = await migration();
    expect(sql).toContain("new_sales_enabled INTEGER NOT NULL DEFAULT 0");
    expect(sql).toMatch(/VALUES \(\s*1,\s*0,\s*1,\s*100,\s*100,/u);
  });
});

describe("retention cleanup migration", () => {
  it("adds explicit cleanup markers without weakening payment evidence", async () => {
    const sql = await retentionMigration();
    expect(sql).toContain("replay_purged_at TEXT");
    expect(sql).toContain("event_content_purged_at TEXT");
    expect(sql).not.toMatch(/DROP\s+(?:TABLE|COLUMN).*request_payments/iu);
  });
});

describe("crash reconciliation migration", () => {
  it("adds deterministic payment, atomic admission, and callback-success evidence", async () => {
    const sql = await reconciliationMigration();
    expect(sql).toContain("external_operation_id TEXT");
    expect(sql).toContain("external_call_started_at TEXT");
    expect(sql).toContain("CREATE TABLE commercial_admissions");
    expect(sql).toContain("callback_success_observed_at TEXT");
  });
});

describe("closed service-control migration", () => {
  it("preserves history and closes both externally meaningful controls", async () => {
    const sql = await closedControlsMigration();
    expect(sql).toMatch(/UPDATE service_controls/iu);
    expect(sql).toMatch(/new_sales_enabled\s*=\s*0/iu);
    expect(sql).toMatch(/callback_delivery_enabled\s*=\s*0/iu);
    expect(sql).not.toMatch(/(?:DROP|DELETE)\s+/iu);
  });
});

describe("ambiguity-honor fuse migration", () => {
  it("adds an explicit honored fact and a conservative default fuse without rewriting history", async () => {
    const sql = await ambiguityHonorMigration();
    expect(sql).toContain("ambiguity_honored_at TEXT");
    expect(sql).toMatch(/max_ambiguous_payment_honors INTEGER NOT NULL DEFAULT 3/iu);
    expect(sql).toMatch(/CHECK \(max_ambiguous_payment_honors >= 1\)/iu);
    expect(sql).not.toMatch(/(?:DROP|DELETE)\s+/iu);
  });
});
