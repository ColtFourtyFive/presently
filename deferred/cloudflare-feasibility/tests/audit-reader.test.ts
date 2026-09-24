import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditActivityPage } from '../shared/audit-reader';
import type { Staff } from '../shared/types';
import { archivedCorrectionAuditPageSql, auditPageSql } from '../worker/audit-reader';
import { CookieJar, createStudent, json, observation, seedHistoricalVisit, startApp, type App } from './helpers';

describe('current logical audit activity in native Worker/D1', () => {
  let app: App;
  beforeAll(async () => { app = await startApp({ metrics: true }); });
  afterAll(async () => app?.close());
  const query = (body: Record<string, unknown> = {}, token = app.token) => app.request('/api/admin/audit/query', { token, body });
  async function insertAudit(createdAt: string, overrides: Record<string, unknown> = {}) {
    const values = { id: crypto.randomUUID(), center: 'test-center', actorId: app.actor.id, actorName: 'Synthetic Manager', action: 'student_updated', type: 'student', entity: crypto.randomUUID(), detail: '{"field":"grade"}', createdAt, ...overrides };
    await app.db.prepare('INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(values.id, values.center, values.actorId, values.actorName, values.action, values.type, values.entity, values.detail, values.createdAt).run();
    return values;
  }
  async function staff(role: Staff['role']) {
    const email = `${crypto.randomUUID()}@example.test`;
    const { staff } = await json<{ staff: Staff }>(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: `Audit ${role}`, role } }), 201);
    return { ...staff, token: await app.signer.token({ email }) };
  }

  it('returns a true empty range with source provenance and private cache controls', async () => {
    const response = await query({ from: '2001-01-01', to: '2001-01-31' });
    expect(response.headers.get('cache-control')).toBe('private, no-store'); expect(response.headers.get('pragma')).toBe('no-cache');
    expect(await json<AuditActivityPage>(response)).toMatchObject({ items: [], scanned: 0, searchComplete: true, nextCursor: null, provenance: { view: 'audit_timeline', storage: 'current-database', evictionEnabled: false, snapshot: false } });
  });

  it('reads actual audit_timeline rows from stored audits, immutable events, and corrections without duplicates or source rewrites', async () => {
    const student = await createStudent(app), arrival = await json<{ event: { id: string }; visit: { id: string; version: number } }>(await app.request('/api/admin/attendance', { token: app.token, body: observation(student.student.id, 'check_in', { observedAt: new Date(Date.now() - 300000).toISOString() }) }), 201);
    const correctionId = crypto.randomUUID();
    await json(await app.request(`/api/admin/visits/${arrival.visit.id}/corrections`, { token: app.token, body: { correctionId, expectedVersion: arrival.visit.version, checkInAt: new Date(Date.now() - 360000).toISOString(), checkOutAt: null, reason: 'Arrival time verified in the source log.' } }), 201);
    const stored = await insertAudit(new Date().toISOString(), { action: 'check_in', type: 'attendance_event', detail: '{"legacy":"stored event audit keeps its actual detail"}' });
    const before = await app.db.prepare('SELECT count(*) AS n FROM audit_timeline').first('n');
    const page = await json<AuditActivityPage>(await query({ limit: 50 }));
    const event = page.items.find(item => item.id === arrival.event.id)!, corrected = page.items.find(item => item.id === correctionId)!, physical = page.items.find(item => item.id === stored.id)!;
    expect(event.source).toBe('attendance-event-projection'); expect(corrected.source).toBe('attendance-correction-projection'); expect(physical.source).toBe('stored-audit');
    expect(physical.detail).toBe(stored.detail); expect(JSON.parse(corrected.detail).reason).toBe('Arrival time verified in the source log.');
    for (const item of [event, corrected, physical]) {
      const actual = await app.db.prepare('SELECT * FROM audit_timeline WHERE id=?').bind(item.id).first<Record<string, unknown>>();
      expect(item).toMatchObject({ actorName: actual!.actor_name, actorId: actual!.actor_id, action: actual!.action, entityType: actual!.entity_type, entityId: actual!.entity_id, recordedAt: actual!.created_at, detail: actual!.detail });
      expect(page.items.filter(row => row.id === item.id)).toHaveLength(1);
    }
    expect(await app.db.prepare('SELECT count(*) AS n FROM audit_timeline').first('n')).toBe(before);
    const originalDefinition = 'SELECT * FROM audit_entries UNION ALL SELECT p.id,p.center_id,p.actor_id,p.actor_name,p.action,p.entity_type,p.entity_id,p.detail,p.created_at FROM attendance_audit_source p WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=p.id)';
    for (const comparison of [`SELECT * FROM audit_timeline EXCEPT SELECT * FROM (${originalDefinition})`, `SELECT * FROM (${originalDefinition}) EXCEPT SELECT * FROM audit_timeline`]) expect((await app.db.prepare(comparison).all()).results).toEqual([]);
    expect(JSON.stringify(page)).not.toMatch(/payload_hash|insertion_nonce|pin_hash|token_hash/);
  });

  it('applies center-local calendar bounds over the spring daylight saving transition and uses recorded time', async () => {
    const before = await insertAudit('2024-03-10T07:59:59.999Z'), start = await insertAudit('2024-03-10T08:00:00.000Z'), end = await insertAudit('2024-03-11T06:59:59.999Z'), after = await insertAudit('2024-03-11T07:00:00.000Z');
    const page = await json<AuditActivityPage>(await query({ from: '2024-03-10', to: '2024-03-10' }));
    expect(page.range.timezone).toBe('America/Los_Angeles'); expect(page.items.map(item => item.id)).toEqual([end.id, start.id]);
    expect(page.items.some(item => item.id === before.id || item.id === after.id)).toBe(false);
    const observed = await createStudent(app); const visit = await seedHistoricalVisit(app, observed, '2023-05-01T12:00:00.000Z', '2023-05-01T12:30:00.000Z');
    const observationPage = await json<AuditActivityPage>(await query({ from: '2023-05-01', to: '2023-05-01', action: 'check_in' }));
    expect(observationPage.items[0].id).toBe(visit.arrivalId);
  });

  it('retains physical legacy audit precedence even when its detail and recorded date differ from a projection', async () => {
    const student = await createStudent(app), arrived = await json<{ event: { id: string } }>(await app.request('/api/admin/attendance', { token: app.token, body: observation(student.student.id, 'check_in') }), 201);
    // Fixture represents a non-equivalent physical row that migration 7 would
    // retain. Runtime guards correctly prevent creating such collisions today.
    await app.db.prepare('DROP TRIGGER standalone_audit_id_available').run();
    try { await insertAudit('2005-09-01T12:00:00.000Z', { id: arrived.event.id, action: 'legacy_observation', type: 'attendance_event', entity: arrived.event.id, detail: '{"legacy":"original stored detail"}' }); }
    finally { await app.db.prepare("CREATE TRIGGER standalone_audit_id_available BEFORE INSERT ON audit_entries BEGIN SELECT CASE WHEN EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id) THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END; END").run(); }
    const page = await json<AuditActivityPage>(await query({ from: '2005-09-01', to: '2005-09-01' }));
    expect(page.items).toHaveLength(1); expect(page.items[0]).toMatchObject({ id: arrived.event.id, action: 'legacy_observation', recordedAt: '2005-09-01T12:00:00.000Z', detail: '{"legacy":"original stored detail"}', source: 'stored-audit' });
    expect((await json<AuditActivityPage>(await query({ entityId: arrived.event.id }))).items).toEqual([]);
    const originalDefinition = 'SELECT * FROM audit_entries UNION ALL SELECT p.id,p.center_id,p.actor_id,p.actor_name,p.action,p.entity_type,p.entity_id,p.detail,p.created_at FROM attendance_audit_source p WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=p.id)';
    for (const comparison of [`SELECT * FROM audit_timeline EXCEPT SELECT * FROM (${originalDefinition})`, `SELECT * FROM (${originalDefinition}) EXCEPT SELECT * FROM audit_timeline`]) expect((await app.db.prepare(comparison).all()).results).toEqual([]);
    expect(await app.db.prepare('SELECT count(*) AS n FROM audit_timeline WHERE id=?').bind(arrived.event.id).first('n')).toBe(1);
  });

  it('combines exact action/entity filters with literal case-insensitive staff substring in POST bodies', async () => {
    const item = await insertAudit('2024-04-01T12:00:00.000Z', { actorName: 'Máría %_ Guardian', action: 'guardian_authority_updated', entity: 'ENTITY-PRIVATE-321' });
    const filters = { from: '2024-04-01', to: '2024-04-01', actor: 'máría %_', action: 'guardian_authority_updated', entityType: 'student', entityId: 'ENTITY-PRIVATE-321' };
    expect((await json<AuditActivityPage>(await query(filters))).items.map(row => row.id)).toEqual([item.id]);
    for (const changed of [{ actor: 'máría __' }, { action: 'student_updated' }, { entityType: 'visit' }, { entityId: 'OTHER' }]) expect((await json<AuditActivityPage>(await query({ ...filters, ...changed }))).items).toEqual([]);
    expect((await app.request('/api/admin/audit/query?actor=private', { token: app.token, body: {} })).status).toBe(400);
    expect((await app.request('/api/admin/audit/query', { token: app.token })).status).toBe(404);
  });

  it('uses a deterministic seek cursor on timestamp ties and binds the reader, center, filters, range, page size, and timezone', async () => {
    const ids = [];
    for (let index = 0; index < 5; index++) ids.push((await insertAudit('2024-05-01T12:00:00.000Z', { id: `audit:${crypto.randomUUID()}:created` })).id);
    const filters = { from: '2024-05-01', to: '2024-05-01', limit: 2 };
    const first = await json<AuditActivityPage>(await query(filters)); expect(first.items).toHaveLength(2); expect(first.nextCursor).not.toBeNull();
    const second = await json<AuditActivityPage>(await query({ ...filters, cursor: first.nextCursor })), third = await json<AuditActivityPage>(await query({ ...filters, cursor: second.nextCursor }));
    expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual(ids.sort().reverse()); expect(third.nextCursor).toBeNull(); expect(first.asOf).toBe(second.asOf);
    for (const changed of [{ action: 'student_updated' }, { actor: 'Synthetic' }, { entityType: 'student' }, { from: '2024-04-30' }, { limit: 3 }]) expect((await query({ ...filters, ...changed, cursor: first.nextCursor })).status).toBe(400);
    const manager = await staff('manager'); expect((await query({ ...filters, cursor: first.nextCursor }, manager.token)).status).toBe(400);
    await app.db.prepare("UPDATE centers SET timezone='America/New_York' WHERE id='test-center'").run();
    try { expect((await query({ ...filters, cursor: first.nextCursor })).status).toBe(400); } finally { await app.db.prepare("UPDATE centers SET timezone='America/Los_Angeles' WHERE id='test-center'").run(); }
  });

  it('continues past an empty filtered scan instead of claiming no activity', async () => {
    await app.db.prepare(`WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<205)
      INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
      SELECT printf('scan-fixture-%04d',n),'test-center',?,'Scan Manager',iif(n<=3,'rare_action','common_action'),'student','scan-student','{}','2024-06-01T12:00:00.000Z' FROM seq`).bind(app.actor.id).run();
    const filters = { from: '2024-06-01', to: '2024-06-01', action: 'rare_action' };
    const first = await json<AuditActivityPage>(await query(filters)); expect(first).toMatchObject({ items: [], scanned: 200, searchComplete: false }); expect(first.nextCursor).toBeTruthy();
    const second = await json<AuditActivityPage>(await query({ ...filters, cursor: first.nextCursor })); expect(second.items).toHaveLength(3); expect(second.searchComplete).toBe(true); expect(second.nextCursor).toBeNull();
  });

  it('caps displayed detail and the response size without skipping entries', async () => {
    for (let index = 0; index < 10; index++) await insertAudit('2024-07-01T12:00:00.000Z', { detail: '🙂'.repeat(5000) });
    const filters = { from: '2024-07-01', to: '2024-07-01', limit: 50 }; let cursor: string | null = null; const ids = new Set<string>();
    do {
      const response = await query({ ...filters, cursor }), body = await response.text(); expect(response.status).toBe(200); expect(new TextEncoder().encode(body).length).toBeLessThan(100 * 1024);
      const page = JSON.parse(body) as AuditActivityPage; for (const row of page.items) { expect(row.detailTruncated).toBe(true); expect([...row.detail]).toHaveLength(4000); expect(ids.has(row.id)).toBe(false); ids.add(row.id); }
      cursor = page.nextCursor;
    } while (cursor);
    expect(ids.size).toBe(10);
  });

  it('uses indexed bounded reads on every branch of the union view at meaningful volume', async () => {
    const student = await createStudent(app), guardian = student.guardians.find(item => item.pickupAuthority === 'allowed')!;
    await app.db.prepare(`WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000)
      INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce)
      SELECT 'audit-volume-event-'||n,'test-center',?,'audit-volume-visit-'||((n+1)/2),iif(n%2=1,'check_in','check_out'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-02-12T12:00:00.000Z','+'||n||' seconds'),strftime('%Y-%m-%dT%H:%M:%fZ','2024-02-12T12:00:00.000Z','+'||n||' seconds'),
        ?,'Audit Volume Manager','admin',iif(n%2=1,NULL,?),'hash-'||n,'nonce-'||n FROM seq`).bind(student.student.id, app.actor.id, guardian.id).run();
    await app.db.prepare(`INSERT INTO attendance_corrections(id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash)
      SELECT 'audit-volume-correction-'||id,center_id,id,version,check_in_at,check_out_at,strftime('%Y-%m-%dT%H:%M:%fZ',check_in_at,'-0.1 seconds'),check_out_at,'Verified earlier arrival',?,'Audit Volume Manager','2024-02-12T12:30:00.000Z','hash-'||id FROM visits WHERE student_id=?`).bind(app.actor.id, student.student.id).run();
    await app.db.prepare(`WITH RECURSIVE seq(n) AS(VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<1000)
      INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
      SELECT 'audit-volume-stored-'||n,'test-center',?,'Audit Volume Manager','student_updated','student','volume-student','{}','2024-02-12T12:45:00.000Z' FROM seq`).bind(app.actor.id).run();
    const [plan, archivedPlan] = await Promise.all([
      app.db.prepare(`EXPLAIN QUERY PLAN ${auditPageSql()}`).bind('test-center', '2024-02-12T08:00:00.000Z', '2024-02-13T08:00:00.000Z', 201).all(),
      app.db.prepare(`EXPLAIN QUERY PLAN ${archivedCorrectionAuditPageSql()}`).bind('test-center', '2024-02-12T08:00:00.000Z', '2024-02-13T08:00:00.000Z', 201).all(),
    ]);
    const description = plan.results.map(row => row.detail).join('\n');
    const archivedDescription = archivedPlan.results.map(row => row.detail).join('\n');
    for (const index of ['audit_center_date', 'attendance_audit_date', 'correction_audit_date']) expect(description).toContain(index);
    expect(description).toContain('MERGE (UNION ALL)'); expect(description).not.toContain('TEMP B-TREE');
    expect(archivedDescription).toContain('history_correction_outbox_center_time'); expect(archivedDescription).not.toContain('TEMP B-TREE');
    const response = await query({ from: '2024-02-12', to: '2024-02-12', action: 'absent_action' });
    const metrics = JSON.parse(response.headers.get('x-isolated-d1-metrics')!); const page = await json<AuditActivityPage>(response);
    console.log('Audit page native D1 evidence', JSON.stringify({ plan: description, metrics, scanned: page.scanned }));
    expect(page).toMatchObject({ items: [], scanned: 200, searchComplete: false }); expect(metrics.rowsWritten).toBe(0); expect(metrics.unmeasuredCalls).toBe(0); expect(metrics.rowsRead).toBeLessThan(1500);
    let cursor = page.nextCursor, scanned = page.scanned, pages = 1, maxRead = metrics.rowsRead;
    while (cursor) {
      const continued = await query({ from: '2024-02-12', to: '2024-02-12', action: 'absent_action', cursor });
      const nextMetrics = JSON.parse(continued.headers.get('x-isolated-d1-metrics')!), next = await json<AuditActivityPage>(continued);
      expect(next.scanned).toBeLessThanOrEqual(200); expect(nextMetrics.rowsWritten).toBe(0); expect(nextMetrics.rowsRead).toBeLessThan(1500);
      cursor = next.nextCursor; scanned += next.scanned; maxRead = Math.max(maxRead, nextMetrics.rowsRead); pages++; expect(pages).toBeLessThan(20);
    }
    expect(scanned).toBe(2500); console.log('Audit full-range seek evidence', JSON.stringify({ pages, scanned, maxRead }));
  });

  it('excludes foreign centers and does not fabricate missing source records', async () => {
    const center = crypto.randomUUID(); await app.db.prepare('INSERT INTO centers(id,name,created_at) VALUES(?,?,?)').bind(center, 'Foreign center', new Date().toISOString()).run();
    await insertAudit('2024-08-01T12:00:00.000Z', { center, actorName: 'Foreign private actor' });
    const raw = await insertAudit('2024-08-01T12:00:00.000Z', { entity: 'nonexistent-record', detail: '{"record":"historical reference, no current profile"}' });
    const page = await json<AuditActivityPage>(await query({ from: '2024-08-01', to: '2024-08-01' }));
    expect(page.items.map(item => item.id)).toEqual([raw.id]); expect(page.items[0].entityId).toBe('nonexistent-record'); expect(JSON.stringify(page)).not.toContain('Foreign');
  });

  it('enforces role, channel, origin and strictly bounded filter/cursor contracts without writing audit data', async () => {
    const manager = await staff('manager'), frontDesk = await staff('front_desk'), instructor = await staff('instructor');
    expect((await query({}, manager.token)).status).toBe(200);
    for (const actor of [frontDesk, instructor]) expect((await query({}, actor.token)).status).toBe(403);
    expect((await app.request('/api/admin/audit/query', { body: {} })).status).toBe(401);
    expect((await app.request('/api/admin/audit/query', { token: app.token, body: {}, headers: { origin: 'https://other.example.test' } })).status).toBe(403);
    await json(await app.request(`/api/admin/staff/${app.actor.id}`, { token: app.token, method: 'PATCH', body: { kioskEnabled: true, pin: '38472918' } }));
    const grant = await json<{ token: string }>(await app.request('/api/admin/devices/enrollment', { token: app.token, body: {} }), 201), jar = new CookieJar();
    await json(await jar.request(app, '/api/kiosk/enroll', { body: { token: grant.token, label: 'Audit test kiosk' } }), 201); await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: app.actor.id, pin: '38472918' } }));
    expect((await jar.request(app, '/api/kiosk/audit/query', { body: {} })).status).not.toBe(200);
    const before = await app.db.prepare('SELECT count(*) AS n FROM audit_timeline').first('n');
    for (const input of [{ from: 1 }, { to: true }, { from: '2024-02-30' }, { from: '2024-01-01', to: '2024-02-01' }, { from: '2024-01-02', to: '2024-01-01' }, { actor: null }, { actor: 12 }, { actor: 'x'.repeat(101) }, { action: 'x'.repeat(65) }, { action: "x' OR 1=1" }, { entityType: [] }, { entityId: 'x'.repeat(101) }, { entityId: 'private@email.test' }, { limit: 0 }, { limit: 51 }, { limit: '25' }, { limit: 1.5 }, { cursor: 1 }, { cursor: 'e30' }, { cursor: 'x'.repeat(1001) }, { unknown: 'filter' }]) expect((await query(input)).status).toBe(400);
    expect((await query({ actor: 'x'.repeat(100001) })).status).toBe(413);
    expect(await app.db.prepare('SELECT count(*) AS n FROM audit_timeline').first('n')).toBe(before);
  });
});
