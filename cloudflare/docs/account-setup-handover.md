# Customer account setup and handover checklist

Current checkpoint, September 22, 2026: the developer Cloudflare account has R2 enabled and private test buckets. The feasibility D1 remains at schema 4 with zero students and visits. A separate owner-protected acceptance Worker runs schema 41 with labeled synthetic data. An isolated scheduled Worker-to-R2 backup, customer-side encrypted copy, and combined recovery decryption passed. Kumon-owned live alert delivery, independent customer-held key recovery, and production acceptance remain open.

This is a draft one-center, customer-owned installation checklist. The test resources belong to `ochengweb@gmail.com`, not Kumon. The owner-only Cloudflare Access policy and signed-token application access were tested; production staff identities, MFA policy, offboarding, and buyer recovery access still need customer validation. The acceptance Worker keeps automatic backups disabled outside isolated exercises.

See [live validation](live-validation.md) for the test-account inventory and [readiness](readiness-report.md) for current evidence limits. R2 is active in the developer account, but a private bucket and working test backup do not establish Kumon account ownership or an off-account recovery copy. Customer installation must create and verify its own R2, D1, Access, Queue, secrets, alert destination, and recovery custodians.

The earlier Google Cloud project `ocheng-kumon-feasibility` is optional legacy work. The selected default backup provider is R2, so Google OAuth is not required. Generated customer configurations keep `BACKUP_ENABLED=false` until destination, alert, recovery, and operating checks pass.

The Railway production database currently has no student or attendance records. It has one non-demo center, one owner, one session, and seven audit entries; see [the read-only count checkpoint](../review/customer-handover-package/railway-production-counts-2026-09-22.json). Repeat the counts under a write freeze before cutover, decide how to retain the Railway audits, provision named Cloudflare staff, and rehearse rollback. This checklist does not authorize billing changes or use with real student data. Use the [installation runbook](installation-runbook.md) and [CLI documentation](../README.md) for commands.

## Confirm the sale and installation boundary

- [ ] Identify the contracting franchise business, center, legal operator of the student records, initial staff count, and kiosk devices. One center per installation is the current product boundary. Multiple installations share any allowances of a common Cloudflare account.
- [ ] Identify the purchased version and included functions. The schema-41 acceptance release implements schedules, inquiries and tasks, interactions, directory filters, report summaries, attendance, and bulk import. The separate feasibility installation remains at schema 4, and no production cutover has occurred.
- [ ] Define a perpetual license to use the purchased features, permitted installations, source access, modification rights, and the right to appoint another maintainer. A perpetual software license is not a transfer of copyright unless an agreement explicitly assigns it.
- [ ] Confirm that licensed features have no required vendor license server, renewal, or maintenance subscription. Provider accounts, domain fees, account recovery, changing allowances, and future maintenance still require an owner.
- [ ] Define written acceptance and the separate terms for optional future features or maintenance. Setup support lasts 30 days from written acceptance. Define defect warranty, covered defects, severity, response expectations, exclusions, and unresolved in-window claims separately; an expiring setup-support window does not silently end a promised defect remedy.

## Account and credential custody

| Asset | Customer responsibility | Handover evidence |
| --- | --- | --- |
| Cloudflare account and D1 installation | Business-controlled administrators and recovery contacts; selected plan and shared usage reviewed. | Account identity, Worker/database identifiers, production address, recovery access, and responsible owner recorded. |
| Access and identity provider | Approve named staff, configure provider MFA, and retain owner recovery access. | Exact allow policy, issuer/audience, tested owner and ordinary staff sign-in, direct API denial, and offboarding drill. |
| Source and release package | Hold source, dependency licenses, build/deploy instructions, and migration history. | Version/revision, repository ownership, package integrity, and independent maintainer access. |
| Private R2 bucket | Buyer controls the bucket and account recovery, verifies public endpoints/domains are disabled, and reviews storage/operation allowances. | Account and bucket identity, private access checks, binding, retention settings, completed backup/download/restore, and responsible custodian. |
| Independent encrypted copy | Buyer keeps a complete copy outside the Cloudflare account and rehearses access without that account. | Destination, copy schedule, retention, named custodian, last successful copy and independent restore, and separately held key. |
| Legacy Google Cloud project and Drive, if selected | Buyer controls the OAuth client, consent configuration, Drive account/folder, and capacity. | Explicit `google-drive` provider, verified connection/token persistence, backup location, and account recovery. |
| Backup key | Hold the recovery key separately from backup files and application source. | Agreed protected custody, backup custodian, and successful decryption without supplier access. Never put the key into an ordinary handover checklist. |
| Domain and notifications | Own the chosen production address and incident/backup alert destination. | Renewal/contact owner, delivered alert test, and escalation contact. |

Use temporary, scoped installation access for the supplier. Do not exchange shared owner passwords. Keep account tokens, OAuth client secrets, recovery keys, enrollment tokens, and staff PINs out of source control, screenshots, public links, and ordinary support messages.

## Technical installation checks

