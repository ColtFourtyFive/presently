# Invalid publication candidate cleanup proposal

Design only, September 16, 2026. This is a proposed checkpoint after schema26, not implemented cleanup authority. It changes no migration, source, test, live data, deployment, scheduler, endpoint, or R2 object. The schema26 verification run remains frozen.

## Problem and existing safeguards

An invalid `archive_publication_builds` row no longer occupies the partial unique index on center/month. However, its `archive_publication_requests.request_id` claims remain globally unique. A replacement candidate can start and then fail when it reaches one of those claims. Schema25 deliberately retains all candidate children and prohibits their deletion.

The foreign-key order is requests → records → parts → build. Requests also reference the permanent `history_request_keys` registry. Committed descriptors reference their retained build; reconciliation jobs and receipts reference committed descriptors. Schema26 already supplies a publication/request-ID index suitable for bounded claim scans.

A new forward migration would need to replace only the three unconditional child `no_delete` guards with guarded abandonment exceptions. Preserve the build's `no_delete` guard, its immutable invalid state, all child update/insert protections, all maintenance guards, and every committed publication, availability, reconciliation, and registry protection. Do not edit migrations25/26, use cascading deletion, disable foreign keys, or grant a generic delete capability.

## Eligibility and scope

The unit of cleanup is one exact publication ID that was invalidated before publication. Require all of the following at admission and again inside every destructive transaction:

1. The retained build exists, has `state='invalid'`, has no writer lease, and exactly matches its pinned original revision, proof generation, root/header, archive/center/month, progress counters, locator digest, and timestamps. Pin a fixed projection and its hash, with a 128 KiB encoded limit. Never relabel or edit that build.
2. No descriptor, availability row, reconciliation job, or reconciliation receipt references this publication ID. Check each authority table explicitly, even where foreign keys normally make a contradiction impossible. A committed build with a missing descriptor is ineligible.
3. A cleanup job has a live native-clock lease, the caller's exact token and expected revision, and the current `history_runtime.generation`; history is `ready` and backup maintenance is inactive.
4. The selected rows belong to this exact publication ID and the job's current bounded page. No request-ID-only deletion is permitted.

Within schema25's enforced state machine, `invalid` can follow `building`; `published` cannot become `invalid`. This retained state transition, plus absence of committed references, supplies the never-published predicate. A missing descriptor alone, a failed legacy archive job, age, an expired semantic proof, or an unavailable archive does not.

Cleanup does not revive the original semantic run or require R2 access or live source rows. It removes only unpublished SQL children after checking retained SQL authority.

An unrelated committed publication may coexist. Its publication ID, catalog rows, availability, receipts, and object references cannot enter this cleanup's selected keys. A successfully published candidate remains ineligible even if its live source rows, old private staging, or R2 objects are absent.

Keep `history_request_keys` unchanged. Removing an abandoned claim releases only its association with a failed candidate. It does not free the accepted request identity, change its owner/hash/canonicalization, permit a new live request with the same ID, or create archive lookup authority. Keep `history_record_locations`, visit heads, live operational tables, and R2 untouched.

## Durable control contract

Propose an internal abandonment job plus an immutable diagnostic/receipt ledger, with no foreign key to disposable semantic staging.

| Record | Required contents |
| --- | --- |
| Job | Unique publication ID; immutable cleanup ID, original build projection/hash and admission reason; admission generation; execution generation; state, revision, lease token/expiry; bounded inventory/deletion phase and cursors; at most eight selected keys; observed/removed counts; diagnostic digest; native timestamps. |
| Diagnostics | Immutable admission, explicit generation rebind, and completion events with cleanup/publication IDs, original build hash, execution generation, revision, bounded reason/result JSON, counts/digests, and native time. Completion has a unique cleanup ID. Persist no raw lease token. |

Use a 30-second lease, eight rows per advance, a bounded metadata byte limit, and a complete invocation ceiling of 40 statements. Exact JSON keys/types, safe integer bounds, phase order, immutable pins, revision increments, and alternate-unique-key replacement rejection belong in SQL guards as well as code. Claiming and checkpointing each increment revision. Terminal jobs and diagnostics are immutable.

A bounded inventory pass precedes the first deletion. Walk the candidate's claims, records, and parts through their indexes; validate present row identity, supported bounds, foreign-key relationships, claim/record equality, and exact permanent-registry ownership. Cap inventory at 20,000 records/claims and 512 parts. Capture actual totals rather than treating the build's planned record count as the number to delete. Its progress counters describe the original build and remain unchanged.

Saved cleanup progress must explain differences between original admitted inventory and remaining children after an interrupted cleanup. Missing job metadata, unexpected missing rows, orphaned children, a missing registry owner, malformed pins, conflicting permanent ownership, or counts outside the supported profile block cleanup. Record a bounded diagnostic through a separate non-destructive path; do not reconstruct authority from children or silently reset counters. A deliberately empty never-published candidate can complete after the same bounded absence checks.

## Bounded deletion and atomic checkpoints

Use three destructive phases, each followed by an explicit EOF checkpoint:

