import { Hono } from 'hono';
import type { AppEnv } from './types';
import { studentView } from './records';
import { ApiProblem, attendanceRoles, body, centerId, now, requireRole, textValue } from './util';
import type { DirectoryResult } from '../shared/directory';

export const directoryRouter = new Hono<AppEnv>();

// Read-only POST keeps family names, phone numbers, and email addresses out of URLs.
directoryRouter.post('/directory/query', async c => {
  requireRole(c, attendanceRoles);
  const input = await body(c);
  if (Object.keys(input).some(key => !['q', 'status', 'subject', 'page', 'pageSize'].includes(key))) throw new ApiProblem(400, 'INVALID_FILTER', 'Use the supported directory filters.');
  const q = textValue(input.q ?? '', 'Search', 100, false);
  const status = input.status ?? 'active', subject = input.subject ?? 'all';
  const page = input.page ?? 1, pageSize = input.pageSize ?? 25;
  if (typeof status !== 'string' || typeof subject !== 'string' || !['active', 'inactive', 'all'].includes(status) || !['all', 'Math', 'Reading'].includes(subject)) throw new ApiProblem(400, 'INVALID_FILTER', 'Choose a valid subject and enrollment status.');
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 10000 || typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50) throw new ApiProblem(400, 'INVALID_PAGE', 'Use a positive page number and a page size from 1 to 50.');
  const where = `s.center_id=? AND (?='all' OR s.active=?)
    AND (?='all' OR EXISTS(SELECT 1 FROM json_each(s.subjects) WHERE value=?))
    AND (?='' OR instr(lower(s.first_name||' '||s.last_name),lower(?))>0 OR instr(lower(s.student_code),lower(?))>0
      OR EXISTS(SELECT 1 FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id
        WHERE sg.student_id=s.id AND g.center_id=s.center_id AND
        (instr(lower(g.display_name),lower(?))>0 OR instr(lower(g.email),lower(?))>0 OR instr(lower(g.phone),lower(?))>0)))`;
  const args = [centerId(c), status, status === 'active' ? 1 : 0, subject, subject, q, q, q, q, q, q];
  const results = await c.env.CRM_DB.batch<Record<string, unknown>>([
    c.env.CRM_DB.prepare(`SELECT s.*,g.display_name AS contact_name,g.phone AS contact_phone,g.email AS contact_email
      FROM students s LEFT JOIN guardians g ON g.id=(SELECT g2.id FROM student_guardians sg2
        JOIN guardians g2 ON g2.id=sg2.guardian_id WHERE sg2.student_id=s.id AND g2.center_id=s.center_id
        ORDER BY g2.display_name,g2.id LIMIT 1)
      WHERE ${where} ORDER BY s.last_name,s.first_name,s.id LIMIT ? OFFSET ?`).bind(...args, pageSize, (page - 1) * pageSize),
    c.env.CRM_DB.prepare(`SELECT count(*) AS n FROM students s WHERE ${where}`).bind(...args),
    c.env.CRM_DB.prepare(`SELECT count(*) AS active,
      coalesce(sum(EXISTS(SELECT 1 FROM json_each(subjects) WHERE value='Math')),0) AS math,
      coalesce(sum(EXISTS(SELECT 1 FROM json_each(subjects) WHERE value='Reading')),0) AS reading
      FROM students WHERE center_id=? AND active=1`).bind(centerId(c)),
  ]);
  const counts = results[2].results[0];
  const result: DirectoryResult = {
    items: results[0].results.map(row => ({ ...studentView(row), contact: row.contact_name === null ? null : { displayName: String(row.contact_name), phone: String(row.contact_phone), email: String(row.contact_email) } })),
    total: Number(results[1].results[0].n), page, pageSize,
    counts: { active: Number(counts.active), math: Number(counts.math), reading: Number(counts.reading) }, asOf: now(),
  };
  return c.json(result);
});
