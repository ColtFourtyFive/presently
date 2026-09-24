import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, startMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { readArchiveStagingLifecycle, readNextDueArchiveStagingLifecycle } from '../worker/archive-staging-lifecycle';
import type { ArchiveRecord } from '../shared/archive-format';
import { createRuntime, projectRoot, type IsolatedStatement, type TestRuntime } from './runtime';

const master = randomBytes(32).toString('base64');
const at = '2025-01-02T00:00:00.000Z';
let app: TestRuntime | undefined;
afterEach(async () => { await app?.close(); app = undefined; });
const db = () => app!.db;
const count = async (table: string) => db().prepare(`SELECT count(*) n FROM ${table}`).first<number>('n');
const day = (value: string, days: number) => new Date(Date.parse(value) + days * 86_400_000).toISOString();
const metadata = (target: { handle: { verificationId: string; generation: string } }) => readArchiveStagingLifecycle(db(), target.handle);
async function runtime(migrate = true) { app = await createRuntime({ bindings: {}, migrate }); }
async function bundle() {
  const records: ArchiveRecord[] = [
    { table: 'centers', key: 'lifecycle-center', row: { id: 'lifecycle-center', name: 'Synthetic lifecycle', timezone: 'UTC', created_at: at } },
    { table: 'students', key: 'lifecycle-student', row: { id: 'lifecycle-student', center_id: 'lifecycle-center', student_code: 'LIFE', first_name: 'Synthetic', last_name: 'Lifecycle', subjects: '["Math"]', active: 1, created_at: at, updated_at: at } },
  ];
  const objects = new Map<string, Uint8Array>();
  const sealed = await createArchive(master, {
    archiveId: crypto.randomUUID(), centerId: 'lifecycle-center', month: '2025-01', timezone: 'UTC', kind: 'monthly',
    createdAt: '2025-02-02T00:00:00.000Z', applicationVersion: 'test', schemaVersions: [21], references: [],
    semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] },
  }, records, async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const reference = { archiveId: sealed.manifest.archiveId, kind: sealed.manifest.kind, manifestObjectKey: sealed.objectKey, manifestSha256: sealed.sha256 };
  return { ...sealed, reference, objects };
}
async function stage() {
  const source = await bundle(), target = await D1ArchiveSemanticStaging.create(db(), master, source.reference);
  await target.registerManifest(source.reference, source.encrypted);
  for (const part of source.manifest.parts) await target.stageEncryptedPart(source.manifest.archiveId, part.index, source.objects.get(part.objectKey)!);
  return { source, target };
}
async function migration(name: string) {
  return unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8')).map(sql => db().prepare(sql));
}

