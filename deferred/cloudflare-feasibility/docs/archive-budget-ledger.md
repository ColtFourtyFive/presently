# Internal archive budget ledger

Schema 23 introduced the work budget ledger. Schema 24 adds durable control-prefix accounting and an internal monthly-step adapter. The system starts closed and has no public route, scheduler, or automatic activation. It does not establish a Free-plan guarantee.

Each UTC day has one immutable allocation with a scope, policy version, envelope version, allocation digest, operator and reason. Work, cleanup and control have separate balances. Changing the execution epoch cannot create another allocation for the same day. This installation does not coordinate competing databases or other account traffic.

Reservations atomically hold a declared read/write envelope and charge a declared control overhead. Claiming changes one reservation to executing. Only the fresh winning claim receives an in-process execution grant; retrying the claim returns its stored receipt without another grant. A lost claim response therefore leaves a held reservation. It does not authorize a second execution.

The usage collector consumes the grant once. It exposes wrapped statements and batch execution, keeps the transport and grant in JavaScript private fields, and inserts the current database fence into every atomic work batch. The fence checks day, epoch, execution generation, attempt, token, ready state and maintenance. A stale fence aborts the entire batch. The 2–40 statement ceiling includes these guards.

Usage evidence comes from native D1 statement metadata. It is process-bound and cannot be recreated from JSON. Settlement checks its complete execution identity and envelope against the executing reservation. Complete observations charge actual reads and writes, releasing unused holds. Missing or invalid metadata and transport failures charge each component at the larger of the reserved envelope or its observed lower bound, then close dispatch. An observed overrun also closes dispatch and preserves its cost.

Already executing attempts in the same epoch, generation and day may record terminal costs after another attempt closes dispatch. New claims and work remain fenced out. Unsafe aggregate totals saturate explicitly at `Number.MAX_SAFE_INTEGER`, set `accounting_saturated`, and remain lower bounds. Valid per-attempt observations are preserved. Closure is sticky, and this version has no reconciliation or reopening procedure for uncertain, overrun, saturated or restored balances.

An independent restore preserves allocation, pool, attempt and receipt rows. The access-reset generation change rotates the budget epoch and closes it as `restore_unreconciled`. It does not refund or reset copied balances. Operators must separately stop source executors: resetting a destination cannot revoke access to its source database.

## Control liabilities

Pending control rows block all new reservations and day opening, even after the corresponding work settles. The owning pending attempt can claim. An invocation collector records actual native control metadata in private state and seals one-use evidence bound to its wrapper. Terminal accounting uses one guarded update, records the observed prefix and prepaid terminal tail separately, charges known deficits, and closes on uncertainty, overrun, or saturation. It retains work holds when work settlement remains unresolved.

Pre-24 attempts become `legacy_unresolved` without fabricated coverage or refunds. Encrypted recovery preserves these rows and their immutable receipts. `readArchiveBudgetRuntime` reports effective dispatch blocking and a pending owner in addition to the raw state.

The terminal tail is a provisional trusted bound of 64 reads, 16 writes, and one statement. Its own eventual cost is not observable before commit. An observed breach stops the local adapter but cannot retroactively alter its committed receipt. Deployed policy validation and dispatcher containment are still required. See [the runner contract](archive-budget-runner.md).

## Activation gates

The successful reservation overhead is supplied policy data, not automatic accounting of every ledger call. Replays, rejected calls, failed batches, opening, claiming and terminal settlement all have database costs. Entry overhead must be prepaid and bounded before any dispatcher is activated; failed native batches may not return usable cost metadata.

Actual archive work must use the collector throughout, with measured envelopes and a full invocation statement limit. UTC-boundary liability, delayed completion, exhausted cleanup reserves, retention/compaction of budget and diagnostic rows, account headroom, alerts, and deployed CPU/D1/R2 measurements remain open. A day with unresolved reserved, executing or unknown attempts cannot roll over in these primitives.

See [the budget design review](archive-daily-budget-design-review.md) and the schema 23 checkpoint for validation evidence. Local workerd row metrics describe that runtime; they do not prove deployed billing or production CPU.
