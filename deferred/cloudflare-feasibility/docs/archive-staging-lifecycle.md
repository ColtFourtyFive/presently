# Private staging lifecycle controls

Schema 21 introduced lifecycle bookkeeping. Schema 22 adds internal pause, resume, renewal, expiry, cleanup leases, and retained diagnostics. These controls operate on disposable archive verification evidence. They grant no publication or source-deletion authority. No scheduler, operator endpoint, daily spending budget, or automatic diagnostic pruning uses them.

The [schema 21 checkpoint](archive-lifecycle-checkpoint-2026-09-16.md) records historical validation of the earlier implementation. Current native usage is reported below. Local validation does not establish deployment readiness.

## Recorded state and deadlines

`archive_semantic_lifecycle` has one row per original verification ID and generation, with a foreign key to the retained staging session. Original admission time, evidence generation, and legacy migration grace remain immutable. `revision` changes on operational updates. `progress_revision` changes only when authenticated work commits.

New sessions start with no observed progress time and zero progress revisions. SQL triggers record database time when a new authenticated manifest, part checkpoint, or runner step is accepted. Runner progress requires a changed cursor or phase and its final revision increment under the lease. Claims, released leases without progress, retries, failed transactions, and repeated completion reads do not extend liveness. Metadata and the underlying work commit or roll back together.

`verified_at` records the first observed transition to verified. The final runner checkpoint preserves that timestamp and deadline. Repeated verification does not restart retention. Invalidation makes the session due while preserving its original admission, progress, verification, and renewal evidence.

Without a pause or resume grace, staging and frozen work becomes eligible for expiry after 24 hours without committed progress, capped by the renewal deadline. Admission supplies the baseline before any progress. Verified snapshots use 24 hours after first verification, also capped by the renewal deadline. An explicit legacy migration grace can extend the effective deadline. Reaching an idle deadline supplies an expiry candidate; committed progress can still win the revision race before invalidation. Work guards reject paused sessions, expired verified sessions, and work beyond the effective renewal deadline.

## Pause, resume, and renewal

The internal [control module](../worker/archive-staging-controls.ts) accepts the original session identity, current execution generation, expected lifecycle revision, and an operation ID. Inputs are copied before asynchronous work. Every mutation rechecks generation, session status, revision, and absence of a live runner lease in its transaction.

| Function | Behavior |
| --- | --- |
| `pauseArchiveStaging` | Records `maintenance`, `daily_budget`, `capacity`, or `size_unavailable`, database pause time, and a future `nextEligibleAt` no later than the effective renewal deadline. The session must be unpaused and staging or frozen. |
| `resumeArchiveStaging` | Requires the recorded eligibility time to have arrived and the effective renewal deadline to remain in the future. Clears pause fields and records at most 24 hours of `resume_grace_until`, capped by that deadline. |
| `renewArchiveStaging` | Requires an actor and bounded reason code. Extends the renewal deadline to database time plus 14 days, increments `renewal_count`, and records `renewed_at`. It preserves admission time and idle history. |

Renewal does not make an already idle job active or resurrect an invalid session. A renewal can win a stale expiry candidate by revision, but the next selection may still find the unchanged idle deadline due. Verified snapshots cannot be paused or renewed. There is no publication hold flag.

Each accepted control operation writes its compact receipt atomically with the lifecycle update. An identical operation ID and request hash replays the stored receipt without another update, including a duplicate discovered in the final transaction. Changing the operation payload under that ID is a conflict. Request scope includes the operation kind, target, generations, expected revision, actor, reason, and eligibility time. Both initial and final receipt lookups check current execution generation. Receipts from a previous execution generation cannot authorize current work.

The `daily_budget` reason is a durable label for an explicit pause. No daily allowance, usage reservation, settlement, or dispatch policy exists yet. Capacity or maintenance responses from the runner do not automatically create a durable pause record.

## Conditional expiry and cleanup

`readArchiveStagingLifecycle` reads an exact session identity. `readNextDueArchiveStagingLifecycle` is the schema 21 read-only due selector. `readNextArchiveStagingExpiry` selects at most one non-invalid due candidate by the due-time index and captures its revision and current execution generation. Selection never grants deletion authority.

`expireArchiveStaging` rechecks identity, generation, revision, due time, and absence of a live runner lease. Eligible invalidation, its diagnostic, and runner invalidation commit together. A paused job whose eligibility time has arrived returns `resume_due` while its renewal deadline is still valid; the caller must explicitly resume it. That result requires a fresh database-time and authority check. An active runner lease returns `busy`. If progress or another control operation committed first, the old candidate is stale. If expiry commits first, later proof writes fail their state and generation checks.

