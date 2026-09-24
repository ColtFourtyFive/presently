# Private D1 semantic staging

Schema 18 adds an internal adapter for authenticated v2 archive verification. It does not publish archives, create historical record locations, enable source deletion, or change the operational v1 reader and writer. `backup-archives.ts` still rejects v2 combined recovery until its runner is integrated separately.

`worker/archive-semantic-store.ts` implements the existing `ArchiveSemanticStore.page/get` contract using native D1 tables. It reads private staged records only. It never resolves a missing relationship from live application tables.

## Authentication and commit contract

A caller starts with the exact immutable root reference selected by its trusted archive catalog or backup manifest. The adapter requires the archive ID, kind, content-addressed manifest object key, and ciphertext SHA-256.

1. `D1ArchiveSemanticStaging.create(db, key, expectedRoot)` captures `history_runtime.generation` and creates a private verification ID. Persist its returned `handle` for interrupted work.
2. `registerManifest(expectedReference, encryptedManifest)` invokes `openArchiveManifest` with the expected reference. It authenticates the encrypted envelope and checks the content hash, identity, scope, and v2 format. Register each dependency using the reference from its authenticated parent manifest.
3. `stageEncryptedPart(archiveId, index, encryptedPart)` loads the immutable registered descriptor and invokes `verifyArchivePart`. Ciphertext, AES-GCM authentication, compressed/plaintext hashes, sizes, record order, coverage, and counts are checked before any staging write.
4. The adapter commits the authenticated records and their part checkpoint in one D1 batch. A part checkpoint stores the exact descriptor, descriptor digest, normalized record-set digest, and a random commit token. Identical concurrent or lost-response retries reuse the original token. A changed manifest or ciphertext is rejected.
5. `freeze()` checks root reachability, dependency hashes, scope/time, cycles, graph depth, and the exact complete part set. The transaction compares the registered manifest set again before closing all registration and part writes. It returns an opaque session commit token and a private `semanticStore` bound to that token. It has not yet established semantic validity.
6. `finalize()` runs `verifyArchiveSemantics` against that frozen store. Only successful completion records private `verified` status. Known semantic failures invalidate the session. An interrupted or maintenance-blocked frozen session can be resumed and verified again.

The adapter does not accept plaintext records with a caller-supplied `authenticated` flag. It does not implement `ArchiveStagingSink.stagePart`, whose input is already plaintext. An integration runner must supply encrypted envelopes to this adapter and then call `finalize`, or explicitly run the existing semantic verifier over the frozen snapshot. Running the verifier externally does not automatically write the adapter's verified status.

The existing `verifyArchiveGraph` runner is not wired to this adapter. Do not add `semanticStore` to its current sink while leaving `stagePart` as a no-op, and do not describe v2 backup recovery as enabled by this module alone.

## Storage and query bounds

The namespace is verification ID, captured generation, archive ID, table name, and immutable record key. The four tables are `archive_semantic_sessions`, `archive_semantic_manifests`, `archive_semantic_parts`, and `archive_semantic_rows`.

- A part contains at most 256 records and 1 MiB of plaintext. A single bounded JSON-array parameter inserts its rows through `json_each`. The write batch contains four statements regardless of record count. Its payload is at most the plaintext part limit plus two bytes, below D1's 2 MiB string limit. Each statement uses fewer than 100 bound parameters.
- Pages require an integer limit from 1 to 64 and use stable binary key ordering. A point lookup uses the complete primary key. `visit_id`, `event_id`, and `entity_id` filters explicitly use their corresponding relationship indexes.
- Each read batches the active-session check and data query in one D1 transaction. A missing, invalidated, or restored session throws. It never masquerades as an empty result set.
- Manifests and parts retain the existing format limits. The database enforces no more than 32 manifests and 512 MiB of declared graph plaintext per session. These are format ceilings, not supported deployment sizes.
- Backup-maintenance triggers cover all staging inserts, updates, and deletes. Snapshot reads remain available while the backup lock is active.

Native tests use a 600-record relationship fixture. Each relationship query retrieves four matching records with fewer than 20 D1 rows read; a 64-record page reads fewer than 70. Tests also assert a constant four-statement write batch for a full 256-record part.

