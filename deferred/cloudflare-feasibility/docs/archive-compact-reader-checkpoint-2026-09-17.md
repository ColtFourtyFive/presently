# Compact archive receipt reader checkpoint — 2026-09-17

Status: integrated locally at schema 28; not deployed.

Release fingerprint: `0cfecf51ad56d634447daa7eccaf7e12ef615b74df42b0e43c8f734a7daa63a0` across 280 release files, application version `0.1.0`.

The shared attendance idempotency resolver can now read either the original publication catalog or a direct compact catalog. A retained valid source row remains authoritative. When source detail is absent, the resolver requires exactly one catalog claim, validates the permanent request owner and payload before R2, reads the encrypted manifest and selected part, and then repeats the complete D1 authority snapshot. Any ownership, generation, availability, map, descriptor, or runtime change fails closed.

The compact path validates the direct identity, committed descriptor, active proof generation, ready availability, catalog version 2, semantic validator version 1, header digest and counts, manifest, selected record identity, center, and payload hash. Event and correction replay use exactly two R2 reads. Hashless foreign and wrong-kind probes remain indistinguishable from absence; payload-bearing conflicts return the existing ID-reuse response without touching R2.

All six existing receipt call sites use this resolver: attendance POST initial lookup and race replay, event receipt GET, and correction POST initial lookup, race replay, and missing-result replay. Source eviction remains disabled.

Validation on the unchanged candidate and identical integrated fingerprint:

- 758 of 758 tests passed across 66 files and 144 suites.
- 94 of 94 focused receipt-path tests passed across 15 suites.
- TypeScript `tsc --noEmit` passed.
- The production Vite build passed.
- Compact source-free event and correction replay, exact `result_visit: "null"` preservation, two-object reads, corrupt or missing objects, pre-R2 conflicts, mid-read authority changes, primary-key query plans, and recovery-reset denial are covered.

Frozen evidence:

- `.installation-work/compact-reader-candidate/review/combined-validation-evidence.json`
- `.installation-work/compact-reader-candidate/review/integration.json`
- `.installation-work/compact-reader-candidate/review/compact-reader.patch`
- `.installation-work/compact-reader-candidate/review/full-regression.json`
- `.installation-work/compact-reader-candidate/review/receipt-path-regression.json`
- `.installation-work/compact-reader-candidate/review/release-fingerprint.json`
- `tmp/compact-reader-fingerprint-20260917.json`

The next release boundary is schema 29 compact reconciliation. Recovery correctly revokes compact availability today, so restored compact catalogs stay unreadable until schema 29 supplies a fresh bounded semantic proof, complete request-map validation, a reverse census, and an immutable reconciliation receipt for the current recovery generation.
