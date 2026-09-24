import { Hono, type Context } from 'hono';
import type { AppEnv } from './types';
import { ApiProblem, attendanceRoles, body, centerId, now, requireRole, sha256, textValue, uuidValue } from './util';
import { interactionChannels, type Interaction, type InteractionChannel } from '../shared/interactions';

type Row = Record<string, unknown>;
const columns = 'id,student_id,channel,summary,actor_id,actor_name,occurred_at';
function view(row: Row): Interaction {
  return { id: String(row.id), studentId: String(row.student_id), channel: row.channel as InteractionChannel,
    summary: String(row.summary), actorId: String(row.actor_id), actorName: String(row.actor_name), occurredAt: String(row.occurred_at) };
}
async function student(c: Context<AppEnv>) {
  const studentId = uuidValue(c.req.param('id'), 'studentId');
  if (!await c.env.CRM_DB.prepare('SELECT id FROM students WHERE id=? AND center_id=?').bind(studentId, centerId(c)).first())
    throw new ApiProblem(404, 'STUDENT_NOT_FOUND', 'Student was not found.');
  return studentId;
}
function cursor(encoded: string | undefined): [string, string] | null {
  if (encoded === undefined) return null;
  try {
    if (!encoded || encoded.length > 256) throw new Error();
    const value: unknown = JSON.parse(atob(encoded));
    if (!Array.isArray(value) || value.length !== 2 || typeof value[0] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[0]) || !Number.isFinite(Date.parse(value[0]))) throw new Error();
    return [value[0], uuidValue(value[1], 'cursorId')];
  } catch { throw new ApiProblem(400, 'INVALID_CURSOR', 'Reload communication history before loading more entries.'); }
}

export const interactionsRouter = new Hono<AppEnv>();
interactionsRouter.use('/students/:id/interactions*', async (c, next) => {
  if (c.var.actor?.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace.');
  requireRole(c, attendanceRoles); await next();
});
interactionsRouter.get('/students/:id/interactions', async c => {
  const studentId = await student(c), after = cursor(c.req.query('after'));
  const rawLimit = c.req.query('limit') || '25', limit = Number(rawLimit);
  if (!/^\d{1,2}$/.test(rawLimit) || limit < 1 || limit > 50) throw new ApiProblem(400, 'INVALID_PAGE', 'Use a history page size from 1 to 50.');
  const rows = await c.env.CRM_DB.prepare(`SELECT ${columns} FROM interactions WHERE center_id=? AND student_id=?${after ? ' AND (occurred_at,id)<(?,?)' : ''} ORDER BY occurred_at DESC,id DESC LIMIT ?`)
    .bind(centerId(c), studentId, ...(after || []), limit + 1).all<Row>();
  const items = rows.results.slice(0, limit).map(view), last = items.at(-1);
  return c.json({ items, next: rows.results.length > limit && last ? btoa(JSON.stringify([last.occurredAt, last.id])) : null });
});
interactionsRouter.post('/students/:id/interactions', async c => {
  const studentId = await student(c), value = await body(c), interactionId = uuidValue(value.interactionId, 'interactionId');
  const summary = textValue(value.summary, 'Summary', 2000), channel = value.channel;
  if (!interactionChannels.includes(channel as InteractionChannel)) throw new ApiProblem(422, 'INVALID_CHANNEL', 'Choose Phone, Email, Meeting, or Other.');
  const hash = await sha256(JSON.stringify({ studentId, channel, summary }));
  try {
    const result = await c.env.CRM_DB.batch<Row>([
      c.env.CRM_DB.prepare(`INSERT INTO interactions(id,center_id,student_id,channel,summary,actor_id,actor_name,occurred_at,creation_hash)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)
        .bind(interactionId, centerId(c), studentId, channel, summary, c.var.actor.id, c.var.actor.displayName, now(), hash),
      c.env.CRM_DB.prepare(`SELECT ${columns},creation_hash FROM interactions WHERE id=? AND center_id=? AND student_id=?`).bind(interactionId, centerId(c), studentId),
    ]);
    const row = result[1].results[0];
    if (!row || row.creation_hash !== hash || row.actor_id !== c.var.actor.id) throw new ApiProblem(409, 'INTERACTION_ID_REUSED', 'This request ID has already been used for a different communication entry.');
    const replayed = !result[0].meta.changes;
    return c.json({ interaction: view(row), replayed }, replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof Error && error.message.includes('INTERACTION_FORBIDDEN')) throw new ApiProblem(403, 'FORBIDDEN', 'Your staff access changed. Refresh the workspace before logging communication.');
    throw error;
  }
});