These query limits do not establish complete Worker invocation limits. `freeze` examines the full registered manifest/part set, and `finalize` currently runs the entire semantic graph verifier. A large graph requires a resumable semantic runner or a separately measured and enforced smaller supported cap before production activation. Cloudflare documents 50 D1 queries per Free-plan Worker invocation and 100 bound parameters per statement in its [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Recovery and bounded cleanup

Native D1 exports include private staging. Backups inventory the four core tables, runner evidence, lifecycle state, and retained diagnostics. Recovery rotates `history_runtime.generation` and changes every restored session to `invalid`, clearing its session commit token, graph digest, cleanup generation, cleanup token, leases, and pause/resume controls. It retains manifest/part/row evidence and lifecycle history under the original generation. A previously verified status grants no authority after recovery.

`resume(db, key, originalHandle)` rejects a restored or missing session. Already-held readers and pending writes also check the current generation. Recovery must never change a saved session's generation to the new runtime generation.

Private records are immutable while being staged, frozen, or verified. They are not intended as permanent duplicate storage:

1. `session.discard()` invalidates a current session and removes read/success authority. It does not delete records.
2. `D1ArchiveSemanticStaging.beginCleanup(db, handle)` accepts only an invalid session and delegates to the schema 22 cleanup claim. It atomically claims a token under the current runtime generation, a 30-second lease, and a retained diagnostic. A live runner or cleanup lease rejects a competing claim. Evidence may remain under an older generation.
3. `cleanupPage(db, cleanupHandle, limit)` deletes at most 64 private records or checkpoints in one phase per call. A nonterminal page commits deletion, lifecycle revision, lease renewal, and next due time together. The terminal page records its exact completion receipt and deletes the session and lifecycle row atomically. The result reports `phase`, `deleted`, and `complete`; metadata writes are excluded from `deleted`.
4. Every deletion checks the cleanup token, original and current generations, invalid state, captured lifecycle revision, and unexpired lease in its transaction. Recovery, takeover, lease expiry, a lost revision race, or a backup lock prevents further deletion. A missing session succeeds only when the exact retained terminal receipt matches. Replaying that receipt returns the original `deleted: 1` result with no new write.

With schema 19, cleanup first removes private runner witnesses, operation references, visit totals, and jobs. Cleanup never deletes business records, authoritative historical keys, archive jobs, publication metadata, or R2 objects. It is an explicit internal operation with no route or scheduler enabled by this change. A future publication runner must retain its authoritative publication evidence elsewhere before discarding private staging.

## Remaining activation gates

The operational v1 path remains copy-only. Schema 19 adds the internal [bounded monthly-base verifier](archive-semantic-runner.md). Before enabling v2 publication, integrate it with the accepted-receipt resolver, publication transaction, and independent combined recovery. Addenda still need a bounded verifier. Keep all source eviction disabled until that full path is proven.

Staging temporarily duplicates plaintext evidence and adds relationship indexes and checkpoints. Schema 20 enforces [deployment admission limits](archive-staging-admission.md) in both the adapter and database: one resident session, one monthly base, 20,000 records and 16 MiB plaintext. New admission requires fresh primary size metadata plus a provisional 128 MiB allowance below 400,000,000 bytes. All statuses and generations retain the slot until the final session row is deleted. Existing incompatible state remains retained and eligible for cleanup. The format ceiling of 512 MiB is not an admitted profile. Full-month and boundary measurements are recorded in the [schema 20 checkpoint](archive-admission-checkpoint-2026-09-16.md). Schema 22 implements internal conditional expiry and leased cleanup. Daily pacing, unattended dispatch, long attendance-derived key and fragmentation checks, and deployed measurements remain necessary before activation.

Validation covers authenticated writes and replay, native transaction rollback, semantic rejection, private visibility, namespace isolation, immutable rows, indexed paging, backup locks, recovery generation races, bounded cleanup, and migration application under maintenance. Schema 18's DDL rolls back completely if a native migration batch fails.


Schemas 21 and 22 add [lifecycle metadata and controls](archive-staging-lifecycle.md). Paused sessions, expired verified snapshots, and work beyond the effective renewal deadline are fenced at the database. Renewal, idle grace, and cleanup do not fabricate semantic progress or grant publication authority. Retained diagnostics survive final cleanup; their retention and pruning remain unresolved. Final session deletion also removes the lifecycle row in the same transaction. Native metrics include those metadata and diagnostic writes even though the returned proof-entry deletion count does not. The complete schema 22 native local lifecycle measured 179,835 writes and 3,180,523 reads; future scheduling and budget overhead remain unmeasured.
