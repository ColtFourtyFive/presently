import { Hono } from 'hono';
import type { AppEnv, Env } from './types';
import { ApiProblem, audit, body, managementRoles, now, paramId, requireAdmin, requireRole, sha256, textValue, type Ctx, type Row } from './util';
import { IMPORT_FIELDS, type ImportField, type ImportPreview, type ImportRow, type ImportSummary } from '../shared/import';

const MAX_ROWS = 500;
/** Rows applied per commit request. Each row takes up to five statements, which keeps a request well under D1's per-invocation query limit. */
export const COMMIT_ROWS = 8;
const PREVIEW_HOURS = 24;

type Mapping = Partial<Record<ImportField, string>>;
type Values = Partial<Record<ImportField, string>> & { subjectList?: string[] };

export function parseCsv(csv: string): { headers: string[]; rows: string[][] } {
  if (new TextEncoder().encode(csv).length > 512 * 1024) throw new Error('CSV must be no larger than 512 KB.');
  csv = csv.replace(/^﻿/, '');
  if (csv.includes('\u0000')) throw new Error('CSV contains unsupported NUL characters.');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  const pushCell = () => {
    if (cell.length > 2000) throw new Error('A CSV field exceeds 2,000 characters.');
    row.push(cell); cell = ''; closed = false;
    if (row.length > 40) throw new Error('CSV supports at most 40 columns.');
  };
  const pushRow = () => {
    pushCell();
    if (row.some(v => v.trim())) rows.push(row);
    row = [];
    if (rows.length > MAX_ROWS + 1) throw new Error(`Import at most ${MAX_ROWS} rows per file.`);
  };
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"') { if (csv[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += ch;
      continue;
    }
    if (ch === '"') { if (cell || closed) throw new Error('Malformed CSV quoting.'); quoted = true; }
    else if (ch === ',') pushCell();
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && csv[i + 1] === '\n') i++; pushRow(); }
    else { if (closed) throw new Error('Unexpected text after a quoted CSV field.'); cell += ch; }
  }
  if (quoted) throw new Error('CSV has an unclosed quoted field.');
  if (cell || row.length || closed) pushRow();
  const headers = rows.shift()?.map(h => h.trim()) || [];
  if (!headers.length || !rows.length) throw new Error('CSV needs a header and at least one data row.');
  if (headers.some(h => !h) || new Set(headers.map(h => h.toLowerCase())).size !== headers.length) throw new Error('CSV headers must be nonempty and unique.');
  if (rows.some(r => r.length !== headers.length)) throw new Error('Each CSV row must have the same number of columns as the header.');
  return { headers, rows };
}

function mapRow(headers: string[], cells: string[], mapping: Mapping): Values {
  const value: Values = {};
  for (const field of IMPORT_FIELDS) { const column = mapping[field]; if (column) value[field] = cells[headers.indexOf(column)].trim(); }
  if (mapping.subjects) {
    value.subjectList = [...new Set(String(value.subjects).split(/[;,|]/).map(x => x.trim()).filter(Boolean)
      .map(x => (/^math$/i.test(x) ? 'Math' : /^reading$/i.test(x) ? 'Reading' : x)))];
  }
  if (mapping.pickupAuthority) value.pickupAuthority = String(value.pickupAuthority).toLowerCase() || 'unverified';
  return value;
}

function validate(value: Values): string | null {
  if (!value.studentCode || !value.firstName || !value.lastName) return 'Student code, first name, and last name are required.';
  if (value.studentCode.length > 60 || value.firstName.length > 100 || value.lastName.length > 100) return 'Student identity fields are too long.';
  if ((value.grade ?? '').length > 30) return 'Grade must be at most 30 characters.';
  if ((value.subjectList || []).some(s => s.length > 60) || (value.subjectList || []).length > 10) return 'List at most 10 short subject names.';
  if (!['unverified', 'allowed', 'denied'].includes(value.pickupAuthority ?? 'unverified')) return 'Pickup authority must be unverified, allowed, or denied.';
  if (value.pickupAuthority === 'allowed' && (value.pickupAuthorityNote ?? '').length < 5) return 'Allowed pickup requires a note on how it was verified.';
  const guardianDetail = [value.guardianReference, value.guardianEmail, value.guardianPhone, value.guardianRelationship, value.pickupAuthorityNote].some(Boolean);
  if (!value.guardianName && guardianDetail) return 'Guardian name is required when guardian information is supplied.';
  if (value.pickupAuthority && value.pickupAuthority !== 'unverified' && !value.guardianName) return 'Pickup authority requires an identified guardian.';
  if (value.guardianEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.guardianEmail)) return 'Guardian email is not valid.';
  if ((value.guardianName ?? '').length > 150 || (value.guardianReference ?? '').length > 100) return 'Guardian fields are too long.';
  if ((value.pickupAlert ?? '').length > 1000 || (value.pickupAuthorityNote ?? '').length > 1000) return 'Pickup notes must be at most 1,000 characters.';
  return null;
}

