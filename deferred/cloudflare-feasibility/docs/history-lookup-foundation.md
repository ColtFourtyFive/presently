# Durable history lookup foundation

Migration `0017_history_lookup.sql` and `worker/history-lookup.ts` add the durable metadata needed before attendance can move out of D1. This is a local prerequisite. It does not enable archive eviction, change attendance reads or retry responses, or establish production readiness.

## What the database now preserves

- `history_request_keys` reserves each event, correction, and standalone audit request ID globally. The original center and stored payload hash remain immutable. Hash encoding describes representation only; `legacy-unverified` explicitly makes no claim about payload canonicalization. Existing standard base64 hashes, hex hashes, URL-safe hashes, and opaque fixture/legacy values are preserved exactly.
- `history_visit_heads` mirrors effective visit intervals, original timestamps, version and review status. Triggers follow every visit update, including review resolution without a version increment. Source visit identity cannot change, and a retained head prevents reusing its visit ID.
- `history_record_locations` is reserved for future verified archive locations. It stays empty and rejects activation in this migration.
- `history_runtime` and four `history_backfill_jobs` track a recovery generation and per-source progress. `ready` means this shadow backfill completed, not that archive deletion is safe or that the installation can go live.

Physical audit aliases are preserved even when older aliases disagree with their event or correction, including a different center. The immutable event or correction owns the request ID. Only audits with no event or correction using that ID receive standalone reservations.

Keys reject updates, deletes and replacement. Source retry guards preserve ignored duplicate requests while rejecting physical `INSERT OR REPLACE`, including before backfill reaches an old source row. Visit deletion remains disabled. Existing event, correction, overlap, backup and archive guards continue to apply.

## Bounded backfill and restoration

`advanceHistoryBackfill(db, pageSize)` processes one explicit primary-key page, with a default of 100 and a hard maximum of 500. It transfers only IDs between the read and write steps. Each write batch reads current source values, creates missing projections, verifies the selected projections, and advances the cursor atomically. Existing projections are never replaced with an earlier JavaScript snapshot.

The batch checks the recovery generation, source cursor and processed count. A stale concurrent call rolls back entirely. Live triggers capture new records even when their IDs fall behind a cursor. A backup maintenance lock pauses backfill without advancing progress. Any mismatched key or head fails the page and prevents readiness.

All five tables participate in backup counts and write barriers. Recovery preserves the authoritative keys, heads and locations, rotates the generation, and resets all backfill jobs for reconciliation. The operational restore process must still keep the restored Worker disabled until identity, hold, archive and other recovery checks pass.

## Limits and next work

The [permanent retry resolver](history-request-resolution.md) now distinguishes unused IDs from accepted keys with unavailable evidence and returns original accepted results from live sources. Migration 18 adds [private authenticated archive staging](archive-semantic-store.md). Exact R2 replay, resumable semantic verification, historical interval enforcement, publication/addenda, archive-aware reports/corrections, holds and deletion fences remain separate work. Combined restoration without original source rows must pass before enabling eviction. See the [current schema 18 checkpoint](archive-staging-checkpoint-2026-09-16.md).

This metadata has a storage cost. It preserves retry ownership and intervals after detailed records eventually leave D1; an archive design cannot discard those guarantees merely to minimize the live file. Local scale measurements are recorded separately and are not deployed Worker CPU or remote D1 space-reclamation evidence.

## September 16 local measurement

The final populated rehearsal applied migrations 7–17 to the original one-center fixture under a maintenance lock. It preserved all original source fields, 120,940 logical audits and 120,000 accepted receipts. Integrity and foreign-key checks passed. Migration took 12.8 seconds on the local machine; after local VACUUM, the file measured 133,681,152 bytes before the history backfill.

The bounded backfill then completed in 365 calls of at most 500 records, taking 5.93 seconds in a local SQLite adapter. It reserved 120,940 request IDs, mirrored 60,000 visits, and left archive locations empty. Source-row fingerprints remained identical. Query plans use the selected JSON ID list and primary-key searches, rather than scanning an entire source table for each page.

After local VACUUM and database closure, the file measured 174,981,120 bytes. This includes about 15.02 MB for request keys, 12.95 MB for visit heads, and 13.34 MB for the two interval indexes. The durable metadata adds about 41.3 MB to the compacted fixture. These are decimal megabytes. No detailed attendance was removed, and this result does not justify a paid-plan change.

Evidence: `tests/full-release-migration-results-17-final.json` and `tests/history-lookup-scale-results-17-final.json`. The earlier unsuffixed 0017 measurements preceded the final visit guards; the `-final` files identify the final migration hashes. Native workerd/D1 tests separately cover trigger semantics, concurrent pages, recovery resets, immutable ownership and rejected replacement. The scale adapter measures SQLite storage and local wall time only.
