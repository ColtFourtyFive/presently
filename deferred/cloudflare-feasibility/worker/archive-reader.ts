import { Hono, type Context } from 'hono';
import type { AppEnv, Env } from './types';
import { ARCHIVE_FORMAT, ARCHIVE_LIMITS, ARCHIVE_TABLES, type ArchiveManifest, type ArchiveRecord, type ArchiveTable } from '../shared/archive-format';
import type { ArchiveCatalog, ArchiveRecordPage } from '../shared/archive-reader';
import type { ArchiveJob } from './archive-source';
import { openArchiveManifest, verifyArchivePart, compareArchiveRecords } from './archive-codec';
import { digest } from './backup-crypto';
import { decodeAttendanceReceipt } from './attendance-receipt';
import { ApiProblem, centerId, managementRoles, requireRole } from './util';

const encoder = new TextEncoder();
const RESPONSE_BYTES = 128 * 1024, ITEMS_BYTES = 96 * 1024;
const ident = /^[A-Za-z0-9_-]{1,100}$/;
const studentTables: ArchiveTable[] = ['students', 'student_guardians', 'visits', 'attendance_events', 'reviews'];
const contextColumns: Partial<Record<ArchiveTable, string[]>> = {
  centers: ['id', 'name', 'timezone', 'created_at'],
  students: ['id', 'center_id', 'student_code', 'first_name', 'last_name', 'active', 'subjects', 'created_at', 'updated_at'],
  guardians: ['id', 'center_id', 'display_name', 'created_at'],
  student_guardians: ['student_id', 'guardian_id', 'relationship', 'pickup_authority', 'authority_note'],
  staff: ['id', 'center_id', 'display_name', 'role', 'active', 'created_at', 'updated_at'],
};
type ReaderJob = Pick<ArchiveJob, 'id' | 'center_id' | 'month' | 'timezone' | 'created_at' | 'completed_at' | 'period_from' | 'period_to' | 'application_version' | 'schema_json' | 'next_part' | 'verify_part' | 'manifest_key' | 'manifest_sha256'>;
const unavailable = () => new ApiProblem(503, 'ARCHIVE_UNAVAILABLE', 'This historical copy could not be verified. Its contents are unavailable; this is not an empty history result. Ask the owner to check storage and recovery.');
function invalid(message = 'The historical page request is invalid.') { return new ApiProblem(400, 'ARCHIVE_PAGE_INVALID', message); }
function size(value: string | undefined, fallback: number, maximum: number) { if (value === undefined) return fallback; if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > maximum) throw invalid(); return Number(value); }
function encodeCursor(value: unknown) { return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''); }
function decodeCursor(value: string): Record<string, unknown> {
  try { if (value.length > 700 || !/^[A-Za-z0-9_-]+$/.test(value)) throw invalid(); const parsed: unknown = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/'))); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid(); return parsed as Record<string, unknown>; } catch { throw invalid(); }
}
async function readFilters(c: Context<AppEnv>) {
  if (Number(c.req.header('content-length') || 0) > 4096) throw new ApiProblem(413, 'ARCHIVE_QUERY_TOO_LARGE', 'Historical lookup filters are too large.');
  const reader = c.req.raw.body?.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  if (reader) for (;;) { const part = await reader.read(); if (part.done) break; length += part.value.length; if (length > 4096) { await reader.cancel(); throw new ApiProblem(413, 'ARCHIVE_QUERY_TOO_LARGE', 'Historical lookup filters are too large.'); } chunks.push(part.value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw invalid(); }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(name => !['table', 'limit', 'recordId', 'studentId', 'q', 'cursor'].includes(name))) throw invalid();
  const fields = input as Record<string, unknown>;
  return (name: string): string | undefined => { const value = fields[name]; if (value === undefined) return undefined; if (name === 'limit' && typeof value === 'number' && Number.isInteger(value)) return String(value); if (typeof value !== 'string') throw invalid(); return value; };
}
async function readObject(env: Env, key: string, maximum: number) {
  const object = await env.BACKUP_BUCKET!.get(key);
  if (!object) throw new ApiProblem(503, 'ARCHIVE_OBJECT_MISSING', 'A required historical file is missing. This copy is unavailable; do not interpret it as an empty history result.');
  if (object.size > maximum) { await object.body.cancel(); throw unavailable(); }
  const reader = object.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  for (;;) { const { value, done } = await reader.read(); if (done) break; length += value.length; if (length > maximum) { await reader.cancel(); throw unavailable(); } chunks.push(value); }
  if (length !== object.size) throw unavailable();
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; } return result;
}
async function manifestForRead(env: Env, job: ReaderJob): Promise<ArchiveManifest> {
  if (!env.BACKUP_BUCKET || typeof env.BACKUP_KEY !== 'string' || !env.BACKUP_KEY) throw new ApiProblem(503, 'ARCHIVE_READER_NOT_CONFIGURED', 'Historical review needs private storage and the recovery key. Ask the owner to complete setup.');
  if (!job.manifest_key || !job.manifest_sha256 || !job.completed_at || job.next_part !== job.verify_part) throw unavailable();
  const manifest = await openArchiveManifest(env.BACKUP_KEY, await readObject(env, job.manifest_key, ARCHIVE_LIMITS.encryptedManifestBytes), { archiveId: job.id, kind: 'monthly', manifestObjectKey: job.manifest_key, manifestSha256: job.manifest_sha256 });
  if (manifest.format !== ARCHIVE_FORMAT) throw new ApiProblem(503, 'ARCHIVE_V2_NOT_ENABLED', 'This historical format is not enabled for operational review. Its complete semantic staging must be configured first.');
  const versions = (await env.CRM_DB.prepare('SELECT version FROM schema_versions ORDER BY version').all<{ version: number }>()).results.map(row => row.version);
  if (manifest.centerId !== job.center_id || manifest.month !== job.month || manifest.timezone !== job.timezone || manifest.createdAt !== job.created_at || manifest.periodFrom !== job.period_from || manifest.periodTo !== job.period_to || manifest.applicationVersion !== job.application_version || manifest.parts.length !== job.next_part || JSON.stringify(manifest.schemaVersions) !== job.schema_json || manifest.schemaVersions.some(version => !versions.includes(version))) throw unavailable();
  return manifest;
}

