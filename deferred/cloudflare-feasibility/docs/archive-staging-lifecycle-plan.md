# Lifecycle plan for private archive staging

Updated September 16, 2026. Schema 21 supplied atomic progress metadata, first-verification timestamps, legacy grace, and indexed due reads. Schema 22 implements internal pause, resume, renewal, conditional expiry, cleanup leases, and retained diagnostics. See the [module contract](archive-staging-lifecycle.md). The [371-test schema 21 checkpoint](archive-lifecycle-checkpoint-2026-09-16.md) is historical evidence for the earlier schema.

Keep unattended scheduling disabled. No operator endpoint, daily budget, reservation ledger, publication transaction, or source eviction is implemented by this work. No deployment or paid upgrade is authorized by this document.

This plan follows [staging admission](archive-staging-admission-plan.md) and must remain compatible with the separate [publication design](archive-publication-design-review.md). It concerns disposable private verification work. Attendance retention and historical reporting authority remain separate requirements.

## Measurements and the pacing problem

The schema 20 full-month rehearsal authenticated 14,295 records in 56 parts. Verification took 16,860 advances with at most 26 measured statements per advance. It created 5,125 operation references, 2,550 visit totals, and two review witnesses. Cleanup took 350 calls of at most 64 entries. See the [historical local measurement](../tmp/native-month-admission20-v2/measurement-final.json).

The subsequent [schema 21 native local D1 measurement](../tmp/native-month-d1-usage21/measurement.json) reported 179,129 rows written, 2,361,868 rows read, and 295,724 statements. Those figures are historical and exclude schema 22 controls and diagnostics.

The current [schema 22 native local lifecycle](../tmp/native-month-d1-usage22/measurement.json) recorded 179,835 rows written, 3,180,523 rows read, and 296,789 statements. It reported no failed batches or missing metrics, a maximum of 26 statements per verification advance, 350 cleanup pages, and two retained diagnostics. A measured terminal completion replay performed zero writes; its `deleted: 1` response replays the original result.

The write total exceeds the documented Free-plan allowance of 100,000 rows per day before ordinary application traffic. It still excludes future reservations, dispatch, alerts, publication, and their retries. Include those operations in later measurements instead of treating the current total as a complete production budget.

These are native local observations through an excluded workerd orchestration request. The schema 22 database started and finished at 733,184 bytes and peaked at 41,422,848 bytes. The 55.934 seconds elapsed is local orchestration time, not deployed Worker CPU. These sizes are separate from populated-baseline allocation tests. Local D1 metadata does not establish account billing. Physical allocation, sampled filesystem size, SQLite `changes()`, and prepared-statement counts measure different things.

One advance per five-minute wake-up permits 288 advances per day. Verification alone would then take more than 58 days. Any future dispatcher needs multiple individually bounded invocations per wake-up under a tested daily allowance. It must preserve the explicit 14-day renewal requirement.

## Implemented control contract

The separate `archive_semantic_lifecycle` table preserves the proof-state transition guards on `archive_semantic_sessions`. Original `(verification_id, generation)` and admission time remain unchanged throughout work and recovery.

| Stored fields | Meaning |
| --- | --- |
| `admitted_at`, `last_progress_at`, `progress_revision` | Original admission and actual committed progress. Retries and lease claims do not refresh them. |
| `verified_at` | First observed verification only. Unknown legacy values remain null. |
| `revision`, `due_at` | Conditional control updates and indexed due selection. Session status stays in the session table. |
| `pause_reason`, `paused_at`, `next_eligible_at`, `resume_grace_until` | Bounded explicit pause and separate resume grace without fabricated progress. |
| `renewal_deadline_at`, `renewed_at`, `renewal_count` | Explicit renewal to at most 14 days after the renewal operation. |
| Session `cleanup_generation`, `cleanup_token`, and lifecycle `cleanup_lease_until` | Current cleanup authority, separate from the immutable evidence generation. |

New manifests, parts, and committed runner steps update progress atomically. An unpaused staging or frozen session becomes eligible for expiry after 24 hours without progress, capped by its renewal deadline. Verified snapshots use the first verification timestamp and cannot receive a pause, renewal, or publication hold. Legacy migration grace and explicit resume grace are represented separately.

Pause reasons are `maintenance`, `daily_budget`, `capacity`, and `size_unavailable`. Each accepted pause includes a future recheck time bounded by the effective renewal deadline. Resume requires that time to have arrived and grants at most 24 hours of idle grace, capped by the same deadline. Renewal preserves idle history; it does not resurrect invalid work. The `daily_budget` reason does not itself implement an allowance or dispatch policy.

