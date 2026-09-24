# Storage and CPU audit

Measured September 15, 2026. No paid plan or deployment change was made for this investigation.

## September 22 capacity update

Schema 40 reran the same 400-operating-day workload after the conditional-roster polling and query-planner fixes. The current benchmark fixture allocates 235,163,648 bytes, about 224 MiB. The fuller archive and recovery rehearsal allocates 262,729,728 bytes after it adds staging, verification, retention, and backup state. The new indexes stop student profiles, report visit resolution, and retention candidate selection from scanning unrelated center history. Student detail reads 291.4 rows per open and the first 30-day history page reads 5,595. The conservative daily projection, including two complete 30-day exports, is about 2.58 million rows at 30-second polling and 2.88 million with 100 students present all day at 10-second polling. Both remain below the 5-million-row daily reference allowance. The recovery rehearsal published 8,267 records, verified all 25 retention candidates, backed up all 96 tables plus one archive reference, and independently restored exact counts with database integrity `ok` and zero foreign-key violations. Source eviction remained blocked. The complete fixture still exceeds the desired 90 to 120-day live window. Authenticated R2 archives and source eviction therefore remain part of the production design, but source eviction stays disabled until a populated independent cloud restore, deployed capacity run, retention approval, and separate enablement release all pass.

The new indexes stop student profiles and report visit resolution from scanning unrelated center history. Student detail fell from about 76,083 to 291 rows read per open. The first 30-day history page fell from 65,457 to 5,586. The conservative daily projection, including two complete 30-day exports, is now about 2.63 million rows read at 30-second polling and 2.93 million with 100 students present all day at 10-second polling. Both are below the 5-million-row daily reference allowance.

The complete fixture still exceeds a desired 90–120 day live window. The authenticated R2 archive and source-eviction code therefore remain part of the production design. Source eviction is disabled until a populated independent restore, deployed capacity run, retention approval, and separate enablement release pass. The figures below document the earlier schema investigation and explain why archive validation remains necessary.

The 248 MB figure describes the September 15 schema's physical storage for **one center**. Most of it is attendance response snapshots, repeated audit data, and the tables and indexes around those records. It is not evidence that the center needs paid hosting. Continue on Free while reducing duplication and validating the deployed workload.

## Which explanation is supported?

| Hypothesis | Finding |
| --- | --- |
| Many centers in the fixture | No. One center, 340 students, 60,000 visits, 120,000 observations, 600 corrections, and 120,940 audit rows. |
| Full snapshots instead of compact records | Yes. `attendance_events.result_visit` stores a full accepted visit-summary JSON object for every arrival and departure. Those strings alone contain 56,978,844 bytes, averaging 475 bytes per event. A separate audit row repeats the event identity, actor, action, times, and other event data. Correction records contain relevant prior/new timestamps, not full student snapshots; they are a small part of the total. |
| Photos, signatures, or other blobs | No. No attachment data is generated and no stored BLOB values were found. |
| Unvacuumed free pages | Not the main cause. `freelist_count` is zero. `VACUUM` reduces the database from 248,168,448 to 235,548,672 bytes: 12.6 MB, or 5.1%. This is page packing, not a mostly empty database. |
| Junk padding | No large padding was found. Synthetic authority and correction notes are short; all 600 correction reasons total 123,600 bytes and all 680 authority notes total 94,588 bytes. Repeated JSON keys and identifiers contribute much more. |

MB in this report means 1,000,000 bytes. The earlier 248,389,632-byte benchmark also performed live-roster/action probes inside its temporary database. This reproduction isolates the unchanged historical generator, so it is about 0.22 MB smaller. Both measurements are local Miniflare/workerd D1 evidence, not the size of the live Cloudflare installation.

## Physical storage

The following includes each table's indexes; do not add the index total again.

| Record group | Allocated MB |
| --- | ---: |
| Attendance events, accepted response snapshots, and indexes | 149.65 |
| Audit entries and indexes | 58.50 |
| Visits and indexes | 38.87 |
| All other schema and records | 1.14 |
| Total | 248.17 |

All indexes together consume 58.25 MB, already included above. Text UUIDs and repeated timestamps occupy both table rows and index keys. The database passes SQLite integrity and foreign-key checks. Ordinary SQLite record/page overhead remains even after compaction.

One realism issue goes in the opposite direction from padding: the fixture uses 36-character UUID strings for `payload_hash`, while real requests store 44-character base64 SHA-256 strings. Across 120,000 observations that understates this field by 960,000 bytes before page effects. These results should not become a production capacity guarantee.

## Measured schema candidates

| Disposable-copy experiment | Database MB |
| --- | ---: |
| Current historical fixture | 248.17 |
| `VACUUM` only | 235.55 |
| Compact accepted-response representation, then `VACUUM` | 173.96 |
| Compact responses, physical audit deduplication, partial open-visit index, then `VACUUM` | 114.02 |

