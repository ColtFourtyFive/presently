import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { ARCHIVE_TABLES, type ArchiveMetadata, type ArchiveRecord, type ArchiveReference } from '../shared/archive-format';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging, type ArchiveSemanticHandle, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { advanceMonthlySemanticVerification, MONTHLY_SEMANTIC_LIMITS, startMonthlySemanticVerification } from '../worker/archive-semantic-runner';
import { ARCHIVE_STAGING_ADMISSION as POLICY, type ArchiveStagingResult } from '../worker/archive-staging-admission';
import { createRuntime, projectRoot, type IsolatedStatement, type TestRuntime } from './runtime';

const master = randomBytes(32).toString('base64');
const at = '2025-01-02T12:00:00.000Z';
const limited = 'ARCHIVE_STAGING_ADMISSION_LIMIT';
const unavailable = 'ARCHIVE_STAGING_SIZE_UNAVAILABLE';
const capacity = 'ARCHIVE_STAGING_CAPACITY';
let app: TestRuntime | undefined;
type Bundle = Awaited<ReturnType<typeof bundle>>;

async function runtime(legacy = false) {
  app = await createRuntime({ bindings: {}, migrate: !legacy });
  if (legacy) for (const name of (await readdir(join(projectRoot, 'migrations'))).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 19).sort()) {
    await apply(name);
  }
  return app;
}
async function apply(name = '0020_archive_staging_admission.sql') {
  const sql = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
  await app!.db.batch(sql.map(text => app!.db.prepare(text)));
}
async function finishMigrationsAfterAdmission() {
  // Preserve migration-20 assertions, then install the schema required by the
  // current staging and cleanup APIs before using them against legacy state.
  for (const name of (await readdir(join(projectRoot, 'migrations'))).filter(name => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) > 20).sort()) await apply(name);
}
async function bundle(overrides: Partial<ArchiveMetadata> = {}) {
  const metadata: ArchiveMetadata = {
    archiveId: crypto.randomUUID(), centerId: 'admission-center', month: '2025-01', timezone: 'UTC', kind: 'monthly',
    createdAt: '2025-02-02T12:00:00.000Z', applicationVersion: 'test', schemaVersions: [20], references: [],
    semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] }, ...overrides,
  };
  const records: ArchiveRecord[] = [
    { table: 'centers', key: metadata.centerId, row: { id: metadata.centerId, name: 'Admission fixture', timezone: 'UTC', created_at: at } },
    { table: 'students', key: 'private-student', row: { id: 'private-student', center_id: metadata.centerId, student_code: 'PRIVATE', first_name: 'Private', last_name: 'Fixture', active: 1, subjects: '["Math"]', created_at: at, updated_at: at } },
  ];
  const objects = new Map<string, Uint8Array>();
  const sealed = await createArchive(master, metadata, records.sort(compareArchiveRecords), async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const reference: ArchiveReference = { archiveId: metadata.archiveId, kind: metadata.kind, manifestObjectKey: sealed.objectKey, manifestSha256: sealed.sha256 };
  return { ...sealed, records, objects, reference };
}
async function stage(source: Bundle, db: ArchiveStagingDatabase<IsolatedStatement> = app!.db) {
  const session = await D1ArchiveSemanticStaging.create(db, master, source.reference);
  await session.registerManifest(source.reference, source.encrypted);
  for (const part of source.manifest.parts) await session.stageEncryptedPart(source.manifest.archiveId, part.index, source.objects.get(part.objectKey)!);
  return session;
}
function metadata(change: (meta: ArchiveStagingResult['meta'], call: number) => ArchiveStagingResult['meta']): ArchiveStagingDatabase<IsolatedStatement> {
  let call = 0;
  return {
    prepare: sql => app!.db.prepare(sql),
    async batch<T>(statements: IsolatedStatement[]) {
      const results = await app!.db.batch<T>(statements), current = ++call;
      return results.map(result => ({ ...result, meta: change(result.meta, current) }));
    },
  };
}
async function count(table: string) { return await app!.db.prepare(`SELECT count(*) AS n FROM ${table}`).first<number>('n'); }
async function cleanup(handle: ArchiveSemanticHandle, db: ArchiveStagingDatabase<IsolatedStatement> = app!.db, limit = 64) {
  const token = await D1ArchiveSemanticStaging.beginCleanup(db, handle);
  for (let calls = 0; calls < 100; calls++) if ((await D1ArchiveSemanticStaging.cleanupPage(db, token, limit)).complete) return;
  throw new Error('cleanup did not finish');
}
async function rawSession(source: Bundle, admittedAt = at) {
  const verificationId = crypto.randomUUID();
  await app!.db.prepare(`INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at)
    SELECT ?,generation,?,?,?,'staging',? FROM history_runtime WHERE id=1`).bind(verificationId, source.reference.archiveId, source.reference.manifestSha256, JSON.stringify(source.reference), admittedAt).run();
  return { verificationId, generation: (await app!.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first<string>('generation'))! };
}
async function rawManifest(source: Bundle, handle: ArchiveSemanticHandle, changes: Record<string, unknown> = {}) {
  const manifest = { ...source.manifest, ...changes };
  await app!.db.prepare(`INSERT INTO archive_semantic_manifests(verification_id,generation,archive_id,manifest_sha256,manifest_json,plaintext_bytes,part_count,record_count)
    VALUES(?,?,?,?,?,?,?,?)`).bind(handle.verificationId, handle.generation, source.reference.archiveId, source.reference.manifestSha256, JSON.stringify(manifest), manifest.plaintextBytes, manifest.parts.length, manifest.recordCount).run();
}
afterEach(async () => { await app?.close(); app = undefined; });

