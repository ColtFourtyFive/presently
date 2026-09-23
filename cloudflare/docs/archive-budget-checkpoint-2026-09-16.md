# Archive budget checkpoint — September 16, 2026

Schema 23 is verified locally. **Production release remains pending.** Budget controls start closed and are not connected to archive work, public routes or a scheduler. No live deployment, remote migration, source eviction, token creation or paid upgrade occurred. Railway remains available.

The integrated suite passed **427 tests across 41 files in 132.97 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `eb5fe4b01323fc39fe090a020829dbf2a1d2f0d3cb7d1bd0ae785739537b274e` covers 219 files and was unchanged through validation. Migration 23 SHA256 is `613f279b089618c3b8b96ae057ee5c7ac34f468a6d0aed489abed35701b2fe73`.

## Implemented and tested

The ledger separates work, cleanup and control pools under an immutable daily allocation. Reservations hold declared costs atomically. A fresh successful claim issues one consumable in-process grant; replay returns a receipt without another executor. Every collected work batch includes a current authority and maintenance fence in the same D1 transaction.

Settlement accepts authentic in-process native usage. It preserves observed costs, conservatively charges missing metadata or transport uncertainty, and closes dispatch on unknown usage or overruns. Other same-day executions can still record terminal costs after closure. Aggregate saturation is explicit and reported as a lower bound. It cannot reopen capacity. JavaScript private fields prevent the returned collector from exposing its raw transport or mutable grant record.

Independent tests cover oversubscription, changed retries, one-shot authority, invalid usage, lost responses, sticky closure, saturation, same-day epoch replacement, past-day rollover, and unresolved liabilities. Native rollback tests prove stale execution fences abort work atomically. Encrypted restore tests preserve populated allocations, pools, attempts and receipts through repeated access resets while rejecting copied execution authority. Restoration closes into an unreconciled epoch; there is no reopening API in this phase.

See [the ledger module](archive-budget-ledger.md) for the contract and limits.

## Native cost sample

The isolated local workerd measurement completed 64 synthetic attempts. Each work step contained one insert and one indexed read, plus the collector's fence. These are measured sample costs, not maximum envelopes for archive work or deployed billing guarantees.

| Operation | Rows read | Rows written | Submitted statements |
| --- | ---: | ---: | ---: |
| Open day | 48 | 8 | 8 |
| Reserve | 18 | 6 | 4 |
| Claim | 15 | 4 | 5 |
| Guarded synthetic work | 6 | 1 | 3 |
| Settle | 18 | 5 | 4 |
| Close | 23 | 3 | 4 |
| Abandon | 33 | 6 | 5 |
| Exact replay | 3 | 0 | 1 |

Reservation, claim and settlement alone added 15 writes and 13 statements per sampled attempt. Replays and denials consumed reads without changing pool charges. Two intentionally rejected write batches did not return complete cost metadata: their observed totals are lower bounds, never evidence of free rejection. Ten denial/replay calls consumed at least 27 reads without changing ledger balances. Of 1,062 submitted statements, 1,056 returned metrics; the missing six belong to the two rejected batches. Successful reservation overhead is supplied policy data and does not automatically cover all these calls.

Adding schema 23 grew the isolated native logical database snapshot by **61,440 bytes**. The measured work grew it by another **131,072 bytes**, ending with 65 attempts, 196 receipts and 64 synthetic work rows. These snapshots include committed WAL through SQLite backup; no VACUUM was used. This small sample does not establish long-term growth. Ledger and diagnostic retention/compaction remain activation gates.

The measurement runtime bundle SHA256 is `b4ca37ce834b42fe116ae22498a3f0308b1b277da5d64ead0343ea2f99b950df`. The finalizer rebuilt it from current source and verified it matched. The [measurement](../tmp/budget23/2026-09-16T22-07-22.278Z-final-c8c40210/measurement.json) includes source hashes, per-statement metadata, inspection costs, coverage flags and storage snapshots. Snapshot integrity and foreign-key checks passed.

## Migration and history preservation

The saved empty schema-4 export migrated locally through schema 23 in **50.89 ms** using native D1. A populated synthetic SQLite schema-6 fixture migrated in **2.097 seconds**. Both rehearsals verified maintenance and full rollback after a deliberately injected failure. All original source fields, **120,940 logical audits** and **120,000 accepted receipts** were preserved.

The populated file measured **133,898,240 bytes** after migration and local VACUUM. Bounded backfill created 120,940 request keys and 60,000 visit heads in 365 calls of at most 500 records, taking **1.997 seconds** locally. The closed file measured **175,198,208 bytes** after backfill and local VACUUM, with zero activated archive locations. These sizes are not deployed D1 reclamation evidence.

Evidence: [empty native migration](../tests/empty-native-migration-results-23-final.json), [populated migration](../tests/full-release-migration-results-23-final.json), [history backfill](../tests/history-lookup-scale-results-23-final.json), and [checkpoint hashes](../tmp/budget23-checkpoint-evidence-20260916.json). Historical schema 19–22 checkpoint artifacts were reverified and remain unchanged.

## Next integration boundary

The next slice is one internally invoked, already-reserved monthly verification step. It must bind the attempt to the exact run, frozen snapshot, expected revision, phase and envelope version. It must count all ledger calls and injected batch fences, prepay entry/rejection/replay/settlement overhead, and reserve room for terminal accounting. The runner's current query count excludes those costs. Reducing its existing limit blindly would misclassify a resource pause as a permanent semantic failure.

Automatic activation still needs measured worst-case envelopes, UTC liability reconciliation, account headroom, retention/compaction, cleanup reserves, alerts and deployed CPU/D1/R2 evidence. Publication, authoritative archived history, independent recovery without source rows, eviction, live backup delivery/recovery, physical iPad/staff acceptance and customer-owned handover remain unfinished.
