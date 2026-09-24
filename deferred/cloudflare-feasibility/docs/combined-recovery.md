# Combined database and historical-object recovery

A D1 SQL backup contains the operational records and archive catalog. Completed archive manifests and their encrypted parts remain separate R2 objects. Since schema 8, each new encrypted SQL backup manifest pins every completed archive's exact object key and SHA-256 under the same write lock used to take the SQL snapshot. An archive still in progress at that point is not a completed dependency; recovery cancels such jobs before the restored application is used.

This stage copies history to R2 without deleting the original attendance, correction, or audit sources from D1. Pinning and verifying the R2 objects nevertheless avoids a restored catalog pointing to missing history, and prepares the recovery contract for any separately reviewed eviction work.

## Download and verify

Keep the downloaded SQL backup's `manifest.kcrm` and `part-*.kcrm` together. Download the pinned archive objects and every referenced ancestor into a separate directory that preserves their full `archives/<center>/<month>/<archive-id>/...` object keys. Include manifests and all their parts. A bucket listing or SQL backup by itself does not prove that this dependency set is complete.

```sh
KUMON_RECOVERY_KEY_FILE=/private/recovery-key.txt npm run recovery -- \
  verify-decrypt /private/sql-backup /private/restored.sql /private/r2-object-root
```

The last argument is optional; when omitted, the archive object root is the SQL backup directory. Old SQL-only manifests from before schema 8 remain readable. Schema 8+ manifests must explicitly declare their archive reference snapshot, including an empty list when no completed archives existed.

The independent CLI authenticates the SQL parts, exact pinned archive manifests, recursive references, and every compressed archive record. It copies each encrypted object into private staging and verifies the copy by reading it back. Only after every dependency has passed does it publish:

- `restored.sql`: decrypted SQL, published last.
- `restored.sql.manifest.json`: the verified SQL backup manifest.
- `restored.sql.archives/archives/...`: byte-identical encrypted historical objects, when any were referenced.

Files use mode 0600 and directories use 0700. The CLI refuses to replace existing output, sidecars, archive directories, or recovery locks. An error or handled interruption removes its own partial output. The terminal reports verified archive and object counts without printing the key. Verification bounds the combined history to 512 MiB encrypted and 512 MiB uncompressed and at most 4,096 archives; each archive graph has its own stricter codec bounds.

## V2 semantic evidence

The offline commands now support complete v2 semantic verification using a private, bounded SQLite store on Node.js 22.13 or later. The store contains only authenticated archive records and is removed before output becomes visible. V2 validates original receipts, corrections, audits, pickup/review relationships, and supported addenda without a live-source fallback. A missing semantic store still rejects v2. See [independent v2 recovery](archive-independent-recovery.md) for commands, limits, and the remaining publication/cutover requirements.

## Copy the exact R2 dependency set

For R2 installations, use the authenticated copy command instead of constructing the object inventory by hand. It reads the encrypted manifest, derives the exact SQL and recursive archive object set, downloads each object through Wrangler, and verifies the full encrypted graph before publishing a private directory.

```sh
npm run backup-copy -- copy \
  --config /private/customer/wrangler.customer.json \
  --backup-id BACKUP_ID_FROM_THE_CONTROL_CENTER \
  --key-file /private/recovery/customer.key \
  --out /private/customer/backup-copy
```

The copy command changes no remote resource. A missing, changed, corrupt, oversized, or unauthenticated object fails the copy and removes its partial destination. The published directory includes private `copy-evidence.json` with the encrypted manifest hash, complete object-inventory hash, counts, and byte totals.

## Restore into an independent installation

Restore SQL into a new isolated D1 database, apply current migrations, and run `scripts/recovery-access-reset.sql` while the Worker is disabled. This revokes restored sessions and integration state, fails incomplete backup jobs, cancels incomplete archive jobs, and expires import previews. Reconcile current identity permissions, revocations, holds, and deletions before allowing access.

Schema 18 adds four private `archive_semantic_*` staging tables to the SQL backup inventory. The reset preserves their manifests, committed parts and rows under the original history generation, marks every staging session `invalid`, and clears its verification token, graph digest and cleanup capability. Restored staging cannot resume or become a published archive, and stale cleanup handles cannot delete its retained evidence. Cleanup requires a new capability and explicit bounded calls after restore. Accepted history request keys and visit heads remain intact while their reconciliation restarts under a new generation. Staging records consume D1 space and enlarge SQL backups even though they carry no operational authority.

Upload every file in `restored.sql.archives/` into the destination private R2 bucket under the same object key. Verify destination byte lengths and SHA-256 against the verified manifests, then use the existing archive verifier against destination reads. Reconnect the reviewed recovery key and destination bindings. A successful local verification is not proof that the destination bucket was populated or that production cutover is safe.

The archive object bundle plus the encrypted SQL backup can be retained outside the original account. R2 in the same Cloudflare account alone does not protect against account loss. Copy-only archives and backups have no automatic object deletion policy in this implementation.

## Verification evidence

Local tests exercise a real workerd/D1/R2 archive job followed by a locked SQL backup, independent CLI verification/copy, SQL restoration into a separate D1, schedule/catalog count reconciliation, and byte-identical object copies. Separate CLI subprocess tests cover recursive addenda, missing manifests/parts, corrupted ciphertext, another recovery key, mismatched references, retained existing output, and recovery using only the copied archive bundle after the original source is deleted.

Provider SQL export calls in these tests are mocked. No live account-loss rehearsal or destination-bucket upload is claimed by this test evidence.

The native recovery regression also restores private sessions in `staging`, `frozen`, `verified` and `invalid` states, including a cleanup capability. Repeated access resets retain their exact private evidence, clear verification and cleanup authority, reject old adapter handles, generation changes and stale writes, and preserve accepted attendance identities and visit heads.
