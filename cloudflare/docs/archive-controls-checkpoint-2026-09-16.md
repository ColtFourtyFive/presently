# Archive control and cleanup checkpoint

September 16, 2026. Application `0.1.0`, local schema 22. Production release remains pending.

The integrated suite passed **392 tests across 38 files** in **126.18 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `44ec0b5369d5cc0bd407ca7fa52d4e03a680ad3b1ab03e8164a10dbbb226ee2b` covers 209 files and stayed unchanged through validation. The [checkpoint manifest](../tmp/controls22-checkpoint-evidence-20260916.json) records artifact hashes and verifies preserved schema 19–21 evidence. The measured native runtime bundle also matches a fresh build of the final source.

## Completed locally

Schema 22 adds internal pause/resume and bounded renewal, conditional expiry, leased cleanup, and retained operational diagnostics. Controls use captured revisions and execution generations. Exact retries return their original receipt; changed reuse conflicts. A restored execution cannot borrow an old receipt. Pauses and renewals cannot seize a live verifier lease, invent progress, or extend a verified snapshot's fixed deadline. Expiry rechecks the candidate inside the mutation transaction, so accepted progress can invalidate a stale expiry attempt.

Cleanup claims cannot replace a live owner. Each bounded page checks the token, original and execution generations, lifecycle revision, and database lease time. Deletion and lease checkpoint commit together; a failed checkpoint rolls deletion back. Final completion writes its diagnostic and deletes the parent/lifecycle atomically. Exact retry after a lost response reads that receipt without a write. Its returned `deleted: 1` is the original result. Maintenance, restoration, takeover, wrong tokens, and competing pages are covered by native tests. Working rows disappear only through explicit cleanup; no scheduler or operator endpoint has been enabled.

Backups include diagnostics. Independent encrypted SQL restoration and repeated resets preserve admission, progress, verification, and renewal evidence, clear control/cleanup authority, and retain stable reset notes even for already-invalid sessions. Diagnostics survive parent cleanup. Their retention/pruning policy remains unresolved and is separate from attendance retention.

Integration also exposed and fixed a review-resolution timestamp race. The accepted review and its audit now use one captured timestamp. A deterministic clock-tick test protects the strict archive witness rule; verification was not weakened.

## Migration and recovery evidence

Migration SHA256: `d7e0fbd807fd29243f36c7ac5262c64539ed753989bdbab983e44e2be067ac36`.

| Local check | Result |
| --- | --- |
| Empty native workerd/D1 schema 4 → 22 | 47.21 ms; original values, maintenance, rollback, integrity and foreign keys passed |
| Populated synthetic SQLite schema 6 → 22 | 1.871 s; original source values, 120,940 logical audits and 120,000 accepted receipts preserved |
| Size after migration and local VACUUM | 133,840,896 bytes |
| History backfill | 365 calls, at most 500 records; 2.191 s; 120,940 request keys, 60,000 visit heads, zero archive locations |
| Closed size after backfill and local VACUUM | **175,140,864 bytes** |

All three final schema 22 migration/backfill JSON files are included in the checkpoint. Both populated SQLite databases were reopened read-only for integrity and foreign-key checks. These timings are local measurements.

## Native local D1 lifecycle usage

The authenticated 14,295-record month completed staging, 16,860 verifier advances, and 350 cleanup pages. Verifier advances used at most 26 prepared statements. Cleanup returned at most 64 working-record deletions per page; metadata and diagnostic writes are counted separately by native D1 metrics. Verification produced 5,125 operations, 2,550 visit totals, and two review witnesses. It did not publish archive locations or create source attendance rows.

| Phase | Native rows written |
| --- | ---: |
| Staging parts | 57,404 |
| Verifier advances | 99,680 |
| Cleanup pages | 22,733 |
| Other lifecycle work | 18 |
| **Total** | **179,835** |

The run reported **3,180,523 rows read across 296,789 statements**, with no missing row/size metrics and no failed batches. All working rows were absent after cleanup. Two immutable diagnostics remained: one claim and one completion. Completion replay added zero writes.

Native `size_after` was 733,184 bytes initially, peaked at 41,422,848 bytes, and ended at 733,184 bytes. Local workerd elapsed time was 55.934 seconds. The measurement loops inside one isolated local request to avoid host connection exhaustion; it does not establish production request CPU, provider charges, remote storage reclamation, or deployed capacity. See [native measurement](../tmp/native-month-d1-usage22/measurement.json).

The write total exceeds the previously documented 100,000 Free-plan daily allowance before ordinary application activity. Daily reservations, crash/retry settlement, UTC rollover, cleanup reserves, and shared-account headroom remain necessary. Pause/resume controls alone do not enforce a daily budget. Schema 20 allocation-boundary artifacts remain historical inputs; the provisional 128 MiB allowance is not an exhaustive schema 22 or deployed worst-case bound.

## Remaining release work

Implement and measure daily background budgets, alerts and scheduling before unattended archival work. Complete immutable publication, exact R2 receipt resolution, independent published-v2 recovery without source rows, historical reporting/corrections, addenda, holds and eviction fences. Unmatched exceptional-departure time correction remains unfinished.

Live Worker-to-R2 backup delivery and independent populated cloud restoration, deployed capacity, physical iPad/staff acceptance, and customer-owned handover remain open. No deployment, remote migration, upload, data mutation, or paid upgrade occurred. The last verified Cloudflare installation remains empty on schema 1–4, automatic backups are disabled, and export-token approval remains pending. Railway remains available. The production-readiness goal stays active.