/** Copy-only reader: check real source ownership as well as encrypted row scope.
 * Replacing these checks with archive indexes belongs to a reviewed eviction step.
 */
async function verifyPartScope(env: Env, job: ReaderJob, records: ArchiveRecord[], part: number) {
  const members = (await env.CRM_DB.prepare('SELECT table_name,record_key,content_sha256 FROM archive_members WHERE job_id=? AND part_index=? LIMIT 257').bind(job.id, part).all<{ table_name: string; record_key: string; content_sha256: string }>()).results;
  const expected = new Map(members.map(row => [JSON.stringify([row.table_name, row.record_key]), row.content_sha256]));
  if (expected.size !== records.length) throw unavailable();
  const references = new Map<string, Set<string>>();
  const add = (table: string, value: unknown) => { if (value === null || value === undefined) return; if (typeof value !== 'string' || !ident.test(value)) throw unavailable(); let ids = references.get(table); if (!ids) references.set(table, ids = new Set()); ids.add(value); };
  for (const record of records) {
    if (await digest(encoder.encode(JSON.stringify(record))) !== expected.get(JSON.stringify([record.table, record.key]))) throw unavailable();
    const row = record.row, allowed = contextColumns[record.table];
    if (allowed && Object.keys(row).some(key => !allowed.includes(key))) throw unavailable();
    if (record.table !== 'centers' && record.table !== 'student_guardians') add(record.table, row.id);
    if (record.table !== 'centers') add('students', row.student_id);
    add('guardians', row.guardian_id); add('visits', row.visit_id); add('attendance_events', row.event_id);
    for (const field of ['actor_id', 'check_in_by', 'check_out_by', 'resolved_by']) add('staff', row[field]);
    add('kiosk_devices', row.device_id);
    if (record.table === 'audit_entries') { const target = { attendance_event: 'attendance_events', visit: 'visits', review: 'reviews' }[String(row.entity_type)]; if (!target) throw unavailable(); add(target, row.entity_id); }
    if (record.table === 'attendance_events') {
      const receipt = decodeAttendanceReceipt({ visit_id: row.visit_id, student_id: row.student_id, action: row.action, observed_at: row.observed_at, result_visit: row.result_visit });
      if (receipt ? receipt.id !== row.visit_id || receipt.studentId !== row.student_id : row.visit_id !== null) throw unavailable();
    }
  }
  const statements: D1PreparedStatement[] = [];
  for (const [table, ids] of references) {
    const source = table === 'audit_entries' ? 'audit_timeline' : table;
    // Table names come only from the fixed archive format and literal mappings above.
    statements.push(env.CRM_DB.prepare(`SELECT count(*) AS n FROM ${source} WHERE center_id=? AND id IN (SELECT value FROM json_each(?))`).bind(job.center_id, JSON.stringify([...ids])));
    if (table !== 'kiosk_devices') statements.push(env.CRM_DB.prepare('SELECT count(*) AS n FROM archive_members WHERE job_id=? AND table_name=? AND record_key IN (SELECT value FROM json_each(?))').bind(job.id, table, JSON.stringify([...ids])));
  }
  if (statements.length) {
    const counts = await env.CRM_DB.batch(statements); let index = 0;
    for (const [table, ids] of references) { if (Number((counts[index++].results[0] as { n: number }).n) !== ids.size) throw unavailable(); if (table !== 'kiosk_devices' && Number((counts[index++].results[0] as { n: number }).n) !== ids.size) throw unavailable(); }
  }
}

