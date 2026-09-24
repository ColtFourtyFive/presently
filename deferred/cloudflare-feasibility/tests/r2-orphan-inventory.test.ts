import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { BACKUP_TABLES } from '../worker/backup';
import {
  advanceR2OrphanInventory,
  archivePrefixFromManifestKey,
  authorityForObjectKey,
  startR2OrphanInventory,
} from '../worker/r2-orphan-inventory';
import type { Env } from '../worker/types';
import { json, startApp } from './helpers';
import { createRuntime, projectRoot, type TestRuntime } from './runtime';

const runtimes: TestRuntime[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.close())); });

const at = (value: string, minutes = 0) => new Date(Date.parse(value) + minutes * 60_000);

async function runtime(migrate = true) {
  const value = await createRuntime({ migrate, r2: true, bindings: { APP_ENV: 'local' } });
  runtimes.push(value);
  return value;
}

function environment(app: TestRuntime, bucket: R2Bucket): Env {
  return { CRM_DB: app.db as unknown as D1Database, BACKUP_BUCKET: bucket };
}

async function status(app: TestRuntime, runId: string) {
  return app.db.prepare('SELECT * FROM r2_orphan_inventory_runs WHERE id=?').bind(runId)
    .first<Record<string, unknown>>();
}

async function advanceUntil(
  app: TestRuntime,
  env: Env,
  runId: string,
  target: string,
  start: Date,
  maximum = 250,
) {
  for (let step = 0; step < maximum; step += 1) {
    const row = await status(app, runId);
    if (row?.status === target) return row;
    if (row?.status === 'failed') throw new Error(`inventory failed: ${String(row.error_code)}`);
    await advanceR2OrphanInventory(env, runId, new Date(start.getTime() + step * 60_000));
  }
  throw new Error(`inventory did not reach ${target}`);
}

