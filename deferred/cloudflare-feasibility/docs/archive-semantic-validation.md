# Versioned historical evidence validation

Implemented locally as the first unit of [the eviction plan](archive-eviction-plan.md). This is a validator foundation. It does not enable D1 removal, change the live archive producer, or establish that a captured subset contains every record eligible for archiving.

## Additive format contract

The existing `ArchiveMetadata` shape remains valid and produces `kumon-history-archive-v1`. Its record tables, count keys, encryption domain, callers and reader behavior remain unchanged. V1 graph verification continues to check authenticated format, sizes, hashes, ordering and dependency scope; it does not claim the new semantic checks.

An explicit `semanticProof` field opts a producer into `kumon-history-archive-v2`:

```ts
semanticProof: {
  version: 1,
  payloadHashEncoding: 'base64', // or explicitly 'base64-or-hex'
  deviceContexts: [{ id: 'device-id', centerId: 'center-id' }],
}
```

The manifest authenticates this field and rejects unknown fields/versions. Device context contains only a device identifier and owning center. IDs must be unique, safe identifiers and belong to the manifest center. The list is limited to 256 devices; the whole proof is limited to 32 KiB and also counts toward the 512 KiB manifest limit. There are no device tokens, session records, PINs or contact fields in this proof. Kiosk observations require matching device ownership; administrator observations require no device reference.

V2 uses the existing history-only encryption domain, separate from SQL backup encryption. The authenticated manifest format selects semantic verification. It is not inferred from an object filename or the caller's query.

## Private staged-store contract

`verifyArchiveGraph` now requires `sink.semanticStore` for any v2 graph. Every dependency must be v2. The existing `stagePart` callback persists each authenticated part privately before resolving; `publish` is called only after cryptographic verification and `verifyArchiveSemantics` both succeed. Failures call `discard` and must remove private staging. A missing semantic store fails closed rather than silently downgrading verification.

The store supplies exact record lookup and keyset pages:

```ts
get(archiveId, table, key): Promise<ArchiveRecord | null>
page({ archiveId, table, after, limit, relation? }): Promise<readonly ArchiveRecord[]>
// relation, when present: an exact visit_id, event_id or entity_id filter
```

This adapter reads only the already authenticated private archive staging. It must not query live operational rows, use current profiles as missing context, return rows from another archive, or modify staged records between verification and publication. Pages must use strict record-key order and honor the requested bound. The verifier checks page order, row identity/shape/scope, manifest counts and relation filters. The adapter is trusted application code, not an untrusted plugin or remote database endpoint.

The verifier retains one page of at most 64 records plus at most one visit's operation chain. A visit is capped at 2,048 unique operations and 4 MiB of serialized operation evidence. Oversized closures fail explicitly. Graph metadata remains subject to the existing 32-archive/16-depth/512-MiB limits. Production adapters should use private indexed disk/database staging; the test-only in-memory adapter is not a production Worker storage recommendation. The original foundation did not include a recovery adapter. The offline CLI now uses a private Node SQLite semantic store; see [independent recovery](archive-independent-recovery.md). The operational producer and review reader remain v1-only.

Bounded memory is not a claim that whole-graph verification fits one Worker invocation or the Free plan's CPU, duration, D1-row or subrequest budgets. This foundation currently verifies the supplied graph before returning. A future operational publication/eviction runner must checkpoint bounded verification steps, or establish and enforce measured supported graph/workload limits, before enabling v2 production use. The current production-facing writer and reader remain v1. Explicit format guards hide a manually cataloged v2 copy from the v1 review catalog, reject v1 page/manifest display, and stop the v1 runner from marking it complete.

## What is verified

- Exact context and evidence columns, expected field types/enums, record keys, same-center ownership, capture-time bounds, and minimal identity context without credential fields.
- V2 standalone/custom audit IDs accept the existing audit grammar `[A-Za-z0-9_:-]{1,200}`, including generated colon suffixes. V2 event/correction IDs must match the UUID grammar already required by their APIs. Reference IDs and v1 archive key grammar are not widened. Audit targets still need captured evidence in the supported attendance graph; this does not add inquiry/interaction retention to the format.
- Student/guardian/staff/visit/review/audit relationships, including composite student/guardian keys and explicit kiosk-device ownership. Missing references never use live-row fallback.
- Actual SHA-256 fingerprints using the existing API's fixed JSON field order and canonical stored values. Base64 is the default. Legacy lowercase hex is accepted only when declared and only when it represents the recomputed digest. Stored hashes are preserved, never normalized or replaced.
- Sealed tuple-v2 and complete legacy-object attendance receipts, including the sealed text `"null"` for unmatched exceptional departure. Receipt IDs, student IDs, original/effective times, action and accepted version must match their operation. Unknown receipt fields are rejected.
- Each visit's complete operation chain: one accepted arrival at version 1, unique successive resulting versions, exact correction prior state, valid intervals and resulting visit projection. Correction reopening and later departure are represented without replacing earlier receipts. Original arrival determines the archive month.
- Exceptional-departure review relationships, pending/resolved field coherence and an actual matching initial resolution audit. Repeated resolution attempts are preserved because the current API records them even when the already-resolved review does not change.
- Generated attendance/correction audit entries, including actor, action, target, time and semantic detail equality; fabricated source audits and missing source audits are rejected. Standalone custom audits must reference captured evidence.
- Across a linear base/addendum graph, repeated immutable records must be identical. Context can change by captured snapshot; reviews may resolve once; corrections require their resulting visit snapshot. Mixed v1/v2 graphs, unresolved branches and conflicting immutable versions fail closed.

The first v2 semantic version deliberately rejects a divergent physical legacy audit that reuses an event/correction ID but differs from its canonical generated audit. V1 still preserves and reads it. Promoting that case requires a later explicit physical-audit provenance extension; this verifier does not treat an unexplained override as proven evidence.

## Limits of this unit

These checks establish internal consistency of authenticated supplied evidence. They cannot prove that a producer truthfully selected all source rows, that historical display names were accurate in reality, or that an omitted real-world event was ever recorded. A receipt's frozen names remain evidence; current identity snapshots are not used to rewrite or retroactively validate those names.

Operational publication heads, permanent request registries, cross-archive interval enforcement, infinite addendum rollover, source-content comparison under an eviction fence, authoritative holds, deletion permits, archive-aware reports, and post-eviction recovery remain separate units. Current v1 source copies and historical browsing retain their existing behavior. No deployment, source deletion or object expiry is part of this change.

## Local evidence

`tests/archive-semantics.test.ts` uses actual local D1 attendance/correction/review triggers and archive source selection, then closes D1 before encrypting and semantically verifying the resulting graph. Malformation cases are re-encrypted and checksum-valid, so relationship/receipt/version/audit failures occur after authentication. It also covers v1 compatibility, opt-in legacy hashes, proof bounds, missing/oversized staging, bounded continuation pages, a valid correction addendum, mixed formats and an oversized visit closure.

The pre-existing codec suite verifies unchanged v1 encoding/decoding, graph integrity and actual workerd execution. These local tests do not establish production staging, deployed CPU/memory cost, complete two-year capacity, or operational approval.

A small v2 graph is also authenticated and semantically verified inside actual local workerd using a test-only private adapter. The operational-reader suite checks that manually inserting a v2 manifest into the old catalog cannot bypass the explicit v1-only guard or remove source attendance.
