# Backup freshness alert checkpoint

Validated September 21, 2026. Schema 38 adds durable overdue-backup notification state. It does not enable backups, configure an alert destination, deploy code, migrate a remote database, or prove live delivery.

## Behavior

- The scheduled Worker records when freshness monitoring first becomes active.
- A configured backup provider becomes stale when no verified backup has completed within the configured threshold, 26 hours by default.
- The Worker posts a `kumon_backup_stale` event containing the provider, last completed backup identifier and time when available, threshold, and observation time. It contains no student data.
- Alert state is persisted in `backup_runtime`, included in encrypted D1 backups, and visible to owners through the backup-status API and control-center UI.
- One stale episode is delivered once. Failed or unconfirmed webhook attempts retry no more than once per hour. A later verified backup clears the episode; a new overdue interval creates a new episode.
- Existing terminal backup-job failures continue to send `kumon_backup_failed` with their job identifier and error code.
- Invalid configured freshness thresholds fail closed. Supported values are whole hours from 2 through 168.

## Validation

The schema 38 release passed 861/861 tests across 81 files with no failed or skipped tests. Focused tests prove scheduler integration, no initial false alert, the 26-hour boundary, failed-delivery throttling, confirmed delivery, duplicate suppression, recovery after a verified backup, and a later independent stale episode. Backup, recovery, installer, and handover suites pass with schema 38 included in manifests and restoration.

## Live acceptance still required

The feasibility Worker remains at schema 4. `CF_EXPORT_API_TOKEN` and `BACKUP_ALERT_URL` are missing, and `BACKUP_ENABLED` remains false. Before production acceptance, configure a customer-approved external alert destination, prove successful and failed webhook delivery, observe manual and scheduled R2 backups, exercise stale escalation, and restore a populated encrypted backup in an independent customer-controlled installation.

