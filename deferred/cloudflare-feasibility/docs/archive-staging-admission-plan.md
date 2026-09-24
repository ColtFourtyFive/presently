# Admission and cleanup for private archive staging

Updated September 16, 2026. Schema 20 implements admission, schema 21 adds lifecycle metadata, and schema 22 supplies internal lifecycle controls and leased cleanup. The [admission module](archive-staging-admission.md) and [lifecycle module](archive-staging-lifecycle.md) describe the current contracts. Unattended dispatch, daily pacing, and production activation remain unfinished. A verified private snapshot does not authorize publication or deletion of live history.

## What is measured

The final schema 20 migration rehearsal preserves 60,000 visits, 120,000 accepted receipts, and 120,940 logical audits. Closed allocation after local VACUUM is 133,783,552 bytes, then 175,083,520 bytes after permanent request-key and visit-head backfill. Those figures exclude populated private staging.

Two new local measurements authenticate encrypted v2 manifests and parts, complete the resumable runner, and pass the independent semantic verifier. Both start from a separate schema 20 copy occupying 175,083,520 bytes:

| Profile | Source input | Added allocation after staging | Added allocation after verification |
| --- | --- | --- | --- |
| Native-trigger synthetic month | 14,295 records, 9,064,646 JSONL bytes, 56 parts; 2,550 visits | 38,764,544 bytes | 40,693,760 bytes |
| Synthetic context boundary | 20,000 records, exactly 16 MiB JSONL, 79 parts; maximum legal context keys | 123,396,096 bytes | 123,404,288 bytes |

The month produces 5,125 operation references, 2,550 visit totals, and two review witnesses. It completes in 16,860 runner calls with at most 26 actual SQL statements per call. The boundary completes in 20,012 calls with at most 12 statements and no derived attendance records. The runner's enforced ceiling remains 40 statements.

The boundary has one center, 143 students, 143 guardians, and 19,713 student/guardian links. IDs are 100 characters and composite keys are 207 characters. Synthetic authority notes of 265 or 266 characters bring plaintext to the exact cap. This is deliberately synthetic context input, not a typical center or a rewritten historical fixture. SQLite allocates 19,713 overflow pages for these records. Measured growth of 117.6875 MiB fits the allowance with 10.3125 MiB remaining. Mixed derived-record profiles and fragmentation still need assessment.

A [supplementary mixed profile](archive-mixed-boundary-2026-09-16.md) now combines all unchanged native month records with 5,705 added context records at the exact 20,000-record/16 MiB caps. Runner and oracle pass with 84,791,296 bytes of growth, or 80.86328125 MiB, including 5,125 operation references, 2,550 totals, and two witnesses. Native attendance-derived keys stay 36 characters; added context/session/archive IDs are 100 characters. This covers one mixed case, while long attendance-derived keys, fragmentation, and deployed capacity remain unproven. The supplementary evidence pins schema 20 and does not replace its frozen checkpoint or include later lifecycle costs.

After verification, the month database occupies 215,777,280 bytes and the boundary database 298,487,808 bytes. Cleanup takes 350 and 318 calls respectively, each deleting at most 64 private entries. It leaves those allocations unchanged while making added pages reusable. Local VACUUM returns both closed files to 175,083,520 bytes. Baseline files remain unchanged. These observations do not establish remote D1 reclamation.

The boundary's sampled main/WAL/shared-memory/journal files total at most 304,016,688 bytes. Samples after SQL statements and commits do not bound transient peaks between samples. This local filesystem total is separate from database page allocation and must not be reported as native D1 size or billed usage. The final month run did not capture an equivalent filesystem peak.

The earlier schema 19 storage-only measurement remains historical evidence. Its 14,289-record fixture had opaque synthetic request hashes and was not an authenticated full-month verification. The new native-trigger month supplies that missing evidence without changing historical hashes. The format's 512 MiB graph and 32-archive ceilings are format limits; schema 20 admits only one smaller monthly base without references.

Sources:

