# Current audit activity

Owners and managers can review audit activity from Center settings. The reader is read-only and remains unavailable to front desk accounts, instructors, and kiosk sessions.

## Source and retention

The API reads `audit_timeline`, the existing logical audit view. It returns the actor name and ID recorded at the time, the exact action and affected record identifiers, the recorded timestamp, and recorded detail. It does not join current student or staff profiles to invent missing context.

Each entry identifies one actual source:

- A physical `audit_entries` row, including a retained legacy exception.
- The existing projection of an immutable attendance observation.
- The existing projection of an immutable attendance correction.

Physical audit rows retain precedence when the same ID also has a source projection. The original JSON detail string is preserved. A long detail is explicitly truncated to its first 4,000 Unicode characters for display.

This reader covers records retained in the current database. Attendance eviction is disabled, so retained attendance observations and corrections remain represented here. It does not read or merge historical R2 copies, reconstitute missing rows, or claim an archive-complete view. A future archive-aware audit resolver is required before eviction can be enabled. The historical-copy reader is a separate verification path.

## Private query contract

`POST /api/admin/audit/query` accepts a JSON body. GET and URL filter parameters are not supported. Responses use `Cache-Control: private, no-store` and `Pragma: no-cache`.

| Field | Behavior |
| --- | --- |
| `from`, `to` | Center-local calendar dates between 2000 and 2099, inclusive; at most 31 days. Defaults to the last 30 days. |
| `actor` | Literal case-insensitive substring of the recorded actor name; at most 100 characters. |
| `action`, `entityType` | Exact identifiers, up to 64 lowercase letters, digits, or underscores. |
| `entityId` | Exact affected record ID; at most 100 letters, digits, underscores, or hyphens. |
| `limit` | Integer from 1 to 50, default 25. |
| `cursor` | The previous page's returned cursor, or null for a new search. |

The cursor binds the authenticated reader, center, timezone, date range, all filters, and page size. It carries the last ordered timestamp/ID and the initial read cutoff. Changing filters or signing in as another reader requires a new search. It is an opaque pagination value, not an authorization credential or a durable snapshot.

Each query retrieves at most 201 logical rows and examines at most 200 for optional filters. An empty filtered page can still return `nextCursor`. The interface then says that more activity remains rather than reporting an empty history. `searchComplete` means the selected range is exhausted after this page; it does not mean all historical storage was searched.

The item payload is capped at 96 KiB, with a maximum of 50 entries. A page that reaches the byte limit stops before the next entry and returns a continuation. The API never computes an unbounded total, and reading activity does not create another audit row.

## Indexed access

Migration `0015_audit_indexes.sql` adds recording-time indexes for attendance observations and corrections and extends the physical audit index with an ID tie-breaker. Observed arrival time is not the audit ordering key.

The migration flattens the existing `audit_timeline` definition into three `UNION ALL` branches. TEXT casts align SQLite column affinities so the planner can merge the three ordered indexes. Projection fields, JSON key order, and physical-row precedence remain unchanged. `attendance_audit_source` remains available for existing callers. No record or source table is rewritten.

Cursor queries first seek IDs at the last timestamp, then continue through older timestamps. Each query supplies a single effective time bound. This avoids rescanning timestamp ties or rows newer than the cursor. The optional actor/action/entity filters run only over the bounded page, so sparse matches may require more pages.

## Verification

The native Worker/D1 suite checks source equality, byte-equivalent logical views, retained physical legacy precedence, daylight saving boundaries, stable timestamp ties, cursor binding, sparse filtering, response limits, center isolation, and role/channel/origin rules. The volume fixture contains 1,000 observations, 500 corrections, and 1,000 standalone audits. Query-plan assertions require all three indexes, `MERGE (UNION ALL)`, and no temporary sort. D1 metadata checks every page for zero writes and bounded row reads.

All 11 tests pass. The previous nested view read 5,434 D1 rows for the first 201-row query on this fixture. The indexed reader reduced that first read to 406 rows, including authentication and center reads. Paging through all 2,500 logical entries took 13 requests, with at most 408 D1 rows read per request and no writes. These measurements are local evidence, not a production latency or capacity guarantee.

Browser validation of this new audit interface remains pending because the configured browser connection was unavailable. No live deployment, migration, or customer data was used.
