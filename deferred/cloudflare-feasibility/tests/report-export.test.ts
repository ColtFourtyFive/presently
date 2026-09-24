import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { unstable_splitSqlQuery } from 'wrangler';
import { createStudent, json, observation, startApp, type App } from './helpers';
import { collectAttendanceExport } from '../client/attendance-export';
import { REPORT_LIMITS, type ReportPage } from '../shared/attendance-report';
import { parseCsv } from '../worker/import';

const range = { from: '2025-01-01', to: '2025-01-31' };
describe('bounded coherent attendance exports', () => {
  let app: App;
  beforeEach(async () => { app = await startApp({ metrics: true }); });
  afterEach(async () => { await app.close(); });
  async function visits(count: number) {
    const detail = await createStudent(app, { firstName: '=DANGEROUS()', lastName: 'Synthetic' });
    const statements = [], ids: string[] = [], events: string[] = [];
    const base = Date.parse('2025-01-10T18:00:00.000Z');
    const sql = 'INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)';
    for (let i = 0; i < count; i++) {
      const visitId = crypto.randomUUID(); ids.push(visitId);
      for (const [action, minute] of [['check_in', 0], ['check_out', 30]] as const) {
        const eventId = crypto.randomUUID(), at = new Date(base + (i * 60 + minute) * 60000).toISOString(); events.push(eventId);
        statements.push(app.db.prepare(sql).bind(eventId, 'test-center', detail.student.id, visitId, action, at, at, app.actor.id, app.actor.displayName, 'admin', action === 'check_out' ? detail.guardians[0].id : null, eventId, eventId));
      }
    }
    for (let i = 0; i < statements.length; i += 100) await app.db.batch(statements.slice(i, i + 100));
    return { detail, ids, events };
  }
  const read = async (path: string) => json<ReportPage>(await app.request(path, { token: app.token }));
  const first = () => read(`/api/admin/reports/attendance/pages?from=${range.from}&to=${range.to}`);

  it('downloads multiple bounded pages with every original observation/correction and safe CSV cells', async () => {
    const seeded = await visits(105), correctionId = crypto.randomUUID();
    await json(await app.request(`/api/admin/visits/${seeded.ids[0]}/corrections`, { token: app.token, body: { correctionId, expectedVersion: 2, checkInAt: '2025-01-10T18:01:00.000Z', checkOutAt: '2025-01-10T18:30:00.000Z', reason: 'Paper register says "one minute later"\nReviewed by owner' } }), 201);
    let requests = 0;
    const exported = await collectAttendanceExport(range.from, range.to, { readPage: async path => {
      requests++; const page = await read(path); expect(page.items.length).toBeLessThanOrEqual(REPORT_LIMITS.pageRows); return page;
    } });
    expect(requests).toBe(7); expect(exported.rows).toBe(105);
    const parsed = parseCsv(exported.csv); expect(parsed.rows).toHaveLength(105);
    const row = parsed.rows.find(row => row[0] === seeded.ids[0])!;
    expect(row[3]).toBe("'=DANGEROUS() Synthetic"); expect(row[4]).toBe('2025-01-10T18:00:00.000Z'); expect(row[6]).toBe('2025-01-10T18:01:00.000Z');
    expect(JSON.parse(row[16])).toEqual([expect.objectContaining({ id: correctionId, priorCheckInAt: '2025-01-10T18:00:00.000Z', checkInAt: '2025-01-10T18:01:00.000Z', reason: 'Paper register says "one minute later"\nReviewed by owner' })]);
    const observed = parsed.rows.flatMap(row => JSON.parse(row[17]) as { id: string }[]).map(event => event.id);
    expect(new Set(observed)).toEqual(new Set(seeded.events)); expect(observed).toHaveLength(210);
    const legacy = await app.request(`/api/admin/reports/attendance.csv?from=${range.from}&to=${range.to}`, { token: app.token });
    expect(legacy.status).toBe(422); expect(await legacy.text()).toContain('EXPORT_REQUIRES_PAGES');
  });

  it('preserves unmatched exceptional departures and safely escapes formula prefixes', async () => {
    const detail = await createStudent(app, { studentCode: '@SUM(1)', firstName: '+Formula', lastName: 'Fixture' });
    const eventId = crypto.randomUUID();
    await app.db.prepare(`INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,reason,payload_hash,insertion_nonce)
      VALUES(?,'test-center',?,NULL,'exceptional_departure','2025-01-10T18:00:00.000Z','2025-01-10T18:00:01.000Z',?,'-Unsafe','admin','No matching arrival recorded',?,?)`).bind(eventId, detail.student.id, app.actor.id, eventId, eventId).run();
    const exported = await collectAttendanceExport(range.from, range.to, { readPage: read });
    const parsed = parseCsv(exported.csv); expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0][0]).toBe(''); expect(parsed.rows[0][4]).toBe(''); expect(parsed.rows[0][5]).toBe('2025-01-10T18:00:00.000Z');
    expect(parsed.rows[0][2]).toBe("'@SUM(1)"); expect(parsed.rows[0][3]).toBe("'+Formula Fixture"); expect(parsed.rows[0][9]).toBe("'-Unsafe");
    expect(JSON.parse(parsed.rows[0][17])).toEqual([expect.objectContaining({ id: eventId, unmatched: true, reason: 'No matching arrival recorded' })]);
  });

  it('rejects any selected-date or identity change between pages, including a visit moved out of range', async () => {
    const seeded = await visits(2); const original = await first();
    const changedRange = await app.request(
      `/api/admin/reports/attendance/pages?from=2025-01-02&to=${range.to}` +
      `&phase=observations&epoch=${original.epoch}&generation=${original.generation}`,
      { token: app.token },
    );
    expect(changedRange.status).toBe(409);
    expect(await changedRange.text()).toContain('REPORT_CHANGED');
    await app.db.prepare("UPDATE visits SET check_in_at='2025-02-10T18:00:00.000Z',check_out_at='2025-02-10T18:30:00.000Z' WHERE id=?").bind(seeded.ids[1]).run();
    const changed = await app.request(`/api/admin/reports/attendance/pages?from=${range.from}&to=${range.to}&phase=observations&epoch=${original.epoch}&generation=${original.generation}`, { token: app.token });
    expect(changed.status).toBe(409); expect(await changed.text()).toContain('REPORT_CHANGED');
    const renamed = await first(); await json(await app.request(`/api/admin/students/${seeded.detail.student.id}`, { token: app.token, method: 'PATCH', body: { firstName: 'Renamed' } }));
    expect((await app.request(`/api/admin/reports/attendance/pages?from=${range.from}&to=${range.to}&phase=corrections&epoch=${renamed.epoch}&generation=${renamed.generation}`, { token: app.token })).status).toBe(409);
  });

  it('does not abort historical exports for unrelated current-day check-ins or center counters', async () => {
    await visits(1); const original = await first(); const todayStudent = await createStudent(app);
    await json(await app.request('/api/admin/attendance', { token: app.token, body: observation(todayStudent.student.id, 'check_in') }), 201);
    await app.db.prepare('UPDATE centers SET student_sequence=student_sequence+1 WHERE id=?').bind('test-center').run();
    const next = await read(`/api/admin/reports/attendance/pages?from=${range.from}&to=${range.to}&phase=observations&epoch=${original.epoch}&generation=${original.generation}`);
    expect(next.epoch).toBe(original.epoch); expect(next.items).toHaveLength(2);
  });

  it('invalidates outstanding pages after recovery even when the numeric epoch is unchanged', async () => {
    await visits(1); const original = await first();
    const resetSql = await readFile(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8');
    await app.db.batch(unstable_splitSqlQuery(resetSql).map(sql => app.db.prepare(sql)));
    await app.db.prepare('UPDATE staff SET email=? WHERE id=?').bind(app.actor.email, app.actor.id).run();
    const restored = await first();
    expect(restored.epoch).toBe(original.epoch); expect(restored.generation).not.toBe(original.generation);
    const response = await app.request(`/api/admin/reports/attendance/pages?from=${range.from}&to=${range.to}&phase=observations&epoch=${original.epoch}&generation=${original.generation}`, { token: app.token });
    expect(response.status).toBe(409); expect(await response.text()).toContain('REPORT_CHANGED');
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      const page = await read(path); if (page.phase !== 'visits') page.generation = original.generation; return page;
    } })).rejects.toThrow(/Attendance changed/);
  });

  it('fails closed when the final response is interrupted or its totals/relations are incomplete', async () => {
    await visits(1);
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      if (new URL(path, 'https://test').searchParams.get('phase') === 'unmatched') throw new Error('Connection interrupted'); return read(path);
    } })).rejects.toThrow('Connection interrupted');
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      const page = await read(path); if (page.phase === 'observations') page.items = []; return page;
    } })).rejects.toThrow(/missing/);
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      const page = await read(path); if (page.phase === 'observations') page.items[0].data.visit_id = 'nonexistent'; return page;
    } })).rejects.toThrow(/without its visit/);
  });

  it('rejects duplicate records, a repeated cursor, excessive bytes, cancellation and mid-export revocation', async () => {
    await visits(1);
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      const page = await read(path); if (page.phase === 'observations') page.items[1] = page.items[0]; return page;
    } })).rejects.toThrow(/verified/);
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      const page = await read(path); if (page.phase === 'visits') page.next = 'repeated'; return page;
    } })).rejects.toThrow(/verified/);
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      const page = await read(path); page.items[0].data.extra = 'x'.repeat(REPORT_LIMITS.bytes); return page;
    } })).rejects.toThrow(/32 MiB/);
    const controller = new AbortController();
    await expect(collectAttendanceExport(range.from, range.to, { signal: controller.signal, readPage: async path => { const page = await read(path); controller.abort(); return page; } })).rejects.toThrow();
    const staffId = crypto.randomUUID(), timestamp = new Date().toISOString();
    await app.db.prepare("INSERT INTO staff(id,center_id,email,display_name,role,created_at,updated_at) VALUES(?,'test-center','report-manager@example.test','Report manager','manager',?,?)").bind(staffId, timestamp, timestamp).run();
    const token = await app.signer.token({ email: 'report-manager@example.test', sub: 'report-manager' }); let requested = 0;
    await expect(collectAttendanceExport(range.from, range.to, { readPage: async path => {
      if (++requested === 2) await app.db.prepare("UPDATE staff SET role='front_desk' WHERE id=?").bind(staffId).run();
      const response = await app.request(path, { token }); if (!response.ok) throw new Error(`Access denied ${response.status}`); return response.json() as Promise<ReportPage>;
    } })).rejects.toThrow('Access denied 403');
  });

  it('validates cursor scope and access on every page', async () => {
    expect((await app.request('/api/admin/reports/attendance/pages')).status).toBe(401);
    for (const extra of ['phase=invalid', 'phase=observations', 'after=not-json', 'epoch=NaN', 'epoch=-1', 'epoch=9007199254740993', 'epoch=0', 'generation=' + '0'.repeat(32), 'epoch=0&generation=invalid']) {
      expect((await app.request(`/api/admin/reports/attendance/pages?from=${range.from}&to=${range.to}&${extra}`, { token: app.token })).status).toBe(400);
    }
    const empty = await collectAttendanceExport(range.from, range.to, { readPage: read }); expect(empty.rows).toBe(0); expect(empty.csv.split('\r\n')).toHaveLength(1); expect(empty.csv).toContain('"Visit ID"');
  });

  it('invalidates snapshots when exported staff/guardian names, review status or timezone changes', async () => {
    const seeded = await visits(1);
    const assertChange = async (change: () => Promise<unknown>) => {
      const before = await first(); await change();
      const response = await app.request(`/api/admin/reports/attendance/pages?from=${range.from}&to=${range.to}&phase=observations&epoch=${before.epoch}&generation=${before.generation}`, { token: app.token });
      expect(response.status).toBe(409); expect(await response.text()).toContain('REPORT_CHANGED');
    };
    await assertChange(() => app.db.prepare("UPDATE guardians SET display_name='Changed guardian' WHERE id=?").bind(seeded.detail.guardians[0].id).run());
    await assertChange(() => app.db.prepare("UPDATE staff SET display_name='Changed owner' WHERE id=?").bind(app.actor.id).run());
    await assertChange(() => app.db.prepare("UPDATE visits SET review_status='resolved' WHERE id=?").bind(seeded.ids[0]).run());
    await assertChange(() => app.db.prepare("UPDATE centers SET timezone='UTC' WHERE id='test-center'").run());
  });
});
