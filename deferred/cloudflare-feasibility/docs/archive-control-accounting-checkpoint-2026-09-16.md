# Durable control accounting checkpoint

September 16, 2026. Local schema 24, application `0.1.0`. The production goal remains active.

The integrated suite passed **485 tests across 45 files in 154.63 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `b9aa3a857cc5b1378e97a4e2b89b57d50a20e218160cbe9df32e6332c5f6e55f` covers 234 files and stayed unchanged through validation. Migration 24 is pinned to `c7acfd58d2a62f1a22faaedd663f96648a46f3b63497a69f864ac071a8ca4f7a`. Machine-readable evidence is in `tmp/controls24-checkpoint-evidence-20260916.json`; previous schema 19–23 checkpoint artifacts were rehashed and remain intact.

## Behavior verified

Every fresh reservation now creates a durable pending control liability. Pending controls block new reservations and day opening even after work settlement. A private native collector seals one-use evidence bound to the same invocation. The terminal operation records the observed prefix and prepaid terminal allowance separately in one SQL update. Unknown coverage, unresolved work, known deficits, and saturation close dispatch while retaining held work when necessary. Completed control records and receipts are immutable.

Lost terminal responses leave either a pending gate or an already-committed immutable receipt. There is no automatic retry or status query. Pre-24 attempts migrate to explicit unresolved control evidence without changing their balances. Effective runtime status includes pending controls, UTC day, history generation/readiness, and maintenance.

Nine encrypted restore cases cover reserved and executing work, work settled with pending control, unknown work, healthy terminal receipts, lost reservation/terminal replies, unknown prefix metadata, and overrun. Restore preserves liabilities, receipts, and counters, rotates execution authority, and keeps dispatch closed. The focused recovery/backup suite passed 41 tests.

## Native local measurements

Both ordinary and guardian-linked exceptional fixtures completed 57 actual budgeted adapter calls. Their maximum whole-call costs were 36 and 37 SQL statements respectively. These include reservation, claim, every work fence, work settlement, and terminal accounting. The work ceiling is 26 statements, with 14 reserved for the enclosing control sequence.

The terminal statement measured 19 reads/4 writes on the healthy path, 33 reads/5 writes on unknown/overrun/saturation paths, and 4 reads/0 writes after stale generation. Each used one SQL statement. Evidence is in `tmp/native-control-terminal24/measurement.json`.

The maintenance-fenced empty native migration and populated synthetic migration passed, including deliberate atomic rollback. All original values, 120,940 logical audits, and 120,000 accepted receipts survived. The populated file measured 133,926,912 bytes after local VACUUM, then 175,226,880 bytes after bounded history backfill and another local VACUUM. Backfill used 365 calls with at most 500 records each. Schema 24 added 28,672 bytes relative to the previous equivalent closed fixture. These are local SQLite file sizes, not deployed D1 billing or CPU measurements.

## Limits and next work

The terminal receipt uses policy `archive-control-terminal-v1`, a provisional prepaid tail of 64 reads, 16 writes, and one statement. The final statement cannot observe its own cost before committing. A returned cost above that bound stops the adapter with an explicit error, but its previously committed receipt may still be settled. A regression test records this limitation. A defensible deployed bound and independent containment are required before dispatch activation.

Entry, denial, replay, and lost-reservation response costs still need admission. The measured policy catalog, UTC reconciliation, ledger retention, cleanup reserves, alerts, and full representative-month budgeted capacity remain open. The earlier 16,860-advance direct-runner benchmark is preserved as historical schema 23 evidence; it is not relabeled as a schema 24 adapter measurement.

Authoritative publication, permanent archive locators, independent recovery without original source rows, archive-aware reports/corrections, and safe eviction remain unfinished. Live backup delivery, alerts, independent populated cloud restoration, deployed Free-tier capacity, physical iPad/staff/outage acceptance, and customer-owned accounts/keys/handover remain release gates.

No deployment, remote migration, live data change, or paid upgrade occurred. The last verified Cloudflare installation remains empty on schema 1–4, automatic backups are disabled, and export-token approval remains pending. Railway stays available through validated cutover.
