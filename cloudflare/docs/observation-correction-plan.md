# Correcting unmatched departure observation times

Status: proposed integration work. No observation-correction feature, migration,
or archive authority change is implemented by this document.

## Current gap

An exceptional departure can correctly be recorded without an arrival. Such an
event has `visit_id=NULL`, and its accepted receipt contains a sealed JSON
`null` visit. The existing correction API operates on a visit ID, and the
`VisitCorrections` interface requires a visit. `ReviewPanel` can record a review
resolution, but its narrative does not correct the effective departure time.

Editing `attendance_events.observed_at` would change the original observation
and invalidate its fingerprint and receipt. Creating a visit solely to enable
the existing correction form would fabricate an arrival. Neither is acceptable.

## Proposed operation and invariants

Add a separate immutable observation-correction operation, initially restricted
to `action='exceptional_departure'` with `visit_id IS NULL`. Retain:

- Correction ID, original event ID, center, and expected projection version.
- Previous effective observation time and the manager's corrected time.
- Manager identity, recorded time, factual reason, and canonical payload hash.
- A separate effective-time projection and version for the unmatched event.

The original event, original observation time, payload hash, and accepted
JSON-null receipt must remain byte-for-byte unchanged. Correcting the time does
not create an arrival, alter current presence, grant pickup authority, or
silently change the review's status. A resolved review remains an independent
record of what the manager previously verified.

Use a manager-only endpoint such as
`POST /attendance/events/:id/corrections`. Resolve an existing correction ID
before checking the current event state or expected version. Exact retries
return the same immutable correction. A changed payload, center, or operation
type returns 409. A known request whose evidence is unavailable returns 503.
Concurrent identical submissions produce one 201 and one replay 200, with one
version advance. Different corrections against the same version conflict.

The permanent request registry needs an explicit observation-correction kind
or an equally explicit target discriminator with complete ownership checks.
Do not disguise these requests as generic audits. A registry entry that keeps
no correction fingerprint cannot reject changed retries when the original
evidence is temporarily unavailable.

## Interface and read semantics

Expose the correction action on unmatched departures in the review and
observation interface. Display the original time, current effective time,
version, and correction history. Retain an in-flight request ID and payload
through uncertain responses and reauthentication. Prevent navigation or actor
changes from discarding an unresolved correction. Require the same manager to
resume the retained draft.

Original-observation views can continue filtering by the original date if they
label that choice and show the effective time separately. Operational departure
lists and counts must use the effective time. Attendance exports must contain
both the original evidence and its complete correction chain, including when a
correction moves the effective departure into a different reporting period.

Use indexed effective-time queries and bounded pages. A correction must
invalidate both the old and new report date buckets. Preserve the report
generation checks so a concurrent correction cannot produce a mixed export.
Test center time zones, midnight boundaries, month changes, and daylight-saving
transitions explicitly.

## Archive and recovery constraints

The current archive semantic profile understands visit corrections only. A
successful copy of an original unmatched event is not proof that its subsequent
observation corrections have been retained or verified.

Include the new immutable operations and effective projection in backup
counts, write barriers, and recovery validation. Preserve permanent request
ownership across recovery. Source capture must fence new corrections to an
event while that event is being captured or verified.

Extend archive membership, format validation, and semantic reconstruction as
an intentional versioned change. An authoritative graph must prove the entire
observation-correction chain and its final projection. Existing archives and
accepted receipts must never be rewritten to incorporate a later correction;
later evidence belongs in a verified addendum.

Keep affected observations live and ineligible for authoritative publication or
eviction until that semantic profile and addendum support exist. Anchor archive
membership to the original observation month. A corrected recent effective
time must prevent removal under an older archive scope. Existing v1/v2 readers
must remain compatible with evidence they already understand.

## Expected implementation files

Treat this as a separate integration unit after the current archive checkpoint.
The exact next migration number depends on that checkpoint.

- New migration for immutable observation corrections, effective projection,
  permanent request ownership, source guards, and report invalidation.
- New `worker/observation-corrections.ts` and `client/ObservationCorrections.tsx`.
- `shared/types.ts`, `worker/index.ts`, and `worker/history-request.ts` for
  request types, routing, ownership, and permanent retry behavior.
- `client/ReviewPanel.tsx`, `client/App.tsx`, and management-state helpers for
  correction entry, retained drafts, reauthentication, and navigation.
- `worker/records.ts` for event detail and correction history.
- `worker/frontdesk.ts`, `worker/attendance-report.ts`,
  `shared/attendance-report.ts`, and affected report-summary consumers for
  effective departure membership and complete evidence exports.
- Archive source selection, format definitions, semantic validation, staging
  schema, and archive-aware readers where the new evidence becomes supported.
- Backup table lists, recovery/reset procedures, and installation fingerprints.
- Focused API, migration, report, archive-fence, recovery, and browser tests.

## Acceptance evidence

Prove that a correction never invents a visit and never changes the old
accepted receipt. Cover manager permissions, expected-version conflicts,
identical and changed retries, missing evidence, cross-center/type collisions,
and lost responses followed by reauthentication.

Verify operational counts and exports after corrections cross dates, months,
and time zones. Preserve original evidence and every correction through backup
and restoration. Exercise active archive freezes and confirm that unsupported
observation-correction graphs cannot become authoritative or authorize source
deletion.
