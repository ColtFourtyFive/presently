# Read-only historical-copy review

Implemented locally September 15, 2026. No deployment or historical eviction is included.

Owners and managers can open **Settings → Historical records → Review historical copies**. Choose a completed monthly copy, browse its captured students, and select **Review attendance** or another evidence group. Original/effective times, observations, corrections, reviews, audits, and captured identity/relationship context are read-only. The interface shows the capture and original verification timestamps, uses the archive's center timezone, and explains that later live corrections and current pickup authority may differ.

## API contract

All routes are behind the existing administrator authentication middleware and independently require owner or manager role. Front-desk/instructor roles and kiosk credentials do not grant archive access. Responses are private and `no-store`; the reader adds no database mutations, logs, exports, browser persistence, or offline cache.

- `GET /api/admin/archive-history?month=YYYY-MM&limit=10&cursor=...` lists only completed jobs belonging to the installation's center. The month is optional. Catalog pages have at most 25 entries and use a month-bound keyset cursor.
- `POST /api/admin/archive-history/:id/records/query` with a JSON body such as `{"table":"students","limit":25}` verifies and reads one bounded historical part. Filters are sent in a body of at most 4 KiB so names and student references do not enter request URLs or URL-based logs. This POST performs no database mutations and uses the existing origin checks. Optional `q` searches captured names, references, and notes within that page. `recordId` selects an exact record key. `studentId` is supported for students, visits, observations, reviews, and student/guardian relationships.

Record pages have at most 50 rows and 128 KiB of serialized JSON. Each request reads at most one encrypted manifest (512 KiB plus envelope overhead) and one part (codec limit approximately 1.07 MiB encrypted, 1 MiB decompressed, 256 records). Result records have a separate 96 KiB budget so metadata fits. Continuations pin the encrypted manifest SHA-256, filter set, part, and row offset; a changed manifest rejects the old cursor.

A filtered page can contain zero matches while later parts remain. The API supplies `nextCursor` and `searchComplete`, and the interface explicitly distinguishes an empty page from the end of review. Missing objects, damaged ciphertext, inconsistent catalog entries, unsupported/mismatched schema metadata, or invalid references return an unavailable error with no record payload. They never become a successful empty-history result.

## Verification and isolation

Before returning records, the reader verifies:

1. Completed job ownership, pinned manifest object/hash, authenticated envelope, monthly format, capture time, timezone, period, application version, schema ledger, and part counts.
2. The selected stored descriptor and its prior verification marker, ciphertext/compression/plaintext hashes, bounded decompression, ordering, record shape, and complete selected-part membership hashes.
3. Every structured source reference against the same center and the archive membership set. Student/guardian links receive the same checks even though they have no `center_id` column. Kiosk-device references are checked against the center's device records. Accepted attendance receipts must identify their own event's student and visit.
4. Captured identity columns contain only the approved archive context fields. Unexpected credential/contact fields are rejected rather than exposed.

Each requested page is freshly verified. The catalog's completion timestamp records the original copy verification; opening one page does not recheck every other R2 object. The interface states this limit.

The reference checks intentionally use retained D1 source rows. This reader is for the current **verified-copy** stage and is not sufficient to enable eviction. A future operational archive tier still needs permanent historical indexes, cross-month effective-interval handling, correction addenda, immutable retry handling, unified live/history lookup, and recovery after actual deletion from D1. Archive creation can remain disabled while already completed copies are reviewed, provided storage and the recovery key are configured.

## Local verification

`tests/archive-reader.test.ts` passed 15 tests in actual local workerd/D1/R2: authorization, incomplete/foreign-center exclusion, frozen identities after later edits, pagination/filter binding, missing and corrupt objects/catalog/schema, authenticated cross-center relationships and substituted receipt references, rejection of unexpected credential fields, manifest-change cursors, and response-byte bounds with large evidence records.

`node scripts/archive-reader-browser-smoke.mjs` uses a temporary local Vite page and explicit synthetic API responses. It checks catalog navigation, capture/copy caveats, forward/back paging, student-to-attendance lookup, original/effective evidence, unavailable errors/retry, empty-page continuation, tablet-width layout, no browser storage, and private filters kept out of request URLs. Its scope is interface behavior; the real storage/authentication evidence comes from the API tests. Browser artifacts are written under `tmp/archive-reader-browser/`.

TypeScript and the production build are checked separately. These local results do not establish deployed CPU/quota usage, live R2 behavior, physical-iPad acceptance, or approval for center operations.
