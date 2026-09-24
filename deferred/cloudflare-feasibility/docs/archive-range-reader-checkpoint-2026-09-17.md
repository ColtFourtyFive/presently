# Archive range reader checkpoint: 2026-09-17

Production release remains pending. This checkpoint adds bounded, authenticated reads for compact schema 29 archives. It does not authorize source eviction or a live migration.

## Implemented behavior

- `GET /api/admin/history/events` merges live D1 observations with authenticated encrypted R2 observations for the requested date and optional student.
- Attendance report counts and correction, observation, and unmatched pages include authenticated archive evidence. Visit rows remain authoritative in D1.
- Report generations bind the center, exact date range, timezone, exporter identity, report runtime generation, and archive authority. A change between pages returns `REPORT_CHANGED`.
- Live rows claimed by a ready compact publication are excluded from the live half of a merged result. Duplicate ownership, missing objects, invalid receipts, changed authority, and incomplete retained visits fail closed.
- Empty results and completed merged pages recheck the complete D1 archive selection before returning.

## Request bounds

One request accepts at most 16 overlapping publications, 48 R2 object reads, and 40,000 authenticated archive records. A range that exceeds a publication, object, or record bound returns a shorter-range response instead of attempting an unbounded Worker invocation.

Archive records are sorted by immutable table and key in the current format. A range read therefore authenticates every part containing a requested table in each overlapping publication. Later visit-report pages authenticate only each manifest because they use retained D1 visit rows and do not consume archived event records.

History page merging materializes at most the authenticated archive cap plus one page of live rows. Deep page requests use a calculated live offset; they no longer allow a 500,000-row Worker result.

## Representative measurement

The source-free 14,295-record January 2025 fixture restored 57 encrypted objects, reset recovery authority, completed history backfill in 80 calls, rebuilt semantic proof in 16,860 calls, and completed compact reconciliation in 2,430 calls. Every measured path used one ready publication and one stable authority digest.

| Path | Authenticated records | Unique R2 reads | Encrypted bytes read | Local elapsed |
| --- | ---: | ---: | ---: | ---: |
| History events | 5,101 | 22 | 1,006,306 | 459.63 ms |
| Initial report | 5,128 | 22 | 1,006,306 | 298.09 ms |
| Later visit page | 0 | 1 | 63,742 | 15.22 ms |
| Correction page | 25 | 2 | 103,253 | 25.28 ms |
| Observation page | 5,101 | 22 | 1,006,306 | 283.33 ms |
| Unmatched page | 5,103 | 22 | 1,006,306 | 213.43 ms |

Every object key was read once per request. The largest measured path used 22 of the 48 allowed reads. The measurement file is `review/archive-range-representative.json` in the isolated candidate.

Local elapsed time is diagnostic only. It is not deployed Worker CPU. Deployed CPU, D1 rows read, R2 operation counts, and concurrent report/import/backup load remain release gates.

## Validation

The promoted root release passed TypeScript checking and the production build. The focused archive range, report, and compact recovery run passed **23/23 tests across 6 suites**. The full root regression passed **781/781 tests across 152 suites** in **1,169.25 seconds**.

The release fingerprint stayed `dc64b4ddf27731af612226f94b8938859eb3ca307f97e304237437940ed651fe` across **289 files** before and after validation. Wrangler 4.100.0 completed `deploy --dry-run`, packaging 60 static assets and a 406.50 KiB Worker upload, 96.99 KiB compressed. A dry run checks build and packaging only; it does not establish deployed bindings, quotas, CPU time, or runtime behavior.

The earlier isolated candidate full run retained in `review/archive-range-full-regression.json` reported two process-level `STACK_TRACE_ERROR` failures in `archive-reconciliation-recovery.test.ts`. That unchanged suite passed 6/6 when rerun alone. The promoted root then passed the complete suite without the runner error. Machine-readable root results, before/after fingerprints, focused results, representative measurements, and the Wrangler log are retained in `.installation-work/archive-range-candidate/review/`.

The representative run found and fixed one restored-authority defect. A reconciliation receipt contains the fresh recovery proof identity, while its immutable descriptor identifies the original publication. Comparing both proof identities directly rejected every valid restored publication. The reader now validates the fresh receipt fields and binds its descriptor and counters to the original publication. A restored-generation test covers this path.

## Remaining limits

- Visit detail still depends on retained D1 visits. Student correction history still needs archive integration.
- Historical corrections need an authenticated addendum workflow before old source rows can be removed.
- Legal and operational holds, expiry scheduling, and the actual source-eviction transaction remain unfinished.
- Multi-month reads may reach the 48-object cap. Deployed measurements will decide whether the current bounded scan is sufficient or needs a compact D1 range index or authenticated R2 report sidecar.
- A Worker-driven R2 backup and independent populated restore drill, Railway cutover and rollback, physical iPad and outage exercises, staff acceptance, and Kumon-owned handover remain open.

No Railway or Cloudflare resource changed during this checkpoint. The live Cloudflare installation remains at the previously recorded empty schema 1 through 4 state, and Railway remains available.

Evidence is retained in `.installation-work/archive-range-candidate/review/`.

## Successor checkpoint

Historical visit pages and attendance-report visit phases now use retained heads plus authenticated R2 visit detail. See [the archive visit authority checkpoint](archive-visit-authority-checkpoint-2026-09-17.md).
