import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { ARCHIVE_LIMITS, type ArchiveMetadata, type ArchiveRecord, type ArchiveReference } from '../shared/archive-format';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging, type ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import { projectRoot, createRuntime, type IsolatedStatement, type TestRuntime } from './runtime';

const master = randomBytes(32).toString('base64');
const at = '2025-01-02T12:00:00.000Z';
let app: TestRuntime;
const rootRecords = (): ArchiveRecord[] => [
  { table: 'centers', key: 'private-center', row: { id: 'private-center', name: 'Private fixture', timezone: 'UTC', created_at: at } },
  ...Array.from({ length: 4 }, (_, index): ArchiveRecord => {
    const id = `student-${String(index).padStart(3, '0')}`;
    return { table: 'students', key: id, row: { id, center_id: 'private-center', student_code: id, first_name: 'Private', last_name: 'Fixture', active: 1, subjects: '["Math"]', created_at: at, updated_at: at } };
  }),
];
async function fixture(records = rootRecords(), overrides: Partial<ArchiveMetadata> = {}) {
  const metadata: ArchiveMetadata = { archiveId: crypto.randomUUID(), centerId: 'private-center', month: '2025-01', timezone: 'UTC', kind: 'monthly', createdAt: '2025-02-02T12:00:00.000Z', applicationVersion: 'test', schemaVersions: [18], references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] }, ...overrides };
  const objects = new Map<string, Uint8Array>();
  const sealed = await createArchive(master, metadata, records.sort(compareArchiveRecords), async (part, bytes) => { objects.set(part.objectKey, bytes); });
  const reference: ArchiveReference = { archiveId: metadata.archiveId, kind: metadata.kind, manifestObjectKey: sealed.objectKey, manifestSha256: sealed.sha256 };
  return { ...sealed, metadata, reference, objects };
}
async function stage(bundle: Awaited<ReturnType<typeof fixture>>, database: ArchiveStagingDatabase<IsolatedStatement> = app.db) {
  const target = await D1ArchiveSemanticStaging.create(database, master, bundle.reference);
  await target.registerManifest(bundle.reference, bundle.encrypted);
  for (const part of bundle.manifest.parts) await target.stageEncryptedPart(bundle.manifest.archiveId, part.index, bundle.objects.get(part.objectKey)!);
  return target;
}
async function clear(target: Awaited<ReturnType<typeof stage>>) {
  await target.discard();
  const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, target.handle);
  while (!(await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).complete) { /* bounded pages */ }
}
async function count(name: string, verificationId: string) { return app.db.prepare(`SELECT count(*) AS n FROM ${name} WHERE verification_id=?`).bind(verificationId).first<number>('n'); }
async function lock(active: boolean) { await app.db.prepare('UPDATE backup_runtime SET write_locked_until=? WHERE id=1').bind(active ? '2999-01-01T00:00:00.000Z' : null).run(); }
const rotate = () => app.db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1").run();
beforeEach(async () => { app = await createRuntime({ bindings: {} }); });
afterEach(async () => { await app.close(); });

