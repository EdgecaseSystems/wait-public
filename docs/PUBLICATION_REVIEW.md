# Portfolio publication review

Prepared September 7, 2026. Scope: privacy, secret exposure, publication packaging, and preservation of the useful implementation. This is not a comprehensive vulnerability audit or a certification of live-service security.

## Export policy

The public repository is a fresh snapshot, not a fork or a branch of the private repository. No original Git objects, commit metadata, branches, tags, issues, CI logs, database contents, or ignored local files were imported.

Included: application TypeScript, SQL migrations, canonical OpenAPI and discovery implementation, payment and callback logic, capability-version handling, unit tests, and Workers-runtime integration tests.

Excluded: operator runbooks, account/deployment setup, incident and payment records, historical audits and internal research, production monitoring/email scripts and workflows, and tests dedicated to those excluded tools. Public documentation was written for this snapshot instead of copying internal operational notes.

Production domains, support email, D1 identity, and the receiving wallet were removed from configuration, source constants, and tests. The configured zero payment recipient is invalid; the separate adapter test recipient is explicitly synthetic. Public protocol contract addresses remain. Worker/Workflow/database names are distinct portfolio names. Public previews/workers.dev publication are disabled; invocation logs and traces remain disabled. Generated types were regenerated. Historical directory-listing claims were replaced with explicitly unverified example metadata and `global_listing: false`.

## Review method

- Inventory every publication file, including dotfiles, lockfiles, tests, configuration, and generated bindings.
- Check original database/payment identifiers, production domains and escaped variants, personal paths, contact addresses, credential files, and common secret patterns.
- Review remaining URLs, wallet-like values, UUIDs, and cryptographic test fixtures in context. Protocol constants and synthetic test material are distinguished from operator credentials.
- Run Gitleaks against the exact publication candidate with redacted output; assess any matches before publishing.
- Check Markdown links, fresh root history, commit identity, the files actually staged, and preservation of private source state.

## Validation

The final targeted publication scan found no prohibited files, production identifiers, personal paths, or broken local documentation links. Gitleaks 8.30.1 reported ten generic-key matches, all synthetic UUID idempotency identifiers in tests. They were reviewed as test identifiers, not credentials. An opaque signing fixture was replaced with an ephemeral valid Ed25519 keypair generated inside the mocked test; its 25 focused tests and type checking passed after the change. No unresolved secret finding remained.

Local validation passed generated-type consistency, TypeScript checking, **178 unit tests across 23 files**, **47 Workers-runtime integration tests across 4 files**, and a Wrangler dry-run bundle. The runtime prints diagnostic exceptions for deliberately rejected callback destinations and disabled delivery in negative tests; those tests pass. No production payment, callback, deployment, or remote migration was performed. CI runs the offline gate; check GitHub Actions for the commit being reviewed.

## Rights and limitations

The project declares `UNLICENSED` and remains a private npm package to prevent accidental package publication. No open-source license is granted for original project material. Existing third-party license metadata and generated notices are preserved; see [NOTICE.md](../NOTICE.md).

Secret scanners cannot prove the absence of every possible disclosure. Mocked tests do not prove the cloud provider's live egress behavior. The public copy is an inspectable work sample and requires independent configuration and review before any operational use.
