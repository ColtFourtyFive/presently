# Next checkpoint: monthly publication and exact receipt resolution

Design review, September 16, 2026. This document proposes a bounded internal checkpoint; it does not activate a route, publish evidence, or permit deletion.

The next slice should turn a completed schema19 proof into a durable, independently recoverable publication and resolve one accepted event or correction from that publication. Keep live visits, current reports, overlap checks, and all source-deletion guards authoritative and unchanged. A publication certifies a captured historical snapshot; it does not make that snapshot the latest visit or review state.

## Supported profile and existing gaps

Accept exactly one authenticated v2 monthly manifest, no references, a completed run at the supported validator version, and the exact frozen session token/hash in the current history generation. A `sessions.status='verified'` row from the older `finalize()` method is insufficient. Keep v1 copies, addenda, unsupported fingerprints, and future standalone observation corrections outside this checkpoint. The v2 verifier currently supports standard base64 and its explicitly declared lowercase-hex alternative; the broader legacy retry hash compatibility is not permission to publish unsupported evidence.

The relevant gaps are concrete:

- `history_record_locations` in migration0017 has only kind, ID, center, archive ID, and manifest hash; inserts/updates remain disabled. It cannot select or authenticate an exact row yet.
- Schema19 and its staging records are private and disposable. Cleanup can remove them after invalidation, so durable publication metadata must not depend on their continued existence.
- The operational `archive.ts` producer still emits v1. A future v2 producer must capture the semantic profile and device context and complete the new proof; changing a format label cannot upgrade an old copy.
- `archive-reader.ts` accepts v1 copies and checks retained live rows. It is not the post-publication resolver.
- `backup.ts` still pins completed `archive_jobs` only. Offline v2 graph verification now has a private SQLite semantic store, but durable publication dependency pinning and restored publication/index reconciliation remain unfinished.

## Durable authority and locator contract

Use a forward migration; do not alter old migration meanings or reinterpret a v1 completed copy. Proposed objects:

| Object | Required contents and invariant |
| --- | --- |
| Publication build | Candidate publication ID, captured runtime generation, source verification/run IDs, frozen token, graph hash, validator version, immutable root reference/header digest, state, lease/revision, bounded cursors and exact completed counters. No public authority. |
| Published descriptor | Immutable publication ID, center/month/timezone and period, archive ID, exact manifest object key/hash, format/schema/validator versions, table counts, proof provenance, publication time, and locator-set digest/count. Inserted only by the terminal guarded transaction. It survives staging cleanup. |
| Publication record index | One immutable locator per `(publication_id, table_name, record_key)`, with center, part index, descriptor hash, row hash and row byte length. Index by publication/table/key. Captured mutable profiles, visits and reviews remain versioned by publication; their keys do not imply current authority. |
| Permanent request locator | One current immutable-evidence location per permanent event/correction request ID, bound to its existing global registry owner and source kind. It references the publication record index. An audit derived from that source is an alias, not another owner. |
| Availability state | Publication ID plus the runtime generation in which its complete evidence and indexes were reconciled. Missing/current-generation-unready availability fails closed. This is a recoverable projection, separate from immutable publication provenance. |

Extend or replace the disabled location foundation with these explicit relationships. Do not place names, receipts, credentials, or reason text in the permanent registry. Keep its existing fingerprint and canonicalization declarations byte-for-byte.

Locator candidates are built in bounded pages and are invisible unless joined to a committed published descriptor and current-generation availability. Reserve each permanent request locator during its candidate page to prevent competing builds from claiming it. An existing committed locator may be reused only after exact owner/type/evidence-hash equality; it must never be silently replaced. Abandoned unpublished claims need bounded fenced cleanup. Published descriptor/index rows cannot be deleted by staging cleanup.

A part index plus exact table/key is sufficient: authenticate one bounded part and search its maximum of 256 records. An optional ordinal is only a hint and must be checked. Never treat R2 object names, `archive_members` rows, or a caller-provided checksum as proof by themselves.

## Bounded publication protocol

