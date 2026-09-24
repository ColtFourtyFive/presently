# Mixed archive boundary measurement

Supplementary schema 20 evidence captured September 16, 2026 at 20:44:58 UTC. This measurement adds a mixed attendance/context case to the earlier month and context-only boundary results. It does not replace the frozen schema 20 checkpoint or its measurements. It excludes schema 21 lifecycle bookkeeping and does not establish deployed capacity.

## Input and preservation

The archive contains all 14,295 records from the existing native-trigger synthetic month, plus 5,705 synthetic context records. Every original record matches its saved serialization, including accepted receipts, payload hashes, audit details, and device context. The original source file's hash was checked before and after the run. No accepted receipt or historical hash was rewritten.

Added context consists of 143 students, 143 guardians, and 5,419 student/guardian links. Notes of 823 or 824 characters bring the archive to exactly 16,777,216 JSONL bytes without exceeding the 1,000-character authority-note limit. The archive contains exactly 20,000 records in 79 authenticated encrypted parts.

The new session, archive, student, and guardian IDs are 100 characters; new composite relationship keys are 207 characters. The original center ID remains `test-center`, and native attendance, correction, visit, review, and audit keys remain 36 characters. This is a mixed measured case with long added context keys, not an exhaustive worst-case bound for long attendance-derived keys.

| Record type | Count |
| --- | ---: |
| Centers | 1 |
| Students | 483 |
| Guardians | 603 |
| Student/guardian links | 6,099 |
| Staff | 8 |
| Visits | 2,550 |
| Attendance events | 5,101 |
| Corrections | 25 |
| Reviews | 2 |
| Audit entries | 5,128 |

## Measured result

The run used a separate copy of the populated schema 20 SQLite baseline. It retained production authentication, admission checks, statement limits, and semantic validation. There was no remote operation, admission bypass, or fabricated size metadata; the local primary transport reported its actual page allocation.

| Stage | Allocated database bytes | Added bytes from baseline |
| --- | ---: | ---: |
| Baseline | 175,083,520 | 0 |
| Authenticated staging | 257,945,600 | 82,862,080 |
| Completed verification | 259,874,816 | 84,791,296 |
| After cleanup | 259,874,816 | 84,791,296 |
| Closed after local VACUUM | 175,083,520 | 0 |

The bounded runner and independent full semantic verifier both passed. Verification produced exactly 5,125 operation references, 2,550 visit totals, and two resolution witnesses. Derived state added 1,929,216 allocated bytes after staging. The runner took 22,565 advances with at most 26 actual statements per advance; external statement counts matched its reported counts.

Total growth was 80.86328125 MiB. It fits the 128 MiB planning allowance with 47.13671875 MiB remaining. This measured case therefore adds no evidence that the allowance must increase. The earlier context-only boundary remains the larger observed allocation, at 117.6875 MiB.

Cleanup completed in 440 calls, each deleting at most 64 private entries. All private staging and derived records were removed, and business-table counts remained unchanged. Before VACUUM, 84,791,296 bytes were reusable while the database retained its allocation. Integrity and foreign-key checks passed. The baseline file remained byte-for-byte unchanged.

Sampled local main/WAL/shared-memory/journal files totaled at most 265,700,336 bytes. The helper took 814,451 samples after statements and commits. That filesystem total is separate from the 259,874,816 allocated database bytes, does not bound transient peaks between samples, and is not a D1 billable-size observation. Local VACUUM does not establish remote D1 reclamation.

The measured runner wall time was 82.50 seconds, including frequent page and filesystem sampling. It is an instrumented local duration, not deployed Worker CPU or production invocation performance. This run did not measure native D1 billed rows.

## Pinned scope and hashes

The helper used the already migrated schema 20 baseline and did not discover or apply later migrations. Its archive code and verifier were bundled before execution, so concurrent schema 21 work could not change the running implementation. The retained source inventory identifies migration files 1 through 20, the helper, and relevant archive modules.

| Artifact | SHA-256 |
| --- | --- |
| Populated schema 20 baseline | `7825d0f4dca0abaffe94f76e2cc0bbebe2239c6fedce5f1d8783e9868309e99e` |
| Unchanged native source JSON file | `d0a2e8145e1f0e9e503254368a379cec84de69f5c509c8a84dbe7b3bfe422330` |
| Combined sorted source JSONL | `ef1f7ea70c056df8d20c72dc508b905b43fcd45b799b063e669c5c30cea78b09` |
| Executed measurement/runtime bundle | `0a6cd754c6313bbb9991ebaf289ca0dc16e4f702b8ee3cb1ad92519314db0db4` |

The native JSON file and combined JSONL use different serializations and contain different record counts. Their hashes are not interchangeable. Preservation was established by exact serialized-record comparison as well as the unchanged native file hash.

Local artifacts:

- [Full evidence and page breakdown](../tmp/staging-mixed-boundary20/evidence.json)
- [Pinned source inventory](../tmp/staging-mixed-boundary20/pinned-source.json)
- [Executed runtime bundle](../tmp/staging-mixed-boundary20/measure.bundle.mjs)
- [Measurement helper](../.installation-work/measure-staging-mixed-boundary20.ts)
- [Run log](../tmp/staging-mixed-boundary20.log)

These scripts and artifacts remain in excluded local validation directories. The measurement does not modify the frozen schema 20 checkpoint manifest or earlier measurement files.

## Remaining capacity gates

The allowance remains provisional. Long attendance-derived identifiers, fragmented-page behavior, deployed CPU, and provider billing still need evidence. Schema 21 lifecycle bookkeeping and future diagnostics, pacing, and publication add work not measured here. The separate native local D1 month measurement already exceeds one documented daily Free-plan write allowance, so tested scheduling across days remains necessary before unattended activation. This result does not enable publication, source eviction, or a paid upgrade.
