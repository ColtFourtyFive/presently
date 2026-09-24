# Resumable verification for v2 monthly bases

The monthly-base portion of this plan is implemented internally in schema 19. See [the implementation status and APIs](archive-semantic-runner.md). Publication remains disabled. The first runner accepts exactly one authenticated v2 monthly archive, with an empty `references` array. It rejects addenda and graphs containing additional manifests before creating a verification job. The existing full `verifyArchiveSemantics` function remains the independent verification oracle, including for its existing addendum support.

The runner uses schema 18's private, immutable staging snapshot. It does not publish archives, enable a reader or writer route, create historical record locations, or authorize source eviction.

## Proposed implementation boundary

Add `worker/archive-semantic-runner.ts` and a migration after schema 18. Extract shared validation rules into `worker/archive-semantic-rules.ts`; keep the public signature of `verifyArchiveSemantics` unchanged. Add native runner tests and differential tests that run the same authenticated records through both implementations.

The smallest useful slice includes all base-archive rules, interruption/resume, generation fencing, backup barriers, and cleanup of its private derived state. It does not include a partially complete production endpoint. Start and advance functions are internal calls until the complete publication and independent recovery paths have their own validation.

The runner's persistent state belongs to a specific verification ID, original history generation, snapshot commit token, graph hash, and validator version. A new application validator version cannot silently resume an old checkpoint.

## Data model

Names below are proposed for the next migration.

| Table | Contents and indexes |
| --- | --- |
| `archive_semantic_runs` | One job per immutable snapshot and validator version. Fixed archive ID, original generation, commit token, graph hash, compact semantic header, expected table counts, phase, revision, lease token/expiry, bounded cursor JSON, completed counters, error code, timestamps. Foreign key to the staging session. |
| `archive_semantic_operations` | Derived references to authenticated events and corrections with a non-null visit ID. Store request ID, source table/key, visit ID, decoded operation version, and original record byte count. Unique request ID within the run. Index `(run_id, visit_id, operation_version, request_id)`. Store references rather than another copy of receipts or plaintext rows. |
| `archive_semantic_visit_totals` | Unique operation count and byte sum per visit, computed while inserting operation references. Enforce the existing 2,048-operation and 4 MiB closure limits. This avoids repeatedly counting or scanning an entire visit before replay. |
| `archive_semantic_review_witnesses` | At most one exact qualifying resolution-audit witness per review. Store the review ID and authenticated audit record key. Primary key `(run_id, review_id)`. |

All derived rows remain private. Their authority requires a matching active job and snapshot token. They need backup-maintenance guards, generation checks, native backup inventory, recovery invalidation, and bounded cleanup. Do not create a second set of permanent historical records here.

The compact semantic header excludes part descriptors. It contains the format/profile, archive and center identity, timezone, capture time, period boundaries, table counts, and semantic proof/device contexts. Cap its serialized size explicitly, for example at 48 KiB. The existing semantic-proof limit is 32 KiB. Initialization may inspect one manifest of at most 512 KiB; subsequent calls load only the compact header. No call loads a multi-archive graph.

Keep cursor JSON below 8 KiB. Do not put the current 4 MiB visit operation map into a D1 string or checkpoint. Its durable representation is the operation index plus a small replay state.

## Phases and checkpoints

### 1. Initialize the base snapshot

Authenticate and stage the archive through the existing adapter, then freeze it. Require v2, `kind=monthly`, no references, and exactly one registered manifest. Check the expected center record with the same shape and relationship rule used by the oracle.

Create the job with the frozen commit token and graph hash. Copy the bounded semantic header and expected table counts. Record a validator version. A snapshot already marked verified by a different mechanism is not itself a completed runner checkpoint.

### 2. Validate records and build derived indexes

Visit `ARCHIVE_TABLES` in its existing order and keyset-scan each table. The cursor records table index, last fully completed key, and completed row count. Fetch one record for a complex attendance/audit rule. Cheap context records may be grouped later after measurement.

Reuse the existing checks for exact columns, IDs, scope, timestamps, nullable values, enum values, subjects, staff roles, pickup authority, relationships, request fingerprints, source-audit equality, receipt decoding, device ownership, review state, and event/correction ID collisions. The monthly profile has no inherited records and no cross-archive immutable comparison. Every relationship resolves within this one frozen archive.

Two checks are deferred to later phases: replaying a visit's complete operation history and proving that a resolved review has an exact resolution-audit witness. All other rules for those records still run in this phase.

After an event or correction passes its checks, insert its derived operation reference and update its visit totals atomically with the record cursor. Decode event versions using the existing receipt decoder. Correction versions are `expected_version + 1`. A sealed null receipt for an unmatched exceptional departure remains valid and produces no visit operation. Source-ID collision checks still apply to that event.

