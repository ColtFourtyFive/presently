import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createStudent, json, startApp, type App } from './helpers';
import { archiveRecordKey, compareArchiveRecords, openArchiveManifest, sealArchiveManifest, sealArchivePart, verifyArchivePart } from '../worker/archive-codec';
import { digest } from '../worker/backup-crypto';
import type { ArchiveMetadata, ArchiveRecord, ArchiveTable } from '../shared/archive-format';
import type { ArchiveCatalog, ArchiveRecordPage } from '../shared/archive-reader';

const apps: App[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const key = randomBytes(32).toString('base64');
const route = (id: string, query = 'table=students') => `/api/admin/archive-history/${id}/records?${query}`;
function read(app: App, target: string, options: { token?: string } = {}) {
  const url = new URL(target, 'https://local.test');
  return app.request(`${url.pathname}/query`, { ...options, body: Object.fromEntries(url.searchParams) });
}
async function historicalVisit(app: App, student: Awaited<ReturnType<typeof createStudent>>, month = '2025-01') {
  const visitId = crypto.randomUUID();
  for (const [action, clock] of [['check_in', '18'], ['check_out', '19']]) {
    const eventId = crypto.randomUUID(), timestamp = `${month}-10T${clock}:00:00.000Z`;
    await app.db.prepare('INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').bind(eventId, 'test-center', student.student.id, visitId, action, timestamp, timestamp, app.actor.id, app.actor.displayName, 'admin', action === 'check_out' ? student.guardians[0].id : null, createHash('sha256').update(eventId).digest('base64'), eventId).run();
  }
  return visitId;
}
async function copy(app: App, month = '2025-01', finish = true) {
  const { jobId } = await json<{ jobId: string }>(await app.request('/api/admin/archives/start', { token: app.token, body: { month } }), 202);
  if (finish) {
    let completed = false;
    for (let i = 0; i < 100; i++) { const result = await json<{ status: string }>(await app.request(`/api/admin/archives/${jobId}/advance`, { token: app.token, body: {} })); if (result.status === 'complete') { completed = true; break; } expect(result.status).not.toBe('failed'); }
    expect(completed).toBe(true);
  }
  return jobId;
}
async function fixture(studentCount = 1, finish = true, bigAudit = false) {
  const app = await startApp({ r2: true, bindings: { APP_ENV: 'local', ARCHIVE_ENABLED: 'true', BACKUP_KEY: key } }); apps.push(app);
  const students: Awaited<ReturnType<typeof createStudent>>[] = [];
  for (let index = 0; index < studentCount; index++) {
    const student = await createStudent(app, { firstName: `Archived${index}`, lastName: 'Student', studentCode: `ARCH-${index}` }); students.push(student);
    const visitId = await historicalVisit(app, student);
    if (bigAudit) await app.db.prepare("INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,'test-center',?,'Synthetic Owner','historical_note','visit',?,?,'2025-01-10T20:00:00.000Z')").bind(`large-audit-${index}`, app.actor.id, visitId, JSON.stringify({ note: 'x'.repeat(55000) })).run();
  }
  const jobId = await copy(app, '2025-01', finish), bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  const job = await app.db.prepare('SELECT * FROM archive_jobs WHERE id=?').bind(jobId).first<{ manifest_key: string; manifest_sha256: string }>();
  const manifest = finish ? await openArchiveManifest(key, new Uint8Array(await (await bucket.get(job!.manifest_key))!.arrayBuffer())) : null;
  return { app, students, jobId, bucket, job: job!, manifest };
}
async function role(app: App, role: string) { const email = `${role}-${crypto.randomUUID()}@example.test`; await json(await app.request('/api/admin/staff', { token: app.token, body: { email, displayName: `Synthetic ${role}`, role, kioskEnabled: false } }), 201); return app.signer.token({ email }); }

// Re-seal an authenticated but invalid fixture and its catalog, so failures must
// come from semantic/scope validation rather than the outer ciphertext hash.
async function replacePart(source: Awaited<ReturnType<typeof fixture>>, table: ArchiveTable, change: (records: ArchiveRecord[]) => void) {
  const manifest = source.manifest!;
  const descriptor = manifest.parts.find(part => part.recordCounts[table] > 0)!;
  const records = await verifyArchivePart(key, manifest, descriptor, new Uint8Array(await (await source.bucket.get(descriptor.objectKey))!.arrayBuffer()));
  const old = records.map(record => ({ ...record, row: { ...record.row } })); change(records); records.sort(compareArchiveRecords);
  const metadata: ArchiveMetadata = { archiveId: manifest.archiveId, centerId: manifest.centerId, month: manifest.month, timezone: manifest.timezone, kind: manifest.kind, createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion, schemaVersions: manifest.schemaVersions, references: manifest.references };
  const sealed = await sealArchivePart(key, metadata, descriptor.index, records), parts = [...manifest.parts]; parts[descriptor.index] = sealed.descriptor;
  const changed = await sealArchiveManifest(key, metadata, parts);
  await source.bucket.put(sealed.descriptor.objectKey, sealed.encrypted); await source.bucket.put(changed.objectKey, changed.encrypted);
  for (const record of old) await source.app.db.prepare('DELETE FROM archive_members WHERE job_id=? AND table_name=? AND record_key=?').bind(source.jobId, record.table, record.key).run();
  for (const record of records) await source.app.db.prepare('INSERT INTO archive_members(job_id,table_name,record_key,content_sha256,part_index) VALUES(?,?,?,?,?)').bind(source.jobId, record.table, record.key, await digest(new TextEncoder().encode(JSON.stringify(record))), descriptor.index).run();
  await source.app.db.batch([
    source.app.db.prepare('UPDATE archive_parts SET descriptor_json=? WHERE job_id=? AND part_index=?').bind(JSON.stringify(sealed.descriptor), source.jobId, descriptor.index),
    source.app.db.prepare('UPDATE archive_jobs SET manifest_key=?,manifest_sha256=?,manifest_json=? WHERE id=?').bind(changed.objectKey, changed.sha256, JSON.stringify(changed.manifest), source.jobId),
  ]);
}

describe('authenticated historical copy reader', () => {
  it('permits owner/manager review, denies other roles, and never exposes incomplete or another-center copies', async () => {
    const { app, jobId } = await fixture();
    expect((await read(app, route(jobId))).status).toBe(401);
    for (const denied of ['front_desk', 'instructor']) expect((await read(app, route(jobId), { token: await role(app, denied) })).status).toBe(403);
    const manager = await role(app, 'manager'); expect((await read(app, route(jobId), { token: manager })).status).toBe(200);
    await app.db.prepare("UPDATE archive_jobs SET status='verify' WHERE id=?").bind(jobId).run();
    expect((await read(app, route(jobId), { token: app.token })).status).toBe(404);
    expect((await json<ArchiveCatalog>(await app.request('/api/admin/archive-history', { token: app.token }))).items).toEqual([]);
    await app.db.prepare("INSERT INTO centers(id,name,timezone,created_at) VALUES('foreign-center','Private Foreign Center','UTC','2025-01-01T00:00:00.000Z')").run();
    await app.db.prepare("UPDATE archive_jobs SET status='complete',center_id='foreign-center' WHERE id=?").bind(jobId).run();
    const denied = await read(app, route(jobId), { token: app.token }); expect(denied.status).toBe(404); expect(await denied.text()).not.toContain('Private Foreign Center');
    expect((await json<ArchiveCatalog>(await app.request('/api/admin/archive-history', { token: app.token }))).items).toEqual([]);
  });
  it('pages complete snapshots without changing current records and retains captured identities after later edits', async () => {
    const { app, jobId, students } = await fixture(3);
    await json(await app.request(`/api/admin/students/${students[0].student.id}`, { token: app.token, method: 'PATCH', body: { firstName: 'CurrentDifferentName' } }));
    const before = await app.db.prepare('SELECT count(*) AS n FROM audit_entries').first('n');
    const ids: string[] = []; let cursor = ''; let firstCursor = '';
    do {
      const response = await read(app, route(jobId, `table=students&limit=1${cursor ? `&cursor=${cursor}` : ''}`), { token: app.token });
      expect(response.headers.get('cache-control')).toContain('no-store');
      const page = await json<ArchiveRecordPage>(response); expect(page.items).toHaveLength(1); expect(page.pageVerified).toBe(true); expect(page.snapshot.capturedAt).toBeTruthy();
      ids.push(page.items[0].key); expect(page.items[0].row.first_name).not.toBe('CurrentDifferentName'); cursor = page.nextCursor || ''; firstCursor ||= cursor;
    } while (cursor);
    expect(new Set(ids)).toEqual(new Set(students.map(student => student.student.id)));
    expect(await app.db.prepare('SELECT count(*) AS n FROM audit_entries').first('n')).toBe(before);
    expect((await read(app, route(jobId, `table=students&limit=1&q=changed&cursor=${firstCursor}`), { token: app.token })).status).toBe(400);
    expect((await read(app, route(jobId, 'table=students&limit=51'), { token: app.token })).status).toBe(400);
    const filtered = await json<ArchiveRecordPage>(await read(app, route(jobId, `table=visits&studentId=${students[1].student.id}`), { token: app.token })); expect(filtered.items).toHaveLength(1); expect(filtered.items[0].row.student_id).toBe(students[1].student.id);
    const staff = await json<ArchiveRecordPage>(await read(app, route(jobId, 'table=staff'), { token: app.token })); expect(staff.items).toHaveLength(1); expect(staff.items[0].row).not.toHaveProperty('email'); expect(staff.items[0].row).not.toHaveProperty('pin_hash');
  });
  it('keeps private filters in a bounded read-only body and rejects cross-origin requests', async () => {
    const { app, jobId } = await fixture(); const path = `/api/admin/archive-history/${jobId}/records/query`;
    const before = await app.db.prepare('SELECT count(*) AS n FROM audit_entries').first('n');
    const result = await json<ArchiveRecordPage>(await app.request(path, { token: app.token, body: { table: 'students', q: 'Archived0', limit: 1 } })); expect(result.items).toHaveLength(1);
    expect(await app.db.prepare('SELECT count(*) AS n FROM audit_entries').first('n')).toBe(before);
    expect((await app.request(path, { token: app.token, headers: { origin: 'https://other.example.test' }, body: { table: 'students' } })).status).toBe(403);
    expect((await app.request(path, { token: app.token, body: { q: 'x'.repeat(4097) } })).status).toBe(413);
    expect((await app.request(path, { token: app.token, body: { table: ['students'] } })).status).toBe(400);
    expect((await app.request(path, { token: app.token, body: { table: 'students', cursor: 'x'.repeat(701) } })).status).toBe(400);
  });
  it('does not list, display or publish manually cataloged v2 evidence through the v1 operational path', async () => {
    const source = await fixture(), manifest = source.manifest!;
    const metadata: ArchiveMetadata = { archiveId: manifest.archiveId, centerId: manifest.centerId, month: manifest.month, timezone: manifest.timezone, kind: manifest.kind, createdAt: manifest.createdAt, applicationVersion: manifest.applicationVersion, schemaVersions: manifest.schemaVersions, references: manifest.references, semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: [] } };
    const v2 = await sealArchiveManifest(key, metadata, manifest.parts);
    await source.bucket.put(v2.objectKey, v2.encrypted);
    await source.app.db.prepare('UPDATE archive_jobs SET manifest_key=?,manifest_sha256=?,manifest_json=? WHERE id=?').bind(v2.objectKey, v2.sha256, JSON.stringify(v2.manifest), source.jobId).run();
    const catalog = await json<ArchiveCatalog>(await source.app.request('/api/admin/archive-history', { token: source.app.token })); expect(catalog.items).toEqual([]);
    for (const response of [await read(source.app, route(source.jobId), { token: source.app.token }), await source.app.request(`/api/admin/archives/${source.jobId}/manifest`, { token: source.app.token })]) {
      expect(response.status).toBe(503); const value = await response.json(); expect(value).toMatchObject({ error: { code: 'ARCHIVE_V2_NOT_ENABLED' } }); expect(value).not.toHaveProperty('items'); expect(value).not.toHaveProperty('manifest');
    }
    await source.app.db.prepare("UPDATE archive_jobs SET status='verify',completed_at=NULL,verify_part=0 WHERE id=?").bind(source.jobId).run();
    const advance = await json<{ status: string }>(await source.app.request(`/api/admin/archives/${source.jobId}/advance`, { token: source.app.token, body: {} })); expect(advance.status).toBe('failed');
    expect(await source.app.db.prepare('SELECT completed_at,error_code FROM archive_jobs WHERE id=?').bind(source.jobId).first()).toEqual({ completed_at: null, error_code: 'ARCHIVE_V2_NOT_ENABLED' });
    expect(await source.app.db.prepare('SELECT count(*) AS n FROM attendance_events').first('n')).toBe(2);
  });
  it('paginates the complete-copy catalog with a month-bound cursor', async () => {
    const { app, students, jobId } = await fixture(); await historicalVisit(app, students[0], '2025-02'); const second = await copy(app, '2025-02');
    const first = await json<ArchiveCatalog>(await app.request('/api/admin/archive-history?limit=1', { token: app.token })); expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTruthy();
    const next = await json<ArchiveCatalog>(await app.request(`/api/admin/archive-history?limit=1&cursor=${first.nextCursor}`, { token: app.token })); expect(next.nextCursor).toBeNull(); expect(new Set([...first.items, ...next.items].map(item => item.id))).toEqual(new Set([jobId, second]));
    expect((await app.request(`/api/admin/archive-history?month=2025-01&cursor=${first.nextCursor}`, { token: app.token })).status).toBe(400);
    const month = await json<ArchiveCatalog>(await app.request('/api/admin/archive-history?month=2025-01', { token: app.token })); expect(month.items.map(item => item.id)).toEqual([jobId]);
  });
  it.each(['missing-manifest', 'corrupt-manifest', 'missing-part', 'corrupt-part', 'catalog-mismatch', 'schema-mismatch'])('returns explicit unavailable evidence for %s, never an empty success', async failure => {
    const source = await fixture(), part = source.manifest!.parts.find(item => item.recordCounts.students > 0)!;
    const objectKey = failure.includes('manifest') ? source.job.manifest_key : part.objectKey;
    if (failure.startsWith('missing')) await source.bucket.delete(objectKey);
    if (failure.startsWith('corrupt')) { const bytes = new Uint8Array(await (await source.bucket.get(objectKey))!.arrayBuffer()); bytes[bytes.length - 1] ^= 1; await source.bucket.put(objectKey, bytes); }
    if (failure === 'catalog-mismatch') await source.app.db.prepare("UPDATE archive_parts SET descriptor_json='{}' WHERE job_id=? AND part_index=?").bind(source.jobId, part.index).run();
    if (failure === 'schema-mismatch') await source.app.db.prepare("UPDATE archive_jobs SET schema_json='[1]' WHERE id=?").bind(source.jobId).run();
    const response = await read(source.app, route(source.jobId), { token: source.app.token }); expect(response.status).toBe(503); const body = await response.json() as { error: { code: string } }; expect(body.error.code).toMatch(/^ARCHIVE_(UNAVAILABLE|OBJECT_MISSING)$/); expect(body).not.toHaveProperty('items'); expect(JSON.stringify(body)).not.toContain('Archived0'); expect(JSON.stringify(body)).not.toContain(key);
  });
  it('rejects authenticated relationship evidence that references a guardian in another center', async () => {
    const source = await fixture();
    await source.app.db.batch([
      source.app.db.prepare("INSERT INTO centers(id,name,timezone,created_at) VALUES('foreign-center','Foreign Center','UTC','2025-01-01T00:00:00.000Z')"),
      source.app.db.prepare("INSERT INTO guardians(id,center_id,display_name,created_at) VALUES('foreign-guardian','foreign-center','Private Foreign Guardian','2025-01-01T00:00:00.000Z')"),
    ]);
    await replacePart(source, 'student_guardians', records => { records[0].row.guardian_id = 'foreign-guardian'; records[0].key = archiveRecordKey('student_guardians', records[0].row); });
    const response = await read(source.app, route(source.jobId, 'table=student_guardians'), { token: source.app.token }); expect(response.status).toBe(503); expect(await response.text()).not.toContain('foreign-guardian');
  });
  it('rejects an authenticated accepted receipt with substituted student/visit references', async () => {
    const source = await fixture();
    await replacePart(source, 'attendance_events', records => {
      const event = records[0]; event.row.result_visit = JSON.stringify({ id: 'foreign-visit', studentId: 'foreign-student', studentName: 'Private Foreign Student', studentCode: 'FOREIGN', active: true, checkInAt: '2025-01-10T18:00:00.000Z', originalCheckInAt: '2025-01-10T18:00:00.000Z', checkInBy: 'Other Staff', checkOutAt: null, originalCheckOutAt: null, checkOutBy: null, guardianName: null, departureType: null, reviewStatus: 'none', version: 1 });
    });
    const response = await read(source.app, route(source.jobId, 'table=attendance_events'), { token: source.app.token }); expect(response.status).toBe(503); expect(await response.text()).not.toContain('Private Foreign');
  });
  it('rejects credential fields in authenticated identity context instead of returning them', async () => {
    const source = await fixture();
    await replacePart(source, 'staff', records => { records[0].row.pin_hash = 'PRIVATE-CREDENTIAL-HASH'; records[0].row.email = 'private@example.test'; });
    const response = await read(source.app, route(source.jobId, 'table=staff'), { token: source.app.token }); expect(response.status).toBe(503); const text = await response.text(); expect(text).not.toContain('PRIVATE-CREDENTIAL-HASH'); expect(text).not.toContain('private@example.test');
  });
  it('rejects a continuation cursor when the pinned immutable manifest changes', async () => {
    const source = await fixture(2);
    const first = await json<ArchiveRecordPage>(await read(source.app, route(source.jobId, 'table=students&limit=1'), { token: source.app.token })); expect(first.nextCursor).toBeTruthy();
    await replacePart(source, 'students', () => {});
    const response = await read(source.app, route(source.jobId, `table=students&limit=1&cursor=${first.nextCursor}`), { token: source.app.token }); expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: { code: 'ARCHIVE_PAGE_CHANGED' } });
  });
  it('bounds serialized response bytes without losing large evidence records across pages', async () => {
    const { app, jobId } = await fixture(3, true, true); const ids: string[] = []; let cursor = '';
    do {
      const response = await read(app, route(jobId, `table=audit_entries&limit=50${cursor ? `&cursor=${cursor}` : ''}`), { token: app.token }); const text = await response.text(); expect(response.status, text.slice(0, 500)).toBe(200); expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(128 * 1024); const page = JSON.parse(text) as ArchiveRecordPage; ids.push(...page.items.map(item => item.key)); cursor = page.nextCursor || '';
    } while (cursor);
    expect(new Set(ids).size).toBe(ids.length); expect(ids.filter(id => id.startsWith('large-audit-'))).toHaveLength(3);
  });
});
