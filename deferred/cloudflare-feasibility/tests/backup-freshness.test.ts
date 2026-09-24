import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { unstable_splitSqlQuery } from 'wrangler';
import { backupScheduled, monitorBackupFreshness, retryFailedBackupAlerts } from '../worker/backup';
import type { Env } from '../worker/types';
import { json, startApp, type App } from './helpers';
import { projectRoot } from './runtime';

const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe('scheduled backup freshness alerts', () => {
  it('does not consume the retry window while the alert destination is missing', async () => {
    const app = await startApp({ r2: true });
    apps.push(app);
    const env = { CRM_DB: app.db, BACKUP_PROVIDER: 'r2' } as unknown as Env;
    const start = new Date('2026-09-21T00:00:00.000Z');
    await monitorBackupFreshness(env, start);

    const stale = new Date(start.getTime() + 27 * 60 * 60 * 1000);
    await expect(monitorBackupFreshness(env, stale)).resolves.toMatchObject({ stale: true, attempted: false, delivered: false });
    expect(await app.db.prepare('SELECT stale_alert_attempted_at FROM backup_runtime WHERE id=1').first('stale_alert_attempted_at')).toBeNull();

    env.BACKUP_ALERT_URL = 'https://alerts.example.test/backup';
    let calls = 0;
    const send = (async () => { calls++; return new Response(null, { status: 204 }); }) as typeof fetch;
    await expect(monitorBackupFreshness(env, new Date(stale.getTime() + 60_000), send)).resolves.toMatchObject({ attempted: true, delivered: true });
    expect(calls).toBe(1);
  });

  it('runs the freshness monitor from the scheduled handler even when no job exists', async () => {
    const app = await startApp({ r2: true });
    apps.push(app);
    const delivered: Record<string, unknown>[] = [];
    const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      delivered.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const env = {
      CRM_DB: app.db,
      BACKUP_PROVIDER: 'r2',
      BACKUP_ENABLED: 'true',
      BACKUP_ALERT_URL: 'https://alerts.example.test/backup',
      BACKUP_QUEUE: {},
    } as unknown as Env;
    const first = Date.parse('2026-09-21T01:00:00.000Z');

    await backupScheduled({ scheduledTime: first } as ScheduledController, env, send);
    await backupScheduled({ scheduledTime: first + 27 * 60 * 60 * 1000 } as ScheduledController, env, send);

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ event: 'kumon_backup_stale', lastCompletedBackupId: null });
  });

  it('persists one alert episode, rate limits retries, and opens a new episode after a later backup', async () => {
    const app = await startApp({
      r2: true,
      bindings: {
        BACKUP_PROVIDER: 'r2',
        BACKUP_ALERT_URL: 'https://alerts.example.test/backup',
      },
    });
    apps.push(app);
    const env = {
      CRM_DB: app.db,
      BACKUP_PROVIDER: 'r2',
      BACKUP_ALERT_URL: 'https://alerts.example.test/backup',
    } as unknown as Env;
    const attempts: Array<{ url: string; body: Record<string, unknown> }> = [];
    let deliveryStatus = 503;
    const send = (async (input: RequestInfo | URL, init?: RequestInit) => {
      attempts.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return new Response(null, { status: deliveryStatus });
    }) as typeof fetch;
    const start = new Date('2026-09-21T00:00:00.000Z');

    await expect(monitorBackupFreshness(env, start, send)).resolves.toMatchObject({ stale: false, attempted: false });
    expect(attempts).toHaveLength(0);

    const firstStale = new Date(start.getTime() + 27 * 60 * 60 * 1000);
    await expect(monitorBackupFreshness(env, firstStale, send)).resolves.toMatchObject({ stale: true, attempted: true, delivered: false });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      url: 'https://alerts.example.test/backup',
      body: { event: 'kumon_backup_stale', provider: 'r2', lastCompletedBackupId: null, lastCompletedAt: null, staleAfterHours: 26 },
    });

    await expect(monitorBackupFreshness(env, new Date(firstStale.getTime() + 30 * 60 * 1000), send)).resolves.toMatchObject({ stale: true, attempted: false, delivered: false });
    expect(attempts).toHaveLength(1);

    deliveryStatus = 204;
    const retry = new Date(firstStale.getTime() + 61 * 60 * 1000);
    await expect(monitorBackupFreshness(env, retry, send)).resolves.toMatchObject({ stale: true, attempted: true, delivered: true });
    expect(attempts).toHaveLength(2);

    await expect(monitorBackupFreshness(env, new Date(retry.getTime() + 2 * 60 * 60 * 1000), send)).resolves.toMatchObject({ stale: true, attempted: false, delivered: true });
    expect(attempts).toHaveLength(2);

    const completedAt = new Date(retry.getTime() + 3 * 60 * 60 * 1000).toISOString();
    await app.db.prepare("INSERT INTO backup_jobs(id,created_at,updated_at,status,counts_json,schema_json,completed_at,storage_provider,archives_json) VALUES(?,?,?,'complete','{}','[38]',?,'r2','[]')")
      .bind('verified-backup', completedAt, completedAt, completedAt).run();
    await expect(monitorBackupFreshness(env, new Date(Date.parse(completedAt) + 1000), send)).resolves.toMatchObject({ stale: false, lastCompletedAt: completedAt });
    const cleared = await app.db.prepare('SELECT stale_alert_key,stale_alert_attempted_at,stale_alert_delivered_at FROM backup_runtime WHERE id=1').first<Record<string, unknown>>();
    expect(cleared).toEqual({ stale_alert_key: null, stale_alert_attempted_at: null, stale_alert_delivered_at: null });

    const secondStale = new Date(Date.parse(completedAt) + 27 * 60 * 60 * 1000);
    await expect(monitorBackupFreshness(env, secondStale, send)).resolves.toMatchObject({ stale: true, attempted: true, delivered: true, lastCompletedAt: completedAt });
    expect(attempts).toHaveLength(3);
    expect(attempts[2].body).toMatchObject({ lastCompletedBackupId: 'verified-backup', lastCompletedAt: completedAt });

    const status = await json<{ freshnessAlert: { staleAfterHours: number; attemptedAt: string | null; deliveredAt: string | null } }>(
      await app.request('/api/admin/backups', { token: app.token }),
    );
    expect(status.freshnessAlert).toMatchObject({ staleAfterHours: 26, attemptedAt: secondStale.toISOString(), deliveredAt: secondStale.toISOString() });

    const reset = unstable_splitSqlQuery(await readFile(join(projectRoot, 'scripts/recovery-access-reset.sql'), 'utf8'));
    await app.db.batch(reset.map(sql => app.db.prepare(sql)));
    const resetState = await app.db.prepare('SELECT backup_monitor_started_at,stale_alert_key,stale_alert_attempted_at,stale_alert_delivered_at FROM backup_runtime WHERE id=1').first<Record<string, unknown>>();
    expect(resetState).toEqual({ backup_monitor_started_at: null, stale_alert_key: null, stale_alert_attempted_at: null, stale_alert_delivered_at: null });
  });

 it('retries a failed backup alert hourly without replaying restored failures', async () => {
  const app = await startApp({ r2: true });
  apps.push(app);
  const env = { CRM_DB: app.db, BACKUP_PROVIDER: 'r2', BACKUP_ALERT_URL: 'https://alerts.example.test/backup' } as unknown as Env;
  const start = new Date('2026-09-21T00:00:00.000Z');
  await app.db.prepare('UPDATE backup_runtime SET backup_monitor_started_at=? WHERE id=1').bind(start.toISOString()).run();
  const insert = app.db.prepare("INSERT INTO backup_jobs(id,created_at,updated_at,status,counts_json,schema_json,storage_provider,archives_json,error_code) VALUES(?,?,?,'failed','{}','[]','r2','[]','D1_EXPORT_FAILED')");
  await insert.bind('current-failure',new Date(start.getTime()+1000).toISOString(),start.toISOString()).run();
  await insert.bind('restored-failure',new Date(start.getTime()-86400000).toISOString(),start.toISOString()).run();
  const delivered: Record<string, unknown>[] = [];
  let responseStatus = 503;
  const send = (async (_input: RequestInfo | URL, init?: RequestInit) => {
   delivered.push(JSON.parse(String(init?.body)));
   return new Response(null,{status:responseStatus});
  }) as typeof fetch;
  const first = new Date(start.getTime()+2000);
  env.BACKUP_ALERT_URL = '';
  expect(await retryFailedBackupAlerts(env,first,send)).toBe(0);
  expect(await app.db.prepare('SELECT alert_attempted_at FROM backup_jobs WHERE id=?').bind('current-failure').first('alert_attempted_at')).toBeNull();
  env.BACKUP_ALERT_URL = 'https://alerts.example.test/backup';
  expect(await retryFailedBackupAlerts(env,first,send)).toBe(1);
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toMatchObject({event:'kumon_backup_failed',backupId:'current-failure',code:'D1_EXPORT_FAILED'});
  expect(await app.db.prepare('SELECT alert_delivered_at FROM backup_jobs WHERE id=?').bind('current-failure').first('alert_delivered_at')).toBeNull();
  expect(await retryFailedBackupAlerts(env,new Date(first.getTime()+30*60000),send)).toBe(0);
  responseStatus = 204;
  const retry = new Date(first.getTime()+61*60000);
  env.BACKUP_ENABLED = 'true';
  env.BACKUP_HOUR_UTC = '2';
  env.BACKUP_QUEUE = { send: async () => {} } as Env['BACKUP_QUEUE'];
  await backupScheduled({ scheduledTime: retry.getTime() } as ScheduledController,env,send);
  expect(delivered).toHaveLength(2);
  const saved = await app.db.prepare('SELECT alert_attempted_at,alert_delivered_at FROM backup_jobs WHERE id=?').bind('current-failure').first<{alert_attempted_at:string;alert_delivered_at:string}>();
  expect(saved).toEqual({alert_attempted_at:retry.toISOString(),alert_delivered_at:retry.toISOString()});
  expect(await retryFailedBackupAlerts(env,new Date(retry.getTime()+2*60*60000),send)).toBe(0);
  expect(await app.db.prepare('SELECT alert_attempted_at FROM backup_jobs WHERE id=?').bind('restored-failure').first('alert_attempted_at')).toBeNull();
 });
});
