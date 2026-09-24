# R2 backups and import status

Updated September 22, 2026. This records the local implementation and a controlled acceptance test, not a production release.

Validation passed: 87 tests across seven suites, TypeScript, and the production build. Four R2 tests cover private local storage, missing configuration, retry behavior, corrupted readback, and encrypted artifact recovery through the independent CLI into fresh local D1. Browser checks confirm the R2 settings display, no Google connection button for R2, disabled backup requests when setup is incomplete, empty backup history, and rejection of invalid UTF-8 uploads. This evidence uses isolated local data and does not establish live R2 delivery.

## Storage choice

D1 remains the operational database. The Worker encrypts consistent D1 SQL exports and writes their parts and authenticated manifest to a private R2 bucket through the `BACKUP_BUCKET` binding. R2 is the default backup provider. Google OAuth is unnecessary for this configuration. An existing Google installation can explicitly select `BACKUP_PROVIDER=google-drive`.

Each backup keeps its original provider even if a later deployment changes the default. R2 object keys have the form `backups/<backup-id>/manifest.kcrm` and `backups/<backup-id>/part-00000.kcrm`. Existing encryption and the independent recovery CLI remain compatible. Successful delivery means ciphertext has been read back and verified; it does not prove that a restored application can operate.

## Live account status

### Kumon-owned backup alert endpoint

Kumon should supply one private HTTPS webhook URL for the `BACKUP_ALERT_URL` Worker secret. The endpoint must accept `POST` requests with `Content-Type: application/json`, record the event in Kumon's monitored alert system, and return a 2xx response only after accepting it. Keep the URL in Kumon's secret manager and configure it through Wrangler's `secret put`; do not place it in `wrangler.json`, the source repository, or the handover package.

The Worker sends `kumon_backup_failed` with `backupId`, `code`, and UTC `at`. It sends `kumon_backup_stale` with `provider`, `lastCompletedBackupId`, `lastCompletedAt`, `staleAfterHours`, and UTC `at`. Neither payload includes student or guardian data. Kumon should route both events to its on-call owner and test delivery by forcing a backup failure and an overdue condition on an isolated installation. Confirm the webhook's receipt and the owner screen's delivery timestamp. A non-2xx response remains visibly undelivered. Both stale alerts and terminal failure alerts retry no more than once per hour after a non-2xx response or network error. The owner screen shows the latest attempt and confirmed delivery. Live delivery to Kumon's endpoint remains a production acceptance item.

The separate owner-protected acceptance Worker completed a manual encrypted R2 backup on September 22. The customer-side copy authenticated the manifest and part, and a new isolated Cloudflare D1 imported the decrypted SQL with matching table counts and clean integrity checks. The acceptance database now has one labeled synthetic student, one historical visit, two observations, and one encrypted archive; the separate feasibility database remains empty. See [the initial acceptance backup and restore](../review/customer-handover-package/acceptance-r2-backup-restore-2026-09-22.json) and [the combined archive restore](../review/customer-handover-package/acceptance-combined-r2-restore-2026-09-22.json). A scheduled backup on the isolated combined restore completed in 18 seconds after the Worker stopped writing to D1 during an active export. Customer-side copy authenticated its manifest, one SQL part, and nine archive objects, and recovery decryption passed. See [scheduled backup evidence](../review/customer-handover-package/acceptance-scheduled-r2-backup-2026-09-22.json). Automatic backups on the acceptance installation and live failure alerts remain disabled pending operational acceptance.

The acceptance D1 Read token returned HTTP 401 from Cloudflare's export endpoint. A 30-day Account D1 Write token allowed the manual export, and the dashboard scoped that permission to the entire developer account. This credential can modify other D1 databases in that account. Keep it temporary, store it only as the Worker secret, and revoke it after acceptance. The customer installation should use Kumon's own Cloudflare account and a separately managed export credential.

The test account is `ochengweb@gmail.com`, account ID `cd7fb7f2adb6b28c0ac2749897c58cd6`. R2 activation is now verified in the dashboard. The `kumon-feasibility-backups` Standard bucket was created successfully. Wrangler confirms its public r2.dev access is disabled and no custom domains are connected. The live Worker still needs the pending migrations, R2 deployment, and backup secret configuration before live backup/restoration can run.

After activation:

