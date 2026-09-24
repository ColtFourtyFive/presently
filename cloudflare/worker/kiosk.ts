import { Hono } from 'hono';
import type { AppEnv } from './types';
import { clearOperatorCookie, createOperatorSession, deviceView, getDevice, getOperator, kioskAuth, setDeviceCookie, touchOperator, type DeviceRow } from './auth';
import { ApiProblem, body, equalSecret, idValue, now, pinHash, sha256, textValue, token, type Ctx } from './util';
import { getLocation } from './admin';

const PIN_WINDOW_MINUTES = 15;
const DEVICE_ATTEMPTS = 20;
const STAFF_ATTEMPTS = 5;

/** Staff who may unlock this kiosk: PIN-enabled attendance staff assigned to its location. */
function kioskStaff(c: Ctx, locationId: number) {
  return c.env.CRM_DB.prepare(
    `SELECT id, display_name AS displayName FROM staff s
     WHERE active = 1 AND kiosk_enabled = 1 AND pin_hash IS NOT NULL AND role IN ('owner', 'manager', 'front_desk')
       AND (role = 'owner' OR EXISTS (SELECT 1 FROM staff_locations sl WHERE sl.staff_id = s.id AND sl.location_id = ?))
     ORDER BY display_name LIMIT 100`,
  ).bind(locationId).all<{ id: number; displayName: string }>();
}

/** Reserve one attempt for each throttle key. Failures beyond the limit lock the key for the window. */
async function reserveAttempt(c: Ctx, keys: { key: string; limit: number }[]) {
  const timestamp = now();
  const windowStart = new Date(Date.now() - PIN_WINDOW_MINUTES * 60000).toISOString();
  const until = new Date(Date.now() + PIN_WINDOW_MINUTES * 60000).toISOString();
  // ?1 now, ?2 window start, ?3 locked failure count, ?4 last allowed count, ?5 lock expiry, ?6 key.
  return c.env.CRM_DB.batch<{ failures: number; window_start: string }>(keys.map(({ key, limit }) => c.env.CRM_DB.prepare(
    `INSERT INTO pin_throttles (key, failures, window_start, locked_until) VALUES (?6, 1, ?1, NULL)
     ON CONFLICT (key) DO UPDATE SET
       failures = CASE WHEN locked_until > ?1 THEN ?3 WHEN window_start <= ?2 THEN 1 ELSE min(failures + 1, ?3) END,
       window_start = CASE WHEN locked_until > ?1 THEN window_start WHEN window_start <= ?2 THEN ?1 ELSE window_start END,
       locked_until = CASE WHEN locked_until > ?1 THEN locked_until WHEN window_start <= ?2 THEN NULL WHEN failures >= ?4 THEN ?5 ELSE NULL END
     RETURNING failures, window_start`,
  ).bind(timestamp, windowStart, limit + 1, limit - 1, until, key)));
}

export const kioskRouter = new Hono<AppEnv>();

kioskRouter.get('/status', async c => {
  const device = await getDevice(c);
  if (!device) return c.json({ enrolled: false, location: null, staff: [] });
  const [location, operator, staff] = await Promise.all([getLocation(c, device.location_id), getOperator(c, device), kioskStaff(c, device.location_id)]);
  return c.json({
    enrolled: true, location, device: deviceView(device), staff: staff.results,
    ...(operator ? { operator: operator.actor, sessionExpiresAt: operator.expiresAt } : {}),
  });
});

kioskRouter.post('/enroll', async c => {
  const input = await body(c);
  const enrollmentToken = textValue(input.token, 'token', 100);
  const label = textValue(input.label, 'label', 100);
  const timestamp = now();
  const secret = token();
  const enrollmentHash = await sha256(enrollmentToken);
  const expires = new Date(Date.now() + 90 * 86400000).toISOString();
  const db = c.env.CRM_DB;
  // Consume the enrollment and create the device atomically; a used or expired code creates nothing.
  const result = await db.batch<DeviceRow>([
    db.prepare('UPDATE device_enrollments SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?').bind(timestamp, enrollmentHash, timestamp),
    db.prepare(
      `INSERT INTO kiosk_devices (location_id, enrollment_id, token_hash, label, created_at, expires_at)
       SELECT location_id, id, ?, ?, ?, ? FROM device_enrollments WHERE token_hash = ? AND consumed_at = ? AND changes() = 1
       RETURNING id, location_id, label, created_at, expires_at, revoked_at`,
    ).bind(await sha256(secret), label, timestamp, expires, enrollmentHash, timestamp),
  ]);
  const device = result[1].results[0];
  if (!device) throw new ApiProblem(401, 'ENROLLMENT_INVALID', 'The enrollment code is invalid, expired, or already used.');
  clearOperatorCookie(c);
  setDeviceCookie(c, secret);
  return c.json({ enrolled: true, device: deviceView(device) }, 201);
});

kioskRouter.post('/unlock', async c => {
  const device = await getDevice(c);
  if (!device) throw new ApiProblem(401, 'DEVICE_REQUIRED', 'Enroll this kiosk first.');
  const input = await body(c);
  const staffId = idValue(input.staffId, 'staffId');
  const pin = textValue(input.pin, 'pin', 12);
  const row = await c.env.CRM_DB.prepare(
    `SELECT id, pin_hash, session_version FROM staff s
     WHERE id = ? AND active = 1 AND kiosk_enabled = 1 AND role IN ('owner', 'manager', 'front_desk')
       AND (role = 'owner' OR EXISTS (SELECT 1 FROM staff_locations sl WHERE sl.staff_id = s.id AND sl.location_id = ?))`,
  ).bind(staffId, device.location_id).first<{ id: number; pin_hash: string | null; session_version: number }>();
  const keys = [{ key: `device:${device.id}`, limit: DEVICE_ATTEMPTS }, ...(row ? [{ key: `staff:${staffId}`, limit: STAFF_ATTEMPTS }] : [])];
  const reservations = await reserveAttempt(c, keys);
  if (reservations.some((result, i) => Number(result.results[0].failures) > keys[i].limit))
    throw new ApiProblem(429, 'PIN_LOCKED', `Too many PIN attempts. Wait ${PIN_WINDOW_MINUTES} minutes before trying again.`);
  const valid = !!row?.pin_hash && /^\d{8,12}$/.test(pin) && equalSecret(await pinHash(c.env, staffId, pin), row.pin_hash);
  if (!valid || !row) throw new ApiProblem(401, 'PIN_INVALID', 'The staff identity or PIN is incorrect.');
  const sessionExpiresAt = await createOperatorSession(c, device.id, row.id, row.session_version);
  await c.env.CRM_DB.batch(keys.map((key, i) => c.env.CRM_DB.prepare('DELETE FROM pin_throttles WHERE key = ? AND failures = ? AND window_start = ?')
    .bind(key.key, reservations[i].results[0].failures, reservations[i].results[0].window_start)));
  const operator = await getOperator(c, device);
  const staff = await c.env.CRM_DB.prepare('SELECT id, email, display_name AS displayName, role FROM staff WHERE id = ?').bind(row.id).first();
  return c.json({ operator: operator?.actor ?? { ...staff, channel: 'kiosk', deviceId: device.id }, sessionExpiresAt });
});

kioskRouter.post('/lock', async c => {
  const device = await getDevice(c);
  if (device) await c.env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE device_id = ?').bind(device.id).run();
  clearOperatorCookie(c);
  return c.json({ ok: true });
});

kioskRouter.post('/touch', kioskAuth, async c => c.json({ sessionExpiresAt: await touchOperator(c) }));
