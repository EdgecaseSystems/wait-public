/** Public presentation only; no lifecycle or payment behavior. */
export const WAIT_DESCRIPTION = "Durable waiting for autonomous agents: defer work that cannot proceed yet and resume it later without keeping the agent running. Use Wait when an external service can send a webhook, but you need a temporary durable receiver that captures one event, retries callback delivery, and preserves recovery state without building that infrastructure yourself. Your callback handler or workflow resumes the work; Wait does not restart an agent process. One wait costs $0.01 for 60 seconds through 24 hours.";
export const waitBuyerGuide = {
  "incremental_value": "An existing callback is the destination. Wait adds a temporary per-job receiver, durable first-event acceptance, bounded callback retries, and retained event/status recovery in front of it.",
  "good_fit": "The producer can POST JSON, you have a public HTTPS callback handler that can resume work, and you want durable capture, retries, and recovery without building them.",
  "skip_when": "Your existing webhook infrastructure already provides equivalent durable event storage, delivery retries, and recovery. Wait is also unsuitable when the producer cannot push an event or you have no callback handler.",
  "prerequisites": [
    "An event producer that can POST one JSON value before your chosen expiry; choose a wait lifetime from 60 seconds to 24 hours.",
    "Your own public HTTPS callback on port 443, able to authenticate and deduplicate delivery and resume your workflow.",
    "An x402-capable wallet with spending authorization for the live payment requirements."
  ],
  "you_receive": "For $0.01: one temporary event_url, a secret status_url for recovery/cancellation, and a callback_token. The first accepted JSON event (up to 65,536 bytes) is durably recorded and delivery is attempted up to five times. Delivery is bounded at-least-once, not guaranteed.",
  "quick_start": [
    "Replace the example callback_url with your own handler. POST the example JSON to /v1/waits with Content-Type: application/json and no PAYMENT-SIGNATURE to obtain current HTTP 402 terms.",
    "After authorizing those terms, send the same body with PAYMENT-SIGNATURE and a fresh UUIDv4 Idempotency-Key. Save the complete HTTP 201 response securely. Never blindly retry an ambiguous signed request.",
    "Give event_url only to the intended producer. It POSTs the event as JSON before expires_at. Your waiting agent process can stop.",
    "Your callback verifies Edgecase-Wait-Token against callback_token, deduplicates by wait_id, and returns HTTP 2xx within 10 seconds. Its handler or workflow resumes the work.",
    "If delivery fails, use the secret status_url to inspect state and recover the accepted event while retained. Event content is retained for 72 hours after resolved terminal state; status for 30 days. A timeout without an event is not a scheduled wake-up callback."
  ],
  "request_example": {
    "callback_url": "https://your-agent.example.com/wait-callback",
    "timeout_seconds": 600,
    "client_reference": "job-123"
  },
  "example_note": "Replace the placeholder callback with your own reachable handler. This example creates no wait until an authorized paid request succeeds."
} as const;
