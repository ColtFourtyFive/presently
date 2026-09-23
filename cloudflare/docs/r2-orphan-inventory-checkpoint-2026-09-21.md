# R2 orphan inventory release checkpoint

Date: 2026-09-21

Status: locally validated and promoted as schema 35. No Cloudflare deployment, remote migration, live-data mutation, Railway change, R2 deletion, or D1 source eviction was performed.

Schema 35 adds a reference-aware inventory for the private R2 bucket. It captures every known monthly archive, publication, correction addendum, correction checkpoint, semantic staging, and R2 backup reference before listing objects. It repeats the reference capture after the R2 listing and stops if the history generation changes, so concurrent publication or recovery cannot produce cleanup authority from a stale view.

Unknown namespaces and malformed archive or backup keys remain protected. An object can become a cleanup candidate only after it is old enough and is observed with the same key, version, ETag, size, and upload time in two runs separated by the configured interval. The resulting evidence is an immutable dry-run plan. SQL constraints, Worker code, and tests keep deletion disabled.

Management roles may read inventory status. Only owners may start or advance a run, and start or resume requests produce an audit entry. The scheduled Worker advances an existing run but never starts one automatically.

## Release inventory

- Schema-34 baseline: 305 release files, SHA-256 `022a310c586a4ce4732cecb74535db7efe906270144b00deacf793a7cea21fa9`.
- Schema-35 release: 308 release files, SHA-256 `efc66d6806e5a6321021c40824da0e05c636fba6decb24d97c03047a603adc04`.
- Added release files: migration `0035`, the R2 inventory worker, and the R2 inventory test file.
- Removed release files: none.
- Backup inventory increases from 80 to 86 protected tables.
- The native migration test proves complete install and rollback of a deliberately failed late migration.
- Full validation passed: 77 test files and 837 tests.
- Promoted-root focused validation passed: 3 test files and 48 tests covering the inventory, backup, and independent recovery paths.
- Candidate and promoted-root TypeScript, production build, Wrangler 4.100.0 dry run, release fingerprint, and file parity checks passed.
- The dry run packaged a 567.72 KiB Worker/assets upload, 125.58 KiB compressed.

Evidence is stored in `review/schema-35-r2-orphan-inventory/` with individual SHA-256 values in `artifact-sha256.json`.

## Operational gate

This checkpoint authorizes local release-tree promotion only. An owner must explicitly start an inventory after schema 35 is deployed. The resulting classifications and dry-run plans still require live review. R2 deletion and D1 source eviction remain disabled until independent cloud recovery, capacity, retention, legal-hold, and operational acceptance gates pass.