describe('default private archive admission on native D1', () => {
  it('atomically admits one contender and preserves identical manifest/part retries', async () => {
    await runtime(); const source = await bundle();
    const attempts = await Promise.allSettled([D1ArchiveSemanticStaging.create(app!.db, master, source.reference), D1ArchiveSemanticStaging.create(app!.db, master, source.reference)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(String((attempts.find(result => result.status === 'rejected') as PromiseRejectedResult).reason)).toContain(limited);
    const session = (attempts.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<D1ArchiveSemanticStaging<IsolatedStatement>>).value;
    await session.registerManifest(source.reference, source.encrypted);
    await session.registerManifest(source.reference, source.encrypted);
    const part = source.manifest.parts[0], bytes = source.objects.get(part.objectKey)!;
    const tokens = await Promise.all([session.stageEncryptedPart(source.manifest.archiveId, 0, bytes), session.stageEncryptedPart(source.manifest.archiveId, 0, bytes)]);
    expect(new Set(tokens).size).toBe(1);
    expect(await count('archive_semantic_sessions')).toBe(1);
    expect(await count('archive_semantic_manifests')).toBe(1);
    expect(await count('archive_semantic_parts')).toBe(1);
    expect(await count('archive_semantic_rows')).toBe(2);
    await expect(rawSession(source)).rejects.toThrow(limited);
  });

  it('retains the slot through verified/invalid state and every partial cleanup page', async () => {
    await runtime(); const source = await bundle(), session = await stage(source);
    await session.finalize();
    await expect(D1ArchiveSemanticStaging.create(app!.db, master, source.reference)).rejects.toThrow(limited);
    await session.discard();
    const token = await D1ArchiveSemanticStaging.beginCleanup(app!.db, session.handle);
    let pages = 0;
    for (;;) {
      await expect(rawSession(source)).rejects.toThrow(limited);
      const result = await D1ArchiveSemanticStaging.cleanupPage(app!.db, token, 1); pages++;
      if (result.complete) break;
      expect(await count('archive_semantic_sessions')).toBe(1);
    }
    expect(pages).toBeGreaterThan(3);
    await expect(D1ArchiveSemanticStaging.create(app!.db, master, source.reference)).resolves.toHaveProperty('handle');
  });

  it('fails closed on missing, invalid, or explicitly nonprimary database sizes before inserting', async () => {
    await runtime(); const source = await bundle();
    for (const value of [undefined, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      const db = metadata(meta => value === undefined ? undefined : { ...meta, size_after: value });
      await expect(D1ArchiveSemanticStaging.create(db, master, source.reference)).rejects.toThrow(unavailable);
    }
    await expect(D1ArchiveSemanticStaging.create(metadata(meta => ({ ...meta, served_by_primary: false })), master, source.reference)).rejects.toThrow(unavailable);
    expect(await count('archive_semantic_sessions')).toBe(0);
  });

  it('applies the planning allowance only at admission and blocks over-watermark no-op retries', async () => {
    await runtime(); const source = await bundle();
    const threshold = POLICY.databaseWatermark - POLICY.planningBytes;
    await expect(D1ArchiveSemanticStaging.create(metadata(meta => ({ ...meta, size_after: threshold + 1 })), master, source.reference)).rejects.toThrow(capacity);
    const session = await D1ArchiveSemanticStaging.create(metadata(meta => ({ ...meta, size_after: threshold })), master, source.reference);
    const progress = await D1ArchiveSemanticStaging.resume(metadata(meta => ({ ...meta, size_after: POLICY.databaseWatermark })), master, session.handle);
    await progress.registerManifest(source.reference, source.encrypted);
    const part = source.manifest.parts[0], bytes = source.objects.get(part.objectKey)!;
    await progress.stageEncryptedPart(source.manifest.archiveId, 0, bytes);
    const over = await D1ArchiveSemanticStaging.resume(metadata(meta => ({ ...meta, size_after: POLICY.databaseWatermark + 1 })), master, session.handle);
    await expect(over.registerManifest(source.reference, source.encrypted)).rejects.toThrow(capacity);
    await expect(over.stageEncryptedPart(source.manifest.archiveId, 0, bytes)).rejects.toThrow(capacity);
    await expect(over.freeze()).rejects.toThrow(capacity);
    expect(await count('archive_semantic_rows')).toBe(2);
    const blind = metadata(() => undefined), diagnostic = await D1ArchiveSemanticStaging.resume(blind, master, session.handle);
    await diagnostic.discard();
    await cleanup(session.handle, blind, 1);
    expect(await count('archive_semantic_sessions')).toBe(0);
  });

  it('pauses pending and completed runners on missing/over-limit observations without changing proof state', async () => {
    await runtime(); const source = await bundle(), session = await stage(source), snapshot = await session.freeze();
    const identity = { ...session.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 };
    const run = await startMonthlySemanticVerification(app!.db, identity);
    await expect(startMonthlySemanticVerification(metadata(() => undefined), identity)).rejects.toThrow(unavailable);
    expect((await advanceMonthlySemanticVerification(metadata(() => undefined), run)).status).toBe('paused');
    expect(await app!.db.prepare('SELECT revision FROM archive_semantic_runs WHERE run_id=?').bind(run.runId).first('revision')).toBe(0);
    let result;
    for (let calls = 0; calls < 100; calls++) { result = await advanceMonthlySemanticVerification(app!.db, run); if (result.status === 'complete') break; }
    expect(result?.status).toBe('complete');
    const late = metadata((meta, call) => call === 1 ? meta : { ...meta, size_after: POLICY.databaseWatermark + 1 });
    expect((await advanceMonthlySemanticVerification(late, run)).status).toBe('paused');
    expect(await app!.db.prepare('SELECT status FROM archive_semantic_runs WHERE run_id=?').bind(run.runId).first('status')).toBe('complete');
    const over = await D1ArchiveSemanticStaging.resume(metadata(() => undefined), master, session.handle);
    await expect(over.finalize()).rejects.toThrow(unavailable);
    await expect(D1ArchiveSemanticStaging.openFrozenBaseSnapshot(metadata(() => undefined), identity)).rejects.toThrow(unavailable);
    await expect(app!.db.prepare(`INSERT INTO archive_semantic_runs(run_id,verification_id,generation,snapshot_commit_token,graph_sha256,validator_version,archive_id,header_json,status,phase,revision,cursor_json,created_at,updated_at)
      SELECT ?,verification_id,generation,snapshot_commit_token,graph_sha256,validator_version,archive_id,header_json,'pending','records',0,cursor_json,created_at,updated_at FROM archive_semantic_runs WHERE run_id=?`).bind(crypto.randomUUID(), run.runId).run()).rejects.toThrow(limited);
  });

  it.each([3, 4])('resumes after an unavailable size observation in batch %s of a leased step', async missingBatch => {
    await runtime(); const source = await bundle(), session = await stage(source), snapshot = await session.freeze();
    const run = await startMonthlySemanticVerification(app!.db, { ...session.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
    const interrupted = metadata((meta, call) => call === missingBatch ? undefined : meta);
    const paused = await advanceMonthlySemanticVerification(interrupted, run);
    expect(paused.status).toBe('paused');
    expect(paused.revision).toBe(0);
    expect(await app!.db.prepare('SELECT status,revision,error_code FROM archive_semantic_runs WHERE run_id=?').bind(run.runId).first())
      .toEqual({ status: 'running', revision: 0, error_code: null });
    expect(await count('archive_semantic_operations')).toBe(0);
    expect(await count('archive_semantic_visit_totals')).toBe(0);
    expect(await app!.db.prepare('SELECT status FROM archive_semantic_sessions').first('status')).toBe('frozen');
    // A later invocation may take over after the existing lease expires. The
    // resource pause preserves the checkpoint and does not invalidate proof.
    await app!.db.prepare("UPDATE archive_semantic_runs SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE run_id=?").bind(run.runId).run();
    const resumed = await advanceMonthlySemanticVerification(app!.db, run);
    expect(resumed.status).toBe('pending');
    expect(resumed.revision).toBe(1);
  });

  it('includes admission observations in the externally counted statement budget through cleanup', async () => {
    await runtime(); const source = await bundle(); let statements = 0;
    const measured: ArchiveStagingDatabase<IsolatedStatement> = {
      prepare: sql => app!.db.prepare(sql),
      async batch<T>(items: IsolatedStatement[]) { statements += items.length; return app!.db.batch<T>(items); },
    };
    const bounded = async <T>(action: () => Promise<T>, limit = MONTHLY_SEMANTIC_LIMITS.statements) => {
      const before = statements, result = await action();
      expect(statements - before).toBeLessThanOrEqual(limit);
      return result;
    };
    const session = await bounded(() => D1ArchiveSemanticStaging.create(measured, master, source.reference));
    await bounded(() => session.registerManifest(source.reference, source.encrypted));
    for (const part of source.manifest.parts) await bounded(() => session.stageEncryptedPart(source.manifest.archiveId, part.index, source.objects.get(part.objectKey)!));
    const snapshot = await bounded(() => session.freeze());
    const run = await bounded(() => startMonthlySemanticVerification(measured, { ...session.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 }));
    let complete = false;
    for (let calls = 0; calls < 100; calls++) {
      const before = statements, result = await bounded(() => advanceMonthlySemanticVerification(measured, run));
      expect(result.queries).toBe(statements - before);
      if (result.status === 'complete') { complete = true; break; }
    }
    expect(complete).toBe(true);
    await bounded(() => session.discard());
    const cleanupToken = await bounded(() => D1ArchiveSemanticStaging.beginCleanup(measured, session.handle));
    complete = false;
    for (let calls = 0; calls < 100; calls++) {
      const page = await bounded(() => D1ArchiveSemanticStaging.cleanupPage(measured, cleanupToken, 1));
      expect(page.deleted).toBeLessThanOrEqual(1);
      if (page.complete) { complete = true; break; }
    }
    expect(complete).toBe(true);
    expect(await count('archive_semantic_sessions')).toBe(0);
    for (const table of ['attendance_events', 'attendance_corrections', 'visits', 'history_record_locations']) expect(await count(table)).toBe(0);
  });

  it('guards exact plaintext/record bounds and unsupported profiles through direct SQL', async () => {
    await runtime(); const source = await bundle(), handle = await rawSession(source, new Date().toISOString());
    for (const changes of [
      { plaintextBytes: POLICY.plaintextBytes + 1 }, { recordCount: POLICY.records + 1 },
      { format: 'kumon-history-archive-v1' }, { kind: 'addendum' }, { references: [source.reference] },
    ]) await expect(rawManifest(source, handle, changes)).rejects.toThrow(limited);
    expect(await count('archive_semantic_manifests')).toBe(0);
    await rawManifest(source, handle, { plaintextBytes: POLICY.plaintextBytes, recordCount: POLICY.records });
    expect(await app!.db.prepare('SELECT count(*) AS n FROM archive_semantic_admitted_sessions').first('n')).toBe(1);
    await expect(rawManifest(source, handle)).rejects.toThrow(limited);
    await expect(D1ArchiveSemanticStaging.create(app!.db, master, { ...source.reference, kind: 'addendum' })).rejects.toThrow(limited);
  });

  it('rolls back a failed part without releasing or corrupting its resident slot', async () => {
    await runtime(); const source = await bundle(), session = await D1ArchiveSemanticStaging.create(app!.db, master, source.reference);
    await session.registerManifest(source.reference, source.encrypted);
    await app!.db.prepare("CREATE TRIGGER fail_admission_part BEFORE INSERT ON archive_semantic_rows WHEN NEW.table_name='students' BEGIN SELECT RAISE(ABORT,'admission_test_failure'); END").run();
    const part = source.manifest.parts[0], bytes = source.objects.get(part.objectKey)!;
    await expect(session.stageEncryptedPart(source.manifest.archiveId, 0, bytes)).rejects.toThrow('admission_test_failure');
    expect(await count('archive_semantic_parts')).toBe(0); expect(await count('archive_semantic_rows')).toBe(0);
    await expect(rawSession(source)).rejects.toThrow(limited);
    await app!.db.prepare('DROP TRIGGER fail_admission_part').run();
    await session.stageEncryptedPart(source.manifest.archiveId, 0, bytes);
    expect(await count('archive_semantic_rows')).toBe(2);
  });

  it('fences a generation change between physical preflight and session insertion', async () => {
    await runtime(); const source = await bundle(); let injected = false;
    const db: ArchiveStagingDatabase<IsolatedStatement> = {
      prepare: sql => app!.db.prepare(sql),
      async batch<T>(statements: IsolatedStatement[]) {
        if (!injected && statements.some(statement => statement.sql.includes('INSERT INTO archive_semantic_sessions'))) {
          injected = true;
          await app!.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
        }
        return app!.db.batch<T>(statements);
      },
    };
    await expect(D1ArchiveSemanticStaging.create(db, master, source.reference)).rejects.toThrow('STALE');
    expect(await count('archive_semantic_sessions')).toBe(0);
  });

  it('installs over legacy multiple sessions without deleting data and rejects work while cleanup remains available', async () => {
    await runtime(true); const source = await bundle(), first = await rawSession(source), second = await rawSession(source);
    await rawManifest(source, first); await rawManifest(source, second);
    await apply();
    expect(await count('archive_semantic_sessions')).toBe(2); expect(await count('archive_semantic_manifests')).toBe(2);
    await finishMigrationsAfterAdmission();
    expect(await count('archive_semantic_sessions')).toBe(2); expect(await count('archive_semantic_manifests')).toBe(2);
    const session = await D1ArchiveSemanticStaging.resume(app!.db, master, first);
    await expect(session.registerManifest(source.reference, source.encrypted)).rejects.toThrow(limited);
    await expect(session.stageEncryptedPart(source.manifest.archiveId, 0, source.objects.get(source.manifest.parts[0].objectKey)!)).rejects.toThrow(limited);
    await expect(session.freeze()).rejects.toThrow(limited);
    await expect(session.finalize()).rejects.toThrow(limited);
    await expect(rawSession(source)).rejects.toThrow(limited);
    await session.discard(); await cleanup(first, metadata(() => undefined), 1);
    const survivor = await D1ArchiveSemanticStaging.resume(app!.db, master, second);
    await survivor.registerManifest(source.reference, source.encrypted);
    await expect(rawSession(source)).rejects.toThrow(limited);
  });

  it('rejects an oversized retained manifest and a restored generation until final cleanup', async () => {
    await runtime(true); const source = await bundle(), handle = await rawSession(source);
    await rawManifest(source, handle, { recordCount: POLICY.records + 1 }); await apply();
    expect(await count('archive_semantic_sessions')).toBe(1);
    expect(await app!.db.prepare('SELECT record_count FROM archive_semantic_manifests').first('record_count')).toBe(POLICY.records + 1);
    await finishMigrationsAfterAdmission();
    expect(await count('archive_semantic_sessions')).toBe(1);
    expect(await app!.db.prepare('SELECT record_count FROM archive_semantic_manifests').first('record_count')).toBe(POLICY.records + 1);
    const session = await D1ArchiveSemanticStaging.resume(app!.db, master, handle);
    await expect(session.registerManifest(source.reference, source.encrypted)).rejects.toThrow(limited);
    await expect(session.freeze()).rejects.toThrow(limited);
    await app!.db.batch([
      app!.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1"),
      app!.db.prepare("UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL"),
    ]);
    await expect(D1ArchiveSemanticStaging.resume(app!.db, master, handle)).rejects.toThrow('STALE');
    await expect(rawSession(source)).rejects.toThrow(limited);
    await cleanup(handle, metadata(() => undefined), 1);
    const next = await D1ArchiveSemanticStaging.create(app!.db, master, source.reference);
    expect(next.handle.generation).not.toBe(handle.generation);
  });
});
