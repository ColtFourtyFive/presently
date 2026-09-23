# Customer installation and updates

This CLI prepares one customer-owned, one-center Cloudflare installation with R2 as the default encrypted backup destination. It generates configuration, checks local prerequisites, verifies an encrypted backup before an update, and imports unapplied D1 migrations through Wrangler's native SQL file importer. It does not create accounts or resources, change plans, configure Access policies, deploy a Worker, enable backups, release maintenance, or roll back a database.

Run commands from the `cloudflare/` release directory with Node.js 22.13 or later. This edition contains its own UI source, worker, dependencies, and migrations. Use `npm ci` with the supplied lockfile. Keep the customer configuration and recovery material outside the release directory so a new release can be unpacked without replacing either.

The software remains subject to the installation and acceptance checks in [account setup and handover](account-setup-handover.md) and [readiness](readiness-report.md). Local tests do not prove live provider delivery, costs, or center acceptance.

## First installation

1. Verify the business controls the Cloudflare account and identify its administrators and recovery contacts. Record the actual account ID, D1 ID/name, Worker name, backup queue name, and private R2 bucket name. Confirm R2 is activated and review its provider requirements before creating a bucket. A generated binding does not activate storage or create a bucket. Provision resources only in that verified account after reviewing any provider requirements. The installer cannot independently establish business ownership.
2. Create the Cloudflare Access application for the intended back-office address. Set its allowed identities and MFA policy. Record its issuer and audience. The Worker checks signed Access tokens; the issuer must be the exact `https://TENANT.cloudflareaccess.com` origin and the audience must be 64 hexadecimal characters.
3. Create a private input JSON file. Include only these public configuration fields, replacing every example with the customer's verified values.

```json
{
  "accountId": "REPLACE_WITH_32_HEXADECIMAL_CHARACTERS",
  "databaseId": "REPLACE_WITH_ACTUAL_D1_UUID",
  "databaseName": "customer-center-db",
  "workerName": "customer-center",
  "centerId": "customer_center",
  "accessIssuer": "https://YOUR-TEAM.cloudflareaccess.com",
  "accessAudience": "REPLACE_WITH_64_HEXADECIMAL_CHARACTERS",
  "ownerEmail": "owner@customer.example",
  "backupQueue": "customer-center-backups",
  "backupProvider": "r2",
  "backupBucket": "customer-center-private-backups"
}
```

The identifier placeholders deliberately fail validation. `backupProvider` may be omitted and defaults to `r2`; `backupBucket` is required for R2. Bucket names must contain 3 to 63 lowercase letters, digits, or hyphens, and must not begin or end with a hyphen. Do not include Google OAuth fields for this destination.

