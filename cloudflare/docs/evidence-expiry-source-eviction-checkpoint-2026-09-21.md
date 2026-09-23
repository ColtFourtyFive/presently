# Evidence expiry and source-eviction checkpoint

Date: 2026-09-21

Status: locally validated and promoted as schema 36. No Cloudflare deployment, remote migration, live-data mutation, Railway change, R2 deletion, or D1 source eviction occurred.

Schema 36 adds explicit evidence-expiry schedules and the transaction needed to remove live D1 attendance source after its encrypted R2 evidence has been independently checked. Every center starts with source eviction disabled. The release has no route that can enable it.

An expiry schedule can be created only from a completed retention dry run whose policy explicitly allows scheduling. The schedule is immutable and always records `delete_enabled=0`. Legal holds still block the schedule and any later eviction attempt.

Each visit now has a monotonic source revision. Visits, events, corrections, reviews, and linked audit changes advance that revision. A retention candidate records the revision and exact source and evidence digests. Immediately before eviction, the Worker reopens the authenticated R2 graph, checks the current history head, hold state, source revision, backup lock, and enabled policy revision, then creates a transaction-local capability. D1 deletes the exact recorded source rows, writes an immutable receipt, and removes the capability in one batch. A late receipt failure rolls the whole batch back. Event and correction retries continue to resolve from retained R2 evidence after the live rows are gone.

Recovery keeps expiry schedules, source revisions, retention-item revisions, disabled and historical policy revisions, and completed eviction receipts. The recovery reset disables any copied enabled policy, appends one immutable disabled revision, and proves that no transaction-local capability remains. Repeating the reset adds no further revision.

The active backup lock blocks expiry scheduling. If a backup begins after R2 verification but before eviction commits, the capability guard rejects the batch and every source row remains.

## Release inventory

- Schema-35 baseline: 308 release files, SHA-256 `efc66d6806e5a6321021c40824da0e05c636fba6decb24d97c03047a603adc04`.
- Schema-36 release: 311 release files, SHA-256 `cefd307918c6553325e671109734dc1a77fd74600ac206acb34fac830cb4b89f`.
- Added release files: migration `0036`, the source-eviction worker, and its test file.
- Changed release files: 21.
- Removed release files: none.
- Backup inventory increases from 86 to 92 tables.
- Full validation passed: 78 test files and 845 tests.
- Promoted-root focused validation passed: 5 test files and 63 tests.
- Candidate and promoted-root TypeScript, production build, Wrangler 4.100.0 dry run, fingerprint, and file parity checks passed.
- The promoted dry run packaged a 581.64 KiB upload, 127.80 KiB compressed.

Evidence is stored in `review/schema-36-evidence-expiry-source-eviction/` with individual SHA-256 values in `artifact-sha256.json`.

## Operational gate

This checkpoint authorizes local release-tree promotion only. Source eviction remains disabled until a populated cloud backup and independent restore pass, deployed capacity is measured, Kumon accepts the retention and hold procedure, and a separate reviewed release adds an explicit enablement process. R2 deletion remains disabled.
