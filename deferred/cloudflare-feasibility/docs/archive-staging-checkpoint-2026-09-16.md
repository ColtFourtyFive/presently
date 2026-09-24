# Retry and private archive staging checkpoint, September 16

The integrated local suite passed **311 tests across 28 files** with zero failures in 80.92 seconds. TypeScript and the production build passed. The installer fingerprint covers 170 files, application version `0.1.0`, through migration 18:

`103bb094031c80b8b35dab0de64825c5eac65a6a04ac51a28392a4d25c8d0406`

The fingerprint matched before and after validation. Artifact hashes and scope are recorded in `tmp/staging-checkpoint-evidence-20260916.json`. Test results are in `tmp/integrated-staging-final-tests.json`; compiler and build output are in `tmp/staging-final-check.log` and `tmp/staging-final-build.log`.

This supersedes the [schema 17 checkpoint](history-checkpoint-2026-09-16.md) as the current local source checkpoint. Earlier scoped browser evidence remains dated evidence for the unchanged client. This checkpoint adds no physical-device or deployed-capacity evidence.

## Verified changes

Attendance and correction retries now consult permanent ownership before current observation-age, student or visit checks. Matching requests return their original stored result. Changed payloads, centers or request types conflict; missing or inconsistent evidence returns an unavailable response and retains the request reference. Hashless status lookups do not disclose another center's evidence. Legacy SHA-256 encodings and opaque fingerprints keep their original stored form. Concurrent identical corrections produce one acceptance and one replay, with one version increment. See [request resolution](history-request-resolution.md).

Migration 18 adds private authenticated archive staging. Encrypted manifests and parts are verified before staging; each part's checkpoint and rows commit in a four-statement write transaction. Frozen snapshots expose only complete immutable graphs to the semantic verifier. Generation and token checks fence reads, writes, cleanup and recovery. Relationship queries use dedicated indexes. Cleanup removes at most 64 private rows per call and never removes attendance sources, request keys or published objects. See [staging design and limits](archive-semantic-store.md).

Backup inventory includes the four staging tables. Independent local restoration preserves staged evidence, then the access-reset procedure invalidates all old verification and cleanup capabilities, including previously verified sessions. Native tests exercise encrypted tampering, replay, atomic failure, restore races, backup barriers and bounded cleanup. Additional independent probes exercised concurrent freeze, graph changes before commit and generation changes before verification or cleanup.

The first integrated attempt found five old-schema compaction fixture failures. Those tests now seed records through the native historical database triggers. The final suite passes without introducing a product fallback for missing current tables.

## Migration and storage evidence

Both rehearsals used actual local maintenance locks, preserved source evidence and verified rollback after an intentional final-statement failure. Integrity and foreign-key checks passed.

| Rehearsal | Result | Evidence |
| --- | --- | --- |
| Saved empty native export, schema 4 to 18 | 35.53 ms in isolated workerd/D1 | [Empty migration results](../tests/empty-native-migration-results-18-final.json) |
| Populated one-center fixture, schema 6 to 18 | 6.02 seconds; all original fields, 120,940 logical audits and 120,000 decoded accepted receipts preserved | [Populated migration results](../tests/full-release-migration-results-18-final.json) |
| History backfill after migration | 120,940 request keys and 60,000 visit heads in 365 calls, at most 500 records per call; source hashes unchanged | [Backfill results](../tests/history-lookup-scale-results-18-final.json) |

After local VACUUM, the populated file measured **133,730,304 bytes before backfill** and **175,030,272 bytes after backfill**. The permanent request and interval metadata adds 41,299,968 bytes. Backfill took 2.60 seconds through a local SQLite adapter. The reopened, closed file passed integrity and foreign-key checks. There are zero active archive locations and no source eviction.

These are local storage and wall-time measurements. They do not establish remote D1 reclamation, deployed Worker CPU, full-CRM growth or permanently free hosting.

## Remaining archive work

Private staging is not publication authority. The operational writer, reader and combined recovery still use the existing v1 copy path. The permanent resolver still needs live source evidence and fails closed when that evidence is absent. No v2 public route, archive-location activation or source removal is enabled.

The next implementation is [resumable semantic verification for monthly bases](archive-semantic-resume-plan.md), with measured staging admission limits and bounded cleanup. It must precede immutable publication records, exact manifest/part/row locators, authenticated R2 receipt replay and independent recovery using a database that contains no original attendance sources. Addenda, historical interval authority, archive-aware reports/corrections, holds and eviction fences remain required before deletion.

Unmatched exceptional-departure time corrections remain open. The [separate correction plan](observation-correction-plan.md) preserves the original observation and null accepted receipt while adding effective-time evidence; visit correction alone cannot cover this case.

## Live and customer gates

No deployment, remote migration, R2 upload, live maintenance lock, automatic backup activation or paid upgrade occurred during this checkpoint. Railway remains available. The last verified Cloudflare installation was empty and on schema 1–4. Existing native-export recovery evidence is local and its freshness must be re-established before an update.

The pending export-credential approval remains unanswered. Live Worker-driven encrypted R2 delivery, scheduled backups, failure alerts, independent populated cloud restoration and deployed capacity measurements remain open. Physical iPad/outage/staff acceptance, MFA, retention decisions, customer account/key ownership and handover acceptance also remain open. The production goal stays active.
