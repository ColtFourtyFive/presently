import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging as Staging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { archiveCleanupReceiptIdentity } from '../worker/archive-staging-controls';
import { createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

const master = randomBytes(32).toString('base64');
let app: TestRuntime;
afterEach(async () => { await app?.close(); });
const count = async (table: string) => app.db.prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');
const lifecycle = async () => app.db.prepare('SELECT * FROM archive_semantic_lifecycle').first();
async function fixture() {
  app = await createRuntime({ bindings: {}, r2: true });
  const objects = new Map<string, Uint8Array>();
  const archive = await createArchive(master, {
    archiveId: crypto.randomUUID(), centerId: 'cleanup-center', month: '2025-01', timezone: 'UTC', kind: 'monthly',
    createdAt: '2025-02-02T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [22], references: [],
    semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] },
  }, [{ table: 'centers', key: 'cleanup-center', row: { id: 'cleanup-center', name: 'Synthetic cleanup', timezone: 'UTC', created_at: '2025-01-01T00:00:00.000Z' } }],
  async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const reference = { archiveId: archive.manifest.archiveId, kind: archive.manifest.kind, manifestObjectKey: archive.objectKey, manifestSha256: archive.sha256 };
  const target = await Staging.create(app.db, master, reference);
  await target.registerManifest(reference, archive.encrypted);
  for (const part of archive.manifest.parts) await target.stageEncryptedPart(archive.manifest.archiveId, part.index, objects.get(part.objectKey)!);
  await target.discard();
  return { target, reference };
}
function wrapped(batch: ArchiveStagingDatabase<IsolatedStatement>['batch']): ArchiveStagingDatabase<IsolatedStatement> {
  return { prepare: sql => app.db.prepare(sql), batch };
}
const isPageRead = (statements: IsolatedStatement[]) => statements[0]?.sql === 'SELECT generation FROM history_runtime WHERE id=1' && statements.length > 3;
const isPageWrite = (statements: IsolatedStatement[]) => statements.at(-1)?.sql.includes('checkpoint_ok');
async function rotateGeneration() { await app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1").run(); }

describe('leased archive cleanup', () => {
  it('allows one claimant and cannot replace a live owner token', async () => {
    const { target } = await fixture();
    const results = await Promise.allSettled([Staging.beginCleanup(app.db, target.handle), Staging.beginCleanup(app.db, target.handle)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const owner = results.find(result => result.status === 'fulfilled')!;
    if (owner.status !== 'fulfilled') throw new Error('missing owner');
    expect(await count('archive_semantic_diagnostics')).toBe(1);
    expect(await app.db.prepare('SELECT cleanup_token FROM archive_semantic_sessions').first('cleanup_token')).toBe(owner.value.cleanupToken);
    await expect(Staging.beginCleanup(app.db, target.handle)).rejects.toThrow();
    await expect(Staging.cleanupPage(app.db, owner.value)).resolves.toMatchObject({ deleted: 1, complete: false });
  });

  it('rolls back the losing page when two calls capture the same revision', async () => {
    const { target } = await fixture(), handle = await Staging.beginCleanup(app.db, target.handle);
    let release!: () => void, arrived = 0;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const database = wrapped(async <T,>(statements: IsolatedStatement[]) => {
      const result = await app.db.batch<T>(statements);
      if (isPageRead(statements)) { if (++arrived === 2) release(); await barrier; }
      return result;
    });
    const before = await lifecycle();
    const results = await Promise.allSettled([Staging.cleanupPage(database, handle), Staging.cleanupPage(database, handle)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && String(rejected.reason)).toContain('CLEANUP_STALE');
    expect((await lifecycle())?.revision).toBe(Number(before?.revision) + 1);
    expect(await count('archive_semantic_rows')).toBe(0);
    expect(await count('archive_semantic_parts')).toBe(1);
    expect(await count('archive_semantic_sessions')).toBe(1);
  });

  it('requires a fresh owner after native lease expiry and rejects the old token', async () => {
    const { target } = await fixture(), old = await Staging.beginCleanup(app.db, target.handle);
    await new Promise(resolve => setTimeout(resolve, 30_200));
    await expect(Staging.cleanupPage(app.db, old)).rejects.toThrow('CLEANUP_STALE');
    const current = await Staging.beginCleanup(app.db, target.handle);
    expect(current.cleanupToken).not.toBe(old.cleanupToken);
    await expect(Staging.cleanupPage(app.db, old)).rejects.toThrow('CLEANUP_STALE');
    await expect(Staging.cleanupPage(app.db, current)).resolves.toMatchObject({ deleted: 1, complete: false });
  }, 45_000);

  it('rolls back deletion when a checkpoint loses CAS and completion when its parent deletion fails', async () => {
    const { target } = await fixture(), handle = await Staging.beginCleanup(app.db, target.handle);
    const before = await lifecycle();
    let failFinal = false;
    const database = wrapped(async <T,>(statements: IsolatedStatement[]) => app.db.batch<T>(statements.map(statement => {
      const selected = failFinal ? statement.sql.startsWith('DELETE FROM archive_semantic_sessions') : statement.sql.startsWith('UPDATE archive_semantic_lifecycle SET revision=revision+1');
      return selected ? app.db.prepare(`${statement.sql} AND 0`).bind(...statement.args) : statement;
    })));
    await expect(Staging.cleanupPage(database, handle)).rejects.toThrow('CLEANUP_STALE');
    expect(await count('archive_semantic_rows')).toBe(1);
    expect(await lifecycle()).toEqual(before);
    for (let i = 0; i < 3; i++) await Staging.cleanupPage(app.db, handle);
    failFinal = true;
    await expect(Staging.cleanupPage(database, handle)).rejects.toThrow('CLEANUP_STALE');
    expect(await count('archive_semantic_sessions')).toBe(1);
    expect(await count('archive_semantic_lifecycle')).toBe(1);
    expect(await app.db.prepare("SELECT count(*) n FROM archive_semantic_diagnostics WHERE kind='cleanup_complete'").first('n')).toBe(0);
    await expect(Staging.cleanupPage(app.db, handle)).resolves.toMatchObject({ complete: true });
  });

  it('fences maintenance and restored generations injected between read and deletion', async () => {
    const { target } = await fixture(), handle = await Staging.beginCleanup(app.db, target.handle);
    const before = await lifecycle();
    let restoration = false;
    const database = wrapped(async <T,>(statements: IsolatedStatement[]) => {
      if (isPageWrite(statements)) {
        if (restoration) await rotateGeneration();
        else await app.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
      }
      return app.db.batch<T>(statements);
    });
    await expect(Staging.cleanupPage(database, handle)).rejects.toThrow('backup_maintenance');
    expect(await count('archive_semantic_rows')).toBe(1);
    expect(await lifecycle()).toEqual(before);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    restoration = true;
    await expect(Staging.cleanupPage(database, handle)).rejects.toThrow('CLEANUP_STALE');
    expect(await count('archive_semantic_rows')).toBe(1);
    expect(await lifecycle()).toEqual(before);
  });

  it('replays lost completion read-only, with exact token and current execution generation', async () => {
    const { target, reference } = await fixture(), handle = await Staging.beginCleanup(app.db, target.handle);
    const input = { ...handle }, pending = Staging.cleanupPage(app.db, input);
    input.cleanupToken = 'mutated-after-call'; input.verificationId = 'mutated-after-call';
    await expect(pending).resolves.toMatchObject({ deleted: 1 });
    await expect(Staging.create(app.db, master, reference)).rejects.toThrow();
    for (let i = 0; i < 2; i++) await Staging.cleanupPage(app.db, handle);
    const lostResponse = wrapped(async <T,>(statements: IsolatedStatement[]) => {
      const result = await app.db.batch<T>(statements);
      if (isPageWrite(statements)) throw new Error('synthetic response lost after commit');
      return result;
    });
    await expect(Staging.cleanupPage(lostResponse, handle)).rejects.toThrow('response lost');
    expect(await count('archive_semantic_sessions')).toBe(0);
    expect(await count('archive_semantic_lifecycle')).toBe(0);
    const readOnly = wrapped(async <T,>(statements: IsolatedStatement[]) => {
      expect(statements.every(statement => statement.sql.startsWith('SELECT'))).toBe(true);
      return app.db.batch<T>(statements);
    });
    await expect(Staging.cleanupPage(readOnly, handle)).resolves.toEqual({ phase: 'archive_semantic_sessions', deleted: 1, complete: true });
    await expect(Staging.cleanupPage(app.db, { ...handle, cleanupToken: crypto.randomUUID() })).rejects.toThrow('CLEANUP_STALE');
    await expect(Staging.cleanupPage(app.db, { ...handle, generation: 'another-original' })).rejects.toThrow('CLEANUP_STALE');
    const identity = await archiveCleanupReceiptIdentity(handle);
    expect(await app.db.prepare('SELECT cleanup_token_sha256 FROM archive_semantic_diagnostics WHERE event_id=?').bind(identity.eventId).first('cleanup_token_sha256')).toBe(identity.tokenSha256);
    await rotateGeneration();
    await expect(Staging.cleanupPage(app.db, handle)).rejects.toThrow('CLEANUP_STALE');
    for (const table of ['centers', 'students', 'visits', 'history_record_locations', 'archive_jobs']) expect(await count(table)).toBe(0);
    expect((await (await app.runtime.getR2Bucket('BACKUP_BUCKET')).list()).objects).toHaveLength(0);
    await expect(Staging.create(app.db, master, reference)).resolves.toBeDefined();
  });
});
