# Historical archive implementation

Updated 2026-09-17. The implementation is local and has not been deployed.

## Implemented

- Migration 0008 adds jobs, selected-record membership, encrypted-part references and preservation holds. Existing immutable attendance deletion guards remain active.
- Owners can request a completed calendar month whose end is at least 90 days old. Selection uses the center timezone and original arrival month. Effective times can differ after correction.
- Open visits, pending reviews and active holds are excluded. Selected historical records freeze while a copy runs. Current attendance and profile edits remain available. Cancellation and two-hour expiry release the freeze.
- Identity context is captured in the same D1 batch as record selection. Historical staff context excludes credentials and sign-in email. Guardian context excludes phone and email. Observations retain accepted receipts and actor names.
- Each queue step encrypts and stores a bounded compressed part. Fresh encryption on retry avoids nonce reuse. R2 object keys identify immutable ciphertext; uploads use create-only conditions followed by readback.
- A separate verification pass authenticates the manifest and every part, checks selected-record hashes and marks the job complete. Missing or corrupt files do not produce a completed archive.
- Settings shows copy progress and cancellation. Copies are disabled unless the installation explicitly configures them.
- The independent archive recovery command verifies all referenced monthly and addendum files in private staging before publishing its output. Combined D1 recovery pins archive references and verifies them before publishing a restored SQL and archive bundle.
- Schemas 29 and 30 make archived visit history, attendance-report visit phases and student-profile attendance detail authoritative after source rows are absent. Compact retained visit and correction heads locate selected records. Live detail wins, encrypted R2 supplies missing detail, and every result is rechecked against D1 and archive authority.
- Student profiles select the latest 20 visits and latest 100 corrections independently. A recent correction remains visible when its visit is older than the displayed visit list. Complete live D1 profiles make no R2 reads.

## Deliberately still incomplete

The verified-copy and authenticated-read stages do not remove attendance rows from D1 or reduce live D1 storage yet. Before enabling eviction, implement and test all of the following together:

1. Historical correction mutation against an archived visit, published as authenticated immutable addendum evidence and reconciled after restoration.
2. Permanent old-ID lookup independent of caller-supplied dates, including unchanged retry receipts and rejection of reused IDs.
3. Hold-aware expiry and source-eviction fences, including changes made after a completed copy.
4. Addenda for changes made after a completed copy.
5. Independent recovery of an installation after actual eviction, with D1 indexes, every referenced object and a separately held recovery key.
6. Actual D1 storage measurements and a supported reclamation procedure. Local SQLite `VACUUM` measurements do not establish remote D1 allocation behavior.

Historical copies are evidence snapshots. Their JSONL files are not ordinary SQL inserts and must not be inserted into a running database through attendance triggers. A D1 SQL backup restores live state; archive objects and indexes restore historical access.

## Local verification

`tests/archive-jobs.test.ts` exercises real workerd, D1 and R2 behavior. It checks successful verified copies, identity minimization, preservation holds, pending and current records, cancellation, expired freezes, corrections, corruption and authorization.

`tests/archive-range-reader.test.ts` covers authenticated source-free history, reports and student detail, including retained-head mismatches, missing objects, changed authority and bounded R2 reads.

`tests/archive-codec.test.ts` and the recovery tests check strict format bounds, decompression limits, encryption separation, ordering, parent and addendum references, wrong keys, corrupt or missing files, subprocess interruption and private no-overwrite publication. See [combined recovery](combined-recovery.md) and the [schema-30 checkpoint](archive-student-detail-authority-checkpoint-2026-09-17.md).

See also the [schema-31 archived-correction checkpoint](archive-correction-outbox-checkpoint-2026-09-17.md).

Live Worker-to-R2 backup delivery and remote restoration remain release gates.
