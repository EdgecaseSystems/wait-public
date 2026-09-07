import { WAIT_DESCRIPTION, waitBuyerGuide } from "./buyer-guide";
import { directoryDiscovery } from "./discovery";
import { EVENT_RECOVERY_RETENTION_MS, WAIT_METADATA_RETENTION_MS, IDEMPOTENCY_REPLAY_RETENTION_MS } from "./retention";

export const supportContact = { email: "support@example.com" } as const;
export const serviceAttentionGuidance = "Keep the status URL, stop blind payment/event/callback retries, and contact support@example.com with the wait_id and a brief problem description. Never send capability URLs, callback tokens, payment signatures, or event content in a support request.";
export const recoveryRetention = {
  event_content_hours_after_resolved_terminal_state: EVENT_RECOVERY_RETENTION_MS / 3_600_000,
  status_days_after_resolved_terminal_state: WAIT_METADATA_RETENTION_MS / 86_400_000,
  creation_replay_days_from_original_request: IDEMPOTENCY_REPLAY_RETENTION_MS / 86_400_000,
  guidance: "Resolved terminal states are delivered, delivery_failed, expired, and cancelled. Event content is retained for 72 hours after that state; status metadata for 30 days after that state. Exact creation replay is retained for 30 days from the original request reservation, not from each replay. Replay does not restore purged event content or reopen a terminal wait. Cleanup is asynchronous; do not rely on availability beyond these windows. Unresolved obligations requiring service attention are preserved for operator resolution.",
} as const;
export const callbackAcknowledgment = "Return any HTTP 200-299 response within 10 seconds to acknowledge delivery; no response body is required or inspected. Authenticate Edgecase-Wait-Token and deduplicate by wait_id before processing. Network errors, timeouts, and HTTP 408, 425, 429, 500, 502, 503, 504 may be retried, up to five total attempts. Other HTTP statuses, including redirects, are terminal failures; redirects are not followed.";

/**
 * The single canonical public API contract. The Worker serves this object
 * directly at /openapi.json, and contract tests import this same value.
 */
