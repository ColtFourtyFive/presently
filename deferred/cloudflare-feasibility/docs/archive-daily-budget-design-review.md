# Daily archive budget design review

Design only, September 16, 2026. No scheduler, budget ledger, remote configuration, publication, or source eviction is enabled by this document. Schema 22 product code and evidence remain unchanged.

The next bounded implementation should provide internal reservation, execution fencing, settlement, and rollover primitives with adversarial tests. Scheduling activation needs a later review after deployed cost and account headroom are established. A `daily_budget` lifecycle pause is already available, but it does not reserve any D1 allowance.

## Measured starting point

The [schema 22 native local measurement](../tmp/native-month-d1-usage22/measurement.json) authenticated and verified 14,295 source records in 56 parts, then removed the private staging evidence. It completed 16,860 runner advances and 350 cleanup calls. All 296,789 statement results supplied row metrics; no batches failed.

| Measured phase | Rows read | Rows written | Statements |
| --- | ---: | ---: | ---: |
| Part authentication and staging | 260,054 | 57,404 | 336 |
| Runner advances | 2,665,504 | 99,680 | 291,149 |
| Cleanup pages | 246,984 | 22,733 | 5,250 |
| Other lifecycle operations and validation reads | 7,981 | 18 | 54 |
| Total | 3,180,523 | 179,835 | 296,789 |

The other operations include session creation, manifest registration, freezing, runner creation, verification reads, invalidation, cleanup claim, terminal receipt replay, and post-cleanup checks. The measurement does not include source generation, migration, a budget ledger, scheduling, publication, normal attendance, backups, account telemetry collection, or concurrent account workloads. The reported 55.934 seconds is local orchestration time, not deployed Worker CPU time or a production latency target.

The existing documented Free-plan planning baseline is 100,000 D1 rows written per day. Even under that full allowance, this one observed lifecycle cannot fit in one day. This is not a two-day completion promise. Headroom, reservations, retries, and deployment overhead can require more days. Confirm the actual target account's plan, allowance scope, and reset behavior before activation; this design makes no claim about its current usage and authorizes no paid upgrade.

Phase totals and averages are insufficient reservation bounds. Native row metrics include trigger and index effects that do not equal inserted source records or a cleanup page's `deleted` count. The observed maximum of 26 statements per runner advance does not establish worst-case rows, CPU, or the cost of future budget checks. The existing runner has a 40-statement ceiling. This design deliberately proposes the stricter target of 40 statements for the whole dispatch invocation, including its caller and budget overhead. That broader contract is not implemented today; it must be measured and enforced rather than assuming the current runner leaves enough room.

## Cost and account allocation contract

Represent cost as a vector. At minimum it includes D1 rows read and rows written. Track statement count, Worker CPU and invocation limits, R2 operations and bytes, and database size separately because spare write allowance cannot compensate for any of those limits.

Each supported step class needs a versioned upper-bound cost envelope. Classes include admission and selection, manifest registration, each bounded part, freeze, runner creation, every runner phase and branch, pause/resume/renewal/expiry, cleanup claim, each cleanup phase, terminal replay, budget reconciliation, and future publication pages. Bind an envelope to the source build, schema, query plan, supported input limits, and relevant state-size bounds. A code, index, trigger, or format change invalidates affected envelopes until checked again.

Use indexed lookup and bounded page contracts to justify the envelopes, then test their limits. A measured maximum plus an arbitrary multiplier is not a proof that an unbounded query is safe. A step whose conservative envelope exceeds the available allocation must be split or deferred before execution. Never start it hoping settlement will make the total fit.

An account coordinator must allocate explicit daily slices to each installation/database if they share a D1 account allowance. With one installation, the same policy can be managed locally, but unrelated account activity still requires a protected allocation. Two independent databases must not each treat the full account quota as available. Local D1 transactions cannot atomically coordinate account spending across those databases.

For each resource and UTC day, divide the account allowance into ordinary application allocations, background archive allocations, and an uncertainty margin. Attendance, imports, reports, backups, restore work, other databases, and other applications belong in that calculation. Prefer conservative allocations that all participating workloads enforce. Fresh provider usage may reduce an allocation or close dispatch; delayed telemetry must never increase it merely because recent usage has not appeared yet.

If another workload has no enforceable upper bound, an archive ledger alone cannot guarantee the account stays under its limit. Require an agreed cap or sufficiently conservative, validated headroom and disclose that residual account risk in the activation review. Unknown usage is not zero. Do not combine a provider total with local charges by blindly adding them, which can count the same work twice, or by subtracting them without a known observation cutoff, which can miss work.

