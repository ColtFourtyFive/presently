# Deployed proof (release gate)

Local tests prove behavior. They do not prove that a real free-tier account stays inside Cloudflare's limits, or that a physical iPad works well. Complete this checklist on a real account before selling the first installation, and again after any change to the Worker's hot paths. Record results in a dated copy of this file outside the repository.

## 1. Install end to end

- [ ] Fresh Cloudflare account on the Free plan, with a card on file only for R2 and Zero Trust.
- [ ] `npm run install:business -- --input installation.json --execute` completes without manual fixes. Record the duration.
- [ ] `wrangler d1 migrations apply --remote` applied `0001_initial.sql` (the installer's output shows it).
- [ ] `/api/health` returns `ok`. The owner's first sign-in creates the business.
- [ ] The deployed script is minified: open Workers → the worker → Edit code and confirm no readable source or source maps.

## 2. CPU per request (Workers Free: 10 ms)

Workers Logs is on (`observability.enabled`, sampling 1.0). After the steps below, open Workers → the worker → Logs, filter by path, and record CPU time p50/p99/max for each operation. `wrangler tail --format json` also shows `cpuTime` per invocation.

| Operation | How to trigger | p50 | p99 | max | Limit errors |
| --- | --- | --- | --- | --- | --- |
| Access sign-in, cold | First page load after 10 minutes idle | | | | |
| Kiosk PIN unlock | Unlock 20 times | | | | |
| Check in / check out | 50 of each on the kiosk | | | | |
| Roster poll, unchanged | Leave the kiosk open 30 minutes | | | | |
| Student search | 30 searches | | | | |
| CSV import preview (500 rows) | Import the template with 500 rows | | | | |
| History export (1 year) | Export after seeding a year | | | | |
| Evidence report | Generate for the current year | | | | |
| Backup queue step (part) | Settings → Back up now | | | | |
| Hourly cron | Wait for the top of the hour | | | | |

Pass: no "exceeded CPU" errors, and p99 under 10 ms for everything a front-desk user touches. If the import preview or export exceeds it, lower the batch sizes (`EXPORT_PAGE` in `worker/reports.ts`, `MAX_ROWS` in `worker/import.ts`) before considering the paid plan.

## 3. D1 rows and storage

- [ ] Seed one year of synthetic attendance for two locations (use a scratch installation; never real data).
- [ ] `npx wrangler d1 info <db>` shows the size. Compare with the local figure of about 374 bytes per visit.
- [ ] `npx wrangler d1 insights <db> --timePeriod 1d` lists rows read and written per query. Compare the daily totals with `npm run measure` (about 140,000 rows read and 1,100 written for a 200-student location).
- [ ] Cloudflare dashboard → D1 → Metrics shows no row-limit errors.

## 4. Backup and restore drill

- [ ] Settings → Back up now completes. Record time taken and size.
- [ ] Nightly backup runs at the configured local hour. Check `created_at` against the business time zone.
- [ ] Download, decrypt and restore into a new database (docs/operations.md). Row counts for students, visits, attendance_events and attendance_corrections match the source. Record the total time.
- [ ] Temporarily break the export token and confirm the failure alert arrives at `BACKUP_ALERT_URL`.

## 5. Physical iPad

Use a real iPad (Safari, current iPadOS) at the front desk for one session.

- [ ] Enrollment code works; the device stays enrolled after closing Safari and after a restart.
- [ ] Add to Home Screen, then run in full screen. Guided Access keeps the iPad in Presently.
- [ ] PIN keypad, search and check-in/out buttons are easy to hit; text is readable at arm's length.
- [ ] The kiosk locks after 5 minutes idle and when the Lock button is used.
- [ ] Airplane mode: the screen shows Offline within 20 seconds, and a check-in attempt reports "Not confirmed". After reconnecting, retrying the same action records exactly one event.
- [ ] Guardian phone numbers and emails never appear on the kiosk.

## 6. Handover

- [ ] Acceptance checklist in docs/installation.md is signed.
- [ ] Installer API token revoked in the customer account; local copies of configuration and key deleted.
