# Cloudflare feasibility evidence

Measured September 22, 2026 for application `0.1.0`, local schema 40. This is local capacity and correctness evidence. It does not prove deployed Worker CPU, live backup delivery, independent cloud restoration, device acceptance, or production readiness. Railway and the empty live Cloudflare database were not changed.

## Validation result

The serialized release run passed all 880 tests in 87 files and 186 suites. TypeScript, the production build, and a Wrangler 4.115.0 customer-config `--dry-run` also passed. The tests bundle the product Worker and run it in workerd with temporary D1 databases. Provider calls use bounded test doubles unless a test explicitly exercises a local Cloudflare runtime binding.

Two new scale checks protect the capacity fix:

- Student detail stayed below 150 D1 rows after adding 4,000 unrelated visits and 200 unrelated corrections.
- A 100-row attendance report page did not gain more than 40 D1 reads after adding 4,000 unrelated center visits.

The SQL control route and D1 counters exist only in the test bundle. The production Worker does not expose them.

## 400-operating-day dataset

`npm run benchmark -- --days=400` created one center with 340 students, eight staff, 460 guardians, 680 guardian relationships, 60,000 historical visits, 120,000 attendance observations, and 600 corrections. The period runs from September 16, 2024 through September 21, 2026. Normal and peak probes add 102 current visits and 104 attendance observations.

| Measurement | Result |
| --- | ---: |
| Final visits | 60,102 |
| Final attendance observations | 120,104 |
| Final correction records | 600 |
| Current local D1 allocation | 235,163,648 bytes, about 224 MiB |
| Tables observed | 108 |
| Complete table-scan lower bound | 425,057 rows across 982 statements |
| JSON produced by that scan | 180,054,062 bytes, about 172 MiB |

The file is well below the 500 MB per-database reference limit, but it already contains a large retained attendance history. Schema 40 adds three indexes that remove center-wide scans. Those indexes add storage. Long-term production still depends on proving the configured live window, authenticated R2 archive, combined recovery, and source eviction. Source eviction remains disabled.

Schedules, interactions, inquiries, and tasks exist in the release but the growth fixture does not populate them. Their production volume remains an input to deployed capacity acceptance.

## Measured request footprints

The benchmark separates changed snapshots from unchanged polls. Changed roster responses include the current visit payload. Unchanged requests read the revision and return no roster rows.

| Action | Mean D1 rows read | Statements | Local wall time |
| --- | ---: | ---: | ---: |
| Admin unchanged roster poll | 2 | 2 | 1.4 ms |
| Kiosk unchanged roster poll | 4 | 3 | 1.8 ms |
| Admin changed roster, 20 present | 63 | 4 | 2.8 ms |
| Admin changed roster, 100 present | 303 | 4 | 2.6 ms |
| Student search | 392 | 3 | 2.8 ms |
| Student detail | 291.4 | 7 | 3.3 ms |
| History page | 5,595 | 8 | 29.4 ms |
| 30-day export visit page | 12,266.9 | 13.2 | 23.3 ms |
| 30-day export observation page | 10,061.7 | 10 | 18.2 ms |
| 30-day export correction page | 15,120 | 10 | 20.3 ms |
| 30-day export unmatched page | 129,677 | 11 | 400.7 ms |

The unmatched phase is the largest single request and remains a deployed CPU and D1 measurement target. It runs twice in the conservative daily projection, once per full export. Page responses are bounded, and the client traverses every phase with coherent epoch, generation, and continuation cursors.

Schema 40 fixes two query-planner failures found by the benchmark. Student detail previously read about 76,083 rows per open. A report page resolving 100 visit IDs previously scanned nearly every center visit. The new center/student/time, center/visit-ID, and retained-head indexes reduce those reads while preserving archive authority checks, provenance, and retry behavior.

## Daily projection

The operating model uses three admin browsers and one kiosk for six hours, 300 attendance changes, 120 searches, 240 student-detail opens, 12 history pages, and two complete 30-day exports. Changed roster reads are modeled after attendance writes; remaining polls use the conditional revision response.

| Scenario | API requests | D1 rows read | D1 rows written |
| --- | ---: | ---: | ---: |
| 30-second polling, 20 present | 4,112 | 2,577,377 | 7,252 |
| 10-second polling, 20 present | 9,872 | 2,591,777 | 7,252 |
| 10-second polling, 100 present all day | 9,872 | 2,880,737 | 7,252 |

Rows are rounded up. All three projections are below the 5-million-row daily reference allowance, including the two full exports. They are workload estimates rather than cloud quota guarantees. They exclude scheduled backup and archive work, device provisioning, imports, broader edits, other customer-account workloads, and shared account consumption.

Polling frequency now has little effect because unchanged polls cost two or four rows. The two full exports contribute most of the daily reads. Production monitoring should record their actual frequency and range.

## Archive and recovery rehearsal

The isolated 400-day recovery rehearsal measured a 262,729,728-byte source database after it added archive staging, verification, retention, and backup state. It published September 2024 as 8,267 authenticated records in 33 encrypted archive parts. The publication covered 5,138,517 plaintext bytes and completed 9,629 semantic advances plus 684 compact-publication advances.

The retention dry run verified all 25 candidates and then returned `SOURCE_EVICTION_DISABLED`, which confirms that the default release cannot delete the source rows. The backup captured all 96 tables and one archive reference in 209,089,887 bytes of SQL split into 200 encrypted parts. A separate recovery process verified the bundle, restored exact counts for all 96 tables, returned `ok` from SQLite integrity checking, found no foreign-key violations, and reconciled the compact archive after the recovery reset. Local recovery took about 2.62 seconds.

This result explains the large fixture. The database keeps 60,000 visits, 120,000 observations, and duplicate live and historical authority because source eviction is disabled. It contains no photo, signature, or other blob payloads and no synthetic padding. The rehearsal did not use the Cloudflare export API, a deployed Worker, remote D1, or an independent Cloudflare account. It deleted no source row or R2 object.

## CPU and release limits

The benchmark records local elapsed time. D1 wait time does not establish Worker CPU usage. These numbers neither prove compliance with nor prove a breach of Cloudflare's deployed CPU limits. Measure normal attendance, Access verification, PIN unlock, import, every report phase, and backup queue work on the deployed customer installation.

The local capacity result supports continuing on the free plan for acceptance testing. It does not guarantee that the final customer workload fits Free. If deployed evidence requires paid capacity, the plan and charges belong to Kumon's account.

Production release still requires:

1. Customer-approved `CF_EXPORT_API_TOKEN` and external `BACKUP_ALERT_URL` secrets.
2. Successful manual and scheduled Worker-to-R2 backups with delivered failure and stale-backup alerts.
3. A populated restore into an independent customer-controlled installation, including every referenced archive object and D1 Time Travel evidence.
4. Deployed CPU, D1, Queue, R2, concurrency, and growth measurements with accepted headroom.
5. Physical iPad, outage, staff workflow, training, Railway cutover, ownership, and written acceptance evidence.

The machine-readable benchmark is [benchmark-results.json](../tests/benchmark-results.json). The release evidence is in [the customer handover review directory](../review/customer-handover-package/validation-summary.md).