Within a background slice, keep separate capacity for control operations, cleanup, and new verification/publication work. The conservation rule is componentwise:

```text
settled charges + unresolved attempt envelopes + protected unused allowances
    <= allocated background slice for this account day
```

A cleanup or control reservation converts part of its protected allowance into an outstanding attempt; it is not counted twice. Normal verification cannot consume protected cleanup or control capacity. If a bound is exceeded in execution, record the measured overrun conservatively and close normal dispatch. An overrun is a broken activation assumption, not permission to borrow attendance capacity silently.

## Proposed durable records

Use a forward migration when implementing this design. Do not retrofit new meanings onto schema 22 diagnostic receipts.

| Record | Required authority and contents |
| --- | --- |
| Budget epoch | Account/installation scope, current execution generation, policy and envelope versions, activation state, allocation provenance, last acceptable account observation and its cutoff. Closed until explicitly reconciled. |
| Day allocation | UTC day, epoch, resource limits, settled totals, outstanding totals, control and cleanup allocations, revision. All admission arithmetic occurs atomically on the primary database. |
| Work attempt | Unique attempt ID, exact request hash, work kind, original session/run identity, expected work revision, execution generation, budget epoch, permitted day or days, envelope, attempt token, state, timestamps, and receipt/settlement hashes. |
| Settlement evidence | Exact statement-result coverage, measured resource totals, missing-metadata or failure reason, durable work-receipt identity, conservative charge, and immutable settlement identity. No student payloads or raw capabilities. |

The ledger survives ordinary staging cleanup. It cannot depend on a foreign key to a disposable session row. Store bounded operational metadata and hashes; retention, safe compaction, and their costs require a separate policy. Existing diagnostics remain immutable with no automatic pruning.

## Reservation and one-step execution

1. A bounded dispatch tick enters through its prepaid control allowance. Confirm maintenance state, account observation freshness, budget epoch, current history generation, UTC day, policy version, and the work's exact identity. Selection and rejected attempts consume resources too. Bound tick frequency, concurrency, reads, and denial handling before exposing a scheduler; unlimited denied requests cannot be made free by an SQL guard.
2. Read only the bounded state needed to select a supported step envelope. In one primary D1 transaction, reserve the full work envelope and fixed control overhead, compare the day revision and remaining allocation, and create the exact attempt. Duplicate attempt IDs with an identical request return the existing attempt; changed payloads conflict. A lost response does not authorize a second reservation or a second executor.
3. Consume the attempt once with an atomic `reserved -> executing` transition and issue one fenced attempt token. Recheck the current budget epoch, generation, day authorization, target revision, and work lease. Bind every mutating work transaction to that authority. A dispatcher-side check alone is insufficient because a delayed worker can outlive it. Existing runner and cleanup leases continue to fence proof changes independently.
4. Execute one bounded step. The envelope must cover all SQL and reads that can occur along success, stale-claim, error, and lease-release paths, plus hashing/decryption and R2 access where relevant. A bounded wrapper must refuse to prepare additional statements once the remaining invocation allowance cannot cover completion or failure handling. Include authorization, selection, reservation, settlement, lifecycle, and error handling when checking the 40-statement contract; the current observed 26 leaves no guaranteed fixed allowance for them.
5. Collect every native D1 result's `rows_read` and `rows_written`, including triggers and reads, and record exact statement coverage. Once all submitted D1 statements and awaited work are known complete, settle in a guarded transaction against the same attempt and envelope. Require its durable work result where a mutation occurred, atomically transition `executing -> settled`, revoke the attempt token, and record the settlement before releasing any unused envelope. Every work transaction must require the attempt still be executing. No unawaited work may remain after settlement. Complete known usage may release the unused work envelope. The receipt and settlement identity make a lost settlement response safely replayable without a second refund.
6. Persist control-path overhead as a conservative fixed charge, including the final settlement transaction itself. That transaction's own cost is not visible before it commits. Never refund this fixed overhead based only on metadata that omits its final write. Meter additional recovery/replay reads against the protected control allowance.

The implementation must account for both committed and unsuccessful execution costs. A rolled-back business mutation can still consume reads, CPU, statements, or provider work. Do not infer zero cost from `changes()=0`, an exception, no visible rows, or a failed D1 batch. If the API cannot return complete costs for a branch, retain that branch's entire envelope. Provider behavior for failed batches and rollback is a measurement gate.

Single-resident staging admission does not replace budget concurrency control. Duplicate cron delivery, cleanup workers, resumptions, and future publication workers can race over the same budget. All use atomic conditional allocation on one authority. Work leases decide which attempt may change proof state; budget reservations decide which attempts may spend. A losing attempt still pays its measured or conservatively held cost.

