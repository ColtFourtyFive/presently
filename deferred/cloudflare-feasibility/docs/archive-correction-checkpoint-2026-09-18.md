# Correction addendum checkpoint release checkpoint

Date: 2026-09-18

Status: locally validated schema-34 candidate, approved for promotion into the local release tree. No Cloudflare deployment, remote migration, live-data mutation, Railway change, R2 deletion, or source eviction was performed.

## Result

Schema 34 adds immutable correction checkpoints for deeply corrected archived visits. A checkpoint references the original monthly archive and contains the current visit state plus the exact ordered correction and audit evidence through one resulting version. It is eligible at addendum depth 12, is limited to 64 correction members, and becomes the preferred parent for later corrections after it is published and authenticated.

Existing monthly archives, correction addenda, and D1 correction rows remain immutable and readable. The implementation adds no D1 or R2 deletion path. Historical source eviction remains disabled.

Recovery treats the current recovery generation's availability rows as authority while preserving the original immutable publication generation. Parent-first reconciliation is required for monthly archives, addenda, and checkpoints. Stale replay handles, corrupt descriptors, missing or reordered members, substituted evidence, invalid transitions, and foreign checkpoint authority fail closed.

Backup inventory increases from 74 to 80 tables and pins checkpoint archive roots alongside monthly archives and correction addenda. Retention authority includes the exact checkpoint rows and rechecks monthly, addendum, checkpoint, and outbox availability before its final dry-run commit.

## Release inventory

- Schema-33 baseline: 302 release files, SHA-256 `4083b853131fd7d9b72f1df2a88a78dd87ffb834c71a395a517c4b5dccaccdf8`.
- Schema-34 candidate: 305 release files, SHA-256 `022a310c586a4ce4732cecb74535db7efe906270144b00deacf793a7cea21fa9`.
- Added release files: migration `0034`, the checkpoint worker, and the checkpoint test file.
- Changed release files: 18 expected checkpoint integrations and schema-version, backup-inventory, recovery, and retention assertions.
- Removed release files: none.
- Added documentation: `docs/archive-correction-checkpoint-plan.md` and this checkpoint record.

The schema-33 hash was reproduced from the promoted root with the same release fingerprint script before the candidate hash was calculated.

## Validation

- TypeScript: `npm run check` passed.
- Production bundle: `npm run build` passed.
- Full compatibility suite: 76 test files and 830 tests passed in 935.05 seconds.
- Migration coverage reaches schema 34 and verifies rollback/install behavior.
- A real 17th correction publishes through a depth-1 checkpoint.
- Backup inventory contains all 80 tables and pins checkpoint and addendum R2 roots.
- Parent-first restore, foreign-key, corruption, race, retry, and no-delete assertions passed.
- Wrangler 4.100.0 deployment dry run passed with a 538.09 KiB upload and 119.54 KiB gzip size.
- Promoted-root focused verification passed: 5 files and 68 tests covering checkpoints, addenda, backup, recovery, and retention.
- Promoted-root TypeScript, production build, Wrangler dry run, fingerprint, and candidate parity checks passed.

Evidence is stored in `review/schema-34-correction-checkpoint/` with individual SHA-256 values in `artifact-sha256.json`.

## Operational gate

This checkpoint authorizes local promotion only. Production deployment and remote migration remain separate release actions. Source eviction must stay disabled until recovery drills, capacity checks, backup/restore acceptance, and production acceptance gates pass.
