import type { Env } from './types';
import { ARCHIVE_TABLES, type ArchiveMetadata, type ArchiveRecord, type ArchiveRow, type ArchiveTable, type ArchiveSemanticProof } from '../shared/archive-format';
import { ApiProblem } from './util';

export type ArchiveJob = {
  id: string; center_id: string; month: string; timezone: string;
  period_from: string; period_to: string; cutoff: string; created_at: string; updated_at: string;
  created_by: string; schema_json: string; application_version: string; status: string;
  source_expires_at: string; next_part: number; cursor_table: number; cursor_key: string;
  verify_part: number; manifest_key: string | null; manifest_sha256: string | null;
  manifest_json: string | null; completed_at: string | null; error_code: string | null;
  lease_token: string | null; lease_until: string | null; attempts: number;
  format_version: 1 | 2; semantic_proof_json: string | null;
};

export function jobMetadata(job: ArchiveJob): ArchiveMetadata {
  if (job.format_version !== 1 && job.format_version !== 2) throw new Error('ARCHIVE_JOB_FORMAT');
  if (job.format_version === 1 && job.semantic_proof_json !== null) throw new Error('ARCHIVE_JOB_PROFILE');
  if (job.format_version === 2 && !job.semantic_proof_json) throw new Error('ARCHIVE_JOB_PROFILE');
  return { archiveId: job.id, centerId: job.center_id, month: job.month, timezone: job.timezone,
    kind: 'monthly', createdAt: job.created_at, applicationVersion: job.application_version,
    schemaVersions: JSON.parse(job.schema_json) as number[], references: [],
    ...(job.format_version === 2 ? { semanticProof: JSON.parse(job.semantic_proof_json!) as ArchiveSemanticProof } : {}) };
}

// These are evidence snapshots, not authentication or CRM profile backups.
// Explicit columns prevent credentials from appearing in historical archives.
const contextColumns: Partial<Record<ArchiveTable, readonly string[]>> = {
  centers: ['id', 'name', 'timezone', 'created_at'],
  students: ['id', 'center_id', 'student_code', 'first_name', 'last_name', 'active', 'subjects', 'created_at', 'updated_at'],
  guardians: ['id', 'center_id', 'display_name', 'created_at'],
  student_guardians: ['student_id', 'guardian_id', 'relationship', 'pickup_authority', 'authority_note'],
  staff: ['id', 'center_id', 'display_name', 'role', 'active', 'created_at', 'updated_at'],
};

