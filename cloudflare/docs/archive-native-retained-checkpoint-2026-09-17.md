# Schema 29 native retained database checkpoint — September 17, 2026

Production release remains pending. This checkpoint validates the compact archive path locally and records a recovery defect found and repaired during representative measurement. It does not authorize live deployment, source eviction, automatic backup activation, or a paid Cloudflare upgrade.

## Accepted native path

The unchanged representative month contains one center, 340 students, 2,550 visits, 5,101 attendance events, 25 corrections, 5,128 audit records, and 14,295 total archive records. Its source SHA-256 is `d0a2e8145e1f0e9e503254368a379cec84de69f5c509c8a84dbe7b3bfe422330`.

The production code completed these operations against isolated native workerd/Miniflare D1:

1. Authenticated and semantically verified the encrypted monthly graph in 16,860 bounded calls.
2. Published the compact catalog in 1,287 bounded calls.
3. Removed events, corrections, and reviews in a test-only source-free snapshot.
4. Applied the production recovery reset and completed history backfill in 80 calls.
5. Reverified the encrypted graph under the new generation in 16,860 calls.
6. Authenticated all archive records and completed the compact forward and reverse census in 2,430 calls.
7. Atomically committed one current-generation reconciliation receipt and `ready` availability.
8. Restored a post-expiry retained snapshot without transient semantic proof rows and resolved one event and one correction. Each lookup used exactly two R2 GETs: manifest and selected part.

The first recovery run found a legacy-alias defect. Once event and correction source rows were absent, history backfill treated their same-ID audit aliases as standalone audit owners. The permanent owner map is immutable and already identifies those IDs as events or corrections. The worker now excludes those aliases from audit ownership after source removal. A dedicated recovery regression covers the older physical shape.

## Physical result

Exact schema and rows were exported through native D1, materialized with SQLite 3.53, and VACUUMed for `dbstat` inspection.

| State | Size |
| --- | ---: |
| Direct accepted publication | 51,802,112 bytes |
| Source-free pre-recovery counterpart | 47,706,112 bytes |
| Retained reconciled post-expiry database | **8,331,264 bytes** |
| Compact catalog tables and indexes | **868,352 bytes** |
| Schema 29 reconciliation job and receipt objects | **32,768 bytes** |
| Encrypted R2 manifest and 56 parts | **1,571,326 bytes** |

The removed event, correction, and review objects account for 4,149,248 allocated bytes; the compacted whole-file comparison fell by 4,096,000 bytes. The retained database still contains visits and audit entries because historical interval/report/current-visit reads, addenda, holds, and safe production eviction are unfinished.

The 8.33 MB result models normal post-expiry retention. Production lifecycle correctly refuses immediate cleanup of a current verified semantic proof. The test omitted only transient proof tables after receipt commit, restored that state natively, and confirmed the immutable receipt still authorized both request types.

## Validation

The repaired release fingerprint is `0a4a8538fcd4924ad53ed75255588917433ae5522cd5ef18722b2eda9e0a9e5a` across 286 release files.

- 771/771 tests passed across 150 suites.
- TypeScript passed.
- The production build passed.
- All three physical databases passed `PRAGMA integrity_check` with zero foreign-key violations and zero free pages.
- The retained database is schema 29, has 5,126 compact request mappings, one compact publication, one reconciliation job, one immutable receipt, no event/correction/review rows, and no transient semantic rows.

Evidence is in [the retained measurement directory](../tmp/native-retained-measurement-20260917/README.md). The three SQLite evidence databases remain in the isolated candidate review directory and are hashed by its artifact manifest.

## Limits and next work

This is local native D1 behavior plus a compacted SQLite physical layout. It is not remote D1 allocation, Worker CPU, replication, WAL, or network evidence. One successful month does not measure multiple months, superseded publications, addenda, or holds.

Source eviction remains disabled. Complete historical date/student range reads, reports, current-visit authority across archive boundaries, corrections, addenda, and holds before enabling it. Deployed capacity, live R2 backup delivery, a populated independent restore drill, Railway cutover and rollback, physical iPad/outage/staff acceptance, and Kumon-owned handover also remain release gates.