1. Delete claims ordered by request ID using `archive_publication_requests_publication_request` and the exact publication ID.
2. After an indexed claim-absence check, delete locators ordered by `(part_index,part_offset)` using the existing unique ordinal index. The permanent registry is never a delete target.
3. After indexed claim and locator absence checks, delete part rows ordered by part index using their primary key.

Always retain the build. Do not adjust its `indexed_count`, `request_count`, part counts, digest, or original proof to resemble an empty candidate. Cleanup completion belongs in its own receipt.

Select at most eight exact keys under the job's fenced claim, and pin that bounded selection in the job. Child delete triggers must require membership in this selection in addition to the current lease and never-published predicate. This prevents a broad `DELETE` from becoming authorized merely because a cleanup lease exists. Use explicit key comparisons and the publication ID; do not rely on a nullable or free-form SQL cursor.

Each native page transaction must recheck eligibility, delete exactly its selected rows, check the deletion count inside SQL, update the job's cursor/counts/digest with the exact owned revision/token, and assert that the checkpoint changed one row. A zero-row conditional checkpoint must abort all preceding deletions. A JavaScript check after `batch` cannot provide that rollback. EOF advances only the phase and revision, without an unbounded aggregate query.

Finalization checks all three child catalogs are empty through indexed `NOT EXISTS`, repeats the never-published and current-generation fences, completes the job, and inserts its immutable completion diagnostic in one native transaction with a final assertion. Saved revision/result resolves lost responses; replay does not delete another page or mint another receipt. Inventory hashes and removal counts are diagnostic evidence, not substitutes for current SQL authority.

Start the intended replacement with a new publication ID after successful completion and fresh supported publication proof. Never reuse or revive the invalid build. Correctness must also tolerate a competing replacement: every old cleanup delete remains scoped to the old publication ID, so a newly claimed request with the same request ID but a different publication ID cannot be removed. Existing active-month and global-request uniqueness protections continue to reject conflicting writers.

## Restore, maintenance, and missing metadata

A generation reset clears unfinished cleanup leases and pauses the jobs while preserving original pins, previous execution generation, deletion progress, and diagnostics. Completed receipts remain historical facts, not current deletion capabilities. The original build's proof generation never changes.

Resume requires an explicit internal operation after restoration reconciliation. Under a new current-generation claim, recheck the immutable build and every committed-authority exclusion, validate the saved progress against a bounded inventory of remaining children, and record an immutable generation-rebind diagnostic before further deletion. Only then may the operational job's execution generation change. Do not automatically resume copied leases or infer a successful cleanup from an absent row. A reset between page selection and deletion makes the old token/revision/generation unusable; atomic page rollback prevents partial progress within that transaction.

A backup taken between pages must contain matching children, cleanup progress, and diagnostics. Extend `BACKUP_TABLES` and offline restore count validation for the new metadata; add maintenance guards for every new table and keep the existing three child-table guards. Retain the four-statement backup inventory transaction and verify native statement limits. Test a partially completed cleanup backup, not only empty metadata tables.

The pinned build root remains diagnostic provenance. Cleanup must neither add that uncommitted root to the committed archive inventory nor remove objects or committed archive references. If an independent policy later requires retaining abandoned evidence files, that is a separate inventory/retention decision.

A build or authoritative cleanup ledger missing from restored SQL is a repair problem, not permission to delete orphaned rows. Contradictory committed metadata, a corrupted build state, or an incomplete recovery inventory also blocks automation. Resolve those cases in an isolated recovery process; this API must have no force option.

## Acceptance tests before implementation is accepted

- Invalidate candidates at zero progress, a partial part, several completed parts, and immediately before publication. Clean in bounded pages, preserve the byte-for-byte build and permanent registry, then publish a fresh replacement with the same supported evidence/request identities.
- Reject building/published builds, missing build or ledger, mismatched pins, unsupported bounds, missing/wrong registry owners, orphaned children, and every contradictory descriptor/availability/reconciliation reference. Verify no R2 get/put/delete occurs.
- Reject broad deletion outside the selected eight keys, wrong phase, skipping child EOF, replayed selections, stale revisions/tokens, expired leases, application-supplied time, malformed cursors, and `INSERT OR REPLACE` through any alternate unique key.
- Inject failures and lost replies before/after each page and terminal commit, including a forced zero-row final checkpoint. Either both deletions and saved progress commit, or neither does. Replays return the exact saved result.
- Reset during selection and immediately before deletion; exercise repeated restore, copied leases, mid-cleanup backups, missing cleanup metadata, and explicit resume. Preserve prior generation diagnostics and never change original build provenance.
- Run simultaneous replacement attempts and cleanup. New publication claims, committed descriptors, availability and receipts remain unchanged; failed cleanup never frees permanent request ownership.
- Verify backup maintenance blocks all mutations, foreign keys remain enabled, cleanup uses reverse foreign-key order, unrelated large catalog populations do not change page cost, and every page meets row/byte/statement bounds with native query-plan and usage evidence.
- Rehearse forward migration on empty, invalid-candidate, partially indexed, and committed/reconciled fixtures; rehearse restoring the pre-migration backup. Rollback after cleanup must restore the coherent backup, not recreate deleted claims from hashes or simply drop the new tables.

This proposal releases failed candidate claims only. It does not implement source eviction, committed catalog repair, stale R2 object deletion, retention scheduling, public controls, or production activation.
