# Budgeted archive integration checkpoint — September 16, 2026

The internal monthly verifier now has a bounded reserve/claim/advance/settle path. **Production release remains pending.** There is no public dispatch route or scheduler, and control-cost reconciliation remains incomplete. No live deployment, remote migration, source eviction, backup activation or paid upgrade occurred. Railway remains available.

The full local suite passed **465 tests across 45 files in 205.23 seconds**, with zero failures. TypeScript and the production build passed. Installer fingerprint `50df0ca990922ff3939a09496dc2b414cf30a242146331118e8381c64019e128` covers 227 files and was unchanged through validation. Schema remains **23**; no migration was added. The schema 23 migration, populated history preservation and backfill evidence remains unchanged.

## Verified behavior

A reservation binds the exact run and frozen snapshot, expected revision and phase, policy version, work envelope and statement limit. Fresh reservation and claim winners issue separate one-use process-local grants. Replay cannot issue another executor. The runner checks selection before its lease and in its lease transaction. Copied inputs, forged grants, changed retries, generation changes and lost responses are covered by native tests.

The wrapper counts every statement it submits for reservation, claim, work and settlement. Its 40-statement ceiling includes the collector's injected fences; work has a 27-statement limit, leaving 13 for ledger calls. Database work outside this function must be counted separately by its future caller. Paused and busy outcomes are reported explicitly and settle their observed usage. Returned receipts contain no execution capability.

Lookup batches and a per-step cache eliminate repeated requests for immutable records in the same frozen snapshot. The active session, generation, token and admission checks still run in SQL; the final write transaction checks current authority, revision and lease. Empty pages retain admission and size metadata. Tests cover cross-session isolation, missing records, malformed data behavior, indexed point/range queries and the guardian-linked exceptional-departure branch. That branch used **23 work statements**, or **36 including the surrounding ledger calls**, in its native fixture.

Fifteen new integration cases cover complete multi-phase verification, duplicate/conflicting requests, copied input, pause/busy handling, missing metadata, generation changes, responses lost after committed work, and settlement failures before and after commit. Twelve grant tests cover runtime authority and exact claim binding. Seven selection tests and four lookup tests cover the other new boundaries. Existing provenance and recovery tests remain in the integrated suite.

## Representative monthly measurement

Both frozen native workerd runs completed 16,860 direct verifier advances over the same representative encrypted month. They retained 5,125 operations, 2,550 visit totals and two review witnesses. Every returned statement supplied row metadata; no native batch failed.

| Verifier measurement | Before | After |
| --- | ---: | ---: |
| Submitted SQL statements | 291,149 | 188,481 |
| Native batches | 157,308 | 102,892 |
| Rows read | 2,665,504 | 2,558,450 |
| Rows written | 99,680 | 99,680 |
| Largest projected reserve/claim/work/settle statement count | 52 | 35 |
| Calls projected above 40 statements | 5,126 | 0 |

The last two rows add one collector fence per native work batch and 13 ledger statements. They are arithmetic over a direct-runner measurement; the entire monthly budgeted adapter was not executed in this benchmark. The smaller native integration fixture verifies actual combined calls. Neither proves all future data shapes, deployed CPU, provider charges or account-wide quota safety.

The optimized fixture used about 35% fewer SQL statements and 4% fewer row reads, with unchanged writes. This does not establish lower cost for every query. A generic 64-record page measured 199 reads after bounded materialization; a four-record relation query measured 20 versus 13 for the former guard-and-record pair. Page queries remain bounded and indexed. The aggregate month measurement is the relevant sample comparison.

The [optimized measurement](../tmp/budget-runner24/2026-09-16T22-32-55.712Z-2e4974de/measurement.json) and [baseline](../tmp/budget-runner24/2026-09-16T22-16-05.111Z-be2ec81d/measurement.json) preserve source hashes, runtime bundles, per-step counts and SQL shapes. The optimized bundle SHA256 is `fe77a76859990a272461f2cf2b59175979360c9f1f5b685b98968b1d3c42bc3b`. The finalizer rebuilt it from current source and verified the match. See [checkpoint evidence](../tmp/budget-runner-checkpoint-evidence-20260916.json) for artifact hashes; historical schema 19–23 evidence was reverified unchanged.

## Remaining activation work

Control overhead is still caller-declared policy. The adapter meters actual control costs and reports unknown or excessive costs as unresolved, but it does not yet persist a separate control liability or durably close/reconcile the ledger after every control fault. Replayed or rejected entry requests can consume SQL without new prepayment. These gaps block public or scheduled activation.

The next work is durable terminal control accounting with its own prepaid statement allowance, approved measured envelopes, bounded entry/rejection costs, UTC liability reconciliation and ledger/diagnostic retention. Full monthly adapter costs and deployed limits still need measurement. Publication, authoritative R2 lookup and independent recovery without source rows must pass before eviction is enabled.

Live Worker-to-R2 backups, independent populated cloud restoration, customer ownership/key custody, physical iPad/outage/staff acceptance and the remaining operational gates are still open. The last verified Cloudflare installation is empty on schema 1–4; automatic backups remain disabled and export-credential approval remains pending. See [the production tracker](../../docs/production-goal.md) and [module contract](archive-budget-runner.md).
