# Post-publication validation

This portfolio repository began as a sanitized snapshot published on 2026-09-07. The production Wait service continued to be exercised afterward. This note records only non-secret evidence that materially changes how the work sample should be interpreted; it intentionally omits wallet identifiers, capability URLs, callback tokens, receiver-specific URLs, payment proofs, credentials, and private operational records.

## 2026-09-10 Base-mainnet cold audits

Two separately approved one-cent Base-mainnet production audits exercised the Wait lifecycle through an iPhone Base App handoff. In each run:

- an unsigned create request negotiated payment with HTTP 402 before wallet approval;
- the buyer approved exactly one payment authorization;
- the service reported successful paid wait creation;
- the first event was accepted;
- a disposable public HTTPS receiver observed one callback from the Wait Worker.

In the second run, the receiver observed the callback about five seconds after event acceptance, consistent with first-attempt delivery. The first run also ultimately showed one delivered callback after an initially stale receiver dashboard view.

These audits provide live evidence for the product path described by the public snapshot: payment-gated creation, durable event acceptance, and bounded callback delivery. They do not change the repository's publication boundary or make this snapshot a production configuration.

## Publication boundary

No wallet secrets, payment signatures, event/status capabilities, callback tokens, receiver URLs, production database records, or deployment credentials are included here. The public repository remains an isolated portfolio work sample whose external effects are mocked during its own CI validation.
