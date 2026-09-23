# Prepaid archive entry accounting — design review

Design only, September 16, 2026. This note does not authorize a migration, scheduler, endpoint, automatic retry, account change, or activation. Schema24 sources and evidence remain unchanged.

## Finding and recommendation

Schema24 makes an accepted reservation's control liability durable. It does not fund every path that reaches D1 before that reservation exists. In particular, the initial receipt lookup, a rejected reservation, and a replay can consume resources without creating a fresh attempt or control row. A lost committed reserve response retains its work hold and pending control liability, but does not make later inspection free.

Use a **finite, prepaid entry tranche with one active entry owner**, followed by a separately enforced, bounded dispatcher. Each physical delivery consumes its own entry allowance before it can query D1. Retain the full allowance on every outcome; no refunds or automatic retry in the first implementation. A replay resolves status and never issues execution authority.

This recommendation is conditional: a D1 ticket table alone cannot bound the cost of reaching that table. Repeatedly querying an exhausted or already-used ticket still costs reads. A signed token proves authenticity, but does not limit its replay count. A single-use JavaScript object protects one process, not a restarted process or repeated network delivery. Activation needs a trusted mechanism that bounds deliveries **before D1 access**, including duplicates, rejected requests, restarts, and telemetry polling.

## The accounting boundary

The account policy must fund a finite bootstrap/administration allowance before provisioning a tranche. Tranche creation cannot retroactively pay for its own first statement. This is the same explicit policy boundary as a prepaid closing tail, not a claim of recursively complete observed accounting.

For each UTC day and policy version, permanently charge:

```text
tranche provisioning allowance
  + number of permitted physical deliveries × entry envelope
  + reserved resolution/stop allowances
```

The entry envelope covers the entry gate, receipt lookup/conflict handling, the entire reserve path through confirmed response, and its bounded denial/closing path. Cover a rolled-back or unobserved reserve batch at the full envelope. On a successful reservation, schema24 may also charge those statements within its control prefix. Keep that conservative overlap explicit; do not add a refund mechanism merely to eliminate it.

Native measurements must distinguish entry observations, attempt control observations, work, and prepaid closing tails, even when allowances overlap. Missing metadata never establishes zero cost. Measurements establish evidence for a versioned bound; an unbounded scan cannot be made safe by choosing a larger multiplier.

The external delivery bound is a separate requirement from SQL capacity, Worker CPU, request limits, R2 costs, and other applications sharing the account. No current source supplies that external guarantee. A Durable Object or other durable dispatcher is an option to evaluate, with its own storage, request, bootstrap, and failure costs; this note does not select or provision one.

## Minimum internal protocol

1. **Provision a finite tranche.** A separately funded, authenticated operation charges the whole tranche atomically. Bind it to account/installation scope, UTC day, budget epoch, execution generation, entry policy, supported source/schema, and a maximum delivery count. Retain immutable allocation provenance. It cannot increase an existing day's allocation or reuse an old balance after restore.
2. **Install an active prepaid owner before delivery.** Keep one active entry slot and a bounded number of queued slots. The matching owner may enter once; other owners remain blocked. A slot binds an exact request digest, operation namespace, purpose (`dispatch` or `resolve`), and the operation being resolved before it can authorize work. Request identity includes the target selection and all attempt/claim/work-settlement/control-settlement IDs. Queued slots carry no work authority. Selection must use a previous bounded receipt or a separately prepaid selection operation; no preliminary database discovery is exempt. The dispatcher's permit is opaque, copied, database-bound, and consumed synchronously before any await. Receipts and serialized permits are not capabilities.
3. **Enter once.** Validate size and syntax locally. Invalid input performs no D1 work; conservatively consume its permit. Missing or forged permits also perform no D1 work. The first native statement checks the durable owner and authoritative service/day fences, and marks entry claimed. A lost response grants no right to continue. The prepaid owner remains unresolved and stops the next dispatch.
4. **Separate inspection from execution.** A fresh accepted reserve can issue its existing one-shot dispatch/work/control grants. A reserve replay, operation conflict, stale selection, closed service, or pending control liability can only return a bounded status. No resolution branch can claim work or convert an old receipt into a new grant.
5. **Close the entry.** Healthy attempt control settlement should close the matching entry in the same native transaction, with a bounded trigger or explicitly fused update. A denial/replay has its own single-statement terminal record and fixed prepaid closing tail. Finalization records the exact immutable result and outcome without claiming the transaction measured its own cost. Only a confirmed terminal transition may advance the active owner to the next prepaid slot. Unknown outcomes retain the owner and prevent new work.
6. **Stop rather than retry.** Lost entry, reserve, or terminal replies end the invocation. A later investigation requires a separately prepaid resolution delivery. It may read the exact outcome but cannot reissue grants. Exhaustion, unexpected cost, missing coverage, or a broken tail assumption stops dispatch; an emergency close itself needs reserved cost and bounded authority.

