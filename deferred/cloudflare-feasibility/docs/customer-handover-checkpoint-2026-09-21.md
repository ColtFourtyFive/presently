# Customer handover package checkpoint

Updated September 22, 2026. This checkpoint records the tested way to prepare a private, release-bound delivery package for a customer-owned Cloudflare installation. It does not deploy, migrate, modify live data, enable backups, remove Railway, or grant production acceptance.

## Delivered

- `npm run handover -- prepare` creates an owner-only draft package from the reviewed customer configuration.
- The manifest records the exact application fingerprint, every migration hash, schema version, customer resource identifiers, configuration hash, required secret names, copied operating documents, and 14 acceptance gates.
- The acceptance template begins with every gate pending and includes explicit retention, recovery-point, recovery-time, support, evidence, and named-approval fields.
- No secret value or recovery key is copied into the package.
- `npm run handover -- verify` checks the matching release, migration inventory, content hashes and sizes, exact file inventory, file types, permissions, and pending acceptance state.
- `npm run handover -- verify-acceptance` checks a separate private completed record against the sealed package. It requires all 14 dated gates, supported retention and recovery decisions, distinct named customer and supplier signers, and consistent approval timing.
- The package includes the current eight-requirement Kumon baseline traceability matrix and its explicit certification gaps.
- The installation and account handover runbooks now include the prepare and verify sequence.

## Validation

Release `0.1.0` fingerprint `a3206c7ab0407ceaf0278c720c4843515b7050100cebbcee3b1ea0b143ba297a` includes 40 migrations and 333 release files. TypeScript, the production build, and the Wrangler 4.115.0 customer-config deployment dry run passed. The full serialized regression passed 880/880 tests across 87 files and 186 suites with no failures, skipped tests, or pending work. Schema 40 also passed conditional-roster polling, bounded student-detail, report visit-resolution, backup, and independent recovery checks. The 400-operating-day benchmark projects about 2.58 million D1 rows read per day at 30-second polling, including two complete 30-day exports. Real CLI exercises generated and verified a private draft with 14 pending gates and a separate synthetic completed record against the exact fingerprint.

The isolated archive and recovery rehearsal published and verified an 8,267-record month, checked all 25 retention candidates, captured all 96 tables and one archive reference, and independently restored exact counts. SQLite integrity returned `ok`, foreign-key checks returned zero violations, and compact archive reconciliation completed after the recovery reset. Source eviction remained blocked and no R2 object was deleted. This evidence does not replace live Worker-to-R2 delivery or a restore into a Kumon-controlled cloud installation.

Evidence is in [the handover review directory](../review/customer-handover-package/validation-summary.md).

## Acceptance boundary

The package consolidates local handover material and binds it to a specific release. It is not a digital signature, provider ownership proof, live recovery result, or customer approval. Record the returned manifest and completed-record hashes through the customer's approved channel. The completed-record verifier checks structure and binding only; provider and customer evidence must still be inspected before signing.

Production still requires live Worker-to-R2 backup delivery and alert evidence, a populated restore in an independent customer-controlled installation, deployed capacity measurements, physical iPad and outage exercises, pickup and exception workflow acceptance, staff training, Railway cutover and rollback validation, Kumon-owned account and recovery-key custody, and written customer acceptance.

A September 22 read-only audit confirmed the feasibility D1 database is still empty at schema 4, the R2 bucket remains private, and queue wiring exists. Only `BACKUP_KEY` is configured. `CF_EXPORT_API_TOKEN` and `BACKUP_ALERT_URL` are the immediate blockers to live backup activation; this checkpoint did not add them or change the deployment.
