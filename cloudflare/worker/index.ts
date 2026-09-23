import { Hono } from 'hono';
import type { AppEnv, Env } from './types';
import { adminAuth, kioskAuth } from './auth';
import { adminRouter } from './admin';
import { kioskRouter } from './kiosk';
import { createRecordsRouter, createHistoryRouter } from './records';
import { createAttendanceRouter } from './attendance';
import { ApiProblem } from './util';
import { backupRouter, backupScheduled, backupQueue } from './backup';
import { importRouter, cleanExpiredImports } from './import';
import { archiveRouter, archiveScheduled, archiveQueue } from './archive';
import { schedulesRouter } from './schedules';
import { inquiriesRouter } from './inquiries';
import { archiveReaderRouter } from './archive-reader';
import { interactionsRouter } from './interactions';
import { reportSummaryRouter } from './report-summary';
import { frontdeskRouter } from './frontdesk';
import { directoryRouter } from './directory';
import { auditReaderRouter } from './audit-reader';
import { createObservationCorrectionsRouter } from './observation-corrections';

export const app = new Hono<AppEnv>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
  if (!['GET','HEAD','OPTIONS'].includes(c.req.method)) { const origin = c.req.header('origin'); if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('sec-fetch-site') === 'cross-site') throw new ApiProblem(403, 'ORIGIN_REJECTED', 'This request must come from the center application.'); }
  await next();
});
app.get('/api/health', c => c.json({ ok: true, version: c.env.APP_VERSION || '0.1.0' }));
app.use('/api/admin/*', adminAuth);
app.route('/api/admin', adminRouter);
app.route('/api/admin', createRecordsRouter());
app.route('/api/admin', createAttendanceRouter());
app.route('/api/admin', createObservationCorrectionsRouter());
app.route('/api/admin', createHistoryRouter());
app.route('/api/admin/backups', backupRouter);
app.route('/api/admin/imports', importRouter);
app.route('/api/admin/archives', archiveRouter);
app.route('/api/admin', schedulesRouter);
app.route('/api/admin', inquiriesRouter);
app.route('/api/admin/archive-history', archiveReaderRouter);
app.route('/api/admin', interactionsRouter);
app.route('/api/admin', reportSummaryRouter);
app.route('/api/admin', frontdeskRouter);
app.route('/api/admin', directoryRouter);
app.route('/api/admin', auditReaderRouter);
app.route('/api/kiosk', kioskRouter);
app.use('/api/kiosk/*', kioskAuth);
app.route('/api/kiosk', createRecordsRouter());
app.route('/api/kiosk', createAttendanceRouter());
app.notFound(c => c.req.path.startsWith('/api/') ? c.json({ error: { code: 'NOT_FOUND', message: 'API route was not found.' } }, 404) : c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Build the frontend assets first.', 404));
const conflictMessages: Record<string, string> = {
  OBSERVATION_CORRECTION_ID_REUSED: 'This observation correction reference is already in use.',
  IMMUTABLE_HISTORY_SOURCE: 'This request reference is already reserved by immutable history.',
  OBSERVATION_ARCHIVE_UNSUPPORTED: 'This observation is part of archive evidence and cannot be corrected with this release.',
  OBSERVATION_PROJECTION_MISMATCH: 'The observation correction state does not match its immutable evidence.',
  IMMUTABLE_OBSERVATION_CORRECTION: 'Observation corrections cannot be edited or deleted.',
  IMMUTABLE_OBSERVATION_PROJECTION: 'Observation correction state cannot be deleted.',
  STALE_OBSERVATION: 'This observation changed. Refresh it before submitting a correction.',
  ARCHIVE_SOURCE_BUSY: 'This historical record is being archived. Retry after the archive finishes, or cancel it from archive settings.',
  AUDIT_ID_CONFLICT: 'This observation or correction ID is already used by another audit record.',
  LAST_OWNER: 'Keep at least one active owner on the staff allowlist.', ALREADY_PRESENT: 'This student already has an open visit.', NOT_PRESENT: 'This student has no open visit.', STUDENT_INACTIVE: 'Inactive students cannot check in. Existing visits may still be checked out.', PICKUP_UNVERIFIED: 'Pickup authority is missing, unverified, or denied. Verify it before checkout.', PICKUP_ALERT: 'Resolve the pickup alert before normal checkout, or record an exceptional departure.', REASON_REQUIRED: 'A meaningful departure reason is required.', DEPARTURE_BEFORE_ARRIVAL: 'Departure cannot be before arrival.', OVERLAPPING_VISIT: 'This would overlap another visit for the student.', STALE_VISIT: 'The visit changed. Refresh it before submitting a correction.', FUTURE_CORRECTION: 'Corrected attendance cannot be in the future.', IMMUTABLE_ATTENDANCE: 'Attendance observations cannot be edited or deleted.', IMMUTABLE_CORRECTION: 'Attendance corrections cannot be edited or deleted.', IMMUTABLE_AUDIT: 'Audit entries cannot be edited or deleted.',
};
app.onError((error, c) => {
  if (error instanceof ApiProblem) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  const message = error.message;
  if (message.includes('backup_maintenance')) return c.json({ error: { code: 'BACKUP_MAINTENANCE', message: 'A backup is briefly preserving the database. Retry this request with the same event ID.' } }, 503);
  for (const [code, text] of Object.entries(conflictMessages)) if (message.includes(code)) return c.json({ error: { code, message: text } }, 409);
  if (message.includes('STUDENT_NOT_FOUND')) return c.json({ error: { code: 'STUDENT_NOT_FOUND', message: 'Student was not found.' } }, 404);
  if (message.includes('UNIQUE constraint')) return c.json({ error: { code: 'DUPLICATE_RECORD', message: 'A record with this identifier already exists.' } }, 409);
  console.error('Request failed', { name: error.name, route: c.req.path });
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed. No success has been confirmed.' } }, 500);
});
export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await cleanExpiredImports(env);
    await backupScheduled(controller, env);
    await archiveScheduled(env);
  },
  async queue(batch, env) {
    const archives = batch.messages.filter(message => (message.body as { type?: string }).type === 'archive');
    const backups = batch.messages.filter(message => (message.body as { type?: string }).type !== 'archive');
    if (backups.length) await backupQueue({ ...batch, messages: backups } as MessageBatch<{jobId:string}>, env);
    if (archives.length) await archiveQueue({ ...batch, messages: archives } as MessageBatch<{type:'archive';jobId:string}>, env);
  }
} satisfies ExportedHandler<Env>;
