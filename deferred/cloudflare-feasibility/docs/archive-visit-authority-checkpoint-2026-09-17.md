# Archive visit authority checkpoint, 2026-09-17

Production release remains pending. This checkpoint completes the read-only historical visit path for compact schema 29 archives. It does not enable source eviction, historical mutation, scheduling, or deployment.

## Behavior

`GET /api/admin/history` now pages immutable `history_visit_heads` for the selected date range and optional student. It uses the live `visits` row when available. When the source row is absent, it authenticates the selected compact publication, encrypted manifest, and encrypted R2 parts before reconstructing visit detail.

The retained head remains authoritative for effective arrival and departure, originals, version, review status, student, and ordering. Archived detail supplies departure type and staff or guardian references. Current retained staff and guardian dimensions supply display names. A missing dimension fails closed instead of returning a partial record.

Attendance report visit pages use the same retained-head and authenticated-detail path. Initial report counts now come from retained heads. Later pages preserve the report cursor, generation, range, timezone, exporter, and archive-authority checks.

The implementation rejects missing objects, corrupt evidence, a retained-head mismatch, live-detail mismatch, duplicate archive authority, an authority change during R2 reads, and an authority change before the response completes. These failures return `HISTORY_EVIDENCE_UNAVAILABLE`. Read or record limits return the existing shorter-range response.

## Capacity evidence

The representative source-free month contains 14,295 archive records in 57 encrypted objects. Recovery reset, history backfill, fresh semantic verification, and compact reconciliation completed before measurement.

| Request | Authenticated records | R2 reads | Encrypted bytes |
| --- | ---: | ---: | ---: |
| Event history | 5,101 | 22 | 1,006,306 |
| Initial attendance report | 7,678 | 32 | 1,205,012 |
| Visit report page | 2,550 | 12 | 288,888 |
| Correction report page | 25 | 2 | 103,253 |
| Observation report page | 5,101 | 22 | 1,006,306 |
| Unmatched report page | 5,103 | 22 | 1,006,306 |

The largest measured request used 32 of the enforced 48-object limit. Each request read every object key once. Local elapsed time is diagnostic and does not measure deployed Worker CPU.

## Validation

The isolated candidate passed TypeScript checking, the production build, 37 focused tests across 6 suites, and the complete 787-test regression across 152 suites in 844.69 seconds. Wrangler 4.100.0 passed `deploy --dry-run`, packaging 60 static assets with a 415.72 KiB Worker upload and 98.50 KiB compressed size.

The release fingerprint remained `935d325ff352ac5296ed40783149144e4368da44d1efeb850e674979e71b0360` across 290 files before and after validation. Machine-readable evidence is in `.installation-work/visit-authority-candidate/review/`.

## Open gates

Student-detail correction history still depends on retained correction rows. Creating a correction against an archived visit requires authenticated addendum publication and reconciliation. Holds, expiry scheduling, safe source eviction, Worker-driven R2 backup delivery, independent populated restoration, deployed capacity, Railway cutover and rollback, physical iPad and staff acceptance, and Kumon-owned account handover remain open.

No live Cloudflare or Railway resource changed during this checkpoint. The live feasibility installation remains at the previously recorded empty schema 1 through 4 state, and Railway remains available.
