# Permanent request resolution

Attendance writes, attendance-result lookups and correction retries now consult the durable request registry and live source ownership in one D1 snapshot. This replaces the old assumption that a missing source row means an unused request ID.

| Evidence | Response |
| --- | --- |
| Matching accepted event or correction with valid live evidence | Return the stored accepted result, before observation-age or current-visit checks. |
| The same POST ID belongs to another center, source type or payload | Reject with `EVENT_ID_REUSED` or `CORRECTION_ID_REUSED`, HTTP 409. |
| A status lookup asks for another center or source type | HTTP 404 without revealing the other record. |
| A matching accepted key has missing, inconsistent or unsealed evidence | HTTP 503 `HISTORY_EVIDENCE_UNAVAILABLE`; keep the request ID and retry/check later. |
| A genuinely unused POST ID | Continue normal validation and insertion. |

The source event or correction owns its ID even when an older physical audit alias uses the same ID with divergent fields. A legacy source without a key remains readable while backfill is incomplete. After the registry is marked ready, a missing key for an existing source fails closed.

Stored hashes are not rewritten. Canonical standard-base64, URL-safe-base64 and hexadecimal SHA-256 representations compare by their 32-byte digest. Opaque legacy fingerprints compare as exact strings only. Registry/source disagreement and malformed declared encodings are evidence failures, rather than permission to insert again.

Receipt decoding preserves the original accepted snapshot. It never substitutes current student names, visit state or review status. SQL NULL is unsealed; JSON `null` is valid only for an unmatched exceptional departure. Malformed receipts and mismatched student/visit references return an unavailable response.

When insertion loses a race, the API resolves the same request ID once and returns its accepted result, conflict or unavailable state. It does not retry the mutation. Correction insertion uses `RETURNING id` to distinguish a new correction from an ignored duplicate; D1 trigger work can increment `meta.changes` even when no correction was inserted. Concurrent identical corrections now yield one 201 acceptance and one 200 replay, with one version increment.

## Validation and remaining archive work

Fourteen native API regressions cover historical retries, unavailable evidence, identity conflicts, malformed receipts, concurrent writes and hash compatibility. Two additional migration tests cover partially backfilled sources and missing keys after readiness. A native query-metrics test adds 5,000 unrelated permanent IDs and confirms status/retry query counts and row reads remain bounded. Existing attendance and kiosk regressions pass.

The latest Worker requires the current migration schema. Legacy migration fixtures seed records directly through the old native D1 triggers before applying migration 0017; the application does not silently operate against an incomplete schema.

This resolver currently returns live source evidence. It deliberately returns unavailable when a durable key has no source. Actual R2 replay still needs activated immutable publication locators, semantic verification, bounded authenticated reads and restoration coverage. Source deletion and archive-location activation remain disabled. The existing clients retain pending request IDs on 503 responses.