1. Completed for the test account: create the dedicated private bucket and verify that public access and custom domains are disabled.
2. Apply new versioned migrations through the guarded native SQL migration procedure. Never modify an already applied migration.
3. Configure `BACKUP_KEY`, `CF_EXPORT_API_TOKEN`, the account/database identifiers, and the R2 binding. Keep the recovery key in a separately accessible vault.
4. Deploy and verify owner-only backup administration. Request a manual backup and check verified completion before enabling the nightly schedule with `BACKUP_ENABLED=true`.
5. Run a scheduled backup, download the encrypted artifacts, and restore into a separate installation using the delivered source and independently held key. Validate record counts, relationships, audit history, and access reset. Measure recovery time and the data-loss interval.
6. Complete rotation/lifecycle policy, failure notifications, stale-backup escalation, and capacity testing before production acceptance.

The existing Google Cloud project and OAuth client have not been deleted. The user reports OAuth creation is complete, but it is no longer a prerequisite for R2.

## Recovery and ownership

Download a complete backup prefix from the private R2 bucket using the Cloudflare dashboard or authenticated S3-compatible tooling. Keep `manifest.kcrm` and all encrypted parts together. Wrangler also supports downloading an individual object:

```sh
npx wrangler r2 object get <bucket>/backups/<backup-id>/manifest.kcrm --remote --file /private/customer/backup/manifest.kcrm --config wrangler.customer.json
```

Download every part under the same prefix, then use the existing verifier:

```sh
KUMON_RECOVERY_KEY_FILE=/private/customer/recovery.key npm run recovery -- verify-decrypt /private/customer/backup /private/customer/new-restore.sql
```

Follow the [installation runbook](installation-runbook.md) and [account handover](account-setup-handover.md) to restore and reconcile records before cutover. Verified decryption alone is not a restore drill.

R2 and D1 in the same Cloudflare account share an account-access failure risk. Keep an additional encrypted copy outside that account if recovery must survive account loss. This can use customer-approved storage and does not require Google Drive. Customer handover includes the Cloudflare account, source, bucket, export credentials, separately held recovery key, operating instructions, and a witnessed recovery exercise.

## Verified customer-side R2 copy

The customer-side copy command removes the manual object-inventory step. It downloads the encrypted SQL manifest first, authenticates it with the separately held recovery key, copies every exact backup part, follows every pinned monthly archive and recursive archive dependency, and verifies the complete encrypted graph before publishing the destination directory. It refuses an existing destination, rejects symbolic links and non-private key files, removes partial output after failure, and records a private `copy-evidence.json`. The command performs R2 reads only.

```sh
npm run backup-copy -- copy \
  --config /private/customer/wrangler.customer.json \
  --backup-id BACKUP_ID_FROM_THE_CONTROL_CENTER \
  --key-file /private/recovery/customer.key \
  --out /private/customer/backup-copy
```

The resulting directory contains `manifest.kcrm`, every encrypted SQL part, and the exact `archives/...` hierarchy required by the backup. Run recovery directly against the copy:

```sh
KUMON_RECOVERY_KEY_FILE=/private/recovery/customer.key npm run recovery -- \
  verify-decrypt /private/customer/backup-copy /private/customer/new-restore.sql
```

Wrangler authentication must have read access to the named private bucket. The command does not deploy, write to R2, delete objects, restore D1, or enable scheduled backups. Copy the completed encrypted directory to the customer-approved independent storage location before testing account-loss recovery.

## Cost

Cloudflare's published R2 Standard pricing on this review date includes 10 GB-month of storage, one million Class A operations, and ten million Class B operations per month. Additional Standard storage is $0.015 per GB-month, with additional operation charges; direct R2 egress is free. These are account-level allowances, not a promise that this installation is free. Retained backup size, frequency, retries, and other workloads must be measured.

## Bulk roster import

The Cloudflare edition includes owner/manager CSV import with up to 500 rows, 40 columns, and 512 KiB per file. It provides column mapping, preview validation, create/update/skip decisions for duplicates, explicit guardian references for shared contacts, batches of at most ten rows, receipts, and partial-import resume. Required mappings are a stable student reference, first name, and last name.

The current local update preserves optional fields when their columns are not mapped, including pickup restrictions and subjects. Explicitly mapped blank values can clear or reset those fields. Invalid UTF-8 files are rejected. These corrections must be tested and migrated before the live importer is approved. Preview every change, particularly pickup authority. Real Kumon export mapping and historical migration remain deferred until a sample and field definitions are supplied.

## References

- [R2 Worker bindings](https://developers.cloudflare.com/r2/get-started/workers-api/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [R2 lifecycle rules](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)
- [Wrangler R2 commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/)
