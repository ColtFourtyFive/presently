# Attendance storage compaction

Implemented locally in migration `0007_storage_compaction.sql`. This document describes product behavior, separate from the disposable sizing experiments in [storage and CPU audit](storage-and-cpu-audit.md). No remote migration or deployment was performed by this work.

## Accepted attendance receipts

New accepted visit receipts use the versioned tuple:

```text
[2, studentName, studentCode, activeAs0Or1, checkInAt,
 originalCheckInAt, checkInBy, checkOutBy, guardianName, visitVersion]
```

The reader reconstructs visit and student IDs from the immutable event. For an arrival, departure timestamps and type remain null and review status remains `none`. For a departure, both accepted departure timestamps equal the event's observed time; departure type is the event action and initial review status is `pending` only for exceptional departures. The tuple retains names and values that may subsequently change, including an effective arrival time corrected before departure, the original arrival time, student activation, and the accepted visit version.

Legacy JSON objects remain readable. The migration converts only 15-field objects with the expected primitive types and event-derived values. Nonmatching legacy objects remain intact. Unknown tuple versions or malformed receipts fail closed. Source observations, correction rows, payload hashes, and insertion nonces are not changed.

JSON text `null` remains the sealed receipt for an exceptional departure with no matching visit. SQL NULL remains an unsealed receipt and cannot be interpreted as a successful unmatched departure. The normal immutability trigger is restored after migration and now checks every immutable event column during the initial seal.

## Audit history

`audit_entries` remains the physical table for standalone administrative audits and preserved legacy exceptions. `attendance_audit_source` projects the exact audit fields from immutable observations and corrections. `audit_timeline` combines those projections with physical audit entries, using a physical entry when an existing ID has a divergent or custom value.

The migration checks that source counts and the complete logical audit ID count remain unchanged, aborting atomically on unexpected legacy gaps or collisions. It removes a physical generated copy only if **all** projected fields match: ID, center, actor ID and name, action, entity type and ID, detail string, and creation time. Detail JSON must match as text; equivalent JSON with different formatting is retained. Subsequent observations and corrections no longer create a second physical audit row. All logical audit IDs and field values remain available through `audit_timeline`.

Cross-source insertion guards preserve the ID uniqueness formerly enforced by the audit table's primary key. Duplicate attendance retries still resolve through their existing source record. Ordinary audit writes continue to target `audit_entries`; logical audit readers should target `audit_timeline` and use explicit ordering and pagination.

Backups and archives should store physical sources once: event rows, correction rows, physical audit rows, and schema definitions including both views and all guards. Native SQL restores recreate the logical history from those sources. A count of `audit_entries` alone now measures physical standalone/legacy rows, not the complete logical audit history.

## Open-visit index

`visits_center_open` now indexes `(center_id,check_in_at)` only where `check_out_at IS NULL`. The existing unique `one_open_visit` index is retained. Historical visit and observation indexes remain unchanged.

## Migration and rollback boundary

Apply the entire migration atomically while application writes remain stopped. The migration temporarily replaces the attendance-update and audit-delete guards needed for these exact transformations, then restores them. It never clears the installation's maintenance sentinel. Do not execute individual statements by hand.

The installation runner already submits all pending migrations and their ledger entries through one `wrangler d1 execute --remote --file` import. [Cloudflare's D1 getting-started documentation](https://developers.cloudflare.com/d1/get-started/) states that an incomplete execution returns the database to its original state. The pinned Wrangler 4.100.0 file path uploads through D1's import API, polls ingestion, and requires a completed result; it does not send these statements as separate query calls. The runner verifies both ledgers after completion and never automatically deploys, retries a failed import, or clears maintenance.

A lost CLI response may leave the operation's outcome uncertain. Inspect the provider operation and the migration/checksum ledgers before another attempt. Keep the verified backup and maintenance lock until the new Worker, schema, and recovery path have been checked. The rollback property is supported by Cloudflare's documented native-import behavior; the local regression test independently proves atomic rollback in actual workerd/D1 `batch()`. A remote failed-import rehearsal has not been performed for this release.

## Verification

Seven regression tests exercise compact and legacy receipts, retry after checkout/corrections/renames/deactivation, review resolution, unmatched departures, concurrent retries, source-ID collisions, and malformed/unknown receipt versions. A populated legacy migration compares every source column, correction row, decoded receipt, and logical audit field before and after, including divergent examples for each audit field. A late constraint failure rolls back receipt changes, physical deduplication, views, triggers, and indexes. A native-style SQL dump restores physical rows, views, guards, and original response receipts into another isolated D1 database.

These tests passed with the 12 existing attendance tests. TypeScript also passed. Actual deployed size, CPU, remote import failure recovery, and combined archive/backup restoration remain separate validation work.