const nameKey = (first: string, last: string) => `${first} ${last}`.replace(/\s+/g, ' ').trim().toLowerCase();

function rowView(row: Row): ImportRow {
  return {
    row: Number(row.row_number), action: row.action as ImportRow['action'], status: row.status as ImportRow['status'],
    studentCode: String(row.student_code), studentName: String(row.student_name), problem: (row.problem as string | null) ?? null,
  };
}

async function summary(env: Env, id: number, locationId: number): Promise<ImportPreview | null> {
  const [job, rows] = await env.CRM_DB.batch<Row>([
    env.CRM_DB.prepare('SELECT * FROM imports WHERE id = ? AND location_id = ?').bind(id, locationId),
    env.CRM_DB.prepare('SELECT row_number, action, status, student_code, student_name, problem FROM import_rows WHERE import_id = ? ORDER BY row_number').bind(id),
  ]);
  const record = job.results[0];
  if (!record) return null;
  const items = rows.results.map(rowView);
  return {
    importId: id, status: record.status as ImportPreview['status'], sourceName: String(record.source_name), totalRows: Number(record.total_rows),
    createdAt: String(record.created_at), expiresAt: String(record.expires_at), completedAt: (record.completed_at as string | null) ?? null,
    remaining: items.filter(r => r.status === 'pending').length, rows: items,
  };
}

export async function cleanExpiredImports(env: Env) {
  const time = now();
  await env.CRM_DB.batch([
    env.CRM_DB.prepare("UPDATE imports SET status = 'expired' WHERE status = 'preview' AND expires_at <= ?").bind(time),
    env.CRM_DB.prepare("UPDATE import_rows SET payload = NULL WHERE payload IS NOT NULL AND import_id IN (SELECT id FROM imports WHERE status != 'preview')"),
  ]);
}

/** Statements that apply one reviewed row. Every statement is idempotent so a retried request cannot duplicate records. */
function applyRow(c: Ctx, importId: number, rowNumber: number, action: 'create' | 'update', v: Values) {
  const db = c.env.CRM_DB;
  const location = c.var.locationId;
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];
  const subjects = v.subjectList ? JSON.stringify(v.subjectList) : null;
  if (action === 'create') {
    statements.push(db.prepare(`INSERT INTO students (location_id, student_code, first_name, last_name, grade, subjects, pickup_alert, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?) ON CONFLICT (location_id, student_code) DO NOTHING`)
      .bind(location, v.studentCode, v.firstName, v.lastName, v.grade ?? '', subjects ?? '[]', v.pickupAlert ?? '', timestamp, timestamp));
  } else {
    statements.push(db.prepare(`UPDATE students SET first_name = ?, last_name = ?, grade = coalesce(?, grade), subjects = coalesce(?, subjects),
      pickup_alert = coalesce(?, pickup_alert), revision = revision + 1, updated_at = ? WHERE location_id = ? AND student_code = ?`)
      .bind(v.firstName, v.lastName, v.grade ?? null, subjects, v.pickupAlert ?? null, timestamp, location, v.studentCode));
  }
  if (v.guardianName) {
    const ref = v.guardianReference ? `ref:${v.guardianReference}` : `import:${importId}:${rowNumber}`;
    statements.push(
      db.prepare(`INSERT INTO guardians (display_name, phone, email, import_ref, created_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (import_ref) DO UPDATE SET display_name = excluded.display_name,
          phone = iif(excluded.phone = '', guardians.phone, excluded.phone), email = iif(excluded.email = '', guardians.email, excluded.email)`)
        .bind(v.guardianName, v.guardianPhone ?? '', v.guardianEmail ?? '', ref, timestamp),
      db.prepare(`INSERT INTO student_guardians (student_id, guardian_id, relationship, pickup_authority, authority_note)
        SELECT s.id, g.id, ?, ?, ? FROM students s, guardians g WHERE s.location_id = ? AND s.student_code = ? AND g.import_ref = ?
        ON CONFLICT (student_id, guardian_id) DO UPDATE SET relationship = excluded.relationship,
          pickup_authority = excluded.pickup_authority, authority_note = excluded.authority_note`)
        .bind(v.guardianRelationship ?? '', v.pickupAuthority ?? 'unverified', v.pickupAuthorityNote ?? '', location, v.studentCode, ref),
    );
  }
  statements.push(db.prepare("UPDATE import_rows SET status = 'applied', action = ? WHERE import_id = ? AND row_number = ?").bind(action, importId, rowNumber));
  return statements;
}

export const importRouter = new Hono<AppEnv>();
importRouter.use('*', async (c, next) => { requireAdmin(c); requireRole(c, managementRoles); await next(); });

