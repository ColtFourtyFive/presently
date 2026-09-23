# Private archive staging admission

Schema 20 enables admission limits for the entire D1 database, across every center, status, and retained generation. The implementation is internal. It does not enable a route, scheduler, publication, historical receipt fallback, or source eviction.

## Enforced policy

| Limit | Value |
| --- | --- |
| Resident private sessions | One, including invalid or restored sessions awaiting cleanup |
| Supported profile | One authenticated v2 monthly base, one manifest, no references |
| Authenticated source records | 20,000 across all archive tables |
| Authenticated source plaintext | 16,777,216 bytes, or 16 MiB |
| Planning allowance for a new session | 134,217,728 bytes, or 128 MiB |
| Database watermark | 400,000,000 observed bytes |
| Runner jobs per resident session | One |

Admission requires observed database size plus the complete planning allowance to be at most the watermark. Continuing work requires observed size at most the watermark. Equality is accepted. Admission does not subtract reusable pages or expected future eviction. The allowance covers the local measurements below but remains provisional. The size check is a fresh preflight, not an atomic reservation against concurrent application writes.

Migration [0020_archive_staging_admission.sql](../migrations/0020_archive_staging_admission.sql) creates the `archive_semantic_admitted_sessions` view and guards session, manifest, part, row, runner, and derived-state writes. A session insert atomically rejects any existing resident. The view rejects multiple residents, multiple manifests or jobs, oversized declarations, and unsupported profiles. The guards install without deleting or relabeling existing evidence.

The adapter authenticates manifest totals and part descriptors before staging. Each accepted part must match its authenticated sizes, hashes, ordered records, and counts. Records and checkpoint commit together. Duplicate retries reuse the original checkpoint. The limits therefore cover actual records accepted through the adapter, not merely caller-supplied manifest numbers.

## APIs and native observations

[archive-staging-admission.ts](../worker/archive-staging-admission.ts) holds the immutable policy and result checks. `ArchiveStagingDatabase.batch` must use the primary database and preserve native `meta.size_after`. Production callers must use the raw `env.CRM_DB` binding. Independent local SQLite transports calculate their own physical page allocation. Missing `served_by_primary` is not evidence that a replica is primary; transport selection remains part of the contract.

`D1ArchiveSemanticStaging.create` reads size and captures the runtime generation before admission. Its insert rechecks that generation. Manifest registration, part staging, freezing, snapshot reads, and verification recheck admission and fresh result metadata during work. No cached observation substitutes for those reads.

| Condition | Result |
| --- | --- |
| Missing, noninteger, unsafe, zero, negative size, or explicit `served_by_primary=false` | `ARCHIVE_STAGING_SIZE_UNAVAILABLE` |
| Size exceeds the admission or progress threshold | `ARCHIVE_STAGING_CAPACITY` |
| Resident, profile, manifest, or job limit fails | `ARCHIVE_STAGING_ADMISSION_LIMIT` |

The runner returns `paused` for unavailable size or excess capacity, including completed-job replays. Pausing preserves the semantic checkpoint and proof. If failure occurs after lease acquisition, that lease may remain until its 30-second expiry, after which another invocation can take over. Starting a job throws when its preflight fails.

Diagnosis and cleanup remain available without a successful size observation. `resume` still checks session and generation identity. `discard` invalidates a current session; `beginCleanup` and `cleanupPage` remove an invalid session under current cleanup authority. Backup maintenance continues to block protected writes, including cleanup.

Every prepared statement, including admission reads and each batch member, counts against the runner's 40-statement ceiling. This does not measure D1 billed rows or deployed CPU. The full `finalize` oracle remains unsuitable as a production single-invocation verifier for a large archive.

## Legacy state, restoration, and cleanup

Migration 20 preserves existing schema 19 sessions even when there are several or they exceed the new profile. It blocks new admission and further work until cleanup leaves one supported resident. Diagnosis and bounded cleanup remain possible.

Invalidation, semantic failure, lease expiry, and restoration do not release the resident slot. Cleanup removes witnesses, operation references, visit totals, jobs, staging rows, parts, manifests, and finally the session. Each invocation deletes at most 64 entries. Only removal of the final session row releases the slot.

Recovery rotates execution authority, invalidates sessions and jobs, and preserves their original generations and evidence. Old handles cannot resume. Cleanup uses a new current-generation capability against retained original-generation rows. Backup inventory already includes these private tables. Schema 20 adds no separate reservation counter that reset could accidentally clear.

## Local measurements

Both profiles authenticated encrypted v2 manifests and parts, completed the bounded runner, and passed the independent full semantic verifier. Both used separate local SQLite copies and left their baseline files unchanged. Starting schema 20 allocation was 175,083,520 bytes.

| Profile | Native-trigger synthetic month | Synthetic context boundary |
| --- | --- | --- |
| Source records | 14,295 | 20,000 |
| JSONL plaintext bytes | 9,064,646 | 16,777,216 |
| Encrypted parts | 56 | 79 |
| Allocated bytes after staging | 213,848,064 | 298,479,616 |
| Allocated bytes after verification | 215,777,280 | 298,487,808 |
| Total added allocation | 40,693,760 | 123,404,288 |
| Runner calls | 16,860 | 20,012 |
| Maximum actual statements per advance | 26 | 12 |
| Cleanup calls, at most 64 deletions each | 350 | 318 |