`claimArchiveStagingCleanup`, also used by `D1ArchiveSemanticStaging.beginCleanup`, accepts only invalid sessions. It claims a new cleanup token and 30-second lease with a revision check, rejects live runner or cleanup leases, and writes a claim diagnostic in the same transaction. Cleanup can execute under the current generation against evidence retained under an older generation. It never relabels that evidence.

`cleanupPage` removes at most 64 private entries in one phase. The order is review witnesses, operation references, visit totals, runs, staged rows, parts, manifests, and finally the session. Every deletion checks the token, original and current generations, invalid session state, captured lifecycle revision, and unexpired lease. A nonterminal page commits its deletions, revision increment, renewed 30-second lease, and next due time together. A failed checkpoint rolls the whole page back. Lease expiry, takeover, or restore prevents the old token from deleting further records.

The terminal transaction writes an exact completion diagnostic before deleting the session. Its trigger deletes the lifecycle row before foreign-key checks. Both operations roll back if the guarded session deletion fails. After a lost terminal response, only the matching token hash, request hash, target, and current execution generation can replay the saved result. A missing session alone is not success. Terminal replay returns the original `deleted: 1` receipt and performs no new deletion. Nonterminal retries continue from retained state; they do not promise to replay the previous page's deletion count.

Only final session removal releases the one-resident admission slot. Cleanup never removes live business records, permanent request ownership, publication metadata, or R2 objects. Diagnosis, invalidation, and cleanup do not require successful database-size observations, but backup maintenance still blocks their writes.

## Diagnostics, maintenance, and recovery

`archive_semantic_diagnostics` retains pause, resume, renewal, expiry, cleanup-claim, cleanup-completion, and restore-invalidation events after staging cleanup. Records contain scoped IDs, reason and error codes, timestamps, revisions, hashes, and bounded JSON details and results. Each JSON field is at most 4 KiB. Cleanup capabilities are stored as hashes, not raw tokens. Diagnostic records do not copy student names, source rows, attendance receipts, credentials, or free-text explanations.

Update, replacement, and deletion guards make diagnostics immutable. Retention duration and a guarded pruning protocol remain unresolved. The earlier 90-day proposal is not an implemented policy or a statement of Kumon's retention requirements. Diagnostic growth must be included in capacity planning.

Maintenance blocks lifecycle and diagnostic writes. The verification runner can return `paused` without changing its checkpoint. Control and cleanup callers must handle the maintenance rejection without trying to stamp metadata through the lock. Planned maintenance needs to record its pause before acquiring the lock and resume after release; that orchestration is not implemented by these functions.

Backup inventory includes lifecycle state and retained diagnostics. Recovery keeps original evidence generations, admission, progress, verification, and renewal history. It rotates execution authority, invalidates retained sessions and runs, clears leases and pause/resume control fields, and leaves retained evidence available for cleanup. This also clears controls on already-invalid retained sessions. One immutable restore-invalidation event per original session identity snapshots the pre-reset context. Repeated reset does not manufacture progress or repeatedly insert that event. Restored diagnostics remain historical observations, not current execution permission.

Legacy backfill preserves unknown progress and verification timestamps as null and gives active legacy work an explicit 24-hour migration grace. It retains unsupported multiple-session legacy state for diagnosis and cleanup. SQL guards fail closed on invalid or null transition predicates. These guards are not protection against a database administrator who can replace the schema.

## Measurement and remaining work

Lifecycle hooks, lease checkpoints, diagnostics, indexes, and final metadata deletion add billed row writes. A page's `deleted` count reports private proof entries, excluding lifecycle and diagnostic writes. SQLite `changes()` and prepared-statement counts cannot substitute for native D1 `rows_read` and `rows_written` observations.

The [schema 22 native local lifecycle](../tmp/native-month-d1-usage22/measurement.json) recorded 179,835 writes, 3,180,523 reads, and 296,789 statements with no failed batches or missing metrics. Verification stayed at a maximum of 26 statements per advance. Cleanup used 350 pages and retained two diagnostic records. Terminal completion replay measured zero writes.

The isolated database started and finished at 733,184 bytes and peaked at 41,422,848 bytes. This is a different measurement from the populated-baseline allocation tests. The 55.934 seconds of local orchestration elapsed time is not deployed Worker CPU. Local row metrics and allocation do not establish account billing, available Free-plan headroom, or remote storage reclamation.

The historical schema 21 run recorded 179,129 writes and 2,361,868 reads. Use the schema 22 measurement for the implemented lifecycle, then add and measure future dispatch, reservation, alert, retry, and publication costs. Even the current lifecycle exceeds the documented 100,000-row daily Free-plan write allowance.

Unattended scheduling still needs measured daily budgets, conservative reservations, recovery of uncertain settlements, cleanup allowance, and useful alerts. Publication, historical receipt resolution, independent restoration of published v2 archives, and source eviction each retain separate release gates. See the [remaining lifecycle plan](archive-staging-lifecycle-plan.md).
