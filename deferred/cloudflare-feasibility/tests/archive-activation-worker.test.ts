import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { seedGrowthFixture } from '../scripts/fixtures';
import { startApp, json, type App } from './helpers';

describe('bounded version 2 archive activation through Worker routes', () => {
  let app: App | undefined;
  afterEach(async () => { await app?.close(); });

  it('publishes an older synthetic month and identifies its source rows without deleting them', async () => {
    app = await startApp({ r2: true, bindings: {
      APP_ENV: 'local', ARCHIVE_ENABLED: 'true', ARCHIVE_V2_ENABLED: 'true',
      BACKUP_KEY: randomBytes(32).toString('base64'),
    } });
    const fixture = await seedGrowthFixture(app.db, app.actor, 2);
    const month = fixture.from.slice(0, 7);
    expect(fixture.visits).toBe(300);

    let ready = false;
    for (let call = 0; call < 500 && !ready; call++) {
      const result = await json<{ state: string }>(await app.request('/api/admin/archives/semantic/maintenance/backfill/advance', { token: app.token, body: {} }));
      ready = result.state === 'ready';
    }
    expect(ready).toBe(true);

    const { jobId } = await json<{ jobId: string }>(await app.request('/api/admin/archives/start', { token: app.token, body: { month } }), 202);
    let archived = false;
    for (let call = 0; call < 500 && !archived; call++) {
      const result = await json<{ status: string }>(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} }));
      if (result.status === 'complete') archived = true;
      else if (!['parts', 'verify'].includes(result.status)) throw new Error(`Archive stopped: ${result.status}`);
    }
    expect(archived).toBe(true);

    const { parts } = await json<{ parts: number }>(await app.request(`/api/admin/archives/semantic/${jobId}/start`, { token: app.token, body: {} }), 202);
    expect(parts).toBeGreaterThan(1);
    for (let index = 0; index < parts; index++) {
      await json(await app.request(`/api/admin/archives/semantic/${jobId}/parts/${index}`, { token: app.token, body: {} }));
    if (index === 0) {
      const progress = await json<{ staging: { partCount: number; stagedParts: number; nextPart: number | null } }>(await app.request(`/api/admin/archives/semantic/${jobId}`, { token: app.token }));
      expect(progress.staging).toEqual({ partCount: parts, stagedParts: 1, nextPart: 1 });
    }
    }
    await json(await app.request(`/api/admin/archives/semantic/${jobId}/freeze`, { token: app.token, body: {} }), 202);
    let verified = false;
    for (let call = 0; call < 2_000 && !verified; call++) {
      const result = await json<{ status: string }>(await app.request(`/api/admin/archives/semantic/${jobId}/verify/advance`, { token: app.token, body: {} }));
      if (result.status === 'complete') verified = true;
      else if (!['pending', 'busy'].includes(result.status)) throw new Error(`Semantic verification stopped: ${result.status}`);
    }
    expect(verified).toBe(true);

    await json(await app.request(`/api/admin/archives/semantic/${jobId}/publish/start`, { token: app.token, body: {} }), 202);
    let published = false;
    for (let call = 0; call < 2_000 && !published; call++) {
      const result = await json<{ state: string }>(await app.request(`/api/admin/archives/semantic/${jobId}/publish/advance`, { token: app.token, body: {} }));
      if (result.state === 'published') published = true;
      else if (result.state !== 'building') throw new Error(`Publication stopped: ${result.state}`);
    }
    expect(published).toBe(true);

    const { jobId: retentionId } = await json<{ jobId: string }>(await app.request('/api/admin/archives/retention/start', { token: app.token, body: { limit: 25 } }), 202);
    let candidates = 0;
    for (let call = 0; call < 500; call++) {
      const result = await json<{ status: string; candidateCount: number }>(await app.request(`/api/admin/archives/retention/${retentionId}/advance`, { token: app.token, body: {} }));
      if (result.status === 'complete') { candidates = result.candidateCount; break; }
      if (result.status !== 'planning') throw new Error(`Retention dry run stopped: ${result.status}`);
    }
    expect(candidates).toBe(25);
    expect(await app.db.prepare('SELECT count(*) AS n FROM visits').first<number>('n')).toBe(300);
    expect((await app.db.prepare('SELECT enabled FROM history_source_eviction_policies WHERE center_id=?').bind('test-center').first<number>('enabled'))).toBe(0);
  }, 300_000);
});