The month contains 2,550 visits and produces 5,125 operation references, 2,550 visit totals, and two review witnesses. Derived state adds 1,929,216 allocated bytes beyond staging. Source evidence came from native attendance triggers; existing historical hashes were not rewritten to make it pass.

The boundary contains one center, 143 students, 143 guardians, and 19,713 student/guardian links. Session, archive, center, student, and guardian IDs are 100 characters; composite relationship keys are 207 characters. Synthetic authority notes of 265 or 266 characters bring plaintext to the exact policy cap. It contains no attendance and produces no derived attendance records.

SQLite allocated 19,713 overflow pages for boundary records, totaling 80,744,448 bytes. Each of the three relationship indexes occupies 10,362,880 bytes. Total growth is 117.6875 MiB, leaving 10.3125 MiB within the allowance. This covers the measured case, not every mixture of derived records or fragmented pages.

Boundary main/WAL/shared-memory/journal files had a sampled maximum total of 304,016,688 bytes. Samples after statements and commits do not bound transient peaks between samples. This filesystem total is separate from the database's 298,487,808 allocated bytes and is not a D1 billable-size observation. The final month run did not capture an equivalent filesystem peak.

Cleanup left files allocated at their verification sizes while making added pages reusable. Local VACUUM returned both closed files to 175,083,520 bytes. This does not establish remote D1 reclamation.

Evidence: [month allocation](../tmp/native-month-admission20-v2/measurement-final.json), [boundary allocation and page breakdown](../tmp/staging-boundary20/evidence.json), and [final schema 20 baseline](../tests/history-lookup-scale-results-20-final.json). Temporary measurement artifacts remain in the excluded local validation directory.

A [supplementary mixed boundary](archive-mixed-boundary-2026-09-16.md) also passed at 20,000 records and 16 MiB. It preserves the native month and adds long-ID context, producing the same 5,125 operation references, 2,550 totals, and two witnesses. Added allocation is 84,791,296 bytes, or 80.86328125 MiB. Native attendance-derived keys remain 36 characters; added context/session/archive IDs are 100 characters. Long attendance-derived keys, fragmentation, and deployed measurements remain open gates. This supplementary run pins schema 20 and excludes later lifecycle bookkeeping.

## Native local D1 work measurement

The schema 20 local workerd run used native D1 for the complete 14,295-record month lifecycle. It recorded 2,260,346 rows read, 145,288 rows written, and 295,722 statements. Every result supplied row and size metadata; no batches failed. Source generation and schema setup are excluded. Encryption and JSON work have no D1 row metric.

| Phase | Native local rows read | Native local rows written |
| --- | --- | --- |
| Part authentication reads and staging | 144,462 | 57,292 |
| Runner advances | 1,940,501 | 65,958 |
| Cleanup | 167,498 | 22,031 |
| All remaining lifecycle and validation queries | 7,885 | 7 |
| Total | 2,260,346 | 145,288 |

This run completed 16,860 advances with at most 26 statements each, then 350 cleanup calls with at most 64 deletions each. It used an empty isolated database with a starting native `size_after` of 675,840 bytes and a maximum of 41,365,504 bytes. These sizes are separate from the populated-copy physical measurements above. They are not evidence of deployed size or remote reclamation.

The observed write total exceeds the documented 100,000-row daily Free-plan allowance even before ordinary application traffic. Unattended work therefore needs a tested budget and resumable scheduling across days. Native local metrics do not establish Cloudflare account billing parity or deployed CPU. Confirm those separately, and leave headroom for attendance, imports, backups, other databases, and other applications. The measurements do not authorize a paid upgrade.

Evidence: [complete native local D1 lifecycle](../tmp/native-month-d1-usage/measurement.json). The excluded measurement ran in one local orchestration request; its elapsed duration does not establish production invocation compliance.

## Validation and remaining gates

The 13 focused native D1 admission tests cover simultaneous admission, retry identity, exact thresholds, missing or nonprimary metadata, generation races, legacy over-capacity installation, restoration, partial cleanup, mid-step resource pauses, and external statement accounting through cleanup. No source or public historical-location rows are created by that private lifecycle.

The [current schema 22 native local lifecycle](../tmp/native-month-d1-usage22/measurement.json) measured 179,835 writes, 3,180,523 reads, and 296,789 statements without failed batches or missing metrics. Its 350 cleanup pages leave two retained diagnostics; exact completion replay measured zero writes. The schema 20 measurements above and the schema 21 result of 179,129 writes and 2,361,868 reads remain historical evidence. Schema 22 supplies [explicit pause/resume, renewal, conditional expiry, cleanup leases, and retained receipts](archive-staging-lifecycle.md). Lifecycle and diagnostic writes add to native row usage and are excluded from the cleanup API's proof-entry deletion count. Diagnostic retention and pruning remain unresolved. Daily budgets, unattended scheduling, alerts, deployed CPU, and provider billing remain unverified or unimplemented. Publication and independent combined archive recovery require separate integration before source eviction. See the [remaining admission and cleanup plan](archive-staging-admission-plan.md).
