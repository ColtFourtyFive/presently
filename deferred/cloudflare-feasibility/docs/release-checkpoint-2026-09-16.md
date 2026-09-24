# Local release checkpoint, September 16, 2026

The later [schema-17 history checkpoint](history-checkpoint-2026-09-16.md) supersedes this source/test count. The browser and native export evidence below remains a dated record of its stated scope.

Production release remains pending. This checkpoint covers local source through migration 0016. Live Cloudflare still has schema 1–4, Railway remains available, and no customer records were added to either live installation.

## Integrated validation

The final integrated run passed **266 tests in 24 files**, with zero failures, in 72.08 seconds. TypeScript and the production build also passed after all browser fixes below. The source fingerprint was unchanged across this final validation. Evidence with artifact hashes is `cloudflare/tmp/release-checkpoint-evidence-20260916.json`. Logs and JSON results are under `cloudflare/tmp/integrated-release-*` relative to the repository.

Installer release fingerprint: `200fa5562f2e468f0ed51a431bead59e8586dce2a0311f41ba7feff9e8ef8d4e`, 154 source/configuration/test files, package version 0.1.0. The inventory is `cloudflare/tmp/release-fingerprint-20260916.json`. A later source change requires a new fingerprint and appropriate validation.

The browser checks used Codex's in-app browser against temporary, isolated workerd/D1 on localhost. The fixture contained three synthetic students, two weekly lessons, a synthetic inquiry, attendance and an explicit correction. A local proxy delayed saved-receipt GET responses by ten seconds. It did not delay or change live services.

## Import defects closed

- Final application, completion and payload cleanup now share one token/center-fenced D1 batch. A stale commit cannot clear a revalidated preview. Pending or review rows prevent completion. Native tests also cover cleanup failure rolling back the batch.
- Name lookup now uses the same ASCII case folding as SQLite. Identical accented and CJK names enter review. This preserves non-ASCII case and normalization differences; it does not claim full Unicode equivalence. The indexed lookup and 1,001-match cap remain.
- File reads, preview requests, saved-receipt opening and commits have one operation owner. Opening a delayed receipt visibly disabled confirmation, file selection, preview rebuild and section navigation. Canceled reads cannot overwrite a later draft or release its lock. In-flight writes remain tracked through reauthentication.
- Clearing the file input after selection allows the exact same original CSV to be reattached. Browser validation reproduced the original failure, then completed saved-preview recovery and explicit same-name review with the fixed input.

Twenty-six native import tests and four operation-ownership tests passed. The generic template stays empty. Kumon-specific export mapping is still deferred until a real format is supplied.

## Browser checks completed

| Workflow | Observed result |
| --- | --- |
| Main control center import | Uploaded a UTF-8 synthetic CSV; mappings and proposed rows appeared; confirmation stayed disabled until accepted; two rows committed with a saved receipt. |
| Saved import recovery | Receipt loading blocked competing controls. Reattached the same file, rebuilt the preview, chose a separate student for an identical accented name, and committed one row. |
| Student directory | Three active students, two Math enrollments and one Reading enrollment; guardian email search returned only the two linked children; Reading filter returned one student. Grades and guardian contacts appeared. |
| Student profile | Current pickup authority and weekly lesson details appeared. Guardian contact did not imply pickup permission. |
| Normal attendance | Recorded an observed arrival, selected a currently allowed guardian, confirmed departure, and verified the departure summary. |
| Completed-visit correction | Corrected arrival one minute earlier through History, supplied a reason, and received a saved correction. Report duration changed from one to two displayed minutes. Audit detail preserved both original and corrected timestamps, including the untouched departure's milliseconds. |
| Daily front desk | Scheduled and no-arrival views showed plans without claiming presence; due follow-ups showed the seeded task; departure view showed the confirmed pickup. After local midnight, the observation view excluded the previous day's events and displayed a new confirmed arrival for the new day. |
| Reports | Seven/thirty-day presets, visit counts, unique students, current enrollment and corrected duration rendered. Current enrollment stayed separate from the attendance date range. |
| Audit activity | Filtered to `attendance_correction`, opened the recorded detail and verified original/effective values and the reason. Filter data stayed out of the page address. |
| Center settings | Saved location and descriptive hours, navigated away and back, and verified both persisted. |
| Responsive layout | Desktop report, 390×844 mobile report/directory/profile, and 1024×768 tablet settings checked visually. Mobile and tablet document widths matched their viewports. These are browser viewport checks, not physical iPad acceptance. |

