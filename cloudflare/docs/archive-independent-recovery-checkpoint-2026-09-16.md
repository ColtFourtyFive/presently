# Independent v2 recovery checkpoint

September 16, 2026. Application `0.1.0`, local schema 24 unchanged. The production goal remains active.

The integrated suite passed **529 tests across 48 files in 182.43 seconds**, with zero failures. TypeScript and the production build passed. Release fingerprint `7b1093835ae587ec79ceb8d254703b18bf0cb4231789606a01729e9c05d2591e` covers 239 files and remained unchanged through validation. The same 39 store/CLI acceptance tests also passed on Node 22.13.1, the verified minimum runtime line. The package now requires Node.js 22.13 or later.

## Recovery behavior

Standalone history recovery and combined SQL/archive recovery now verify v2 semantic graphs without the original application database. A private SQLite store holds authenticated archive records and supplies exact lookup and indexed relationship pages. Part checksums, byte counts, ordering, and table counts bind the stored rows to authenticated descriptors. Duplicate input, unsupported shapes, and changed manifest identity cannot replace evidence.

The store limits queries to 64 records per page, caps staged JSONL at 512 MiB, and enforces a 1 GiB main database-file limit. Transaction failures preserve rows and counters atomically. The main-file cap excludes rollback journal, encrypted staging, and JSONL output space. Files are private and scratch is removed before output publication.

Independent query-plan tests found SQLite could choose a primary-key range and filter unrelated rows for an empty relationship. Relation queries now select their matching index explicitly; tests inspect the actual SQL plan. Node SQLite is imported only for v2 CLI paths, preserving the v1 runtime path. Both CLIs reject symlink components inside the selected encrypted bundle.

The new acceptance suite covers native guardian-linked departures, corrections, original sealed receipts including literal `"null"`, linear addenda, a combined encrypted SQL/history bundle, and recovery from copied objects after the original object bundle is removed. Freshly re-encrypted but semantically inconsistent evidence fails. Wrong/missing keys, missing/corrupt parts, symlink inputs, and interruption leave no published partial output or private SQLite files. Five portable sink tests cover factory allocation, disposal, disposal failure, bad root pins, and fail-closed v2 handling without a semantic store.

The SQL fixture is explicitly synthetic and does not claim a provider export. Existing compatibility tests continue to cover native local D1/R2 backup and separate D1 restore. No live cloud restoration occurred.

## Representative offline measurement

A detached native monthly fixture with **2,550 visits and 14,295 records** recovered from 56 encrypted parts. Recovered JSONL matched every original record exactly. On Node 22.13.1, the CLI subprocess took **1.82 seconds** including startup and TypeScript loading; peak resident memory was **162,016 KiB**. The measured run published private output and no SQLite scratch.

This is offline Node evidence. It is not Worker CPU, deployed D1/R2 billing, live delivery, production capacity, or customer acceptance evidence. Machine-readable results are in `tmp/recovery-v2-checkpoint-evidence-20260916.json`, with source-pinned measurement and output hashes. Historical schema 19–24 checkpoint artifacts were rehashed and remain unchanged.

## Remaining production work

The operational producer and review reader still use v1 verified copies. Durable published descriptors, permanent exact locators, source/registry reconciliation, and generation-fenced archived request resolution remain unfinished. Independent recovery of a published locator catalog still needs reconciliation after SQL restore. This checkpoint proves offline v2 graph recovery, not that full publication/eviction contract.

Next implement one verified monthly publication and exact request resolution while retaining source rows. Then complete archive-aware reports/corrections, addenda, holds, safe eviction, and operational scheduling. Budget entry/replay admission, approved terminal bounds and containment, UTC reconciliation, retention/cleanup reserves, alerts, and deployed capacity measurements remain open.

Live backups and failure alerts still need the approved export credential and a populated cloud restore rehearsal. Physical iPad, staff/outage/pickup/training acceptance, customer accounts/key custody, contracts, and handover remain required. No deployment, remote migration, source removal, automatic backup activation, or paid upgrade occurred. Railway stays available; the last verified Cloudflare installation remains empty on schema 1–4.