async function seedReferenceCatalog(app: TestRuntime) {
  const generation = String(await app.db.prepare('SELECT generation FROM history_runtime WHERE id=1').first('generation'));
  const now = '2029-01-01T00:00:00.000Z';
  const manifest = (archiveId: string) => `archives/center-1/2025-01/${archiveId}/manifest-${'a'.repeat(64)}.kca`;
  const retained = {
    archiveId: 'retained-id',
    kind: 'monthly',
    manifestObjectKey: manifest('retained-id'),
    manifestSha256: 'a'.repeat(64),
  };
  await app.db.batch([
    app.db.prepare('INSERT INTO centers(id,name,timezone,created_at) VALUES(?,?,?,?)')
      .bind('center-1', 'Inventory Center', 'UTC', now),
    app.db.prepare(`INSERT INTO staff(id,center_id,email,display_name,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).bind('owner-1', 'center-1', 'owner@example.test', 'Owner', 'owner', now, now),
    app.db.prepare(`INSERT INTO archive_jobs(
      id,center_id,month,timezone,period_from,period_to,cutoff,created_at,updated_at,created_by,
      schema_json,application_version,status,source_expires_at,manifest_key
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'active-id', 'center-1', '2025-01', 'UTC', '2025-01-01T00:00:00.000Z',
      '2025-02-01T00:00:00.000Z', '2025-05-01T00:00:00.000Z', now, now, 'owner-1',
      '[1,8]', 'test', 'complete', '2099-01-01T00:00:00.000Z', manifest('active-id'),
    ),
    app.db.prepare(`INSERT INTO archive_jobs(
      id,center_id,month,timezone,period_from,period_to,cutoff,created_at,updated_at,created_by,
      schema_json,application_version,status,source_expires_at,manifest_key,error_code
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      'failed-id', 'center-1', '2025-02', 'UTC', '2025-02-01T00:00:00.000Z',
      '2025-03-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z', now, now, 'owner-1',
      '[1,8]', 'test', 'failed', '2099-01-01T00:00:00.000Z', manifest('failed-id'), 'TEST_FAILURE',
    ),
    app.db.prepare(`INSERT INTO archive_semantic_sessions(
      verification_id,generation,root_archive_id,root_manifest_sha256,root_reference_json,status,created_at
    ) VALUES(?,?,?,?,?,'staging',?)`).bind(
      'semantic-verification', generation, 'semantic-id', 'b'.repeat(64),
      JSON.stringify({ archiveId: 'semantic-id', kind: 'monthly', manifestObjectKey: manifest('semantic-id'), manifestSha256: 'b'.repeat(64) }), now,
    ),
    app.db.prepare(`INSERT INTO backup_jobs(
      id,created_at,updated_at,status,counts_json,schema_json,storage_provider,archives_json,completed_at
    ) VALUES(?,?,?,'complete','{}','[1,8]','r2',?,?)`).bind('backup-id', now, now, JSON.stringify([retained]), now),
  ]);
  return { generation, manifest };
}

async function addLateBuild(app: TestRuntime, manifest: (archiveId: string) => string) {
  const now = '2029-01-01T00:30:00.000Z';
  await app.db.prepare(`INSERT INTO archive_jobs(
    id,center_id,month,timezone,period_from,period_to,cutoff,created_at,updated_at,created_by,
    schema_json,application_version,status,source_expires_at,manifest_key
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
    'late-id', 'center-1', '2025-03', 'UTC', '2025-03-01T00:00:00.000Z',
    '2025-04-01T00:00:00.000Z', '2025-07-01T00:00:00.000Z', now, now, 'owner-1',
    '[1,8]', 'test', 'parts', '2099-01-01T00:00:00.000Z', manifest('late-id'),
  ).run();
}

describe('schema 35 R2 orphan inventory', () => {
  it('installs atomically, rolls back a late failure, and closes the 92-table backup inventory', async () => {
    const app = await runtime(false);
    const names = (await readdir(join(projectRoot, 'migrations'))).filter(name => /^\d{4}.*\.sql$/.test(name)).sort();
    for (const name of names.filter(name => Number(name.slice(0, 4)) <= 34)) {
      const statements = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
      await app.db.batch(statements.map(sql => app.db.prepare(sql)));
    }
    const migration = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations/0035_r2_orphan_inventory.sql'), 'utf8'));
    await expect(app.db.batch([
      ...migration.map(sql => app.db.prepare(sql)),
      app.db.prepare('INSERT INTO schema_versions(version) VALUES(34)'),
    ])).rejects.toThrow();
    expect(await app.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'r2_orphan_%'").first('n')).toBe(0);
    expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(34);

    await app.db.batch(migration.map(sql => app.db.prepare(sql)));
    expect(await app.db.prepare('SELECT max(version) n FROM schema_versions').first('n')).toBe(35);
    expect(new Set(BACKUP_TABLES).size).toBe(96);
    for (const table of [
      'r2_orphan_inventory_policy', 'r2_orphan_inventory_runs', 'r2_orphan_inventory_references',
      'r2_orphan_inventory_objects', 'r2_orphan_observations', 'r2_orphan_cleanup_plans',
    ]) expect(BACKUP_TABLES).toContain(table);
    expect(await app.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'backup_lock_r2_orphan_%'").first('n')).toBe(18);
    await app.db.prepare("UPDATE backup_runtime SET write_locked_until='2999-01-01T00:00:00.000Z' WHERE id=1").run();
    await expect(app.db.prepare("UPDATE r2_orphan_inventory_policy SET updated_at='blocked' WHERE id=1").run())
      .rejects.toThrow('backup_maintenance');
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    await expect(app.db.prepare('UPDATE r2_orphan_inventory_policy SET delete_enabled=1 WHERE id=1').run()).rejects.toThrow();
    expect((await app.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  }, 60_000);

  it('classifies canonical namespaces, protects live authority, and emits only blocked plans after two aged scans', async () => {
    const app = await runtime();
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    let deleteCalls = 0;
    const guardedBucket = new Proxy(bucket as unknown as R2Bucket, {
      get(target, key, receiver) {
        if (key === 'delete') return async () => { deleteCalls += 1; throw new Error('R2_DELETE_FORBIDDEN'); };
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const env = environment(app, guardedBucket);
    const { manifest } = await seedReferenceCatalog(app);
    await app.db.prepare(`UPDATE r2_orphan_inventory_policy SET minimum_age_seconds=86400,
      minimum_confirmation_interval_seconds=3600,page_size=1,updated_at=? WHERE id=1`)
      .bind('2030-01-01T00:00:00.000Z').run();

    const keys = {
      active: manifest('active-id'),
      semantic: manifest('semantic-id'),
      backup: 'backups/backup-id/part-00000.kcrm',
      retained: manifest('retained-id'),
      late: manifest('late-id'),
      orphan: manifest('orphan-id'),
      failed: manifest('failed-id'),
      unknown: 'misc/private-object.bin',
      malformed: 'archives//2025-01/bad/part.kca',
    };
    for (const [name, key] of Object.entries(keys)) await bucket.put(key, new TextEncoder().encode(name));

    const firstAt = at('2030-01-01T00:00:00.000Z');
    const first = await startR2OrphanInventory(env, firstAt);
    await advanceUntil(app, env, first, 'refreshing_references', firstAt);
    await addLateBuild(app, manifest);
    await advanceUntil(app, env, first, 'complete', at('2030-01-01T01:00:00.000Z'));

    const rows = (await app.db.prepare(`SELECT object_key,classification,matched_source_table
      FROM r2_orphan_inventory_objects WHERE run_id=?`).bind(first).all<{
        object_key: string; classification: string; matched_source_table: string | null;
      }>()).results;
    const byKey = new Map(rows.map(row => [row.object_key, row]));
    for (const key of [keys.active, keys.semantic, keys.backup, keys.retained, keys.late]) {
      expect(byKey.get(key)?.classification, key).toBe('referenced');
    }
    expect(byKey.get(keys.late)?.matched_source_table).toBe('archive_jobs');
    expect(byKey.get(keys.orphan)?.classification).toBe('orphan_candidate');
    expect(byKey.get(keys.failed)?.classification).toBe('orphan_candidate');
    expect(byKey.get(keys.unknown)?.classification).toBe('protected');
    expect(byKey.get(keys.malformed)?.classification).toBe('protected');
    expect(await app.db.prepare('SELECT count(*) n FROM r2_orphan_cleanup_plans').first('n')).toBe(0);

    const secondAt = at('2030-01-03T00:00:00.000Z');
    const second = await startR2OrphanInventory(env, secondAt);
    await advanceUntil(app, env, second, 'complete', secondAt);
    const plans = (await app.db.prepare(`SELECT object_key,status,delete_enabled,evidence_json
      FROM r2_orphan_cleanup_plans WHERE run_id=? ORDER BY object_key`).bind(second).all<{
        object_key: string; status: string; delete_enabled: number; evidence_json: string;
      }>()).results;
    expect(plans.map(plan => plan.object_key)).toEqual([keys.failed, keys.orphan].sort());
    expect(plans.every(plan => plan.status === 'dry_run_blocked' && plan.delete_enabled === 0)).toBe(true);
    const secondRun = await status(app, second);
    for (const plan of plans) {
      const evidence = JSON.parse(plan.evidence_json) as { referenceRefreshCompletedAt: string; deleteEnabled: boolean };
      expect(evidence.referenceRefreshCompletedAt).toBe(secondRun?.refreshed_at);
      expect(evidence.deleteEnabled).toBe(false);
    }
    expect(deleteCalls).toBe(0);
  }, 120_000);

  it('marks a replayed object that changes during pagination unstable and never calls R2 deletion', async () => {
    const app = await runtime();
    const uploaded = at('2029-01-01T00:00:00.000Z');
    let lists = 0;
    let deletes = 0;
    const object = (etag: string) => ({ key: 'archives/center-1/2025-01/mutating-id/part.kca', etag, size: 1, uploaded });
    const bucket = {
      async list(options?: { cursor?: string }) {
        lists += 1;
        if (!options?.cursor) return { objects: [object('etag-1')], truncated: true, cursor: 'page-1' };
        if (options.cursor === 'page-1') return { objects: [object('etag-2')], truncated: true, cursor: 'page-2' };
        return { objects: [], truncated: false };
      },
      async delete() { deletes += 1; throw new Error('R2_DELETE_FORBIDDEN'); },
    } as unknown as R2Bucket;
    const env = environment(app, bucket);
    const runId = await startR2OrphanInventory(env, at('2030-01-01T00:00:00.000Z'));
    for (let step = 0; step < 100; step += 1) {
      const row = await status(app, runId);
      if (row?.status === 'failed') break;
      await advanceR2OrphanInventory(env, runId, at('2030-01-01T00:00:00.000Z', step));
    }
    const row = await status(app, runId);
    expect(row?.status).toBe('failed');
    expect(row?.error_code).toBe('R2_OBJECT_CHANGED_DURING_SCAN');
    expect(lists).toBe(3);
    expect(deletes).toBe(0);
  });

  it('keeps D1 binding counts bounded at the maximum configured object page size', async () => {
    const app = await runtime();
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    for (let index = 0; index < 81; index += 1) {
      const archiveId = `bulk-${String(index).padStart(3, '0')}`;
      await bucket.put(`archives/center-1/2025-01/${archiveId}/part.kca`, new Uint8Array([index]));
    }
    await app.db.prepare("UPDATE r2_orphan_inventory_policy SET page_size=250,updated_at='2030-01-01T00:00:00.000Z' WHERE id=1").run();
    const env = environment(app, bucket as unknown as R2Bucket);
    const runId = await startR2OrphanInventory(env, at('2030-01-01T00:00:00.000Z'));
    await advanceUntil(app, env, runId, 'complete', at('2030-01-01T00:00:00.000Z'));
    expect(await app.db.prepare(`SELECT count(*) n FROM r2_orphan_inventory_objects
      WHERE run_id=? AND classification='orphan_candidate'`).bind(runId).first('n')).toBe(81);
  }, 60_000);

  it('fails and releases an active run immediately when recovery changes the history generation', async () => {
    const app = await runtime();
    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    const env = environment(app, bucket as unknown as R2Bucket);
    const runId = await startR2OrphanInventory(env, at('2030-01-01T00:00:00.000Z'));
    await app.db.prepare(`UPDATE history_runtime SET generation=lower(hex(randomblob(16))),updated_at=? WHERE id=1`)
      .bind('2030-01-01T00:01:00.000Z').run();
    const row = await status(app, runId);
    expect(row?.status).toBe('failed');
    expect(row?.active_slot).toBeNull();
    expect(row?.error_code).toBe('R2_INVENTORY_GENERATION_CHANGED');
    expect(await advanceR2OrphanInventory(env, runId)).toBe('failed');
  });

  it('allows managers to read inventory status but reserves inventory mutations for owners', async () => {
    const app = await startApp({ r2: true });
    runtimes.push(app);
    const managerEmail = `manager-${crypto.randomUUID()}@example.test`;
    await json(await app.request('/api/admin/staff', {
      token: app.token,
      body: { email: managerEmail, displayName: 'Inventory Manager', role: 'manager', kioskEnabled: false },
    }), 201);
    const manager = await app.signer.token({ email: managerEmail });
    expect((await app.request('/api/admin/archives/orphan-inventory', { token: manager })).status).toBe(200);
    expect((await app.request('/api/admin/archives/orphan-inventory/start', { token: manager, body: {} })).status).toBe(403);

    const started = await json<{ id: string; status: string }>(await app.request('/api/admin/archives/orphan-inventory/start', {
      token: app.token,
      body: {},
    }), 202);
    expect((await app.request(`/api/admin/archives/orphan-inventory/${started.id}/advance`, {
      token: manager,
      body: {},
    })).status).toBe(403);
    expect(await app.db.prepare("SELECT count(*) n FROM audit_entries WHERE action='r2_orphan_inventory_requested' AND entity_id=?")
      .bind(started.id).first('n')).toBe(1);
  });

  it('rejects malformed reference keys and protects malformed or unknown object namespaces', () => {
    expect(archivePrefixFromManifestKey('archives/center-1/2025-01/archive-1/manifest.kca'))
      .toBe('archives/center-1/2025-01/archive-1/');
    for (const key of ['../archive.kca', 'archives//2025-01/archive-1/x', 'archives/center/2025-13/archive-1/x']) {
      expect(() => archivePrefixFromManifestKey(key)).toThrow('REFERENCE_KEY_INVALID');
    }
    expect(authorityForObjectKey('misc/private.bin').namespace).toBe('protected');
    expect(authorityForObjectKey('archives//2025-01/archive-1/x').namespace).toBe('protected');
    expect(authorityForObjectKey('backups/backup-1/part.kcrm')).toMatchObject({ namespace: 'backups', backupId: 'backup-1' });
  });
});
