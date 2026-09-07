# API reading guide

The canonical OpenAPI document is built in [`src/openapi.ts`](../src/openapi.ts) and returned from `/openapi.json`. [`src/buyer-guide.ts`](../src/buyer-guide.ts) contains the buyer instructions; discovery is in [`src/discovery.ts`](../src/discovery.ts).

The addresses below are reserved examples. They do not identify a working portfolio service.

| Operation | Purpose |
| --- | --- |
| `POST /v1/waits` | Request a temporary wait with exact request identity and payment binding |
| `POST /e/{token}` | Submit the first event using the event capability |
| `GET /s/{token}` | Read bounded status using the separate status capability |
| `GET /openapi.json` | Read the machine-readable contract |
| `GET /.well-known/api-catalog` | Discover the API description |

An unsigned valid create request negotiates x402 terms; it is not payment or a purchased wait. A payment-bearing request must retain the original UUIDv4 idempotency key and exact request binding. A missing HTTP response does not authorize a new settlement attempt.

Treat returned capability URLs as secrets. The receiver must validate the callback's `Edgecase-Wait-Token` and deduplicate by `wait_id`. Do not forward arbitrary incoming headers or interpret callback delivery as exactly-once execution.

Examples of the complete mocked lifecycle are in [`test/integration/public-lifecycle.test.ts`](../test/integration/public-lifecycle.test.ts) and [`test/integration/x402-payment-lifecycle.test.ts`](../test/integration/x402-payment-lifecycle.test.ts). These exercise the contract without live funds or production callbacks.
