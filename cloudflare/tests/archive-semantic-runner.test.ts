import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification, type MonthlySemanticRunHandle } from '../worker/archive-semantic-runner';
import { type ArchiveMetadata, type ArchiveRecord } from '../shared/archive-format';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';
const key = randomBytes(32).toString('base64'), at = '2025-01-02T00:00:00.000Z';
let app: TestRuntime;
let native: Awaited<ReturnType<typeof nativeSemanticFixture>>;
const base = (): ArchiveRecord[] => [
  { table: 'centers', key: 'test-center', row: { id: 'test-center', name: 'Synthetic center', timezone: 'UTC', created_at: at } },
  { table: 'students', key: 'student-1', row: { id: 'student-1', center_id: 'test-center', student_code: 'ONE', first_name: 'Synthetic', last_name: 'Student', subjects: '["Math"]', active: 1, created_at: at, updated_at: at } },
];
async function staging(records = base(), meta: Partial<ArchiveMetadata> = {}) {
  const metadata: ArchiveMetadata = { centerId: 'test-center', month: '2025-01', timezone: 'UTC', kind: 'monthly', createdAt: '2025-02-03T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [19], references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] }, ...meta, archiveId: crypto.randomUUID() };
  const objects = new Map<string, Uint8Array>();
  const result = await createArchive(key, metadata, records, async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const reference = { archiveId: metadata.archiveId, kind: metadata.kind, manifestObjectKey: result.objectKey, manifestSha256: result.sha256 };
  const target = await D1ArchiveSemanticStaging.create(app.db, key, reference);
  await target.registerManifest(reference, result.encrypted);
  for (const part of result.manifest.parts) await target.stageEncryptedPart(result.manifest.archiveId, part.index, objects.get(part.objectKey)!);
  const snapshot = await target.freeze();
  return { target, snapshot, reference, ...result, identity: { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 } };
}
async function started(records = base(), meta: Partial<ArchiveMetadata> = {}) { const bundle = await staging(records, meta); return { ...bundle, handle: await startMonthlySemanticVerification(app.db, bundle.identity) }; }
async function clear(target: Awaited<ReturnType<typeof staging>>['target']) {
  const status = await app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(target.handle.verificationId).first<string>('status');
  if (status !== 'invalid') await target.discard();
  const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, target.handle);
  for (let page = 0; page < 200; page++) {
    const result = await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup, 64);
    expect(result.deleted).toBeLessThanOrEqual(64);
    if (result.complete) return;
  }
  throw new Error('Test cleanup did not finish');
}
async function saved(handle: MonthlySemanticRunHandle) { return (await app.db.prepare('SELECT * FROM archive_semantic_runs WHERE run_id=?').bind(handle.runId).first())!; }
async function complete(handle: MonthlySemanticRunHandle, database: ArchiveStagingDatabase<IsolatedStatement> = app.db) {
  for (let i = 0; i < 400; i++) { const result = await advanceMonthlySemanticVerification(database, handle); expect(result.queries).toBeLessThanOrEqual(40); if (result.status === 'complete') return; expect(result.status).toBe('pending'); }
  throw new Error('Test runner failed to finish');
}
async function untilPhase(handle: MonthlySemanticRunHandle, phase: string) {
  for (let i = 0; i < 300; i++) { const row = await saved(handle); if (row.phase === phase) return row; await advanceMonthlySemanticVerification(app.db, handle); }
  throw new Error('Test phase was not reached');
}
const rotate = () => app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
const commitBatch = (statements: IsolatedStatement[]) => statements.some(statement => statement.sql.startsWith('UPDATE archive_semantic_runs SET revision=CASE'));
function database(hook: <T>(statements: IsolatedStatement[]) => Promise<{ results: T[] }[]>): ArchiveStagingDatabase<IsolatedStatement> { return { prepare: sql => app.db.prepare(sql), batch: hook }; }
beforeAll(async () => { native = await nativeSemanticFixture(13); });
beforeEach(async () => { app = await createRuntime({ bindings: {} }); });
afterEach(async () => { await app.close(); });

