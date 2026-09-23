import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import {
  assertArchiveBudgetExecution, claimArchiveBudgetAttempt, closeArchiveBudgetEpoch,
  openArchiveBudgetDay, readArchiveBudgetRuntime, reserveArchiveBudgetAttempt,
  settleArchiveBudgetAttempt,
} from '../worker/archive-budget-ledger';
import { createArchiveBudgetUsage } from '../worker/archive-budget-usage';
import { createArchiveBudgetInvocation } from '../worker/archive-budget-control-usage';
import { finalizeArchiveBudgetControl } from '../worker/archive-budget-control-store';
import { installBudgetControlMigration, legacyBudgetFixture } from './archive-budget-legacy-fixture';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { advanceHistoryBackfill } from '../worker/history-lookup';
import { createRuntime, projectRoot, type IsolatedStatement, type TestRuntime } from './runtime';

let app: TestRuntime | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const hash = (letter: string) => letter.repeat(64);
const pools = () => ({ work: { reads: 10_000, writes: 10_000 }, cleanup: { reads: 3_000, writes: 3_000 }, control: { reads: 2_000, writes: 2_000 } });
async function readyHistory() {
  for (let page = 0; page < 10; page++) if ((await advanceHistoryBackfill(app!.db as unknown as D1Database)).state === 'ready') return;
  throw new Error('Empty fixture history did not become ready');
}
async function clock() {
  return (await app!.db.prepare("SELECT strftime('%Y-%m-%d','now') AS today,strftime('%Y-%m-%d','now','-1 day') AS yesterday,strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day') AS prior_time").first<{ today: string; yesterday: string; prior_time: string }>())!;
}
async function openInput() {
  const runtime = await readArchiveBudgetRuntime(app!.db);
  return {
    operationId: crypto.randomUUID(), epochId: crypto.randomUUID(), executionGeneration: runtime.execution_generation,
    utcDay: (await clock()).today, expectedRevision: runtime.revision, scopeId: 'contract-installation',
    policyVersion: 'contract-policy', envelopeVersion: 'contract-envelope', allocationSha256: hash('a'),
    actorId: 'contract-owner', reasonCode: 'LOCAL_CONTRACT', pools: pools(), bootstrap: { reads: 4, writes: 4 },
  };
}
async function fresh() {
  app = await createRuntime({ bindings: {} });
  await readyHistory();
  const input = await openInput();
  await openArchiveBudgetDay(app.db, input);
  return input;
}
async function ledgerRows() {
  const results = await app!.db.batch([
    app!.db.prepare('SELECT * FROM archive_budget_runtime'),
    app!.db.prepare('SELECT * FROM archive_budget_days ORDER BY utc_day'),
    app!.db.prepare('SELECT * FROM archive_budget_pools ORDER BY utc_day,pool'),
    app!.db.prepare('SELECT * FROM archive_budget_attempts ORDER BY attempt_id'),
    app!.db.prepare('SELECT * FROM archive_budget_receipts ORDER BY operation_id'),
    app!.db.prepare('SELECT * FROM archive_budget_controls ORDER BY attempt_id'),
  ]);
  return results.map(result => result.results);
}
async function reserveAndClaim(identity: Awaited<ReturnType<typeof openInput>>, database: ArchiveStagingDatabase<IsolatedStatement> = app!.db) {
  const attemptId = crypto.randomUUID();
  const db = createArchiveBudgetInvocation(database);
  const reservation = await reserveArchiveBudgetAttempt(db, {
    ...identity, operationId: crypto.randomUUID(), attemptId, pool: 'work', workKeySha256: hash('b'),
    targetRevision: 0, envelope: { reads: 200, writes: 50 }, overhead: { reads: 1000, writes: 100 }, maximumStatements: 26,
  });
  const claimed = await claimArchiveBudgetAttempt(db, {
    ...identity, operationId: crypto.randomUUID(), attemptId, expectedRevision: 0,
  });
  expect(claimed.grant).toBeDefined();
  return { attemptId, grant: claimed.grant!, db, controlGrant: reservation.controlGrant! };
}

