# Budgeted monthly verification step

`reserveAndAdvanceBudgetedMonthlyVerification` composes one monthly verification step locally. It reserves a work envelope and control overhead, claims the reservation, advances the exact selected runner revision, settles authentic work usage, and records the observed control prefix. It has no public route, scheduler, automatic day opening, or automatic retry.

The target digest binds the run ID, verification ID, snapshot generation and commit token, graph digest, selected revision and phase, and caller-supplied policy version. The budget claim compares the stored work key, revision, envelope, and statement ceiling atomically. The runner checks the selected revision and phase before acquiring its lease and within the lease compare-and-swap.

A fresh reservation issues separate process-local dispatch and control grants, both bound to the database wrapper. Replays cannot issue either grant. The native invocation collector copies identities and consumes grants synchronously. Its private metrics create the control evidence; the terminal API cannot accept caller-supplied numeric observations. Serialized copies, cross-wrapper use, and reused evidence fail before SQL. Returned adapter receipts strip all grants.

The enclosing function counts reservation, claim, work, per-batch execution fences, work settlement, and one control terminal statement. The limit is 40 statements. Work may submit 26; the existing control sequence uses 13 and terminal accounting uses one. Database calls outside this function still need separate admission and accounting.

The frozen monthly reader combines active-session checks with bounded record retrieval. Per-step memoization reduces repeated reads of immutable snapshot records. The final write transaction still checks the generation, snapshot identity, runner revision, and lease. Caches never survive an advance.

## Durable control accounting

Schema 24 creates a pending control row atomically with every reservation. Pending rows block new reservations and day opening, including when the work itself has already settled. The owning attempt can claim, and already-executing attempts retain their settlement rights after another fault closes dispatch.

The terminal API consumes sealed evidence before its first await, then makes one `UPDATE … RETURNING` call. The receipt records the observed prefix and the versioned prepaid terminal allowance separately. Unknown prefix coverage, unsettled work, a known deficit, or saturation closes dispatch. Deficits increase the control pool charge; they never refund overhead or silently release work holds. Completed controls and their receipts are immutable.

A terminal call lost before commit leaves the pending gate in place. A call that commits but loses its reply leaves the immutable receipt and prepaid tail charge. The API makes no retry or status query. Restore preserves liabilities, counters, and receipts, rotates execution authority, and closes dispatch. Pre-24 attempts become `legacy_unresolved`; successful historical work settlement is not fabricated into healthy control evidence.

## Remaining accounting limits

The final statement cannot observe its own native cost before committing. Policy `archive-control-terminal-v1` therefore prepays a terminal bound of 64 reads, 16 writes, and one statement. Local healthy and fault-path measurements fit this bound. These are provisional local policy limits and require deployed validation before activation. The receipt does not claim the entire invocation was observed before commit.

An observed terminal cost above that bound returns `CONTROL_TERMINAL_TAIL_BOUND_EXCEEDED`. The already-committed receipt cannot include the subsequently observed excess, and this internal function cannot durably close dispatch without another prepaid action. A regression test records that limitation. Approval of a defensible terminal bound and independent containment remains a production prerequisite.

Entry, denial, replay, and lost-reservation response costs are not fully admitted. Replays and unconfirmed prepayment return unresolved accounting, with `prepaidControl: null`. Caller-supplied policy versions are bound to the selected work but are not an approved measured envelope catalog. UTC reconciliation, ledger retention, cleanup reserves, alerts, and complete account-wide headroom remain unfinished.

No authoritative R2 publication, archived retry authority, source eviction, or live activation follows from this implementation. See [the production tracker](../../docs/production-goal.md) and [the daily budget design](archive-daily-budget-design-review.md).
