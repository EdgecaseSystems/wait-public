# Architecture and trust boundaries

## Durable facts and race winners

Request identity, payment outcome, wait entitlement, accepted event, Workflow provisioning, and callback delivery are distinct facts. D1 conditional writes determine the winning transition. A retried HTTP request cannot implicitly create another paid entitlement or change which event won.

Idle waits live in D1. The first accepted event records `delivery-{wait_id}` as a stable delivery identity. Provisioning uses that identity with `createBatch`; Workflow parameters contain the wait identifier, not event content. The short Workflow reads the accepted event from D1 and manages delivery attempts. It does not establish payment truth or select the winning event.

## Payment ambiguity

The x402 adapter validates exact protocol terms and proof binding before attempting settlement. It does not blindly retry a possibly transmitted settlement. A definite rejection creates no entitlement; an acceptance creates one. Under the illustrated one-cent policy, a qualifying irrecoverable post-boundary ambiguity may honor one entitlement while payment truth remains ambiguous. A cumulative fuse bounds that exposure and closes new sales when necessary.

Turning off new sales does not erase obligations already purchased. Separate callback controls can pause later attempts. The snapshot includes the corresponding D1 schema and mocked lifecycle tests, but omits live control values and incident records.

## Capability and callback boundaries

Event and status URLs are bearer credentials for separate purposes. Capability generation is domain-separated and recovery selects the secret solely by the persisted key version. A missing V1 secret must not be replaced with V2, or vice versa.

Callback destinations must use public HTTPS DNS names and the permitted port. Syntax checks reject credential-bearing URLs, fragments, and prohibited host forms. The persisted destination is revalidated before every attempt; redirects are not followed. `global_fetch_strictly_public` is retained as the ordinary global-fetch network boundary. This statement does not cover private service bindings, VPC paths, or raw sockets.

Delivery is bounded at-least-once. A receiver must authenticate the callback token and deduplicate by `wait_id` before causing its own external effects. Network timeouts can occur after a receiver acted, so a retry cannot promise exactly-once execution at the destination.

## Retention and observability

Event content is eligible for removal 72 hours after a resolved terminal state; wait metadata/status and exact creation replay have separate 30-day windows. Payment evidence is separate again. Cleanup progress and safety markers make deletion resumable. Unresolved obligations and their evidence must not be mistaken for ordinary expired content.

Workflow state is content-minimized. Automatic invocation logs and traces are disabled because URLs may carry bearer capabilities. Custom telemetry restricts fields to bounded state and timing metadata. Raw capability URLs, callback tokens, payment proofs, and event bodies do not belong in logs.

## What the portfolio changes

Only identifiers, sample configuration, discovery claims, contact details, packaging, and documentation are adapted for publication. The payment recipient in configuration is deliberately invalid; a separate synthetic test constant keeps mocked mainnet validation testable. Production secrets, database identity, payment recipient, incident records, monitoring jobs, and deployment access are omitted. The application state machines and callback protections remain visible for review.
