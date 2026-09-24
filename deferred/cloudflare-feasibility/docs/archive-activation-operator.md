# Version 2 historical copy rehearsal

Use an isolated, owner-protected installation containing synthetic records. Keep the feasibility database empty, Railway available, `BACKUP_ENABLED=false`, and the D1 source eviction policy disabled. This rehearsal verifies a private R2 copy, semantic checks, publication, and a retention dry run. It does not authorize source deletion or production release.

Customer configuration defaults `ARCHIVE_ENABLED=false` and `ARCHIVE_V2_ENABLED=false`. Set both to `true` only in the isolated rehearsal configuration after binding private R2, supplying a separately held `BACKUP_KEY`, applying migrations, and confirming the owner-only Access policy. The installation loader rejects version 2 activation without R2 and the base archive flag.

Before starting, record the Worker version, database ID, bucket, schema version, source visit count, and remaining account-level D1 read/write headroom. Importing even a modest fixture can consume much of the D1 Free daily write allowance. Never rebind the feasibility Worker to the fixture database.

The owner can run the copy from **Center settings → Historical records**. Select the old month, wait for **Verified copy**, then choose **Verify history**. The control center stages encrypted parts, checks their meaning, and publishes lookup data through separate bounded Worker requests. It shows durable progress, can be stopped between requests, and resumes after a browser reload. Keep the tab open during a run. This is an operator-led rehearsal; a production rollout still needs an unattended scheduler with a measured daily D1 budget. The routes below describe the same operations for troubleshooting and evidence collection.

1. Advance `POST /api/admin/archives/semantic/maintenance/backfill/advance` until `state=ready`.
2. Start an eligible, complete month older than 90 days with `POST /api/admin/archives/start` and JSON `{ "month": "YYYY-MM" }`. Save `jobId`. Advance `POST /api/admin/archives/{jobId}/advance` in bounded calls until `status=complete`; stop on a terminal failure.
3. Call `POST /api/admin/archives/semantic/{jobId}/start`, then stage indexes zero through `parts-1` using `POST /api/admin/archives/semantic/{jobId}/parts/{index}`. Missing, oversized, or unauthenticated R2 objects are stop conditions.
4. Call `POST /api/admin/archives/semantic/{jobId}/freeze`. Advance `POST /api/admin/archives/semantic/{jobId}/verify/advance` until `status=complete`. Stop on a semantic failure.
5. Call `POST /api/admin/archives/semantic/{jobId}/publish/start`, then advance `POST /api/admin/archives/semantic/{jobId}/publish/advance` until `state=published`. Verify a historical lookup returns the expected visit, events, and corrections.
6. Start a bounded dry run with `POST /api/admin/archives/retention/start` and a small `limit`; advance `POST /api/admin/archives/retention/{retentionId}/advance` to completion. Compare candidate counts with source rows. Confirm `history_source_eviction_policies.enabled=0` and the source visit count is unchanged. Do not call the eviction route.

After an uncertain response, inspect `GET /api/admin/archives/semantic/{jobId}` before retrying. Record phase status, revisions, duration, D1 rows read/written, Worker CPU, R2 operations, publication state, candidate count, and unchanged source count. Retain failures for diagnosis; do not reset data to turn a failed rehearsal into a pass.

Production activation still requires bounded automatic orchestration, deployed capacity measurements, verified backup and Kumon-owned webhook alert delivery, independent restoration with a customer-held key, device and staff exercises, approved retention and recovery targets, and signed acceptance. Source eviction remains disabled until its separate proof and these gates pass.