- [Final schema 20 migration](../tests/full-release-migration-results-20-final.json) and [backfill](../tests/history-lookup-scale-results-20-final.json)
- [Authenticated native-trigger month](../tmp/native-month-admission20-v2/measurement-final.json)
- [Authenticated context boundary and page breakdown](../tmp/staging-boundary20/evidence.json)
- [Native local D1 lifecycle usage](../tmp/native-month-d1-usage/measurement.json)
- [Historical schema 19 allocation](../tmp/staging-storage-19/evidence.json)
- [Admission tests](../tests/archive-staging-admission.test.ts) and [runner bounds](archive-semantic-runner.md)

Artifacts under `tmp` remain in the excluded local validation directory. None of these measurements establishes deployed Worker CPU or Cloudflare account-level daily billing.

## Implemented initial policy

Schema 20 applies one policy to the whole D1 database, including every center and retained generation. The staging adapter and database guards enforce it independently of queue concurrency.

| Limit | Implemented value | Enforcement and meaning |
| --- | --- | --- |
| Resident private sessions | 1 | Count staging, frozen, verified, invalid, and restored sessions until their last private row has been removed. |
| Active runner advances | 1 | Retain the existing generation, revision, and 30-second lease checks. The resident limit also prevents a second job from accumulating data. |
| Supported archive profile | One v2 monthly base, no references | Reject other profiles before accepting parts. |
| Authenticated plaintext per session | 16 MiB | Check the authenticated manifest total and require each committed part to match its bound descriptor. |
| Source records per session | 20,000 | Check the manifest count and actual committed records. Count all tables, not just visits. |
| Physical planning allowance | 128 MiB per resident session | Provisional allowance covering both measured profiles. Mixed derived-record and fragmented-page cases remain before production acceptance. |
| Database admission watermark | 400,000,000 observed bytes, including the full planning allowance | Reject a new session if the latest primary database-size observation plus 128 MiB exceeds this watermark. This is a conservative preflight, not an atomic reservation of physical capacity. |

MiB means 1,048,576 bytes. The 400 MB watermark leaves at least 100 decimal MB below the documented 500 MB per-database Free-plan limit. The fixed allowance deliberately overcounts any already allocated reusable pages. Do not subtract local `freelist_count` or expected future eviction from a live D1 observation.

The final schema 20 fixture plus the 128 MiB allowance is 309,301,248 bytes, below this watermark. That arithmetic is useful for planning. It does not prove that a permitted session fits in deployed D1 under concurrent application growth.

The limits admit the representative native-trigger month and the exact-cap context boundary above. The latter consumes about 92% of the allowance. This is measured local headroom, not a validated worst-case bound or a guarantee under concurrent application growth.

An archive that exceeds any limit remains in live history. A future route should show measured counts and bytes alongside the applicable capacity error. Do not silently truncate a month, publish a partial archive, omit oversized records, or relax semantic checks. Supporting larger months requires a separately tested profile or a different staging design. Source eviction remains disabled in the meantime.

## Implemented atomic admission

No reservation table was needed. A `BEFORE INSERT` trigger on `archive_semantic_sessions` rejects creation when any resident exists, across all generations and statuses. The admitted-session view also checks the bounded manifest and runner profile. The session row occupies the slot and its planning allowance until cleanup removes it.

Database guards and the adapter enforce the monthly-base profile, one-manifest limit, and aggregate plaintext/record bounds. Authenticated part verification and the atomic part/row checkpoint remain in place. The manifest binds exact part counts, plaintext sizes, hashes, and record counts; actual accepted parts must continue to match those descriptors. Identical part retries reuse the checkpoint without increasing stored data. The one-resident, one-manifest policy keeps admission aggregates bounded. Lower-level adapter entry points enforce these checks without requiring a future route or scheduler.

The initial byte cap applies to authenticated source plaintext, not every byte held by SQLite. Staging metadata also has existing bounded manifest and descriptor sizes. Runner headers are bounded to 48 KiB and cursors to 8 KiB. Derived operation, visit-total, and review-witness rows must remain limited by the corresponding authenticated source records and current uniqueness constraints. A second runner or future validator version must not multiply those derived rows outside the admitted profile.

