# Internal monthly archive verification

Schema 19 implements resumable semantic verification for one authenticated v2 monthly base. The profile requires `kind=monthly`, no references, and exactly one staged manifest. Addenda are rejected. No route, scheduler, archive writer, public reader, publication transaction, or source eviction is enabled by this module.

## Internal API

`startMonthlySemanticVerification(db, identity)` accepts `{verificationId, generation, commitToken, graphSha256}` from a frozen staging snapshot. It returns a durable handle with the additional `runId`. Repeated starts return the same job for that snapshot and validator version. A session marked verified by the old full-verifier path cannot substitute for a completed runner job.

`advanceMonthlySemanticVerification(db, handle)` performs one bounded step. Its result includes `status`, `phase`, `revision`, `processed`, and actual prepared-statement count in `queries`. Status is `pending`, `complete`, `busy`, or `paused`. Semantic failures and invalid persistent metadata throw, save a bounded `error_code`, and invalidate the private run/session. Stale handles throw without changing a newer owner's progress.

`D1ArchiveSemanticStaging.openFrozenBaseSnapshot(db, identity)` opens the guarded semantic store and a compact header without needing an encryption key, rereading R2, or parsing part descriptors. Authentication happened when the original encrypted manifest and parts entered staging.

## Phases and private state

1. `records` validates one source record per step, using shared shape, relationship, receipt, fingerprint, audit, and device rules. Each table reaches an explicit EOF/count check. Accepted operations populate an indexed reference table and per-visit totals. Exact resolution audits populate one witness per review.
2. `visits` streams up to eight operations in accepted-version order and persists the visit fold between calls. It checks the same arrival, receipt, correction, interval, original-time, version, and final-state rules as the full verifier.
3. `reviews` requires an indexed exact witness for each resolved review and rechecks the referenced audit. It does not rescan all audits for every review.
4. `complete` atomically marks the private session verified and the run complete after checking every terminal counter.

The tables are `archive_semantic_runs`, `archive_semantic_operations`, `archive_semantic_visit_totals`, and `archive_semantic_review_witnesses`. Operation rows point to immutable staged records rather than copying receipts. The existing full `verifyArchiveSemantics` function shares the extracted rules and remains the independent oracle, including for its existing addendum profile.

## Enforced work limits

- An advance call issues at most 40 actual prepared statements. Every statement inside a batch counts. Six units remain reserved during validation for its checkpoint or failure handling. A future route must fit its own authorization/scheduling work into the remaining ten statements under a 50-query invocation limit.
- A compact header is at most 48 KiB. A cursor is at most 8 KiB, with strict field, phase, count, key, and fold-state validation. Completed jobs validate their stored cursor before returning success too.
- Decoded record payloads total at most 1 MiB per advance. Headers have their separate 48 KiB bound and are not charged against that record-payload total. A source record is at most 64 KiB, and a visit fold reads no more than eight operations at once.
- Each visit has at most 2,048 unique operations and 4 MiB of source-record bytes. Totals update in the same native transaction as the operation reference and record cursor.

These are enforced statement/payload limits. They are not a measured production CPU guarantee or permission to admit a 512 MiB staging graph into a Free-plan database.

## Interruption, maintenance, and cleanup

Every progress transaction starts with a revision, lease, generation, frozen-token, and graph-hash assertion. A stale assertion aborts before derived writes. Index/totals/witness changes and the next cursor commit together. Lost responses therefore resume from durable progress without counting an operation twice.

Leases last 30 seconds. An expired lease can be replaced; its old worker cannot commit. A backup lock pauses writes without moving the cursor. A lease acquired just before the lock may remain until expiry because releasing it is also a protected write.

Restore invalidates all jobs and clears leases while retaining original generation, snapshot provenance, errors, and derived evidence. Old handles, including previously completed handles, cannot resume. Private cleanup removes witnesses, operations, totals, and runs before the core staging tables, at most 64 proof entries per call. Schema 22 adds a current-generation cleanup token, a 30-second lease, a captured lifecycle revision, atomic page checkpoints, and an exact terminal completion receipt. Metadata and retained diagnostic writes are additional to the reported deletion count. Cleanup does not delete live records or R2 objects.

## Validation and remaining integration

Focused native tests cover concurrent claims, lease takeover, actual statement accounting, indexed operation pages, strict profile/cursor handling, atomic rollback, lost responses, backup barriers, generation races, and bounded foreign-key cleanup. Differential tests compare the runner with the full verifier using authenticated native attendance evidence and invalid-evidence fixtures. A separate test executes the runner inside real local workerd invocations.

Schema 20 adds enforced [staging admission](archive-staging-admission.md): one resident session across all generations and statuses, one runner per session, 20,000 records, 16 MiB plaintext and fresh primary database-size observations. Missing size metadata or excess observed size pauses work without invalidating semantic evidence. Production integration still needs unattended dispatch, daily background budgets and alerts, deployed CPU and provider-usage measurements, the publication transaction and exact receipt resolver, and independent recovery of published v2 archives. Internal abandoned-job expiry and leased cleanup exist in schema 22; no scheduler or operator endpoint invokes them. Addenda need a separate bounded implementation. Source eviction remains disabled.

Schema 21 records [lifecycle progress](archive-staging-lifecycle.md) only on committed cursor or phase advancement. Lease claims, unchanged releases, and completion retries do not refresh liveness. The first verification time stays fixed across the final runner update. Schema 22 adds explicit pause/resume and bounded renewal controls, with verified snapshots ineligible for holds or renewal. The runner returns `paused` for lifecycle work holds without invalidating its proof. Returning `paused` does not itself persist a daily budget or create a durable pause record. Lifecycle hooks add database row usage without adding prepared statements to the runner API. The complete schema 22 native local lifecycle measured 179,835 writes and 3,180,523 reads, with at most 26 statements per verification advance. These observations are local and do not establish deployed CPU or a complete future dispatch budget.