Mobile profile testing found that automatic focus on the communication form scrolled past pickup information. Profiles now focus the close control and open at scroll position zero with identity and guardian authority visible. The correction button in recent visits has its own line. Other forms retain their input focus behavior.

Screenshots were inspected in the task. Native date-time input edits were completed with the browser's keyboard controls because the automation fill operation did not update the controlled date input reliably.

## Fresh native export and independent local recovery

Private evidence directory:
`/Users/ocheng/.config/kumon-crm/validation-20260915/native-export-20260916T035023Z`

A native export of the verified empty live D1 completed at `2026-09-16T03:50:45.872Z`. The 29,133-byte SQL file was encrypted locally in the production backup format using the private recovery key. A separate CLI process decrypted it, and an independent local native D1 restoration reconciled all 23 table fingerprints, counts, schema and center/staff identities. Both persisted local databases passed physical integrity and foreign-key checks.

- SQL SHA-256: `6ea7c94b71dd115fab12044ced34e2692dfd1a4439194da5c6d76e23d71b0fca`
- Encrypted manifest SHA-256: `84a183378bc80d9a2041c743e3dd70a5506dd6d7233d98c35d623e75cdddba20`
- Measured CLI decryption plus local native restore/reconciliation: 2,638 ms.
- Evidence: `verification-evidence.json`, `recovery-cli.json`, and the `encrypted-backup` directory in the private directory above.

No maintenance lock was acquired; unchanged counts and selected identities do not prove a write-quiesced snapshot. Wrangler did not expose the exact export snapshot bookmark, and the manifest records that limitation. No R2 objects, backup jobs, tokens, migrations or deployments were created by this drill. It proves native export plus local encryption/recovery, not Worker-driven R2 delivery or restoration into a separate cloud account. The restore reproduces schema 4. The installer freshness check passed at the time of the drill; do not reuse old evidence as a fresh pre-update backup.

## Migration and storage evidence retained

The exact migration inventory through 16 passed both existing rehearsals. Native empty startup schema 4→16 passed in isolated workerd/D1. The populated one-center schema 6→16 fixture preserved original fields, 120,940 logical audits and 120,000 decoded accepted receipts. Integrity, foreign keys and maintenance fencing passed. That final local SQLite file occupied 133,632,000 bytes after local VACUUM. This is not proof of remote D1 reclamation or deployed Worker CPU.

See `tests/full-release-migration-results-16.json` and the private native rehearsal `migration-rehearsal-2026-09-16T03-39-47-050Z.json` under the validation directory.

## Remaining release work

1. Complete permanent request identity, historical intervals/resolution, immutable correction addenda, report integration, holds and guarded D1 removal. Current archives are verified copies; no eviction is enabled. The v2 semantic verifier is a tested foundation, with operational readers and recovery still deliberately limited to v1.
2. Implement corrections for unmatched exceptional-departure observation times. Existing visit correction and review notes do not cover that case.
3. Apply a reviewed update through the guarded installer, with fresh backup and real maintenance evidence. Demonstrate Worker-driven R2 export, scheduled backups, alert delivery and failure handling, then independent populated SQL/archive/key restoration. Export-token approval and alert transport remain open.
4. Measure deployed free-tier CPU, D1 reads/writes/storage and realistic peak workloads. Local query counts and timings are not deployed capacity evidence.
5. Complete physical iPad, outage, staff, pickup, security/MFA, retention, training and customer acceptance checks. Agree recovery targets, customer infrastructure ownership and independent key custody before cutover.
