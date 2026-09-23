import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { Role, Staff } from '../shared/types';
import { ApiProblem, audit, base64, body, centerId, id, now, pinHash, requireRole, sha256, staffRoles, textValue, token } from './util';
import { deviceView } from './auth';
import { getCenter } from './records';

function staffView(row: Record<string, unknown>): Staff { return { id: String(row.id), email: String(row.email), displayName: String(row.display_name), role: row.role as Role, active: !!row.active, kioskEnabled: !!row.kiosk_enabled, hasPin: !!row.pin_hash }; }
export const adminRouter = new Hono<AppEnv>();
adminRouter.get('/session', async c => c.json({ center: await getCenter(c), actor: c.var.actor }));
adminRouter.patch('/center', async c => {
  requireRole(c, ['owner']); const input = await body(c); const existing = await getCenter(c); const name = input.name === undefined ? existing.name : textValue(input.name, 'name', 150); const timezone = input.timezone === undefined ? existing.timezone : textValue(input.timezone, 'timezone', 100);
  const location = input.location === undefined ? existing.location : textValue(input.location, 'location', 300, false);
  const operatingHours = input.operatingHours === undefined ? existing.operatingHours : textValue(input.operatingHours, 'operatingHours', 500, false);
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { throw new ApiProblem(400, 'INVALID_TIMEZONE', 'Choose a valid IANA time zone.'); }
  await c.env.CRM_DB.batch<Record<string, unknown>>([c.env.CRM_DB.prepare('UPDATE centers SET name=?,timezone=?,location=?,operating_hours=? WHERE id=?').bind(name, timezone, location, operatingHours, centerId(c)), audit(c, 'center_updated', 'center', centerId(c), { name, timezone, location, operatingHours })]); return c.json({ center: { id: centerId(c), name, timezone, location, operatingHours } });
});
adminRouter.get('/staff', async c => { requireRole(c, ['owner']); const rows = await c.env.CRM_DB.prepare('SELECT * FROM staff WHERE center_id=? ORDER BY display_name LIMIT 101').bind(centerId(c)).all(); return c.json({ items: rows.results.slice(0, 100).map(staffView), truncated: rows.results.length > 100 }); });
async function staffInput(input: Record<string, unknown>, existing?: Record<string, unknown>) {
  const email = textValue(input.email ?? existing?.email, 'email', 200).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiProblem(400, 'INVALID_EMAIL', 'Provide a valid staff email.');
  const displayName = textValue(input.displayName ?? existing?.display_name, 'displayName', 150); const role = input.role ?? existing?.role;
  if (!staffRoles.includes(role as Role)) throw new ApiProblem(400, 'INVALID_ROLE', 'Choose owner, manager, front_desk, or instructor.');
  for (const key of ['active', 'kioskEnabled']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiProblem(400, 'INVALID_INPUT', `${key} must be true or false.`);
  const active = input.active ?? (existing ? !!existing.active : true); const kioskEnabled = input.kioskEnabled ?? (existing ? !!existing.kiosk_enabled : false);
  if (kioskEnabled && role === 'instructor') throw new ApiProblem(400, 'INVALID_ROLE', 'Instructors have roster access; choose a front desk role for kiosk operation.');
  let hash = existing?.pin_hash || null; let salt = existing?.pin_salt || null; let iterations = existing?.pin_iterations || null;
  if (input.pin !== undefined) { if (typeof input.pin !== 'string' || !/^\d{8,12}$/.test(input.pin)) throw new ApiProblem(400, 'INVALID_PIN', 'Use a staff PIN of 8–12 digits.'); salt = base64(crypto.getRandomValues(new Uint8Array(16))); iterations = 600000; hash = await pinHash(input.pin, String(salt), Number(iterations)); }
  if (kioskEnabled && !hash) throw new ApiProblem(400, 'PIN_REQUIRED', 'Set an individual staff PIN before enabling kiosk access.');
  return { email, displayName, role: role as Role, active: active ? 1 : 0, kioskEnabled: kioskEnabled ? 1 : 0, hash, salt, iterations };
}
adminRouter.post('/staff', async c => {
  requireRole(c, ['owner']); const input = await staffInput(await body(c)); const staffId = id(); const timestamp = now();
  await c.env.CRM_DB.batch<Record<string, unknown>>([c.env.CRM_DB.prepare('INSERT INTO staff(id,center_id,email,display_name,role,active,kiosk_enabled,pin_hash,pin_salt,pin_iterations,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(staffId, centerId(c), input.email, input.displayName, input.role, input.active, input.kioskEnabled, input.hash, input.salt, input.iterations, timestamp, timestamp), audit(c, 'staff_created', 'staff', staffId, { email: input.email, role: input.role, kioskEnabled: !!input.kioskEnabled })]);
  return c.json({ staff: { id: staffId, email: input.email, displayName: input.displayName, role: input.role, active: !!input.active, kioskEnabled: !!input.kioskEnabled, hasPin: !!input.hash } }, 201);
});
adminRouter.patch('/staff/:id', async c => {
  requireRole(c, ['owner']); const existing = await c.env.CRM_DB.prepare('SELECT * FROM staff WHERE id=? AND center_id=?').bind(c.req.param('id'), centerId(c)).first(); if (!existing) throw new ApiProblem(404, 'STAFF_NOT_FOUND', 'Staff member was not found.');
  const input = await staffInput(await body(c), existing);
  await c.env.CRM_DB.batch<Record<string, unknown>>([c.env.CRM_DB.prepare('UPDATE staff SET email=?,display_name=?,role=?,active=?,kiosk_enabled=?,pin_hash=?,pin_salt=?,pin_iterations=?,session_version=session_version+1,updated_at=? WHERE id=? AND center_id=?').bind(input.email, input.displayName, input.role, input.active, input.kioskEnabled, input.hash, input.salt, input.iterations, now(), existing.id, centerId(c)), c.env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE staff_id=?').bind(existing.id), audit(c, 'staff_updated', 'staff', String(existing.id), { role: input.role, active: !!input.active, kioskEnabled: !!input.kioskEnabled, sessionsRevoked: true })]);
  return c.json({ staff: { id: existing.id, email: input.email, displayName: input.displayName, role: input.role, active: !!input.active, kioskEnabled: !!input.kioskEnabled, hasPin: !!input.hash } });
});
adminRouter.get('/devices', async c => { requireRole(c, ['owner']); const result = await c.env.CRM_DB.prepare('SELECT id,label,created_at,expires_at,revoked_at FROM kiosk_devices WHERE center_id=? ORDER BY created_at DESC LIMIT 101').bind(centerId(c)).all<{ id: string; label: string; created_at: string; expires_at: string; revoked_at: string | null }>(); return c.json({ items: result.results.slice(0, 100).map(deviceView), truncated: result.results.length > 100 }); });
adminRouter.post('/devices/enrollment', async c => { requireRole(c, ['owner']); const secret = token(); const enrollmentId = id(); const expiresAt = new Date(Date.now() + 10 * 60000).toISOString(); await c.env.CRM_DB.batch<Record<string, unknown>>([c.env.CRM_DB.prepare('INSERT INTO device_enrollments(id,center_id,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?)').bind(enrollmentId, centerId(c), await sha256(secret), expiresAt, c.var.actor.id, now()), audit(c, 'kiosk_enrollment_created', 'device_enrollment', enrollmentId)]); return c.json({ token: secret, expiresAt }, 201); });
adminRouter.post('/devices/:id/revoke', async c => { requireRole(c, ['owner']); const existing = await c.env.CRM_DB.prepare('SELECT id FROM kiosk_devices WHERE center_id=? AND id=?').bind(centerId(c), c.req.param('id')).first(); if (!existing) throw new ApiProblem(404, 'DEVICE_NOT_FOUND', 'Kiosk device was not found.'); await c.env.CRM_DB.batch<Record<string, unknown>>([c.env.CRM_DB.prepare('UPDATE kiosk_devices SET revoked_at=? WHERE id=?').bind(now(), existing.id), c.env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE device_id=?').bind(existing.id), audit(c, 'kiosk_revoked', 'kiosk_device', String(existing.id))]); return c.json({ ok: true }); });
