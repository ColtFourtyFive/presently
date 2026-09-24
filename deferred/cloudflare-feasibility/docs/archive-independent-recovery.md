# Independent v2 archive recovery

The offline recovery commands can verify v2 historical evidence without the original application database. They need the encrypted manifest and all referenced parts, plus the recovery key. Use Node.js 22.13 or later. This enables offline evidence recovery; authoritative publication, archive availability reconciliation, and application cutover remain separate work.

For a standalone history bundle, preserve the original object-key directories and run from the `cloudflare/` release directory:

```sh
KUMON_RECOVERY_KEY_FILE=/private/recovery-key.txt \
node --import tsx scripts/archive-recovery.ts verify-decrypt \
/private/archive-objects \
archives/center-id/2025-01/archive-id/manifest-SHA256.kca \
/private/new-history-output
```

The output contains the verified manifests and exact JSONL records for each archive. The command refuses to replace existing output. The recovery key never appears in its summary.

For an encrypted SQL backup with pinned archive references:

```sh
KUMON_RECOVERY_KEY_FILE=/private/recovery-key.txt npm run recovery -- \
verify-decrypt /private/sql-backup /private/new-restored.sql /private/archive-objects
```

The SQL backup manifest pins exact archive identities and hashes. The combined command authenticates SQL and archive objects, runs complete v2 semantic graph validation, and copies byte-identical encrypted history objects. It exposes the restored SQL only after verification succeeds. SQL catalog/availability reconciliation and restoration into a new application installation still require their separate checks.

## How evidence is checked

Both commands use the shared archive codec to authenticate manifests, references, encryption, compression, sizes, hashes, record order, and counts. For v2, the codec also requires a private semantic store. The new Node SQLite adapter stores only the verified archive records; it never queries live students, visits, observations, corrections, or audits.

Each staged part is bound again to its authenticated descriptor by its exact JSONL checksum, byte count, ordering, and table counts. Rows, part identity, and aggregate counters commit atomically. Duplicate parts and changed manifests cannot replace earlier evidence. Exact lookup and keyset pagination use archive/table/key indexes; visit, event, and audit-target relationship queries have dedicated indexes.

Semantic verification checks captured context, device ownership, request fingerprints, original sealed receipts, attendance/correction version chains, generated audits, review resolutions, and supported base/addendum relationships. Unsupported or inconsistent graphs fail even when their encryption and checksums are valid. A missing v2 semantic factory in the portable backup verifier remains an error; verification cannot silently fall back to v1 behavior.

V1 recovery retains its existing format and cryptographic checks. The public archive producer and review reader remain v1-only, and no source deletion becomes permitted by either offline command.

## Private staging and resource limits

Scratch databases are created exclusively as mode 0600 files inside mode 0700 directories. Every returned record is a detached copy. The CLI closes and removes SQLite scratch before exposing output. Failure and handled interruption clean the temporary stage and any output created by that attempt. Existing output is retained. Archive input path components cannot be symlinks; the explicitly selected bundle root may resolve through a symlink.

A store accepts at most 512 MiB of staged JSONL evidence, matching the existing graph plaintext limit. SQLite's main file is capped at 1 GiB with `max_page_count`; that cap is not a total disk-space estimate. The rollback journal, staged encrypted objects, and any JSONL output require additional space. Pages contain at most 64 records, individual records and encrypted parts retain codec limits, and each visit's operation chain retains the existing 2,048-operation/4-MiB closure limit. Exceeding a bound fails before publication.

The CLI runs whole-graph verification offline. These limits do not establish that a graph fits in one Worker invocation or that Cloudflare Free can run the operational archive workload. A successful local recovery also does not prove the destination R2 bucket contains the verified objects, that customer key custody is arranged, or that production acceptance is complete.