Control mutations use the current execution generation, expected lifecycle revision, current session status, and absence of a live runner lease. The operation ID and exact request hash make receipt replay idempotent, including a concurrent duplicate discovered in the final transaction. Changed retry payloads conflict. Diagnostics and state updates commit together. Initial and final receipt reads check execution generation.

Due selection is read-only. Conditional expiry rechecks due time and revision inside the invalidation transaction. Progress or renewal can make a selected candidate stale. A paused job due for resumption returns `resume_due` only after a fresh database-time and authority check and before its renewal deadline expires. A live runner lease causes a bounded defer.

Cleanup claims use a 30-second lease and reject both a live runner lease and another live cleanup claim. A page deletes at most 64 private entries in the existing foreign-key order. Each deletion and checkpoint checks original and current generations, token, lease, invalid state, and captured revision. A nonterminal page commits its deletions, revision increment, renewed lease, and due time together. The terminal transaction writes a scoped completion diagnostic and removes the session and lifecycle row atomically. Only an exact terminal receipt can replay completion after the session disappears.

All statuses and retained generations continue to occupy the single admission slot until final session removal. Cleanup never removes live sources, permanent ownership, publication metadata, or R2 objects. Inspection, invalidation, and cleanup remain usable when size metadata is unavailable or the admission watermark is exceeded.

## Diagnostics and recovery limits

Retained `archive_semantic_diagnostics` records have no foreign key that deletes them with the session. They store bounded operational fields and hashes without source rows, student names, raw cleanup tokens, or free-text reasons. Replacement, update, and deletion are rejected. Retention and pruning are unresolved; the earlier proposed 90 days is not implemented and does not set attendance-retention policy.

Lifecycle hooks, claim and page checkpoints, diagnostic inserts, indexes, and final lifecycle deletion add database writes. The cleanup result counts proof entries only. Measure native row usage across the complete operation, including triggers and retries.

Maintenance blocks lifecycle and diagnostic writes. The runner may return paused without a mutation; internal control functions must surface the maintenance rejection. Planned maintenance must record a pause before taking the lock and resume after release. No automatic lock/pause orchestration exists yet. Do not infer a durable pause start from an expired lock.

Backup inventory includes lifecycle state and retained diagnostics. Recovery preserves original evidence and lifecycle history while rotating execution authority. It invalidates retained sessions and runs and clears execution leases and pause/resume fields, including controls on already-invalid sessions. One immutable restore-invalidation note per original session identity retains pre-reset context; repeated reset does not duplicate it or fabricate progress. Cleanup then uses the new runtime generation against unchanged original evidence. A reset does not free the admission slot.

## Remaining verification and implementation

1. Preserve the schema 22 integration evidence. Cover progress versus expiry, renewal versus expiry, identical concurrent controls, changed retry payloads, active runner leases, cleanup takeover, old capabilities, rollback after failed receipt or checkpoint, and generation rotation at asynchronous boundaries. Include empty and legacy migrations under maintenance, migration rollback, and independent encrypted recovery between cleanup phases. Verify due selection uses its index with retained diagnostics present. Keep source records, publication metadata, permanent ownership, and R2 unchanged.
2. Extend capacity measurements beyond the completed native schema 22 lifecycle. Long attendance-derived keys, fragmentation, and later scheduling overhead remain separate checks. Rerun supported boundary profiles after changes that affect storage. Preserve fixture provenance and distinguish local VACUUM from remote D1 reclamation.
3. Implement daily background budgets and conservative reservations before dispatch. Include headroom for attendance, imports, backups, other databases, and account applications. Reserve cleanup capacity so abandoned work can release the resident slot. Missing usage metadata must pause dispatch rather than count as zero. Settle measured usage idempotently; uncertain responses keep their reservation.
4. Test UTC-day transitions, delayed dispatch, budget races, lost settlement responses, backup maintenance spanning deadlines, and restored stale usage. A restored observation cannot establish the current account's remaining allowance. Do not reset daily spending to zero during access reset. Establish a fresh budget epoch before resuming unattended work.
5. Add deduplicated alerts and resolve diagnostic retention and guarded pruning. Avoid repeated no-op writes or notifications while a job waits for eligibility. Include these costs in measurements and storage planning.
6. Validate deployed CPU, provider usage, and account headroom. Fit authorization, dispatch, lifecycle, and budget checks into the invocation limit alongside the runner's 40-statement bound. Only then review scheduling activation as a separate step. No existing five-minute schedule or backup queue should dispatch these functions yet.

Publication, historical receipt resolution, independent restoration of published v2 archives, and source eviction require their own integration and release evidence. Private verification and cleanup do not satisfy those gates.
