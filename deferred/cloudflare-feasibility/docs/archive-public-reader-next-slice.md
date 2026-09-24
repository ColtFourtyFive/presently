# Next slice: authenticated archived attendance receipts

Historical design proposal, September 16, 2026. The GET slice is now implemented and locally validated; see [the checkpoint](archive-public-reader-checkpoint-2026-09-16.md). The following text records the original proposal and later boundaries. No source, route, test, deployment, or eviction changes are included in this note. “Public” here means an existing authenticated application API, not anonymous access.

## Minimal useful change

Enable the existing `GET /attendance/events/:id` handler in [attendance.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/attendance.ts:45) to supply the optional archive-storage argument to `resolveHistoryRequest`. This is one point lookup by an accepted event ID. It returns the existing `AttendanceResult` with `replayed: true`, including the original sealed acceptance receipt rather than a reconstructed current visit.

The router is mounted at both `/api/admin` and `/api/kiosk` in [index.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/index.ts:28). Preserve that existing scope. The receipt-check action in [App.tsx](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/client/App.tsx:158) already uses the endpoint for both channels, so this slice needs no new browser page or search API.

Add a small server-side adapter using the existing `BACKUP_BUCKET` and string `BACKUP_KEY`, exposing only `{ bucket: { get }, masterKey }`. Pass it at this GET call site. Do not accept object keys, publication IDs, center IDs, or encryption material from the request. A missing binding/key must leave healthy live lookups working; it must produce the resolver's existing unavailable result only when archived evidence is actually required. Archive-read wiring must not turn on `ARCHIVE_ENABLED` scheduling or writes.

No schema migration is needed for this slice. Ready v2 publications, permanent request ownership, and current-generation availability already exist. No production source row should be removed to demonstrate the feature; use isolated restored fixtures with omitted live evidence.

## Current wiring and limits

| Application path | Implementation and present behavior |
| --- | --- |
| `/api/admin/attendance/events/:id`, `/api/kiosk/attendance/events/:id` | [attendance.ts:createAttendanceRouter](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/attendance.ts:45). Calls the resolver without archive storage today. Recommended first activation. |
| `POST /api/admin/attendance`, `POST /api/kiosk/attendance` | [attendance.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/attendance.ts:14). Initial retry lookup and post-error retry lookup are also storage-less. New acceptance remains a live SQL transaction. |
| `GET /api/admin/visits/:id`, `POST /api/admin/visits/:id/corrections` | [attendance.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/attendance.ts:51). Visit reads and new corrections require live `visits`; correction retry lookups have three storage-less call sites. Kiosk requests are explicitly refused. |
| `/api/admin/history`, `/api/admin/history/events` | [records.ts:createHistoryRouter](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/records.ts:116). Live SQL lists and counts, not a merge with publications. |
| `/api/admin/reports/attendance/pages`, `/api/admin/reports/attendance.csv`, `/api/admin/reports/attendance/summary` | [attendance-report.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/attendance-report.ts:55), [report-summary.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/report-summary.ts:22). Bounded live evidence pages and SQL aggregation; the archive is not included. |
| `/api/admin/archive-history`, `POST /api/admin/archive-history/:id/records/query` | [archive-reader.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/archive-reader.ts:97). Existing manager/owner verified-copy browser reads legacy v1 `archive_jobs`/`archive_parts`, not the new v2 publication catalog. Keep these authorities separate. |
| `/api/admin/audit/query` | [audit-reader.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/audit-reader.ts). Audit browsing also remains live SQL; an event receipt reader is not an archived audit browser. |

The storage seam is [history-request.ts:resolveHistoryRequest](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/history-request.ts:65). It prefers consistent live evidence. Only a known permanent owner with absent live detail can reach [archive-publication-reader.ts:loadPublishedRequestEvidence](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/archive-publication-reader.ts:37). That reader requires a committed supported v2 descriptor, exact request/record locators, and ready availability in the current history generation. [archive-record-evidence.ts:loadArchiveRecordEvidence](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/archive-record-evidence.ts:88) authenticates one manifest and the selected part, then checks record identity, byte count, hash, and shape. It does no R2 listing or month scan.