## Crash, retry, and uncertain outcomes

| Interruption | Required accounting and retry behavior |
| --- | --- |
| Reservation response lost | Resolve the same attempt ID and exact request. Do not create an extra executor from a replayed reservation. |
| Executor crashes before a durable work result | Retain the whole envelope as uncertain. Lease expiry alone never refunds it. |
| Work commits but response or metadata is lost | Preserve its envelope. Recover the work checkpoint or sealed receipt, but do not confuse proof of a committed effect with proof of its billing cost. |
| Settlement commits but response is lost | Replay the exact settlement receipt. No second decrement of outstanding cost and no second refund. |
| Retry needs actual work | First resolve current target state. Allocate a new attempt and envelope; do not reuse the uncertain attempt's money or stale target revision. |
| Missing, invalid, or partial metrics | Charge the complete envelope, stop further work if envelope coverage is uncertain, and retain a bounded diagnostic. |

Conservative unresolved charges can be moved from `held` to `charged_unknown` without changing available allowance. A lease timeout is evidence that takeover is allowed, not that the earlier attempt spent nothing. Release an unstarted reservation only if a transaction revokes its ability to start and the protocol proves no executor consumed it. Otherwise burn it. Account reconciliation may later resolve uncertainty only with trustworthy coverage and proof that no old work can still execute.

## UTC rollover and delayed work

Use authoritative database time for day assignment, rather than browser time or a worker's cached clock. Confirm the provider's actual reset boundary. Store explicit UTC day identities and retain old day records; never reset a shared counter in place.

A reservation's creation date does not determine the provider's billing date. A request reserved just before midnight can execute after midnight or span the boundary. Stop issuing ordinary work within a conservative midnight guard window, but do not treat that window as sufficient proof. Its size requires a supported maximum execution lifetime, D1 completion/cancellation behavior, and deployed latency evidence.

Before opening a new day, atomically install its allocation and carry forward the full envelopes of work that could still execute in that day. At a boundary, conservatively charge such work to both possible days until its execution interval is established. An attempt authorized only for yesterday cannot start today. Every work transaction must recheck its permitted day and budget epoch. Replaying yesterday's receipt consumes today's control allowance but does not restore yesterday's unused allocation.

If no finite lifetime or reliable completion evidence can rule out an old executor, keep carrying its liability or keep dispatch closed. Do not release it merely because the calendar changed. Test a crash before midnight, a delayed claim after midnight, an in-flight multi-batch step, a delayed settlement, overlapping day-open attempts, and clock-boundary behavior. Account usage telemetry must have a known cutoff before it can reconcile these charges.

## Cleanup and lifecycle integration

Reserve cleanup capacity before admitting a session or increasing its cleanup liability. The observed 22,733 cleanup writes and 246,984 reads are a useful sizing input for this fixture, not a universal teardown envelope. Include all dependent proof tables, lifecycle updates, claim and completion diagnostics, retained metadata, indexes, retries, and takeover costs. The 64-entry page limit bounds proof entries removed; it does not bound billed rows by itself.

Prefer enough protected capacity to remove the complete supported resident session. If measured maximum teardown cannot fit in a safe daily allocation, define a multi-day drain policy with a protected daily tranche and explicit completion objective before admission. Future normal verification cannot spend that tranche. Unknown cleanup costs or insufficient account capacity close new admission; they do not authorize an unbudgeted cleanup loop. If account quota is already exhausted, even a protected local ledger cannot make D1 writes succeed, which is why ordinary-work and account headroom matter.

The existing cleanup token has a 30-second lease. After a budget pause, obtain fresh authority if that lease expired; never extend or refund a budget attempt solely because a work lease changed. Only final session removal frees the resident slot. Cleanup must continue to preserve live source data, permanent request ownership, published metadata, and R2 objects.

For staging or frozen work, record `daily_budget` pause with a stable operation ID before the protected control allowance runs out and after a live runner lease is released or expires. Choose `nextEligibleAt` no later than the effective renewal cutoff. Do not resume merely because that timestamp arrived: establish the current day's allocation, account headroom, capacity and maintenance eligibility first, then explicitly resume. SQL eligibility prevents early resume. Claims, retries, and pauses must not fabricate progress.

Pause/resume and selection themselves consume the control allowance. Avoid repeated pause diagnostics or repeated no-op ticks while a job waits. Maintenance blocks lifecycle writes, so planned maintenance must record a pause before locking. An unexpected lock leaves work stopped and reservations held; it does not justify bypassing the maintenance guard to write a pause or settlement.

