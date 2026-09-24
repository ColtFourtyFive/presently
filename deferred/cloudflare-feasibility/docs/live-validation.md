# Cloudflare feasibility deployment validation

Updated September 22, 2026, Pacific time, application version 0.1.0. This record separates implementation, local validation, live observations, and external acceptance. It does not approve center operations or certify the supplied Kumon requirements.

**September 22 local release:** Schema 40 passes 880/880 tests across 87 files and 186 suites, TypeScript, production build, Wrangler 4.115.0 customer-configuration dry run, and the 400-operating-day archive recovery rehearsal. Release fingerprint `a3206c7ab0407ceaf0278c720c4843515b7050100cebbcee3b1ea0b143ba297a` covers 333 files. This release is deployed only to the isolated acceptance installation described below; the earlier feasibility installation remains unchanged on schema 4.

The fingerprint above predates the later backup-error, report-polling, and history-date performance fixes. Those fixes are deployed only to the isolated acceptance Worker. The customer handover package must be regenerated and verified against a sealed source snapshot before release.

**September 17 local update:** schema 29 compact publication, receipt dispatch, restored-generation reconciliation, legacy audit-alias recovery, and representative retained measurement pass locally. The repaired release passes 771/771 tests across 150 suites, TypeScript, and the production build. The retained post-expiry database measures 8,331,264 bytes locally. Live deployment, source eviction, and remote capacity validation remain pending; the live installation recorded below is unchanged.

**Last verified live state, September 22 at 1:22 PM Pacific:** isolated acceptance Worker `kumon-crm-acceptance-20260922` runs schema 40 version `efd69edc-c3b5-4d9d-a8e6-fb3a16c8534d` behind owner-only Access. Its original D1 binding is restored. It contains one synthetic student, zero visits, and two failed backup jobs. The private R2 bucket has zero objects. `BACKUP_KEY` and a short-lived D1 Read export token are configured, but Cloudflare rejected the export request with HTTP 401. `BACKUP_ALERT_URL` is missing and automatic backups are disabled. The feasibility D1 still has zero students and visits. Railway remains unchanged. See the [acceptance backup evidence](../review/customer-handover-package/acceptance-backup-permission-2026-09-22.json) and [1,500-visit deployed CPU checkpoint](../review/deployed-capacity-2026-09-22/export-page-cpu-1500-checkpoint.json).

## September 22 read-only inventory refresh

- Wrangler authentication is valid for the feasibility account.
- The latest Worker deployment remains the September 16 feasibility version; schema 40 has not been deployed.
- D1 read metadata reported schema version 4, 24 total tables and 23 application tables, 331,776 bytes, and no student, visit, or backup-job rows. Query metadata reported zero rows written.
- R2 bucket `kumon-feasibility-backups` is Standard storage in WNAM. Its r2.dev endpoint is disabled and it has no custom domains.
- Queue `kumon-feasibility-backups` reports one producer and one consumer.
- Secret-name inventory contains only `BACKUP_KEY`. Export permission and alert transport remain the immediate backup activation blockers.
- Structured evidence is stored in [the read-only audit record](../review/customer-handover-package/live-readonly-audit-2026-09-22.json).

## Live installation inventory