/** All membership and identity snapshots are inserted in the job's creation batch. */
export function snapshotStatements(env: Env, job: ArchiveJob): D1PreparedStatement[] {
  const db = env.CRM_DB;
  const member = (table: ArchiveTable, alias: string) => `EXISTS(SELECT 1 FROM archive_members am WHERE am.job_id=? AND am.table_name='${table}' AND am.record_key=${alias}.id)`;
  const statements: D1PreparedStatement[] = [
    db.prepare(`INSERT INTO archive_members(job_id,table_name,record_key)
      SELECT ?,'visits',v.id FROM visits v
      WHERE v.center_id=? AND v.original_check_in_at>=? AND v.original_check_in_at<?
        AND v.check_out_at IS NOT NULL AND v.check_out_at<? AND v.review_status!='pending'
        AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.visit_id=v.id AND r.status='pending')
        AND NOT EXISTS(SELECT 1 FROM archive_holds h WHERE h.center_id=v.center_id AND h.released_at IS NULL AND (h.visit_id=v.id OR h.student_id=v.student_id))`)
      .bind(job.id, job.center_id, job.period_from, job.period_to, job.cutoff),
    db.prepare(`INSERT INTO archive_members(job_id,table_name,record_key)
      SELECT ?,'attendance_events',e.id FROM attendance_events e
      WHERE e.center_id=? AND (EXISTS(SELECT 1 FROM archive_members m WHERE m.job_id=? AND m.table_name='visits' AND m.record_key=e.visit_id)
        OR (e.visit_id IS NULL AND e.observed_at>=? AND e.observed_at<?
     AND NOT EXISTS(SELECT 1 FROM observation_effective_times p WHERE p.event_id=e.id AND p.version>1)
     AND EXISTS(SELECT 1 FROM reviews r WHERE r.event_id=e.id AND r.status='resolved')
          AND NOT EXISTS(SELECT 1 FROM archive_holds h WHERE h.center_id=e.center_id AND h.released_at IS NULL AND h.student_id=e.student_id)))`)
      .bind(job.id, job.center_id, job.id, job.period_from, job.period_to),
    db.prepare(`INSERT INTO archive_members(job_id,table_name,record_key)
      SELECT ?,'attendance_corrections',c.id FROM attendance_corrections c JOIN visits v ON v.id=c.visit_id WHERE c.center_id=? AND ${member('visits', 'v')}`)
      .bind(job.id, job.center_id, job.id),
    db.prepare(`INSERT INTO archive_members(job_id,table_name,record_key)
      SELECT ?,'reviews',r.id FROM reviews r JOIN attendance_events e ON e.id=r.event_id WHERE r.center_id=? AND ${member('attendance_events', 'e')}`)
      .bind(job.id, job.center_id, job.id),
    db.prepare(`INSERT INTO archive_members(job_id,table_name,record_key)
      SELECT ?,'audit_entries',a.id FROM audit_timeline a WHERE a.center_id=? AND EXISTS(
        SELECT 1 FROM archive_members m WHERE m.job_id=? AND (
          (m.table_name='attendance_events' AND a.entity_type='attendance_event' AND a.entity_id=m.record_key)
          OR (m.table_name='visits' AND a.entity_type='visit' AND a.entity_id=m.record_key)
          OR (m.table_name='reviews' AND a.entity_type='review' AND a.entity_id=m.record_key)))`)
      .bind(job.id, job.center_id, job.id),
  ];
  const addContext = (table: ArchiveTable, alias: string, where: string, args: string[], key = `${alias}.id`) => {
    const fields = contextColumns[table]!;
    const json = `json_object(${fields.map(column => `'${column}',${alias}.${column}`).join(',')})`;
    statements.push(db.prepare(`INSERT INTO archive_members(job_id,table_name,record_key,row_json) SELECT ?,?,${key},${json} FROM ${table} ${alias} WHERE ${where}`).bind(job.id, table, ...args));
  };
  addContext('centers', 'c', 'c.id=?', [job.center_id]);
  addContext('students', 's', `s.center_id=? AND (EXISTS(SELECT 1 FROM attendance_events e JOIN archive_members m ON m.record_key=e.id AND m.table_name='attendance_events' AND m.job_id=? WHERE e.student_id=s.id)
    OR EXISTS(SELECT 1 FROM visits v JOIN archive_members m ON m.record_key=v.id AND m.table_name='visits' AND m.job_id=? WHERE v.student_id=s.id))`, [job.center_id, job.id, job.id]);
  addContext('guardians', 'g', `g.center_id=? AND (EXISTS(SELECT 1 FROM student_guardians sg JOIN archive_members m ON m.record_key=sg.student_id AND m.table_name='students' AND m.job_id=? WHERE sg.guardian_id=g.id)
    OR EXISTS(SELECT 1 FROM attendance_events e JOIN archive_members m ON m.record_key=e.id AND m.table_name='attendance_events' AND m.job_id=? WHERE e.guardian_id=g.id)
    OR EXISTS(SELECT 1 FROM visits v JOIN archive_members m ON m.record_key=v.id AND m.table_name='visits' AND m.job_id=? WHERE v.guardian_id=g.id))`, [job.center_id, job.id, job.id, job.id]);
  addContext('student_guardians', 'sg', `EXISTS(SELECT 1 FROM archive_members m WHERE m.job_id=? AND m.table_name='students' AND m.record_key=sg.student_id)`, [job.id], 'json_array(sg.student_id,sg.guardian_id)');
  addContext('staff', 's', `s.center_id=? AND (EXISTS(SELECT 1 FROM attendance_events e JOIN archive_members m ON m.record_key=e.id AND m.table_name='attendance_events' AND m.job_id=? WHERE e.actor_id=s.id)
    OR EXISTS(SELECT 1 FROM attendance_corrections c JOIN archive_members m ON m.record_key=c.id AND m.table_name='attendance_corrections' AND m.job_id=? WHERE c.actor_id=s.id)
    OR EXISTS(SELECT 1 FROM reviews r JOIN archive_members m ON m.record_key=r.id AND m.table_name='reviews' AND m.job_id=? WHERE r.resolved_by=s.id)
    OR EXISTS(SELECT 1 FROM visits v JOIN archive_members m ON m.record_key=v.id AND m.table_name='visits' AND m.job_id=? WHERE v.check_in_by=s.id OR v.check_out_by=s.id)
    OR EXISTS(SELECT 1 FROM audit_timeline a JOIN archive_members m ON m.record_key=a.id AND m.table_name='audit_entries' AND m.job_id=? WHERE a.actor_id=s.id))`, [job.center_id, job.id, job.id, job.id, job.id, job.id]);
  return statements;
}

/** Keyset pagination bounds memory independently of the number of archived rows. */
export async function sourcePage(env: Env, job: ArchiveJob, tableIndex: number, after: string, limit = 128): Promise<ArchiveRecord[]> {
  const table = ARCHIVE_TABLES[tableIndex];
  if (!table || !Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('ARCHIVE_SOURCE_PAGE');
  if (job.source_expires_at <= new Date().toISOString()) throw new Error('ARCHIVE_SOURCE_EXPIRED');
  if (contextColumns[table]) {
    const rows = await env.CRM_DB.prepare('SELECT record_key,row_json FROM archive_members WHERE job_id=? AND table_name=? AND record_key>? ORDER BY record_key LIMIT ?')
      .bind(job.id, table, after, limit).all<{ record_key: string; row_json: string }>();
    return rows.results.map(r => ({ table, key: r.record_key, row: JSON.parse(r.row_json) as ArchiveRow }));
  }
  const source = table === 'audit_entries' ? 'audit_timeline' : table;
  const rows = await env.CRM_DB.prepare(`SELECT s.*,m.record_key AS archive_record_key FROM archive_members m LEFT JOIN ${source} s ON s.id=m.record_key
    WHERE m.job_id=? AND m.table_name=? AND m.record_key>? ORDER BY m.record_key LIMIT ?`).bind(job.id, table, after, limit).all<ArchiveRow>();
  return rows.results.map(r => {
    const { archive_record_key, ...row } = r;
    if (!row.id) throw new Error('ARCHIVE_SOURCE_MISSING');
    return { table, key: String(archive_record_key), row };
  });
}

export async function assertArchiveSourceAvailable(env: Env, centerId: string) {
  const existing = await env.CRM_DB.prepare("SELECT id FROM archive_jobs WHERE center_id=? AND status IN ('parts','verify')").bind(centerId).first();
  if (existing) throw new ApiProblem(409, 'ARCHIVE_ALREADY_RUNNING', 'Wait for the current historical archive to finish, or cancel it first.');
}
