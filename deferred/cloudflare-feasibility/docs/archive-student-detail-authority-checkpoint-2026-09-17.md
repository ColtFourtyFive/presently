# Archived student-detail authority checkpoint

Updated September 17, 2026. This checkpoint is local and has not been deployed.

Schema 30 adds `history_correction_heads`, a compact immutable D1 index that identifies each attendance correction, its student and visit, and its recorded time. The migration atomically backfills every retained correction, captures future corrections through a trigger, blocks mutation, participates in backup maintenance guards, and is included in the 60-table backup inventory. Direct migration backfill is valid because source eviction has never been enabled on an installation.

The normal student-detail endpoint now selects the latest 20 visit heads and the latest 100 correction heads independently. A recent correction remains visible even when its visit is older than the 20 visits displayed on the profile. Live D1 detail has priority. If selected detail is absent from D1, the endpoint reads encrypted R2 records through the authenticated archive range reader, verifies every row against its retained head, rechecks D1 and archive authority after object reads, and fails closed if evidence is missing or changes.

Complete live D1 evidence produces zero R2 reads. The source-free representative profile read returned one visit and one correction with two unique R2 reads, 5,454 encrypted bytes, against the 48-object request ceiling. The evidence is in `review/student-detail-r2-measurement.json`. This is a local workerd measurement and is not deployed Worker CPU evidence.

The endpoint returns `HISTORY_RANGE_TOO_LARGE` when required archived evidence exceeds the bounded publication, object, or record limits. It returns `HISTORY_EVIDENCE_UNAVAILABLE` for a missing object, missing or partial retained-head index, head/detail mismatch, changed authority, or missing current staff/guardian dimension. Supported application flows retain staff and guardian rows; manual dimension loss therefore fails closed instead of inventing a historical name.

Validation completed:

- TypeScript and the production build passed.
- The archive-range suite passed 22/22 tests, including source-free student visits and corrections, recent corrections on older visits, zero-R2 live reads, partial-head detection, missing objects, head mismatch, and authority changes.
- The focused schema-30 regression passed 129/129 tests across 22 suites.
- The prior schema-inventory failures were updated to the 60-table schema-30 backup contract; their regression passed 98/98 tests across 22 suites.
- The complete candidate regression passed 795/795 tests across 154 suites.
- Wrangler 4.100.0 completed a production dry run with the expected D1, R2, Queue, Assets and Access bindings.
- The promoted root matches the 293-file candidate fingerprint `c8dc75b4a8bd973fbe7269e4916b59bb8e5e7bf53c88d4e232a2064eface77a4` exactly. Root TypeScript and production build passed, and the root archive/history/recovery verification passed 49/49 tests across 7 suites.

This checkpoint does not authorize source eviction. Historical correction mutation, authenticated addendum publication, holds, expiry scheduling, eviction, live Worker backup delivery, populated cloud restoration, deployed capacity tests, device/staff acceptance, cutover, and customer handover remain release work.
