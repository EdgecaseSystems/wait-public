import { describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/index";

describe("Worker surface", () => {
  it("serves health without external bindings", async () => {
    const response = await handleRequest(new Request("https://wait.example/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", service: "wait", version: "0.1.0" });
  });

  it("serves discovery without inventing activation or unavailable control state", async () => {
    const response = await handleRequest(new Request("https://wait.example/"));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty("phase");
    expect(body).not.toHaveProperty("activated");
    expect(body).not.toHaveProperty("sales_status");
    expect(body).not.toHaveProperty("callback_delivery_status");
    expect(body).toMatchObject({
      service: "Edgecase Wait",
      semantics: { callback_delivery: "bounded_at_least_once", callback_deduplication_key: "wait_id" },
      purchase: {
        unsigned_request: expect.stringContaining("sales are disabled"),
        paid_retry_headers: ["PAYMENT-SIGNATURE", "Idempotency-Key (UUIDv4)"],
        payment_disposition: {
          rejected: "No wait is created.",
          accepted: expect.stringContaining("PAYMENT-RESPONSE"),
          ambiguous: expect.stringContaining("payment remains ambiguous"),
          fuse: expect.stringContaining("close new sales"),
        },
      },
      cancellation: { allowed_while: "waiting" },
      service_attention: { status: "service_attention_required" },
      retry_guidance: { signed_payment_exception: expect.stringContaining("Never automatically resend") },
      discovery: { global_listing: false, directory: { name: "CDP Bazaar" } },
      callback: {
        authentication: { token_header: "Edgecase-Wait-Token" },
        host_policy: { model: "public_https_dns_hosts", arbitrary_public_hosts: true, pre_registration_required: false, redirects_followed: false },
      },
    });
  });

  it.each([[0, 0], [0, 1], [1, 0], [1, 1]])("reports only buyer-facing status from controls %i/%i", async (sales, callbacks) => {
    const controls = { new_sales_enabled: sales, callback_delivery_enabled: callbacks, max_active_waits: 999, max_paid_waits_per_day: 888, max_ambiguous_payment_honors: 777 };
    const first = vi.fn().mockResolvedValue(controls);
    const prepare = vi.fn().mockReturnValue({ first });
    const env = { DB: { prepare } } as unknown as Env;
    const response = await handleRequest(new Request("https://wait.example/"), env);
    const body = await response.json();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({ sales_status: sales === 1 ? "open" : "closed", callback_delivery_status: callbacks === 1 ? "enabled" : "disabled" });
    for (const key of ["phase", "activated", ...Object.keys(controls)]) expect(body).not.toHaveProperty(key);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare.mock.calls[0][0]).toMatch(/^SELECT/u);
    controls.new_sales_enabled = 1 - sales;
    const refreshed = await handleRequest(new Request("https://wait.example/"), env);
    expect(await refreshed.json()).toHaveProperty("sales_status", sales === 1 ? "closed" : "open");
  });

  it.each(["missing", "failed"])("omits availability when controls are %s while preserving discovery", async (mode) => {
    const first = mode === "missing" ? vi.fn().mockResolvedValue(null) : vi.fn().mockRejectedValue(new Error("private diagnostic"));
    const env = { DB: { prepare: vi.fn().mockReturnValue({ first }) } } as unknown as Env;
    const response = await handleRequest(new Request("https://wait.example/"), env);
    const body = await response.json();
    expect(response.status).toBe(200);
    for (const key of ["phase", "activated", "sales_status", "callback_delivery_status"]) expect(body).not.toHaveProperty(key);
    expect(JSON.stringify(body)).not.toContain("private diagnostic");
  });

  it("publishes complete-response retention and authenticated exact-replay guidance", async () => {
    const response = await handleRequest(new Request("https://wait.example/"));
    const body = await response.json() as { purchase: { save_response: string; exact_replay: string } };
    expect(body.purchase.save_response).toContain("complete successful HTTP 201");
    for (const text of ["event_url", "status_url", "callback_token", "bearer credentials", "keep them secret"]) expect(body.purchase.save_response).toContain(text);
    for (const text of ["same logical request body", "same Idempotency-Key", "original PAYMENT-SIGNATURE", "Idempotency-Key alone is not sufficient", "without another settlement"]) expect(body.purchase.exact_replay).toContain(text);
  });

  it("fails closed on product routes when their D1 binding is absent", async () => {
    const response = await handleRequest(new Request("https://wait.example/v1/waits", { method: "POST" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "service_unavailable", retryable: false });
  });

  it("serves the implemented OpenAPI JSON without bindings", async () => {
    const response = await handleRequest(new Request("https://wait.example/openapi.json"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      openapi: "3.1.0",
      paths: { "/v1/waits": {}, "/e/{event_capability}": {}, "/s/{status_capability}": {} },
    });
  });
});