The byte sum must use the same `TextEncoder(JSON.stringify(record)).length` calculation as the oracle. Do not count only receipt bytes or compressed bytes. Within a monthly base, authenticated table keys are unique, so each accepted operation contributes once.

When a validated `review_resolved` audit exactly matches its target review's actor, resolution timestamp, and resolution text, insert one witness. Other legitimate resolution attempts still undergo the existing audit checks and remain part of the evidence, but do not become the witness. This replaces a later scan of every audit for each review with one indexed existence lookup.

At table EOF, compare the completed count with the manifest's exact table count. Empty tables and exact page-size boundaries must also reach this check. Cursor and counters advance only when the entire selected record has passed and its derived writes commit.

### 3. Replay visits from the operation index

Keyset-scan the actual `visits` records. For the current visit, load its operation totals, rejecting missing arrival evidence or an exceeded closure bound with the existing error semantics.

Read operation references in `(operation_version, request_id)` order and join them back to immutable staged records. Fetch at most eight operations per call initially. The cursor stores the visit key, last operation version/request ID, processed operation count, and the running state:

- current version, start and end;
- original start and end;
- arrival actor, departure actor, guardian, and departure type.

Apply the existing transition rules verbatim. Enforce a version-1 arrival, consecutive versions, correction prior-state equality, no future corrections, valid departure ordering, accepted receipt state, and nonnegative intervals. Two operations with the same version must fail, even when they straddle an invocation boundary.

At EOF, compare the fold with the saved visit's final/original times, version, actors, guardian, departure type, review state, and original-month scope. Require processed operation count to equal the saved total. Commit the next visit cursor only after this comparison succeeds.

No visit scans the event or correction tables again. A large visit is folded across several calls using the same ordered operation index.

### 4. Check resolved-review witnesses

Keyset-scan the reviews and require a witness for each resolved review. Pending reviews have already passed their null-resolution-field checks. A witness lookup is indexed by run and review ID.

The witness was produced only after validating the audit and comparing its fields with the immutable review. For an independent consistency check, fetch its staged audit by key and rerun the same exact comparison. Do not accept only a count of `review_resolved` actions or the existence of an audit aimed at that review.

This phase does not rescan an unbounded audit relationship. It preserves the oracle's requirement for at least one exact witness while retaining its acceptance of later resolution attempts.

### 5. Commit private verification success

One native transaction must assert the job revision/lease, validator version, original runtime generation, session commit token, graph hash, and terminal counters. Require every phase to be complete. Then mark the session privately verified and the job complete together.

No public publication occurs here. A caller-provided `verified=true` flag or a forged terminal cursor is not a substitute for these checkpoints. Return completion idempotently only for the same valid snapshot and job.

## Shared rules and parity

Refactor the oracle around small shared helpers rather than copying its conditional logic into a second validator.

- Keep shape, canonical JSON, fingerprint, receipt, source-audit, and review/audit comparison helpers shared.
- Extract initial visit state, one-operation transition, and final visit comparison from the existing `visitState` logic. The oracle gathers and sorts its bounded closure, then uses those helpers. The runner streams the indexed closure through the same helpers.
- Extract ordinary record checks with explicit deferred obligations for visit replay and review witness proof. The full oracle immediately fulfills those obligations; the runner records and completes the corresponding later phase.
- Leave the oracle's cross-archive latest-context lookup, immutable equality, review version-chain, and graph checks in place. The first runner rejects profiles that need those checks.

Parity means identical acceptance or rejection for the supported monthly profile. Preserve established error codes for isolated violations. Moving checks into phases can change which of several simultaneous invalidities is reported first; tests should not mistake that ordering difference for an acceptance change.

## Query and byte budgets

Count actual D1 SQL statements, including statements inside `batch`. A batch of four statements consumes four units. A current staging `get` or `page` consumes two units because it includes an active-session guard.

Set a hard runner ceiling of 40 statements per invocation, including its lease, metadata reads, derived writes, checkpoint, and failure handling. This leaves up to ten statements for a future caller's authorization and scheduling overhead under the Free-plan limit of 50. The future caller must count its own overhead too.

Reserve six of the runner's units for terminal checkpoint or invalidation work. Do not start another complete record unless its conservative worst-case statement cost fits. A monthly event needs at most nine point lookups, or 18 current adapter statements. One source-record read, job/header access, operation/totals writes, and checkpoint still fit below 40. Visits and review witnesses run in separate bounded steps. Never loop through an entire archive inside one advance call.

Add a query-budget wrapper around every database dependency used by the runner. Before sending a batch, charge its full statement count. If implementation changes violate the predicted record budget, fail without moving the cursor instead of silently issuing extra queries.

