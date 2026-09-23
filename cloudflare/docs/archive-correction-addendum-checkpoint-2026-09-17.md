# Archived correction addendum checkpoint

Updated September 17, 2026.

Schema 32 publishes each accepted `history_correction_outbox` row as a small encrypted R2 addendum. The addendum contains exactly three authenticated records: the resulting visit, the correction, and its audit projection. It references the exact monthly archive or preceding addendum that supplied the prior visit version.

Publication remains fail closed:

- A monthly parent must have current-generation `archive_publication_availability` and an exact visit locator.
- An addendum parent must have current-generation availability, the same visit, and the exact preceding version.
- Every parent manifest and selected visit part is reread and authenticated before an addendum is written.
- The part and manifest are written under immutable content-addressed R2 keys and reread before D1 publication authority is committed.
- Publication, initial availability, and the build's terminal checkpoint commit in one native batch.
- Competing publishers can write harmless unreferenced objects, but only one D1 publication can own a correction.
- The outbox, retained visit head, correction head, and request key remain in D1. Schema 32 removes no source authority.

Restoration rotates `history_runtime.generation`, invalidates every addendum availability row, invalidates unfinished publication and reconciliation work, and retains immutable publications and receipts. Parent archive reconciliation must finish first. Addendum reconciliation then rereads its manifest, part, parent visit, record-set digest, semantic version transition, and audit projection before a fresh immutable receipt can reactivate it. Reads walk the complete current parent chain, so a child cannot stay readable after any parent becomes unavailable.

The scheduled archive maintenance path performs at most one addendum publish or reconciliation per invocation. A restored or transiently failed addendum gets at most four reconciliation attempts in one generation. Backups include all five schema-32 tables and pin published addendum roots alongside monthly roots, so independent recovery receives every recursive R2 dependency.

Native schema-32 tests cover:

- failed migration rollback followed by a clean atomic migration;
- source-free addendum lookup with no operational `visits` row;
- exact R2 readback, replay, and a second correction chained to the first;
- one winner under two concurrent publishers;
- interrupted upload without D1 publication authority;
- immutable publication/build rows and rejected forged reconciliation descriptors;
- same-generation parent invalidation;
- restored-generation invalidation and parent-first reconciliation;
- restart of a pre-publication build invalidated by restoration;
- in-flight generation rotation before receipt commit;
- missing and corrupt addendum parts;
- backup inventory and archive-reference pinning;
- continued retention of all D1 outbox authority.

Final candidate validation passed 811/811 tests across 158 suites and 73 test files with two Vitest workers. TypeScript, the production bundle, and Wrangler 4.100.0 dry run passed. Evidence is in `.installation-work/archive-correction-addendum-candidate/review/archive-correction-addendum-full-regression.json`, `.installation-work/archive-correction-addendum-candidate/review/archive-correction-addendum-check.log`, `.installation-work/archive-correction-addendum-candidate/review/archive-correction-addendum-build.log`, and `.installation-work/archive-correction-addendum-candidate/review/archive-correction-addendum-wrangler-dry-run.log`.

No deployment, remote migration, source eviction, Railway change, or live-data mutation occurred.

Schema 32 deliberately limits a linear correction graph to 16 addenda for one archived visit, matching the archive format's authenticated graph-depth bound. R2 objects written by a publisher that loses a race or is interrupted are not authority and need a later orphan-cleanup job. Before source eviction can be enabled, the release still needs addendum compaction for long-running installations, legal and operational holds, expiry scheduling, and an atomic eviction transaction.
