# Presently

Student check-in and check-out for Kumon centers. Presently is sold once and installed into the franchise business's own Cloudflare account, with one installation per business and any number of locations under one owner. It runs on Cloudflare Workers, D1, R2 and Queues, with a React client.

Presently is an independent product. It is not affiliated with, endorsed by, or sponsored by Kumon North America, Inc. or Kumon Institute of Education Co., Ltd.

## What it does

| Screen | Who | Purpose |
| --- | --- | --- |
| Kiosk (`/kiosk`) | Front-desk staff with a PIN | Shared iPad: find a student, check in, check out with a verified guardian, record an exceptional departure. Locks after 5 minutes. Never shows guardian contact details. |
| Who’s here now | All staff | Live roster for the selected location, student search, departures needing review |
| Roster | All staff; owners and managers edit | Students, guardians and pickup authority, visit history, manager corrections |
| CSV import | Owners, managers | Template, column mapping, preview, duplicate review, receipt |
| History | Owners, managers | Visits by date and student, correction trail, CSV export, daily summary, audit log |
| Evidence report | Owners, managers | The eight baseline requirements: software facts plus the center's own attestations, printable to PDF |
| Settings | Owner | Business, locations, staff and location assignments, kiosk enrollment, backups |

Roles: **owner** (all locations), **manager**, **front desk**, **instructor** (live roster and names only). Owners reach every location; everyone else reaches only the locations they are assigned to. Kiosks are bound to the location they were enrolled at.

## Design

- **Database.** One D1 database per installation, created by one migration (`migrations/0001_initial.sql`) that applies with the standard `wrangler d1 migrations apply`. Attendance observations, corrections, audit entries and attestations are append-only, enforced by 18 triggers. A visit costs about 374 bytes, so a typical location adds about 7.5 MB a year.
- **Correctness.** Each check-in carries a client-generated request ID. A retry after a lost reply returns the original result instead of recording twice. The screen never shows "saved" until the server confirms it.
- **Sign-in.** The back office uses Cloudflare Access. The kiosk uses device enrollment plus per-staff PINs, hashed with an HMAC keyed by a Worker secret and protected by lockouts.
- **Backups.** Nightly encrypted D1 exports to the customer's private R2 bucket, at the business's local backup hour. The owner holds the recovery key. See [docs/operations.md](docs/operations.md).
- **Packaging.** Customer deployments are minified with no source maps.

## Develop

Use Node.js 22.13 or later.

```sh
npm ci
npm run check          # TypeScript
npm test               # workerd + D1 tests, about 15 seconds
npm run preview:local  # http://127.0.0.1:8791 (back office) and /kiosk, temporary empty database
npm run measure        # projected daily D1 usage for one location against Free plan limits
```

## Install and operate

- [Installation](docs/installation.md): customer account, Access, installer, acceptance checklist.
- [Operations](docs/operations.md): backups, restore, outage procedure, updates, retention.
- [Deployed proof](docs/deployed-proof.md): the release gate on a real free-tier account and a physical iPad.
