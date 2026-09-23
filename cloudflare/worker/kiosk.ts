import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv } from './types';
import { clearOperatorCookie, createOperatorSession, deviceView, getDevice, getOperator, kioskAuth, setDeviceCookie, touchOperator } from './auth';
import { ApiProblem, body, centerId, equalSecret, id, now, pinHash, sha256, textValue, token, uuidValue } from './util';
import { getCenter } from './records';

export const kioskRouter = new Hono<AppEnv>();
kioskRouter.get('/status', async c => {
  const center = await getCenter(c); const device = await getDevice(c); if (!device) return c.json({ enrolled: false, center, staff: [] });
  const operator = await getOperator(c, device.id);
  const staff = await c.env.CRM_DB.prepare("SELECT id,display_name AS displayName FROM staff WHERE center_id=? AND active=1 AND kiosk_enabled=1 AND pin_hash IS NOT NULL AND role IN ('owner','manager','front_desk') ORDER BY display_name LIMIT 100").bind(centerId(c)).all();
  return c.json({ enrolled: true, center, device: deviceView(device), ...(operator ? { operator: operator.actor, sessionExpiresAt: operator.expiresAt } : {}), staff: staff.results });
});
kioskRouter.post('/enroll', async c => {
  const input = await body(c); const enrollmentToken = textValue(input.token, 'token', 100); const label = textValue(input.label, 'label', 100); const timestamp = now(); const deviceId = id(); const secret = token(); const secretHash = await sha256(secret); const enrollmentHash = await sha256(enrollmentToken); const expires = new Date(Date.now() + 90 * 86400000).toISOString();
  const result = await c.env.CRM_DB.batch<Record<string, unknown>>([
    c.env.CRM_DB.prepare('INSERT INTO kiosk_devices(id,center_id,enrollment_id,token_hash,label,created_at,expires_at) SELECT ?,center_id,id,?,?,?,? FROM device_enrollments WHERE center_id=? AND token_hash=? AND consumed_at IS NULL AND expires_at>?').bind(deviceId, secretHash, label, timestamp, expires, centerId(c), enrollmentHash, timestamp),
    c.env.CRM_DB.prepare('UPDATE device_enrollments SET consumed_at=? WHERE token_hash=? AND EXISTS(SELECT 1 FROM kiosk_devices WHERE id=?)').bind(timestamp, enrollmentHash, deviceId),
    c.env.CRM_DB.prepare('SELECT id,label,created_at,expires_at,revoked_at FROM kiosk_devices WHERE id=?').bind(deviceId),
  ]);
  const device = result[2].results[0]; if (!device) throw new ApiProblem(401, 'ENROLLMENT_INVALID', 'The enrollment code is invalid, expired, or already used.');
  clearOperatorCookie(c); setDeviceCookie(c, secret); return c.json({ enrolled: true, device: deviceView(device as unknown as Parameters<typeof deviceView>[0]) }, 201);
});
async function reserveAttempt(c: Context<AppEnv>, keys: { key: string; limit: number }[]) {
  const timestamp = now(); const windowStart = new Date(Date.now() - 15 * 60000).toISOString(); const until = new Date(Date.now() + 15 * 60000).toISOString();
  return c.env.CRM_DB.batch<Record<string, unknown>>(keys.map(({ key, limit }) => c.env.CRM_DB.prepare(`INSERT INTO pin_throttles(key,failures,window_start,locked_until) VALUES(?,1,?,NULL) ON CONFLICT(key) DO UPDATE SET failures=CASE WHEN pin_throttles.locked_until>? THEN ? WHEN pin_throttles.window_start<=? THEN 1 ELSE min(pin_throttles.failures+1,?) END,window_start=CASE WHEN pin_throttles.locked_until>? THEN pin_throttles.window_start WHEN pin_throttles.window_start<=? THEN ? ELSE pin_throttles.window_start END,locked_until=CASE WHEN pin_throttles.locked_until>? THEN pin_throttles.locked_until WHEN pin_throttles.window_start<=? THEN NULL WHEN pin_throttles.failures>=? THEN ? ELSE NULL END RETURNING *`).bind(key, timestamp, timestamp, limit + 1, windowStart, limit + 1, timestamp, windowStart, timestamp, timestamp, windowStart, limit - 1, until)));
}
kioskRouter.post('/unlock', async c => {
  const device = await getDevice(c); if (!device) throw new ApiProblem(401, 'DEVICE_REQUIRED', 'Enroll this kiosk first.');
  const input = await body(c); const staffId = uuidValue(input.staffId, 'staffId'); const pin = textValue(input.pin, 'pin', 12);
  const row = await c.env.CRM_DB.prepare("SELECT id,pin_hash,pin_salt,pin_iterations,session_version FROM staff WHERE id=? AND center_id=? AND active=1 AND kiosk_enabled=1 AND role IN ('owner','manager','front_desk')").bind(staffId, centerId(c)).first<{ id: string; pin_hash: string; pin_salt: string; pin_iterations: number; session_version: number }>();
  const keys = [{ key: `${centerId(c)}:device:${device.id}`, limit: 20 }, ...(row ? [{ key: `${centerId(c)}:staff:${staffId}`, limit: 5 }] : [])];
  const reservations = await reserveAttempt(c, keys);
  if (reservations.some((r, i) => Number(r.results[0].failures) > keys[i].limit)) throw new ApiProblem(429, 'PIN_LOCKED', 'Too many PIN attempts. Wait 15 minutes before trying again.');
  if (!row?.pin_hash || !/^\d{8,12}$/.test(pin) || !equalSecret(await pinHash(pin, row.pin_salt, row.pin_iterations), row.pin_hash)) throw new ApiProblem(401, 'PIN_INVALID', 'The staff identity or PIN is incorrect.');
  const sessionExpiresAt = await createOperatorSession(c, device.id, row.id, row.session_version);
  await c.env.CRM_DB.batch<Record<string, unknown>>(keys.map((key, i) => c.env.CRM_DB.prepare('DELETE FROM pin_throttles WHERE key=? AND failures=? AND window_start=?').bind(key.key, reservations[i].results[0].failures, reservations[i].results[0].window_start)));
  const staff = await c.env.CRM_DB.prepare('SELECT id,email,display_name AS displayName,role FROM staff WHERE id=?').bind(row.id).first();
  return c.json({ operator: { ...staff, channel: 'kiosk', deviceId: device.id }, sessionExpiresAt });
});
kioskRouter.post('/lock', async c => { const device = await getDevice(c); if (device) await c.env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE device_id=?').bind(device.id).run(); clearOperatorCookie(c); return c.json({ ok: true }); });
kioskRouter.post('/touch', kioskAuth, async c => c.json({ sessionExpiresAt: await touchOperator(c) }));
