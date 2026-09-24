# Customer-owned handover package

The handover command creates a private, release-bound draft for one customer-owned installation. It collects the documents an operator needs, records the exact source and migration hashes, identifies the intended Cloudflare resources, and creates a pending acceptance record. It does not contain secret values or a recovery key, contact Cloudflare, transfer an account, deploy code, or claim production acceptance.

Run it from the matching `cloudflare/` release directory after generating and reviewing the customer configuration:

```sh
npm run handover -- prepare \
  --config /private/customer/wrangler.customer.json \
  --out /private/customer/kumon-crm-handover

npm run handover -- verify \
  --package /private/customer/kumon-crm-handover

npm run handover -- verify-acceptance \
  --package /private/customer/kumon-crm-handover \
  --record /private/customer/completed-acceptance.json
```

The output directory and every file are owner-only. Preparation refuses to overwrite an existing directory. Keep the package private because it contains account, database, Access, owner, and backup-resource identifiers.

## Package contents

- `handover-manifest.json` pins the application version, complete release fingerprint, migration names and hashes, target resource identities, configuration hash, required secret names, document hashes, and every acceptance gate.
- `acceptance-record.template.json` starts with every gate pending. Copy it to a separate controlled record before adding evidence or signatures. Do not edit the sealed template.
- `README.md` states how to handle and verify the package.
- `release/` contains the exact source, migrations, lockfile, and tests named by the release fingerprint. It can be installed and built independently after `npm ci`; it contains no credentials or installed dependencies.
- `review/` contains the local evidence JSON files linked from the copied documents. The same references are present under `release/review/` so links in the source documentation also work. These files record tests and provider observations; they are not customer acceptance.
- `documents/` contains the installation, account ownership, baseline traceability, backup, recovery, outage, parity, readiness, and release-specific correction instructions used by this release.

The package verifier rejects changed or extra files, symlinks, public permissions, changed release or migration hashes, incomplete gates, and any sealed template that claims acceptance. The completed-record verifier requires the separate record to be private, bound to the same release and installation, and outside the sealed package. It requires all 14 gates in order, at least one dated evidence reference per gate, accepted retention and recovery targets, different named customer and supplier identities, consistent approval timestamps, and the customer's final decision. Both commands are structural checks. They do not contact providers or prove that a referenced exercise occurred.

Each completed gate uses evidence objects rather than free-form strings:

```json
{
  "reference": "customer-evidence/live-backup-delivery.json",
  "observedAt": "2026-09-20T17:00:00.000Z",
  "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

Use `null` for `sha256` only when the reference is a controlled provider record that cannot be exported. Keep the completed record and evidence private. The verifier records the completed record's SHA-256 so the signed result can be preserved through the customer's approved channel.

## Evidence required for acceptance

Every gate needs a dated reference and named approver in the completed customer record:

1. Kumon controls the Cloudflare account, billing, recovery administrators, domain, D1 database, Queue, and private R2 bucket.
2. Kumon controls the source repository and has the contract or license rights needed to own, maintain, and modify the product.
3. Staff Access policy, MFA, least privilege, owner recovery, revocation, and offboarding work with named identities.
4. Manual and scheduled Worker-to-R2 backups complete, failed-delivery alerts arrive, stale backups escalate, and backups remain private. Use the read-only `backup-copy` command to capture the exact encrypted SQL and recursive archive dependency set for independent custody.
5. A populated encrypted D1 backup and every referenced archive object restore into a separate customer-controlled installation using a separately held key.
6. Recovery-key generation, protected custody, backup custodian, rotation decision, and loss procedure are assigned without placing the key in this package.
7. The 90 to 120 day detailed D1 window, at least 730 days of evidence, holds, independent encrypted copy, and destruction rules are approved.
8. Deployed Worker CPU, D1 reads, writes and storage, Queue and R2 operations, concurrency, imports, exports, reports, and growth fit the selected plan with measured headroom.
9. Managed iPads pass normal, concurrent, stale-session, uncertain-response, restart, network-loss, and approved outage exercises.
10. Staff witness normal pickup, denied or unverified pickup, unmatched departure, correction, review, and escalation workflows.
11. Owners, managers, front-desk staff, instructors, and recovery custodians complete role-specific training.
12. Railway-to-Cloudflare reconciliation, write freeze, cutover, rollback trigger, rollback rehearsal, and Railway retirement decision are recorded. Railway stays available until this gate passes.
13. Incident, privacy, billing, domain, backup, recovery, maintenance, and application-support contacts and response expectations are recorded.
14. Named customer and supplier approvers sign the final decision, including any conditions and the accepted recovery point and recovery time.

## Custody and transfer

Transfer the source repository, release package, configuration, operational evidence, and completed acceptance record through the customer's approved channel. Transfer Cloudflare, domain, and billing control through the providers' account-management procedures. Exchange secret values only through the customer's secret manager or an equivalent protected method.

Store at least one complete encrypted backup outside the Cloudflare account. Keep its recovery key separately. The source package, encrypted backup, and key are three different assets with different custodians. Rehearse recovery without supplier access before final acceptance.

The authoritative installation sequence remains [installation-runbook.md](installation-runbook.md). Recovery details are in [combined-recovery.md](combined-recovery.md), outage work is in [outage-procedure.md](outage-procedure.md), and the current unresolved release gates are in [readiness-report.md](readiness-report.md).
