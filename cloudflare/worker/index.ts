import { Hono } from 'hono';
import type { AppEnv, BackupMessage, Env } from './types';
import { adminAuth, kioskAuth, withLocation } from './auth';
import { adminRouter } from './admin';
import { kioskRouter } from './kiosk';
import { createRecordsRouter } from './records';
import { createAttendanceRouter } from './attendance';
import { reportsRouter } from './reports';
import { auditReaderRouter } from './audit-reader';
import { importRouter, cleanExpiredImports } from './import';
import { backupQueue, backupRouter, backupScheduled } from './backup';
import { ApiProblem, now } from './util';

export const app = new Hono<AppEnv>();

app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('origin');
    if ((origin && origin !== new URL(c.req.url).origin) || c.req.header('sec-fetch-site') === 'cross-site')
      throw new ApiProblem(403, 'ORIGIN_REJECTED', 'This request must come from the Presently application.');
  }
  await next();
});
app.get('/api/health', c => c.json({ ok: true, version: c.env.APP_VERSION || '0.0.0' }));

// Back office: Cloudflare Access identity, then an explicit location for location-scoped routes.
app.use('/api/admin/*', adminAuth);
const locationScoped = [
  '/students', '/students/*', '/roster', '/attendance', '/attendance/*', '/visits/*', '/history', '/reviews', '/reviews/*',
  '/reports/*', '/evidence', '/attestations', '/audit', '/imports', '/imports/*',
];
for (const path of locationScoped) app.use(`/api/admin${path}`, withLocation);
app.route('/api/admin', adminRouter);
app.route('/api/admin/backups', backupRouter);
app.route('/api/admin/imports', importRouter);
app.route('/api/admin', createRecordsRouter());
app.route('/api/admin', createAttendanceRouter());
app.route('/api/admin', reportsRouter);
app.route('/api/admin', auditReaderRouter);

// Shared front-desk kiosk: enrolled device plus an unlocked staff PIN session, bound to the device's location.
app.route('/api/kiosk', kioskRouter);
app.use('/api/kiosk/*', kioskAuth);
app.route('/api/kiosk', createRecordsRouter());
app.route('/api/kiosk', createAttendanceRouter());

app.notFound(c => c.req.path.startsWith('/api/')
  ? c.json({ error: { code: 'NOT_FOUND', message: 'API route was not found.' } }, 404)
  : c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text('Build the frontend assets first.', 404));

const conflictMessages: Record<string, string> = {
  LAST_OWNER: 'Keep at least one active owner.',
  STAFF_DELETE_FORBIDDEN: 'Deactivate staff instead of deleting them.',
  ALREADY_PRESENT: 'This student is already checked in.',
  NOT_PRESENT: 'This student is not checked in.',
  VISIT_MISMATCH: 'The student’s visit changed. Refresh and try again.',
  STUDENT_INACTIVE: 'Inactive students cannot check in. An existing visit can still be checked out.',
  PICKUP_UNVERIFIED: 'Choose a guardian whose pickup authority has been verified.',
  PICKUP_ALERT: 'This student has a pickup alert. Resolve it before a normal checkout, or record an exceptional departure.',
  REASON_REQUIRED: 'A meaningful departure reason is required.',
  DEPARTURE_BEFORE_ARRIVAL: 'Departure cannot be before arrival.',
  OVERLAPPING_VISIT: 'This would overlap another visit for the student.',
  STALE_VISIT: 'The visit changed. Refresh it before submitting a correction.',
  FUTURE_CORRECTION: 'Corrected attendance cannot be in the future.',
  IMMUTABLE_ATTENDANCE: 'Attendance records cannot be edited or deleted. Use a correction.',
  IMMUTABLE_CORRECTION: 'Attendance corrections cannot be edited or deleted.',
  IMMUTABLE_AUDIT: 'Audit entries cannot be edited or deleted.',
  IMMUTABLE_ATTESTATION: 'Attestations cannot be edited or deleted. Record a new one.',
};

app.onError((error, c) => {
  if (error instanceof ApiProblem) return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
  const message = error.message;
  for (const [code, text] of Object.entries(conflictMessages)) if (message.includes(code)) return c.json({ error: { code, message: text } }, 409);
  if (message.includes('STUDENT_NOT_FOUND')) return c.json({ error: { code: 'STUDENT_NOT_FOUND', message: 'Student was not found.' } }, 404);
  if (message.includes('UNIQUE constraint')) return c.json({ error: { code: 'DUPLICATE_RECORD', message: 'A record with this identifier already exists.' } }, 409);
  if (message.includes('FOREIGN KEY constraint')) return c.json({ error: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist.' } }, 400);
  console.error('Request failed', { name: error.name, route: c.req.path });
  return c.json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed. Nothing has been confirmed as saved.' } }, 500);
});

/** Housekeeping that must not stop the backup schedule if it fails. */
async function housekeeping(env: Env) {
  const at = now();
  await env.CRM_DB.batch([
    env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE expires_at < ?').bind(at),
    env.CRM_DB.prepare('DELETE FROM pin_throttles WHERE window_start < ? AND (locked_until IS NULL OR locked_until < ?)').bind(new Date(Date.now() - 86400000).toISOString(), at),
  ]);
}

export default {
  fetch: app.fetch,
  async scheduled(controller: ScheduledController, env: Env) {
    const tasks: [string, () => Promise<unknown>][] = [
      ['imports', () => cleanExpiredImports(env)],
      ['housekeeping', () => housekeeping(env)],
      ['backup', () => backupScheduled(env, new Date(controller.scheduledTime))],
    ];
    for (const [name, task] of tasks) {
      try { await task(); } catch (error) { console.error('Scheduled task failed', { task: name, error: error instanceof Error ? error.message : 'unknown' }); }
    }
  },
  queue: (batch: MessageBatch<BackupMessage>, env: Env) => backupQueue(batch, env),
} satisfies ExportedHandler<Env, BackupMessage>;
