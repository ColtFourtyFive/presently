import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { issueArchiveBudgetExecutionGrant, type ArchiveBudgetCost } from '../worker/archive-budget-usage';
import { advanceHistoryBackfill } from '../worker/history-lookup';
import { createRuntime, projectRoot, type TestRuntime } from './runtime';

/** A consistent pre-upgrade snapshot. Original schema23 guards are installed
 * before any tested execution or upgrade. No product clock or guard is changed. */
export async function legacyBudgetFixture(states: readonly ('reserved' | 'executing')[], envelope: ArchiveBudgetCost = { reads: 1000, writes: 1000 }) {
  const app = await createRuntime({ bindings: {}, migrate: false });
  try {
    for (const name of (await readdir(join(projectRoot, 'migrations'))).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) < 23).sort()) {
      const sql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
      await app.db.batch(sql.map(text => app.db.prepare(text)));
    }
    for (let page = 0; page < 12; page++) {
      if ((await advanceHistoryBackfill(app.db as unknown as D1Database)).state === 'ready') break;
      if (page === 11) throw new Error('Legacy fixture history did not become ready');
    }
    const migration = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', '0023_archive_budget_ledger.sql'), 'utf8'));
    const firstGuard = migration.findIndex(sql => /CREATE TRIGGER\s/i.test(sql));
    await app.db.batch(migration.slice(0, firstGuard).map(sql => app.db.prepare(sql)));
    const generation = (await app.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation'))!;
    const date = (await app.db.prepare("SELECT strftime('%Y-%m-%d','now') AS day,strftime('%Y-%m-%dT%H:%M:%fZ','now') AS at").first<{ day: string; at: string }>())!;
    const identity = { epochId: crypto.randomUUID(), executionGeneration: generation, utcDay: date.day };
    const attempts = states.map(state => ({ ...identity, attemptId: crypto.randomUUID(), state, executionTokenSha256: state === 'executing' ? crypto.randomUUID().replaceAll('-', '').repeat(2) : null, envelope, maximumStatements: 40, overhead: { reads: 1000, writes: 100 } }));
    await app.db.batch([
      app.db.prepare('INSERT INTO archive_budget_days(utc_day,scope_id,epoch_id,execution_generation,policy_version,envelope_version,allocation_sha256,actor_id,reason_code,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .bind(date.day, 'legacy-test-installation', identity.epochId, generation, 'legacy-policy', 'legacy-envelope', 'a'.repeat(64), 'legacy-owner', 'LEGACY_SNAPSHOT', date.at),
      ...['work', 'cleanup', 'control'].map(pool => app.db.prepare('INSERT INTO archive_budget_pools(utc_day,pool,allocated_reads,allocated_writes,held_reads,held_writes,charged_reads,charged_writes) VALUES(?,?,?,?,?,?,?,?)')
        .bind(date.day, pool, 100_000, 100_000, pool === 'work' ? states.length * envelope.reads : 0, pool === 'work' ? states.length * envelope.writes : 0, pool === 'control' ? 1 + states.length * 1000 : 0, pool === 'control' ? 1 + states.length * 100 : 0)),
      ...attempts.map(attempt => app.db.prepare(`INSERT INTO archive_budget_attempts(attempt_id,utc_day,epoch_id,execution_generation,pool,request_sha256,work_key_sha256,target_revision,reads_envelope,writes_envelope,overhead_reads,overhead_writes,maximum_statements,state,reserved_at,claimed_at,execution_token_sha256,revision)
        VALUES(?,?,?,?,'work',?,?,0,?,?,1000,100,40,?,?,?, ?,?)`)
        .bind(attempt.attemptId, date.day, identity.epochId, generation, 'b'.repeat(64), 'c'.repeat(64), envelope.reads, envelope.writes, attempt.state, date.at, attempt.state === 'executing' ? date.at : null, attempt.executionTokenSha256, attempt.state === 'executing' ? 1 : 0)),
      app.db.prepare("UPDATE archive_budget_runtime SET state='open',epoch_id=?,scope_id='legacy-test-installation',current_day=?,close_reason=NULL,revision=1 WHERE id=1")
        .bind(identity.epochId, date.day),
    ]);
    await app.db.batch(migration.slice(firstGuard).map(sql => app.db.prepare(sql)));
    // Preserve the old executable authority while native usage is collected
    // before schema24 exists. The current fence requires its new control row.
    const grants = attempts.map(attempt => attempt.executionTokenSha256 === null ? null : issueArchiveBudgetExecutionGrant({ ...attempt, executionTokenSha256: attempt.executionTokenSha256 }, (db, scope) => db.prepare(`SELECT CASE WHEN EXISTS(
      SELECT 1 FROM archive_budget_attempts a JOIN archive_budget_runtime b ON b.id=1 AND b.epoch_id=a.epoch_id JOIN history_runtime h ON h.id=1 AND h.generation=a.execution_generation
      WHERE a.attempt_id=? AND a.epoch_id=? AND a.execution_generation=? AND a.utc_day=? AND a.execution_token_sha256=? AND a.state='executing'
      AND b.state='open' AND b.execution_generation=a.execution_generation AND h.state='ready' AND b.current_day=a.utc_day AND a.utc_day=strftime('%Y-%m-%d','now')
      AND NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
      THEN 1 ELSE json_extract('ARCHIVE_BUDGET_EXECUTION_STALE','$') END AS archive_budget_allowed`).bind(scope.attemptId, scope.epochId, scope.executionGeneration, scope.utcDay, scope.executionTokenSha256)));
    return { app, identity, attempts, grants };
  } catch (error) {
    await app.close();
    throw error;
  }
}

export async function installBudgetControlMigration(app: TestRuntime) {
  const name = (await readdir(join(projectRoot, 'migrations'))).find(name => /^0024_.*\.sql$/.test(name));
  if (!name) throw new Error('Schema24 migration is not available');
  const statements = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
  await app.db.batch(statements.map(sql => app.db.prepare(sql)));
}
