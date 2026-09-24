# Archived correction outbox checkpoint

Updated September 17, 2026.

Schema 31 lets a manager correct an authenticated archived visit after its operational `visits` row is absent. The correction is written to immutable D1 authority instead of recreating the evicted source row.

The migration adds `history_correction_outbox`, a 61st backup table. One native statement inserts the pending correction, advances `history_visit_heads`, inserts `history_correction_heads`, and reserves the request ID. Any late trigger failure rolls the entire statement back. Backup maintenance blocks inserts, updates, and deletes. Accepted rows cannot be changed or removed.

The application uses live visit detail first, the latest outbox result second, and authenticated encrypted R2 detail third. A second archived correction can therefore use the immutable first result without another R2 read. Direct visit lookup, student profile history, reports, request replay, and the audit reader include pending archived corrections. A retry that races source eviction rechecks durable request ownership before requiring visit detail.

The audit reader keeps each source query independently bounded. Live audit branches retain their ordered merge plan, and outbox rows use `history_correction_outbox_center_time`. The 2,500-row native fixture read 407 rows for its first 200-row scan and at most 410 rows on later pages.

Restoration treats the outbox as authenticated D1 authority only after the encrypted database backup has been verified and restored and `history_runtime` is ready. The restored row, retained visit head, correction head, and request key must remain consistent. This checkpoint does not treat an unverified SQL copy as authority.

Validation completed:

- Native schema 31 tests cover migration rollback, late-trigger rollback, two-writer concurrency, backup maintenance, forged inserts, immutability, inventory, restoration, and a subsequent correction.
- Archived request replay remains compatible with schema 17–30 fixtures.
- Focused archived correction, range reader, request replay, and audit tests passed 54/54.
- Complete candidate regression passed 802/802 tests across 72 files with two workers.
- TypeScript, the production build, and Wrangler 4.100.0 production dry run passed.

This is an intermediate durable outbox. It does not authorize source eviction. Authenticated R2 addendum publication and restored-generation reconciliation must land before pending corrections can leave D1 or source eviction can be enabled.