| Resource | Recorded value | Evidence and limit |
| --- | --- | --- |
| Test account | `ochengweb@gmail.com` · `cd7fb7f2adb6b28c0ac2749897c58cd6` | Feasibility account; customer ownership remains pending. Wrangler read-only access was reconfirmed September 22. |
| Zero Trust plan | Free | Recorded Zero Trust plan, not a guarantee of free operation across all products or workloads. No paid upgrade was made during this review. |
| Worker | [kumon-center-feasibility.ochengweb.workers.dev](https://kumon-center-feasibility.ochengweb.workers.dev) | Latest listed deployment was created September 16 at `2026-09-16T02:46:36.056Z`, version `2725bbc7-7959-4b44-b90a-1e22cec6dc1a`. It is the feasibility edition, not schema 40. |
| D1 | `kumon-crm-feasibility` · `c1d5ddec-930b-4a47-a5e9-d5261cb9c101` | September 22 read-only check: schema 1–4, 24 total tables and 23 application tables, 331,776 bytes, students 0, visits 0, backup jobs 0, rows written 0. |
| R2 | Standard bucket `kumon-feasibility-backups` | Provisioned private bucket; public r2.dev access disabled and no custom domains connected. Existence is not proof of backup delivery. |
| Queue | `kumon-feasibility-backups` | September 22: one producer and one consumer. Successful scheduled backup processing remains unverified. |
| Cron | Every five minutes | Trigger deployed. Automatic backup activation has not been completed or validated. |
| Worker secrets | `BACKUP_KEY` | September 22 secret-name inventory contains only `BACKUP_KEY`. `CF_EXPORT_API_TOKEN` and `BACKUP_ALERT_URL` are missing. Independent customer key custody remains open. |
| Access application | `69fe811f-cb77-4c89-bbcf-f95bcbe8f30d` | Protects `/admin` and `/api/admin`. |
| Access allow policy | `017e8a4a-9cc4-4d0a-b930-b9712f68486f` | User-approved owner-only rule. HttpOnly Access cookie setting enabled at the recorded checkpoint. |
| Earlier Google project | `ocheng-kumon-feasibility` · `Kumon CRM Feasibility` | Created for the previous Drive integration. The user later reported OAuth client creation complete. No Google delivery/restore is claimed; OAuth is unnecessary for the selected R2 path. |

The September 14 native migration import applied four versions and reported 100 queries in 18.05 ms. Before owner bootstrap, the installation reported 23 tables and 331,776 bytes. Preserve these as installation observations: they are not Worker CPU or populated-workload measurements. The later September 15 size above is a separate current check.

These resource identifiers are for handover and troubleshooting. Credentials, session cookies, PINs, tokens, and recovery keys must not be recorded here. The current tree has not been packaged as an accepted customer release.

## Live checks completed, September 14

The owner signed in through the Cloudflare identity provider in a real browser. The application verified an RS256 Access JWT and loaded the staff workspace with an empty roster. This confirms that owner sign-in and roster read at that checkpoint; it does not establish MFA, every denial boundary, offboarding, or owner recovery.

| Unauthenticated request | Observed response | Scope |
| --- | --- | --- |
| `GET /api/health` | HTTP 200, `{"ok":true,"version":"0.1.0"}` | Public health response. |
| `GET /admin` | HTTP 302 | Access redirected the browser entry point. |
| `GET /api/admin/session` | HTTP 302 | Access redirected the session request. |
| `GET /api/admin/students` | HTTP 302 | Access redirected the student request. |
| `GET /api/kiosk/roster` | HTTP 401 | Kiosk roster unavailable without credentials. |
| `GET /api/kiosk/status` | HTTP 200 | Public status response; not roster authorization. |

No live student creation or attendance writes are claimed. Student, arrival, kiosk, and departure UI exercises used disposable local D1. September 15 CLI reauthentication is a developer-credential check and does not replace the browser/device acceptance tests.

## Local evidence by checkpoint

| Date/checkpoint | Passing evidence | Scope and limit |
| --- | --- | --- |
| September 14, initial Google-era checkpoint | 72 tests across seven files; TypeScript/build passed; production dependency audit reported zero vulnerabilities. | Historical checkpoint, including eight recovery and 17 installer tests. Does not describe the current feature set or prove provider delivery. |
| September 14, R2/import checkpoint | 87 tests across seven suites; TypeScript, build, deployment dry run, and local R2/import browser checks passed. | Historical R2 change. The earlier R2 activation error was subsequently resolved by provisioning the private bucket. |
| September 15, earlier completed checkpoint | **144 tests across 12 files passed**, approximately 100 seconds; TypeScript and production build passed. | Completed before the subsequent CRM/report/reader additions. Focused results below do not replace a fresh integrated regression. |
| September 15, import optimization evidence | 17 import tests passed, including a full 500-row preview against 1,000 name matches and the 1,001-match safety rejection. | Same duplicate decisions, guardian safeguards, omitted-field rules, receipts, and D1 query scope. See [matching measurements](import-preview-performance.md); its microbenchmark is not deployed CPU. |
| September 16, previous integrated checkpoint through migration 0016 | **266 tests across 24 files passed** in 72.08 seconds; TypeScript and production build passed. The source fingerprint was unchanged across validation. | Previous completed baseline, superseded for current source by the schema-17 result below. Preserve its [checkpoint and browser evidence](release-checkpoint-2026-09-16.md); it does not establish live deployment. |
| September 16, scoped browser and responsive checkpoint | Import mapping/review/commit/resume; directory/contact filters; weekly lesson details; normal pickup and completed-visit correction; daily views; reports; audit detail; persisted center fields; desktop, mobile and tablet layouts passed. | Isolated synthetic workerd/D1 only. Mobile 390×844 and tablet 1024×768 viewport checks do not replace physical iPad or staff acceptance. |
| September 16, previous history checkpoint through migration 0017 | **283 tests across 25 files passed** in 168.43 seconds; TypeScript/build passed. The 161-file installer fingerprint matched before and after validation. Final empty-native and populated migration rehearsals, bounded backfill and recovery checks passed. | Verifies the request-ownership/shadow-interval foundation locally. The client was unchanged, so the earlier scoped browser evidence remains applicable. Archive lookup APIs, eviction and archive-aware reporting are not implemented. [History checkpoint](history-checkpoint-2026-09-16.md). |

Earlier focused checkpoints passed 21 import API tests, 13 inquiry/task tests, 8 interaction tests, 15 archive-reader tests, 6 directory tests, 15 summary/export tests, and 25 installer tests. Inquiry, interaction and archive-reader browser checks also passed locally. At that stage, manager validation stopped after seven workflows on a selector timeout, and import upload encountered Chrome file-URL access and connection failures. Those are dated limitations of the earlier runs. The September 16 in-app-browser checkpoint subsequently completed the scoped import, directory, summary and other workflows listed above; they are no longer outstanding because of that connection failure.

The final import scope passed 26 native tests and four operation-ownership tests. Browser validation exercised delayed receipt loading, same-file reattachment, explicit same-name review and saved-preview recovery after the associated fixes. The integrated 266-test result remains the previous baseline through migration 0016. The 283-test result covers the schema-17 history foundation; subsequent schema-18, schema-19 and schema-20 checkpoints below supersede it for current source. Counts overlap and must not be summed. No synthetic records were written to live Cloudflare or Railway.

Local API tests use actual workerd/D1; R2 tests use actual local R2 bindings. Provider export/Drive responses are mocked. Independent recovery tests execute separate Node CLI processes. Test counts overlap across checkpoints and must not be summed.

| Current evidence | What it exercises locally |
| --- | --- |
| [Access](../tests/access.test.ts), [kiosk](../tests/kiosk.test.ts), [attendance](../tests/attendance.test.ts) | Signature/allowlist behavior, named operators, roles/revocation, pickup restrictions, observed/original times, concurrent transitions, corrections, and fixed-event retries. |
| [Import](../tests/import.test.ts) | Mapping, duplicate review, guardian safety, preserved omitted fields, bounded/resumable commit, stale previews, and receipts. |
| [Schedules](../tests/schedules.test.ts) | Recurring weekly schedule slice, validation, student/subject constraints, overlap checks, roles, and data consistency. The schedule UI was also tested locally; no live schedule validation is claimed. |
| [Front desk](../tests/frontdesk.test.ts), [report summary](../tests/report-summary.test.ts), [report export](../tests/report-export.test.ts), [audit reader](../tests/audit-reader.test.ts) | Bounded daily views, center-day/DST boundaries, actual-record semantics, due follow-ups, attendance/enrollment summaries, coherent paged exports, and audit history. These are included in the schema-16 integrated baseline; scoped browser checks also passed. |
| [Backup](../tests/backup.test.ts), [combined recovery](../tests/recovery.test.ts) | Encrypted R2 parts/readback, job fencing/retries, pinned archive references, separate CLI recovery, copies of every recursive history object, isolated D1 restoration, record counts, and access reset. |
| [Archive codec](../tests/archive-codec.test.ts), [archive jobs](../tests/archive-jobs.test.ts), [archive recovery](../tests/archive-recovery.test.ts) | Bounded compressed evidence, encryption/graph validation, holds, frozen sources, cancellation, corruption, private publication, and verification of historical copies. This is copy-only; no application eviction is implemented. |
| [Storage compaction](../tests/storage-compaction.test.ts) | Frozen receipt compatibility, audit identity/field preservation, atomic rollback, immutable guards, and native-style SQL restoration. |
| [Installer](../tests/installation.test.ts) | Configuration, target identity, migration ledgers/checksums, backup/maintenance guards, failure cleanup, and reruns. Remote command responses are simulated. |
| Local UI checks, September 14 | Student creation/arrival; one-use kiosk enrollment; named front-desk PIN; roster visibility; normal departure blocked without an authorized guardian; exceptional departure with observation/reason entering review and reducing presence from 1 to 0. |

The latest September 16 resumable-verification checkpoint records its exact source fingerprint, complete test output and artifact hashes through migration 0019. Final release acceptance still needs the deployed version, customer installation record and validation of later source changes. Local validation does not authorize deployment or production use.

## Current backup and archive status

R2 is the selected backup destination. The earlier Cloudflare activation error `10042` is resolved: the private Standard bucket exists. Google setup is no longer a prerequisite. The previous Google Cloud project/OAuth client has not been deleted, and no Google backup or restore is claimed.

The deployed schema remains 1–4 and the live backup-job table is empty. `BACKUP_KEY` is configured; `CF_EXPORT_API_TOKEN` and an alert transport remain missing. The queue/cron alone cannot establish an active preservation workflow. Apply the reviewed migrations and deployment, configure real export credentials, independent key custody, identifiers and binding, and the alert transport. Demonstrate manual encrypted delivery before enabling and verifying scheduled work.

Current local code pins completed archive manifest references under the SQL snapshot lock. Independent recovery verifies SQL plus every referenced archive/addendum and copies the encrypted objects before publishing SQL. See [combined recovery](combined-recovery.md). The archive product stage is verified copying, with no D1 eviction. The owner/manager copy reader passed 15 native API tests and browser validation. It still depends on retained source rows. Permanent historical retry/correction behavior, safe removal, and recovery after eviction remain open.

Migration 0017 and its history foundation are verified locally. Immutable request ownership, shadow visit intervals, bounded transactional backfill, generation/cursor checks, maintenance fencing and recovery reset behavior passed native tests and final migration rehearsals. Attendance APIs still use live tables; archived request resolution, archive-aware reporting/corrections, source-visit deletion and archive-location activation remain unavailable. Archive v2 semantic verification has focused local tests, while operational readers and restoration remain limited to v1. The verified foundation does not establish eviction readiness.

R2 in the same Cloudflare account does not independently protect against account loss. Define and test the complete external encrypted copy and separately held key, and provide staff with a separate immediately usable outage information source.

## Actual native export and isolated recovery drill

September 14, 2026 checkpoint. A native **remote** D1 SQL export through Wrangler succeeded for the deployed feasibility database. It contained the schema and bootstrap owner, with **zero students, visits, or attendance events**. The following recovery steps then ran locally, without changing remote resources:

1. Imported the actual 29,133-byte native SQL file into a fresh isolated workerd/D1 database to establish the exported objects, table counts, migration ledger, and owner record.
2. Encrypted that file with the application's production backup cryptography as one authenticated data part and an encrypted manifest. A temporary recovery key was kept in a private file and was not printed.
3. Ran the independent Node recovery CLI to decrypt into a new private output file. The source and recovered SQL matched byte for byte by SHA-256.
4. Restored the recovered SQL into another fresh isolated D1 database. All exported application SQL objects and table counts matched the direct native import, including the migration ledger `[1, 2, 3, 4]` and the single owner record.
5. Ran the recovery access-reset SQL available at that checkpoint. A locally generated, valid RS256 test token for the restored owner identity received HTTP 200 before reset and HTTP 403 afterward. The isolated test issuer/JWKS was used; no live Access cookie was replayed. The owner row remained, and the reset audit record was present.

| Measurement | Result |
| --- | --- |
| Native SQL file size | 29,133 bytes |
| Parsed native SQL statements | 102 |
| Source and recovered SHA-256 | `6ea7c94b71dd115fab12044ced34e2692dfd1a4439194da5c6d76e23d71b0fca` |
| Migration versions preserved | 1, 2, 3, 4 |
| Owner rows preserved before reset | 1 |
| Students / visits / attendance events | 0 / 0 / 0 |
| Remote changes during the recovery drill | None |
| Private-file cleanup | Native source SQL and temporary keys, encrypted files, recovered outputs, and isolated databases removed after successful validation. |

This is evidence for native export and recovery of the startup state. It is **not** a Google Drive delivery/restore test, a restore of populated student or attendance records, a full two-year recovery drill, or a throughput/CPU/capacity result. The encrypted manifest was constructed for this independent drill; it was not delivered by the deployed scheduled backup job.

## Recovery behavior and caveats

The current [recovery CLI](../scripts/recovery.ts) authenticates SQL parts and all pinned archive dependencies, copies each encrypted historical object to private staging, reads the copies back, and publishes recovered SQL last. It refuses existing SQL output, manifest, archive directory, `.partial` file, or recovery lock. Files use mode `0600`; staging directories use `0700`. Legacy SQL-only manifests from before schema 8 remain supported; newer manifests must explicitly declare the archive snapshot.

Local subprocess tests cover wrong keys, missing/corrupted SQL and archive parts, recursive addenda, existing-output preservation, size bounds, `SIGINT`/`SIGTERM`, and recovery from the copied historical bundle after its original source is deleted. A forced kill or power loss cannot run cleanup; inspect any private staging directory and lock before retrying.

Restore into an isolated database, apply current migrations, and run [recovery-access-reset.sql](../scripts/recovery-access-reset.sql) before reopening access. The current reset disables restored staff email identities/PINs, removes kiosk sessions, revokes devices/enrollments, disconnects saved integration state, clears export URLs/leases, expires pending imports, and cancels unfinished archive jobs. Completed archive metadata and holds remain. Attendance, corrections, existing revocation timestamps, and owner rows are preserved, and the reset is audited. Reapply the reviewed current allowlist deliberately.

The reset cannot revoke tokens at their provider, disable the old deployment, populate a new R2 bucket, or reconcile current holds/deletions. Upload and independently verify the restored archive objects at their destination, reconcile current access and custody, and verify application behavior before cutover. Protect encrypted backups containing older credential material.

The September 14 native drill above and September 16 fresh native-export drill recovered the empty live startup state into local databases. The newer combined tests use local populated fixtures and mocked provider exports. None proves scheduled live R2 delivery, independent live-account restoration, a supported two-year recovery time, or full CRM capacity. The September 16 private artifacts remain available as dated evidence; their backup freshness must be re-established before an update.

## Validation still required

| Area | Remaining completion/acceptance evidence |
| --- | --- |
| Current release deployment | The latest source through migration 0017 passed the integrated suite/build and final migration rehearsals; earlier browser evidence remains applicable because the client was unchanged. Validate later changes and apply a reviewed update only with fresh backup and real maintenance evidence. Live schema is still 1–4. |
| Backup credentials and key | Create/apply the reviewed export credential after approval, verify identifiers/binding, and establish independent key custody. `BACKUP_KEY` is uploaded; that alone does not validate backup delivery. |
| Backup execution and alerts | Manual Worker-driven export, verified R2 delivery, scheduled queue execution, actual alert transport/recipient, failed-delivery handling, and stale-backup escalation. |
| Combined live restore | Populated live backup restored into a separate installation with every historical object/addendum, destination verification, access reset, reconciliation, application checks, measured recovery time and missing interval; repeat at the supported workload. |
| Historical tier | Integrated query/catalog reader, permanent old-ID replay lookup, archived effective-interval and correction/addendum handling, guarded eviction, and independent recovery after eviction. No history deletion is currently enabled. |
| Archive API/report integration | The schema-17 ownership/interval foundation is locally verified. Permanent archived request lookup, historical interval authority and archive-aware reports/corrections still need implementation and validation. |
| Remaining CRM/cutover scope | Recurring schedules, inquiries/tasks, interactions, directory filters, daily front-desk views, audit activity and bounded reports/summaries have completed local integrated evidence. Unmatched exceptional-departure time corrections remain to be implemented. Validate deployed parity, migration/cutover and rollback before claiming the full package accepted. |
| Deployed security and workload | Live attendance/pickup/corrections/concurrency; denial paths, offboarding, owner recovery and chosen MFA; CPU and limit errors; D1 reads/writes/size; Queue/R2 usage, backup locks, and peak overlap. |
| Physical devices and staff | Supported iPads/browsers, lock/restart/foreground behavior, uncertain requests, outage procedure, accessible contingency information, and witnessed staff training. The Cloudflare kiosk does not record offline. |
| Customer handover | Customer-owned accounts/source/credentials/key vault/domain, contract and support responsibility, approved data mapping/reconciliation, privacy and retention/hold decisions, witnessed restore, and written center acceptance. |

The [readiness report](readiness-report.md) maps these gates to the eight supplied requirements. Keep implemented, locally passed, live-observed, and externally accepted states separate when adding new evidence.

## September 15 migration inventory through version 15

A second private native-export rehearsal applied schema 4→15 in isolated workerd/D1, preserving the manual maintenance sentinel, existing table counts, logical audits and decoded receipts. Local SQLite integrity and foreign keys passed. The source is the empty live startup export, not a populated live backup. The local migration batch took 54.9 ms, which is not Worker CPU evidence.

Separately, the original synthetic one-center fixture upgraded schema 6→15 in one local SQLite transaction. Original source-field digests, all 120,940 logical audits and 120,000 accepted receipts matched; maintenance, integrity and foreign keys passed. It took 5.64 seconds and occupies 130,924,544 bytes after local VACUUM. The earlier 113,557,504-byte number measured compaction alone; the later inventory adds report and audit indexes. [Full migration evidence](../tests/full-release-migration-results.json) records exact migration hashes. Re-run affected validation if those hashes change. Neither rehearsal changes live D1 or establishes remote reclamation, live R2 restoration, or free-tier CPU/capacity.

The subsequent final inventory through schema 16 passed the same two rehearsals. Native startup 4→16 took 52.4 ms locally; populated 6→16 took 5.66 seconds and measured 133,632,000 bytes after VACUUM. [Schema-16 evidence](../tests/full-release-migration-results-16.json) includes the final flattened audit view and partial departure-date index. Source data, logical audits, receipts, maintenance, integrity and foreign keys remained unchanged. These are still local results.

## September 16 previous integrated and browser checkpoint through schema 16

The previous local checkpoint through migration 0016 passed 266 tests across 24 files, TypeScript and the production build. Installer source fingerprint `200fa5562f2e468f0ed51a431bead59e8586dce2a0311f41ba7feff9e8ef8d4e` remained unchanged across that run. Results and artifact hashes are in `tmp/release-checkpoint-evidence-20260916.json`. Import races and same-file recovery were fixed; scoped directory, normal pickup, completed-visit correction, daily views, reports, audit details, center fields and responsive browser checks passed in isolated workerd/D1. Mobile profile focus now opens at the identity and guardian authority section. The schema-17 checkpoint below supersedes this integrated source baseline; the browser evidence remains applicable because the client did not change.

A fresh native empty live D1 export was encrypted locally and independently restored, reconciling all 23 table fingerprints/counts. It did not use Worker-driven R2 delivery, did not acquire maintenance, and did not expose an exact snapshot bookmark. Source remains schema 4. The private evidence and all limitations are recorded in the [release checkpoint](release-checkpoint-2026-09-16.md). No deployment, migration, R2 upload or live data writes occurred.

## September 16 previous history foundation checkpoint through schema 17

The integrated suite passed **283 tests across 25 files** in 168.43 seconds, with zero failures. TypeScript and the production build passed. Installer fingerprint `be32818bf6dde72d9f8323636feb3d84be88ba500489b787d376e84021069155` covers 161 files, version 0.1.0, through migration 17 and matched before and after validation. Artifact hashes and scope are recorded in `tmp/history-checkpoint-evidence-20260916.json`; detailed results are in `tmp/integrated-history-tests.json`. See the [history checkpoint](history-checkpoint-2026-09-16.md).

Sixteen native history tests cover immutable ownership, legacy and cross-center audit aliases, hashes, ignored retries, rejected replacement, source/visit identity, review changes without a version increment, concurrent bounded backfill, corruption and backup barriers. A new native recovery test verifies exact key/head restoration and repeated resets. Independent native review also exercised a reset between reading a backfill page and writing its batch. These checks validate the foundation only. Attendance still uses live tables; archived request-resolution APIs, archive-aware reporting/corrections, eviction and archive-location activation are not implemented or enabled.

The final empty native-export rehearsal migrated schema 4→17 in 232.8 ms locally, preserving source counts, logical audits, immutable observations/receipts and the maintenance lock, with integrity and foreign-key checks passing. Private evidence is `/Users/ocheng/.config/kumon-crm/validation-20260915/migration-rehearsal-2026-09-16T07-33-23-481Z.json`.

The populated one-center fixture migrated schema 6→17 under a local maintenance lock in 12.8 seconds. All original fields, 120,940 logical audits and 120,000 decoded accepted receipts matched. It measured 133,681,152 bytes before history backfill. Backfill reserved 120,940 request IDs and mirrored 60,000 visits in 365 calls of at most 500 records, taking 5.93 seconds with the local SQLite adapter and preserving source fingerprints. After local VACUUM and closure, the file measured **174,981,120 bytes**. The lookup tables and interval indexes add about 41.3 MB. See the [final migration evidence](../tests/full-release-migration-results-17-final.json) and [backfill scale evidence](../tests/history-lookup-scale-results-17-final.json).

These are local wall-time and storage results, not deployed CPU, remote D1 reclamation or Free-tier production capacity. No paid upgrade, deployment, live migration/maintenance lock, R2 upload or automatic backup activation occurred. Live Cloudflare remains empty on schema 1–4 and Railway remains available. Worker-driven R2 delivery, failure alerts, independent cloud restoration, archive integration/removal, unmatched exceptional-departure time correction, physical-device/staff acceptance and customer handover remain open.


## September 16 previous checkpoint through schema 18

The final integrated local suite passed **311 tests across 28 files** in 80.92 seconds. TypeScript and the production build passed. Installer fingerprint `103bb094031c80b8b35dab0de64825c5eac65a6a04ac51a28392a4d25c8d0406` covers 170 files through migration 18 and matched before and after validation. Artifact hashes are recorded in `tmp/staging-checkpoint-evidence-20260916.json`. See the [retry and private staging checkpoint](archive-staging-checkpoint-2026-09-16.md).

This adds permanent request lookup before current-state validation, exact stored live receipts, changed-request conflict handling, missing-evidence failure, legacy fingerprint compatibility and concurrent correction replay. The private staging adapter authenticates encrypted input, commits bounded part writes atomically, freezes immutable graphs, uses indexed private reads and fences verification/cleanup across restoration. Recovery inventory and reset tests include all four new private tables. No v2 publication, R2 request replay or source deletion is enabled.

The first integrated attempt failed five old-schema compaction fixtures. Those fixtures now use native historical database triggers instead of the latest router; the final suite passes without a missing-schema product fallback. The previously recorded schema 17 evidence remains intact.

Both final migration rehearsals used local maintenance locks and passed integrity/FK checks plus deliberate final-statement failure rollback. The saved empty native export migrated 4 to 18 in 35.53 ms; the populated fixture migrated 6 to 18 in 6.02 seconds while preserving original fields, 120,940 logical audits and 120,000 accepted receipts. [Empty evidence](../tests/empty-native-migration-results-18-final.json) and [populated evidence](../tests/full-release-migration-results-18-final.json) include migration hashes.

Backfill then created 120,940 permanent request keys and 60,000 visit heads in 365 calls of at most 500 records. Source hashes remained unchanged; maintenance fencing, integrity/FK and indexed queries passed. The closed file measured **175,030,272 bytes** after local VACUUM, including 41,299,968 bytes of backfill metadata above its 133,730,304-byte pre-backfill size. [Backfill evidence](../tests/history-lookup-scale-results-18-final.json) records the 2.60-second local SQLite elapsed time. These measurements do not establish deployed Worker CPU or remote D1 reclamation.

There were no remote actions, deployment, paid upgrade, R2 upload or automatic backup activation in this checkpoint. Earlier live observations have not been promoted to new evidence. The export-credential approval remains pending; fresh backup/maintenance evidence is still required before installation. Live R2 delivery/recovery, deployed capacity, physical-device/staff acceptance and customer ownership remain open.


## September 16 resumable verification checkpoint through schema 19

The integrated suite passed **340 tests across 32 files** in **119.29 seconds**, with zero failures. TypeScript and the production build passed. The 184-file installer fingerprint `df0faae287d69581db1f8623b219db772a82d3fd7297cddc44edf31f7e0aada6` remained unchanged. See [resumable verification checkpoint](archive-runner-checkpoint-2026-09-16.md) and `tmp/semantic-runner-checkpoint-evidence-20260916.json`.

One authenticated monthly base can now be semantically verified across restartable, lease/generation/maintenance-fenced steps. Native parity tests compare valid and invalid evidence against the full verifier after closing the source database. A separate bundle executes the runner inside local workerd. Recovery invalidates old jobs while retaining original provenance and diagnostic codes. This does not activate publication, R2 receipt lookup, source removal or scheduling.

Final schema 19 empty-native and populated migration rehearsals match the final DDL hash and preserve source values, 120,940 logical audits and 120,000 receipts, with rollback and maintenance checks. The populated fixture measures 133,775,360 bytes before backfill and 175,075,328 bytes afterward. Backfill takes 365 calls of at most 500 records. Parity fixtures use at most 26 actual SQL statements per verifier advance; 40 is the enforced ceiling. All figures are local, not deployed CPU or capacity evidence.

No remote change or paid upgrade occurred. Staging admission/cleanup scheduling, immutable publication/locators, independent v2 restoration, live backup delivery and alerts, deployed resource measurements, physical-device/staff acceptance and customer ownership remain required. The export-token approval is still pending and Railway stays available.


## September 16 previous exact-record checkpoint, schema 19

The final suite passed **351 tests across 33 files** in **103.48 seconds**; TypeScript and the production build passed. Fingerprint `9416e0b2e10e84d8ea23e1e3c46145692baa6015da1c0e260954c249c86212d4` covers 186 files and remained unchanged. See the [exact archive record checkpoint](archive-record-checkpoint-2026-09-16.md) and `tmp/record-evidence-checkpoint-evidence-20260916.json`.

The internal loader authenticates an exact v2 manifest and indexed part, preserving the complete record and original receipt bytes. Eleven focused real-local-R2 tests cover scope, hashes, missing/corrupt objects, body limits and caller mutation. It does not activate publication, operational retry resolution or source removal. Existing schema 19 migration/backfill evidence and the unchanged-client browser evidence still apply.

A separate local allocation study measured 40,316,928 extra bytes for 14,289 unchanged historical records, but that old synthetic month fails codec validation and has only minimal staging metadata. It is storage-only evidence, not full-month authentication, derived storage, deployed quota or CPU evidence. A separate native 65-record fixture authenticated and verified. Admission limits and cleanup scheduling remain planned. No live action or paid upgrade occurred; all live-backup, recovery, deployment, acceptance and ownership gates remain open.


## September 16 previous staging admission checkpoint, schema 20

The integrated suite passed **364 tests across 34 files** in **79.43 seconds**. TypeScript and the production build passed. Fingerprint `1a5127fc647754e59bcd85acb8d5a5940f3deda9ce21d376aeffaaa8587b20a2` covers 193 files and matched before and after validation. [Checkpoint details](archive-admission-checkpoint-2026-09-16.md) and `tmp/staging20-checkpoint-evidence-20260916.json` preserve the scope and artifact hashes. Historical schema 19 artifacts remain unchanged.

Schema 20 enforces one resident session across generations and statuses, one runner, one monthly base, 20,000 records and 16 MiB plaintext. New admission needs a fresh primary size observation plus a provisional 128 MiB allowance below 400,000,000 bytes. Oversized legacy state remains retained and blocks work until reconciled; cleanup releases admission only after deleting the last session row. Missing size metadata pauses work.

Final empty and populated migration/rollback rehearsals passed. All original fields, 120,940 audits and 120,000 receipts remained intact. The populated file measures 133,783,552 bytes before backfill and 175,083,520 afterward with local VACUUM. Authenticated full-month staging and verification added 40,693,760 bytes; an exact admitted boundary with long identifiers added 123,404,288 bytes. Both passed independent verification and bounded cleanup. The allowance remains provisional pending mixed derived-record, fragmentation and deployed evidence.

A separate native local D1 lifecycle reported 145,288 writes, 2,260,346 reads and 295,722 statements, with no missing metadata or failed batches. Its 16,860 verifier advances used at most 26 statements each; cleanup took 350 calls. These local observations require daily background pacing before unattended archiving and do not establish deployed CPU or account charges. Initial per-query measurement transports exhausted host ports; the completed measurement executed inside local workerd. The final full regression passed after that connection load was removed.

No remote deployment, migration, upload, paid upgrade, live data mutation or backup activation occurred. The last verified live state remains the empty schema 1–4 installation above. Export-token approval remains pending. Durable abandoned-work cleanup and pacing, publication and exact R2 replay, independent populated cloud recovery, deployed measurements, physical acceptance and customer handover remain open. Railway stays available.


## September 16 current lifecycle checkpoint, schema 21

The integrated suite passed **371 tests across 35 files** in **128.53 seconds**. TypeScript and the production build passed. Fingerprint `9865fb6373458a99b8de511b0b5c4b0000e2a76e330c968bf6fb24a2bf5cb00f` covers 201 files and matched before and after validation. The [lifecycle checkpoint](archive-lifecycle-checkpoint-2026-09-16.md) and `tmp/lifecycle21-checkpoint-evidence-20260916.json` retain exact scope and hashes. Historical schema 19 and 20 artifacts remain unchanged.

Lifecycle triggers record accepted progress and first verification atomically. Retries and lease claims do not extend liveness. Unknown legacy timestamps remain null with explicit migration grace. Read-only due selection grants no cleanup authority. The final guarded session deletion removes its bookkeeping atomically. Encrypted SQL restoration and repeated resets preserve evidence while invalidating old authority. A nullable legacy-update guard edge found during review is fixed and covered by a native regression test.

Final empty and populated schema 21 migration/rollback rehearsals passed against migration hash `ccbfa40ceb6a7c12ffd269cfb4bbab7ded626d5306c37c11ede63bbf50b118b0`. All original fields, 120,940 logical audits and 120,000 accepted receipts remain intact. The populated file measures 133,804,032 bytes before backfill and 175,104,000 afterward with local VACUUM. Backfill completed in 365 calls of at most 500 records, with zero archive locations activated.

The full native local D1 lifecycle reported **179,129 writes and 2,361,868 reads across 295,724 statements**, with complete metadata coverage and no failed batches. It completed 16,860 verifier advances and 350 cleanup calls. These totals include lifecycle bookkeeping. Due selection, future pacing, retries and shared-account operations will require their own headroom. The local measurements do not establish deployed CPU or account charges. The independent [mixed-boundary supplement](archive-mixed-boundary-2026-09-16.md) remains explicitly pinned to schema 20.

No remote deployment, migration, upload, live mutation, automatic backup activation or paid upgrade occurred. The last verified live state is still empty schema 1–4, export-token approval is pending, and Railway stays available. Deliberate pauses and renewal, guarded expiry/cleanup, daily budgets and alerts are next. Publication/replay, independent cloud recovery, deployed capacity, physical acceptance and customer-owned handover remain required.

## September 16 — schema 22 controls and cleanup checkpoint

The integrated suite passed **392 tests across 38 files** in **126.18 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `44ec0b5369d5cc0bd407ca7fa52d4e03a680ad3b1ab03e8164a10dbbb226ee2b` covers 209 files and stayed unchanged through validation. See the [checkpoint](archive-controls-checkpoint-2026-09-16.md) and `tmp/controls22-checkpoint-evidence-20260916.json`. Historical schema 19–21 artifacts remain unchanged.

Internal controls now cover pause/resume, bounded renewal, conditional expiry, leased cleanup and retained diagnostics. Native regressions cover progress/expiry races, concurrent claims/pages, lease expiry/takeover, maintenance/restoration between read and write, atomic rollback, lost completion responses and exact replay. Restore revokes control authority while preserving original history and diagnostic notes. The accepted review/audit timestamp now comes from one captured instant.

The empty native and populated synthetic migration/backfill rehearsals passed; the latter closed at 175,140,864 bytes after local VACUUM. Full native monthly lifecycle usage was 179,835 writes and 3,180,523 reads, with zero failed batches or missing row/size metrics. Two diagnostics survived cleanup. The measured runtime bundle matches the final source.

These are local results. Daily budgets, alerts and scheduling remain unfinished. No deployment, remote data change, token creation, backup activation, source eviction or paid upgrade occurred. Live backup/recovery, deployed capacity, physical-device/staff acceptance and customer-owned handover gates remain open.

## September 16 — schema 23 budget checkpoint

The integrated local suite passed **427 tests across 41 files in 132.97 seconds**. TypeScript and the production build passed. Installer fingerprint `eb5fe4b01323fc39fe090a020829dbf2a1d2f0d3cb7d1bd0ae785739537b274e` covers 219 files and stayed unchanged through validation. See [the checkpoint](archive-budget-checkpoint-2026-09-16.md) and `tmp/budget23-checkpoint-evidence-20260916.json`.

Internal day/pool allocations, reservations, one-shot grants, same-batch fences, native usage settlement, sticky closure and encrypted restore fencing are implemented. They remain unwired to archive work and scheduling. Exact replay and rejection consume database reads without automatic pool charges, so complete entry accounting is still required.

The native cost sample completed 64 tiny synthetic steps. Reservation/claim/settlement added 15 writes and 13 statements per step. Schema 23 added 61,440 bytes in the isolated native fixture; measured work added 131,072 bytes. Two deliberately rejected native write batches lacked complete cost metrics. The measured runtime bundle was rebuilt and matched current source. These results establish neither worst-case envelopes nor deployed quotas or CPU.

Empty native and populated synthetic migration, rollback, maintenance and backfill checks passed. The populated closed file measured 175,198,208 bytes after local VACUUM; all original fields, 120,940 logical audits and 120,000 accepted receipts survived. Historical schema 19–22 evidence remains unchanged.

No live changes occurred. The last verified live installation remains empty on schema 1–4; automatic backups are disabled and export-credential approval remains pending. Railway remains available. Production and customer acceptance gates remain open.

## September 16 — budgeted verifier integration

The integrated suite passed **465 tests across 45 files in 205.23 seconds**; TypeScript/build passed. Fingerprint `50df0ca990922ff3939a09496dc2b414cf30a242146331118e8381c64019e128` covers 227 files and remained unchanged. Schema stays 23. See [the checkpoint](archive-budget-integration-checkpoint-2026-09-16.md).

The internal reserve/claim/advance/settle path binds an exact frozen run and selected step, prevents duplicate executors, and counts all submitted calls under 40. Native integration tests cover every phase and uncertain-response boundaries. Control faults still lack durable reconciliation, and entry/replay costs are not fully prepaid; activation stays disabled.

The matched native month completed 16,860 direct verifier advances before and after optimization. The full +13-ledger statement projection fell from 52 to 35 at its maximum and from 5,126 over-limit calls to zero. Actual verifier row reads fell about 4%; writes were unchanged. Generic page reads can cost more. This is not deployed CPU/billing evidence or a full-month budgeted adapter run.

Previous schema 19–23 evidence remains unchanged. No live update, new data, backup activation, source eviction or paid upgrade occurred. Railway remains available; live recovery, deployed capacity, physical acceptance and customer-owned handover gates remain open.

## September 16 — schema 24 durable control accounting

The integrated suite passed **485 tests across 45 files in 154.63 seconds**. TypeScript/build passed. Fingerprint `b9aa3a857cc5b1378e97a4e2b89b57d50a20e218160cbe9df32e6332c5f6e55f` covers 234 files and remained unchanged. See [the checkpoint](archive-control-accounting-checkpoint-2026-09-16.md).

Schema 24 persists pending control liabilities, immutable terminal prefix receipts, known deficits, and conservative legacy evidence. Nine encrypted restore states retain charges and revoke old authority. Native whole-adapter ordinary/exceptional fixtures used at most 36/37 statements; measured closing paths used at most 33 reads and 5 writes in one statement. A trusted terminal bound remains explicit. A cost exceeding that bound can be detected only after its receipt commits, so deployed policy validation and containment remain required.

Maintenance-fenced empty/populated migration, rollback, and bounded backfill passed. Original values, 120,940 audits, and 120,000 receipts survived. The populated closed file measured 175,226,880 bytes after local VACUUM. Earlier schema 19–23 evidence was rehashed without changes.

No live mutation or paid upgrade occurred. The last verified live state remains empty schema 1–4, automatic backups disabled, export-token approval pending, and Railway available. Entry/replay admission, full-month budgeted capacity, authoritative publication/recovery/eviction, live backups and cloud restoration, deployed limits, physical/staff acceptance, and customer-owned handover remain open.

## September 16 — independent v2 recovery checkpoint

The integrated suite passed **529 tests across 48 files in 182.43 seconds**. TypeScript and build passed. Fingerprint `7b1093835ae587ec79ceb8d254703b18bf0cb4231789606a01729e9c05d2591e` covers 239 files and remained unchanged. Schema 24 did not change. See [the checkpoint](archive-independent-recovery-checkpoint-2026-09-16.md).

Both offline CLIs now verify v2 semantic relationships through private indexed SQLite before publishing recovery output. The 39 focused tests also passed on Node 22.13.1. Existing v1/native backup compatibility and five semantic-sink lifecycle checks passed. Authentic and semantically tampered graphs, exact receipts, addenda, copied bundles, wrong keys, path/ciphertext failures, resource limits, atomic rollback, and interruption cleanup are covered.

The representative detached monthly fixture recovered 14,295 records from 56 encrypted parts with exact JSONL equality. Offline subprocess time was 1.82 seconds and peak RSS was 162,016 KiB. These are local Node measurements, not deployed Worker CPU or account costs. Earlier schema 19–24 evidence remains intact.

No live changes occurred. Durable publication/locator reconciliation and archived request authority remain unfinished, as do safe eviction, budget/scheduler activation, live backup/restore evidence, deployed capacity, physical/staff acceptance, and customer-owned handover. Railway remains available; the last verified Cloudflare state is empty schema 1–4, backups disabled, and export-token approval pending.


## September 16 — schema 25 publication and exact archived evidence

**578 tests across 52 files in 247.80 seconds passed**. TypeScript/build passed; frozen release `e1abb7bf6b2f8b1f5e60573a93a0420b9b81e0bba8768094d54d217bbee7868c` covers 250 files. [Checkpoint and limits](archive-publication-checkpoint-2026-09-16.md).

Immutable monthly publication, optional exact request resolution, all 48 backup table counts, legacy/publication root pinning, repeated restore fencing, and independent encrypted SQL-plus-v2 recovery pass locally. Empty native and populated migration/rollback rehearsals preserve values, audits, receipts and maintenance with clean integrity/FK checks. Detailed operational source rows can be absent in the recovered test bundle; restored availability remains unavailable pending catalog reconciliation. No public archive route, source eviction, automatic publication, deployed capacity or production acceptance is established. Abandoned unpublished claim cleanup remains unfinished.

No live changes or paid upgrade occurred. The last verified live installation remains empty on schema 1–4; backups are disabled and export-token approval remains pending. Railway stays available. Live recovery/alerts, device/staff acceptance and customer-owned handover remain open.


## September 16 — schema 26 restored catalog reconciliation

The integrated suite passed **616 tests across 56 files** in **272.66 seconds**. TypeScript and the production build passed. Release fingerprint `8862faf8a7717b1b439d3ebf376adab9779a66320b6af4752f9df2ab60bd7a30` covers 260 files and remained unchanged during validation. [Checkpoint and limits](archive-reconciliation-checkpoint-2026-09-16.md).

Fresh current-generation proof and complete catalog reconciliation now support exact original receipt resolution after independent encrypted SQL-plus-v2 restoration with operational source details absent. Repeated reset preserves original provenance and receipts while revoking availability. Shared locator vectors preserve version 1 compatibility. All 50 backup table counts, the four-statement snapshot, bounded query plans and empty/populated migration/rollback rehearsals pass locally.

No live mutation, source deletion, deployment or paid upgrade occurred. Public archive activation, abandoned-candidate cleanup, historical interval/report/correction authority, live cloud recovery/alerts, deployed capacity, physical-device/staff acceptance and customer-owned handover remain open. Railway stays available; the last verified Cloudflare state remains empty schema 1–4 with automatic backups disabled and export approval pending.


## September 16, schema 27 invalid-candidate cleanup

The integrated suite passed **649 tests across 59 files** in **729.58 seconds**. TypeScript and the production build passed. Release fingerprint `d1ae4da329eaea7e40594492535aedcf4eb5caf53ed354c0996f6e2206a817f3` covers 269 files and remained unchanged during validation. [Checkpoint and limits](archive-abandonment-checkpoint-2026-09-16.md).

Native selected-page cleanup preserves original provenance and permanent request ownership. Interrupted encrypted recovery, current-generation re-inventory, missing-ledger rejection and replacement publication pass locally. The 52-table backup snapshot remains four native statements. Empty/populated migration and rollback rehearsals passed.

No live mutation, deployment, source eviction, automatic backup activation or paid upgrade occurred. Live recovery/alerts, public historical authority, deployed capacity, physical-device/staff acceptance and customer handover remain open. Railway remains available.


## September 16, authenticated archived receipt lookup

The affected regression suite passed **108 tests across 8 files**. TypeScript and the production build passed. Release fingerprint `faca57eaea439b29af040322b81b3525dbb2cfd67511bccd89c781883a350522` covers 270 files and remained unchanged during validation. See [the scoped checkpoint](archive-public-reader-checkpoint-2026-09-16.md). No live deployment, migration, backup activation, source eviction, or paid action occurred. Live installations remain unchanged.


## September 16, archived event and correction POST replay

The affected regression suite passed **122 tests across 9 files**. TypeScript and the production build passed. Release fingerprint `7f893eddf62e38cf6f946929bf247a709eb502a643696f60fd551976543f2140` covers 272 files and remained unchanged during validation. See [the scoped checkpoint](archive-post-replay-checkpoint-2026-09-16.md). No live deployment, migration, backup activation, source eviction, or paid action occurred. Live installations remain unchanged.
# September 17, 2026: local archive metadata audit

The isolated current-schema history backfill preserved every original event, correction, audit and visit value, passed integrity and foreign-key checks, and measured 175,538,176 bytes after local VACUUM. Separate physical-layout models measured 7,421,952 allocated bytes for the representative month's publication catalog and 31,010,816 extra bytes for a hypothetical D1 event range projection. These models bypassed admission triggers/FKs only in fresh diagnostic databases; neither is a native publication or eviction test.

The [storage audit](archive-metadata-storage-audit-2026-09-17.md) records the methods, exclusions and revised implementation order. The [checkpoint evidence](../tmp/history-metadata-audit-20260917/checkpoint-evidence.json) records 19 root artifacts, 31 independently verified publication artifacts, and 14 unchanged prior checkpoint artifacts. The 272-file release fingerprint remains `7f893eddf62e38cf6f946929bf247a709eb502a643696f60fd551976543f2140`.

No product code, schema, remote resources or live data changed during this audit. No new application test suite ran; the existing 122-test affected checkpoint and earlier 649-test full-suite checkpoint remain the latest release test evidence. No deployed capacity, live recovery, maintenance or readiness result is inferred from these local measurements.

## September 17, 2026: internal manifest reader integrated

The root regression passed 57 tests across three files. TypeScript and the production build passed. The 273-file release fingerprint is `b40444c8cc26a6a7da3ed5d692ace46ae93354adbdbc86095f059e6b150b153a`, with schema 27 unchanged. The internal reader finds an exact record through the authenticated manifest and selected part. Public routes and v1 catalog selection remain unchanged.

The [checkpoint](archive-manifest-reader-checkpoint-2026-09-17.md) and [evidence manifest](../tmp/manifest-reader-checkpoint-evidence-20260917.json) distinguish the 57-test root regression from the candidate's 32-test run and older 649-test full suite. Fifteen checkpoint artifacts, ten candidate artifacts and nineteen prior audit artifacts were verified. Direct compact publication is the next isolated implementation; it has not been integrated or deployed. No remote changes, source eviction, paid upgrade, deployed capacity or live restoration result occurred in this checkpoint.
# Local compact receipt reader checkpoint — 2026-09-17

The local release fingerprint is now `0cfecf51ad56d634447daa7eccaf7e12ef615b74df42b0e43c8f734a7daa63a0` across 280 files at schema 28. Compact source-free event and correction receipt resolution passed 758 full-regression tests and the production build. This code has not been deployed. The live feasibility Worker and D1 remain on migrations 1–4, and Railway remains the operational fallback.

Do not deploy this checkpoint yet. Compact catalogs restored from backup deliberately remain unavailable until schema 29 reconciliation is implemented and validated through an independent encrypted restore. The installation runbook, fresh backup, maintenance lock, reviewed update packet, and explicit target checks remain mandatory for any eventual live migration.

## September 17 — schema 29 native retained database

A representative 14,295-record month completed direct compact publication, recovery reset, fresh semantic proof, two-way reconciliation, and exact event/correction R2 reads in isolated native D1. Each receipt lookup used two R2 GETs. The post-expiry retained database measures 8,331,264 bytes after local materialization and VACUUM; compact catalog objects use 868,352 bytes and reconciliation job/receipt objects use 32,768 bytes. The run found and repaired legacy audit-alias owner reclassification during source-free recovery. The repaired release fingerprint is `0a4a8538fcd4924ad53ed75255588917433ae5522cd5ef18722b2eda9e0a9e5a`; 771/771 tests, TypeScript, and build passed. [Checkpoint](archive-native-retained-checkpoint-2026-09-17.md).

No remote resource changed. The live Worker and D1 remain at the recorded schema 1–4 empty state, automatic backups remain disabled, and Railway remains available. This local result does not establish remote D1 allocation, deployed CPU/quota headroom, live backup delivery, populated cloud restoration, or customer acceptance.

## September 17 — authenticated archive ranges and reports

The promoted local release passed 781/781 tests across 152 suites in 1,169.25 seconds, TypeScript, and the production build. The fingerprint remained `dc64b4ddf27731af612226f94b8938859eb3ca307f97e304237437940ed651fe` across 289 files. Wrangler 4.100.0 dry-run packaging also passed with 60 static assets and a 406.50 KiB upload, 96.99 KiB compressed.

Date and optional-student observation history now merges live D1 data with authenticated encrypted R2 evidence. Historical visit pages and report visit phases use retained D1 heads for ordering and current mutable status, then authenticate R2 visit detail when live source rows are absent. Report paging binds the exact range, timezone, exporter, runtime generation, and archive authority. The representative initial report authenticated 7,678 records using 32 R2 reads and 1,205,012 encrypted bytes. A source-free visit page used 12 reads. Local elapsed time is not Worker CPU evidence.

This release has not been deployed. The live feasibility installation remains at the recorded empty schema 1 through 4 state. Student-detail correction history, archived correction mutation and addenda, holds, expiry, safe eviction, deployed capacity, backup restoration, device and staff acceptance, and Kumon-owned handover remain open.

## September 17, archive visit authority candidate

The sealed 290-file candidate passed 787/787 tests across 152 suites, TypeScript, the production build, and a Wrangler dry run at fingerprint `935d325ff352ac5296ed40783149144e4368da44d1efeb850e674979e71b0360`. Historical visit pages and report visit phases now use retained D1 heads plus authenticated R2 detail. The largest representative request used 32 of 48 allowed object reads. This code has not been deployed. See [the checkpoint](archive-visit-authority-checkpoint-2026-09-17.md).

## September 22 — isolated schema-40 acceptance deployment

With explicit authorization, an isolated acceptance installation was created under `ochengweb@gmail.com`: Worker `kumon-crm-acceptance-20260922`, D1 `f8e63c51-ba83-4cb8-8d3e-085b9edac5f4`, private R2 bucket `kumon-crm-acceptance-20260922-backups`, and Queue `dec2869bd50047fa95c995326bc7dd0c`. All 40 migrations and migration hashes are present. The current Worker version is `d56e53ba-41c1-4c61-ae32-12ab0157364f`.

A reusable Access policy `Kumon acceptance owner only` permits only `ochengweb@gmail.com` and is attached to application `Kumon CRM acceptance`. Direct unauthenticated requests to `/`, `/api/health`, and `/api/admin/session` return a 302 Access redirect. The authorized owner sign-in loaded the CRM workspace with the `owner` role. That controlled initialization created one center and one owner staff row. Students, guardians, visits, attendance events, corrections, roster imports, backup jobs, kiosk devices, and audit entries remain zero; no demo or business data was loaded.

The D1 allocation is 1,978,368 bytes across 110 provider-reported tables. Remote D1 rejected `PRAGMA integrity_check` with `SQLITE_AUTH`, so no remote integrity result is claimed. The R2 bucket contains zero objects and bytes; public r2.dev access is disabled, no custom domains or CORS configuration exist, and no lock rules are set. The Queue has one producer and one consumer, both the acceptance Worker. `BACKUP_KEY` is configured. `CF_EXPORT_API_TOKEN` and `BACKUP_ALERT_URL` remain missing, and `BACKUP_ENABLED` remains `false`.

Authenticated read-only navigation also loaded Front desk, Students, Inquiries, Schedule, History, Import roster, and Center settings. The views exposed the expected empty-state controls and safety copy, including original-observation review, pickup-authority cautions, import limits, and disabled historical copying. A follow-up D1 read confirmed zero students, guardians, visits, observations, corrections, imports, inquiries, schedules, backup jobs, kiosks, and audit entries. See [deployed UI smoke evidence](../review/customer-handover-package/acceptance-ui-smoke-2026-09-22.json).

The first Cloudflare dashboard baseline then reported 161 invocations, 24 asset requests, 12 subrequests, zero errors, and zero memory, CPU-limit, internal, load-shed, exception, or client-disconnect events. CPU time was 4 ms p50, 8.28 ms p90, 18.2 ms p99, and 20.54 ms p99.9. Memory was 2.59 MB p50 and 3.03 MB p99. D1 reported 517 read queries, 3 write queries, 27,281 rows read, 1,419 rows written, and 1,978,368 allocated bytes in the 24-hour window. These are setup, Access, empty navigation, and verification observations. They exclude populated concurrency, imports, reports, exports, backups, and archives, so they do not establish Free-plan or production headroom. See [deployed baseline evidence](../review/customer-handover-package/acceptance-deployed-baseline-2026-09-22.json).

A second Wrangler live-tail sample captured 28 responses across 15 authenticated empty-state routes. All returned 200 with `ok`. CPU maxima were 10 ms for `POST /api/admin/audit/query`, 8 ms for history and attendance summary, and 6 ms for front-desk, backup, and archive reads. Maximum wall time was 421 ms for backup status. The temporary raw tail, which included request metadata, was deleted after aggregate route metrics were produced. This remains an empty-database observation and does not close populated or concurrent capacity. See [route-level evidence](../review/customer-handover-package/acceptance-route-metrics-2026-09-22.json).

This closes isolated resource provisioning, schema deployment, Access direct-denial, owner sign-in, and non-mutating main-control-center smoke checks for the acceptance environment. It does not close live backup, alert delivery, independent populated restoration, deployed capacity, physical-device/staff acceptance, production identity/MFA design, Railway reconciliation/cutover/rollback, Kumon ownership transfer, or written acceptance. The Access application currently covers the entire Worker production and preview destination; staff and kiosk identity boundaries still require an accepted production policy. No backup, R2 write or deletion, source eviction, feasibility change, Railway change, paid plan change, or production declaration occurred. See [machine-readable deployment evidence](../review/customer-handover-package/acceptance-deployment-2026-09-22.json).

