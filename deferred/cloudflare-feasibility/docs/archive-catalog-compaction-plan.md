# Archive catalog compaction plan

The [September 17 storage audit](archive-metadata-storage-audit-2026-09-17.md) established the original catalog cost. The [native retained checkpoint](archive-native-retained-checkpoint-2026-09-17.md) now validates schema 29 direct publication, restored reconciliation, exact receipt reads, and an 8,331,264-byte retained post-expiry database.

This plan does not authorize a remote migration or change the current published catalog. Existing receipt reads and retry responses keep their current behavior until each replacement passes its own compatibility and recovery checks.

## 1. Prove exact lookup through the manifest

Add a read-only evidence function that accepts a trusted published archive reference, expected scope and header hash, and a table/key. Authenticate the bounded manifest, select exactly one part through its ordered record-key bounds, verify that part, and return exactly one semantically valid record. Snapshot all supplied selection fields before the first await.

The function must fetch at most the manifest and the selected part. It must reject malformed references and paths before object I/O, and reject invalid scope, format, header, directory, record shape, size or cryptographic evidence. Missing records remain unavailable. The existing locator-based function remains compatible.

Publication proof, authorization, permanent request ownership and post-read generation/availability checks remain the caller's responsibility. A valid encrypted object alone does not establish current publication authority.

## 2. Specify and measure a compact catalog version — direct publication complete

Keep permanent request ownership for kind, center and accepted payload identity. Store only the information needed to select the owning publication. The existing manifest commits to part and record bytes, so duplicated per-record hashes, offsets and descriptor hashes need not be retained merely to authenticate an exact receipt.

The earlier two-column experiment was a lower bound. The accepted native run now includes the complete five-table/seven-index catalog at 868,352 bytes and schema 29 reconciliation job/receipt objects at 32,768 bytes.

Define the complete v2 state machine before writing a migration. In particular:

- Every request selected for archived receipt lookup must map to one immutable committed publication or a clearly private candidate. A live request does not require an archive mapping. Missing, conflicting or orphaned archive claims fail closed.
- Building, committing, aborting and cleaning a candidate must preserve ownership. Retries must not move a request to another archive.
- Commit must establish complete membership against the authenticated graph. Replacing the full locator table cannot replace this check with a count alone.
- Existing v1 catalogs remain readable until a validated conversion completes. Supported catalog versions must be explicit in readers, backup inventory, recovery and restore reconciliation.
- Conversion must be bounded, resumable and interruption-safe. Do not delete old catalog evidence until new ownership, selection and reconciliation evidence is complete.

This is a new catalog version and recovery contract. It is not a safe in-place deletion of the current locator rows.

Keep the existing v1 publication descriptor and its locator digest immutable when converting a published catalog. An additive conversion certificate can identify the compact representation without rewriting historical proof. It needs representation-specific availability and restore reconciliation: the existing reconciliation receipt foreign key and full catalog census apply only to v1. Existing abandoned-candidate cleanup also excludes committed publications and cannot authorize catalog retirement.

Schema 28 now builds the compact representation directly. It reuses the completed frozen semantic snapshot, proves exact source ownership and complete request membership through bounded native cursor transitions, preserves immutable audit-source checks, and commits the descriptor and availability atomically. The measured five-table/seven-index layout is 868,352 bytes for the representative 5,126-request month. See [the checkpoint](archive-compact-publication-checkpoint-2026-09-17.md).

## 3. Integrate and recover compact exact receipts — complete

Exercise archived GET and every existing POST retry path against both supported catalog versions. Preserve the original accepted response, including null visits. Changed payloads and foreign/kind conflicts must fail before R2 I/O. Missing storage or evidence must never permit duplicate insertion.

Require the returned event/correction ID, center, kind and payload hash to match permanent ownership, and validate the sealed event response. Recheck current generation, publication availability, permanent owner, selected request-to-publication map, catalog version, committed descriptor, reconciliation receipt identity and any live authority after asynchronous object reads. Test response-loss retries, concurrent transitions, interrupted conversion, candidate abandonment and restored-generation revocation. Restore a populated encrypted backup and its archive dependencies into an independent local installation before considering live validation.

The representative native run completed this measurement. Event and correction receipt lookups each used exactly two R2 GETs; the retained post-expiry database is 8,331,264 bytes locally. Remote D1 allocation and deployed CPU remain unmeasured.

## 4. Complete history before eviction

Exact receipt lookup does not solve a date/student range. Design authenticated search pages with complete coverage and stable cursors, or choose a measured compact D1 projection. Route on actual observation/correction timestamps, including events whose visit arrived in another month. Missing index or detail evidence must not produce a successful partial history or report.

Current visit/review selection needs a native mutation revision, validated snapshot selection and eventual explicit archived residency. Review resolution currently changes review status without incrementing visit version. Current names still come from live profile dimensions. Interval guards, historical corrections, review evidence, holds, addenda and their foreign keys must agree with the archived state.

Only then implement bounded source eviction. Prove net storage on the full representative dataset, preserve complete reports and exact retries, and validate recovery with operational source rows absent. Deployed CPU, daily quotas, background pacing, alerts and the release/handover gates remain separate requirements.
# Schema 28 reader completion — 2026-09-17

Direct compact catalogs are now readable by the shared event/correction receipt resolver. The reader keeps retained source precedence, requires one catalog representation, rejects payload and ownership conflicts before R2, performs exactly two encrypted object reads, and rechecks the full D1 snapshot afterward. The full 758-test regression passed at fingerprint `0cfecf51ad56d634447daa7eccaf7e12ef615b74df42b0e43c8f734a7daa63a0`.

Schema 29 compact reconciliation is complete. A fresh proof authenticates the original root, every archive record is checked in bounded pages, the reverse census rejects missing or extra mappings, and an immutable receipt binds restored authority to the current generation. The next slice is historical ranges/reports/current-visit authority, corrections, addenda, holds, and safe eviction.

## Schema 29 measurement result

The accepted native run completed 16,860 initial proof calls, 1,287 publication calls, 80 recovery-backfill calls, 16,860 fresh proof calls, and 2,430 reconciliation calls. The final receipt survived a test-only post-expiry snapshot without transient semantic proof rows; event and correction reads still resolved with two R2 GETs. The retained database is 8,331,264 bytes.

The run repaired one older-installation edge case: a same-ID audit alias no longer replaces an immutable event/correction owner after source detail is absent. The full repaired release passes 771/771 tests. Source eviction remains disabled until every range, report, current-visit, correction, addendum, and hold path has archive authority.

## Schema 29 range and report result

Bounded authenticated range reads are now integrated for attendance observations and report evidence. The history endpoint merges live and archived observations for an exact date range and optional student. Report correction, observation, and unmatched phases read archive records; later visit pages authenticate the manifest while using retained `history_visit_heads` rows. Every completed or empty response rechecks archive authority.

The representative source-free month used 32 of 48 allowed R2 reads on the largest measured request. The initial report authenticated 7,678 visit, event, correction, and review records and read 1,205,012 encrypted bytes. A visit-only page used 12 reads and 288,888 encrypted bytes. Date and optional-student visit history plus report visit phases now use retained heads and authenticated R2 detail, closing the read-only visit-detail portion of section 4.

Student-detail correction history remains open. Historical corrections need an authenticated addendum workflow. Holds, expiry scheduling, and the source-eviction transaction also remain unfinished, so eviction stays disabled.