describe('bounded private monthly semantic runner', () => {
  it('requires a frozen monthly base and returns the same durable job for repeated starts', async () => {
    const bundle = await started();
    expect(await startMonthlySemanticVerification(app.db, bundle.identity)).toEqual(bundle.handle);
    await expect(startMonthlySemanticVerification(app.db, { ...bundle.identity, commitToken: crypto.randomUUID() })).rejects.toThrow('STALE');
    await expect(startMonthlySemanticVerification(app.db, { ...bundle.identity, graphSha256: '0'.repeat(64) })).rejects.toThrow('STALE');
    await complete(bundle.handle);
    expect((await advanceMonthlySemanticVerification(app.db, bundle.handle)).status).toBe('complete');
    await clear(bundle.target);
    const externallyVerified = await staging(); await externallyVerified.target.finalize();
    await expect(startMonthlySemanticVerification(app.db, externallyVerified.identity)).rejects.toThrow('STALE');
    await clear(externallyVerified.target);
    const source = await staging();
    const added: ArchiveRecord[] = [...base(), { table: 'audit_entries', key: 'added-audit', row: { id: 'added-audit', center_id: 'test-center', actor_id: null, actor_name: 'Synthetic', action: 'historical_note', entity_type: 'visit', entity_id: 'visit', detail: '{}', created_at: at } }];
    const extra = await createArchive(key, { archiveId: crypto.randomUUID(), centerId: 'test-center', month: '2025-01', timezone: 'UTC', kind: 'addendum', createdAt: '2025-02-03T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [19], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] }, references: [source.reference] }, added, async () => {});
    const addRef = { archiveId: extra.manifest.archiveId, kind: extra.manifest.kind, manifestObjectKey: extra.objectKey, manifestSha256: extra.sha256 };
    await clear(source.target);
    // Admission rejects an addendum before it can acquire a private proof job.
    await expect(D1ArchiveSemanticStaging.create(app.db, key, addRef)).rejects.toThrow('ADMISSION_LIMIT');
    expect(await app.db.prepare('SELECT count(*) n FROM archive_semantic_runs').first('n')).toBe(0);
  });

  it('caps actual prepared statements, streams indexed operations, and bounds persisted headers/cursors', async () => {
    const bundle = await started(structuredClone(native.records), native.metadata), counts: number[] = [], operationReads: IsolatedStatement[] = [];
    let current = 0;
    const instrumented = database(async <T,>(statements: IsolatedStatement[]) => { current += statements.length; operationReads.push(...statements.filter(statement => statement.sql.startsWith('SELECT o.source_table'))); return app.db.batch<T>(statements); });
    for (let i = 0; i < 400; i++) {
      current = 0; const result = await advanceMonthlySemanticVerification(instrumented, bundle.handle); counts.push(current);
      expect(result.queries).toBe(current); expect(current).toBeLessThanOrEqual(40);
      const row = await saved(bundle.handle); expect(new TextEncoder().encode(String(row.cursor_json)).length).toBeLessThanOrEqual(8192); expect(new TextEncoder().encode(String(row.header_json)).length).toBeLessThanOrEqual(49152);
      if (result.status === 'complete') break;
    }
    expect((await saved(bundle.handle)).status).toBe('complete'); expect(Math.max(...counts)).toBeLessThanOrEqual(40);
    expect(operationReads.length).toBeGreaterThan(2);
    const query = operationReads[0];
    const plan = await app.db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.args).all<{ detail: string }>();
    expect(plan.results.map(row => row.detail).join(' ')).toContain('archive_semantic_operations_visit');
    const result = await app.db.prepare(query.sql).bind(...query.args).all(); expect(result.results.length).toBeLessThanOrEqual(8);
    expect(await app.db.prepare('SELECT count(*) n FROM visits').first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) n FROM history_record_locations').first('n')).toBe(0);
  });

  it('allows one concurrent owner and rejects an old lease after takeover', async () => {
    const bundle = await started();
    const results = await Promise.all([advanceMonthlySemanticVerification(app.db, bundle.handle), advanceMonthlySemanticVerification(app.db, bundle.handle)]);
    expect(results.filter(result => result.status === 'pending')).toHaveLength(1);
    expect(results.filter(result => result.status === 'busy')).toHaveLength(1);
    expect((await saved(bundle.handle)).revision).toBe(1);
    let release!: () => void, claimed!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), claim = new Promise<void>(resolve => { claimed = resolve; });
    let held = false;
    const delayed = database(async <T,>(statements: IsolatedStatement[]) => {
      const result = await app.db.batch<T>(statements);
      if (!held && statements.some(statement => statement.sql.startsWith("UPDATE archive_semantic_runs SET status='running'"))) { held = true; claimed(); await wait; }
      return result;
    });
    const old = advanceMonthlySemanticVerification(delayed, bundle.handle); const rejection = expect(old).rejects.toThrow('STALE');
    await claim;
    await app.db.prepare("UPDATE archive_semantic_runs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE run_id=?").bind(bundle.handle.runId).run();
    expect((await advanceMonthlySemanticVerification(app.db, bundle.handle)).status).toBe('pending');
    release(); await rejection;
    expect((await saved(bundle.handle)).revision).toBe(2);
  });

  it('rolls back derived operations, totals and cursor together and survives a lost commit response', async () => {
    const bundle = await started(structuredClone(native.records), native.metadata);
    let injected = false;
    const broken = database(async <T,>(statements: IsolatedStatement[]) => {
      if (!injected && statements.some(statement => statement.sql.startsWith('INSERT INTO archive_semantic_operations'))) {
        injected = true;
        return app.db.batch<T>([...statements.slice(0, -1), app.db.prepare('SELECT * FROM injected_missing_table'), statements.at(-1)!]);
      }
      return app.db.batch<T>(statements);
    });
    let before: Record<string, unknown> = {};
    for (let i = 0; i < 100 && !injected; i++) { before = await saved(bundle.handle); try { await advanceMonthlySemanticVerification(broken, bundle.handle); } catch (error) { expect(String(error)).toContain('injected_missing_table'); } }
    expect(injected).toBe(true);
    const rolledBack = await saved(bundle.handle); expect(rolledBack.cursor_json).toBe(before.cursor_json); expect(rolledBack.revision).toBe(before.revision); expect(rolledBack.status).toBe('pending');
    expect(await app.db.prepare('SELECT count(*) n FROM archive_semantic_operations WHERE run_id=?').bind(bundle.handle.runId).first('n')).toBe(0);
    expect(await app.db.prepare('SELECT count(*) n FROM archive_semantic_visit_totals WHERE run_id=?').bind(bundle.handle.runId).first('n')).toBe(0);
    let lost = false;
    const lostResponse = database(async <T,>(statements: IsolatedStatement[]) => {
      const result = await app.db.batch<T>(statements);
      if (!lost && commitBatch(statements)) { lost = true; throw new Error('synthetic lost response'); }
      return result;
    });
    await expect(advanceMonthlySemanticVerification(lostResponse, bundle.handle)).rejects.toThrow('synthetic lost response');
    expect((await saved(bundle.handle)).revision).toBe(Number(before.revision) + 1);
    expect(await app.db.prepare('SELECT count(*) n FROM archive_semantic_operations WHERE run_id=?').bind(bundle.handle.runId).first('n')).toBe(1);
    await complete(bundle.handle);
    const totals = await app.db.prepare('SELECT sum(operation_count) n FROM archive_semantic_visit_totals WHERE run_id=?').bind(bundle.handle.runId).first('n');
    expect(await app.db.prepare('SELECT count(*) n FROM archive_semantic_operations WHERE run_id=?').bind(bundle.handle.runId).first('n')).toBe(totals);
  });

  it('rejects malformed or inconsistent persisted cursors and protects immutable headers', async () => {
    const examples = [{ extra: true }, { tableIndex: 9 }, { visitsDone: 1 }, { counts: {} }, { visit: { fold: {} } }, { phase: 'complete' }];
    for (const patch of examples) {
      const bundle = await started(), row = await saved(bundle.handle);
      await app.db.prepare('UPDATE archive_semantic_runs SET cursor_json=? WHERE run_id=?').bind(JSON.stringify({ ...JSON.parse(String(row.cursor_json)), ...patch }), bundle.handle.runId).run();
      let failures = 0;
      const bounded = database(async <T,>(statements: IsolatedStatement[]) => { failures += statements.length; return app.db.batch<T>(statements); });
      await expect(advanceMonthlySemanticVerification(bounded, bundle.handle)).rejects.toThrow('CURSOR_INVALID');
      expect(failures).toBeLessThanOrEqual(40);
      expect((await saved(bundle.handle)).revision).toBe(0);
      expect((await saved(bundle.handle)).status).toBe('invalid');
      expect((await saved(bundle.handle)).error_code).toBe('CURSOR_INVALID');
      await expect(app.db.prepare("UPDATE archive_semantic_runs SET header_json='{}' WHERE run_id=?").bind(bundle.handle.runId).run()).rejects.toThrow('STALE');
      await clear(bundle.target);
    }
    const bundle = await started(); await complete(bundle.handle);
    const row = await saved(bundle.handle), cursor = JSON.parse(String(row.cursor_json)); cursor.counts.students = 0;
    await app.db.prepare('UPDATE archive_semantic_runs SET cursor_json=? WHERE run_id=?').bind(JSON.stringify(cursor), bundle.handle.runId).run();
    await expect(advanceMonthlySemanticVerification(app.db, bundle.handle)).rejects.toThrow('CURSOR_INVALID');
  });

  it('rejects a corrupt visit fold between operation pages', async () => {
    const bundle = await started(structuredClone(native.records), native.metadata); await untilPhase(bundle.handle, 'visits');
    for (let i = 0; i < 20; i++) {
      await advanceMonthlySemanticVerification(app.db, bundle.handle);
      const row = await saved(bundle.handle), cursor = JSON.parse(String(row.cursor_json));
      if (cursor.visit) {
        cursor.visit.fold.end = { corrupted: true };
        await app.db.prepare('UPDATE archive_semantic_runs SET cursor_json=? WHERE run_id=?').bind(JSON.stringify(cursor), bundle.handle.runId).run();
        await expect(advanceMonthlySemanticVerification(app.db, bundle.handle)).rejects.toThrow('CURSOR_INVALID'); return;
      }
    }
    throw new Error('Expected multi-page visit fold');
  });

  it('honors backup maintenance before and during a step without moving its cursor', async () => {
    const bundle = await started(), original = await saved(bundle.handle);
    await app.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    try { expect((await advanceMonthlySemanticVerification(app.db, bundle.handle)).status).toBe('paused'); } finally { await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run(); }
    let locked = false;
    const barrier = database(async <T,>(statements: IsolatedStatement[]) => {
      if (!locked && commitBatch(statements)) { locked = true; await app.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run(); }
      return app.db.batch<T>(statements);
    });
    try { expect((await advanceMonthlySemanticVerification(barrier, bundle.handle)).status).toBe('paused'); } finally { await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run(); }
    const after = await saved(bundle.handle); expect(after.cursor_json).toBe(original.cursor_json); expect(after.revision).toBe(original.revision);
    await app.db.prepare("UPDATE archive_semantic_runs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE run_id=?").bind(bundle.handle.runId).run();
    expect((await advanceMonthlySemanticVerification(app.db, bundle.handle)).status).toBe('pending');
  });

  it('invalidates completed proof handles and cleans derived tables in bounded FK order', async () => {
    const bundle = await started(structuredClone(native.records), native.metadata); await complete(bundle.handle);
    await bundle.target.discard();
    await expect(advanceMonthlySemanticVerification(app.db, bundle.handle)).rejects.toThrow('STALE');
    const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, bundle.target.handle), phases = new Set<string>();
    let done = false;
    for (let i = 0; i < 200 && !done; i++) { const result = await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup, 4); phases.add(result.phase); expect(result.deleted).toBeLessThanOrEqual(4); done = result.complete; }
    expect(done).toBe(true);
    for (const name of ['archive_semantic_review_witnesses', 'archive_semantic_operations', 'archive_semantic_visit_totals', 'archive_semantic_runs']) { expect(phases.has(name)).toBe(true); expect(await app.db.prepare(`SELECT count(*) n FROM ${name} WHERE run_id=?`).bind(bundle.handle.runId).first('n')).toBe(0); }
  });

  it('rejects restore before a checkpoint and before terminal success', async () => {
    const bundle = await started();
    let rotated = false;
    const restoring = database(async <T,>(statements: IsolatedStatement[]) => { if (!rotated && commitBatch(statements)) { rotated = true; await rotate(); } return app.db.batch<T>(statements); });
    await expect(advanceMonthlySemanticVerification(restoring, bundle.handle)).rejects.toThrow('STALE');
    expect((await saved(bundle.handle)).revision).toBe(0);
    await expect(advanceMonthlySemanticVerification(app.db, bundle.handle)).rejects.toThrow('STALE');
    // Recovery invalidates old-generation sessions before their bounded cleanup.
    await app.db.prepare("UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL WHERE verification_id=?").bind(bundle.target.handle.verificationId).run();
    // Complete the same lease revocation performed by the recovery reset before cleanup.
    await app.db.prepare("UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL WHERE verification_id=?").bind(bundle.target.handle.verificationId).run();
    await clear(bundle.target);
    const terminal = await started(); await untilPhase(terminal.handle, 'reviews');
    const terminalRestore = database(async <T,>(statements: IsolatedStatement[]) => {
      if (statements.some(statement => statement.sql.startsWith("UPDATE archive_semantic_sessions SET status='verified'"))) await rotate();
      return app.db.batch<T>(statements);
    });
    await expect(advanceMonthlySemanticVerification(terminalRestore, terminal.handle)).rejects.toThrow('STALE');
    expect(await app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(terminal.handle.verificationId).first('status')).toBe('frozen');
    expect((await saved(terminal.handle)).status).not.toBe('complete');
  });
});
