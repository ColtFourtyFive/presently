# Archive staging admission checkpoint

September 16, 2026. Application `0.1.0`, local schema 20. Production release remains pending.

The integrated suite passed **364 tests across 34 files** in **79.43 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `1a5127fc647754e59bcd85acb8d5a5940f3deda9ce21d376aeffaaa8587b20a2` covers 193 files and remained unchanged throughout validation. [Checkpoint evidence](../tmp/staging20-checkpoint-evidence-20260916.json) contains the artifact hashes. The [full results](../tmp/integrated-staging20-final-tests.json) and [test log](../tmp/integrated-staging20-final-tests.log) are retained locally.

The first integrated run passed 359 tests and failed five fixture-creation requests with local `EADDRNOTAVAIL` errors while a separate measurement exhausted host connections. Its results are preserved in `tmp/integrated-staging20-transport-failed-tests.{json,log}`. Moving the measurement loop inside a local Worker removed that connection load. The subsequent full suite passed without product changes. Historical schema 19 checkpoint artifact hashes also remain unchanged.

## Implemented admission policy

Schema 20 admits one resident staging session across all centers, generations, and statuses. It accepts one authenticated v2 monthly base, with no references, at most 20,000 records and 16 MiB plaintext. A session permits one derived runner regardless of validator version. Database guards and the adapter enforce these bounds.

New admission requires a fresh primary database-size observation plus a provisional 128 MiB allowance to fit below 400,000,000 bytes. Work pauses if native size metadata is unavailable or the observed database crosses that watermark. These checks do not reserve physical space atomically against unrelated application writes.

The migration preserves existing oversized or multiple-session state. Such state blocks admission and further work while remaining available for diagnosis, invalidation, and cleanup. The admission slot stays occupied until cleanup deletes the final session row. Recovery invalidates old execution authority without discarding original evidence. No retained tables or columns were added. See the [module documentation](archive-staging-admission.md).

## Migration and retained history

Empty schema 4 to 20 and populated schema 6 to 20 rehearsals passed under local maintenance locks. The populated migration preserved all original source fields, 120,940 logical audits and 120,000 accepted receipts. Intentional final-statement failures rolled back both rehearsals without losing data or maintenance state. Integrity and foreign-key checks passed.

The populated database measured **133,783,552 bytes** after migration and local VACUUM, then **175,083,520 bytes** after backfill and local VACUUM. Backfill completed in 365 calls, at most 500 records per call, reserving 120,940 request keys and mirroring 60,000 visit heads. No archive locations were activated. The three final schema 20 evidence files are linked in the checkpoint manifest.

## Measured temporary storage

Both measurements use separate copies of the populated baseline and production admission rules. Their authenticated archives pass both the resumable runner and the independent complete semantic verifier.

| Fixture | Input | Added allocated database bytes | Verification and cleanup |
| --- | --- | --- | --- |
| Native monthly records | 14,295 records, 9,064,646 JSONL bytes, 56 parts, 2,550 visits | 40,693,760 total, including 1,929,216 after staging for derived verification | 16,860 advances, at most 26 statements; 350 cleanup calls, at most 64 deletions |
| Exact admitted boundary with long identifiers | 20,000 records, exactly 16 MiB JSONL, 79 parts | 123,404,288, or 117.6875 MiB | 20,012 advances, at most 12 statements; 318 cleanup calls, at most 64 deletions |

The native monthly fixture generated 5,125 operation references, 2,550 visit totals and two review witnesses. The boundary fixture contains valid context relationships with 100-character identifiers and 207-character relationship keys. It deliberately has no attendance-derived rows. Its relationship rows use 19,713 overflow pages, accounting for 80,744,448 bytes. It fits the provisional allowance with 10.3125 MiB remaining.

Cleanup removes all private rows and returns used pages to the baseline. Allocated file sizes remain at their peak until local VACUUM. This does not establish remote D1 storage reclamation. The boundary run sampled 304,016,688 bytes across local database and journal files; that is neither its D1 database size nor a guaranteed filesystem peak.

The allowance remains provisional. A mixed profile combining long identifiers with derived attendance rows, fragmentation, concurrent application growth and deployed measurements must still be assessed. [Monthly evidence](../tmp/native-month-admission20-v2/measurement-final.json) and [boundary evidence](../tmp/staging-boundary20/evidence.json) preserve the exact scopes and unchanged baseline hashes.

## Native local D1 usage

An independent local workerd/D1 run authenticated the same native month, completed verification and cleaned every private row. It preserved actual result metadata for every statement, with zero missing observations or failed batches. The destination contained no source attendance, visit, correction or profile rows.

| Phase | Native rows written |
| --- | ---: |
| Staging parts | 57,292 |
| Runner advances | 65,958 |
| Cleanup | 22,031 |
| Other lifecycle statements | 7 |
| **Entire lifecycle** | **145,288** |

The lifecycle reported **2,260,346 rows read across 295,722 statements**. It took 64.308 seconds inside local workerd. The isolated database started at 675,840 bytes and peaked at 41,365,504 bytes. Its empty baseline differs from the populated SQLite allocation study above. See [native usage evidence](../tmp/native-month-d1-usage/measurement.json).

These are local D1-reported observations, not deployed CPU or account billing evidence. The measurement runs inside one local request to avoid host transport exhaustion; it does not claim a production invocation can execute the whole lifecycle. The existing runner bounds still apply separately to each advance.

Even this local write count exceeds the documented Free-plan daily allowance of 100,000 writes before reserving headroom for normal operations or other account activity. Unattended archiving therefore requires an explicit daily background budget, conservative reservations and resumable pauses across days. Statement limits alone do not solve that requirement. No paid upgrade has been requested or applied.

## Remaining work

Implement [durable lifecycle tracking and abandoned cleanup](archive-staging-lifecycle-plan.md), daily pacing and alerts. Then complete immutable publication, exact request locators, R2 receipt resolution and independent published-v2 restoration without original source rows. Historical interval authority, archive-aware reports and corrections, addenda, holds and removal fences must precede source eviction.

Unmatched exceptional-departure time correction remains a separate unfinished feature. Live backup delivery and independent populated cloud restoration, deployed capacity, physical iPad and staff acceptance, customer ownership and handover remain required.

No live deployment, migration, data mutation, upload or paid upgrade occurred. The last verified Cloudflare installation remains empty on schema 1–4, with automatic backups disabled and export-token approval pending. Railway remains available. The production-readiness goal stays active.
