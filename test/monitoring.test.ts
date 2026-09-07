import { afterEach, describe, expect, it, vi } from "vitest";
import { reportIncident, reportSalesFuseState, reconcileIncidentMonitoring } from "../src/monitoring";
import { handleRequest } from "../src/index";
import { commitAmbiguousPaymentAndHonor, failCallbackDelivery } from "../src/repository";

const now = new Date("2026-09-06T01:00:00Z");
afterEach(() => vi.restoreAllMocks());
function readDb(value: unknown) {
  const first = vi.fn().mockResolvedValue(value);
  const bind = vi.fn().mockReturnValue({ first });
  const prepare = vi.fn().mockReturnValue({ bind, first });
  return { db: { prepare } as unknown as D1Database, prepare, bind, first };
}
describe("content-minimized incident monitoring", () => {
  it("only emits fixed categories and numeric counts, and cannot break callers", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    reportIncident("payment_ambiguity", "transition");
    expect(log).toHaveBeenCalledWith({ service: "wait", event: "wait_incident", incident: "payment_ambiguity", source: "transition", count: 1 });
    reportIncident("https://secret.example/e/token" as never, "fetch");
    reportIncident("worker_error", "secret" as never);
    reportIncident("worker_error", "fetch", NaN);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockImplementation(() => { throw new Error("logger unavailable"); });
    expect(() => reportIncident("worker_error", "fetch")).not.toThrow();
  });
  it("reconciles aggregate durable incidents with a bounded lookback and no writes", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, prepare, bind } = readDb({ payment_ambiguity: 2, callback_failure: 1, sales_fuse_closed: 1 });
    await reconcileIncidentMonitoring(db, now);
    expect(prepare.mock.calls[0][0]).toMatch(/^SELECT/u);
    expect(bind).toHaveBeenCalledWith("2026-09-05T23:55:00.000Z", "2026-09-05T23:55:00.000Z");
    expect(log.mock.calls.map(c => c[0].incident)).toEqual(["payment_ambiguity", "callback_failure", "sales_fuse_closed"]);
    expect(JSON.stringify(log.mock.calls)).not.toContain("request_id");
  });
  it.each([[1, 5, 5, false], [0, 4, 5, false], [0, 5, 5, true]])("reports closed and exhausted fuse only (%i/%i/%i)", async (enabled, honors, limit, expected) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = readDb({ new_sales_enabled: enabled, honors, max_ambiguous_payment_honors: limit });
    await reportSalesFuseState(db);
    expect(log).toHaveBeenCalledTimes(expected ? 1 : 0);
  });
  it("does not claim healthy monitoring when D1 is unavailable, or expose its error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, first } = readDb(null);
    first.mockRejectedValue(new Error("secret callback URL"));
    await expect(reconcileIncidentMonitoring(db, now)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ incident: "worker_error" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret");
  });
  it("logs ambiguity only after a committed transition and preserves success when monitoring fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, first } = readDb(null);
    const batch = vi.fn().mockResolvedValue(Array.from({ length: 4 }, () => ({ meta: { changes: 1 } })));
    Object.assign(db, { batch });
    first.mockRejectedValue(new Error("private"));
    await expect(commitAmbiguousPaymentAndHonor(db, "request-id", "safe-code", now)).resolves.toBeUndefined();
    expect(log.mock.calls[0][0].incident).toBe("payment_ambiguity");
    log.mockClear(); batch.mockResolvedValue([]);
    await expect(commitAmbiguousPaymentAndHonor(db, "request-id", "safe-code", now)).rejects.toThrow();
    expect(log).not.toHaveBeenCalled();
  });
  it("logs a terminal callback failure once, without logging idempotent recovery", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    let updated = true;
    const statement = { bind: (..._args: unknown[]) => statement, run: async () => ({ meta: { changes: updated ? 1 : 0 } }), first: async () => ({ state: "delivery_failed", delivery_workflow_instance_id: "delivery-wait-id" }) };
    const db = { prepare: () => statement } as unknown as D1Database;
    await failCallbackDelivery(db, "wait-id", "delivery-wait-id", now);
    updated = false;
    await failCallbackDelivery(db, "wait-id", "delivery-wait-id", now);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0].incident).toBe("callback_failure");
  });
  it("logs handled Worker errors without request URLs or exception messages", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db, first } = readDb(null); first.mockRejectedValue(new Error("secret-signature"));
    const response = await handleRequest(new Request("https://wait.example/s/" + "a".repeat(64)), { DB: db } as Env);
    expect(response.status).toBe(500);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ incident: "worker_error", source: "fetch" }));
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|https:|aaaa/u);
  });
});