describe('native D1 authenticated private semantic staging', () => {
  it('authenticates, freezes, independently verifies, resumes and leaves all public authority empty', async () => {
    const bundle = await fixture(), target = await stage(bundle);
    const snapshot = await target.finalize();
    expect(snapshot.commitToken).toBeTruthy();
    expect(await snapshot.semanticStore.get(bundle.manifest.archiveId, 'students', 'student-000')).toEqual(rootRecords()[1]);
    const resumed = await D1ArchiveSemanticStaging.resume(app.db, master, target.handle);
    expect((await resumed.finalize()).commitToken).toBe(snapshot.commitToken);
    expect(await app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(target.handle.verificationId).first('status')).toBe('verified');
    for (const name of ['centers', 'students', 'history_record_locations', 'archive_jobs']) expect(await app.db.prepare(`SELECT count(*) n FROM ${name}`).first('n')).toBe(0);
    await expect(target.registerManifest(bundle.reference, bundle.encrypted)).rejects.toThrow('STALE');
    await expect(target.stageEncryptedPart(bundle.manifest.archiveId, 0, bundle.objects.get(bundle.manifest.parts[0].objectKey)!)).rejects.toThrow('STALE');
  });

  it('rejects unauthenticated envelopes, conflicting manifest replay and mismatched part ciphertext', async () => {
    const bundle = await fixture(), target = await D1ArchiveSemanticStaging.create(app.db, master, bundle.reference);
    const tampered = bundle.encrypted.slice(); tampered[tampered.length - 1] ^= 1;
    await expect(target.registerManifest(bundle.reference, tampered)).rejects.toThrow('checksum');
    expect(await count('archive_semantic_manifests', target.handle.verificationId)).toBe(0);
    await target.registerManifest(bundle.reference, bundle.encrypted);
    await target.registerManifest(bundle.reference, bundle.encrypted);
    const alternative = await fixture(rootRecords(), { archiveId: bundle.manifest.archiveId });
    await expect(target.registerManifest(alternative.reference, alternative.encrypted)).rejects.toThrow('ROOT_MISMATCH');
    const part = bundle.manifest.parts[0], bytes = bundle.objects.get(part.objectKey)!;
    const badPart = bytes.slice(); badPart[badPart.length - 1] ^= 1;
    await expect(target.stageEncryptedPart(bundle.manifest.archiveId, 0, badPart)).rejects.toThrow('checksum');
    expect(await count('archive_semantic_parts', target.handle.verificationId)).toBe(0);
    expect(await count('archive_semantic_rows', target.handle.verificationId)).toBe(0);
    const [token, concurrentToken] = await Promise.all([target.stageEncryptedPart(bundle.manifest.archiveId, 0, bytes), target.stageEncryptedPart(bundle.manifest.archiveId, 0, bytes)]);
    expect(concurrentToken).toBe(token);
    expect(await target.stageEncryptedPart(bundle.manifest.archiveId, 0, bytes)).toBe(token);
    expect(await count('archive_semantic_rows', target.handle.verificationId)).toBe(rootRecords().length);
  });

  it('rolls the checkpoint and every row back when a mid-part native insert fails', async () => {
    const bundle = await fixture(), target = await D1ArchiveSemanticStaging.create(app.db, master, bundle.reference);
    await target.registerManifest(bundle.reference, bundle.encrypted);
    await app.db.prepare("CREATE TRIGGER fail_semantic_row BEFORE INSERT ON archive_semantic_rows WHEN NEW.record_key='student-001' BEGIN SELECT RAISE(ABORT,'test_mid_part_failure'); END").run();
    try {
      await expect(target.stageEncryptedPart(bundle.manifest.archiveId, 0, bundle.objects.get(bundle.manifest.parts[0].objectKey)!)).rejects.toThrow('test_mid_part_failure');
      expect(await count('archive_semantic_parts', target.handle.verificationId)).toBe(0);
      expect(await count('archive_semantic_rows', target.handle.verificationId)).toBe(0);
    } finally { await app.db.prepare('DROP TRIGGER fail_semantic_row').run(); }
    await target.stageEncryptedPart(bundle.manifest.archiveId, 0, bundle.objects.get(bundle.manifest.parts[0].objectKey)!);
    await expect(target.finalize()).resolves.toHaveProperty('commitToken');
  });

  it('keeps missing parts invisible and freezes only the admitted monthly base', async () => {
    const bundle = await fixture(), target = await D1ArchiveSemanticStaging.create(app.db, master, bundle.reference);
    await target.registerManifest(bundle.reference, bundle.encrypted);
    await expect(target.freeze()).rejects.toThrow('INCOMPLETE_OR_CHANGED_GRAPH');
    expect(await app.db.prepare('SELECT commit_token FROM archive_semantic_sessions WHERE verification_id=?').bind(target.handle.verificationId).first('commit_token')).toBeNull();
    await target.stageEncryptedPart(bundle.manifest.archiveId, 0, bundle.objects.get(bundle.manifest.parts[0].objectKey)!);
    const unrelated = await fixture();
    await expect(target.registerManifest(unrelated.reference, unrelated.encrypted)).rejects.toThrow();
    expect(await count('archive_semantic_manifests', target.handle.verificationId)).toBe(1);
    expect((await target.freeze()).manifests.map(manifest => manifest.archiveId)).toEqual([bundle.manifest.archiveId]);
    await clear(target);
    const addendum = await fixture([...rootRecords(), { table: 'audit_entries', key: 'review-attempt', row: { id: 'review-attempt', center_id: 'private-center', actor_id: null, actor_name: 'Fixture', action: 'review_resolved', entity_type: 'review', entity_id: 'review-id', detail: '{}', created_at: '2025-02-03T12:00:00.000Z' } }], { kind: 'addendum', references: [bundle.reference], createdAt: '2025-02-03T12:00:00.000Z' });
    await expect(stage(addendum)).rejects.toThrow();
    expect(await app.db.prepare('SELECT count(*) n FROM archive_semantic_manifests').first('n')).toBe(0);
  });

  it('keeps the admitted namespace immutable and rejects replacement or premature deletion', async () => {
    const bundle = await fixture(), target = await stage(bundle);
    await expect(stage(bundle)).rejects.toThrow();
    const snapshot = await target.freeze();
    for (const name of ['archive_semantic_rows', 'archive_semantic_parts', 'archive_semantic_manifests']) {
      await expect(app.db.prepare(`UPDATE ${name} SET archive_id='changed' WHERE verification_id=?`).bind(target.handle.verificationId).run()).rejects.toThrow();
      await expect(app.db.prepare(`DELETE FROM ${name} WHERE verification_id=?`).bind(target.handle.verificationId).run()).rejects.toThrow();
      await expect(app.db.prepare(`INSERT OR REPLACE INTO ${name} SELECT * FROM ${name} WHERE verification_id=?`).bind(target.handle.verificationId).run()).rejects.toThrow();
    }
    expect(await snapshot.semanticStore.get(bundle.manifest.archiveId, 'students', 'student-000')).toEqual(rootRecords()[1]);
    await target.discard();
    await expect(snapshot.semanticStore.get(bundle.manifest.archiveId, 'students', 'student-000')).rejects.toThrow('STALE');
  });

  it('bounds pages, keeps key order and uses each relationship index with bounded native reads', async () => {
    const records = rootRecords();
    for (let i = 0; i < 600; i++) {
      const id = `audit-${String(i).padStart(4, '0')}`, target = i % 150 === 0 ? 'target' : `other-${i}`;
      records.push({ table: 'audit_entries', key: id, row: { id, center_id: 'private-center', actor_id: null, actor_name: 'Fixture', action: 'historical_note', entity_type: 'visit', entity_id: target, detail: '{}', created_at: at, visit_id: target, event_id: target } });
    }
    const bundle = await fixture(records), queries: IsolatedStatement[] = [], costs: number[] = [], partBatchSizes: number[] = [];
    const database: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), batch: async <T,>(statements: IsolatedStatement[]) => {
      if (statements.some(statement => statement.sql.startsWith('INSERT INTO archive_semantic_parts'))) partBatchSizes.push(statements.length);
      queries.push(...statements.filter(statement => statement.sql.includes('LEFT JOIN (SELECT r.record_key,r.record_json FROM archive_semantic_rows')));
      const result = await app.db.batch<T>(statements);
      for (let i = 0; i < statements.length; i++) if (statements[i].sql.includes('LEFT JOIN (SELECT r.record_key,r.record_json FROM archive_semantic_rows')) costs.push(Number(result[i].meta?.rows_read));
      return result;
    } };
    const target = await stage(bundle, database), snapshot = await target.freeze(), store = snapshot.semanticStore;
    const first = await store.page({ archiveId: bundle.manifest.archiveId, table: 'audit_entries', after: '', limit: 64 });
    const second = await store.page({ archiveId: bundle.manifest.archiveId, table: 'audit_entries', after: first.at(-1)!.key, limit: 64 });
    expect(first).toHaveLength(64); expect(second).toHaveLength(64); expect(first.at(-1)!.key < second[0].key).toBe(true);
    await expect(store.page({ archiveId: bundle.manifest.archiveId, table: 'audit_entries', after: '', limit: 65 })).rejects.toThrow('PAGE_BOUND');
    for (const column of ['visit_id', 'event_id', 'entity_id'] as const) {
      const selected = await store.page({ archiveId: bundle.manifest.archiveId, table: 'audit_entries', after: '', limit: 64, relation: { column, value: 'target' } });
      expect(selected.map(record => record.key)).toEqual(['audit-0000', 'audit-0150', 'audit-0300', 'audit-0450']);
      const query = queries.at(-1)!;
      const plan = await app.db.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).bind(...query.args).all<{ detail: string }>();
      expect(plan.results.map(row => row.detail).join(' ')).toContain(`archive_semantic_rows_${column.split('_')[0]}`);
      const former = await app.db.batch([
        app.db.prepare(`SELECT s.*,EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a WHERE a.verification_id=s.verification_id AND a.generation=s.generation) AS admission_allowed
          FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
          WHERE s.verification_id=? AND s.generation=? AND s.status IN ('frozen','verified') AND s.commit_token=?`)
          .bind(target.handle.verificationId, target.handle.generation, snapshot.commitToken),
        app.db.prepare(`SELECT r.record_json FROM archive_semantic_rows r INDEXED BY archive_semantic_rows_${column.split('_')[0]}
          JOIN archive_semantic_sessions s USING(verification_id,generation) JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
          WHERE r.verification_id=? AND r.generation=? AND s.status IN ('frozen','verified') AND s.commit_token=? AND r.archive_id=? AND r.table_name=?
          AND r.record_key>? AND r.${column}=? ORDER BY r.record_key LIMIT ?`)
          .bind(target.handle.verificationId, target.handle.generation, snapshot.commitToken, bundle.manifest.archiveId, 'audit_entries', '', 'target', 64),
      ]);
      const formerTotal = former.reduce((total, result) => total + Number(result.meta?.rows_read), 0);
      expect(Number(former[1].meta?.rows_read)).toBeLessThan(20);
      // The combined result now accounts for the admission query too, plus
      // scans of the bounded materialized page and single active-session row.
      expect(costs.at(-1)).toBeLessThanOrEqual(formerTotal + selected.length + 3);
      expect(costs.at(-1)).toBeLessThanOrEqual(20);
    }
    // Native metadata includes bounded subquery/output scans (199 reads for
    // this 64-row page), whereas the former assertion counted only raw rows.
    expect(Math.max(...costs)).toBeLessThanOrEqual(3 * ARCHIVE_LIMITS.semanticPageRecords + 16);
    expect(bundle.manifest.parts[0].recordCount).toBe(ARCHIVE_LIMITS.recordsPerPart);
    expect(partBatchSizes).toEqual(bundle.manifest.parts.map(() => 4));
  });

  it('rejects semantic errors rather than recording caller-asserted success', async () => {
    const records = rootRecords(); records[1].row.active = 5;
    const bundle = await fixture(records), target = await stage(bundle);
    await expect(target.finalize()).rejects.toThrow('INVALID_ACTIVE');
    expect(await app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(target.handle.verificationId).first('status')).toBe('invalid');
    await expect(target.freeze()).rejects.toThrow('STALE');
  });

  it('blocks staging, freezing, invalidation and cleanup while the backup barrier is held', async () => {
    const bundle = await fixture();
    await lock(true);
    try { await expect(D1ArchiveSemanticStaging.create(app.db, master, bundle.reference)).rejects.toThrow('backup_maintenance'); }
    finally { await lock(false); }
    const target = await stage(bundle);
    await lock(true);
    try {
      await expect(target.freeze()).rejects.toThrow('backup_maintenance');
      await expect(target.discard()).rejects.toThrow('backup_maintenance');
    } finally { await lock(false); }
    await target.finalize(); await target.discard();
    const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, target.handle);
    await lock(true);
    try { await expect(D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).rejects.toThrow('backup_maintenance'); }
    finally { await lock(false); }
    expect((await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).deleted).toBe(rootRecords().length);
  });

  it('deletes invalid private staging in bounded FK order before admitting a replacement', async () => {
    const bundle = await fixture(), target = await stage(bundle);
    const snapshot = await target.finalize();
    await expect(D1ArchiveSemanticStaging.beginCleanup(app.db, target.handle)).rejects.toThrow('CLEANUP_STALE');
    await target.discard();
    const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, target.handle);
    await expect(snapshot.semanticStore.page({ archiveId: bundle.manifest.archiveId, table: 'students', after: '', limit: 2 })).rejects.toThrow('STALE');
    const phases: string[] = []; let total = 0, done = false;
    for (let i = 0; i < 15 && !done; i++) {
      const result = await D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup, 2);
      expect(result.deleted).toBeLessThanOrEqual(2); total += result.deleted; phases.push(result.phase); done = result.complete;
    }
    expect(done).toBe(true); expect(total).toBe(rootRecords().length + 3);
    expect([...new Set(phases)]).toEqual(['archive_semantic_rows', 'archive_semantic_parts', 'archive_semantic_manifests', 'archive_semantic_sessions']);
    expect(await count('archive_semantic_rows', target.handle.verificationId)).toBe(0);
    const other = await stage(bundle);
    await expect(D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).resolves.toEqual({ phase: 'archive_semantic_sessions', deleted: 1, complete: true });
    expect(await count('archive_semantic_rows', other.handle.verificationId)).toBe(rootRecords().length);
    await other.finalize();
  });

  it('applies migration18 under maintenance and rolls back all DDL on a failed native batch', async () => {
    const isolated = await createRuntime({ bindings: {}, migrate: false });
    try {
      const directory = join(projectRoot, 'migrations');
      for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql') && name < '0018').sort()) {
        await isolated.db.batch(unstable_splitSqlQuery(await readFile(join(directory, name), 'utf8')).map(sql => isolated.db.prepare(sql)));
      }
      await isolated.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
      const migration = unstable_splitSqlQuery(await readFile(join(directory, '0018_archive_semantic_staging.sql'), 'utf8')).map(sql => isolated.db.prepare(sql));
      await expect(isolated.db.batch([...migration, isolated.db.prepare('SELECT * FROM nonexistent_migration_failure')])).rejects.toThrow();
      expect(await isolated.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'archive_semantic_%'").first('n')).toBe(0);
      expect(await isolated.db.prepare('SELECT count(*) n FROM schema_versions WHERE version=18').first('n')).toBe(0);
      await isolated.db.batch(migration);
      expect(await isolated.db.prepare('SELECT max(version) version FROM schema_versions').first('version')).toBe(18);
      const bundle = await fixture();
      await expect(isolated.db.prepare("INSERT INTO archive_semantic_sessions(verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at) SELECT 'legacy-18-probe',generation,?,?,?,'staging',? FROM history_runtime WHERE id=1").bind(bundle.reference.archiveId, bundle.reference.manifestSha256, JSON.stringify(bundle.reference), at).run()).rejects.toThrow('backup_maintenance');
    } finally { await isolated.close(); }
  });

  it('fences restore between authentication and write, and rejects old read/cleanup capabilities', async () => {
    const bundle = await fixture(); let injected = false;
    const database: ArchiveStagingDatabase<IsolatedStatement> = { prepare: sql => app.db.prepare(sql), batch: async <T,>(statements: IsolatedStatement[]) => {
      if (!injected && statements.some(statement => statement.sql.startsWith('INSERT INTO archive_semantic_parts'))) { injected = true; await rotate(); }
      return app.db.batch<T>(statements);
    } };
    const target = await D1ArchiveSemanticStaging.create(database, master, bundle.reference);
    await target.registerManifest(bundle.reference, bundle.encrypted);
    await expect(target.stageEncryptedPart(bundle.manifest.archiveId, 0, bundle.objects.get(bundle.manifest.parts[0].objectKey)!)).rejects.toThrow('STALE');
    expect(await count('archive_semantic_parts', target.handle.verificationId)).toBe(0);
    const invalidate = () => app.db.prepare("UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL").run();
    await invalidate(); const removed = await D1ArchiveSemanticStaging.beginCleanup(app.db, target.handle);
    while (!(await D1ArchiveSemanticStaging.cleanupPage(app.db, removed)).complete) { /* bounded pages */ }
    const source = await stage(bundle), snapshot = await source.finalize();
    await rotate();
    await expect(snapshot.semanticStore.get(bundle.manifest.archiveId, 'students', 'missing')).rejects.toThrow('STALE');
    await expect(D1ArchiveSemanticStaging.resume(app.db, master, source.handle)).rejects.toThrow('STALE');
    await invalidate(); const cleanup = await D1ArchiveSemanticStaging.beginCleanup(app.db, source.handle);
    await rotate();
    await expect(D1ArchiveSemanticStaging.cleanupPage(app.db, cleanup)).rejects.toThrow('CLEANUP_STALE');
    const renewed = await D1ArchiveSemanticStaging.beginCleanup(app.db, source.handle);
    expect(renewed.cleanupGeneration).not.toBe(cleanup.cleanupGeneration);
    expect((await D1ArchiveSemanticStaging.cleanupPage(app.db, renewed)).deleted).toBe(rootRecords().length);
  });
});
