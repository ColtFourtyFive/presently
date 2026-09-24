import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceResult, RosterPollResponse, RosterResponse } from '../shared/types.js';
import { BACKUP_TABLES } from '../worker/backup.js';
import { createStudent, json, observation, startApp, type App } from './helpers.js';

type Metrics = { rowsRead: number; rowsWritten: number; statements: number; unmeasuredCalls: number };
type AppResponse = Awaited<ReturnType<App['request']>>;

function metrics(response: AppResponse): Metrics {
  const value = response.headers.get('x-isolated-d1-metrics');
  if (!value) throw new Error('Missing isolated D1 metrics.');
  return JSON.parse(value) as Metrics;
}

describe('conditional current-roster polling', () => {
  let app: App;

  beforeAll(async () => { app = await startApp({ metrics: true }); });
  afterAll(async () => app?.close());

  const revision = async () => {
    const value = await app.db.prepare('SELECT version FROM roster_revisions WHERE center_id=?').bind('test-center').first<number>('version');
    if (value === null) throw new Error('Missing roster revision.');
    return value;
  };
  const poll = (known?: number | string) => app.request(`/api/admin/roster${known === undefined ? '' : `?revision=${known}`}`, { token: app.token });

  it('answers an unchanged poll with only the revision lookup', async () => {
    const fullResponse = await poll();
    const fullMetrics = metrics(fullResponse);
    const full = await json<RosterResponse>(fullResponse);

    const unchangedResponse = await poll(full.revision);
    const unchangedMetrics = metrics(unchangedResponse);
    const unchanged = await json<RosterPollResponse>(unchangedResponse);

    expect(unchanged).toEqual(expect.objectContaining({ unchanged: true, revision: full.revision }));
    expect(unchanged).not.toHaveProperty('items');
    expect(unchangedMetrics.statements).toBe(fullMetrics.statements - 2);
    expect(unchangedMetrics.rowsRead).toBeLessThan(fullMetrics.rowsRead);
    expect(unchangedMetrics.rowsWritten).toBe(0);
    expect(unchangedMetrics.unmeasuredCalls).toBe(0);
  });

  it('advances for arrival and departure, and returns the changed roster', async () => {
    const detail = await createStudent(app);
    const beforeArrival = await revision();
    const arrival = await json<AttendanceResult>(await app.request('/api/admin/attendance', {
      token: app.token,
      body: observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 120_000).toISOString() }),
    }), 201);
    expect(await revision()).toBe(beforeArrival + 1);

    const present = await json<RosterResponse>(await poll(beforeArrival));
    expect(present.revision).toBe(beforeArrival + 1);
    expect(present.items.map(item => item.id)).toContain(arrival.visit!.id);

    await json<AttendanceResult>(await app.request('/api/admin/attendance', {
      token: app.token,
      body: observation(detail.student.id, 'check_out', { guardianId: detail.guardians[0].id }),
    }), 201);
    expect(await revision()).toBe(present.revision + 1);

    const departed = await json<RosterResponse>(await poll(present.revision));
    expect(departed.items.map(item => item.id)).not.toContain(arrival.visit!.id);
  });

  it('advances for every student identity field shown on the roster', async () => {
    const detail = await createStudent(app);
    let prior = await revision();
    for (const [column, value] of [
      ['student_code', `POLL-${crypto.randomUUID()}`],
      ['first_name', 'Changed'],
      ['last_name', 'Roster'],
      ['active', 0],
    ] as const) {
      await app.db.prepare(`UPDATE students SET ${column}=? WHERE id=?`).bind(value, detail.student.id).run();
      const next = await revision();
      expect(next, column).toBe(prior + 1);
      prior = next;
    }
  });

  it('advances when displayed staff or guardian names change', async () => {
    const detail = await createStudent(app);
    let prior = await revision();
    await app.db.prepare('UPDATE staff SET display_name=? WHERE id=?').bind('Renamed Staff', app.actor.id).run();
    expect(await revision()).toBe(prior + 1);
    prior++;
    await app.db.prepare('UPDATE guardians SET display_name=? WHERE id=?').bind('Renamed Guardian', detail.guardians[0].id).run();
    expect(await revision()).toBe(prior + 1);
  });

  it('does not reload the roster for unrelated CRM changes', async () => {
    const detail = await createStudent(app);
    const prior = await revision();
    await app.db.batch([
      app.db.prepare('UPDATE students SET grade=? WHERE id=?').bind('7', detail.student.id),
      app.db.prepare('UPDATE guardians SET phone=? WHERE id=?').bind('555-0199', detail.guardians[0].id),
      app.db.prepare('UPDATE staff SET updated_at=? WHERE id=?').bind(new Date().toISOString(), app.actor.id),
      app.db.prepare('UPDATE centers SET name=? WHERE id=?').bind('Renamed Center', 'test-center'),
    ]);
    expect(await revision()).toBe(prior);
    expect(await json<RosterPollResponse>(await poll(prior))).toEqual(expect.objectContaining({ unchanged: true, revision: prior }));
  });

  it('rejects malformed revisions and forces a full snapshot for a different revision', async () => {
    for (const value of ['', '0', '-1', '1.5', '01', 'abc', '9007199254740992']) {
      expect((await poll(value)).status, value).toBe(400);
    }
    const current = await revision();
    const restoredOrChanged = await json<RosterResponse>(await poll(current + 10));
    expect(restoredOrChanged.revision).toBe(current);
    expect(restoredOrChanged).toHaveProperty('items');
  });

  it('includes the revision table in backup inventory and backup maintenance locking', async () => {
    expect(BACKUP_TABLES).toContain('roster_revisions');
    expect(new Set(BACKUP_TABLES).size).toBe(96);
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=? WHERE id=1').bind(new Date(Date.now() + 60_000).toISOString()).run();
    await expect(app.db.prepare('UPDATE roster_revisions SET version=version+1 WHERE center_id=?').bind('test-center').run()).rejects.toThrow('backup_maintenance');
    await app.db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
  });
});
