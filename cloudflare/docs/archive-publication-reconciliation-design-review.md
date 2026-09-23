# Restored publication catalog reconciliation — design review

Design only, September 16, 2026. This note proposes the next bounded checkpoint. It changes no schema, product code, test, availability, deployment, or live data. It does not authorize a route, scheduler, source eviction, abandoned-claim cleanup, or automatic recovery.

## Current implementation

Schema25 retains each publication's original proof generation, root reference, authenticated header identity, locator digest, records, parts, and permanent request claims. Restoration invalidates unfinished builds and changes committed publication availability to `unavailable`, preserving its previous generation. Readers require availability in the current history generation and recheck authority after object reads.

The existing availability guards deliberately cannot mark a restored publication ready. A successful offline v2 graph verification currently proves the archive's semantic relationships; it does not prove that the restored SQL locator and request catalog exactly matches that archive. Neither the old published descriptor nor its old completed semantic run supplies fresh execution authority.

## Recommended contract

Use a new, current-generation completed validator1 semantic run plus a separate, resumable catalog reconciliation job and immutable completion receipt. Keep all original publication provenance unchanged. The only final product mutation is a guarded availability transition for the reconciled publication.

The unit of atomic visibility is **one complete publication**, not one part or request. Every required publication must pass separately before a restored installation's full-history cutover is approved. A success for one month cannot mark other months ready. Enumerate committed descriptors in bounded primary-key pages and use their exact pinned object references; do not list R2 or infer completeness from objects that happen to be present.

Support the current profile only: one v2 monthly base, no references/addenda, validator1, locator version1, and the existing admission limits of 20,000 records and 16 MiB of plaintext staging. Unsupported provenance, a missing key, a missing object, or an unreconciled publication remains unavailable.

## Proof and catalog identity

1. Authenticate the exact manifest and all parts pinned by the immutable descriptor. Create fresh private staging and complete the supported semantic validator in the current history generation. All relationship lookups use that detached staging, including captured profiles, visits, reviews, immutable events/corrections, and audit aliases.
2. Compare the fresh proof's root/header identity with the existing publication: archive ID, center/month/timezone, manifest object key/hash, format, schema/application provenance, header hash, and declared counts. Reject a different valid archive rather than replacing the original publication.
3. Pin a bounded fingerprint of the complete immutable descriptor and its original proof fields in the new reconciliation job. Record the **new** verification ID, run ID, frozen token, graph hash, validator version, and execution generation separately. Never relabel the publication's original generation or update its original build to the new generation.

A `verified` session without the exact completed supported run remains insufficient. Reconciliation must also stop if the new session expires, its proof is invalidated, cleanup begins, history leaves `ready`, maintenance starts, or generation changes.

## Complete equality, in bounded pages

The archive and restored SQL catalog must agree in both directions. Point-checking only the requests used by a smoke test is insufficient.

| Catalog | Required equality |
| --- | --- |
| Parts | Exact contiguous part indices, descriptor JSON/hash, record counts, completed state, and indexed counts against the authenticated manifest. Explicit EOF excludes extra parts. |
| Records | For every authenticated record, exact publication/table/key, part index and offset, descriptor hash, UTF-8 record byte length, and SHA-256 of the original serialized record. No missing, duplicate, misplaced, or additional locator is allowed. |
| Request claims | Exactly one claim for every event/correction, with its original request ID, publication, table/key, source kind, center, and literal payload hash. No extra claim and no audit alias treated as another owner. |
| Permanent registry | Each expected request has the same owner/type, literal fingerprint, hash encoding, and supported canonicalization declaration. Unrelated registry keys are allowed. Missing or conflicting keys are not repaired by reconciliation. |
| Totals and digest | Exact per-table, part, record, and request counts, explicit EOF for every catalog pass, and the publication's locator digest. |

Use indexed pages of at most 64 rows and a stricter decoded-byte cap. A practical initial implementation can reuse the publisher's maximum eight records/256 KiB per advance. A part read remains bounded by the archive format limits. SQL checks should use the publication/part/offset index and exact record/request keys, with forced join order or index selection where measurements show the planner may scan unrelated rows. Count the complete catalog using bounded pages, not a growing full-index scan on every checkpoint.

One pass can compare authenticated records with their exact SQL locators and claims. A separate bounded catalog pass, with independent observed counts and EOF, rules out extra restored entries. Immutable published tables allow those pages to share a stable identity; generation and descriptor fences must still hold in every native checkpoint transaction. If a future migration permits catalog repair, it must introduce an explicit catalog revision that this job pins.

Do not query live attendance, correction, audit, visit, review, student, or guardian rows to establish equality. In particular, current names, current visit versions, and reconstructed receipts cannot replace the captured evidence. A complete supported archived proof and permanent ownership are the intended authority after live detail is absent.

