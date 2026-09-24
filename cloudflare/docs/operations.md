# Operations

## Backups

Every night at the hour chosen in Settings (in the business's time zone, default 2:00 AM), the Worker:

1. asks D1 for a SQL export, using the `CF_D1_EXPORT_TOKEN` secret (D1 Edit on this account only);
2. copies the export in 512 KiB parts, encrypts each part with AES-256-GCM under a key derived from the owner's recovery key, and writes it create-only to the private R2 bucket under `backups/<backup-id>/`;
3. reads each object back to verify it, then writes an encrypted manifest listing every part and its hashes.

D1 briefly pauses other queries while an export runs, which is why backups run at night. Each step is one small queue message, so no single invocation does much work. Stalled jobs are re-queued hourly. After five failed attempts a job is marked failed and, if `BACKUP_ALERT_URL` is set, an alert is posted. An alert is also sent if no backup has completed for 26 hours. The owner can start a backup at any time from Settings → Backups.

D1 also keeps 30 days of point-in-time history (Time Travel), which covers accidental changes without needing the backups.

Backups are never deleted automatically. At roughly 1–2 MB per compressed night for a typical location, R2's free 10 GB lasts for years. Review the bucket once a year.

## Restore a backup

Restore into a **new** database. Never overwrite the live one.

```sh
# 1. Download and verify the encrypted backup (uses your Cloudflare login).
npm run recovery -- download --bucket <worker>-backups --backup <backup-id> --key-file recovery.key --out ./restore
# 2. Decrypt to SQL. Every part is checked against the manifest first.
npm run recovery -- decrypt --dir ./restore --key-file recovery.key --out ./restore.sql
# 3. Load it into a new database.
npx wrangler d1 create <worker>-db-restored
npx wrangler d1 execute <worker>-db-restored --remote --file ./restore.sql
```

To switch the installation to the restored database, change `database_name`, `database_id` and `CF_DATABASE_ID` in the installation's `wrangler.jsonc` and deploy. Then:

- sign in and check the roster, recent visits and staff list;
- revoke and re-enroll kiosks if a device was lost, and reset PINs if they may have been exposed;
- record on paper any attendance between the backup and the restore, then enter it as manager corrections with the reason "restored from backup".

Run a restore drill into a scratch database at least once a year and after any major update. Record the date and how long it took.

## Outage procedure

Print this for the front desk. Adopting it is one of the center's annual attestations (requirement 6).

When the screen shows **Offline**, or Presently cannot be reached:

1. Keep a paper sign-in sheet at the desk with columns for student name, student code, time in, time out, pickup adult, and staff initials.
2. Write each arrival and departure **when it happens**, with the actual time.
3. Check pickup authority against the printed pickup list (print it from the roster at the start of each month).
4. Anything already on screen may be out of date. Do not trust the "Here now" list until it says Connected again.
5. When Presently is back, a manager enters the paper records as corrections, with the reason "entered from outage sheet on <date>". Keep the paper sheet for two years.

Presently never shows an action as saved until the server confirms it. If a check-in says "Not confirmed", tap the same button again. Retrying the same action can never create a duplicate.

## Updates

1. Read the release notes. Database changes come as new numbered migration files; existing migrations never change.
2. Run a backup from Settings, and confirm it completed.
3. Apply migrations, then deploy:
   ```sh
   npx wrangler d1 migrations apply CRM_DB --remote --config ../installations/<worker>/wrangler.jsonc
   npm run build:client && npx wrangler deploy --config ../installations/<worker>/wrangler.jsonc
   ```
4. Check `https://<host>/api/health` and sign in.

To roll back the Worker, redeploy the previous release. If a migration has already run, restore the pre-update backup into a new database instead of running old code against a newer schema.

## Retention

Attendance observations, corrections, reviews, attestations and audit entries cannot be edited or deleted, by database rule. Nothing is removed automatically. At about 7.5 MB per location per year, the 500 MB free database holds decades of records. "At least two years" is a floor, not a deletion date. Inactive students stay on file with their history.