SQLite table and index pages need more space than the source plaintext. The 128 MiB allowance is deliberately separate. Long keys, many small records, index duplication, derived rows, and page fragmentation must appear in boundary measurements before this allowance becomes an accepted deployment profile. A manifest byte cap by itself cannot prove a physical maximum. Introduce incremental physical-cost estimates or extra counters only if those measurements show the simple bounds are inadequate; any such counters would need rollback, retry, restore, and drift-reconciliation tests.

The generic staging result now preserves native `meta.size_after`. Its transport must use the primary database, such as the raw `env.CRM_DB` binding. Missing, invalid, or explicitly nonprimary observations fail closed. Admission reads a fresh observation; ongoing work checks fresh results rather than using a five-minute cache. Runner capacity failures return `paused` without advancing or invalidating proof. Application writes can race with a preflight, so these checks are not an atomic physical reservation. Durable observation history and scheduler budgets remain unfinished.

Invalidation, semantic failure, lease expiry, reset, and restore do not release the occupied slot. Cleanup releases it only when the last private session row is removed, after all derived and staged rows are gone. Partial cleanup continues to occupy the one resident slot. Publication, once separately implemented, must retain its immutable proof outside staging before private cleanup can discard this data.

## Existing databases and recovery

The default policy handles databases that already contain several schema 19 sessions. Migration 20 installs without failing for that reason or deleting old evidence.

Admission guards preserve existing rows. Retained sessions reject new admission. Existing sessions remain inspectable; an explicit reconciliation choice can invalidate and clean unwanted jobs. Additional staging and runner work are denied while several residents remain or while the surviving session exceeds the byte/profile limits. Diagnosis and bounded cleanup remain available. Once one supported session remains, it may resume after the ordinary size and resource checks. Once all sessions have been cleaned, new admission is possible again. No reservation backfill or new inventory table is required.

Production defaults are enabled by migration and immutable policy configuration, without an optional route flag. Tests use separate fixture databases or explicit cleanup between sessions. Focused cases verify the production default rejects a second resident and cannot be bypassed through the adapter.

Backup inventory includes the staging rows that determine admission, lifecycle state, and retained diagnostics. Restoration preserves original evidence generations and lifecycle history while rotating execution authority. It clears leases and pause/resume controls. Retained sessions block new admission until cleanup, even though old jobs cannot resume. A counter reset cannot free the slot because admission reads retained session rows. Reset and restore must not turn private verification into publication authority.

## Implemented abandoned-session controls

Schema 22 adds explicit pause/resume, renewal, conditional expiry, cleanup leases, and retained diagnostics to schema 21's progress metadata. See the [current lifecycle contract](archive-staging-lifecycle.md). The [schema 21 checkpoint](archive-lifecycle-checkpoint-2026-09-16.md) remains historical evidence.

Unpaused staging and frozen jobs become eligible for expiry after 24 hours without progress, capped by the renewal deadline. An explicit pause records its reason and bounded next eligible time. Resume requires that time to have arrived and grants at most 24 hours of separate idle grace. Renewal preserves original admission and progress history. Verified snapshots cannot be paused, renewed, or held for publication.

Indexed due selection grants no mutation authority. Expiry rechecks the selected revision, deadline, current execution generation, and absence of a live runner lease. Progress or renewal can win the race and make a candidate stale. A paused job due for resumption returns `resume_due` while its effective renewal deadline remains valid.

Cleanup claims reject live runner and cleanup leases. Each page deletes at most 64 private entries and commits its lifecycle revision, 30-second lease renewal, and next due time atomically. Original evidence generation, current execution generation, token, lease, and captured revision fence every deletion. The terminal transaction writes an exact completion diagnostic and removes the session and lifecycle row. A missing session alone is not success; an exact saved completion receipt can replay without another write.

Diagnostics survive private cleanup. Their retention and guarded pruning remain unresolved. Metadata updates, diagnostic inserts, indexes, and final lifecycle deletion contribute native row writes beyond the cleanup API's proof-entry deletion count.

There is no scheduler, operator endpoint, or daily spending budget. A future dispatcher must preserve the database guards regardless of queue concurrency, pace cleanup alongside verification, and avoid assuming that the existing five-minute wake-up can complete a month with one step per invocation.

