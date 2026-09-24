# Archive metadata storage audit

Measured September 17, 2026. These are isolated local SQLite measurements. No deployed data, account settings or paid plan changed.

## Current database after history backfill

The current schema 27 database occupies **175,538,176 bytes** after the production backfill function and local `VACUUM`. The source fixture has one center, 340 students, 60,000 visits and 120,000 attendance observations. The result is 72,630,272 bytes smaller than the original 248,168,448-byte fixture, a 29.27% reduction. Older measurements of roughly 114 MB or 134 MB did not include all current permanent history metadata.

| Stage | Bytes | What it establishes |
| --- | ---: | --- |
| Original fixture | 248,168,448 | Original storage problem, including repeated receipt and audit data |
| Schema 27 before history backfill | 134,238,208 | Current migrated operational tables, with history metadata still empty |
| Schema 27 after history backfill | 175,538,176 | Current populated operational database with permanent request ownership and visit heads |

The backfill ran 365 bounded calls, each processing at most 500 records. It first verified that maintenance pauses work, then ran on the isolated copy. Every original event, correction, audit and visit value retained its pre-backfill digest. Integrity and foreign-key checks passed. The result contains 120,940 permanent request keys and 60,000 visit heads, with no legacy archive record locations. This exercises the current backfill function through a local SQLite adapter; it does not measure Worker CPU or remote D1 behavior.

Evidence: [current-schema backfill result](../tmp/history-metadata-audit-20260917/history-lookup-27-result.json), [run log](../tmp/history-metadata-audit-20260917/history-lookup-27-run.log), and [measurement script](../.installation-work/measure-history-lookup-27-20260917.ts). An initial launch used the repository root instead of the Cloudflare directory and produced no result artifact. The recorded successful launch used the required working directory.

## Existing permanent metadata

The following allocated sizes come from the backfilled schema 24 fixture. The audit compared each table and index definition with schema 27 and verified that all four definitions are byte-identical. The new schema 27 backfill independently confirms the same total backfill increase of 41,299,968 bytes. The sum below includes the previously allocated empty pages, so it differs from that increase.

| Table or index | Allocated bytes |
| --- | ---: |
| Permanent request ownership | 15,024,128 |
| Visit heads | 12,947,456 |
| Visit head center/interval index | 5,132,288 |
| Visit head student/interval index | 8,212,480 |
| Total | **41,316,352** |

The fixture therefore retains about 689 bytes per visit in these four objects before adding a publication catalog. This ratio describes this fixture, not a universal cost per visit. Identifier length, record mix and page packing affect it.

## Cost of adding a D1 event range index

A separate physical-layout experiment copied the exact current ownership and visit-head tables and indexes into a fresh SQLite database. It then added event student and observed-time fields to the ownership table, populated them from all 120,000 real fixture events, and added two partial event indexes for center/time and center/student/time ordering.

| Hypothetical addition | Extra allocated bytes |
| --- | ---: |
| Two fields on the existing ownership table | 7,475,200 |
| Center/time event index | 9,469,952 |
| Center/student/time event index | 14,065,664 |
| Total | **31,010,816** |

This experiment establishes physical cost only. It deliberately omits triggers and disables foreign-key enforcement in the fresh diagnostic database. It is not a migration, an accepted publication, a complete range-read contract or an eviction test. All source fixtures were opened read-only and immutable; their hashes were unchanged afterward.

Do not add this projection before comparing it with authenticated R2 search pages. The existing archive manifest can locate a record by table and key, but it cannot answer a student/date range or prove that every matching event was returned. Date routing must use actual observation timestamps. Archive months follow a visit's original arrival, and a later departure can fall in another month.

Evidence: [physical-layout measurement](../tmp/history-metadata-audit-20260917/measurement.json) and [audit script](../.installation-work/history-metadata-audit-20260917.py). `dbstat` cell counts are B-tree cells; the evidence separately records actual logical row counts.

## Current publication catalog cost

The representative captured month contains 2,550 visits, 5,101 events, 25 corrections and their review, audit and context records. Its 14,295 records fit in 56 parts under the current codec. The codec round trip preserved all records.

An isolated physical model used the exact schema 27 table and index layouts and populated the catalog with the current codec's actual descriptors, record hashes, offsets and request identities. After `VACUUM`, publication catalog tables and indexes occupied **7,421,952 bytes**, or 7,319,552 bytes more than their empty allocation.

| Catalog objects | Allocated bytes |
| --- | ---: |
| Record locators and their unique index | 4,898,816 |
| Request claims and their indexes | 2,174,976 |
| Part catalog | 262,144 |
| Other publication and empty lifecycle objects | 86,016 |
| Total | **7,421,952** |

This is large enough to change the implementation order. Adding a permanent locator for every archived record can consume much of the space that removing operational detail would save. This measurement does not establish the net size after archiving the full two-year fixture. No multi-month eviction has run.

The manifest already authenticates a sorted, non-overlapping directory of record-key ranges. An exact receipt reader can select one part from that manifest, verify the whole part and select the unique record. The existing permanent ownership key still decides identity and payload conflicts before object reads. A trusted publication selection and a generation/availability recheck remain necessary.

A separate two-column physical model of `request_id → publication_id` occupied **409,600 bytes** for the same 5,126 event/correction requests. That is a promising replacement for repeated request metadata, not the size of a complete replacement catalog. It excludes publication descriptors and lifecycle state, existing permanent ownership and visit heads, current visit/review selectors, range-search metadata and migration overhead. It has no production authority or recovery behavior.

Both catalog experiments bypassed native admission triggers and foreign-key enforcement only in fresh diagnostic databases. They measure physical layout. They do not prove publication acceptance, safe deletion, deployed D1 reclamation, CPU or quota compliance.

Evidence: [catalog measurement](../tmp/publication-storage-audit-20260917/storage-results.json), [minimal-map measurement](../tmp/publication-storage-audit-20260917/minimal-map-results.json), [independent verification](../tmp/publication-storage-audit-20260917/independent-verification.json), and [frozen method and artifact inventory](../.installation-work/publication-storage-audit-20260917/README.md). The independent verifier checked every record hash and byte length, all part boundaries, and every unique request mapping against the original captured input.

## Release implications

Permanent ownership, visit heads and publication metadata continue to grow with retained history. A 90–120 day operational window alone does not establish that D1 stays permanently small. No source eviction is enabled. Reduce catalog duplication before introducing another per-event D1 index, then measure the complete retained database after an actual archive lifecycle.

The next design must preserve original accepted receipts, global request ownership, current visit and review state, complete history ranges, report counts, holds and recovery. An unavailable archive must remain unavailable; it must never turn an old request into a new accepted write or produce a falsely complete report.

The [catalog compaction plan](archive-catalog-compaction-plan.md) sets the implementation order and compatibility checks. Its first step validates manifest-selected exact evidence without changing production routes or deleting catalog records.

Current visit authority also needs an independent mutation revision. Resolving a review changes visit review status without incrementing visit version. Publication selection cannot rely on visit version alone. See the [visit authority review](../.installation-work/historical-visit-authority-design.md) and [historical read contracts](../.installation-work/historical-read-contracts.md).