The permanent pending owner bounds *further work*, not hostile repetition of its entry query. The external delivery gate remains necessary even after these SQL changes.

## The 40-statement contract

The current adapter permits 40 statements: reserve 4, claim 5, work at most 26, work settlement 4, and terminal control 1. Simply adding a preliminary entry statement would permit 41. Lowering the work cap is not sufficient if a supported semantic branch needs all 26.

The minimum viable integration should replace the reserve's existing first replay lookup with the entry claim/read statement. An indexed `UPDATE … RETURNING` can be investigated for returning the required receipt identity and status while consuming the owner. The remaining three reserve statements stay in the same invocation. Fuse healthy entry closure with the existing terminal control transaction. Denial and resolution paths have no work and can afford their own bounded terminal statement.

This is a design target, not verified SQL. Preserve the existing reserve API for historical tests if needed, but expose no activation path that bypasses entry permits. If the fused gate cannot meet the correctness and cost bounds, split the semantic step further or revise its protocol; do not raise 40 or quietly omit failed statements from the collector. Re-measure reserve, terminal trigger, and exceptional guardian branches after integration. Schema24's measured 64-read/16-write terminal policy cannot automatically be reused after adding entry updates.

## Minimum migration and API changes

A new forward migration would add immutable tranche allocation records, bounded entry slots, their terminal results, and a current owner reference. Indexed equality lookups must cover owner identity, operation ID, and unresolved state; costs must not grow with settled history. Enforce an operation namespace shared with existing budget receipts and control terminals. Reject replacement/deletion, allocation changes, invalid state transitions, and terminal-result mutation. Include the new tables in encrypted backup inventories and restore tests.

Add internal operations for bounded provisioning, opaque permit issuance/consumption, fused entry/reserve, denial/resolution terminal settlement, and effective runtime status. Caller-supplied metric totals or booleans cannot authorize an entry. Persist native lower bounds through trusted collectors. No scheduler, public control route, automatic reconciliation, day-reopen helper, or permit-reconstruction API is part of this minimum.

The migration must not infer that schema24 historical entry costs were covered. Preserve all historical money and receipts, and keep existing unresolved or sticky closures closed. Any adopted historical baseline requires a separate, explicit allocation policy.

## Day, maintenance, restart, and restore rules

- The database's UTC day, current epoch/generation, history readiness, and maintenance state fence work. A rejected gate still spends its entry allowance.
- An old-day permit must be stopped before its D1 call. A SQL date check prevents old work but cannot charge today's rejection read to yesterday. Activation therefore needs bounded execution lifetime plus a midnight stop/carry policy. Until established, unresolved or possibly in-flight entry owners block rollover; calendar change never refunds them.
- Maintenance denies fresh dispatch. Do not bypass maintenance to write an entry settlement or stop receipt. Preserve its full allowance and unresolved ownership when a write cannot complete.
- A restart cannot reconstruct a fresh delivery authority from a pending slot, receipt, serialized grant, or local clock. Without a proven durable delivery gate, the first internal prototype must stop on restart and burn its remaining delivery authority.
- Restore/access reset rotates execution generation and budget epoch, retains entry charges and terminal results, and revokes every old permit. Restored counters cannot establish current account headroom. No automatic reopening follows the reset.

## Required tests and acceptance evidence

Use native D1 for fresh entry, exact replay, changed-payload conflict, closed day, stale generation, pending control, maintenance, exhausted tranche, and every lost-response boundary. Prove that invalid/forged/copied/reused permits perform zero database calls; exercise restart and duplicate delivery against the proposed external gate rather than substituting an in-memory map for it.

Test competing owners, immutable results, namespace collisions, interrupted provisioning, reserve rollback, reserve commit with lost reply, lost terminal reply, unknown/overrun metrics, saturation, and preservation of work holds. A separately funded resolution must never advance proof or issue execution grants. Retain previous schema23/24 migration and recovery evidence.

Measure the complete adapter on every supported branch, including maximum guardian fan-out, with native query plans over substantial settled entry history. Verify the 40-statement ceiling, bounded denial/terminal costs, and no history scans. Test midnight and restoration without refunds or new authority. Finally, demonstrate a finite bound on actual pre-D1 deliveries and independently account for its bootstrap and operating costs. Until that last boundary is established, the internal protocol is useful preparation, not sufficient authorization to activate unattended archive work.
