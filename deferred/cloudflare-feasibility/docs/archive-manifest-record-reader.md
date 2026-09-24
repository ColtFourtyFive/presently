# Manifest-selected archive record reader

`loadManifestRecordEvidence` loads one exact record using a trusted publication reference and record identity. It is an internal building block for the compact archive catalog. The current public receipt routes still use their existing v1 catalog and locator reader; this addition changes no schema, route, archive authority or deletion behavior.

The caller supplies the archive reference, center, month, timezone, authenticated header hash, table and record key. The function snapshots that selection before any object fetch, rejects malformed values and out-of-scope paths, then authenticates the bounded v2 monthly manifest. It requires the expected scope and header and rejects addenda and monthly references.

The manifest commits to strictly ordered, non-overlapping record-key ranges. The reader finds exactly one candidate descriptor, fetches and verifies the complete part, requires exactly one matching record and validates its semantic row shape. It needs no separate part offset, record hash or record length stored in D1. Existing object hashes, encryption authentication, byte limits and full-part verification still apply.

Successful reads fetch exactly the manifest and selected part. A key outside all authenticated ranges fetches only the manifest before returning unavailable. A missing key inside a part's range fetches that part and then returns unavailable. The reader does not list objects or scan months. These are object-count bounds; they are not deployed CPU or latency measurements.

## Authority remains with the caller

The function verifies evidence. It does not establish that a publication is committed, selected, currently available or semantically verified as a complete graph. Before invoking it, the caller must authorize the center and request owner and pin the exact committed representation and proof.

After loading an event or correction, the caller must compare its identity, center, kind and payload hash with permanent ownership. Event receipts still require sealed-response validation. Before returning, re-read and compare the selected map/catalog version, descriptor, availability/reconciliation identity, runtime generation, permanent owner and any retained live authority. Changed authority or missing evidence remains unavailable and cannot permit a new acceptance.

The existing `loadArchiveRecordEvidence` API remains unchanged. It continues to verify its full pinned locator, including the descriptor hash, record hash and byte length.

## Validation scope

The focused tests use real local R2 with native fixture records and authenticated archives. They cover exact event and correction evidence, literal-null receipts, both ends of every part, input mutation during a fetch, missing keys inside and outside ranges, malformed selections, wrong scope/header, v1/addendum rejection, authenticated malformed directories, unsupported row shapes, missing/corrupted/truncated ciphertext and bounded streams. The existing locator-reader tests remain in the regression run.

These checks do not implement a compact catalog, its native publication/conversion protocol, restore reconciliation, date/student search, current visit authority or safe source eviction. Those steps remain in the [compaction plan](archive-catalog-compaction-plan.md).
