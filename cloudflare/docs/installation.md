# Installation

One installation per franchise business, in the business's own Cloudflare account. An installation can hold several locations. Plan about 60–90 minutes for the first install.

## What the customer needs

| Item | Cost | Notes |
| --- | --- | --- |
| Cloudflare account | $0 | Workers Free, D1, R2 and Queues all run on the free plan at single-business volumes. |
| Payment method on file | $0 charged | Cloudflare requires a card to enable **R2** and **Zero Trust (Access)**, even on their free plans. Nothing is charged within the free allowances. |
| Custom domain | ~$12 per year | Recommended. The `workers.dev` address works but is not recommended for production. |

Free-plan limits that matter (checked September 2026; reconfirm before quoting): D1 databases up to 500 MB each, 5 million rows read and 100,000 rows written per day (enforced since September 1, 2026); Workers 100,000 requests and 10 ms CPU per request; Queues 10,000 operations per day; R2 10 GB; Access 50 users. A typical location uses about 3% of the daily read allowance and 1% of the write allowance (`npm run measure`) and about 7.5 MB of storage per year (`tests/storage.test.ts`).

## Roles in the installation

| Who | Signs in with | Reaches |
| --- | --- | --- |
| Owner (the franchisee, often the Kumon Instructor) | Cloudflare Access (email) | Every location, settings, staff, kiosks, backups, evidence report |
| Manager | Cloudflare Access | Assigned locations: roster, import, history, corrections, reviews, evidence report |
| Front desk | Kiosk PIN, and optionally Access | Assigned locations: check-in and check-out |
| Instructor role | Cloudflare Access | Assigned locations: live roster and student names only |
| Kiosk device | Enrollment code, then a staff PIN | The one location it was enrolled to |

Only people who sign in to the back office need a Cloudflare Access seat. Front-desk staff who only use the kiosk need a PIN, not a seat.

## Steps

1. **Account and access for the installer.** The customer creates the Cloudflare account, adds a payment method, and creates two API tokens for us:
   - a temporary installer token (Account: Workers Scripts Edit, D1 Edit, Workers R2 Storage Edit, Queues Edit, Account Settings Read; Zone: Workers Routes Edit if using a custom domain). It is revoked at handover.
   - the backup export token: **D1 Edit on this account only**. It stays with the Worker as `CF_D1_EXPORT_TOKEN`.
2. **Cloudflare Access.** In Zero Trust, create a team (e.g. `brightfutures.cloudflareaccess.com`), then a self-hosted application for the Presently hostname with the path `/*`, **excluding `/kiosk` and `/api/kiosk/*`** (the kiosk uses its own enrollment and PINs). Add a policy allowing the owner's and managers' emails, with a one-time PIN or the customer's identity provider. Copy the application's Audience (AUD) tag.
3. **Installation file.** Outside the repository, create `installation.json`:
   ```json
   {
     "accountId": "32-hex-character account id",
     "workerName": "presently-brightfutures",
     "ownerEmail": "owner@brightfutures.com",
     "accessTeamDomain": "brightfutures.cloudflareaccess.com",
     "accessAudience": "64-hex-character AUD tag",
     "customDomain": "attendance.brightfutures.com",
     "alertUrl": "https://optional-webhook.example/backup-alerts"
   }
   ```
4. **Dry run, then install.**
   ```sh
   npm ci
   npm test
   CLOUDFLARE_API_TOKEN=... npm run install:business -- --input installation.json
   CLOUDFLARE_API_TOKEN=... PRESENTLY_D1_EXPORT_TOKEN=... npm run install:business -- --input installation.json --execute
   ```
   The installer creates the D1 database, private R2 bucket and queue; writes the configuration to `../installations/<workerName>/`; applies migrations with the standard `wrangler d1 migrations apply --remote`; generates the recovery key and PIN pepper and uploads them as secrets; builds; and deploys a minified Worker with no source maps.
5. **Recovery key.** Hand `recovery.key` to the owner: their password manager plus one offline copy. Then delete it from the installer's machine. Without it no backup can be decrypted, and nobody (including us) can recover it.
6. **First sign-in.** The owner signs in. The first sign-in creates the business and a first location. The owner then sets the business name and time zone, renames the location, adds any other locations, adds staff with PINs, and enrolls the front-desk iPad (Settings → Kiosk devices → Enroll, then open `https://<host>/kiosk` on the iPad and enter the code within 10 minutes).
7. **Roster.** The owner imports their roster (CSV import) after handover, so we never see student records.

## Acceptance checklist

Complete with the owner and sign before the 30-day support window starts:

- [ ] Owner signs in through Access; a non-allowed email is refused.
- [ ] Each location exists with the right time zone.
- [ ] Each staff member who records attendance has an individual PIN; the kiosk unlocks with it and locks after inactivity.
- [ ] A test student is checked in and out on the iPad; the live roster updates; history shows the visit.
- [ ] A manager corrects a visit time with a reason; the original observation is still shown.
- [ ] An exceptional departure creates a review, which a manager resolves.
- [ ] The roster import template downloads; a sample file previews and imports.
- [ ] Settings → Backups shows a completed backup; the owner has downloaded and decrypted it once (docs/operations.md).
- [ ] The evidence report prints to PDF for each location.
- [ ] The owner has the outage procedure (docs/operations.md) printed at the front desk.
- [ ] The installer API token is revoked and temporary copies are deleted.