The resolver repeats its SQL authority snapshot after R2 awaits. Preserve that check, its live-evidence consistency checks, the original sealed receipt, and its existing error distinction: an unknown or undisclosed foreign ID returns 404 through this GET; a known request whose evidence cannot be verified returns `503 HISTORY_EVIDENCE_UNAVAILABLE`. Never convert damaged/unavailable history into an unused ID or an empty success.

## Authorization and data scope

Run the existing middleware and role check before storage work. [auth.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/worker/auth.ts) requires a verified Cloudflare Access identity plus active center staff for admin routes; kiosk access requires an enrolled device and a live, version-matched operator session. `attendanceRoles` permits owner, manager, and front desk. The configured `centerId(c)` is authoritative, not a URL/body field. Foreign-center and wrong-kind IDs must remain undisclosed with zero object reads.

Return only the existing event/receipt DTO, not raw archive records, hashes, root references, or storage paths. Keep the global `Cache-Control: no-store` behavior. Missing keys, unavailable R2, invalid ciphertext, old availability, and a restore during the read must not cause an API mutation or reveal encryption details.

## Tests needed for this slice

1. Exercise the real authenticated HTTP routes, not only the internal resolver tests in [archive-publication-resolution.test.ts](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/tests/archive-publication-resolution.test.ts). Cover allowed admin/front-desk and enrolled kiosk actors; missing, disabled, expired, revoked, and disallowed identities; foreign-center and wrong-kind event IDs.
2. Compare live and archive-only fixture responses byte-for-byte at the DTO level, including unmatched departure `visit: null`, corrected visits whose original receipt must remain unchanged, and `replayed: true`. Assert no changes to operational rows, permanent ownership, publication catalogs, availability, or receipts.
3. Confirm healthy live reads make zero R2 calls even if archive storage is absent/broken. Confirm truly unknown/foreign IDs also make zero object reads. An archived point read should fetch only its manifest and selected part within existing byte/stream bounds.
4. Verify missing/corrupt objects, wrong encryption key, stale generation, unpublished/invalid candidates, missing current availability, and a generation or authority change during object I/O produce the existing 503 response. A restored publication becomes readable only after genuine current-generation reconciliation.
5. Confirm the route returns no-store headers and only the existing response shape. Record native SQL/row-read and object-byte evidence; measure actual Worker CPU before production activation. A two-object bound alone does not prove compliance with a 10 ms CPU allowance.
6. Run the existing attendance, authentication, offline receipt recovery, history-request, and publication-resolution regressions. Keep production source retention and scheduling unchanged.

## Following work and the eviction boundary

After the GET is validated, the next small step is to give the same adapter to the five existing event/correction POST replay lookup calls. That enables retrieval of an already accepted result only. Test same-payload replay, changed-payload 409 conflicts even during storage outages, unknown-ID acceptance, and the post-insert-race lookup. New writes must continue through existing SQL guards; never recreate a missing archived event or correction to satisfy a retry.

General history and visit detail need a bounded, duplicate-free merge with explicit coverage and current-generation cursors. Snapshot visit/profile rows cannot automatically stand in for today's effective visit, review status, or identity details. `history_visit_heads` is currently a shadow projection and `history_record_locations` is disabled, as documented in [0017_history_lookup.sql](/Users/ocheng/Documents/ChatGPT/Safu/cloudflare/migrations/0017_history_lookup.sql).

Reports need exact live-plus-archive counts, evidence ordering, snapshot/epoch guarantees, stable pagination, and complete failure reporting when a required month is unavailable. Current effective check-in filters can cross the original monthly archive boundary after a correction. Fetching one receipt does not establish range completeness or correct totals.

Accepting a new correction to an archived visit needs authoritative current version/interval/review state, overlap validation against retained history, durable append-only correction/addendum evidence, and report invalidation. Current correction SQL selects and validates the live `visits` row; existing overlap guards query live intervals. Reading an old correction receipt establishes none of that mutation authority.

Source eviction must therefore remain disabled after this reader slice. It requires those interval/report/correction contracts, complete coverage and retention/hold checks, verified backup/recovery, and a separately fenced deletion protocol. The new abandonment cleanup deletes only never-published candidate metadata and does not change that boundary.
