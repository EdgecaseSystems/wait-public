import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { openApiDocument } from "../src/openapi";

describe("canonical OpenAPI contract", () => {
  it("documents the narrow wait_for_event public surface", () => {
    expect(Object.keys(openApiDocument.paths)).toEqual(expect.arrayContaining([
      "/v1/waits",
      "/e/{event_capability}",
      "/s/{status_capability}",
      "/s/{status_capability}/cancel",
    ]));
    expect(openApiDocument.components.schemas.CreateWaitRequest.properties).toHaveProperty("callback_url");
    expect(openApiDocument.components.schemas.CreateWaitRequest.properties).toHaveProperty("timeout_seconds");
    expect(JSON.stringify(openApiDocument)).toContain("65,536-byte");
    expect(JSON.stringify(openApiDocument)).toContain("service_attention_required");
  });

  it("documents stateless negotiation, UUIDv4 paid retry, and capacity/recovery responses", () => {
    const create = openApiDocument.paths["/v1/waits"].post;
    expect(create.description).toContain("stateless HTTP 402 negotiation");
    expect(create.description).toContain("UUIDv4");
    expect(create.description).toContain("without pre-registration");
    expect(create.responses).toHaveProperty("429");
    expect(create.responses).toHaveProperty("503");
    expect(JSON.stringify(create.responses)).not.toMatch(/\b(?:mock|local)\b/iu);
    expect(openApiDocument.info).toMatchObject({ version: "0.1.0" });
    expect(openApiDocument.info.description).not.toMatch(/\b(?:predeployment|local)\b/iu);
    const signature = openApiDocument.components.parameters.PaymentSignature.description;
    expect(signature).not.toContain("Base Sepolia");
    for (const text of ["network", "asset", "amount", "recipient", "request binding", "authoritative live PAYMENT-REQUIRED"]) expect(signature).toContain(text);
  });

  it("documents complete-response persistence, bearer secrecy, and exact replay requirements", () => {
    const guidance = openApiDocument.components.schemas.CreateWaitResponse.description;
    for (const text of ["complete successful HTTP 201", "event_url", "status_url", "callback_token", "bearer credentials", "keep them secret", "same logical request body", "same Idempotency-Key", "original PAYMENT-SIGNATURE", "Idempotency-Key alone is not sufficient", "without another settlement"]) expect(guidance).toContain(text);
    expect(openApiDocument.paths["/"].get.responses["200"].description).toContain("omitted when unavailable");
  });

  it("documents callback authentication, at-least-once delivery, and public destinations", () => {
    const document = JSON.stringify(openApiDocument);
    expect(document).toContain("Edgecase-Wait-Token");
    expect(document).toContain("deduplicate callback processing by wait_id");
    expect(document).toContain("bounded at-least-once");
    expect(document).toContain("Cloudflare global fetch provides the public outbound HTTP boundary");
    expect(document).toContain("Redirects are not followed");
    expect(document).toContain("service_attention_required means stop blind payment");
    expect(document).toContain("Cancel only while the wait is waiting");
  });

  it("documents the truthful bounded one-cent ambiguity policy", () => {
    const creation = openApiDocument.paths["/v1/waits"].post;
    expect(creation.description).toContain("definitely rejected payment creates no wait");
    expect(creation.description).toContain("irrecoverably ambiguous");
    expect(creation.description).toContain("without claiming payment success");
    expect(creation.responses["201"].description).toContain("PAYMENT-RESPONSE is present only when payment acceptance is proven");
  });

  it("documents deterministic semantic event reconciliation", () => {
    const event = openApiDocument.paths["/e/{event_capability}"].post;
    expect(event.description).toContain("semantic retry");
    expect(event.description).toContain("delivery-{wait_id}");
    expect(event.responses).toHaveProperty("409");
  });

  it("serves the exact canonical object at /openapi.json", async () => {
    const response = await handleRequest(new Request("https://wait.example/openapi.json"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(openApiDocument);
  });
});


describe("buyer callback and recovery contract", () => {
  it("defines the outbound callback envelope, authentication and acknowledgment", () => {
    const callback = openApiDocument.paths["/v1/waits"].post.callbacks.eventDelivery["{$request.body#/callback_url}"].post;
    expect(callback.requestBody.content["application/json"].schema.$ref).toBe("#/components/schemas/CallbackPayload");
    const payload = openApiDocument.components.schemas.CallbackPayload;
    expect(payload.required).toEqual(["wait_id", "client_reference", "event_received_at", "event"]);
    expect(Object.keys(payload.properties)).toEqual(payload.required);
    expect(payload.properties.client_reference.type).toEqual(["string", "null"]);
    expect(payload.properties.event.$ref).toBe("#/components/schemas/EventPayload");
    expect(callback.parameters.map(p => p.name)).toEqual(["Edgecase-Wait-Token", "Edgecase-Wait-Id", "Idempotency-Key"]);
    for (const text of ["200-299", "10 seconds", "no response body", "408, 425, 429, 500, 502, 503, 504", "five total attempts", "redirects are not followed"]) expect(callback.description).toContain(text);
  });

  it("provides descriptions for every inline operation response, including callbacks", () => {
    function check(value: unknown): void {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "responses") {
          for (const response of Object.values(child as Record<string, { $ref?: string; description?: string }>)) {
            if (!response.$ref) expect(response.description).toEqual(expect.stringMatching(/\S/u));
          }
        }
        check(child);
      }
    }
    check(openApiDocument.paths);
  });

  it("publishes matching recovery windows and safe support guidance at both discovery surfaces", async () => {
    const response = await handleRequest(new Request("https://wait.example/"));
    const root = await response.json() as Record<string, any>;
    const retention = openApiDocument["x-recovery-retention"];
    expect(root.recovery_retention).toEqual(retention);
    expect(retention).toMatchObject({ event_content_hours_after_resolved_terminal_state: 72, status_days_after_resolved_terminal_state: 30, creation_replay_days_from_original_request: 30 });
    for (const text of ["original request reservation", "not from each replay", "does not restore purged event content", "Unresolved obligations"]) expect(retention.guidance).toContain(text);
    expect(root.service_attention.contact).toEqual(openApiDocument.info.contact);
    expect(openApiDocument.info.contact.email).toBe("support@example.com");
    expect(root.service_attention.action).toContain("Never send capability URLs");
    expect(root.callback.body_fields).toEqual(openApiDocument.components.schemas.CallbackPayload.required);
    expect(root.callback.acknowledgment).toEqual(openApiDocument.paths["/v1/waits"].post.callbacks.eventDelivery["{$request.body#/callback_url}"].post.description);
  });
});
