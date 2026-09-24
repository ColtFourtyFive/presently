# Historical retention dry-run checkpoint

Updated September 18, 2026.

Schema 33 adds the first hold-aware retention control for the D1 live tier. It is deliberately non-destructive. It can identify and verify bounded historical visit candidates, but it cannot delete D1 rows or R2 objects.

The default policy keeps at least 90 days of operational history in D1 and at least 730 days of evidence. Evidence expiry is disabled. Each job is capped at 25 candidates by default and 100 candidates at the schema boundary. The scheduler advances at most one candidate per invocation.

Legal and operational holds are immutable records with separate immutable release records. Visit holds resolve through `history_visit_heads`, so a hold can still be created after operational visit rows have been removed in a later release. Student holds cover every visit for that student. Legacy `archive_holds` writes are mirrored for rolling-code compatibility while live source exists.

Every selected candidate pins:

- the exact current visit head and deterministic source-closure JSON;
- its monthly publication and manifest;
- the ordered correction-addendum authority chain;
- a fresh authenticated read of the monthly and addendum R2 evidence; and
- content digests for the source closure, addendum authority, and recovered evidence.

Selection rechecks the source head, source closure, holds, pending reviews, publication state, addendum state, history generation, backup maintenance, and R2 evidence after every await and again in the committing transaction. A concurrent hold, visit/source mutation, publication or addendum change, policy revision, or restoration generation change invalidates affected work. Expired leases can be reclaimed; live leases and one active planning job per center remain fenced.

Completion creates an immutable receipt with `mode='dry_run'` and `delete_enabled=0`. The schema rejects any other value. The Worker and migration contain no visit, event, correction, review, audit, or R2 deletion path. Completed receipts that later lose authority retain an immutable invalidation record and cannot become deletion authority without a separate future migration and transaction-local capability.

Backups now include all 74 authority tables, including the eight schema-33 hold and retention tables. Backup maintenance blocks their mutations. Existing recovery generation rotation invalidates unfinished retention work and records invalidations for completed dry-run evidence while preserving all immutable rows.

Validation passed:

- 818/818 tests across 75 test files in 815.79 seconds;
- the focused schema-33, populated 32→33 migration, backup, recovery, publication, reconciliation, and budget-runner checks;
- source-free hold creation and release, holds before and during R2 verification, source drift, restoration invalidation, expired-lease reclaim, and exact one-item scheduling;
- TypeScript checking and the production build;
- Wrangler 4.100.0 dry-run packaging with 60 static assets and a 494.52 KiB Worker upload (112.98 KiB gzip); and
- an exact 302-file candidate fingerprint of `4083b853131fd7d9b72f1df2a88a78dd87ffb834c71a395a517c4b5dccaccdf8`, derived from the schema-32 298-file fingerprint `b908adf193463360f78422cd99911dcd93ca4368fb6586204cf06df092ae15a8`.

The promoted local root matched all 302 candidate files byte for byte. Its focused hold, retention, backup, and recovery verification passed 48/48 tests across 11 suites and 4 files; root TypeScript, production build, and Wrangler dry-run packaging also passed.

Evidence is retained in `.installation-work/archive-retention-candidate/review/`.

No deployment, remote migration, Railway change, source eviction, R2 deletion, paid upgrade, or live-data mutation occurred.

Before source eviction can be considered, the release still needs correction-addendum consolidation, reference-aware cleanup of unauthoritative R2 objects, an explicit expiry scheduler, atomic hold-aware source eviction, remote D1/R2 capacity evidence, and a populated cloud recovery exercise. Source eviction remains disabled.
