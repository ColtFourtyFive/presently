# Resumable archive verification checkpoint

September 16, 2026. Application version `0.1.0`, local schema 19. This is local engineering evidence, not production or center acceptance.

## Verified release source

The integrated suite passed **340 tests across 32 files** in **119.29 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `df0faae287d69581db1f8623b219db772a82d3fd7297cddc44edf31f7e0aada6` covers 184 files and matched before and after validation.

Artifact hashes and the unchanged-source check are recorded in [checkpoint evidence](../tmp/semantic-runner-checkpoint-evidence-20260916.json). Full test results are [JSON](../tmp/integrated-semantic-runner-final-tests.json) and [log](../tmp/integrated-semantic-runner-final-tests.log). This supersedes schema 18 as the latest fully verified local source. Earlier dated measurements remain historical evidence.

## What changed

One authenticated v2 monthly base can now be semantically verified across durable bounded steps. The job checks relationships, original accepted receipts, request fingerprints, audit attribution, operation ordering, final visit state and exact review-resolution witnesses. The full verifier and resumable runner share record and fold rules; differential tests compare their decisions.

Each advance has an enforced 40-statement ceiling, a 1 MiB cumulative decoded-record limit, a separate 48 KiB header limit, and an 8 KiB cursor limit. Visits fold at most eight operations per step, with a 2,048-operation and 4 MiB source-record ceiling per visit. The private runner checks generation, snapshot identity, revision and lease before each mutation transaction. Lost responses resume committed work without duplicate totals. Invalid checkpoints, including completed ones, fail permanently with bounded diagnostic codes.

The independent parity fixture closes its source database before verifying in a separate empty native D1 database. Three valid profiles completed in 82, 82 and 83 calls. The largest observed call used **26 SQL statements**, below the enforced ceiling. Ten invalid-evidence profiles were rejected. A separate bundled test executes orchestration, concurrent requests and replay inside local workerd. These figures do not establish deployed Worker CPU or D1 capacity.

Recovery invalidates jobs and clears leases while preserving original generation, provenance, cursors, derived evidence and diagnostic codes. Bounded private cleanup removes the new derived tables before the original staging tables. Backup inventories include all four new private tables.

## Migration and storage evidence

Final DDL SHA-256 for migration 19 is `68f7092284ee1344e6473403d76a1b3e605e77e42b0f48159e9c44a97e16f43a`. Both final rehearsals contain this hash.

| Isolated rehearsal | Result |
| --- | --- |
| Saved empty native export, schema 4 to 19 | 90.67 ms in local workerd/D1; source values, maintenance fence, deliberate final-statement rollback, integrity and foreign keys verified |
| Populated synthetic fixture, schema 6 to 19 | 8.01 seconds in local SQLite; all original fields, 120,940 logical audits and 120,000 accepted receipts preserved; rollback, maintenance, integrity and foreign keys verified |
| Bounded history backfill | 365 calls of at most 500 records; 120,940 permanent keys, 60,000 visit heads, zero archive locations; 4.124 seconds in local SQLite |
| Closed and vacuumed populated database | 133,775,360 bytes before backfill; **175,075,328 bytes** afterward; no source eviction |

See the final [empty migration](../tests/empty-native-migration-results-19-final.json), [populated migration](../tests/full-release-migration-results-19-final.json), [backfill](../tests/history-lookup-scale-results-19-final.json), and [parity metrics](../tmp/semantic-runner-parity-metrics-340.json). Provisional schema 19 evidence is retained under `-provisional` filenames and does not replace these final results.

## Remaining activation gates

The runner is internal. It accepts one monthly base with no references or addenda. It does not publish archives, activate R2 receipt lookup, remove source records or schedule work. Staging byte/concurrency admission, abandoned cleanup scheduling and deployed resource measurements remain required. The format's 512 MiB ceiling is not an operational Free-plan budget.

Next implement admission limits, immutable publication and exact authenticated receipt locators, then independently restore and replay accepted requests without original attendance/correction/visit rows. Historical intervals, archive-aware reports and corrections, addenda, holds and safe eviction follow. Unmatched exceptional-departure time correction remains a separate product gap.

No remote deployment, migration, upload, paid upgrade or live data mutation occurred. The last verified live Cloudflare installation remains empty on schema 1–4. Automatic backups remain disabled and the export-token approval remains pending. Railway stays available. Live R2 delivery and independent populated recovery, deployed capacity, physical iPad/staff acceptance and customer-owned handover remain open.
