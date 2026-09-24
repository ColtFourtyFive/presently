# Import preview matching work

Preview now builds a normalized-name-to-student-code-set index once from the existing D1 name-match result. Each CSV row checks that index instead of scanning the returned students again. Keeping a set of codes preserves ambiguity when two existing students share a name, and excludes an exact code from being treated as a different student. Explicit create, update, and skip decisions retain their existing meaning.

Names use the same ASCII-only case folding in the Worker and SQLite's `lower()` expression index. Non-ASCII characters are preserved exactly. Stored `Élodie Smith` and incoming `ÉLODIE SMITH` therefore trigger same-name review, as do identical CJK names. Matching does not equate `É` with `é`, composed characters with their decomposed forms, or locale-specific letter variants. Full Unicode normalization and case folding are outside this implementation. Matching names always require a reviewed decision and never merge student records automatically.

Already-applied receipt rows also use a set during preview revalidation. This avoids rescanning their row numbers for every pending CSV row while preserving the original receipt list and ordering.

## Measured matching work

A local in-memory comparison used 500 CSV rows and 1,000 stored matches, with two existing codes per name. The prior and indexed algorithms produced identical decisions for every row.

| Work | Prior scan | Indexed lookup |
| --- | ---: | ---: |
| Existing candidate checks | 250,000 | 1,000 index additions |
| Per-CSV-row name lookups | Included in scans | 500 map lookups |
| Median matching time, 25 samples after warmup | 62.148 ms | 0.351 ms |

This is a synthetic JavaScript microbenchmark, not an HTTP latency or Cloudflare CPU measurement. Its stable result is the work reduction from O(rows × matched students) to O(rows + matched students); local elapsed times are environment-dependent. The allowed bounds remain 500 CSV rows and 1,000 matched students.

The preview SQL, database indexes, and data-access scope are unchanged. Preview still performs the same three batched roster lookups for codes, names, and guardian references, with its existing optional guardian-link lookup. In particular, this change does not reduce D1's work evaluating the name query.

## Regression checks

The import suite includes checks against actual local D1 for:

- Multiple existing students sharing a name, case normalization, explicit update/create/skip decisions, repeated-row receipts, and preserving the other student's identity.
- A full 500-row CSV with 1,000 existing same-name matches, plus the 1,001-match safety rejection without replacing the earlier preview or token.
- Identical accented and CJK names, ASCII case variants, explicit create/skip decisions, and the Unicode matching limitations above.
- An old commit finishing after revalidation changes a skipped row to a pending row. The old preview token cannot complete the new preview or clear its payload.
- Pending and review rows preventing completion and payload cleanup, plus rollback of student changes and completion if cleanup fails.

Existing tests continue to cover omitted fields, guardian authority/evidence, stale previews, authorization, resumable commits, and idempotent receipts.

Validation for this change passed all 26 import tests, TypeScript compilation, and the production build. Test fixtures use isolated workerd/D1 storage. No deployment or live database migration was performed.

## Commit completion

Each commit applies at most ten rows, decides completion, and clears completed payloads in one D1 batch transaction. Every step checks the accepted preview token and center. Completion and cleanup also require zero pending or review rows. A failed statement rolls back that batch, while earlier successful batches retain their receipts. No schema migration is required.