async function finishWork(context: Awaited<ReturnType<typeof reserveAndClaim>>) {
  context.db.phase('work');
  const usage = createArchiveBudgetUsage(context.db, context.grant);
  await usage.batch([usage.prepare('SELECT 1')]);
  context.db.phase('control');
  await settleArchiveBudgetAttempt(context.db, { operationId: crypto.randomUUID(), usage: usage.seal() });
}

type PriorState = 'reserved' | 'executing' | 'settled' | 'unknown';
async function yesterdayFixture(state: PriorState) {
  app = await createRuntime({ bindings: {}, migrate: false });
  for (const name of (await readdir(join(projectRoot, 'migrations'))).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 23).sort()) {
    const sql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
    await app.db.batch(sql.map(text => app!.db.prepare(text)));
  }
  await readyHistory();
  const migration = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', '0023_archive_budget_ledger.sql'), 'utf8'));
  const firstGuard = migration.findIndex(sql => /CREATE TRIGGER\s/i.test(sql));
  expect(firstGuard).toBeGreaterThan(0);
  await app.db.batch(migration.slice(0, firstGuard).map(sql => app!.db.prepare(sql)));
  const controls = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', '0024_archive_budget_control.sql'), 'utf8'));
  const backfill = controls.findIndex(sql => /INSERT INTO archive_budget_controls\(/i.test(sql));
  await app.db.batch(controls.slice(0, backfill).map(sql => app!.db.prepare(sql)));
  // Seed an internally consistent prior-day snapshot before installing guards.
  // All production triggers are installed before exercising today's public APIs.
  // This uses native D1 time and does not alter the product clock or its SQL.
  const date = await clock(), runtime = (await app.db.prepare('SELECT execution_generation FROM archive_budget_runtime WHERE id=1').first<{ execution_generation: string }>())!;
  const epochId = crypto.randomUUID(), attemptId = crypto.randomUUID();
  const terminal = state === 'settled' || state === 'unknown';
  const charge = state === 'settled' ? { reads: 10, writes: 3 } : state === 'unknown' ? { reads: 200, writes: 50 } : { reads: 0, writes: 0 };
  const statements = [
    app.db.prepare('INSERT INTO archive_budget_days(utc_day,scope_id,epoch_id,execution_generation,policy_version,envelope_version,allocation_sha256,actor_id,reason_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(date.yesterday, 'contract-installation', epochId, runtime.execution_generation, 'contract-policy', 'contract-envelope', hash('a'), 'contract-owner', 'LOCAL_CONTRACT', date.prior_time),
    ...Object.entries(pools()).map(([pool, allocation]) => app!.db.prepare('INSERT INTO archive_budget_pools(utc_day,pool,allocated_reads,allocated_writes,held_reads,held_writes,charged_reads,charged_writes) VALUES(?,?,?,?,?,?,?,?)')
      .bind(date.yesterday, pool, allocation.reads, allocation.writes, pool === 'work' && !terminal ? 200 : 0, pool === 'work' && !terminal ? 50 : 0, pool === 'work' ? charge.reads : pool === 'control' ? 1004 : 0, pool === 'work' ? charge.writes : pool === 'control' ? 104 : 0)),
    app.db.prepare(`INSERT INTO archive_budget_attempts(attempt_id,utc_day,epoch_id,execution_generation,pool,request_sha256,work_key_sha256,target_revision,reads_envelope,writes_envelope,overhead_reads,overhead_writes,maximum_statements,state,reserved_at,claimed_at,settled_at,execution_token_sha256,observed_reads,observed_writes,charge_reads,charge_writes,revision,settle_operation_id,unknown_reason)
      VALUES(?,?,?,?,'work',?,?,0,200,50,1000,100,40,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .bind(attemptId, date.yesterday, epochId, runtime.execution_generation, hash('d'), hash('b'), state, date.prior_time, state === 'reserved' ? null : date.prior_time, terminal ? date.prior_time : null, state === 'executing' ? hash('c') : null, state === 'settled' ? 10 : 0, state === 'settled' ? 3 : 0, charge.reads, charge.writes, state === 'reserved' ? 0 : state === 'executing' ? 1 : 2, terminal ? crypto.randomUUID() : null, state === 'unknown' ? 'INCOMPLETE_USAGE' : null),
    app.db.prepare('UPDATE archive_budget_runtime SET state=?,epoch_id=?,scope_id=?,current_day=?,close_reason=?,revision=1 WHERE id=1')
      .bind(state === 'unknown' ? 'closed' : 'open', epochId, 'contract-installation', date.yesterday, state === 'unknown' ? 'unknown_usage' : null),
  ];
  await app.db.batch(statements);
  // This is a historical schema24 snapshot, not a schema23 upgrade. Its
  // synthetic saved receipt is loaded before every original production guard.
  // Fresh terminal evidence below is always produced by the native collector.
  const controlState = state === 'settled' ? 'settled' : state === 'unknown' ? 'unknown' : 'pending';
  const operationId = terminal ? crypto.randomUUID() : null;
  const prefix = { rowsRead: 13, rowsWritten: 9, statements: 13, batches: 6, coverageComplete: state === 'settled' };
  const result = terminal ? { attemptId, state: controlState, observedPrefix: prefix, prepaid: { reads: 1000, writes: 100 }, prepaidTail: { version: 'archive-control-terminal-v1', reads: 64, writes: 16, statements: 1 }, charged: { reads: 1000, writes: 100 }, deficit: { reads: 0, writes: 0 }, accountingSaturated: false } : null;
  await app.db.prepare(`INSERT INTO archive_budget_controls(attempt_id,utc_day,epoch_id,execution_generation,policy_version,prepaid_reads,prepaid_writes,tail_reads,tail_writes,tail_statements,state,observed_prefix_reads,observed_prefix_writes,prefix_statements,prefix_batches,prefix_coverage_complete,charge_reads,charge_writes,operation_id,request_sha256,result_json,created_at,terminal_at)
    VALUES(?,?,?,?,'archive-control-terminal-v1',1000,100,64,16,1,?,?,?,?,?, ?,1000,100,?,?,?,?,?)`)
    .bind(attemptId, date.yesterday, epochId, runtime.execution_generation, controlState, terminal ? 13 : 0, terminal ? 9 : 0, terminal ? 13 : 0, terminal ? 6 : 0, state === 'settled' ? 1 : 0, operationId, terminal ? hash('d') : null, result ? JSON.stringify(result) : null, date.prior_time, terminal ? date.prior_time : null).run();
  await app.db.batch(migration.slice(firstGuard).map(sql => app!.db.prepare(sql)));
  const controlGuards = controls.findIndex(sql => /CREATE TRIGGER\s/i.test(sql));
  await app.db.batch(controls.slice(controlGuards).map(sql => app!.db.prepare(sql)));
  return { attemptId, epochId, executionGeneration: runtime.execution_generation, utcDay: date.yesterday, executionTokenSha256: hash('c'), envelope: { reads: 200, writes: 50 }, maximumStatements: 40 };
}

describe('independent native archive budget contracts', () => {
  it.each(['unknown_usage', 'overrun', 'accounting_saturated', 'restore_unreconciled'])('keeps %s closure sticky through direct SQL and operator close', async closeReason => {
    const identity = await fresh();
    if (closeReason === 'restore_unreconciled') await app!.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    else await app!.db.prepare("UPDATE archive_budget_runtime SET state='closed',close_reason=?,revision=revision+1 WHERE id=1").bind(closeReason).run();
    const before = await ledgerRows(), runtime = await readArchiveBudgetRuntime(app!.db);
    expect(runtime.close_reason).toBe(closeReason);
    await expect(app!.db.prepare("UPDATE archive_budget_runtime SET close_reason='operator_closed',revision=revision+1 WHERE id=1").run()).rejects.toThrow('ARCHIVE_BUDGET_RUNTIME_INVALID');
    await expect(closeArchiveBudgetEpoch(app!.db, { ...identity, operationId: crypto.randomUUID(), expectedRevision: runtime.revision, reasonCode: 'TRY_REOPEN' })).rejects.toThrow('STALE');
    expect(await ledgerRows()).toEqual(before);
  });

  it('cannot create fresh same-day capacity by closing and replacing the epoch', async () => {
    const identity = await fresh(), { grant, db, controlGrant } = await reserveAndClaim(identity);
    db.phase('work');
    const usage = createArchiveBudgetUsage(db, grant);
    await usage.batch([usage.prepare('SELECT generation FROM history_runtime WHERE id=1')]);
    db.phase('control');
    await settleArchiveBudgetAttempt(db, { operationId: crypto.randomUUID(), usage: usage.seal() });
    await finalizeArchiveBudgetControl(db, { operationId: crypto.randomUUID(), usage: db.sealControlUsage(controlGrant) });
    const runtime = await readArchiveBudgetRuntime(app!.db);
    await closeArchiveBudgetEpoch(app!.db, { ...identity, operationId: crypto.randomUUID(), expectedRevision: runtime.revision, reasonCode: 'LOCAL_STOP' });
    const before = await ledgerRows();
    await expect(openArchiveBudgetDay(app!.db, await openInput())).rejects.toThrow();
    expect(await ledgerRows()).toEqual(before);
    expect((before[2] as Array<{ pool: string; charged_reads: number }>).find(pool => pool.pool === 'control')!.charged_reads).toBe(1004);
  });

  it('opens one new day after settled history without rewriting old allocations or counters', async () => {
    const prior = await yesterdayFixture('settled'), before = await ledgerRows(), input = await openInput();
    const responses = await Promise.all([openArchiveBudgetDay(app!.db, input), openArchiveBudgetDay(app!.db, input)]);
    expect(responses.filter(response => !response.replayed)).toHaveLength(1);
    expect(responses.filter(response => response.replayed)).toHaveLength(1);
    const after = await ledgerRows();
    expect(after[1]).toHaveLength(2);
    expect(after[2]).toHaveLength(6);
    expect(after[1].filter(row => row.utc_day === prior.utcDay)).toEqual(before[1]);
    expect(after[2].filter(row => row.utc_day === prior.utcDay)).toEqual(before[2]);
    expect(after[3]).toEqual(before[3]);
    await expect(assertArchiveBudgetExecution(app!.db, prior)).rejects.toThrow();
  });

  it.each(['reserved', 'executing', 'unknown'] as const)('does not open a new day over prior %s liability', async state => {
    const prior = await yesterdayFixture(state), before = await ledgerRows();
    await expect(openArchiveBudgetDay(app!.db, await openInput())).rejects.toThrow('ARCHIVE_BUDGET_CONTROL_PENDING');
    await expect(assertArchiveBudgetExecution(app!.db, prior)).rejects.toThrow();
    expect(await ledgerRows()).toEqual(before);
  });

  it('does not expose the native transport or mutable grant record through the usage object', async () => {
    const identity = await fresh(), { grant } = await reserveAndClaim(identity);
    const usage = createArchiveBudgetUsage(app!.db, grant);
    const leaked = Reflect.get(usage, 'grant');
    if (leaked && typeof leaked === 'object') Reflect.set(leaked, 'consumed', false);
    expect(() => createArchiveBudgetUsage(app!.db, grant)).toThrow('GRANT_CONSUMED_OR_INVALID');
    expect(Reflect.get(usage, 'db')).toBeUndefined();
    expect(leaked).toBeUndefined();
    usage.seal();
  });

  it('escalates saturation when a prior overrun is followed by within-envelope terminal accounting', async () => {
    const legacy = await legacyBudgetFixture(['executing', 'executing'], { reads: 200, writes: 50 });
    app = legacy.app;
    // Native ledger transactions with injected usage totals exercise arithmetic
    // boundaries. These values are test inputs, not measured provider billing.
    const observation = (reads: number): ArchiveStagingDatabase<IsolatedStatement> => ({
      prepare: sql => app!.db.prepare(sql),
      async batch<T>(statements: IsolatedStatement[]) {
        const results = await app!.db.batch<T>(statements);
        return results.map((row, index) => ({ ...row, meta: { ...row.meta, rows_read: index === 0 ? 0 : reads, rows_written: 0 } }));
      },
    });
    const large = createArchiveBudgetUsage(observation(Number.MAX_SAFE_INTEGER - 5), legacy.grants[0]!);
    const small = createArchiveBudgetUsage(observation(10), legacy.grants[1]!);
    await expect(large.batch([large.prepare('SELECT 1')])).rejects.toThrow('COST_OVERRUN');
    await small.batch([small.prepare('SELECT 1')]);
    const smallEvidence = small.seal(), operationId = crypto.randomUUID();
    await installBudgetControlMigration(app);
    await settleArchiveBudgetAttempt(app!.db, { operationId: crypto.randomUUID(), usage: large.seal() });
    expect((await readArchiveBudgetRuntime(app!.db)).close_reason).toBe('overrun');
    await settleArchiveBudgetAttempt(app!.db, { operationId, usage: smallEvidence });
    expect(await app!.db.prepare("SELECT held_reads,charged_reads,accounting_saturated FROM archive_budget_pools WHERE pool='work'").first())
      .toEqual({ held_reads: 0, charged_reads: Number.MAX_SAFE_INTEGER, accounting_saturated: 1 });
    expect((await readArchiveBudgetRuntime(app!.db)).close_reason).toBe('accounting_saturated');
    const before = await ledgerRows();
    expect((await settleArchiveBudgetAttempt(app!.db, { operationId, usage: smallEvidence })).replayed).toBe(true);
    expect(await ledgerRows()).toEqual(before);
  });
});

describe('independent durable control contracts', () => {
  it('keeps settled work blocked by pending control across a fresh wrapper', async () => {
    const identity = await fresh(), context = await reserveAndClaim(identity);
    await finishWork(context);
    expect(await app!.db.prepare('SELECT state FROM archive_budget_attempts WHERE attempt_id=?').bind(context.attemptId).first('state')).toBe('settled');
    expect(await readArchiveBudgetRuntime(app!.db)).toMatchObject({ state: 'open', dispatchBlocked: true, pendingControlOwner: context.attemptId });
    const before = await ledgerRows(), restarted = createArchiveBudgetInvocation(app!.db);
    expect(() => restarted.sealControlUsage(JSON.parse(JSON.stringify(context.controlGrant)))).toThrow('CONTROL_USAGE_INVALID');
    expect(restarted.submitted).toBe(0);
    await expect(reserveArchiveBudgetAttempt(restarted, { ...identity, operationId: crypto.randomUUID(), attemptId: crypto.randomUUID(), pool: 'work', workKeySha256: hash('e'), targetRevision: 1, envelope: { reads: 200, writes: 50 }, overhead: { reads: 1000, writes: 100 }, maximumStatements: 26 })).rejects.toThrow('CONTROL_PENDING');
    await expect(openArchiveBudgetDay(app!.db, await openInput())).rejects.toThrow('CONTROL_PENDING');
    expect(await ledgerRows()).toEqual(before);
  });

  it('binds terminal evidence to one wrapper and keeps its embedded receipt immutable', async () => {
    const identity = await fresh(), context = await reserveAndClaim(identity);
    await finishWork(context);
    const sealed = context.db.sealControlUsage(context.controlGrant), before = context.db.submitted;
    const other = createArchiveBudgetInvocation(app!.db), operationId = crypto.randomUUID();
    await expect(finalizeArchiveBudgetControl(other, { operationId, usage: sealed })).rejects.toThrow('CONTROL_USAGE_INVALID');
    await expect(finalizeArchiveBudgetControl(context.db, { operationId, usage: { ...sealed } })).rejects.toThrow('CONTROL_USAGE_INVALID');
    expect(other.submitted).toBe(0); expect(context.db.submitted).toBe(before);
    const terminal = await finalizeArchiveBudgetControl(context.db, { operationId, usage: sealed });
    expect(terminal.result).toMatchObject({ state: 'settled', prepaidTail: { version: 'archive-control-terminal-v1', reads: 64, writes: 16, statements: 1 }, charged: { reads: 1000, writes: 100 }, deficit: { reads: 0, writes: 0 } });
    expect(context.db.submitted).toBe(before + 1);
    expect(context.db.metrics('terminal')).toMatchObject({ statements: 1, coverageComplete: true });
    expect(context.db.metrics('terminal').rowsRead).toBeLessThanOrEqual(64); expect(context.db.metrics('terminal').rowsWritten).toBeLessThanOrEqual(16);
    expect(await readArchiveBudgetRuntime(app!.db)).toMatchObject({ dispatchBlocked: false, pendingControlOwner: null });
    const saved = await ledgerRows();
    await expect(finalizeArchiveBudgetControl(context.db, { operationId, usage: sealed })).rejects.toThrow('CONTROL_USAGE_INVALID');
    expect(() => context.db.sealControlUsage(context.controlGrant)).toThrow('CONTROL_USAGE_INVALID');
    expect(context.db.submitted).toBe(before + 1);
    for (const sql of [
      'UPDATE archive_budget_controls SET observed_prefix_reads=0 WHERE attempt_id=?',
      "UPDATE archive_budget_controls SET result_json='{}' WHERE attempt_id=?",
      "UPDATE archive_budget_controls SET state='pending',operation_id=NULL,request_sha256=NULL,result_json=NULL,terminal_at=NULL WHERE attempt_id=?",
      'DELETE FROM archive_budget_controls WHERE attempt_id=?',
      'INSERT OR REPLACE INTO archive_budget_controls SELECT * FROM archive_budget_controls WHERE attempt_id=?',
    ]) await expect(app!.db.prepare(sql).bind(context.attemptId).run()).rejects.toThrow();
    expect(await ledgerRows()).toEqual(saved);
  });

  it.each(['missing', 'deficit', 'saturation'] as const)('persists %s evidence and closes dispatch conservatively', async mode => {
    const identity = await fresh(); let inject = true;
    const measured: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app!.db.prepare(sql), batch: async <T,>(statements: IsolatedStatement[]) => {
      const results = await app!.db.batch<T>(statements);
      if (!inject) return results; inject = false;
      // Deliberately injected metadata tests arithmetic, not provider billing.
      return results.map((result, index) => index ? result : mode === 'missing' ? { ...result, meta: undefined } : { ...result, meta: { ...result.meta, rows_read: mode === 'deficit' ? 2000 : Number.MAX_SAFE_INTEGER } });
    } };
    const context = await reserveAndClaim(identity, measured); await finishWork(context);
    const receipt = await finalizeArchiveBudgetControl(context.db, { operationId: crypto.randomUUID(), usage: context.db.sealControlUsage(context.controlGrant) });
    const row = (await app!.db.prepare('SELECT * FROM archive_budget_controls WHERE attempt_id=?').bind(context.attemptId).first<Record<string, number | string>>())!;
    expect(row.state).toBe(mode === 'missing' ? 'unknown' : 'overrun');
    expect(row.prefix_coverage_complete).toBe(mode === 'deficit' ? 1 : 0);
    expect(row.charge_reads).toBe(mode === 'missing' ? 1000 : mode === 'saturation' ? Number.MAX_SAFE_INTEGER : Number(row.observed_prefix_reads) + 64);
    expect(row.deficit_reads).toBe(Number(row.charge_reads) - 1000);
    expect(receipt.result).toMatchObject({ state: row.state, charged: { reads: row.charge_reads }, deficit: { reads: row.deficit_reads } });
    expect(context.db.metrics('terminal').rowsRead).toBeLessThanOrEqual(64); expect(context.db.metrics('terminal').rowsWritten).toBeLessThanOrEqual(16);
    expect(await readArchiveBudgetRuntime(app!.db)).toMatchObject({ state: 'closed', dispatchBlocked: true, close_reason: mode === 'missing' ? 'unknown_usage' : mode === 'deficit' ? 'overrun' : 'accounting_saturated' });
    if (mode === 'saturation') expect(await app!.db.prepare("SELECT charged_reads,accounting_saturated FROM archive_budget_pools WHERE pool='control'").first()).toEqual({ charged_reads: Number.MAX_SAFE_INTEGER, accounting_saturated: 1 });
    const before = await ledgerRows();
    await expect(app!.db.prepare("UPDATE archive_budget_runtime SET close_reason='operator_closed',revision=revision+1 WHERE id=1").run()).rejects.toThrow('RUNTIME_INVALID');
    expect(await ledgerRows()).toEqual(before);
  });

  it('keeps liability pending when maintenance rejects the one-shot terminal write', async () => {
    const identity = await fresh(), context = await reserveAndClaim(identity); await finishWork(context);
    const evidence = context.db.sealControlUsage(context.controlGrant), operationId = crypto.randomUUID(), before = await ledgerRows();
    await app!.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    await expect(finalizeArchiveBudgetControl(context.db, { operationId, usage: evidence })).rejects.toThrow('backup_maintenance');
    expect(await ledgerRows()).toEqual(before);
    await app!.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    const count = context.db.submitted;
    await expect(finalizeArchiveBudgetControl(context.db, { operationId, usage: evidence })).rejects.toThrow('CONTROL_USAGE_INVALID');
    expect(context.db.submitted).toBe(count);
    expect(await readArchiveBudgetRuntime(app!.db)).toMatchObject({ dispatchBlocked: true, pendingControlOwner: context.attemptId });
  });

  it('migrates settled schema23 work as unresolved control without changing money or generation', async () => {
    const legacy = await legacyBudgetFixture(['executing']); app = legacy.app;
    const usage = createArchiveBudgetUsage(app.db, legacy.grants[0]!); await usage.batch([usage.prepare('SELECT 1')]);
    await settleArchiveBudgetAttempt(app.db, { operationId: crypto.randomUUID(), usage: usage.seal() });
    const before = await app.db.prepare('SELECT * FROM archive_budget_pools ORDER BY pool').all();
    await installBudgetControlMigration(app);
    expect((await app.db.prepare('SELECT * FROM archive_budget_pools ORDER BY pool').all()).results).toEqual(before.results);
    expect(await readArchiveBudgetRuntime(app.db)).toMatchObject({ state: 'closed', close_reason: 'unknown_usage', execution_generation: legacy.identity.executionGeneration, epoch_id: legacy.identity.epochId, dispatchBlocked: true });
    expect(await app.db.prepare('SELECT state,policy_version,prefix_coverage_complete,charge_reads,charge_writes FROM archive_budget_controls').first()).toEqual({ state: 'legacy_unresolved', policy_version: 'legacy23-unreconciled', prefix_coverage_complete: 0, charge_reads: 1000, charge_writes: 100 });
    await expect(app.db.prepare("UPDATE archive_budget_controls SET state='settled' WHERE attempt_id=?").bind(legacy.attempts[0].attemptId).run()).rejects.toThrow('CONTROL_INVALID');
  });

  it('uses indexed unresolved-state seeks when settled history has no pending control', async () => {
    await yesterdayFixture('settled');
    const query = "SELECT attempt_id FROM archive_budget_controls WHERE state IN ('pending','unknown','overrun','legacy_unresolved') LIMIT 1";
    const plan = await app!.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all<{ detail: string }>();
    expect(plan.results.map(row => row.detail).join(' ')).toContain('SEARCH archive_budget_controls USING COVERING INDEX archive_budget_controls_state (state=?)');
    const result = await app!.db.prepare(query).all(); expect(result.results).toEqual([]); expect(result.meta.rows_read).toBeLessThanOrEqual(4);
  });
});