export const archiveReaderRouter = new Hono<AppEnv>();
archiveReaderRouter.use('*', async (c, next) => { requireRole(c, managementRoles); c.header('Cache-Control', 'private, no-store'); c.header('Pragma', 'no-cache'); await next(); });
archiveReaderRouter.get('/', async c => {
  const limit = size(c.req.query('limit'), 10, 25), month = c.req.query('month') || '';
  if (month && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw invalid('Choose a calendar month between 2000 and 2099.');
  const cursor = c.req.query('cursor') ? decodeCursor(c.req.query('cursor')!) : null;
  if (cursor && (cursor.month !== month || typeof cursor.createdAt !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(cursor.createdAt) || typeof cursor.id !== 'string' || !ident.test(cursor.id))) throw invalid();
  const items = (await c.env.CRM_DB.prepare(`SELECT id,month,timezone,created_at AS capturedAt,completed_at AS verifiedAt FROM archive_jobs WHERE center_id=? AND status='complete' AND completed_at IS NOT NULL AND CASE WHEN json_valid(manifest_json) THEN json_extract(manifest_json,'$.format') END=? ${month ? 'AND month=?' : ''} ${cursor ? 'AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`).bind(centerId(c), ARCHIVE_FORMAT, ...(month ? [month] : []), ...(cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : []), limit + 1).all<ArchiveCatalog['items'][number]>()).results;
  const page = items.slice(0, limit), last = page.at(-1);
  const payload = JSON.stringify({ items: page, nextCursor: items.length > limit && last ? encodeCursor({ month, createdAt: last.capturedAt, id: last.id }) : null, mode: 'verified-copy' } satisfies ArchiveCatalog);
  if (encoder.encode(payload).length > RESPONSE_BYTES) throw unavailable();
  return c.body(payload, 200, { 'Content-Type': 'application/json; charset=UTF-8' });
});
archiveReaderRouter.post('/:id/records/query', async c => {
  // Lookup is read-only; filters use a body so names never enter logged URLs.
  const parameter = await readFilters(c);
  if (!ident.test(c.req.param('id'))) throw new ApiProblem(404, 'ARCHIVE_NOT_FOUND', 'A completed historical copy was not found.');
  const job = await c.env.CRM_DB.prepare("SELECT id,center_id,month,timezone,created_at,completed_at,period_from,period_to,application_version,schema_json,next_part,verify_part,manifest_key,manifest_sha256 FROM archive_jobs WHERE id=? AND center_id=? AND status='complete'").bind(c.req.param('id'), centerId(c)).first<ReaderJob>();
  if (!job) throw new ApiProblem(404, 'ARCHIVE_NOT_FOUND', 'A completed historical copy was not found.');
  const table = (parameter('table') || 'visits') as ArchiveTable, limit = size(parameter('limit'), 25, 50);
  const recordId = parameter('recordId') || '', studentId = parameter('studentId') || '', query = (parameter('q') || '').trim().toLowerCase();
  if (!ARCHIVE_TABLES.includes(table) || recordId.length > 210 || query.length > 100 || studentId && (!ident.test(studentId) || !studentTables.includes(table))) throw invalid();
  const filter = await digest(encoder.encode(JSON.stringify({ table, limit, recordId, studentId, query })));
  const cursor = parameter('cursor') ? decodeCursor(parameter('cursor')!) : null;
  if (cursor && (cursor.filter !== filter || !Number.isInteger(cursor.part) || Number(cursor.part) < 0 || Number(cursor.part) >= ARCHIVE_LIMITS.parts || !Number.isInteger(cursor.offset) || Number(cursor.offset) < 0 || Number(cursor.offset) >= ARCHIVE_LIMITS.recordsPerPart)) throw invalid();
  try {
    const manifest = await manifestForRead(c.env, job);
    if (cursor && cursor.hash !== job.manifest_sha256) throw new ApiProblem(409, 'ARCHIVE_PAGE_CHANGED', 'This historical copy changed. Start the review again.');
    const candidates = manifest.parts.filter(part => part.recordCounts[table] > 0 && (!recordId || compareArchiveRecords(part.first, { table, key: recordId }) <= 0 && compareArchiveRecords(part.last, { table, key: recordId }) >= 0));
    const descriptor = cursor ? candidates.find(part => part.index === cursor.part) : candidates[0];
    if (cursor && !descriptor) throw invalid();
    let nextCursor: string | null = null; const items: ArchiveRecord[] = [];
    if (descriptor) {
      const catalog = await c.env.CRM_DB.prepare('SELECT descriptor_json,verified_at FROM archive_parts WHERE job_id=? AND part_index=?').bind(job.id, descriptor.index).first<{ descriptor_json: string; verified_at: string | null }>();
      if (!catalog?.verified_at || catalog.descriptor_json.length > 8192 || JSON.stringify(JSON.parse(catalog.descriptor_json)) !== JSON.stringify(descriptor)) throw unavailable();
      const records = await verifyArchivePart(String(c.env.BACKUP_KEY), manifest, descriptor, await readObject(c.env, descriptor.objectKey, descriptor.encryptedBytes));
      await verifyPartScope(c.env, job, records, descriptor.index);
      let position = Number(cursor?.offset || 0), bytes = 0;
      if (position >= records.length) throw invalid();
      for (; position < records.length; position++) {
        const record = records[position], row = record.row;
        if (record.table !== table || recordId && record.key !== recordId || studentId && (table === 'students' ? row.id : row.student_id) !== studentId) continue;
        const searchable = [record.key, row.first_name, row.last_name, row.student_code, row.display_name, row.actor_name, row.reason, row.resolution, row.detail, row.authority_note].filter(value => typeof value === 'string').join(' ').toLowerCase();
        if (query && !searchable.includes(query)) continue;
        const length = encoder.encode(JSON.stringify(record)).length;
        if (items.length >= limit || bytes + length > ITEMS_BYTES) break;
        items.push(record); bytes += length;
      }
      const next = candidates[candidates.indexOf(descriptor) + 1];
      if (position < records.length) nextCursor = encodeCursor({ hash: job.manifest_sha256, filter, part: descriptor.index, offset: position });
      else if (next) nextCursor = encodeCursor({ hash: job.manifest_sha256, filter, part: next.index, offset: 0 });
    }
    const result: ArchiveRecordPage = { snapshot: { id: job.id, month: job.month, timezone: job.timezone, capturedAt: job.created_at, verifiedAt: job.completed_at!, recordCounts: manifest.recordCounts, manifestSha256: job.manifest_sha256! }, table, items, nextCursor, pageVerified: true, searchComplete: !nextCursor, mode: 'verified-copy' };
    const json = JSON.stringify(result); if (encoder.encode(json).length > RESPONSE_BYTES) throw unavailable();
    return c.body(json, 200, { 'Content-Type': 'application/json; charset=UTF-8' });
  } catch (error) { if (error instanceof ApiProblem) throw error; throw unavailable(); }
});