The current renewal helper requires an actor ID and bounded reason code. Operational policy must also establish the responsible authorized owner; a syntactically valid actor ID alone does not establish that authority. Renewal extends the deadline by at most the existing 14-day rule and does not refresh idle progress. Do not create an automatic renewal loop to hide insufficient capacity. Verified evidence cannot be paused or renewed and has its fixed first-verification deadline. Before completing verification for a publication workflow, prove that the next bounded publication sequence and required cleanup can finish within its available deadline under reserved capacity. Otherwise remain in a pausable earlier phase or explicitly expire and clean up; do not add an undeclared publication hold.

## Publication and restore fences

The [publication design](archive-publication-design-review.md) remains separate. Its R2 readback, locator pages, permanent ownership reconciliation, final publication transaction, and receipt resolution need their own measured envelopes. A budget reservation authorizes resource consumption only. It never turns a staging snapshot into published authority, makes a pending locator visible, or authorizes source eviction. Leave publication scheduling disabled until its proof, exact receipt resolution, and independent restoration gates pass.

Include budget tables and allocation provenance in backup inventory, but restored counters cannot establish current account allowance. Restoring yesterday's SQL can lose spending that the provider already counted today. Restoring an older `remaining` value or resetting it to zero spent would create false capacity.

During restoration or access reset, close dispatch, rotate the execution generation and a separate budget epoch, revoke old execution capabilities, and preserve prior attempts and diagnostics as historical evidence. Reconcile unresolved spending and any old executors against fresh account information and the chosen allocation policy before opening a new epoch. If that cannot be proved, keep normal dispatch closed, including after UTC rollover until old execution liability is bounded. Recovery and cleanup need an explicitly allocated recovery/control budget; they are not exempt from account limits.

Ledger settlement after a restore must not reopen the old epoch or credit the new one. A generation change between reservation, work, and settlement fails closed. Retained old attempts can be reconciled through a distinct current-epoch recovery operation while their original identities remain unchanged. Existing schema 22 reset behavior clears active session controls and leases, preserves original evidence/history, and requires cleanup with new authority; the budget design must respect that boundary.

## Activation gates

The internal implementation may be built and tested locally before these gates are satisfied. Unattended dispatch stays disabled until the activation review has evidence for all of them:

1. **Bounded costs.** Measure every step class and failure branch on native D1, including budget overhead. Cover the 20,000-record/16 MiB profile, long attendance-derived identifiers, maximum derived rows, retained diagnostics and ledger growth, fragmentation, unrelated retained data, and concurrent ordinary writes. Query plans must support the claimed read bounds. Unknown or unsupported profiles fail before dispatch.
2. **Deployed limits.** Validate actual D1/provider row accounting, failed-batch behavior, Worker CPU, statement limits, R2 costs, maximum execution lifetime and midnight behavior. Exercise cryptography, part decoding, and worst-case runner/publication branches. Local orchestration duration supplies none of these guarantees.
3. **Account allocation.** Confirm plan limits, quota scope, UTC reset, usable observation cutoff/lag, participating databases, ordinary workload allocations, and who owns policy changes. Missing account usage or an unbounded competing workload cannot be silently replaced with a guessed balance. No paid upgrade is implied.
4. **Accounting races.** Prove atomic oversubscription rejection, exact duplicate replay, changed-payload conflict, one executor per attempt, partial/failed metadata handling, lost responses at each boundary, conservative uncertainty, idempotent refunds, retry charges, and no cost-free denial loop. Check the full invocation statement ceiling after integration.
5. **Rollover and recovery.** Prove carry-forward liability, delayed and overlapping day-open operations, maintenance spanning eligibility, generation rotation during each asynchronous boundary, restoration of stale counters, old capability rejection, and recovery with exhausted or unknown allowance. A restored database must never mint new spending authority.
6. **Drain and deadlines.** Demonstrate reserved cleanup of the maximum supported resident, retries and takeover, a multi-day verification pause/resume, renewal cutoff handling, and publication admission under the verified deadline. Define what happens when ordinary account traffic consumes the remaining provider quota.
7. **Operations.** Provide an immediate dispatch stop, bounded reconciliation, deduplicated actionable alerts, visible remaining/held/unknown balances, and an explicit ledger/diagnostic retention policy. Include their costs. Do not enable a public control route or reuse an existing backup schedule as an implicit activation step.

The first implementation checkpoint should finish the ledger primitives and these local race tests without adding a scheduler. The later activation decision must name the approved account allocation, supported envelope versions, cleanup policy, and remaining measured limits. Publication and production release still require their own acceptance evidence.

Schema 23 implements internal ledger and local race tests; see [the ledger module](archive-budget-ledger.md). Archive dispatch and scheduling remain unwired. The activation requirements above remain open.
