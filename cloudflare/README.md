# Kumon CRM Cloudflare feasibility build

This package is an isolated, single-center Cloudflare edition of the CRM. It uses React, Hono Workers, D1, Cloudflare Access, and enrolled front-desk kiosks. The Railway application is separate.

New installations start with an empty student roster. Copy `wrangler.example.jsonc` to the ignored `wrangler.jsonc` and set customer-owned resource and Access identifiers before using Wrangler.

This is not ready for live center operations. Live R2 backup/restoration, deployed resource measurements, physical iPad validation, the outage procedure, and integrated CRM acceptance remain release gates. See [live validation](docs/live-validation.md), [feasibility measurements](docs/feasibility-evidence.md), and the [readiness report](docs/readiness-report.md).

## Local preview

Use Node.js 22.13 or later.

```sh
npm ci
npm run check
npm test
npm run preview:local
```

Open http://127.0.0.1:8791/admin. This localhost-only preview uses a signed synthetic identity and a temporary empty D1 database. It does not perform a real Cloudflare login. Any records entered there are disposable test records. Stop the preview to remove its temporary database. Use `CLOUDFLARE_LOCAL_PORT` to select a different port.

## Installation and recovery

New installations use private Cloudflare R2 storage for encrypted backups. D1 remains the live database; R2 does not require Google OAuth. See [R2 setup and recovery](docs/r2-backups.md). The private test bucket is provisioned with public access disabled. The recovery-key secret is uploaded. Pending application migrations/deployment, export credentials, independent key custody, alert delivery, and live recovery validation remain.

The included `wrangler.jsonc` identifies the existing feasibility installation. Do not use it to deploy a customer installation. Generate a separate customer configuration with the [installation runbook](docs/installation-runbook.md).

```sh
npm run installation -- configure --input installation.local.json --out wrangler.customer.json
npm run installation -- doctor --config wrangler.customer.json
```

The installer validates configuration, prepares guarded updates, and applies migrations through D1's native SQL file import. Cloudflare's standard remote migration command failed on this release's SQL triggers during the live test. Follow the runbook rather than substituting a different migration command.

The recovery CLI can generate a private key file and verify/decrypt a downloaded encrypted backup. Keep the key outside the source tree and separate from backup storage. Follow [account setup and handover](docs/account-setup-handover.md) before restoring or reopening a database. Restoring SQL alone does not reconcile later access revocations or records created after the snapshot.

Generate the installation's key once, then place that same value into the Worker's `BACKUP_KEY` secret through a secure channel. Do not generate a replacement key when recovering an existing backup.

```sh
npm run recovery -- generate-key /private/customer/recovery.key
npm run backup-copy -- copy --config /private/customer/wrangler.customer.json --backup-id BACKUP_ID --key-file /private/customer/recovery.key --out /private/customer/downloaded-backup
KUMON_RECOVERY_KEY_FILE=/private/customer/recovery.key npm run recovery -- verify-decrypt /private/customer/downloaded-backup /private/customer/new-restore.sql
```

The read-only copy command obtains `manifest.kcrm`, every referenced encrypted SQL part, and every pinned recursive archive object from private R2. It verifies the complete encrypted dependency graph before publishing the destination. Decryption refuses to overwrite existing files and publishes SQL only after verification. Restore the SQL into a new isolated database. Run `scripts/recovery-access-reset.sql` there, reapply the current staff allowlist and revocations, reconcile the interval after the snapshot, and verify records before reopening access. Record the recovery duration and any missing interval. Successful decryption alone is not a completed restore drill.

Source code, migrations, UI components, and styles needed by this edition are contained in this directory. Customer accounts, credentials, backup keys, and business records do not belong in a distributable release.
