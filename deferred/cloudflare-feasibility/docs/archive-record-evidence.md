# Internal exact archived-record evidence loader

`loadArchiveRecordEvidence(storage, locator)` in `worker/archive-record-evidence.ts` loads one authenticated record from a private R2 bucket. It is an internal primitive: no route, publication, historical resolver, source deletion, or authority transition is enabled.

The caller supplies a trusted published locator and storage `{bucket, masterKey}`. The locator binds an exact archive reference, center/month/timezone, compact-header hash, part index/descriptor hash, table/key, and record hash/byte count. The loader copies the locator and its nested reference before any asynchronous work so later caller mutations cannot change the expected evidence.

It performs at most two R2 `get` calls: the pinned manifest and its indexed part. It never lists objects, searches months, consults D1, or reconstructs a receipt from current profiles. Manifest format must be v2, kind must be monthly, and references must be empty. Root object paths are checked before fetching and again against the authenticated manifest. Header/scope/descriptor mismatches stop before fetching the part. The selected record must match exactly one table/key and pass semantic shape, byte-count and checksum checks.

All locator hashes are lowercase hexadecimal SHA-256. Hash inputs are UTF-8 `JSON.stringify` output with existing property order:

- Header: the authenticated manifest with only `parts` omitted, matching the frozen-snapshot header convention. Do not independently sort properties.
- Descriptor: the exact authenticated part descriptor.
- Record: the full `{table,key,row}` record, excluding the JSONL newline. `recordBytes` measures those same UTF-8 bytes, matching the archive membership hash convention.

Envelope, compressed-part and JSONL checks reuse the existing archive codec. Body reads enforce both the declared R2 size and actual received bytes, with fixed format limits and exact expected part size. Missing, corrupt, mismatched, oversized or failed reads return the same bounded `ARCHIVE_RECORD_EVIDENCE_UNAVAILABLE` error without exposing storage keys or encryption material.

A returned record is evidence, not publication authority. The loader does not prove that a schema19 run completed, that the complete archive remains recoverable, or that a request registry authorizes the caller. It preserves receipt text and request fingerprints, including standard base64 and the explicitly declared lowercase-hex variant, without rewriting or reinterpreting them. It does not run whole-graph semantic verification.

Before calling, future publication/resolver code must authorize an immutable committed locator and its owner. After awaiting the loader, that caller must recheck the runtime generation, publication availability, permanent request ownership and selected locator identity before returning data. Until those integrations and independent recovery are complete, the operational resolver continues to use live source evidence and source deletion remains disabled.

Focused tests use native application-generated evidence and real local Miniflare R2. They cover exact calls across multiple parts, original event/correction/sealed-null evidence, locator mutation during a fetch, malformed/cross-scope/profile/header/descriptor locators, missing/corrupt objects, wrong keys, absent targets, checksum conventions, both supported fingerprint representations, stream-size/overflow defenses and sanitized failures. Malformed-stream cases wrap actual local R2 bodies at the transport boundary; no remote bucket is contacted.