describe('private staging lifecycle bookkeeping', () => {
  it('creates immutable admission metadata without claiming progress or proof authority', async () => {
    await runtime();
    const source = await bundle(), target = await D1ArchiveSemanticStaging.create(db(), master, source.reference);
    const row = await metadata(target);
    expect(row).toEqual({
      verification_id: target.handle.verificationId, generation: target.handle.generation,
      admitted_at: row.admitted_at, last_progress_at: null, progress_revision: 0, revision: 0, verified_at: null,
      renewal_deadline_at: day(row.admitted_at, 14), migration_grace_until: null, due_at: day(row.admitted_at, 1),
      pause_reason: null, paused_at: null, next_eligible_at: null, resume_grace_until: null, renewed_at: null, renewal_count: 0, cleanup_lease_until: null,
    });
    expect(await readNextDueArchiveStagingLifecycle(db())).toBeNull();
    for (const name of ['centers', 'students', 'history_record_locations', 'archive_jobs']) expect(await count(name)).toBe(0);
    await expect(readArchiveStagingLifecycle(db(), { ...target.handle, verificationId: 'unknown' })).rejects.toThrow('LIFECYCLE_MISSING');
    await expect(readArchiveStagingLifecycle(db(), { ...target.handle, verificationId: '../bad' })).rejects.toThrow('HANDLE_INVALID');
  });

  it('records only new manifest/part checkpoints and rolls metadata back with failed part rows', async () => {
    await runtime();
    const source = await bundle(), target = await D1ArchiveSemanticStaging.create(db(), master, source.reference);
    await target.registerManifest(source.reference, source.encrypted);
    const first = await metadata(target);
    expect(first.progress_revision).toBe(1); expect(first.last_progress_at).not.toBeNull();
    await target.registerManifest(source.reference, source.encrypted);
    expect(await metadata(target)).toEqual(first);
    await db().prepare("CREATE TRIGGER lifecycle_test_rollback BEFORE INSERT ON archive_semantic_rows WHEN NEW.table_name='students' BEGIN SELECT RAISE(ABORT,'lifecycle_test_failure'); END").run();
    const part = source.manifest.parts[0], bytes = source.objects.get(part.objectKey)!;
    await expect(target.stageEncryptedPart(source.manifest.archiveId, 0, bytes)).rejects.toThrow('lifecycle_test_failure');
    expect(await metadata(target)).toEqual(first);
    expect(await count('archive_semantic_lifecycle')).toBe(1);
    expect(await count('archive_semantic_parts')).toBe(0); expect(await count('archive_semantic_rows')).toBe(0);
    await db().prepare('DROP TRIGGER lifecycle_test_rollback').run();
    const tokens = await Promise.all([target.stageEncryptedPart(source.manifest.archiveId, 0, bytes), target.stageEncryptedPart(source.manifest.archiveId, 0, bytes)]);
    expect(new Set(tokens).size).toBe(1);
    const second = await metadata(target);
    expect(second.progress_revision).toBe(2); expect(second.revision).toBe(2);
    expect(second.due_at).toBe(day(second.last_progress_at!, 1));
    await target.stageEncryptedPart(source.manifest.archiveId, 0, bytes);
    expect(await metadata(target)).toEqual(second);
  });

  it('ignores claims and rolled-back commits, records cursor/phase commits, and retains first verification on replay', async () => {
    await runtime();
    const { target } = await stage(), snapshot = await target.freeze();
    const handle = await startMonthlySemanticVerification(db(), { ...target.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
    const before = await metadata(target);
    let claims = 0, failed = false;
    const intercepted: ArchiveStagingDatabase<IsolatedStatement> = {
      prepare: sql => db().prepare(sql),
      async batch<T>(statements: IsolatedStatement[]) {
        if (!failed && statements.some(item => item.sql.startsWith('UPDATE archive_semantic_runs SET revision=CASE'))) {
          failed = true;
          return db().batch<T>([...statements, db().prepare('SELECT * FROM lifecycle_missing_rollback_table')]);
        }
        const result = await db().batch<T>(statements);
        if (statements.some(item => item.sql.startsWith("UPDATE archive_semantic_runs SET status='running'"))) {
          claims++; expect(await metadata(target)).toEqual(before);
        }
        return result;
      },
    };
    await expect(advanceMonthlySemanticVerification(intercepted, handle)).rejects.toThrow('lifecycle_missing_rollback_table');
    expect(claims).toBe(1); expect(failed).toBe(true); expect(await metadata(target)).toEqual(before);
    let finalRevision = 0;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await advanceMonthlySemanticVerification(db(), handle);
      expect(result.queries).toBeLessThanOrEqual(40);
      finalRevision = result.revision;
      const row = await metadata(target);
      expect(row.progress_revision).toBe(before.progress_revision + finalRevision);
      if (result.status === 'complete') break;
      expect(result.status).toBe('pending');
    }
    const complete = await metadata(target);
    expect(complete.verified_at).not.toBeNull(); expect(finalRevision).toBeGreaterThan(5);
    expect(await count('archive_semantic_lifecycle')).toBe(1);
    expect(complete.revision).toBe(complete.progress_revision + 1);
    expect(complete.due_at).toBe(day(complete.verified_at!, 1));
    expect((await advanceMonthlySemanticVerification(db(), handle)).status).toBe('complete');
    await target.finalize();
    expect(await metadata(target)).toEqual(complete);
  });

  it('records first full-verifier completion once and forbids immutable or unsupported metadata edits', async () => {
    await runtime();
    const { target } = await stage();
    await target.finalize();
    const complete = await metadata(target);
    expect(complete.verified_at).not.toBeNull(); expect(complete.progress_revision).toBe(2);
    await target.finalize(); expect(await metadata(target)).toEqual(complete);
    for (const assignment of [
      "verification_id='replacement'", "generation='replacement'", "admitted_at='2020-01-01T00:00:00.000Z'",
      "renewal_deadline_at='2999-01-01T00:00:00.000Z'", "migration_grace_until='2999-01-01T00:00:00.000Z'",
      'verified_at=NULL', "last_progress_at='2999-01-01T00:00:00.000Z'", 'progress_revision=progress_revision+2',
      "due_at='2999-01-01T00:00:00.000Z'",
    ]) await expect(db().prepare(`UPDATE archive_semantic_lifecycle SET ${assignment},revision=revision+1 WHERE verification_id=?`).bind(target.handle.verificationId).run()).rejects.toThrow('LIFECYCLE_INVALID');
    await expect(db().prepare('DELETE FROM archive_semantic_lifecycle WHERE verification_id=?').bind(target.handle.verificationId).run()).rejects.toThrow('PARENT_PRESENT');
    expect(await metadata(target)).toEqual(complete);
  });

  it('honors maintenance, preserves progress on invalidation, and atomically removes metadata on final parent cleanup', async () => {
    await runtime();
    const { target } = await stage(); await target.finalize();
    const complete = await metadata(target);
    await db().prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    try {
      await expect(target.discard()).rejects.toThrow('backup_maintenance');
      await expect(db().prepare('UPDATE archive_semantic_lifecycle SET revision=revision+1').run()).rejects.toThrow('backup_maintenance');
      await expect(db().prepare('DELETE FROM archive_semantic_lifecycle').run()).rejects.toThrow('backup_maintenance');
    } finally { await db().prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run(); }
    expect(await metadata(target)).toEqual(complete);
    await target.discard();
    const invalid = await metadata(target);
    expect(invalid).toEqual({ ...complete, revision: complete.revision + 1, due_at: invalid.due_at });
    expect(invalid.due_at <= new Date().toISOString()).toBe(true);
    expect((await readNextDueArchiveStagingLifecycle(db()))?.verification_id).toBe(target.handle.verificationId);
    const cleanup = await D1ArchiveSemanticStaging.beginCleanup(db(), target.handle);
    let done = false;
    for (let call = 0; call < 20; call++) {
      const result = await D1ArchiveSemanticStaging.cleanupPage(db(), cleanup, 1);
      expect(result.deleted).toBeLessThanOrEqual(1);
      if (result.complete) { expect(result.phase).toBe('archive_semantic_sessions'); expect(result.deleted).toBe(1); done = true; break; }
      expect(await count('archive_semantic_lifecycle')).toBe(1);
    }
    expect(done).toBe(true);
    expect(await count('archive_semantic_sessions')).toBe(0); expect(await count('archive_semantic_lifecycle')).toBe(0);
    expect((await db().prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    expect(await readNextDueArchiveStagingLifecycle(db())).toBeNull();
  });

  it('backfills overcapacity legacy work under maintenance with explicit grace and unknown progress, and rolls DDL back atomically', async () => {
    await runtime(false);
    for (const name of (await readdir(join(projectRoot, 'migrations'))).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 19).sort()) await db().batch(await migration(name));
    const source = await bundle();
    for (const id of ['legacy-active', 'legacy-verified', 'legacy-invalid']) {
      await db().prepare(`INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at)
        SELECT ?,generation,?,?,?,'staging',? FROM history_runtime WHERE id=1`).bind(id, source.reference.archiveId, source.reference.manifestSha256, JSON.stringify(source.reference), at).run();
    }
    await db().prepare("UPDATE archive_semantic_sessions SET status='frozen',commit_token='legacy-proof',graph_sha256=? WHERE verification_id='legacy-verified'").bind('a'.repeat(64)).run();
    await db().prepare("UPDATE archive_semantic_sessions SET status='verified' WHERE verification_id='legacy-verified'").run();
    await db().prepare("UPDATE archive_semantic_sessions SET status='invalid' WHERE verification_id='legacy-invalid'").run();
    await db().batch(await migration('0020_archive_staging_admission.sql'));
    const originals = await db().prepare('SELECT * FROM archive_semantic_sessions ORDER BY verification_id').all();
    await db().prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    const statements = await migration('0021_archive_staging_lifecycle.sql');
    await expect(db().batch([...statements, db().prepare('SELECT * FROM lifecycle_migration_failure')])).rejects.toThrow('lifecycle_migration_failure');
    expect(await db().prepare("SELECT count(*) n FROM sqlite_master WHERE name='archive_semantic_lifecycle'").first('n')).toBe(0);
    expect(await db().prepare('SELECT count(*) n FROM schema_versions WHERE version=21').first('n')).toBe(0);
    await db().batch(statements);
    expect((await db().prepare('SELECT * FROM archive_semantic_sessions ORDER BY verification_id').all()).results).toEqual(originals.results);
    for (const session of originals.results) {
      const row = await readArchiveStagingLifecycle(db(), { verificationId: String(session.verification_id), generation: String(session.generation) });
      expect(row.admitted_at).toBe(at); expect(row.last_progress_at).toBeNull(); expect(row.verified_at).toBeNull();
      expect(row.progress_revision).toBe(0); expect(row.revision).toBe(0);
      expect(row.renewal_deadline_at).toBe(day(at, 14));
      if (session.status === 'invalid') { expect(row.migration_grace_until).toBeNull(); expect(row.due_at <= new Date().toISOString()).toBe(true); }
      else { expect(row.migration_grace_until! > new Date().toISOString()).toBe(true); expect(row.due_at).toBe(row.migration_grace_until); }
    }
    await db().prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    const legacyVerified = originals.results.find(item => item.verification_id === 'legacy-verified')!;
    const legacyHandle = { verificationId: String(legacyVerified.verification_id), generation: String(legacyVerified.generation) };
    const unchanged = await readArchiveStagingLifecycle(db(), legacyHandle);
    // Nullable unknown timestamps must make unsupported shapes false, never
    // SQL NULL that causes a WHEN guard to silently skip its rejection.
    await expect(db().prepare("UPDATE archive_semantic_lifecycle SET due_at='2999-01-01T00:00:00.000Z',revision=revision+1 WHERE verification_id='legacy-verified'").run()).rejects.toThrow('LIFECYCLE_INVALID');
    expect(await readArchiveStagingLifecycle(db(), legacyHandle)).toEqual(unchanged);
    const queries: IsolatedStatement[] = [];
    const measured: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => db().prepare(sql), async batch<T>(items: IsolatedStatement[]) { queries.push(...items); return db().batch<T>(items); } };
    expect((await readNextDueArchiveStagingLifecycle(measured))?.verification_id).toBe('legacy-invalid');
    const query = queries[0];
    const plan = await db().prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.args).all<{ detail: string }>();
    expect(plan.results.map(item => item.detail).join(' ')).toContain('archive_semantic_lifecycle_due');
    expect(await count('archive_semantic_sessions')).toBe(3);
  });
});
