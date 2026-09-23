# History foundation checkpoint, September 16

> Historical checkpoint. The current local source is covered by the [schema 18 retry and staging checkpoint](archive-staging-checkpoint-2026-09-16.md). The evidence below remains unchanged.

The integrated Cloudflare suite passed **283 tests across 25 files**, with zero failures, in 168.43 seconds. TypeScript and the production build also passed. This checkpoint supersedes the earlier 266-test checkpoint for the local source; its browser evidence remains applicable because this change did not alter the client.

The installer fingerprint covers 161 files, version `0.1.0`, through migration 17:

`be32818bf6dde72d9f8323636feb3d84be88ba500489b787d376e84021069155`

The fingerprint matched before and after the integrated suite. Artifact hashes and verification scope are recorded in `tmp/history-checkpoint-evidence-20260916.json`. Detailed results are in `tmp/integrated-history-tests.json`; TypeScript and build output are in `tmp/history-check.log` and `tmp/history-build.log`.

## Verified changes

The [history lookup foundation](history-lookup-foundation.md) reserves immutable request ownership and maintains shadow visit intervals. Explicit ID pages, transactional projection validation, and generation/cursor checks prevent concurrent or stale backfill from skipping work or overwriting a newer visit. Backup maintenance pauses progress. Recovery preserves authority and resets work under a new generation.

Sixteen native workerd/D1 tests cover the new history layer, including legacy and cross-center physical audit aliases, hashes, ignored retries, rejected replacement, source/visit identity, review changes without a version increment, concurrent pages, corruption and backup barriers. A new native recovery test verifies exact key/head restoration and repeated recovery resets. An independent native review also exercised a recovery reset between a page read and its write batch.

Source visit deletion and archive location activation remain disabled. Attendance APIs continue using live tables. No archived request resolution or eviction is claimed.

## Migration and storage evidence

The final empty native export rehearsal migrated schema 4 to 17 in 232.8 ms in isolated workerd/D1. It preserved source counts, logical audits, immutable observations/receipts and the maintenance lock, and passed integrity/FK checks. Private evidence is `/Users/ocheng/.config/kumon-crm/validation-20260915/migration-rehearsal-2026-09-16T07-33-23-481Z.json`.

The populated one-center fixture migrated schema 6 to 17 under a maintenance lock in 12.8 seconds locally. All original fields, 120,940 logical audits and 120,000 decoded accepted receipts remained identical. The compacted file measured 133,681,152 bytes before history backfill.

Backfill reserved 120,940 request IDs and mirrored 60,000 visits in 365 calls, with at most 500 records per call. The local SQLite adapter took 5.93 seconds, and source fingerprints remained unchanged. After local VACUUM and closure, the file measured 174,981,120 bytes. The lookup tables and interval indexes add about 41.3 MB. See `tests/full-release-migration-results-17-final.json` and `tests/history-lookup-scale-results-17-final.json`.

These are local wall-time and storage measurements. They do not establish deployed CPU, remote D1 reclamation or Free-tier production capacity. No paid plan was enabled.

## Remaining release gates

The next archive work is permanent request lookup, historical interval authority, staged semantic verification, immutable publication/addenda and archive-aware reports/corrections. Holds, eviction fences and a combined recovery drill after actual deletion must pass before removal can be enabled. Unmatched exceptional-departure observation-time correction is also still open.

Live Worker-driven R2 backups, failure alerts, independent cloud restoration, deployed capacity measurements, physical iPad/outage/staff acceptance, MFA/retention verification and customer ownership/handover remain open. The export-credential approval is still pending; this checkpoint does not grant it.

The live Cloudflare database remains on schema 1–4 and empty. Railway remains available. No deployment, live migration, maintenance lock, R2 upload or automatic backup activation occurred during this checkpoint.
