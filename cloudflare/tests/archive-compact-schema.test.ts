import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { BACKUP_TABLES } from '../worker/backup';
import type { AdminSession } from '../shared/types';
import { createRuntime, projectRoot, testAudience, testIssuer, type TestRuntime } from './runtime';
import { createStudent, json, seedHistoricalVisit, type App } from './helpers';

const runtimes: TestRuntime[] = [];
afterEach(async () => { for (const app of runtimes.splice(0)) await app.close(); });
const compactTables = ['archive_compact_builds','archive_compact_identities','archive_compact_requests','archive_compact_publications','archive_compact_availability'];
async function schema27(): Promise<App> {
  const runtime = await createRuntime({ migrate: false, bindings: { APP_ENV: 'local', CENTER_ID: 'test-center', APP_VERSION: 'compact-migration-test', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test' } });
  runtimes.push(runtime);
  const files = (await readdir(join(projectRoot,'migrations'))).filter(name=>/^\d{4}.*\.sql$/.test(name) && Number(name.slice(0,4)) <= 27).sort();
  expect(files).toHaveLength(27);
  for (const name of files) await runtime.db.batch(unstable_splitSqlQuery(await readFile(join(projectRoot,'migrations',name),'utf8')).map(sql=>runtime.db.prepare(sql)));
  const token = await runtime.signer.token();
  const session = await json<AdminSession>(await runtime.request('/api/admin/session',{token}));
  const app: App = { ...runtime, token, actor: session.actor };
  const student = await createStudent(app);
  await seedHistoricalVisit(app,student,'2025-01-10T18:00:00.000Z','2025-01-10T19:00:00.000Z');
  expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(27);
  return app;
}
async function inventory(app: TestRuntime) {
  return (await app.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name").all<{ type: string; name: string; tbl_name: string; sql: string }>()).results;
}
async function fingerprints(app: TestRuntime, tables: string[]) {
  const result: Record<string,{ count: number; sha256: string }> = {};
  for (const table of tables) {
    const rows = (await app.db.prepare(`SELECT * FROM "${table.replaceAll('"','""')}"`).all()).results.map(row=>JSON.stringify(row)).sort();
    result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
  }
  return result;
}
async function migration(app: TestRuntime) {
  return unstable_splitSqlQuery(await readFile(join(projectRoot,'migrations/0028_archive_compact_publication.sql'),'utf8')).map(sql=>app.db.prepare(sql));
}

describe('schema28 direct compact migration on native D1', () => {
  it('keeps compact audit validation on indexed physical sources', async () => {
    const app = await schema27();
    await app.db.batch(await migration(app));
    const trigger = await app.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='archive_compact_build_update'")
      .first<string>('sql');
    expect(trigger).toBeTypeOf('string');
    expect(trigger).not.toContain('audit_timeline');
    expect(trigger).toContain('FROM audit_entries');
    expect(trigger).toContain('FROM attendance_events');
    expect(trigger).toContain('FROM attendance_corrections');
    expect(trigger).toContain('FROM history_correction_outbox');
  });

  it('adds exactly the compact contract and keeps all schema27 rows, sources and original schema objects unchanged', async () => {
    const app = await schema27(), before = await inventory(app);
    const oldTables = before.filter(row=>row.type==='table' && row.name!=='schema_versions').map(row=>row.name);
    const original = await fingerprints(app,oldTables);
    expect(original.attendance_events.count).toBe(2);
    expect(original.visits.count).toBe(1);
    await app.db.batch(await migration(app));
    const after = await inventory(app), previous = new Set(before.map(row=>row.name));
    expect(after.filter(row=>previous.has(row.name))).toEqual(before);
    expect(await fingerprints(app,oldTables)).toEqual(original);
    expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(28);
    expect(after.filter(row=>row.type==='table' && !previous.has(row.name)).map(row=>row.name).sort()).toEqual([...compactTables].sort());
    expect((await app.db.prepare('PRAGMA table_info(archive_compact_requests)').all<{name:string}>()).results.map(row=>row.name)).toEqual(['request_id','publication_id']);
    expect((await app.db.prepare('PRAGMA index_info(archive_compact_request_publication)').all<{name:string}>()).results.map(row=>row.name)).toEqual(['publication_id','request_id']);
    expect(after.find(row=>row.name==='archive_compact_requests')!.sql).toContain('WITHOUT ROWID');
    expect(new Set(BACKUP_TABLES).size).toBe(96);
    for (const table of compactTables) {
      expect(BACKUP_TABLES).toContain(table);
      expect(await app.db.prepare(`SELECT count(*) AS n FROM ${table}`).first('n')).toBe(0);
      expect(after.some(row=>row.name===`${table}_no_delete`)).toBe(true);
      for (const operation of ['insert','update','delete']) expect(after.some(row=>row.name===`backup_lock_${table}_${operation}`)).toBe(true);
    }
    for (const name of ['archive_compact_build_legacy_conflict','archive_legacy_build_compact_conflict','archive_legacy_descriptor_compact_conflict','archive_legacy_request_compact_conflict','archive_compact_generation_reset']) expect(after.some(row=>row.name===name)).toBe(true);
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('rolls back every schema28 object and version on a late native transaction failure, then retries without changing source values', async () => {
    const app = await schema27(), before = await inventory(app);
    const tables = before.filter(row=>row.type==='table').map(row=>row.name), original = await fingerprints(app,tables);
    const statements = await migration(app);
    // A late duplicate version is a real execution failure, after the DDL and
    // native trigger creation; D1.batch must roll the entire migration back.
    await expect(app.db.batch([...statements,app.db.prepare('INSERT INTO schema_versions(version) VALUES(27)')])).rejects.toThrow();
    expect(await inventory(app)).toEqual(before);
    expect(await fingerprints(app,tables)).toEqual(original);
    expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(27);
    await app.db.batch(await migration(app));
    expect(await app.db.prepare('SELECT max(version) AS n FROM schema_versions').first('n')).toBe(28);
    const preserved = await fingerprints(app,tables.filter(name=>name!=='schema_versions'));
    const { schema_versions: _version, ...oldRows } = original;
    expect(preserved).toEqual(oldRows);
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