Initially use one complex record or up to eight visit operations per step. Set a 1 MiB decoded-record payload ceiling per invocation and a separate 48 KiB compact-header ceiling. Eight maximum-size operations are at most 512 KiB; one record plus nine maximum-size referenced records is at most 640 KiB. Bound every page before decoding, and retain the existing 64 KiB per-record and 4 MiB per-visit limits. These limits leave room for serialization and parsing overhead but must still be checked in actual workerd.

D1 query counts and bounded memory do not establish compliance with Worker CPU limits. Measure the largest supported records, fingerprints, receipt JSON, and operation pages in workerd. Reduce the step size or supported deployment profile if required. The format's 512 MiB archive ceiling is not a production storage admission limit.

## Concurrency, interruption, and recovery

Acquire a short job lease by comparing the current revision and active snapshot identity. Every mutation batch must reassert that lease/revision and the current `history_runtime.generation`. A stale guard must abort the transaction before any derived index or counter writes. Checking an update's zero-row result only after unrelated writes would be insufficient.

Commit derived operations, visit totals or witnesses, and the next cursor/revision in the same D1 transaction. A response lost after commit is handled by rereading durable state. A response lost before commit repeats the same work. Neither case adds counts twice or skips a record.

Reads and final commits remain bound to the frozen token and generation. A cleanup invalidation or restore between reading and committing must prevent success. A crashed lease may be reclaimed; the new lease token fences the old worker even if it later resumes.

Recovery invalidates jobs, clears leases, and keeps their original generation and snapshot association. It must not relabel old checkpoints with the new generation. Backup inventory must include the new tables. Backup locks block job creation, progress, completion, invalidation, and cleanup; transient lock failures do not advance progress.

Extend private cleanup so run witnesses, operation references, totals, and jobs are removed in bounded foreign-key order before their staging session is deleted. Session invalidation must immediately disable reads and future success. Cleanup never touches live records, publication metadata, or R2 objects.

## Test matrix

| Area | Required cases |
| --- | --- |
| Profile | Valid monthly base; v1; addendum; nonempty references; extra registered manifest; wrong snapshot token/hash; unsupported validator version. |
| Differential parity | Every current monthly semantic fixture through oracle and runner; accepted tuple/object/sealed-null receipts; fingerprint encodings; source audits; device context; pickup relationships; corrections and review resolution. |
| Counts and cursors | Empty tables; exact page boundary; final partial page; missing/excess row; duplicate or out-of-order key; forged table index/count; resume at every record and phase boundary. |
| Visit replay | Arrival only; normal and exceptional departure; multiple corrections; same version across page boundary; missing version; missing arrival; wrong prior state; receipt mismatch; final-state mismatch; original-month mismatch. Test exactly 2,048 operations and 4 MiB, then one over each bound. |
| Review witnesses | Exact witness; no witness; wrong actor/time/text; unrelated audit; later legitimate resolution attempt; many attempts; a witness on the last audit page. Verify reads remain bounded as unrelated audit volume grows. |
| Query and byte budgets | Instrument real prepared statements, not method calls. Worst-case nine-lookup event, eight maximum-size operations, maximum header, and failure paths must stay within 40. Confirm indexed operation order and witness queries with native query plans and rows-read evidence. |
| Atomicity | Inject failures after operation insertion, totals update, witness insertion, and before cursor update. Verify complete rollback. Simulate lost response after commit and retry without double counts. |
| Leases and generations | Two concurrent advances; expired-lease takeover; stale worker after takeover; restore before read, during validation, and before checkpoint; cleanup invalidation during a step; terminal success racing invalidation. |
| Backup and cleanup | Lock before and between reads/writes; no cursor movement under the lock; restored jobs cannot resume; cleanup is bounded and FK-safe; no authoritative rows or archive objects change. |
| Resource abuse | Maximum-size record/receipt/detail; invalid nested JSON; oversized cursor/header; huge visit; many audits for one review; many abandoned sessions. Confirm terminal failure or bounded progress, never an unbounded scan. |

## Adapter gap resolution after schema 19

1. Completed. `openFrozenBaseSnapshot` validates the frozen token and graph hash, returns the guarded store, and loads compact metadata without rereading part descriptors on each advance.
2. Completed. The bounded runner owns its guarded final transaction. `finalize()` remains the full independent oracle path; it is not used for resumable advances and no success-boolean API was added.
3. Completed. The operation-version index, visit totals, and exact review-witness map avoid full closure gathering and repeated witness scans.
4. Completed. Cleanup removes the four runner tables before the original staging tables. Backup inventory and recovery invalidation include all four, so checkpoint foreign keys do not block session deletion or leave derived private state behind.
5. Still open before activation: measured staging-byte admission and global concurrent-session limits, scheduled abandoned-job cleanup, deployed CPU validation, publication/receipt lookup, and independent published-v2 recovery. The runner already rejects addenda and multiple manifests; supporting addenda needs a separate bounded implementation. Source eviction remains disabled.
