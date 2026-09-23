import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import type { AttendanceResult } from '../shared/types';
import { advanceHistoryBackfill } from '../worker/history-lookup';
import { restorePublicationDatabase, snapshotPublicationDatabase } from './archive-publication-fixture';
import { createStudent, json, observation, startApp, type App } from './helpers';
import type { TestRuntime } from './runtime';

const opened: Array<App | TestRuntime> = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(app => app.close()));
});

describe('restored history audit aliases', () => {
  it('keeps the permanent event owner when its live source row was archived', async () => {
    const source = await startApp();
    opened.push(source);
    const student = await createStudent(source);
    const body = observation(student.student.id, 'check_in', {
      observedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const attendance = await json<AttendanceResult>(await source.request('/api/admin/attendance', {
      token: source.token,
      body,
    }), 201);
    const requestId = attendance.event.id;
    expect(await source.db.prepare('SELECT source_kind FROM history_request_keys WHERE request_id=?')
      .bind(requestId).first('source_kind')).toBe('event');
    // Older installations could retain the event's physical audit alias.
    // Recreate only that historical shape, then immediately restore today's
    // collision guard before taking the recovery snapshot.
    const guard = await source.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='standalone_audit_id_available'")
      .first<string>('sql');
    expect(guard).toBeTruthy();
    await source.db.batch([
      source.db.prepare('DROP TRIGGER standalone_audit_id_available'),
      source.db.prepare('INSERT INTO audit_entries SELECT * FROM attendance_audit_source WHERE id=?').bind(requestId),
      source.db.prepare(guard!),
    ]);
    expect(await source.db.prepare('SELECT count(*) AS n FROM audit_entries WHERE id=?')
      .bind(requestId).first('n')).toBe(1);

    const sql = await snapshotPublicationDatabase(source, { omitTables: ['attendance_events'] });
    const restored = await restorePublicationDatabase(sql, { r2: false });
    opened.push(restored);
    expect(await restored.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE id=?')
      .bind(requestId).first('n')).toBe(0);
    expect(await restored.db.prepare('SELECT source_kind FROM history_request_keys WHERE request_id=?')
      .bind(requestId).first('source_kind')).toBe('event');

    const reset = unstable_splitSqlQuery(await readFile(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8'));
    await restored.db.batch(reset.map(statement => restored.db.prepare(statement)));
    const database = await restored.runtime.getD1Database('CRM_DB');
    let ready = false;
    for (let step = 0; step < 100; step += 1) {
      const result = await advanceHistoryBackfill(database, 1);
      if (result.state === 'ready') {
        ready = true;
        break;
      }
    }
    expect(ready).toBe(true);
    expect(await restored.db.prepare('SELECT source_kind,center_id FROM history_request_keys WHERE request_id=?')
      .bind(requestId).first()).toEqual({ source_kind: 'event', center_id: 'test-center' });
    expect(await restored.db.prepare('SELECT count(*) AS n FROM audit_entries WHERE id=?')
      .bind(requestId).first('n')).toBe(1);
  });
});