export const openApiDocument = {
  openapi: "3.1.0",
  info: {
    title: "Edgecase Wait API",
    contact: supportContact,
    version: "0.1.0",
    description: WAIT_DESCRIPTION + " New sales and callback delivery are operator-controlled and may be disabled. Callback delivery is bounded at-least-once; buyers deduplicate by wait_id.",
  },
  "x-buyer-guide": waitBuyerGuide,
  "x-recovery-retention": recoveryRetention,
  "x-directory-discovery": directoryDiscovery,
  tags: [
    { name: "Discovery" },
    { name: "Waits" },
    { name: "Event delivery" },
    { name: "Recovery" },
  ],
  paths: {
    "/.well-known/api-catalog": {
      get: { tags: ["Discovery"], operationId: "getApiCatalog", responses: { "200": { description: "RFC 9727 API catalog linking the public service and canonical OpenAPI contract.", content: { "application/linkset+json": { schema: { type: "object", required: ["linkset"], properties: { linkset: { type: "array", items: { type: "object" } } } } } } } } },
      head: { tags: ["Discovery"], operationId: "headApiCatalog", responses: { "200": { description: "Catalog discovery headers without a response body.", headers: { Link: { schema: { type: "string" }, description: "api-catalog link relation." } } } } },
    },
    "/health": {
      get: { tags: ["Discovery"], operationId: "getHealth", responses: { "200": { description: "Healthy" } } },
    },
    "/": {
      get: { tags: ["Discovery"], operationId: "getRoot", responses: { "200": { description: "Service summary. sales_status (open or closed) and callback_delivery_status (enabled or disabled) are current snapshots, omitted when unavailable. Open sales do not guarantee purchase availability; use unsigned POST /v1/waits for current requirements." } } },
    },
    "/openapi.json": {
      get: { tags: ["Discovery"], operationId: "getOpenApi", responses: { "200": { description: "This document" } } },
    },
    "/v1/waits": {
      post: {
        tags: ["Waits"],
        operationId: "createWait",
        summary: "Wait for one event and resume work through an HTTPS callback",
        description: WAIT_DESCRIPTION + " Your callback handler resumes the agent or workflow; Wait does not run the agent or poll another service. An unsigned request performs stateless HTTP 402 negotiation. The paid retry supplies PAYMENT-SIGNATURE and a UUIDv4 Idempotency-Key. Exact paid-request replay recovers one entitlement without another financial operation. A definitely rejected payment creates no wait. A definitely accepted payment creates one wait. For the one-cent v0.1 offer, an irrecoverably ambiguous outcome after the durable external-call boundary also receives one wait without claiming payment success or attempting settlement again; PAYMENT-RESPONSE is omitted for that ambiguity-honored response. A bounded ambiguity fuse closes new sales automatically. Arbitrary public HTTPS DNS callback hostnames are accepted without pre-registration, on default port 443 only. IP literals, localhost, single-label hosts, local/reserved-style suffixes (.localhost, .local, .internal, .lan, .home, .invalid, .test), credentials, and fragments are rejected. Redirects are not followed. Cloudflare global fetch provides the public outbound HTTP boundary. Delivery remains bounded at-least-once; deduplicate by wait_id.",
        parameters: [
          { $ref: "#/components/parameters/IdempotencyKey" },
          { $ref: "#/components/parameters/PaymentSignature" },
        ],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWaitRequest" }, example: waitBuyerGuide.request_example } },
        },
        callbacks: {
          eventDelivery: {
            "{$request.body#/callback_url}": {
              post: {
                operationId: "receiveWaitCallback",
                description: callbackAcknowledgment,
                parameters: [
                  { name: "Edgecase-Wait-Token", in: "header", required: true, description: "Must match the secret callback_token from creation.", schema: { type: "string" } },
                  { name: "Edgecase-Wait-Id", in: "header", required: true, description: "The wait_id.", schema: { type: "string", format: "uuid" } },
                  { name: "Idempotency-Key", in: "header", required: true, description: "The wait_id; deduplicate callback processing by wait_id.", schema: { type: "string", format: "uuid" } },
                ],
                requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CallbackPayload" } } } },
                responses: {
                  "2XX": { description: "Delivery acknowledged. Response body is ignored." },
                  default: { description: callbackAcknowledgment },
                },
              },
            },
          },
        },
        responses: {
          "201": {
            description: "Wait created or payment-free replay recovered. PAYMENT-RESPONSE is present only when payment acceptance is proven; it is omitted when the bounded v0.1 ambiguity policy honors the wait without claiming payment success.",
            headers: { "PAYMENT-RESPONSE": { schema: { type: "string" } } },
            content: { "application/json": { schema: { $ref: "#/components/schemas/CreateWaitResponse" } } },
          },
          "400": { $ref: "#/components/responses/BadRequest" },
          "402": {
            description: "Stateless PAYMENT-REQUIRED negotiation or rejected payment",
            headers: { "PAYMENT-REQUIRED": { required: true, schema: { type: "string" } } },
          },
          "409": { description: "Idempotency/proof conflict or an ambiguity that did not qualify for the bounded honor policy; retryable is false" },
          "429": { description: "Atomic commercial capacity admission failed; retry only when the response sets retryable=true and obey Retry-After" },
          "503": { description: "Required service configuration or sales admission unavailable; retryable is false" },
        },
      },
    },
    "/e/{event_capability}": {
      post: {
        tags: ["Event delivery"],
        operationId: "deliverEvent",
        description: "POST one JSON value to the secret event_url returned by creation. The first bounded JSON event wins durably. A semantic retry reconciles the same deterministic delivery-{wait_id} Workflow; a different event conflicts. The sender receives 202 after durable event acceptance and Workflow provisioning/reconciliation, not after callback completion.",
        parameters: [{ $ref: "#/components/parameters/EventCapability" }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/EventPayload" } } },
        },
        responses: {
          "202": { description: "Event durably accepted for asynchronous delivery" },
          "400": { $ref: "#/components/responses/BadRequest" },
          "404": { description: "Capability unavailable" },
          "409": { description: "Different event or incompatible terminal state; retryable is false" },
          "413": { description: "Event exceeds 65,536 bytes" },
          "415": { description: "Unsupported content type" },
          "503": { description: "The event remains durably accepted but Workflow reconciliation is incomplete; retry the semantically identical event when retryable=true" },
        },
      },
    },
    "/s/{status_capability}": {
      get: {
        tags: ["Recovery"],
        operationId: "getWaitStatus",
        description: "Private bearer recovery for lifecycle state and retained accepted event. service_attention_required means stop blind payment, event, and callback retries. " + serviceAttentionGuidance,
        parameters: [{ $ref: "#/components/parameters/StatusCapability" }],
        responses: {
          "200": { description: "Current wait state and accepted event while retained; see x-recovery-retention for recovery windows.", content: { "application/json": { schema: { $ref: "#/components/schemas/WaitStatusResponse" } } } },
          "404": { description: "Capability unavailable" },
        },
      },
    },
    "/s/{status_capability}/cancel": {
      post: {
        tags: ["Recovery"],
        operationId: "cancelWait",
        description: "Cancel only while the wait is waiting. Repeating cancellation of an already-cancelled wait returns its terminal state; cancellation cannot override an accepted event or another terminal state.",
        parameters: [{ $ref: "#/components/parameters/StatusCapability" }],
        responses: {
          "200": { description: "Current wait state and accepted event while retained; see x-recovery-retention for recovery windows.", content: { "application/json": { schema: { $ref: "#/components/schemas/WaitStatusResponse" } } } },
          "404": { description: "Capability unavailable" },
          "409": { description: "Wait is no longer cancellable; retryable is false" },
        },
      },
    },
  },
  components: {
    parameters: {
      IdempotencyKey: {
        name: "Idempotency-Key", in: "header", required: false,
        description: "Required on PAYMENT-SIGNATURE requests; must be UUIDv4.",
        schema: { type: "string", format: "uuid" },
      },
      PaymentSignature: {
        name: "PAYMENT-SIGNATURE", in: "header", required: false,
        description: "x402 V2 payment proof matching exactly the network, asset, amount, recipient, and request binding advertised by the authoritative live PAYMENT-REQUIRED challenge from unsigned HTTP 402 negotiation. Retain the original PAYMENT-SIGNATURE securely for exact replay with the same logical request body and Idempotency-Key; the Idempotency-Key alone is not sufficient to recover capabilities. Never blindly resend a payment-bearing request after an ambiguous result.",
        schema: { type: "string" },
      },
      EventCapability: {
        name: "event_capability", in: "path", required: true,
        description: "Secret bearer event capability.",
        schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
      StatusCapability: {
        name: "status_capability", in: "path", required: true,
        description: "Secret bearer status and cancellation capability.",
        schema: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
    responses: {
      BadRequest: {
        description: "Request validation failed",
        content: { "application/json": { schema: { $ref: "#/components/schemas/ErrorResponse" } } },
      },
    },
    schemas: {
      CallbackPayload: {
        type: "object", additionalProperties: false,
        required: ["wait_id", "client_reference", "event_received_at", "event"],
        properties: {
          wait_id: { type: "string", format: "uuid" },
          client_reference: { type: ["string", "null"], description: "The creation request client_reference, or null when omitted." },
          event_received_at: { type: "string", format: "date-time" },
          event: { $ref: "#/components/schemas/EventPayload" },
        },
      },
      CreateWaitRequest: {
        type: "object", additionalProperties: false, required: ["callback_url", "timeout_seconds"],
        properties: {
          callback_url: { type: "string", format: "uri", minLength: 1, maxLength: 2048, description: "Arbitrary public HTTPS DNS callback hostnames are accepted without pre-registration, on default port 443 only. IP literals, localhost, single-label hosts, local/reserved-style suffixes (.localhost, .local, .internal, .lan, .home, .invalid, .test), credentials, and fragments are rejected. Redirects are not followed. Cloudflare global fetch provides the public outbound HTTP boundary. Delivery remains bounded at-least-once; deduplicate by wait_id." },
          timeout_seconds: { type: "integer", minimum: 60, maximum: 86_400 },
          client_reference: { type: "string", minLength: 1, maxLength: 200 },
        },
      },
      CreateWaitResponse: {
        description: "Persist the complete successful HTTP 201 creation response immediately. event_url, status_url, and callback_token are bearer credentials; keep them secret and out of logs. For recovery within the supported retention window, securely retain the original request body, Idempotency-Key, and PAYMENT-SIGNATURE. Exact replay to the same create endpoint requires the same logical request body, the same Idempotency-Key, and the original PAYMENT-SIGNATURE. The Idempotency-Key alone is not sufficient to recover capabilities. A retained accepted or ambiguity-honored entitlement is reconstructed without another settlement; do not create a new payment authorization or blindly resend after an ambiguous result.",
        type: "object", additionalProperties: false,
        required: ["wait_id", "status", "event_url", "status_url", "callback_token", "created_at", "expires_at"],
        properties: {
          wait_id: { type: "string", format: "uuid" }, status: { const: "waiting" },
          event_url: { type: "string", format: "uri" }, status_url: { type: "string", format: "uri" },
          callback_token: { type: "string", pattern: "^[0-9a-f]{64}$", description: "Secret expected in Edgecase-Wait-Token on callbacks. Edgecase-Wait-Id and Idempotency-Key both contain wait_id; deduplicate callback processing by wait_id because network delivery is bounded at-least-once." },
          client_reference: { type: ["string", "null"] },
          created_at: { type: "string", format: "date-time" }, expires_at: { type: "string", format: "date-time" },
        },
      },
      EventPayload: { description: "Any JSON value within the 65,536-byte request limit." },
      WaitStatusResponse: {
        type: "object", required: ["wait_id", "status", "created_at", "expires_at"],
        properties: {
          wait_id: { type: "string", format: "uuid" },
          status: { enum: ["waiting", "event_received", "delivering", "delivered", "delivery_failed", "expired", "cancelled", "service_attention_required"] },
          client_reference: { type: ["string", "null"] },
          created_at: { type: "string", format: "date-time" }, expires_at: { type: "string", format: "date-time" },
          event_received_at: { type: ["string", "null"], format: "date-time" },
          callback_delivered_at: { type: ["string", "null"], format: "date-time" },
          callback_attempts: { type: "integer", minimum: 0 }, event: { description: "Present while retained after event acceptance." },
        },
      },
      ErrorResponse: {
        type: "object", required: ["error"],
        properties: {
          error: { type: "string" }, code: { type: "string" }, message: { type: "string" },
          retryable: { type: "boolean" }, retry_after_seconds: { type: "integer", minimum: 0 },
        },
      },
    },
  },
} as const;