importRouter.get('/', async c => {
  const rows = await c.env.CRM_DB.prepare(
    `SELECT i.id, i.status, i.source_name, i.total_rows, i.created_at, i.completed_at,
       (SELECT count(*) FROM import_rows r WHERE r.import_id = i.id AND r.status = 'applied') AS applied
     FROM imports i WHERE i.location_id = ? ORDER BY i.created_at DESC, i.id DESC LIMIT 50`,
  ).bind(c.var.locationId).all<Row>();
  const items: ImportSummary[] = rows.results.map(r => ({
    importId: Number(r.id), status: r.status as ImportSummary['status'], sourceName: String(r.source_name), totalRows: Number(r.total_rows),
    applied: Number(r.applied), createdAt: String(r.created_at), completedAt: (r.completed_at as string | null) ?? null,
  }));
  return c.json({ items });
});

importRouter.post('/preview', async c => {
  const input = await body(c, 800 * 1024);
  if (typeof input.csv !== 'string' || !input.mapping || typeof input.mapping !== 'object' || Array.isArray(input.mapping))
    throw new ApiProblem(400, 'IMPORT_FORMAT', 'Supply a CSV file and column mapping.');
  const sourceName = textValue(input.sourceName ?? 'roster.csv', 'sourceName', 200, false);
  let parsed: ReturnType<typeof parseCsv>;
  try { parsed = parseCsv(input.csv); } catch (error) { throw new ApiProblem(400, 'CSV_INVALID', error instanceof Error ? error.message : 'Invalid CSV.'); }
  const mapping: Mapping = {};
  const requested = input.mapping as Record<string, unknown>;
  for (const field of IMPORT_FIELDS) {
    const column = requested[field];
    if (column === undefined || column === '' || column === null) continue;
    if (typeof column !== 'string' || !parsed.headers.includes(column)) throw new ApiProblem(400, 'MAPPING_INVALID', `The ${field} column does not exist.`);
    mapping[field] = column;
  }
  if (!mapping.studentCode || !mapping.firstName || !mapping.lastName) throw new ApiProblem(400, 'MAPPING_REQUIRED', 'Map a stable student code, first name, and last name.');
  if (new Set(Object.values(mapping)).size !== Object.values(mapping).length) throw new ApiProblem(400, 'MAPPING_DUPLICATE', 'Each CSV column can map to only one field.');

  const values = parsed.rows.map(cells => mapRow(parsed.headers, cells, mapping));
  const db = c.env.CRM_DB;
  // Load the location roster once to match both codes and names.
  const existing = await db.prepare('SELECT student_code, first_name, last_name FROM students WHERE location_id = ? LIMIT 5001')
    .bind(c.var.locationId).all<Row>();
  if (existing.results.length > 5000) throw new ApiProblem(409, 'ROSTER_TOO_LARGE', 'This location has too many students to preview an import safely.');
  const byCode = new Map(existing.results.map(r => [String(r.student_code), r]));
  const byName = new Map<string, string[]>();
  for (const r of existing.results) {
    const key = nameKey(String(r.first_name), String(r.last_name));
    byName.set(key, [...(byName.get(key) || []), String(r.student_code)]);
  }
  const seenCodes = new Set<string>();
  const rows = values.map((value, index) => {
    const row = index + 2; // Spreadsheet row number, counting the header.
    let action: ImportRow['action'] = 'create';
    let problem = validate(value);
    if (!problem && seenCodes.has(value.studentCode!)) problem = 'This student code appears earlier in the file.';
    if (problem) action = 'reject';
    else {
      seenCodes.add(value.studentCode!);
      if (byCode.has(value.studentCode!)) action = 'update';
      else {
        const others = byName.get(nameKey(value.firstName!, value.lastName!)) || [];
        if (others.length) { action = 'skip'; problem = `Possible duplicate of existing student ${others.join(', ')}. Choose “create” if this is a different student.`; }
      }
    }
    return {
      row, action, status: action === 'reject' ? 'rejected' : 'pending', studentCode: value.studentCode ?? '',
      studentName: `${value.firstName ?? ''} ${value.lastName ?? ''}`.trim(), problem, payload: action === 'reject' ? null : JSON.stringify(value),
    };
  });
  const timestamp = now();
  const sourceHash = await sha256(`${input.csv}\n${JSON.stringify(mapping)}`);
  const created = await db.prepare("INSERT INTO imports (location_id, status, source_name, source_hash, total_rows, created_by, created_at, expires_at) VALUES (?, 'preview', ?, ?, ?, ?, ?, ?) RETURNING id")
    .bind(c.var.locationId, sourceName, sourceHash, rows.length, c.var.actor.id, timestamp, new Date(Date.now() + PREVIEW_HOURS * 3600000).toISOString()).first<Row>();
  const importId = Number(created!.id);
  const nothingToApply = rows.every(row => row.status === 'rejected');
  // One statement for every row keeps the preview within D1's per-request query limit.
  await db.prepare(`INSERT INTO import_rows (import_id, row_number, action, status, student_code, student_name, problem, payload)
    SELECT ?, json_extract(value, '$.row'), json_extract(value, '$.action'), json_extract(value, '$.status'),
      json_extract(value, '$.studentCode'), json_extract(value, '$.studentName'), json_extract(value, '$.problem'), json_extract(value, '$.payload')
    FROM json_each(?)`).bind(importId, JSON.stringify(rows)).run();
  // A file where every row was rejected has nothing to commit; close it now.
  if (nothingToApply) await db.prepare("UPDATE imports SET status = 'completed', completed_at = ? WHERE id = ?").bind(now(), importId).run();
  await audit(c, 'import_previewed', 'import', importId, { sourceName, rows: rows.length }, c.var.locationId).run();
  return c.json(await summary(c.env, importId, c.var.locationId), 201);
});

