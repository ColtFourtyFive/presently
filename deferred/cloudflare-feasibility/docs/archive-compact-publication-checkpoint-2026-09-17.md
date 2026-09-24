# Direct compact publication checkpoint

Updated September 17, 2026. Local schema **28** adds direct version-2 monthly publication without first materializing the version-1 per-record locator catalog. This is an internal publication checkpoint. Public receipt routes still use version 1 until compact reconciliation and reader integration are complete.

## Implemented contract

`startCompactMonthlyPublication` admits only a completed, current authenticated semantic snapshot. `advanceCompactMonthlyPublication` walks the exact native event, correction and audit prefixes in pages of at most eight records. Native D1 guards verify immutable source values, permanent request ownership, original-arrival month membership, sealed event receipts, current proof, lifecycle state, maintenance state, lease ownership and revision before each checkpoint.

The terminal transaction proves bidirectional membership between the authenticated archive graph and `archive_compact_requests`, then inserts the immutable descriptor and ready availability together. Direct compact and version-1 publication reserve the same center/month and archive/request claims in both directions. Failed or restored candidates cannot publish through a later generation.

Schema 28 adds five tables:

- `archive_compact_builds`
- `archive_compact_identities`
- `archive_compact_requests`
- `archive_compact_publications`
- `archive_compact_availability`

Backups include all five tables and every committed compact archive root. Restore reset invalidates unfinished builds, clears leases and marks compact availability unavailable while retaining immutable descriptors, request maps, proof identity and permanent ownership. Restored authority cannot be marked ready again under schema 28; a fresh compact reconciliation contract is the next step.

## Validation

The frozen release fingerprint is `d5af7209d9353bf7cd3c484ed1e166c98fccad259f19082acafb6457bdb163a8` across **279 files**.

The validation covered **749 unique tests across 65 files**. The first long process passed 745 tests. Four tests in three late-running files encountered process-level timeouts or connection resets after more than 40 minutes; all 45 tests in those three files passed in a fresh isolated rerun against the unchanged fingerprint. TypeScript and the production build passed.

Focused evidence also passed:

- 32 native compact-publication cases, including lost replies, bounded prefixes, source/owner corruption, cross-format conflicts, lifecycle expiry, maintenance fencing and terminal membership substitution.
- Three encrypted backup/recovery cases, including separate CLI decryption, independent SQL integrity and foreign-key checks, restored authority revocation and preservation of private partial maps.
- Two native schema 27-to-28 cases proving exact existing-schema/source preservation, full rollback after a late migration failure and successful retry.

Evidence is under [the frozen candidate review](../.installation-work/direct-compact-candidate/review/). The combined validation manifest is `combined-validation-evidence.json`; the exact reviewed patch is `direct-compact.patch`.

## Storage result

For the same representative 5,126-request month used in the schema-27 catalog audit, the complete compact table/index layout occupies **868,352 bytes after VACUUM**, including all five tables and all seven secondary indexes. The request map and its required reverse index consume 819,200 bytes together. Fixed build, identity, descriptor and availability rows/indexes add 49,152 bytes.

That table/index layout is **88.30% smaller** than the prior 7,421,952-byte version-1 catalog model. A full-schema physical model, including installed schema metadata, adds 970,752 bytes over a fresh schema-27 database.

These are independently verified SQLite physical models using the unchanged representative month. They are not a native accepted large publication, remote D1 measurements, net database size after source removal or evidence of Free-plan capacity. The verifier deliberately reports the absent external owner rows in the physical model rather than treating it as deployable state. See [the measurement report](../.installation-work/direct-compact-candidate/review/storage-measurement/README.md).

## Remaining authority

Public routes do not yet select compact publications. A fresh restored-generation reconciliation must authenticate the original archive graph, prove exact compact map membership and issue an immutable current-generation receipt before compact availability can be reenabled. The existing six receipt paths must then dispatch by explicit catalog version, preserve retained-source precedence and owner/hash rejection before R2, and recheck publication identity, generation, availability, map and reconciliation receipt after object reads.

Historical date/student ranges, current visit/review authority, reports, corrections, addenda, holds and safe source eviction remain separate work. No live deployment, remote migration, scheduler activation, paid upgrade or source deletion occurred in this checkpoint.
