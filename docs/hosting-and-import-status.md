# Main control center and Cloudflare deployment

Reviewed September 14, 2026. Provider limits below were checked against Cloudflare's current documentation on this date.

CPU reasoning and polling behavior reviewed September 15, 2026 against the source and official Workers and Queues limits. Deployment evidence and other allowance figures below retain their September 14 dates.

## Current installations

| Installation | Hosting and database | Status |
| --- | --- | --- |
| [Main control center](https://web-production-ce255.up.railway.app) | Railway web service, Node/Express, PostgreSQL | Active main application. Live `/api/health` reports PostgreSQL. Includes students/families, attendance, schedules, inquiries, tasks, interactions, and reports. |
| [Cloudflare feasibility build](https://kumon-center-feasibility.ochengweb.workers.dev/admin) | Workers static assets and Hono API, D1 | Separate attendance and roster build. It is not a completed migration of the main control center. |
| Cloudflare backup destination | Private Standard R2 bucket `kumon-feasibility-backups` | Provisioned with public access disabled. Pending D1 migrations, backup secrets, Worker deployment, and live backup/restore validation remain. |

These applications have separate records and authentication. Railway uses staff password sessions; Cloudflare uses Access for back-office identity and enrolled kiosks. The D1/R2 backup design applies to the Cloudflare edition. It does not export or back up Railway PostgreSQL. No customer-data cutover or synchronization has been performed.

The main control center now includes its own Import roster navigation item and a shortcut in Students & families for owners and managers. It uses the main application's PostgreSQL database. The generic CSV flow provides an empty template, column mapping, a field-level preview, explicit duplicate decisions, resumable batches, and receipts. Files are limited to 500 rows, 40 columns, and 512 KiB. Kumon-specific export mapping and historical migration remain pending the actual export format.

The full root test suite and production build passed on September 14, 2026, including 12 importer integration tests. A disposable local center passed browser checks for empty startup, upload and mapping, preview and confirmation, creation, update with omitted fields preserved, receipt reopening, invalid UTF-8 rejection, guardian pickup authorization remaining disabled, and mobile layout. A mobile overflow issue found during review was corrected; the final check showed equal viewport and document widths with mapped values expanded. No browser console errors were recorded. These checks used synthetic records in a temporary local database that was removed afterward.

Railway deployment `ecace225-ccd5-4536-9192-9a3a8f693be2` completed successfully on September 14, 2026. The live authenticated browser verified both import entry points, file/template controls, and an empty recent-import list. The student directory still showed zero students. `/api/health` returned `{"status":"ok","database":"postgres"}`; anonymous `/api/imports` returned HTTP 401. No live roster import was submitted. The live browser recorded no console errors.

## What Cloudflare Free provides

| Service | Current free allowance relevant to this CRM | Practical constraint |
| --- | --- | --- |
| Workers static assets | Free, unlimited static-asset requests | API requests invoke the Worker and have separate limits. |
| Workers API | 100,000 requests per day; 10 ms CPU per HTTP request and per Cron Trigger | Database and network waiting do not count toward Worker CPU. Authentication, PIN verification, imports, exports, and encryption need deployed CPU measurements. Queue consumers have separate documentation; do not assume the HTTP limit applies to them. |
| D1 | 5 million rows read and 100,000 rows written per day; 500 MB per database; 5 GB across the account | Tables and indexes consume storage. Hitting daily read/write limits makes database queries fail until reset. |
| D1 Time Travel | Seven days of point-in-time recovery | This does not replace two-year attendance retention or independent encrypted backups. |
| Queues | 10,000 operations per day; 24-hour retention | Sending, reading, and deleting a normal message typically use three operations; retries add work. |
| R2 Standard | 10 GB-month storage, one million Class A and ten million Class B operations per month; free direct egress | R2 bills usage beyond its included allowance. Enabling R2 does not upgrade Workers to Paid. |

Allowances are shared with other applications in the same account. Cloudflare Free has the components to host the redesigned application; it is not an equivalent place to run the existing Railway server unchanged. The current implementation ports PostgreSQL behavior to D1 and Node/Express behavior to a Worker. Remaining feature parity and operational tests must be completed before switching the main installation.

## CPU and refresh evidence

Stay on Workers Free while collecting measurements. No deployed CPU measurements currently establish that this application exceeds the free allowance. The [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time) distinguish active Worker execution from time waiting for database queries, network requests, and other I/O. Worker-side processing and serialization still need measurement. Asynchronous cryptographic calls are not evidence that their work is outside CPU accounting.

The local benchmark records elapsed request/response time with `performance.now()`, not deployed Worker CPU. Its roughly 42 ms mean for three successful PIN unlocks proves neither compliance with nor a breach of the 10 ms HTTP CPU allowance. See [the benchmark implementation](../cloudflare/scripts/benchmark.ts) and [its measurement limits](../cloudflare/docs/feasibility-evidence.md#measurement-limits-and-release-gates).

The deployed Railway release still uses the original five-second bootstrap refresh. The local replacement now polls the bounded `/api/attendance/live` endpoint every five seconds on attendance pages and every 30 seconds elsewhere. It pauses when hidden, allows one request at a time, stops after logout/idle, and reconciles full bootstrap data once per visible minute and after explicit actions. This change passed 48 root tests, TypeScript, the production build, and an isolated browser smoke. It has not been deployed. Cloudflare's HTTP CPU limit does not apply to Railway's Node/Express service.

[The Cloudflare client](../cloudflare/client/App.tsx) refreshes only the roster every 30 seconds, skips hidden tabs, and prevents overlapping roster requests. [Its records API](../cloudflare/worker/records.ts) already uses SQL pagination and count queries for students and history, and bounds the roster response. Moving all aggregation to SQL is therefore not a missing prerequisite for this slice.

The remaining CPU candidates require route-specific measurements:

- Access JWT verification and the existing 600,000-iteration PBKDF2 PIN verification. Measure cold and warm authentication without weakening the PIN settings.
- CSV import parsing, hashing, and preview construction across up to 500 input rows. The local implementation now indexes normalized names once per request; 17 import tests passed. Its algorithm benchmark reduced 250,000 candidate scans to 1,000 index additions and 500 lookups. These are local measurements, not deployed CPU.
- Attendance export. Bounded SQL keyset pages and a browser memory ceiling passed focused local tests; report revisions prevent a download from mixing changing records. Deployed measurements must cover each page and realistic complete reports.
- Backup encryption, hashing, readback verification, and manifest construction. The queue already advances one 1 MiB part per invocation with a one-message batch. It does not encrypt the entire database in one invocation. Full backup restore verification runs in local recovery scripts.

[Queues limits](https://developers.cloudflare.com/queues/platform/limits/) describe a 30-second default consumer CPU limit, configurable up to five minutes, while also linking generic account limits. That wording does not clearly reconcile with the Workers Free table. Verify the effective consumer limit before applying the 10 ms HTTP figure to backup processing.

Start with the existing dashboard's [CPU, wall-time, and invocation metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/). Use bounded synthetic workloads in isolated free-tier test resources for ordinary attendance, cold/warm authentication, PIN verification, a 500-row import, larger exports, and backup parts and retries. Record deployed CPU percentiles and maximums, CPU-limit failures, SQL rows, response sizes, and request counts. Local profiles can locate expensive code but cannot certify deployed CPU. Track shared-account allowances during testing. Unresolved acceptance does not by itself demonstrate a need for paid hosting.

## Capacity evidence and recommendation

The final schema-40 evidence resolves the 248 MB question. The current 400-day benchmark allocates 235,163,648 bytes, and the archive and recovery rehearsal allocates 262,729,728 bytes after adding staging, verification, retention, and backup state. The fixture represents one center. It contains 60,000 visits, 120,000 observations, and duplicate live and historical authority because source eviction is disabled. It contains no photos, signatures, padded junk, or meaningful free-page bloat. The isolated rehearsal published 8,267 records, verified 25 retention candidates, backed up all 96 tables and one archive reference, and restored exact counts with database integrity `ok`. These are local results. Live Worker-to-R2 delivery, independent customer-account restoration, deployed CPU, and remote D1 allocation remain open.

The September 15 [storage and CPU audit](../cloudflare/docs/storage-and-cpu-audit.md) now explains the earlier size. One center reproduces at 248.17 MB; attendance events and their indexes use 149.65 MB, audits 58.50 MB, and visits 38.87 MB. There are no blobs or free pages. `VACUUM` saves only 5.1%. Full accepted-response snapshots and duplicated audit records are the main avoidable costs. A local compact-receipt/audit-deduplication/index candidate measures 114.02 MB.

Archiving complete older months leaves 35.03 MB of detailed live data in a disposable clone, or 78.55 MB with one conservative design that also keeps historical lookup references in D1. Compressed archive data measures 23.53 MB after replacing patterned synthetic UUIDs with same-length pseudorandom identifiers. These are sizing experiments. The shipped compaction migration now measures 113,557,504 bytes after local VACUUM and preserves all source/audit hashes. Verified archive copying and combined D1/R2 recovery are implemented and tested locally, with provider exports mocked. The owner/manager copy reader passed 15 API tests and isolated browser checks. It still requires retained D1 source rows. Guarded eviction and correction/retry handling after removal remain unfinished, so archive copying currently saves no D1 space. Remote D1 reclamation remains unverified. The later schema-15 fixture, including report/audit indexes, measured 130,924,544 bytes after local VACUUM; final-index revisions require an updated measurement.

The isolated two-year attendance fixture occupies 248,389,632 bytes, about 248 MB. It includes 340 students, 60,000 historical visits, 120,000 historical observations, linked guardians, corrections, and audit records. It does not include the unported schedules, inquiries, tasks, and interactions. Its projected normal workload is 3,662 API requests, 745,580 D1 rows read, and 4,092 rows written per day, excluding parts of the backup pipeline and other CRM/account activity. These are partial local measurements, not live production capacity.

Free-plan acceptance is unresolved, particularly for CPU, storage growth, full-size encrypted backup/export, retention, concurrency, and bursts. Do not weaken PIN hashing or delete required records to fit a free allowance.

Do not upgrade based on local wall time or an unmeasured CPU assumption. Consider Workers Paid only if deployed measurements and reasonable optimizations show that a required workload cannot meet the free limits. If that becomes necessary, its current starting fee is $5 per account per month plus metered overages, and the paid D1 per-database limit is 10 GB. Any eventual Workers Paid subscription and usage charges belong to Kumon's own Cloudflare account at handover. R2 remains separately metered. The final monthly estimate needs full-workload and backup-retention measurements.

Before a full cutover, finish feature parity in the main interface, rehearse data migration and reconciliation, demonstrate live backups and restoration, validate supported devices and access, measure capacity, and agree on the customer's operating and recovery procedures. Keep Railway active until the replacement passes acceptance.

## Sources

- [Workers CPU and account limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers CPU and wall-time metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers static-asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 pricing and quota behavior](https://developers.cloudflare.com/d1/platform/pricing/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Local feasibility measurements](../cloudflare/docs/feasibility-evidence.md)
