import { beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { resolve } from 'node:path';
import { ARCHIVE_FORMAT, ARCHIVE_FORMAT_V2, ARCHIVE_LIMITS, type ArchiveManifest, type ArchiveMetadata, type ArchiveRecord, type ArchiveSemanticStore, type ArchiveStagingSink } from '../shared/archive-format';
import { compareArchiveRecords, createArchive, verifyArchiveGraph, validateArchiveMetadata } from '../worker/archive-codec';
import { decodeAttendanceReceipt } from '../worker/attendance-receipt';
import { sourcePage, type ArchiveJob } from '../worker/archive-source';
import { createStudent, json, startApp } from './helpers';
import type { Env } from '../worker/types';

const key = randomBytes(32).toString('base64');
let captured: ArchiveRecord[];
let generatedColonAudit: ArchiveRecord;
let metadata: ArchiveMetadata;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64');
const clone = () => structuredClone(captured);
const row = (records: ArchiveRecord[], table: ArchiveRecord['table']) => records.find(record => record.table === table)!.row;

/** Test adapter only. Production adapters must use private bounded storage.
 * No live database or application Env is supplied to semantic verification. */
function staging(options: { pageOverflow?: boolean; dropRow?: boolean } = {}) {
  const records = new Map<string, ArchiveRecord[]>(); let published = false, discarded = false, pageLimit = 0, continuations = 0;
  const semanticStore: ArchiveSemanticStore = {
    async page(query) {
      pageLimit = Math.max(pageLimit, query.limit);
      if (query.after) continuations++;
      const matches = (records.get(query.archiveId) || []).filter(record => record.table === query.table && record.key > query.after && (!query.relation || record.row[query.relation.column] === query.relation.value));
      if (options.pageOverflow && matches.length) return Array.from({ length: query.limit + 1 }, () => matches[0]);
      return matches.slice(0, query.limit);
    },
    async get(archiveId, table, recordKey) { return (records.get(archiveId) || []).find(record => record.table === table && record.key === recordKey) || null; },
  };
  const sink: ArchiveStagingSink = {
    semanticStore,
    async stagePart(part, _descriptor, manifest) {
      const existing = records.get(manifest.archiveId) || [];
      existing.push(...structuredClone(part)); records.set(manifest.archiveId, existing);
      if (options.dropRow) existing.pop();
    },
    async publish() { published = true; },
    async discard() { records.clear(); discarded = true; },
  };
  return { sink, get published() { return published; }, get discarded() { return discarded; }, get pageLimit() { return pageLimit; }, get continuations() { return continuations; } };
}
async function bundle(records = clone(), meta = metadata) {
  const objects = new Map<string, Uint8Array>();
  const sealed = await createArchive(key, meta, records.sort(compareArchiveRecords), async (part, bytes) => { objects.set(part.objectKey, bytes); });
  objects.set(sealed.objectKey, sealed.encrypted);
  const read = async (path: string, maximum: number) => { const bytes = objects.get(path); if (!bytes || bytes.length > maximum) throw new Error('Archive fixture object unavailable'); return bytes; };
  return { ...sealed, objects, read };
}
async function rejects(records: ArchiveRecord[], code: string) {
  // These records are resealed with valid encryption/hash/shape. Rejection must
  // come from graph semantics, not tampered outer ciphertext.
  const sealed = await bundle(records), target = staging();
  await expect(verifyArchiveGraph(key, sealed.encrypted, sealed.read, target.sink)).rejects.toThrow(code);
  expect(target.published).toBe(false); expect(target.discarded).toBe(true);
}

beforeAll(async () => {
  const app = await startApp({ r2: true, bindings: { APP_ENV: 'local', ARCHIVE_ENABLED: 'true', BACKUP_KEY: key } });
  try {
    const detail = await createStudent(app), student = detail.student.id, visit = `visit-${crypto.randomUUID()}`;
    const at = new Date().toISOString(), device = crypto.randomUUID(), enrollment = crypto.randomUUID();
    await app.db.batch([
      app.db.prepare('INSERT INTO device_enrollments(id,center_id,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(enrollment, 'test-center', crypto.randomUUID(), at, app.actor.id, at),
      app.db.prepare('INSERT INTO kiosk_devices(id,center_id,enrollment_id,token_hash,label,created_at,expires_at) VALUES(?,?,?,?,?,?,?)').bind(device, 'test-center', enrollment, crypto.randomUUID(), 'Synthetic tablet', at, at),
    ]);
    const insert = async (studentId: string, visitId: string | null, action: string, observedAt: string, reason: string | null, kiosk: boolean) => {
      const eventId = crypto.randomUUID();
      await app.db.prepare('INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(eventId, 'test-center', studentId, visitId, action, observedAt, observedAt, app.actor.id, app.actor.displayName, kiosk ? 'kiosk' : 'admin', kiosk ? device : null, null, reason, hash({ studentId, action, observedAt, guardianId: null, reason }), crypto.randomUUID()).run();
      return eventId;
    };
    await insert(student, visit, 'check_in', '2025-01-10T18:00:00.000Z', null, false);
    const departed = await insert(student, visit, 'exceptional_departure', '2025-01-10T19:00:00.000Z', 'Observed exceptional departure', true);
    await json(await app.request(`/api/admin/visits/${visit}/corrections`, { token: app.token, body: { correctionId: crypto.randomUUID(), expectedVersion: 2, checkInAt: '2025-01-10T18:02:00.000Z', checkOutAt: '2025-01-10T19:01:00.000Z', reason: 'Verified documented times' } }), 201);
    await json(await app.request(`/api/admin/reviews/${departed}/resolve`, { token: app.token, body: { resolution: 'Departure evidence reviewed' } }));
    const second = await createStudent(app);
    const unmatched = await insert(second.student.id, null, 'exceptional_departure', '2025-01-11T19:00:00.000Z', 'Observed departure without arrival', false);
    await json(await app.request(`/api/admin/reviews/${unmatched}/resolve`, { token: app.token, body: { resolution: 'Unmatched departure documented' } }));
    const started = await json<{ jobId: string }>(await app.request('/api/admin/archives/start', { token: app.token, body: { month: '2025-01' } }), 202);
    const job = await app.db.prepare('SELECT * FROM archive_jobs WHERE id=?').bind(started.jobId).first<ArchiveJob>();
    captured = [];
    for (let table = 0; table < 10; table++) captured.push(...await sourcePage({ CRM_DB: app.db } as unknown as Env, job!, table, '', 256));
    await app.db.prepare("INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) SELECT id||':reviewed:1',center_id,?,?, 'historical_note','visit',id,json_object('note','Synthetic historical review'),? FROM visits WHERE id=?")
      .bind(app.actor.id, app.actor.displayName, job!.created_at, visit).run();
    const auditRow = await app.db.prepare('SELECT * FROM audit_entries WHERE id=?').bind(`${visit}:reviewed:1`).first<ArchiveRecord['row']>();
    generatedColonAudit = { table: 'audit_entries', key: String(auditRow!.id), row: auditRow! };
    const devices = await app.db.prepare('SELECT id,center_id AS centerId FROM kiosk_devices WHERE id=?').bind(device).all<{ id: string; centerId: string }>();
    metadata = { archiveId: 'semantic-base', centerId: 'test-center', month: job!.month, timezone: job!.timezone, kind: 'monthly', createdAt: job!.created_at, applicationVersion: 'semantic-test', schemaVersions: JSON.parse(job!.schema_json), references: [], semanticProof: { version: 1, payloadHashEncoding: 'base64', deviceContexts: devices.results } };
  } finally { await app.close(); }
}, 30000);

describe('independent semantic archive graph proof', () => {
  it('accepts real D1-generated observations, compact receipts, corrections, resolved reviews, device context and logical audits after D1 closes', async () => {
    const sealed = await bundle(), target = staging();
    expect(sealed.manifest.format).toBe(ARCHIVE_FORMAT_V2);
    await verifyArchiveGraph(key, sealed.encrypted, sealed.read, target.sink);
    expect(target.published).toBe(true); expect(target.pageLimit).toBe(ARCHIVE_LIMITS.semanticPageRecords);
  });
  it('runs opt-in v2 authentication and semantic staging in actual workerd', async () => {
    const contents = `
      import { createArchive, verifyArchiveGraph } from './worker/archive-codec.ts';
      export default { async fetch() {
        const objects = new Map(), staged = new Map(); let published = false;
        const archive = await createArchive(${JSON.stringify(key)}, ${JSON.stringify(metadata)}, ${JSON.stringify(captured)}, async (part, bytes) => objects.set(part.objectKey, bytes));
        await verifyArchiveGraph(${JSON.stringify(key)}, archive.encrypted, async path => objects.get(path), {
          async stagePart(rows, part, manifest) { const list = staged.get(manifest.archiveId) || []; list.push(...rows); staged.set(manifest.archiveId, list); },
          async publish() { published = true; }, async discard() { staged.clear(); },
          semanticStore: {
            async get(id, table, key) { return (staged.get(id) || []).find(row => row.table === table && row.key === key) || null; },
            async page(query) { return (staged.get(query.archiveId) || []).filter(row => row.table === query.table && row.key > query.after && (!query.relation || row.row[query.relation.column] === query.relation.value)).slice(0, query.limit); }
          }
        });
        return Response.json({ published, format: archive.manifest.format });
      } };`;
    const built = await build({ stdin: { contents, resolveDir: resolve('.') }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const runtime = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-06-11' });
    try { const response = await runtime.dispatchFetch('https://semantic.test/'); expect(response.status).toBe(200); expect(await response.json()).toEqual({ published: true, format: ARCHIVE_FORMAT_V2 }); }
    finally { await runtime.dispose(); }
  });
  it('retains v1 default encoding and decoding without demanding a semantic store', async () => {
    const { semanticProof: _proof, ...legacy } = metadata;
    const sealed = await bundle(clone(), legacy), target = staging(); delete target.sink.semanticStore;
    expect(sealed.manifest.format).toBe(ARCHIVE_FORMAT); expect(sealed.manifest).not.toHaveProperty('semanticProof');
    await verifyArchiveGraph(key, sealed.encrypted, sealed.read, target.sink); expect(target.published).toBe(true);
  });
  it('accepts a real D1-generated colon-ID custom audit in v2 without widening v1 or source request IDs', async () => {
    const records = [...clone(), structuredClone(generatedColonAudit)], sealed = await bundle(records), target = staging();
    await verifyArchiveGraph(key, sealed.encrypted, sealed.read, target.sink); expect(target.published).toBe(true);
    const { semanticProof: _proof, ...legacy } = metadata;
    await expect(bundle(records, legacy)).rejects.toThrow('identifier');
    const invalid = clone(); row(invalid, 'attendance_corrections').id = 'request:invalid';
    invalid.find(record => record.table === 'attendance_corrections')!.key = 'request:invalid';
    await expect(bundle(invalid)).rejects.toThrow('identifier');
    const nonUuid = clone(), nonUuidCorrection = nonUuid.find(record => record.table === 'attendance_corrections')!;
    nonUuidCorrection.key = 'not-a-request-uuid'; nonUuidCorrection.row.id = nonUuidCorrection.key;
    await rejects(nonUuid, 'INVALID_REQUEST_ID');
  });
  it('requires private bounded staging and discards incomplete or oversized staged pages', async () => {
    const sealed = await bundle();
    for (const options of [{}, { pageOverflow: true }, { dropRow: true }]) {
      const target = staging(options); if (!Object.keys(options).length) delete target.sink.semanticStore;
      await expect(verifyArchiveGraph(key, sealed.encrypted, sealed.read, target.sink)).rejects.toThrow();
      expect(target.published).toBe(false); expect(target.discarded).toBe(true);
    }
  });
  it('accepts full legacy receipts and explicitly declared correctly computed hex fingerprints without rewriting them', async () => {
    const records = clone();
    for (const record of records) if (record.table === 'attendance_events' || record.table === 'attendance_corrections') {
      record.row.payload_hash = Buffer.from(String(record.row.payload_hash), 'base64').toString('hex');
      if (record.table === 'attendance_events') record.row.result_visit = JSON.stringify(decodeAttendanceReceipt(record.row as Parameters<typeof decodeAttendanceReceipt>[0]));
    }
    const target = staging(), sealed = await bundle(records, { ...metadata, semanticProof: { ...metadata.semanticProof!, payloadHashEncoding: 'base64-or-hex' } });
    await verifyArchiveGraph(key, sealed.encrypted, sealed.read, target.sink); expect(target.published).toBe(true);
    await rejects(records, 'REQUEST_FINGERPRINT');
  });
  it('bounds and validates device proof fields, identities and declared hash policy', () => {
    const proof = metadata.semanticProof!;
    const bad = [
      { ...proof, version: 2 }, { ...proof, unexpected: true }, { ...proof, payloadHashEncoding: 'opaque' },
      { ...proof, deviceContexts: [...proof.deviceContexts, proof.deviceContexts[0]] },
      { ...proof, deviceContexts: [{ ...proof.deviceContexts[0], centerId: 'another-center' }] },
      { ...proof, deviceContexts: [{ ...proof.deviceContexts[0], token_hash: 'private' }] },
      { ...proof, deviceContexts: Array.from({ length: ARCHIVE_LIMITS.deviceContexts + 1 }, (_, i) => ({ id: `device-${i}`, centerId: metadata.centerId })) },
      { ...proof, deviceContexts: Array.from({ length: ARCHIVE_LIMITS.deviceContexts }, (_, i) => ({ id: `device-${String(i).padStart(3, '0')}-${'x'.repeat(89)}`, centerId: metadata.centerId })) },
    ];
    for (const semanticProof of bad) expect(() => validateArchiveMetadata({ ...metadata, semanticProof } as ArchiveMetadata)).toThrow();
  });
  it('rejects missing identity and relationship dependencies', async () => {
    const records = clone(), guardian = row(records, 'guardians').id;
    await rejects(records.filter(record => !(record.table === 'guardians' && record.row.id === guardian)), 'MISSING_RELATION');
  });
  it('rejects unexpected credential fields even with authenticated envelopes', async () => {
    const records = clone(); row(records, 'staff').pin_hash = 'not-allowed'; await rejects(records, 'UNSUPPORTED_COLUMNS');
  });
  it('rejects cross-student accepted receipt substitution', async () => {
    const records = clone(), event = row(records, 'attendance_events');
    const receipt = decodeAttendanceReceipt(event as Parameters<typeof decodeAttendanceReceipt>[0])!;
    if (receipt) { receipt.studentId = 'different-student'; event.result_visit = JSON.stringify(receipt); }
    else { event.result_visit = JSON.stringify({ id: 'bad' }); }
    await rejects(records, 'RECEIPT');
  });
  it('rejects changed request fingerprints and incorrect correction prior versions', async () => {
    const changed = clone(); row(changed, 'attendance_events').payload_hash = randomBytes(32).toString('base64'); await rejects(changed, 'REQUEST_FINGERPRINT');
    const correction = clone(); row(correction, 'attendance_corrections').expected_version = 1; await rejects(correction, 'VISIT_VERSION_CHAIN');
  });
  it('rejects a forged visit projection or omitted correction despite valid ciphertext', async () => {
    const changed = clone(); row(changed, 'visits').version = 7; await rejects(changed, 'VISIT_FINAL_STATE');
    await rejects(clone().filter(record => record.table !== 'attendance_corrections'), 'VISIT_FINAL_STATE');
  });
  it('rejects generated audit replacement and incomplete review resolution evidence', async () => {
    const changed = clone(); const event = row(changed, 'attendance_events'); changed.find(record => record.table === 'audit_entries' && record.row.id === event.id)!.row.detail = '{}'; await rejects(changed, 'SOURCE_AUDIT_MISMATCH');
    await rejects(clone().filter(record => !(record.table === 'audit_entries' && record.row.action === 'review_resolved')), 'MISSING_REVIEW_RESOLUTION_AUDIT');
    const phantom = clone(), audit = structuredClone(phantom.find(record => record.table === 'audit_entries' && record.row.action === 'attendance_correction')!);
    audit.key = crypto.randomUUID(); audit.row.id = audit.key; phantom.push(audit); await rejects(phantom, 'MISSING_RELATION');
  });
  it('rejects an authenticated kiosk observation without matching captured device ownership', async () => {
    const sealed = await bundle(clone(), { ...metadata, semanticProof: { ...metadata.semanticProof!, deviceContexts: [] } }), target = staging();
    await expect(verifyArchiveGraph(key, sealed.encrypted, sealed.read, target.sink)).rejects.toThrow('DEVICE_OWNERSHIP');
    expect(target.published).toBe(false);
  });
  it('accepts a verified base and ordered correction addendum, while rejecting a missing resulting snapshot or mixed v1 graph', async () => {
    const base = await bundle(), current = structuredClone(row(clone(), 'visits'));
    const correction = structuredClone(row(clone(), 'attendance_corrections'));
    const correctionAt = new Date(Date.parse(metadata.createdAt) + 1000).toISOString();
    correction.id = crypto.randomUUID(); correction.expected_version = current.version;
    correction.prior_check_in_at = current.check_in_at; correction.prior_check_out_at = current.check_out_at;
    correction.check_in_at = '2025-01-10T18:03:00.000Z'; correction.recorded_at = correctionAt;
    correction.payload_hash = hash({ visitId: correction.visit_id, expectedVersion: correction.expected_version, checkInAt: correction.check_in_at, checkOutAt: correction.check_out_at, reason: correction.reason });
    current.version = Number(current.version) + 1; current.check_in_at = correction.check_in_at;
    const audit = { id: correction.id, center_id: metadata.centerId, actor_id: correction.actor_id, actor_name: correction.actor_name, action: 'attendance_correction', entity_type: 'visit', entity_id: correction.visit_id, detail: JSON.stringify({ reason: correction.reason, priorCheckInAt: correction.prior_check_in_at, priorCheckOutAt: correction.prior_check_out_at, checkInAt: correction.check_in_at, checkOutAt: correction.check_out_at }), created_at: correctionAt };
    const records: ArchiveRecord[] = [{ table: 'visits', key: String(current.id), row: current }, { table: 'attendance_corrections', key: String(correction.id), row: correction }, { table: 'audit_entries', key: String(correction.id), row: audit }];
    const addonMeta: ArchiveMetadata = { ...metadata, archiveId: 'semantic-addendum', kind: 'addendum', createdAt: new Date(Date.parse(correctionAt) + 1000).toISOString(), references: [{ archiveId: base.manifest.archiveId, kind: 'monthly', manifestObjectKey: base.objectKey, manifestSha256: base.sha256 }] };
    const addon = await bundle(records, addonMeta); for (const [path, value] of base.objects) addon.objects.set(path, value);
    const target = staging(); await verifyArchiveGraph(key, addon.encrypted, addon.read, target.sink); expect(target.published).toBe(true);
    const missing = await bundle(records.filter(record => record.table !== 'visits'), addonMeta); for (const [path, value] of base.objects) missing.objects.set(path, value);
    await expect(verifyArchiveGraph(key, missing.encrypted, missing.read, staging().sink)).rejects.toThrow('MISSING_RESULTING_VISIT');
    const { semanticProof: _proof, ...legacy } = metadata; const legacyBase = await bundle(clone(), legacy);
    const mixed = await bundle(records, { ...addonMeta, references: [{ archiveId: legacyBase.manifest.archiveId, kind: 'monthly', manifestObjectKey: legacyBase.objectKey, manifestSha256: legacyBase.sha256 }] });
    for (const [path, value] of legacyBase.objects) mixed.objects.set(path, value);
    await expect(verifyArchiveGraph(key, mixed.encrypted, mixed.read, staging().sink)).rejects.toThrow('complete semantic graph');
  });
  it('uses continuation pages and rejects an oversized individual visit closure', async () => {
    const records = clone(), context = row(records, 'students');
    for (let i = 0; i < 130; i++) records.push({ table: 'students', key: `context-${i.toString().padStart(3, '0')}`, row: { ...context, id: `context-${i.toString().padStart(3, '0')}` } });
    const paged = await bundle(records), target = staging(); await verifyArchiveGraph(key, paged.encrypted, paged.read, target.sink);
    expect(target.published).toBe(true); expect(target.continuations).toBeGreaterThan(1);
    const oversized = clone(), correction = row(oversized, 'attendance_corrections');
    for (let i = 0; i < ARCHIVE_LIMITS.semanticVisitOperations; i++) {
      const id = crypto.randomUUID();
      oversized.push({ table: 'attendance_corrections', key: id, row: { ...correction, id, expected_version: i + 3 } });
    }
    await rejects(oversized, 'VISIT_CLOSURE_BOUND');
  });
});