1. **Admit and bind.** Require `history_runtime.state='ready'`, the supported completed schema19 run, current generation, exact token/hash, and the single-base profile. Store immutable build identity. Apply the separately measured staging/storage/concurrency admission policy.
2. **Read back and index.** Process one encrypted R2 part per step, within existing format byte limits; authenticate its descriptor and contents against the captured manifest. Compare it with the exact immutable staged part checkpoint/rowset. Derive locator hashes using the existing `SHA-256(TextEncoder(JSON.stringify(record)))` convention, not a new canonicalization. Do not retrieve all records or parts in one call.
3. **Reconcile permanent evidence.** In bounded record pages, compare each staged event/correction with its existing registry owner/type/fingerprint and the complete immutable live source projection, including the original sealed receipt. Fingerprint equality alone does not prove receipt, actor, timestamp or provenance equality. Check source-audit equality too. Do not rebuild receipts from current profiles or visits. Enforce publication membership: linked evidence belongs to the visit's original-arrival month; unmatched observations use their original observed month. Unsupported membership stays live.
4. **Checkpoint atomically.** Commit each validated page's locator candidates, ownership claims, exact counts and next cursor in one D1 batch. Assert build revision/lease, current generation, completed run, frozen token/hash, and backup barrier before any writes. Derive counters from accepted work; a terminal caller cursor is never publication authority.
5. **Commit visibility.** After every table and part reaches explicit EOF/count checks, insert the immutable published descriptor and mark availability ready in one guarded transaction. This single commit makes previously prepared locators visible; it must not insert an entire month's locators in one batch. Record a durable publication receipt with the locator-set digest and totals. No source rows are deleted, and live visit heads retain `residency='live'`.

Use a bounded ordered digest chain over locator pages to bind the final set without rereading it wholesale. A candidate head for the center/month may prevent competing initial bases, but it is not a latest-effective-visit head. After successful publication, discard/clean private staging in bounded FK order. Cleanup must preserve the completed descriptor, locators, availability record, R2 objects and permanent request ownership.

Keep publication advancement within 40 measured D1 statements, including reserve for commit/failure handling, with explicit decoded-byte and part bounds. R2 readback and hashing need real workerd CPU measurements; format maxima alone are not a deployment budget.

## Exact request resolver

Extend `resolveHistoryRequest` with an internal archive reader dependency, preserving its ownership-first ordering:

1. In one D1 snapshot, read the permanent key, live source/owner, current runtime generation, and any committed locator/availability. Preserve foreign-center/type nondisclosure. A changed payload returns 409 even if R2 is unavailable. Only a genuinely unowned ID may proceed toward insertion.
2. Prefer consistent retained live evidence. Otherwise require a committed current-generation locator; a pending locator is not a fallback. Fetch and authenticate exactly the pinned manifest and selected part, then find exactly one matching table/key and verify descriptor/row hashes, owner, center, source kind and original fingerprint.
3. Reuse the existing sealed-receipt decoder and correction response construction. Preserve tuple/object receipts and the literal JSON string `"null"` for unmatched exceptional departures. Do not substitute current student names, review status or visit values.
4. Before returning an R2 result, recheck generation, publication availability, permanent key and selected locator identity. A restore or authority change during object reads returns 503. Missing, corrupt, unsupported or inconsistent evidence returns `HISTORY_EVIDENCE_UNAVAILABLE`, never null, an empty-history success, or insertion permission.

The lookup uses permanent IDs, never a user-supplied date, month search, R2 listing, whole-graph verification, or a scan of all locators. It may authenticate one manifest and one bounded part per request; document that cost and measure it. The authenticated publication proof supplies the already-checked relationship closure. No external route is required for this checkpoint.

## Backup, restore and release gates

Add every durable publication/build/index/claim/availability table to maintenance triggers, backup inventories and count reconciliation. Under the existing SQL snapshot barrier, pin the union of v1 completed-copy references and all committed publication references. Deduplicate by archive identity plus hash and reject conflicting identities. Publication commits must be blocked during that barrier; later object reads use the pinned immutable reference set.

Before enabling the resolver, extend independent combined recovery to authenticate every pinned v2 base in private indexed staging and run semantic verification without the live application database. Recompute locator hashes/counts/digest and reconcile registry ownership against restored SQL. Missing keys, locators, manifests or parts must prevent cutover. Restore invalidates unfinished builds, claims and sessions, clears leases, and retains their original generation. Preserve published proof provenance; require a new-generation availability reconciliation instead of relabeling an old verification run. Keep the Worker disabled until that reconciliation and the existing identity/access reset complete.

Required acceptance evidence: identical receipt/correction results through live and R2 resolution after rename/later correction; bounded reads with thousands of unrelated locators; wrong-owner/hash/part and sealed-null cases; publication interruption/lost-response/retry; competing builds; backup-lock, cleanup and restore races; and an independent SQL-plus-R2 recovery drill resolving historical requests with live source detail absent in an isolated restored fixture. Keep the deployment gate off until that drill passes.

This checkpoint still does not provide addendum publication, current historical visit authority, archive-aware reports, historical corrections, safe source eviction, or retention expiry. Those require a later coordinated change to projections, holds, report epochs, mutation guards and recovery.
