import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import type { AdminSession } from '../shared/types';
import { BACKUP_TABLES } from '../worker/backup';
import { createRuntime, projectRoot, testAudience, testIssuer, type TestRuntime } from './runtime';
import { createStudent, json, seedHistoricalVisit, type App } from './helpers';

const runtimes: TestRuntime[] = [];
const newTables = ['archive_compact_reconciliation_jobs', 'archive_compact_reconciliation_receipts'];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });

async function schema28(): Promise<App> {
  const runtime = await createRuntime({
    migrate: false,
    bindings: {
      APP_ENV: 'local', CENTER_ID: 'test-center', APP_VERSION: 'compact-reconciliation-migration-test',
      ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
    },
  });
  runtimes.push(runtime);
  const files = (await readdir(join(projectRoot, 'migrations')))
    .filter(name => /^\d{4}.*\.sql$/.test(name) && Number(name.slice(0, 4)) <= 28).sort();
  expect(files).toHaveLength(28);
  for (const name of files) {
    await runtime.db.batch(unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'))
      .map(sql => runtime.db.prepare(sql)));
  }
  const token = await runtime.signer.token();
  const session = await json<AdminSession>(await runtime.request('/api/admin/session', { token }));
  const app = { ...runtime, token, actor: session.actor };
  const student = await createStudent(app, { firstName: 'Schema', lastName: 'Twenty Nine' });
  await seedHistoricalVisit(app, student, '2025-01-10T18:00:00.000Z', '2025-01-10T19:00:00.000Z');
  expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(28);
  return app;
}

async function inventory(app: TestRuntime) {
  return (await app.db.prepare("SELECT name,type,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type,name")
    .all<{ name: string; type: string; sql: string }>()).results;
}
async function fingerprints(app: TestRuntime, tables: readonly string[]) {
  return Object.fromEntries(await Promise.all(tables.map(async table => {
    const rows = (await app.db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all()).results
      .map(row => JSON.stringify(row)).sort();
    return [table, { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }];
  })));
}
async function migration(app: TestRuntime) {
  return unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations/0029_archive_compact_reconciliation.sql'), 'utf8'))
    .map(sql => app.db.prepare(sql));
}

describe('schema29 compact reconciliation migration on native D1', () => {
  it('adds only reconciliation evidence, extends availability, and preserves every schema28 row', async () => {
    const app = await schema28();
    const before = await inventory(app);
    const oldTables = before.filter(item => item.type === 'table' && item.name !== 'schema_versions').map(item => item.name);
    const original = await fingerprints(app, oldTables);
    await app.db.batch(await migration(app));
    const after = await inventory(app), previous = new Set(before.map(item => item.name));
    expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(29);
    expect(after.filter(item => item.type === 'table' && !previous.has(item.name)).map(item => item.name).sort()).toEqual([...newTables].sort());
    expect(await fingerprints(app, oldTables)).toEqual(original);
    expect((await app.db.prepare('PRAGMA table_info(archive_compact_availability)').all<{ name: string }>()).results.map(row => row.name))
      .toEqual(['publication_id', 'generation', 'status', 'reconciliation_id']);
    expect((await app.db.prepare('PRAGMA index_info(archive_compact_reconciliation_active_publication)').all<{ name: string }>()).results.map(row => row.name))
      .toEqual(['publication_id', 'execution_generation']);
    expect(new Set(BACKUP_TABLES).size).toBe(96);
    for (const table of newTables) {
      expect(BACKUP_TABLES).toContain(table);
      expect(await app.db.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
    }
    for (const name of [
      'archive_compact_reconciliation_job_insert_guard', 'archive_compact_reconciliation_job_update_guard',
      'archive_compact_reconciliation_receipt_insert_guard', 'archive_compact_generation_reset',
    ]) expect(after.some(item => item.name === name)).toBe(true);
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('rolls back all schema29 DDL on a late native failure and retries without changing schema28 values', async () => {
    const app = await schema28(), before = await inventory(app);
    const tables = before.filter(item => item.type === 'table').map(item => item.name);
    const original = await fingerprints(app, tables);
    const statements = await migration(app);
    await expect(app.db.batch([...statements, app.db.prepare('INSERT INTO schema_versions(version) VALUES(28)')])).rejects.toThrow();
    expect(await inventory(app)).toEqual(before);
    expect(await fingerprints(app, tables)).toEqual(original);
    expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(28);
    await app.db.batch(await migration(app));
    expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(29);
    expect(await fingerprints(app, tables.filter(name => name !== 'schema_versions')))
      .toEqual(Object.fromEntries(Object.entries(original).filter(([name]) => name !== 'schema_versions')));
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