The compact representation is a versioned array of frozen names, student code/active status, arrival times, actor/guardian names, and accepted visit version. Other response fields can be derived from the immutable event. All **120,000 persisted compact arrays were decoded and compared with their original response objects**, with equal field values in this fixture.

The snapshots cannot simply be discarded or rebuilt from today's student and visit records: retrying an arrival after checkout must still return the original accepted arrival response. The existing attendance tests require this. Names, active status, corrections, and review resolution can also change later. Unmatched exceptional departures use the JSON text `null` as a sealed receipt; SQL NULL has different trigger semantics.

Attendance audit entries can be exposed as a logical projection from immutable observations instead of stored twice. Correction audits have similar duplication. A unified audit query/view, export and backup compatibility, pagination, and migration tests must exist before removing physical duplicates. The experiment measures physical savings; it does not implement that replacement.

The live-roster index can cover only open visits, while retaining the separate unique constraint that prevents two open visits for one student. This saves about 4.2 MB relative to the vacuumed baseline. Other event and history indexes have concrete query uses and were retained.

The counterfactual copies deliberately remove immutability guards only within isolated diagnostic files. They are not application migrations. The measured schema cleanup reaches about **114 MB, not 20 MB**, before additional identifier/receipt optimizations or archiving.

## Historical archive tier

The supplied requirements call for records to remain reviewable and retained for at least two years. They do not require all history to remain in D1 or establish a two-second historical retrieval target. See [the source requirements audit](../../research/requirements_audit.md).

The local archive experiment moved 21 completed months containing 51,300 visits, 102,600 observations, 513 corrections, and 103,113 linked audit rows into full-field JSONL bundles. It retained 8,700 visits. As of September 15, the complete-month cutoff was June 1, leaving 106 days of detailed attendance.

| Archive sizing experiment | MB |
| --- | ---: |
| Remaining detailed live dataset, before archive catalog/index implementation | 35.03 |
| Same dataset plus one conservative design with historical ID and visit-interval references in D1 | 78.55 |
| Complete archived JSONL before compression | 210.58 |
| Gzip using the fixture's patterned UUIDs | 8.55 |
| Gzip after replacing UUID identities consistently with same-length pseudorandom identifiers | 23.53 |

The identifier sensitivity check matters: patterned synthetic IDs make compression look unusually effective. It preserves identifier lengths and relationships, but the remaining names, notes, and workload still come from a synthetic fixture. Encryption framing, operational copies, future correction addenda, and backup retention are not included in these sizes.

Every compressed bundle passed decompression, hash, JSON, and record-count checks. The disposable D1 eviction copy passed foreign-key checks and retained-plus-archived counts reconciled to the source. The 35 MB figure is a detailed-data footprint, **not a complete archive implementation**. The extra 43.52 MB in the conservative design illustrates the cost of keeping historical lookup references live; those indexes can instead live in R2 with an appropriate reader. Neither design's deployed latency or combined D1/R2 recovery has been verified.

Keep current profiles, open visits, unresolved cases, and any held records live. Moving completed historical months to R2 leaves roughly 90–120 days of detailed attendance in D1 when eviction occurs only for complete months. Archive complete visit evidence: original/effective times, observations, accepted responses, corrections, resolved reviews, linked audit records, and the identity context needed to interpret them.

Archives need versioned private objects, compression before encryption, a searchable catalog, integrity/count checks, and an application history reader. Publish and independently read back an archive before allowing its D1 detail to be removed. Preserve records with unresolved dependencies. Late corrections require versioned addenda and date-aware lookup; corrected dates may cross month boundaries. Old event IDs still need duplicate-request and changed-payload handling.

A monthly archive catalog can stay in D1 while detailed historical indexes live in R2. Keeping every old event and visit lookup reference in D1 is a different tradeoff with a larger footprint. The retained lookup design and remote retrieval latency need implementation and measurement. Attendance detail can be bounded; catalog growth, active profiles, holds, other CRM modules, and backup retention still need a capacity policy.

After archiving, restoring only a D1 SQL backup is insufficient. Recovery must also fetch and verify every referenced archive and correction addendum. An archive is part of the retained record, not a substitute for its own recovery protection.

## CPU correction

Cloudflare explicitly excludes time waiting on database queries and network I/O from Worker CPU. The existing benchmark measures local elapsed request/response time with `performance.now()`. Its approximately 42 ms PIN-unlock result cannot establish either a breach of or compliance with the 10 ms HTTP CPU allowance.

Ordinary attendance should be measured on the deployed Worker before drawing a pricing conclusion. The specific heavier candidates are Access verification, the existing PIN hashing, large CSV exports, import preview construction, and backup-part processing. Keep security settings intact while measuring. Student/history pagination and counts already execute in SQL; CSV export still gathers many records and builds the result in memory. Backup jobs already process one 1 MiB part per queue invocation, and full restore verification runs outside the Worker. Do not apply the HTTP CPU figure to every execution type without checking its effective limits.

