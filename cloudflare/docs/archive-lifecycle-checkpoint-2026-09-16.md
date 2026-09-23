# Archive lifecycle checkpoint

September 16, 2026. Application `0.1.0`, local schema 21. Production release remains pending.

The integrated suite passed **371 tests across 35 files** in **128.53 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `9865fb6373458a99b8de511b0b5c4b0000e2a76e330c968bf6fb24a2bf5cb00f` covers 201 files and remained unchanged throughout validation. The [checkpoint manifest](../tmp/lifecycle21-checkpoint-evidence-20260916.json) records artifact hashes. Historical schema 19 and 20 checkpoint artifacts remain unchanged.

This extends the [schema 20 admission checkpoint](archive-admission-checkpoint-2026-09-16.md) with lifecycle bookkeeping. It does not enable scheduling, archive publication, operational R2 replay or source deletion.

## Implemented lifecycle tracking

SQL triggers record new manifest and part checkpoints, committed runner progress, first verification and invalidation atomically with the associated work. Retries, claims, releases without progress and repeated completion reads do not refresh liveness. First verification and original admission remain preserved. Unknown legacy progress times remain null, with explicit migration grace.

Read-only helpers inspect an exact session or select one indexed due candidate. These reads grant no cleanup authority. Final guarded session deletion removes lifecycle metadata in the same statement. The additional bookkeeping deletion counts toward database writes even though the returned outer deletion count excludes it.

Six focused native tests cover real progress versus retries, part and runner rollback, first-verification preservation, immutable fields, maintenance, legacy migration and atomic cleanup. Review found a nullable SQL guard edge on legacy verified rows. The final migration explicitly rejects an indeterminate update predicate, and the regression test verifies that malformed deadline edits fail after maintenance ends. See the [lifecycle module](archive-staging-lifecycle.md).

The backup inventory includes lifecycle metadata. Encrypted independent SQL restoration preserves it exactly. Repeated access resets invalidate execution authority while preserving original generation, progress and first-verification evidence. Existing reset SQL works through the invalidation trigger. All 29 backup/recovery tests passed separately and in the integrated suite.

## Migration and retained history

Final migration evidence pins SHA256 `ccbfa40ceb6a7c12ffd269cfb4bbab7ded626d5306c37c11ede63bbf50b118b0`. Earlier runs against the withdrawn guard were retained as provisional evidence and are not the final migration results.

| Rehearsal | Final local evidence |
| --- | --- |
| Empty native schema 4 to 21 | 82.990 ms; maintenance, integrity and deliberate rollback checks passed |
| Populated synthetic schema 6 to 21 | 4.410 seconds; all original fields, 120,940 logical audits and 120,000 accepted receipts preserved |
| Size after migration and local VACUUM | 133,804,032 bytes |
| History backfill | 365 calls, at most 500 records; 120,940 request keys, 60,000 visit heads and zero archive locations |
| Size after backfill and local VACUUM | **175,104,000 bytes** |

The three final schema 21 migration/backfill JSON files are included in the checkpoint manifest. No source history was evicted.

## Full native local D1 lifecycle

The same authenticated 14,295-record monthly fixture completed staging, 16,860 verifier advances and 350 cleanup calls. Every statement returned native row and size metadata; no batch failed. Verification produced one lifecycle row, 5,125 operation references, 2,550 visit totals and two witnesses. The destination contained no source attendance, correction or visit records. Cleanup removed every private row.

| Phase | Native rows written |
| --- | ---: |
| Staging parts | 57,404 |
| Runner advances | 99,680 |
| Cleanup | 22,032 |
| Other lifecycle statements | 13 |
| **Entire lifecycle** | **179,129** |

The run reported **2,361,868 rows read across 295,724 statements**. Each verifier advance stayed at or below 26 prepared statements. Cleanup returned at most 64 staged/proof deletions per call, with the final lifecycle-row deletion counted separately in native write metadata.

The isolated database reported `size_after` of 696,320 bytes initially, a peak of 41,385,984 bytes and 696,320 bytes after cleanup. These local D1 observations do not prove remote storage reclamation. Local workerd elapsed time was 92.897 seconds; it is not deployed Worker CPU. The measurement executes the loop inside one local request to avoid host connection exhaustion and does not claim one production request can process a full month. See the [native usage evidence](../tmp/native-month-d1-usage21/measurement.json).

The lifecycle writes exceed the documented Free-plan allowance of 100,000 daily writes before ordinary application and shared-account headroom. Unattended work must therefore pause and resume under explicit daily background budgets. The 33,841-write increase over the schema 20 measurement is included in this result. No paid upgrade has been requested or applied.

The [mixed boundary supplement](archive-mixed-boundary-2026-09-16.md) also passed at exactly 20,000 records and 16 MiB using pinned schema 20 code. It combined unchanged native attendance with long-identifier context records and added 84,791,296 allocated bytes. That measurement supplements the earlier long-context boundary; it does not establish schema 21's complete worst-case allocation or deployed capacity. The 128 MiB planning allowance remains provisional.

## Next work and external gates

Implement deliberate pauses and renewal, conditional expiry, cleanup leases, retained diagnostics, daily budget reservations and failure alerts. Test progress versus expiry, interrupted cleanup, lease takeover, restore, maintenance and UTC-day boundaries before scheduling work.

Then complete immutable publication, exact R2 receipt resolution and independent published-v2 restoration without original source rows. Historical interval authority, archive-aware reports/corrections, addenda, holds and removal fences must precede source eviction. Unmatched exceptional-departure time correction remains a separate unfinished feature.

Live backup delivery and independent populated cloud restoration, deployed capacity, physical iPad/staff acceptance and customer-owned handover remain open. No live deployment, migration, upload, data mutation or paid upgrade occurred. The last verified Cloudflare installation remains empty on schema 1–4, with automatic backups disabled and export-token approval pending. Railway remains available. The production-readiness goal stays active.