The generated `r2_buckets` entry binds `BACKUP_BUCKET` directly to the supplied bucket. It includes no S3 credentials and no remote development override. Confirm the bucket belongs to the selected customer account and has both public custom domains and the `r2.dev` public endpoint disabled. Configuration alone does not prove those settings. See the [R2 Workers API](https://developers.cloudflare.com/r2/get-started/workers-api/) and [bucket naming rules](https://developers.cloudflare.com/r2/buckets/create-buckets/).

```sh
npm run installation -- configure --input /private/customer/installation-input.json --out /private/customer/wrangler.customer.json
npm run installation -- doctor --config /private/customer/wrangler.customer.json
npm run check
npm test
npm run build
```

`configure` creates a new file with owner-only permissions and refuses to overwrite an existing file. Paths are relative to that file and point into the release used to create it. Its output contains secret names, never secret values. It leaves `BACKUP_ENABLED`, `ARCHIVE_ENABLED`, and `ARCHIVE_V2_ENABLED` false. Use the [isolated archive rehearsal procedure](archive-activation-operator.md) before enabling historical copies; source eviction is a separate D1 policy and remains disabled. `doctor` checks the supported configuration shape, paths, dependency files, and sequential migration inventory. Its unresolved list identifies checks that require actual customer accounts, bucket privacy, live backup delivery and restoration, devices, and operations. It does not report R2 as connected or private based on a local configuration file.

4. Review the initial migration inventory without any remote call.

```sh
npm run installation -- migrate --config /private/customer/wrangler.customer.json --confirm-database ACTUAL_D1_UUID
```

5. After checking the selected target, append `--execute` to initialize the empty database. This performs remote metadata reads, verifies the D1 UUID and name, then submits one native SQL file containing unapplied migrations and their ledger entries.

```sh
npm run installation -- migrate --config /private/customer/wrangler.customer.json --confirm-database ACTUAL_D1_UUID --execute
```

Do not use `wrangler d1 migrations apply --remote` for this release. Its statement splitting rejected this release's trigger SQL on the live validation target. Native `wrangler d1 execute --remote --file` preserved the trigger bodies in that validation. This is evidence for the checked release, not a guarantee that arbitrary future migrations are safe. The runner checks migration names and checksums after import. If the import or verification fails, stop and inspect the database before continuing. Do not retry by deleting ledger entries.

6. Generate the recovery key in a new private file, store a separate customer-controlled copy, and enter that same key at the `BACKUP_KEY` prompt. The CLI does not print the key. Keep the independent key copy outside the Cloudflare account and separate from backup files.

```sh
npm run recovery -- generate-key /private/recovery/customer.key
```

Configure the required secret values interactively through the installed Wrangler. Do not put values in shell arguments, source, input JSON, ordinary logs, or support messages. R2 uses the Worker binding and does not require a Google client secret or S3 access key.

```sh
node node_modules/wrangler/bin/wrangler.js secret put BACKUP_KEY --config /private/customer/wrangler.customer.json
node node_modules/wrangler/bin/wrangler.js secret put CF_EXPORT_API_TOKEN --config /private/customer/wrangler.customer.json
node node_modules/wrangler/bin/wrangler.js secret put BACKUP_ALERT_URL --config /private/customer/wrangler.customer.json
```

Kumon will own the alert receiver. It must accept an HTTPS `POST` with a JSON body and return a 2xx response only after it has accepted the alert. The Worker sends `Content-Type: application/json` and no separate authentication header, so use a private, unguessable webhook URL or a Kumon-owned relay if the final notification service requires another authentication method. Failure alerts contain `event: "kumon_backup_failed"`, `backupId`, `code`, and `at`; stale-backup alerts contain `event: "kumon_backup_stale"`, `provider`, `lastCompletedBackupId`, `lastCompletedAt`, `staleAfterHours`, and `at`. Neither payload contains student records. Keep the full URL in the Worker secret and the customer's secret store, never in this package or a support message. Before enabling scheduled backups, exercise both alert types in an isolated installation, confirm receipt with the Kumon alert owner, and verify that the control center records successful delivery. Also exercise a non-2xx response and confirm that the alert remains undelivered and is retried.

Use the smallest provider-supported D1 export token scope for the selected account. In the September 22 acceptance test, an account-level D1 Read token fetched database metadata but received HTTP 401 from the export API. Use an account-level D1 Edit token for the export Worker, with a short expiration during testing. Record its account-wide database access. Verify an actual export before relying on scheduled backups. Token verification and database metadata reads do not prove export permission. The alert URL may itself contain a credential, so treat it as a secret.

A downloaded encrypted backup can be verified and decrypted into a new private SQL file for a separate restore drill. For R2, first use the read-only customer copy command so the directory contains `manifest.kcrm`, every encrypted SQL part, and every pinned recursive archive object. The decrypted output contains customer records. Keep it in protected recovery storage and remove temporary copies according to the agreed procedure after the drill.

```sh
npm run backup-copy -- copy \
  --config /private/customer/wrangler.customer.json \
  --backup-id BACKUP_ID_FROM_THE_CONTROL_CENTER \
  --key-file /private/recovery/customer.key \
  --out /private/customer/backup-directory
```

```sh
KUMON_RECOVERY_KEY_FILE=/private/recovery/customer.key npm run recovery -- verify-decrypt /private/customer/backup-directory /private/recovery/restore.sql
```

See [recovery behavior and caveats](live-validation.md#recovery-behavior-and-caveats) and [the native export and isolated recovery drill](live-validation.md#actual-native-export-and-isolated-recovery-drill) for prior measured recovery evidence and restoration limits. That earlier drill does not by itself prove live R2 delivery.

7. Build and deploy using the customer configuration. Provisioning and deployment are separate, explicit operations; this CLI never starts them.

```sh
npm run build
node node_modules/wrangler/bin/wrangler.js deploy --config /private/customer/wrangler.customer.json
```

8. Verify the owner can sign in through Access, unauthenticated direct API calls fail, and ordinary staff receive the intended roles. Configure the center in the empty workspace, enroll managed kiosks, and issue individual operator PINs. Test revocation and the outage procedure.
9. Verify the private R2 binding and complete a live encrypted backup, download, alert test, and restoration into a separate customer-controlled installation. Compare restored records and relationships. Record results in the [account handover](account-setup-handover.md) and [live validation record](live-validation.md). Enable scheduled backups only when the agreed acceptance checks pass. Each installation has one queue producer and a consumer with concurrency one. Shared account quotas, storage limits, retention, and costs require measured verification.

R2 in the same Cloudflare account supports recovery from some database failures, but account loss or account-wide deletion can make both D1 and those backups unavailable. The customer must keep a complete encrypted copy outside that account and a separately held recovery key, and rehearse restoring from that copy without the original account. Record who makes the copy, its destination and schedule, its retention, and the last verified restore. The read-only copy command verifies and packages the exact remote object set. It does not choose the independent storage provider, schedule transfers, or make an account-loss recovery guarantee.

## Explicit legacy Google Drive installations

Google Drive is optional legacy support. To generate it, set `backupProvider` to `google-drive`, omit `backupBucket`, and include `googleOAuthMode` as `production` or `internal`. `googleClientId` may be omitted during preparation; the doctor reports it as missing. The generated configuration sets `BACKUP_PROVIDER=google-drive`, includes the Google fields, omits the R2 binding, and lists `GOOGLE_CLIENT_SECRET` with the required secret names. Set that secret through the interactive Wrangler command only when using this provider.

An existing Google-only customer configuration must set `BACKUP_PROVIDER` explicitly to `google-drive` before using the new installer. It cannot be silently interpreted as R2. For a new R2 configuration, remove Google fields and bind the verified private bucket. Preserve the separately held recovery key unless a reviewed key-rotation procedure calls for changing it. Do not assume that selecting a new provider moves or deletes old backups; retain the prior encrypted files and their keys until their retention and restore obligations are met.

The customer controls the legacy Google OAuth client, consent screen, Drive account, and recovery contacts. Confirm the actual Google application is in the required production or internal mode, test refresh-token behavior, and complete live backup/restore and alert checks before enablement. External Testing mode can cause seven-day refresh-token expiry for this use. A configuration flag does not publish the Google project. New R2 installations have no Google consent requirement.

## Updates to an existing installation

An existing database with pending migrations requires an update packet. A database with unrelated tables, no supported application history, reordered/unknown migrations, or mismatched recorded checksums is refused. A current migration ledger produces no writes. It does not prove the installed Worker or all operational checks are current.

The update packet is a local verification record. It is not a digital signature or independent proof of the owner's statements. The encrypted backup format does not independently prove customer account ownership; the named operator must verify its source and restore evidence. Keep the packet and configuration private.

1. Unpack the new release separately. Preserve the old release and its customer configuration for diagnosis. Generate a new customer configuration pointing into the new release, using the same verified customer identifiers. Reapply intentional public configuration such as the selected backup provider, private bucket name, and backup enablement. Legacy Drive installations also need their Google fields. Do not copy credentials into configuration.
2. Rehearse the new migrations against a separately restored staging installation and record the result. Confirm compatibility between the new schema and the Worker version to be deployed. Migrations that change guarded domain rows need an explicitly reviewed procedure; the installer does not bypass guard triggers.
3. Stop normal center writes and use the agreed outage procedure. Keep operational access isolated throughout the backup, maintenance, deployment, and verification steps. Take a fresh encrypted backup after normal writes have stopped. Wait for completion, download all encrypted parts and `manifest.kcrm`, and verify a separate restore using the separately held recovery key. D1 Time Travel is an additional recovery option, not a substitute for this backup.
4. Wait until no backup job is active, then acquire the manual-release maintenance lock in the selected database. Use a new `upgrade-UUID` identifier and record it. Do not use the backup job's ordinary expiring lock. The required `write_locked_until` value is `9999-12-31T23:59:59.999Z`.

The following SQL is a template to review with the verified customer target. Replace the lock ID with the same UUID recorded in the evidence file. Execute it with the explicitly selected customer configuration, then read the row back and confirm it was acquired. A zero-row update means maintenance was not acquired.

```sql
UPDATE backup_runtime
SET write_locked_until='9999-12-31T23:59:59.999Z',
    lock_job_id='upgrade-REPLACE_WITH_UUID'
WHERE id=1
  AND (write_locked_until IS NULL OR write_locked_until<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  AND NOT EXISTS(SELECT 1 FROM backup_jobs WHERE status NOT IN ('complete','failed'));
SELECT write_locked_until,lock_job_id FROM backup_runtime WHERE id=1;
```

The existing database triggers guard normal CRM domain writes. They do not stop all authentication and backup housekeeping. Keep the operating procedures and access isolation in place. The manual-release sentinel does not expire during the update, and the migration runner never clears it.

5. Create an evidence JSON file with these exact fields. Use UTC ISO timestamps with milliseconds and a trailing `Z`. Record real references to the restore and staged migration results. These references are operator attestations that a reviewer must inspect.

```json
{
  "accountId": "ACTUAL_ACCOUNT_ID",
  "databaseId": "ACTUAL_D1_UUID",
  "backupId": "ID_FROM_VERIFIED_BACKUP",
  "verifiedBy": "Named customer operator",
  "writesStoppedAt": "2026-09-14T12:00:00.000Z",
  "maintenanceLockId": "upgrade-ACTUAL_UUID",
  "restoreDrillReference": "Private record of independent restoration",
  "stagingMigrationEvidence": "Private record of the migration rehearsal",
  "acceptLegacyLedger": false
}
```

`acceptLegacyLedger` may be true only when a reviewer has checked the actual prior release and the installed migration history predates this installer's checksum ledger. This records current checked hashes for those existing migrations. It cannot reconstruct proof of which SQL was originally executed. It never permits an existing mismatched hash, unknown migration, or reordered history.

6. Protect the recovery-key file with owner-only permissions. Place every historical object referenced by the SQL backup, including recursive ancestors, under the backup directory using its full `archives/<center>/<month>/<archive-id>/...` key. Prepare the packet. This streams decryption and validates the encrypted manifest, SQL parts, and every pinned historical object without writing plaintext SQL or history. Missing, corrupt, mismatched, or symlinked historical inputs stop preparation. The migration command repeats this verification before making database changes. It then runs `npm run check`, `npm test`, and `npm run build`, and records configuration, source, migration, and encrypted-manifest hashes.

```sh
npm run installation -- prepare-update --config /private/customer/wrangler.customer.json --backup /private/customer/backup-directory --key-file /private/recovery/customer.key --evidence /private/customer/maintenance.json --out /private/customer/update-packet.json
```

The default maximum backup age is 60 minutes. A documented rehearsal may need `--max-backup-age-minutes N`, bounded from 1 to 1440 minutes. The age is checked again before an existing database is changed. A packet expires after 30 minutes. A stale packet, changed source/configuration/backup, invalid target, wrong key, active backup job, or missing manual-release lock stops migration. Prepare another packet when required. Elapsed time does not authorize continuing.

7. Review the plan, then execute the migration using the packet and key file.

```sh
npm run installation -- migrate --config /private/customer/wrangler.customer.json --confirm-database ACTUAL_D1_UUID
npm run installation -- migrate --config /private/customer/wrangler.customer.json --confirm-database ACTUAL_D1_UUID --packet /private/customer/update-packet.json --key-file /private/recovery/customer.key --execute
```

The runner submits only pending migration SQL, verifies the name and checksum ledgers, removes its temporary SQL file, and leaves maintenance active. It stops after a failed command. Provider output is suppressed because it may contain credentials; use the customer's protected provider diagnostics to investigate. Commands have a ten-minute timeout and an output limit.

8. Deploy the compatible Worker explicitly with the new configuration. Check the schema and protected application while maintenance remains active. Verify authentication, expected records, backups, and release-specific acceptance steps. A code rollback does not undo a schema change. If verification fails, keep access isolated and follow the rehearsed restore procedure into a separate target.
9. Only after acceptance, explicitly release the same maintenance lock. Verify the row and run a controlled write check before resuming center operation.

```sql
UPDATE backup_runtime SET write_locked_until=NULL,lock_job_id=NULL
WHERE id=1 AND lock_job_id='upgrade-ACTUAL_UUID'
  AND write_locked_until='9999-12-31T23:59:59.999Z';
SELECT write_locked_until,lock_job_id FROM backup_runtime WHERE id=1;
```

`scripts/recovery-access-reset.sql` is for restoration. Do not use it for a routine update; it revokes restored access credentials. Reopening operations is an explicit operator step and is never part of this installer.

## Prepare the draft customer handover package

After the release, configuration, and operating documents are final, generate a private draft package from the same release directory. The command records the exact release fingerprint, all migration hashes, customer resource identifiers, required secret names, copied operating documents, and 14 pending acceptance gates. It includes no secret values or recovery key.

```sh
npm run handover -- prepare --config /private/customer/wrangler.customer.json --out /private/customer/kumon-crm-handover
npm run handover -- verify --package /private/customer/kumon-crm-handover
```

Preparation refuses to overwrite an existing directory. Package verification rejects changed or extra files, symbolic links, public permissions, release or migration drift, incomplete gates, and any acceptance claim in the sealed template. Copy `acceptance-record.template.json` into a separate controlled record before attaching evidence or approvals. Once every external gate has dated evidence and both parties have signed, run `npm run handover -- verify-acceptance --package /private/customer/kumon-crm-handover --record /private/customer/completed-acceptance.json`. The completed-record verifier rejects a record inside the sealed package, release or installation drift, missing evidence, unsupported targets, reused customer/supplier identities, and inconsistent approval timing. These checks do not contact Cloudflare or establish that referenced evidence is truthful. Follow [the customer-owned handover package procedure](customer-owned-handover-package.md) to finish those gates.

## Evidence and limits

The installer suite uses isolated local directories, synthetic encrypted backups, and an injected provider-command runner. It covers configuration validation, file permissions/no-overwrite behavior, backup corruption/wrong keys/staleness, packet and source changes, target identity, migration history/checksums, native-file construction, maintenance guards, failed imports, and idempotent reruns. These tests make no remote changes. The release's native D1 import also has separate live validation evidence from an empty feasibility target.

Remote resource creation, R2 activation and bucket privacy, owner identity verification, provider billing, live backup/restore, independent-copy recovery, deployment, center acceptance, and recovery after an arbitrary future schema migration remain explicit operational work. Google consent approval applies only to explicit legacy Drive installations.