importRouter.get('/:id', async c => {
  const result = await summary(c.env, paramId(c), c.var.locationId);
  if (!result) throw new ApiProblem(404, 'IMPORT_NOT_FOUND', 'Import was not found.');
  return c.json(result);
});

/** Apply up to COMMIT_ROWS reviewed rows. The client calls this repeatedly until nothing remains. */
importRouter.post('/:id/commit', async c => {
  const importId = paramId(c);
  const input = await body(c);
  const decisions = input.rows;
  if (!Array.isArray(decisions) || !decisions.length || decisions.length > COMMIT_ROWS) throw new ApiProblem(400, 'INVALID_INPUT', `Send between 1 and ${COMMIT_ROWS} rows.`);
  const db = c.env.CRM_DB;
  const job = await db.prepare("SELECT id, status FROM imports WHERE id = ? AND location_id = ?").bind(importId, c.var.locationId).first<Row>();
  if (!job) throw new ApiProblem(404, 'IMPORT_NOT_FOUND', 'Import was not found.');
  if (job.status !== 'preview') throw new ApiProblem(409, 'IMPORT_CLOSED', 'This import is no longer open. Upload the file again.');
  const wanted = decisions.map(d => {
    const row = Number((d as Row)?.row);
    const action = (d as Row)?.action;
    if (!Number.isInteger(row) || !['create', 'update', 'skip'].includes(String(action))) throw new ApiProblem(400, 'INVALID_INPUT', 'Each row needs a row number and create, update, or skip.');
    return { row, action: action as 'create' | 'update' | 'skip' };
  });
  const pending = await db.prepare("SELECT row_number, action, payload FROM import_rows WHERE import_id = ? AND status = 'pending' AND row_number IN (SELECT value FROM json_each(?))")
    .bind(importId, JSON.stringify(wanted.map(w => w.row))).all<Row>();
  const byRow = new Map(pending.results.map(r => [Number(r.row_number), r]));
  const codes = pending.results.map(r => String((JSON.parse(String(r.payload)) as Values).studentCode));
  const existing = await db.prepare('SELECT student_code FROM students WHERE location_id = ? AND student_code IN (SELECT value FROM json_each(?))')
    .bind(c.var.locationId, JSON.stringify(codes)).all<Row>();
  const existingCodes = new Set(existing.results.map(r => String(r.student_code)));
  const statements: D1PreparedStatement[] = [];
  for (const { row, action } of wanted) {
    const stored = byRow.get(row);
    if (!stored) continue; // Already applied or skipped by an earlier request.
    const value = JSON.parse(String(stored.payload)) as Values;
    if (action === 'skip') {
      statements.push(db.prepare("UPDATE import_rows SET status = 'skipped', action = 'skip' WHERE import_id = ? AND row_number = ? AND status = 'pending'").bind(importId, row));
      continue;
    }
    // Decide against the current roster: a code created since the preview is updated rather than duplicated.
    statements.push(...applyRow(c, importId, row, existingCodes.has(value.studentCode!) ? 'update' : action === 'update' ? 'create' : action, value));
  }
  statements.push(
    db.prepare(`UPDATE imports SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'preview'
      AND NOT EXISTS (SELECT 1 FROM import_rows WHERE import_id = ? AND status = 'pending')`).bind(now(), importId, importId),
    db.prepare("UPDATE import_rows SET payload = NULL WHERE import_id = ? AND EXISTS (SELECT 1 FROM imports WHERE id = ? AND status = 'completed')").bind(importId, importId),
  );
  await db.batch(statements);
  const result = await summary(c.env, importId, c.var.locationId);
  if (result?.status === 'completed') await audit(c, 'import_completed', 'import', importId, { applied: result.rows.filter(r => r.status === 'applied').length }, c.var.locationId).run();
  return c.json(result);
});
