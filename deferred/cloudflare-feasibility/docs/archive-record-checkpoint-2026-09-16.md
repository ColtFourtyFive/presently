# Exact archive record checkpoint

September 16, 2026. Application `0.1.0`, local schema 19. Production release remains pending.

The integrated suite passed **351 tests across 33 files** in **103.48 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `9416e0b2e10e84d8ea23e1e3c46145692baa6015da1c0e260954c249c86212d4` covers 186 files and remained unchanged throughout validation. [Checkpoint evidence](../tmp/record-evidence-checkpoint-evidence-20260916.json) records the artifact hashes. [Full results](../tmp/integrated-record-evidence-final-tests.json) and [test log](../tmp/integrated-record-evidence-final-tests.log) are retained.

This extends the [340-test resumable verifier checkpoint](archive-runner-checkpoint-2026-09-16.md) with an internal exact-record R2 loader. The database schema, source receipt resolver, client and previously verified migration/backfill behavior are unchanged. The source database still measures 175,075,328 bytes after backfill and local VACUUM, with no source eviction.

## Exact evidence loading

The new loader reads a pinned encrypted manifest and one indexed encrypted part. It checks the v2 monthly-base profile, center/month/timezone, compact header, descriptor, table/key, complete record bytes and hashes. It copies the locator before asynchronous work and bounds both reported R2 sizes and actual received bytes. Original receipt strings, null receipts and supported fingerprint representations remain unchanged. Failure returns a bounded error without storage or key details.

Eleven focused tests use native application-generated evidence and real local R2. They cover exact two-object access across multiple parts, missing/corrupt objects, wrong keys and scope, malformed locators, unsupported profiles, missing records, UTF-8 lengths, checksum conventions, caller mutation during reads, stream overflow and sanitized transport errors. Independent source review found no actionable defect in this internal loader.

The loader supplies evidence only. The application still needs an immutable publication ledger and exact request locators, source/registry reconciliation, a final generation/authority check after R2 reads, and independent v2 restoration. No route or operational R2 retry fallback is enabled. See the [loader contract](archive-record-evidence.md) and [publication design](archive-publication-design-review.md).

## Staging allocation measurements

The representative month contains 14,289 unchanged records and 9,176,652 bytes of record JSON. Loading those records into the private schema with normal UUID identifiers increased allocated local SQLite storage by **40,316,928 bytes**, to **215,392,256 bytes**. Cleanup removed the private rows in 227 calls of at most 64 deletions. Used pages returned to baseline, but the file remained allocated until local VACUUM.

This full-month fixture contains opaque synthetic request hashes that the codec rejects. Its measurement is therefore **storage only**, with minimal metadata and no runner-derived rows. It does not prove authentication, semantic success or complete monthly staging cost. A separate native 65-record fixture authenticated and verified successfully, adding 126,976 allocated bytes through runner completion. It cannot establish full-month derived overhead.

The [measurement evidence](../tmp/staging-storage-19/evidence.json) records both scopes and confirms the source fixture remained unchanged. The [admission plan](archive-staging-admission-plan.md) proposes one resident session, a 20,000-record and 16 MiB plaintext cap, conservative observed headroom and bounded cleanup. These limits are not yet implemented. Full-profile measurements and actual D1 daily reads/writes remain activation gates; local page allocation does not establish deployed CPU, billed storage or remote reclamation.

## Next work and external gates

Implement staging admission and bounded abandoned cleanup, then immutable publication and exact request lookup with independent D1/R2 restoration. Keep source rows until historical intervals, reports, corrections/addenda, holds and removal fences are verified. Unmatched exceptional-departure time correction remains a separate unfinished feature.

No live mutation, deployment, migration, upload or paid upgrade occurred. The last verified Cloudflare installation remains empty on schema 1–4. Export-token approval, scheduled Worker-to-R2 backups, failure alerts, populated cloud recovery, deployed capacity, physical iPad/staff acceptance and customer-owned handover remain open. Railway stays available and the delivery goal stays active.