## Remaining daily pacing and production gates

Cloudflare documents 5 million D1 rows read and 100,000 rows written per day for the Free plan, shared across the account. Writes include inserts, updates, deletes, and indexed-column maintenance. The September 1, 2026 enforcement change makes further queries fail after the daily allowance is exhausted. Forty statements per invocation and a four-statement part write transaction are not measures of the rows charged by those statements.

The schema 20 local workerd/native D1 run of the 14,295-record month reported 2,260,346 rows read, 145,288 rows written, and 295,722 statements. There were no missing row/size metadata results or failed batches. Part staging accounts for 57,292 writes, runner advances for 65,958, cleanup for 22,031, and the remaining lifecycle work for seven. It completed 16,860 advances at most 26 statements each and 350 cleanup calls at most 64 deletions each. Source generation and schema setup are outside those totals; encryption and JSON work have no row metric.

That isolated D1 started at 675,840 native reported bytes and reached 41,365,504. These are not populated-copy measurements or evidence of deployed billing, CPU, or remote reclamation. The run used one excluded local orchestration request. Its elapsed time cannot establish production invocation compliance.

The local write total exceeds one documented daily Free-plan allowance before ordinary application traffic. Implement an explicit daily background budget and test pauses before exhaustion plus resumptions across day boundaries. Leave measured headroom for attendance, imports, backups, other databases, and other applications in the account. Confirm provider billing and deployed CPU separately. The result does not authorize a paid upgrade.

Measure retries, scheduler overhead, and publication when implemented using native `meta.rows_read` and `meta.rows_written`. SQLite `changes()` and local elapsed time cannot substitute. Retain durable observations for scheduling and diagnosis without using stale values to bypass fresh capacity checks. Alerts should identify paused or over-capacity work without repeatedly notifying staff about unchanged state. Do not assume a whole month must finish in one UTC day.

Release gates:

1. Authenticated full-month, maximum-context, and one mixed capped local allocation case are complete. Add long attendance-derived key and fragmentation cases before accepting the allowance for deployment, and remeasure later lifecycle overhead. Local VACUUM remains distinct from remote D1 reclamation.
2. Admission, explicit lifecycle controls, leased cleanup, concurrent retries, rollback, maintenance, and recovery have focused local coverage. Preserve the integrated schema 22 checkpoint. Delayed dispatch and daily-budget behavior still require implementation and tests.
3. Native local D1 lifecycle row usage is measured. Verify deployed CPU and provider billing, then include retries, authentication, admission, scheduling, and maintenance in the complete cost. The runner's 40-statement bound leaves ten statements under the documented Free-plan limit for caller work.
4. Add durable resource observations, conservative daily reservations, useful alerts, and bounded dispatch around the implemented expiry and cleanup functions. Resolve diagnostic retention and pruning. Include new budget state in backup and restoration checks without treating restored observations as current allowance.
5. Complete publication and independent combined D1/archive/key recovery before enabling archive publication. Retain immutable publication proof outside private staging. Verify source eviction in its own checkpoint.

Cloudflare references, checked for this plan:

- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [Workers pricing, D1 allowance table](https://developers.cloudflare.com/workers/platform/pricing/#d1)
- [D1 indexes and billed rows](https://developers.cloudflare.com/d1/best-practices/use-indexes/)
- [Free-tier daily limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
- [D1 return-object metadata](https://developers.cloudflare.com/d1/worker-api/return-object/)

No deployed CPU measurements or guaranteed production capacity are established by this plan.


The historical schema 21 lifecycle measurement recorded 179,129 writes and 2,361,868 reads. The [current schema 22 native local measurement](../tmp/native-month-d1-usage22/measurement.json) recorded 179,835 writes, 3,180,523 reads, and 296,789 statements with no failed batches or missing metrics. It retained two diagnostics after 350 cleanup pages; terminal completion replay measured zero writes. Use the current measurement when planning budgets, then measure future scheduling, reservations, alerts, and publication overhead separately. Neither measurement establishes deployed CPU or account usage.
