import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging, type ArchiveSemanticHandle, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { startMonthlySemanticVerification, advanceMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { archiveCleanupReceiptIdentity, claimArchiveStagingCleanup, expireArchiveStaging, pauseArchiveStaging, readNextArchiveStagingExpiry, renewArchiveStaging, resumeArchiveStaging, type ArchiveStagingControlledLifecycle } from '../worker/archive-staging-controls';
import type { ArchiveRecord } from '../shared/archive-format';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

let app: TestRuntime;
const key = randomBytes(32).toString('base64'), at = '2025-01-02T00:00:00.000Z';
beforeEach(async () => { app = await createRuntime({ bindings: {} }); });
afterEach(async () => { await app.close(); });
async function bundle() {
  const records: ArchiveRecord[] = [
    { table: 'centers', key: 'control-center', row: { id: 'control-center', name: 'Synthetic controls', timezone: 'UTC', created_at: at } },
    { table: 'students', key: 'control-student', row: { id: 'control-student', center_id: 'control-center', student_code: 'CONTROL', first_name: 'Synthetic', last_name: 'Controls', subjects: '["Math"]', active: 1, created_at: at, updated_at: at } },
  ];
  const parts = new Map<string, Uint8Array>();
  const result = await createArchive(key, { archiveId: crypto.randomUUID(), centerId: 'control-center', month: '2025-01', timezone: 'UTC', kind: 'monthly', createdAt: '2025-02-02T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [22], references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] } }, records, async (part, bytes) => { parts.set(part.objectKey, bytes); });
  return { ...result, parts, reference: { archiveId: result.manifest.archiveId, kind: result.manifest.kind, manifestObjectKey: result.objectKey, manifestSha256: result.sha256 } };
}
async function life(handle: ArchiveSemanticHandle) { return (await app.db.prepare('SELECT * FROM archive_semantic_lifecycle WHERE verification_id=? AND generation=?').bind(handle.verificationId, handle.generation).first<ArchiveStagingControlledLifecycle>())!; }
async function identity(handle: ArchiveSemanticHandle) { return { ...handle, executionGeneration: (await app.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation'))!, expectedRevision: (await life(handle)).revision }; }
async function fresh(offset?: string) {
  const source = await bundle();
  let target: D1ArchiveSemanticStaging<IsolatedStatement>;
  if (!offset) target = await D1ArchiveSemanticStaging.create(app.db, key, source.reference);
  else {
    const id = crypto.randomUUID();
    await app.db.prepare(`INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at)
      SELECT ?,generation,?,?,?,'staging',strftime('%Y-%m-%dT%H:%M:%fZ','now',?) FROM history_runtime WHERE id=1`).bind(id, source.reference.archiveId, source.reference.manifestSha256, JSON.stringify(source.reference), offset).run();
    target = await D1ArchiveSemanticStaging.resume(app.db, key, { verificationId: id, generation: (await app.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation'))! });
  }
  return { source, target };
}
async function frozen() {
  const result = await fresh();
  await result.target.registerManifest(result.source.reference, result.source.encrypted);
  for (const part of result.source.manifest.parts) await result.target.stageEncryptedPart(result.source.manifest.archiveId, part.index, result.source.parts.get(part.objectKey)!);
  return { ...result, snapshot: await result.target.freeze() };
}
const next = (milliseconds = 86_400_000) => new Date(Date.now() + milliseconds).toISOString();
const count = (table: string) => app.db.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');

describe('internal staging lifecycle controls', () => {
  it('pauses once, rejects changed retry payloads, resumes after eligibility without invented progress, and blocks direct work', async () => {
    const { target, source } = await fresh(), original = await life(target.handle);
    const input = { ...await identity(target.handle), operationId: crypto.randomUUID(), reason: 'daily_budget' as const, nextEligibleAt: next(1200) };
    const paused = await pauseArchiveStaging(app.db, input), saved = await life(target.handle);
    expect(paused.replayed).toBe(false); expect(saved.progress_revision).toBe(0); expect(saved.last_progress_at).toBeNull();
    expect((await pauseArchiveStaging(app.db, input)).replayed).toBe(true); expect(await life(target.handle)).toEqual(saved);
    await expect(pauseArchiveStaging(app.db, { ...input, nextEligibleAt: next() })).rejects.toThrow('OPERATION_CONFLICT');
    await expect(target.registerManifest(source.reference, source.encrypted)).rejects.toThrow('PAUSED');
    expect(await expireArchiveStaging(app.db, { ...await identity(target.handle), dueAt: saved.due_at })).toEqual({ status: 'stale' });
    const resumeInput = { ...await identity(target.handle), operationId: crypto.randomUUID() };
    await expect(resumeArchiveStaging(app.db, resumeInput)).rejects.toThrow('STALE');
    await new Promise(resolve => setTimeout(resolve, 1250));
    const candidate = await readNextArchiveStagingExpiry(app.db);
    expect(candidate).not.toBeNull(); expect(await expireArchiveStaging(app.db, candidate!)).toEqual({ status: 'resume_due' });
    const resumed = await resumeArchiveStaging(app.db, resumeInput), after = await life(target.handle);
    expect(resumed.replayed).toBe(false); expect(after.pause_reason).toBeNull(); expect(after.resume_grace_until).not.toBeNull();
    expect(after.admitted_at).toBe(original.admitted_at); expect(after.last_progress_at).toBeNull(); expect(after.progress_revision).toBe(0);
    await target.registerManifest(source.reference, source.encrypted);
    expect((await life(target.handle)).progress_revision).toBe(1);
    expect(await count('archive_semantic_diagnostics')).toBe(2);
  });

  it.each([false, true])('scopes a concurrently committed duplicate receipt to the current generation, rotated=%s', async rotate => {
    const { target } = await fresh();
    const input = { ...await identity(target.handle), operationId: crypto.randomUUID(), reason: 'maintenance' as const, nextEligibleAt: next() };
    let winner: Awaited<ReturnType<typeof pauseArchiveStaging>> | undefined;
    const delayed: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (!winner && statements.some(item => item.sql.startsWith('UPDATE archive_semantic_lifecycle AS l SET pause_reason='))) {
        winner = await pauseArchiveStaging(app.db, input);
        if (rotate) await app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
      }
      return app.db.batch<T>(statements);
    } };
    const result = pauseArchiveStaging(delayed, input);
    if (rotate) await expect(result).rejects.toThrow('STALE');
    else expect(await result).toEqual({ ...winner, replayed: true });
    expect(winner).toBeDefined();
    expect(await count('archive_semantic_diagnostics')).toBe(1);
    expect((await life(target.handle)).revision).toBe(1);
  });

  it('renews within 14 days once per operation, preserves idle history, and loses expiry races by revision', async () => {
    const { target } = await fresh('-25 hours'), original = await life(target.handle);
    const candidate = await readNextArchiveStagingExpiry(app.db); expect(candidate).not.toBeNull();
    const input = { ...await identity(target.handle), operationId: crypto.randomUUID(), actorId: 'test-owner', reason: 'CONTINUE_VERIFICATION' };
    const receipt = await renewArchiveStaging(app.db, input), renewed = await life(target.handle);
    expect(renewed.admitted_at).toBe(original.admitted_at); expect(renewed.last_progress_at).toBeNull();
    expect(renewed.progress_revision).toBe(0); expect(renewed.renewal_count).toBe(1); expect(renewed.due_at).toBe(original.due_at);
    expect(Date.parse(renewed.renewal_deadline_at) - Date.parse(renewed.renewed_at!)).toBe(14 * 86_400_000);
    expect(await renewArchiveStaging(app.db, input)).toEqual({ ...receipt, replayed: true });
    expect(await life(target.handle)).toEqual(renewed);
    expect(await expireArchiveStaging(app.db, candidate!)).toEqual({ status: 'stale' });
    const current = await readNextArchiveStagingExpiry(app.db);
    expect(await expireArchiveStaging(app.db, current!)).toEqual({ status: 'expired' });
    await expect(renewArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID(), actorId: 'test-owner', reason: 'CONTINUE_VERIFICATION' })).rejects.toThrow('STALE');
    expect((await life(target.handle)).verified_at).toBeNull();
    const diagnostic = await app.db.prepare("SELECT detail_json FROM archive_semantic_diagnostics WHERE kind='renew'").first<string>('detail_json');
    expect(JSON.parse(diagnostic!)).toMatchObject({ priorRenewalDeadlineAt: original.renewal_deadline_at, newRenewalDeadlineAt: renewed.renewal_deadline_at });
  });

  it('lets accepted progress win a stale expiry and makes expiry prevent later work', async () => {
    const { target, source } = await fresh('-25 hours');
    const candidate = (await readNextArchiveStagingExpiry(app.db))!;
    await target.registerManifest(source.reference, source.encrypted);
    expect(await expireArchiveStaging(app.db, candidate)).toEqual({ status: 'stale' });
    expect(await readNextArchiveStagingExpiry(app.db)).toBeNull();
    // A separate old session tests the opposite ordering without weakening admission.
    await target.discard(); const cleanup = await claimArchiveStagingCleanup(app.db, target.handle);
    for (let page = 0; page < 20; page++) if ((await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).complete) break;
    const old = await fresh('-25 hours');
    expect(await expireArchiveStaging(app.db, (await readNextArchiveStagingExpiry(app.db))!)).toEqual({ status: 'expired' });
    await expect(old.target.registerManifest(old.source.reference, old.source.encrypted)).rejects.toThrow('STALE');
    expect(await count('archive_semantic_manifests')).toBe(0);
  });

  it('rejects pause under a live runner lease, returns paused without invalidating proof, and forbids verified holds', async () => {
    const { target, snapshot } = await frozen();
    const handle = await startMonthlySemanticVerification(app.db, { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
    const before = await life(target.handle);
    await app.db.prepare("UPDATE archive_semantic_runs SET status='running',lease_token='test-lease',lease_expires_at=? WHERE run_id=?").bind(next(30_000), handle.runId).run();
    await expect(pauseArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID(), reason: 'maintenance', nextEligibleAt: next() })).rejects.toThrow('BUSY');
    expect(await life(target.handle)).toEqual(before);
    await app.db.prepare("UPDATE archive_semantic_runs SET status='pending',lease_token=NULL,lease_expires_at=NULL WHERE run_id=?").bind(handle.runId).run();
    await pauseArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID(), reason: 'maintenance', nextEligibleAt: next(1200) });
    expect((await advanceMonthlySemanticVerification(app.db, handle)).status).toBe('paused');
    expect(await app.db.prepare('SELECT status FROM archive_semantic_sessions').first('status')).toBe('frozen');
    expect(await app.db.prepare('SELECT status,revision,lease_token FROM archive_semantic_runs WHERE run_id=?').bind(handle.runId).first()).toEqual({ status: 'pending', revision: 0, lease_token: null });
    await new Promise(resolve => setTimeout(resolve, 1250));
    await resumeArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID() });
    for (let step = 0; step < 100; step++) if ((await advanceMonthlySemanticVerification(app.db, handle)).status === 'complete') break;
    const verified = await life(target.handle); expect(verified.verified_at).not.toBeNull();
    await expect(pauseArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID(), reason: 'capacity', nextEligibleAt: next() })).rejects.toThrow('STALE');
    await expect(renewArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID(), actorId: 'test-owner', reason: 'CONTINUE_VERIFICATION' })).rejects.toThrow('STALE');
    expect(await life(target.handle)).toEqual(verified);
  });

  it('pauses a runner racing its claim without invalidating or advancing its checkpoint', async () => {
    const { target, snapshot } = await frozen();
    const handle = await startMonthlySemanticVerification(app.db, { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
    let injected = false;
    const racing: ArchiveStagingDatabase<IsolatedStatement> = {
      prepare: sql => app.db.prepare(sql),
      async batch<T>(statements: IsolatedStatement[]) {
        if (!injected && statements.some(item => item.sql.startsWith("UPDATE archive_semantic_runs SET status='running'"))) {
          injected = true;
          await pauseArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID(), reason: 'capacity', nextEligibleAt: next() });
        }
        return app.db.batch<T>(statements);
      },
    };
    expect((await advanceMonthlySemanticVerification(racing, handle)).status).toBe('paused');
    expect(injected).toBe(true);
    expect(await app.db.prepare('SELECT status,revision,lease_token,error_code FROM archive_semantic_runs WHERE run_id=?').bind(handle.runId).first()).toEqual({ status: 'pending', revision: 0, lease_token: null, error_code: null });
    expect(await app.db.prepare('SELECT status FROM archive_semantic_sessions').first('status')).toBe('frozen');
    expect((await life(target.handle)).progress_revision).toBe(2);
  });

  it('defers cleanup while an invalidated worker lease remains active', async () => {
    const { target, snapshot } = await frozen();
    const handle = await startMonthlySemanticVerification(app.db, { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
    await app.db.prepare("UPDATE archive_semantic_runs SET status='running',lease_token='old-worker',lease_expires_at=? WHERE run_id=?").bind(next(30_000), handle.runId).run();
    await target.discard();
    const invalid = await life(target.handle);
    await expect(claimArchiveStagingCleanup(app.db, target.handle)).rejects.toThrow('BUSY');
    expect(await life(target.handle)).toEqual(invalid); expect(await count('archive_semantic_diagnostics')).toBe(0);
    await app.db.prepare("UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL WHERE run_id=?").bind(handle.runId).run();
    await expect(claimArchiveStagingCleanup(app.db, target.handle)).resolves.toHaveProperty('cleanupToken');
  });

  it('claims one cleanup capability atomically, preserves token across pages, and retains scoped diagnostics', async () => {
    const { target } = await frozen(); await target.discard();
    const attempts = await Promise.allSettled([claimArchiveStagingCleanup(app.db, target.handle), claimArchiveStagingCleanup(app.db, target.handle)]);
    expect(attempts.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    const handle = (attempts.find(item => item.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof claimArchiveStagingCleanup>>>).value;
    const claim = await archiveCleanupReceiptIdentity(handle, 'cleanup_claim');
    const event = await app.db.prepare('SELECT * FROM archive_semantic_diagnostics WHERE event_id=?').bind(claim.eventId).first();
    expect(event).toMatchObject({ execution_generation: handle.cleanupGeneration, cleanup_token_sha256: claim.tokenSha256, request_sha256: claim.requestSha256 });
    const before = await life(target.handle);
    expect((await D1ArchiveSemanticStaging.cleanupPage(app.db, handle, 1)).deleted).toBe(1);
    const after = await life(target.handle);
    expect(after.revision).toBe(before.revision + 1); expect(after.progress_revision).toBe(before.progress_revision); expect(after.last_progress_at).toBe(before.last_progress_at);
    expect(await app.db.prepare('SELECT cleanup_token FROM archive_semantic_sessions').first('cleanup_token')).toBe(handle.cleanupToken);
    for (let page = 0; page < 30; page++) if ((await D1ArchiveSemanticStaging.cleanupPage(app.db, handle, 1)).complete) break;
    expect(await count('archive_semantic_sessions')).toBe(0); expect(await count('archive_semantic_lifecycle')).toBe(0);
    expect(await count('archive_semantic_diagnostics')).toBe(2);
    const again = await D1ArchiveSemanticStaging.cleanupPage(app.db, handle, 1);
    expect(again).toEqual({ phase: 'archive_semantic_sessions', deleted: 1, complete: true });
    expect(await count('archive_semantic_diagnostics')).toBe(2);
  });

  it('rolls control receipts and mutations back together and preserves exact input scope across await boundaries', async () => {
    const { target } = await fresh(), before = await life(target.handle);
    await app.db.prepare("CREATE TRIGGER fail_control_receipt BEFORE INSERT ON archive_semantic_diagnostics WHEN NEW.kind='pause' BEGIN SELECT RAISE(ABORT,'control_receipt_failure'); END").run();
    await expect(pauseArchiveStaging(app.db, { ...await identity(target.handle), operationId: crypto.randomUUID(), reason: 'capacity', nextEligibleAt: next() })).rejects.toThrow('control_receipt_failure');
    expect(await life(target.handle)).toEqual(before); expect(await count('archive_semantic_diagnostics')).toBe(0);
    await app.db.prepare('DROP TRIGGER fail_control_receipt').run();
    const input = { ...await identity(target.handle), operationId: String(crypto.randomUUID()), reason: 'maintenance' as const, nextEligibleAt: next() };
    const savedId = input.operationId;
    const promise = pauseArchiveStaging(app.db, input);
    input.operationId = 'changed-operation'; input.verificationId = 'changed-session'; input.expectedRevision = 999; input.nextEligibleAt = '2999-01-01T00:00:00.000Z';
    expect((await promise).operationId).toBe(savedId);
    expect((await life(target.handle)).pause_reason).toBe('maintenance');
    expect(await app.db.prepare('SELECT event_id FROM archive_semantic_diagnostics').first('event_id')).toBe(savedId);
  });

  it('cannot borrow a competing cleanup claim after a failed compare-and-swap', async () => {
    const { target } = await frozen(); await target.discard();
    let winner: Awaited<ReturnType<typeof claimArchiveStagingCleanup>> | undefined;
    const delayed: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), async batch<T>(statements: IsolatedStatement[]) {
      if (!winner && statements.some(item => item.sql.startsWith('UPDATE archive_semantic_sessions AS s SET cleanup_generation'))) winner = await claimArchiveStagingCleanup(app.db, target.handle);
      return app.db.batch<T>(statements);
    } };
    await expect(claimArchiveStagingCleanup(delayed, target.handle)).rejects.toThrow('BUSY');
    expect(winner).toBeDefined();
    expect(await app.db.prepare('SELECT cleanup_token FROM archive_semantic_sessions').first('cleanup_token')).toBe(winner!.cleanupToken);
    expect(await count('archive_semantic_diagnostics')).toBe(1);
    expect((await life(target.handle)).revision).toBe(4); // manifest, part, invalidation, successful claim
  });

  it('blocks controls during maintenance and rejects old execution-generation capabilities without rewriting history', async () => {
    const { target } = await fresh();
    const input = { ...await identity(target.handle), operationId: crypto.randomUUID(), actorId: 'test-owner', reason: 'CONTINUE_VERIFICATION' };
    const before = await life(target.handle);
    await app.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    await expect(renewArchiveStaging(app.db, input)).rejects.toThrow('backup_maintenance');
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    expect(await life(target.handle)).toEqual(before);
    await app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    await expect(renewArchiveStaging(app.db, input)).rejects.toThrow('STALE');
    expect(await life(target.handle)).toEqual(before);
  });
});
