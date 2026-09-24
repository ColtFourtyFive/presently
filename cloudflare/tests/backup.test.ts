import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BackupStatus } from '../shared/types';
import { verifyBackup } from '../worker/backup-crypto';
import { json, startApp, type App } from './helpers';

const ACCOUNT = 'test-account';
const DATABASE = 'test-database';
const KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const DUMP = new TextEncoder().encode(Array.from({ length: 30000 }, (_, i) => `INSERT INTO "students" VALUES(${i},1,'K${i}','Test','Student ${i}','','[]','',1,1,'2026-01-01','2026-01-01');`).join('\n'));

describe('encrypted R2 backups', () => {
  let app: App;
  const exportCalls: unknown[] = [];
  beforeAll(async () => {
    app = await startApp({
      r2: true, queue: true,
      bindings: {
        BACKUP_ENABLED: 'true', BACKUP_KEY: KEY, CF_ACCOUNT_ID: ACCOUNT, CF_DATABASE_ID: DATABASE, CF_D1_EXPORT_TOKEN: 'd1-edit-only-token',
      },
      mockFetch: mock => {
        mock.get('https://api.cloudflare.com').intercept({ path: `/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/export`, method: 'POST' })
          .reply(200, (options: { body?: unknown; headers?: unknown }) => {
            exportCalls.push({ headers: options.headers });
            return { success: true, result: { at_bookmark: 'bookmark-1', status: 'complete', result: { signed_url: 'https://export.example.test/dump.sql' } } };
          }).persist();
        mock.get('https://export.example.test').intercept({ path: '/dump.sql', method: 'GET' })
          .reply((options: { headers?: Record<string, string> | string[] }) => {
            const headers = options.headers as Record<string, string>;
            const range = (headers.Range ?? headers.range ?? '').match(/bytes=(\d+)-(\d+)/)!;
            const start = Number(range[1]);
            const end = Math.min(Number(range[2]), DUMP.length - 1);
            return { statusCode: 206, data: Buffer.from(DUMP.slice(start, end + 1)), responseOptions: { headers: { 'content-range': `bytes ${start}-${end}/${DUMP.length}` } } };
          }).persist();
      },
    });
  });
  afterAll(async () => { await app?.close(); });

  it('exports, encrypts, stores and verifies a backup that the recovery key can decrypt', async () => {
    const { id } = await json<{ id: string }>(await app.admin('/backups/start', { location: null, body: {} }), 202);
    let steps = 0;
    for (; steps < 20; steps++) {
      const result = await app.invoke('queue', { messages: [{ jobId: id }] }) as { sent: unknown[]; acked: number[]; retried: number[] };
      expect(result.retried).toEqual([]);
      if (!result.sent.length) break;
    }
    const status = await json<BackupStatus>(await app.admin('/backups', { location: null }));
    const job = status.jobs.find(j => j.id === id)!;
    expect(job).toMatchObject({ status: 'complete', sqlBytes: DUMP.length, parts: Math.ceil(DUMP.length / (512 * 1024)) });
    expect(status.stale).toBe(false);
    expect(JSON.stringify(exportCalls[0])).toContain('d1-edit-only-token');

    const bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
    const read = async (name: string) => new Uint8Array(await (await bucket.get(`backups/${id}/${name}`))!.arrayBuffer());
    const { manifest, sql } = await verifyBackup(KEY, await read('manifest.bin'), read);
    expect(manifest.parts).toHaveLength(job.parts);
    expect(Buffer.from(sql).equals(Buffer.from(DUMP))).toBe(true);
    // Nothing in R2 is readable without the key.
    const stored = new TextDecoder().decode(await read('part-00000.bin'));
    expect(stored).not.toContain('INSERT INTO');
    const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32)));
    await expect(verifyBackup(wrongKey, await read('manifest.bin'), read)).rejects.toThrow();
  });

  it('starts the scheduled backup only at the business’s local backup hour', async () => {
    await json(await app.admin('/business', { location: null, method: 'PATCH', body: { timezone: 'America/Los_Angeles', backupHour: 2 } }));
    // 10:00 UTC is 03:00 in Los Angeles during daylight time: not the backup hour.
    const off = await app.invoke('scheduled', { at: Date.parse('2026-07-01T10:00:00Z') }) as { sent: unknown[] };
    expect(off.sent).toEqual([]);
    const before = (await app.db.prepare("SELECT count(*) AS n FROM backup_jobs WHERE reason = 'scheduled'").first<{ n: number }>())!.n;
    // 09:00 UTC is 02:00 in Los Angeles.
    const on = await app.invoke('scheduled', { at: Date.parse('2026-07-01T09:00:00Z') }) as { sent: unknown[] };
    expect(on.sent).toHaveLength(1);
    const after = (await app.db.prepare("SELECT count(*) AS n FROM backup_jobs WHERE reason = 'scheduled'").first<{ n: number }>())!.n;
    expect(after).toBe(before + 1);
  });

  it('limits backup controls to the owner', async () => {
    await json(await app.admin('/staff', { location: null, body: { email: 'manager@example.test', displayName: 'M', role: 'manager', locationIds: [app.locationId] } }), 201);
    const token = await app.signer.token({ email: 'manager@example.test', sub: 'manager' });
    expect((await app.admin('/backups', { token, location: null })).status).toBe(403);
    expect((await app.admin('/backups/start', { token, location: null, body: {} })).status).toBe(403);
  });
});
