import { takeArchiveBudgetControlUsage } from './archive-budget-control-usage';
import type { ArchiveBudgetReceipt } from './archive-budget-ledger';
import type { ArchiveStagingDatabase, ArchiveStagingStatement } from './archive-semantic-store';
import { digest } from './backup-crypto';

/** One terminal native statement. Its cost is covered by the fixed policy tail;
 * the persisted measurements describe only the prefix, never the whole call.
 * A failed or lost call is not retried here: its pending/terminal row remains
 * durable and this one-shot authority cannot dispatch any further work. */
export async function finalizeArchiveBudgetControl<S extends ArchiveStagingStatement<S>>(
  db: ArchiveStagingDatabase<S>, input: { operationId: string; usage: unknown },
): Promise<ArchiveBudgetReceipt> {
  if (typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.operationId)) throw new Error('ARCHIVE_BUDGET_INPUT_INVALID');
  const operationId = input.operationId;
  const usage = takeArchiveBudgetControlUsage(db, input.usage);
  // This store is paired with migration24's measured closing policy. A future
  // collector policy must not silently reuse its prepaid closing transaction.
  if (usage.tail.version !== 'archive-control-terminal-v1' || usage.tail.reads !== 64 || usage.tail.writes !== 16 || usage.tail.statements !== 1) {
    throw new Error('ARCHIVE_BUDGET_CONTROL_TAIL_POLICY_INVALID');
  }
  const requestSha256 = await digest(new TextEncoder().encode(JSON.stringify({ kind: 'control', operationId, ...usage })));
  const result = await db.batch<{ operation_id: string; result_json: string }>([db.prepare(`
    WITH incoming(operation_id,request_sha256,attempt_id,epoch_id,execution_generation,utc_day,prepaid_reads,prepaid_writes,reads,writes,statements,batches,complete) AS (
      VALUES(?,?,?,?,?,?,CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER),CAST(? AS INTEGER))
    ), amounts AS (
      SELECT i.*,c.tail_reads,c.tail_writes,c.tail_statements,c.policy_version,a.state AS work_state,p.accounting_saturated AS pool_saturated,
        p.charged_reads AS pool_reads,p.charged_writes AS pool_writes,
        max(c.prepaid_reads,min(9007199254740991,i.reads+c.tail_reads)) AS total_reads,
        max(c.prepaid_writes,min(9007199254740991,i.writes+c.tail_writes)) AS total_writes
      FROM incoming i JOIN archive_budget_controls c ON c.attempt_id=i.attempt_id AND c.state='pending'
        AND c.epoch_id=i.epoch_id AND c.execution_generation=i.execution_generation AND c.utc_day=i.utc_day
        AND c.prepaid_reads=i.prepaid_reads AND c.prepaid_writes=i.prepaid_writes
      JOIN archive_budget_attempts a ON a.attempt_id=c.attempt_id
      JOIN archive_budget_pools p ON p.utc_day=c.utc_day AND p.pool='control'
    ), deficits AS (
      SELECT *,total_reads-prepaid_reads AS extra_reads,total_writes-prepaid_writes AS extra_writes FROM amounts
    ), limits AS (
      SELECT *,max(pool_saturated,reads>9007199254740991-tail_reads,writes>9007199254740991-tail_writes,
        extra_reads>9007199254740991-pool_reads,extra_writes>9007199254740991-pool_writes) AS saturated FROM deficits
    ), terminal AS (
      SELECT *,CASE WHEN extra_reads>0 OR extra_writes>0 OR saturated=1 THEN 'overrun'
        WHEN complete=1 AND work_state='settled' THEN 'settled' ELSE 'unknown' END AS terminal_state FROM limits
    )
    UPDATE archive_budget_controls AS c SET
      state=t.terminal_state,observed_prefix_reads=t.reads,observed_prefix_writes=t.writes,
      prefix_statements=t.statements,prefix_batches=t.batches,prefix_coverage_complete=t.complete,
      charge_reads=t.total_reads,charge_writes=t.total_writes,deficit_reads=t.extra_reads,deficit_writes=t.extra_writes,accounting_saturated=t.saturated,
      operation_id=t.operation_id,request_sha256=t.request_sha256,terminal_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      result_json=json_object('attemptId',t.attempt_id,'state',t.terminal_state,
        'observedPrefix',json_object('rowsRead',t.reads,'rowsWritten',t.writes,'statements',t.statements,'batches',t.batches,'coverageComplete',json(CASE WHEN t.complete=1 THEN 'true' ELSE 'false' END)),
        'prepaid',json_object('reads',t.prepaid_reads,'writes',t.prepaid_writes),
        'prepaidTail',json_object('version',t.policy_version,'reads',t.tail_reads,'writes',t.tail_writes,'statements',t.tail_statements),
        'charged',json_object('reads',t.total_reads,'writes',t.total_writes),
        'deficit',json_object('reads',t.extra_reads,'writes',t.extra_writes),'accountingSaturated',json(CASE WHEN t.saturated=1 THEN 'true' ELSE 'false' END))
    FROM terminal t WHERE c.attempt_id=t.attempt_id
      AND NOT EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=t.operation_id)
      AND NOT EXISTS(SELECT 1 FROM archive_budget_controls WHERE operation_id=t.operation_id)
      AND EXISTS(SELECT 1 FROM archive_budget_runtime b JOIN history_runtime h ON h.id=1
        WHERE b.id=1 AND b.epoch_id=t.epoch_id AND b.execution_generation=t.execution_generation AND b.current_day=t.utc_day
          AND h.state='ready' AND h.generation=t.execution_generation AND t.utc_day=strftime('%Y-%m-%d','now'))
    RETURNING operation_id,result_json
  `).bind(operationId, requestSha256, usage.identity.attemptId, usage.identity.epochId, usage.identity.executionGeneration, usage.identity.utcDay,
    usage.identity.prepaid.reads, usage.identity.prepaid.writes, usage.prefix.rowsRead, usage.prefix.rowsWritten,
    usage.prefix.statements, usage.prefix.batches, usage.prefix.coverageComplete ? 1 : 0)]);
  const row = result[0]?.results[0];
  if (!row || row.operation_id !== operationId) throw new Error('ARCHIVE_BUDGET_CONTROL_STALE');
  return { operationId, kind: 'control', result: JSON.parse(row.result_json) as Record<string, unknown>, replayed: false };
}