## Locator digest compatibility is a prerequisite

Current locator version1 is a chain beginning with 64 zero hex characters. Each update hashes UTF-8 `JSON.stringify({ prior, locators })`; each locator uses the ordered fields `table`, `key`, `part`, `offset`, `descriptorSha256`, `recordSha256`, and `recordBytes`.

The chain also depends on page boundaries. The current writer takes up to eight records and 256 KiB of serialized record bytes, stops at part boundaries, and hashes every accepted page. Therefore, hashing the same locator set in arbitrary pages will produce a different digest.

Before implementing reconciliation, freeze this complete algorithm as locator version1 and extract a shared pure encoder/page-partition function with fixed test vectors. Reconstruct its original deterministic page grouping from authenticated part records. Do not compare a new aggregate digest with the old page-chain digest or silently change version1's page policy. Any future change requires a new supported locator version and explicit compatibility handling.

## Minimum durable additions and API

A forward migration should add two logical records:

- A reconciliation job containing publication/current-generation identity, pinned descriptor fingerprint, the fresh semantic proof identity, policy version, state, revision/lease, bounded phase/cursors, observed counts, and digest progress. Checkpoints update only this operational record; they never edit existing locators or request claims.
- An immutable reconciliation receipt containing the complete pinned identities, verified totals/digests, supported versions, and completion time. Copy proof provenance rather than referencing disposable staging with a foreign key.

Add a nullable receipt reference to availability, or an equivalently enforceable receipt binding. Initial publication can retain its existing same-generation proof path. The new ready transition must require a matching completed receipt for the **current** generation and exact immutable publication identity. Support a missing availability row only through that same reconciliation proof; do not treat absence as readiness.

Expose internal start/advance/read-result operations only. Starting binds a fresh completed proof; advancing takes an exact expected revision and one current lease. Caller-supplied `verified` flags, receipt JSON, counters, or hashes cannot mint authority. There is no “mark ready” shortcut and no repair/overwrite mode.

## Terminal transaction and interruptions

After all comparison passes reach EOF and exact totals/digest agree, one native transaction should finalize the reconciliation job, insert its immutable receipt, and insert/update availability to `ready` in the current generation. Recheck the fresh proof, descriptor fingerprint, exact lease/revision, maintenance barrier, and history generation inside that transaction.

Finish with an in-transaction assertion that the expected availability write occurred. A conditional update affecting zero rows must abort preceding receipt/job writes; a JavaScript check after the batch is too late. Replays return an exact saved outcome and issue no new capability.

A lost checkpoint response is resolved by its saved revision/outcome; it does not permit a second increment. A lost terminal response must leave either the entire ready transition or none of it. Generation change invalidates unfinished reconciliation work, clears its leases, and makes availability unavailable while preserving both original and previous reconciliation provenance. A later attempt needs a fresh current-generation proof. Completed receipts survive staging cleanup.

Budget this work separately. Authentication, catalog reads, denied calls, status inspection, and recovery retries all cost resources. The pending entry-accounting and account-allocation gates still apply; restoring a SQL budget does not recreate spending authority. No automatic retry or background activation is implied by a resumable reconciliation API.

## Required tests and remaining risks

The acceptance drill must restore encrypted SQL plus pinned R2 objects into an isolated installation, remove live immutable source detail only in that test fixture, reconcile the full publication, and reproduce the original accepted event receipts and correction responses. Include literal sealed `"null"`, tuple/object receipts, renamed profiles, and later visit corrections.

Adversarial cases must include missing and extra parts/locators/claims; wrong ordinal, row hash, byte length, descriptor hash, owner, source kind, fingerprint or catalog digest; unsupported proof/locator version; malformed yet authenticated evidence; and a valid replacement archive with a different pinned identity. Verify no failure mutates original publication rows or repairs the permanent registry.

Exercise interruptions before/after every checkpoint and terminal commit, stale leases/revisions, generation reset during R2 reads, maintenance, expired proof, staging cleanup, repeated reset, missing availability, lost terminal reply, forged/copied receipts, and exact replay. Restore again after a successful reconciliation and prove availability becomes unavailable again.

Measure supported maximum parts/records and large unrelated catalog/registry populations. Require indexed plans, bounded bytes, the complete invocation's statement ceiling, native usage evidence, and deployed CPU evidence before activation. Add backup inventory, maintenance triggers, and forward-migration/rollback rehearsals for new reconciliation metadata.

Abandoned invalid-build claims remain reserved under schema25. This proposal neither deletes them nor enables rebuilding their publication. It also does not provide addendum reconciliation, historical report integration, archive-aware correction writing, or safe source eviction. Those remain separate release gates.