1. Before a customer installation, confirm the actual buyer-owned Cloudflare account. The feasibility resources already recorded in [live validation](live-validation.md) belong to the test installation; do not assume they establish buyer-business custody. Record all proposed provider dependencies and any payment requirement before a billing change. A local build or pending account login is not a deployed installation.
2. Configure Access for exact permitted identities and verify the Worker’s signed-token checks. Add matching application staff roles. Adding a CRM staff member does not by itself approve that person in Access; removing a seat does not replace removing authentication permission. Test both layers during offboarding.
3. Enroll only center-managed kiosks with one-time owner-issued codes. Give each authorized operator an individual 8–12 digit PIN privately. Test device/PIN revocation and locking. Record which physical devices belong to which enrollment.
4. Confirm R2 activation in the actual buyer-owned account and bind the named private bucket as `BACKUP_BUCKET`. Keep public custom domains and `r2.dev` access disabled. Use the smallest supported D1 export token scope, record any account-wide database access, and hold the recovery key separately. Review R2 storage, operation, and retention settings. For an explicit legacy `google-drive` installation, complete its Google consent and refresh-token checks instead.
5. The feasibility queue producer/consumer and five-minute cron were previously deployed. On the customer installation, verify the selected destination, secrets, D1 export, queue processing, and alerts before explicitly enabling scheduled encrypted backups. New generated configurations set `BACKUP_ENABLED=false`. Measure actual CPU, queue operations, retries, export size, storage growth, and completion. All account workloads share applicable allowances; no free-cost or capacity guarantee has been established.
6. Run a live encrypted backup to the private R2 bucket, download the complete encrypted files, and restore into a separate buyer-controlled installation using the delivered package and separately held key. This R2 drill is still required. Passing local installer, worker, and recovery tests do not substitute for it. Compare identities, relationships, original observations/corrections, counts, retention coverage, and any unrecoverable interval. Also copy the complete encrypted backup outside the Cloudflare account and rehearse restoration without access to that account. Test D1 Time Travel independently; its recovery window is not a two-year record-retention policy.
7. Import only an authorized roster after reviewing field mappings, duplicates, rejected rows, sibling guardian references, and pickup authority. Preserve the receipt. Never use names alone to merge students or treat missing pickup authority as allowed.
8. Complete [readiness evidence](readiness-report.md), publish a measured supported workload with remaining exclusions, and deliver the installer and recovery runbooks. Rehearse an update with migrations and a recovery path; code rollback does not undo a schema migration.

A private R2 bucket in the same Cloudflare account does not provide an independent copy for account loss or account-wide deletion. The customer must accept and rehearse the separate copy process, including key custody, before claiming that recovery coverage. The release now includes a read-only `backup-copy` command that verifies and packages the exact encrypted SQL and recursive archive object set. The customer must still choose the independent storage location, schedule and monitor copies, retain the separate key, and rehearse account-loss restoration.

## Recovery handover facts

The independent CLI generates private keys without printing or replacing them, verifies every encrypted part, and publishes complete SQL plus a private manifest without replacing existing files. Wrong-key, missing/corrupt-part, bounded-read, existing-file, and `SIGINT`/`SIGTERM` cleanup tests pass. A forced kill or power loss can leave private staging and an exclusive recovery lock; inspect abandoned files before removing them or retrying.

Restore into a new isolated database, apply current migrations, and run the delivered access-reset SQL before opening access. The local D1 drill confirmed that old owner/staff JWTs, kiosk cookies, PINs, and unused enrollment codes stop working while attendance history and immutable records remain. Reapply the current approved allowlist and reconnect the selected backup destination deliberately. Verify the restored Worker binds to the intended private R2 bucket and does not unintentionally replace the independent backup copy. Resetting the database does not stop the previous deployment, revoke Cloudflare/provider access, or revoke Google tokens for a legacy Drive installation. Reconcile current revocations, holds, deletions, provider grants, and cutover separately. The full recovery caveats are in [live validation](live-validation.md#recovery-behavior-and-caveats).

## Center acceptance and data responsibilities

The center decides why student information is collected and who may use it. Record minimum fields, permitted staff, guardian-authority verification, device custody, retention/holds, authorized exports, incident contacts, and disposal procedures. Identify the supplier's permitted activities during setup or support, access duration, confidentiality duties, temporary-copy deletion, subprocessors/providers, and breach/incident notification responsibilities. Use the controller, processor, or service-provider terms appropriate to the jurisdiction and actual arrangement. Hosting in the buyer's account does not remove these responsibilities.

The center must approve and rehearse the [outage procedure](outage-procedure.md), including independently accessible necessary information. Encrypted backups are not an emergency presence or pickup roster. Obtain appropriate review of any unresolved requirement before operational acceptance.

Record written acceptance only after the agreed tests and center demonstrations. List unresolved items explicitly, their owners, and whether they prevent use. Record the support start/end dates and contact route; keep defect-warranty terms separate.

## Seal the draft delivery package

Generate the draft package only after the delivered release and customer configuration are final. Run both commands from that matching release directory:

```sh
npm run handover -- prepare --config /private/customer/wrangler.customer.json --out /private/customer/kumon-crm-handover
npm run handover -- verify --package /private/customer/kumon-crm-handover
```

The package is owner-only and release-bound. It contains no secret values or recovery key. Keep it in the customer's approved private channel, copy the acceptance template into a separate controlled record, and attach dated evidence and named approval for every gate. A valid draft package does not prove account ownership, backup delivery, restoration, center acceptance, or cutover. See [the customer-owned handover package procedure](customer-owned-handover-package.md).

## Remove supplier access and demonstrate independence

- [ ] Deliver the source/release, account inventory, configuration ownership record, dependency licenses, build/update instructions, migration history, operator guide, recovery runbook/CLI, and completed evidence reports.
- [ ] Verify that the buyer and another authorized maintainer can sign in, deploy, recover, and update using those materials without supplier credentials.
- [ ] Remove temporary supplier access to Cloudflare, identity policies, source, R2, independent-copy storage, legacy Google/Drive if used, alerts, and student records. Rotate installation credentials where appropriate; document any separately agreed, limited support access.
- [ ] Verify continued operation and scheduled backup after supplier access is removed. Revoke or reissue restored staff sessions and kiosk credentials during recovery, and reapply later revocations before reopening access.
- [ ] Record the handover date, buyer custodian, received artifacts, recovery-key custody confirmation, removed access, acceptance decision, and agreed follow-up items. Do not include secret values in that record.