The five-second full-data refresh belongs to Railway's `/api/bootstrap` flow. It is not a browser reload and it is not subject to the Workers CPU limit. It still deserves narrower queries and visible-tab polling. The Cloudflare client already polls the roster every 30 seconds, skips hidden tabs, and avoids overlapping requests.

The next acceptance evidence is deployed CPU percentiles, maximums and limit errors for normal attendance, cold/warm authentication, PIN unlock, bounded imports/exports, and backup parts. Local wall time is not that evidence. [The hosting status document](../../docs/hosting-and-import-status.md) now reflects this correction.

## Cost decision and reproducibility

Stay on Free for the investigation and optimization. Consider paid capacity only if measured required workloads still exceed the applicable limits after reasonable changes. If necessary at handover, the $5/month starting Workers Paid fee and metered usage belong to **Kumon's account**. No new hosted resources, paid plan, or paid capacity was activated for these experiments.

Run `npm run benchmark:storage` from `cloudflare/` to recreate the unchanged 400-operating-day fixture in a network-isolated temporary workerd/D1 runtime. The audit uses Python's SQLite `dbstat`, counts, column lengths, free-page metrics, and copies for experiments. Set `STORAGE_AUDIT_OUTPUT` to a fresh output directory for another run; existing evidence is not overwritten. `STORAGE_AUDIT_DAYS=2` supports a small diagnostic smoke run. The runtime is removed after the run, while aggregate results and disposable diagnostic copies stay in the selected output directory.

- [Storage audit script](../scripts/storage-audit.ts)
- [SQLite analysis and copy experiments](../scripts/storage-audit.py)
- [Full measurements](../tests/storage-audit-results.json)
- [Archive sizing script](../scripts/archive-storage-audit.py)
- [Archive measurements](../tests/archive-storage-audit-results.json)
- [Identifier compression sensitivity script](../scripts/archive-identifier-audit.py)
- [Identifier sensitivity measurements](../tests/archive-identifier-audit-results.json)
- [Original benchmark](../tests/benchmark-results.json)
- [Workers CPU documentation](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)
- [Workers metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)

## Implemented migration measurement, September 15

The exact shipped `0007_storage_compaction.sql` was applied atomically to a private copy of the 248,168,448-byte fixture. All 120,940 logical audit entries, all 120,000 immutable event fields other than the intentionally compacted receipt, and all 600 corrections retained their pre-migration hashes. Physical audit rows fell to 340 because the other rows are projected from immutable evidence. SQLite integrity and foreign-key checks passed.

The file occupied 113,557,504 bytes after local VACUUM, a reduction of about 54.2%. Before VACUUM it still allocated 248,172,544 bytes and held 62,939,136 bytes of reusable free pages. This does not establish remote D1 reclamation behavior. The local migration took 4.173 seconds of wall time; it is not a Worker CPU measurement.

Reproduce with `python3 scripts/verify-storage-compaction.py SOURCE DESTINATION --result RESULT_JSON`. Evidence: `tests/storage-compaction-results.json`. Archive eviction is still disabled.

Cloudflare now documents enforcement of Free daily D1 row limits beginning September 1, 2026. Deployed measurement must therefore include daily reads and writes, including archive/index maintenance, rather than only file size and CPU. See [D1 limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/).

### September 16 history lookup overhead

Migration 0017 adds permanent request ownership and shadow visit intervals as a prerequisite to safe archive eviction. The final full migration rehearsal through 17 preserved the same source history and occupied 133,681,152 bytes after local VACUUM, before backfill. Backfilling 120,940 request keys and 60,000 visit heads increased the closed file to 174,981,120 bytes. About 41.3 MB belongs to the new keys, heads and interval indexes. Detailed attendance is still live; eviction remains disabled.

The SQLite backfill took 365 calls of at most 500 records. Source fingerprints, integrity and foreign-key checks passed. Its 5.93-second local elapsed time is not deployed Worker CPU. See [the history lookup record](history-lookup-foundation.md) and `tests/history-lookup-scale-results-17-final.json` for the query plans and exact counts. These measurements supersede a simple compaction-only estimate for the current schema; they do not establish remote D1 reclamation or require a paid plan.

## Schema 30 student-profile read

The source-free representative student profile authenticated one archived visit and one archived correction with two unique R2 reads and 5,454 encrypted bytes. The same endpoint makes zero R2 reads when all selected detail remains in D1. The 48-object ceiling remains enforced; profiles that require more archive publications, objects or records fail with HISTORY_RANGE_TOO_LARGE instead of performing an unbounded read.

See review/student-detail-r2-measurement.json and the schema-30 archive student-detail checkpoint. This is local workerd evidence, not deployed Worker CPU evidence.
