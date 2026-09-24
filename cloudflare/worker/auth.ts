import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Actor, Device, Role } from '../shared/types';
import type { AppEnv } from './types';
import { ApiProblem, now, sha256, token, type Ctx } from './util';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const DEVICE_COOKIE = 'presently_kiosk_device';
const SESSION_COOKIE = 'presently_kiosk_operator';
export const KIOSK_SESSION_MINUTES = 15;

type StaffRow = { id: number; email: string | null; display_name: string; role: Role; active: number; session_version: number };
export type DeviceRow = { id: number; location_id: number; label: string; created_at: string; expires_at: string; revoked_at: string | null };

function actorOf(row: StaffRow, channel: 'admin' | 'kiosk', deviceId?: number): Actor {
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, channel, ...(deviceId ? { deviceId } : {}) };
}

/** Locations a staff member can reach: every active location for owners, assigned active locations otherwise. */
export async function reachableLocations(c: Ctx, staffId: number, role: Role) {
  const sql = role === 'owner'
    ? 'SELECT id FROM locations WHERE active = 1 ORDER BY name, id'
    : 'SELECT l.id FROM staff_locations sl JOIN locations l ON l.id = sl.location_id WHERE sl.staff_id = ? AND l.active = 1 ORDER BY l.name, l.id';
  const statement = c.env.CRM_DB.prepare(sql);
  const rows = await (role === 'owner' ? statement : statement.bind(staffId)).all<{ id: number }>();
  return rows.results.map(row => row.id);
}

async function verifiedAccessEmail(c: Ctx) {
  const issuer = c.env.ACCESS_ISSUER?.replace(/\/$/, '');
  const audience = c.env.ACCESS_AUD;
  if (!issuer || !audience) throw new ApiProblem(503, 'ACCESS_NOT_CONFIGURED', 'Cloudflare Access is not configured.');
  const hostname = new URL(c.req.url).hostname;
  const local = c.env.APP_ENV === 'local' && c.env.LOCAL_ACCESS_TEST_MODE === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const jwt = c.req.header('cf-access-jwt-assertion');
  if (!jwt) throw new ApiProblem(401, 'ACCESS_REQUIRED', 'Sign in through Cloudflare Access.');
  try {
    const issuerUrl = new URL(issuer);
    const validIssuer = issuerUrl.protocol === 'https:' && /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuerUrl.hostname)
      && issuerUrl.pathname === '/' && !issuerUrl.port && !issuerUrl.username && !issuerUrl.password && !issuerUrl.search && !issuerUrl.hash;
    if (!local && !validIssuer) throw new Error('Invalid issuer');
    let keyset;
    if (local && c.env.LOCAL_ACCESS_JWKS) {
      const keys = JSON.parse(c.env.LOCAL_ACCESS_JWKS) as JSONWebKeySet;
      if (keys.keys.some(key => 'd' in key || 'k' in key)) throw new Error('Public asymmetric test keys only');
      keyset = createLocalJWKSet(keys);
    } else {
      keyset = jwksCache.get(issuer);
      if (!keyset) { keyset = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)); jwksCache.set(issuer, keyset); }
    }
    const verified = await jwtVerify(jwt, keyset, { issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'email'] });
    if (typeof verified.payload.email !== 'string' || verified.payload.email_verified === false) throw new Error('Missing verified identity');
    return verified.payload.email.trim().toLowerCase();
  } catch {
    throw new ApiProblem(401, 'ACCESS_INVALID', 'Cloudflare Access identity could not be verified.');
  }
}

/** First sign-in by the configured owner creates the business, its first location and the owner account. */
async function bootstrapOwner(c: Ctx, email: string) {
  if (email !== c.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase()) return;
  const db = c.env.CRM_DB;
  const timestamp = now();
  await db.batch([
    db.prepare("INSERT INTO business (id, name, timezone, created_at) SELECT 1, 'My business', 'America/Los_Angeles', ? WHERE NOT EXISTS (SELECT 1 FROM business)").bind(timestamp),
    db.prepare("INSERT INTO locations (name, timezone, created_at) SELECT 'My center', 'America/Los_Angeles', ? WHERE NOT EXISTS (SELECT 1 FROM locations)").bind(timestamp),
    db.prepare("INSERT INTO staff (email, display_name, role, active, created_at, updated_at) SELECT ?, ?, 'owner', 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM staff)")
      .bind(email, email.split('@')[0], timestamp, timestamp),
  ]);
}

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const email = await verifiedAccessEmail(c);
  const select = c.env.CRM_DB.prepare('SELECT id, email, display_name, role, active, session_version FROM staff WHERE email = ? COLLATE NOCASE AND active = 1').bind(email);
  let row = await select.first<StaffRow>();
  if (!row) { await bootstrapOwner(c, email); row = await select.first<StaffRow>(); }
  if (!row) throw new ApiProblem(403, 'STAFF_NOT_ALLOWED', 'This identity is not an active staff member of this business.');
  c.set('actor', actorOf(row, 'admin'));
  c.set('locationIds', await reachableLocations(c, row.id, row.role));
  await next();
});

/**
 * Location-scoped admin routes name their location in the X-Location-Id header.
 * Kiosk requests always use the location the device was enrolled to.
 */
export const withLocation = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.actor.channel === 'kiosk') { await next(); return; }
  const header = c.req.header('x-location-id');
  const id = header && /^\d{1,15}$/.test(header) ? Number(header) : NaN;
  if (!Number.isSafeInteger(id)) throw new ApiProblem(400, 'LOCATION_REQUIRED', 'Choose a location first.');
  if (!c.var.locationIds.includes(id)) throw new ApiProblem(403, 'LOCATION_FORBIDDEN', 'You do not have access to this location.');
  c.set('locationId', id);
  await next();
});

function cookieOptions(c: Ctx, maxAge: number) {
  return { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:' || c.env.APP_ENV !== 'local', sameSite: 'Strict' as const, path: '/api/kiosk', maxAge };
}
export function setDeviceCookie(c: Ctx, value: string) { setCookie(c, DEVICE_COOKIE, value, cookieOptions(c, 90 * 86400)); }
export function clearOperatorCookie(c: Ctx) { deleteCookie(c, SESSION_COOKIE, { path: '/api/kiosk' }); }

export async function getDevice(c: Ctx) {
  const secret = getCookie(c, DEVICE_COOKIE);
  if (!secret) return null;
  return c.env.CRM_DB.prepare(
    `SELECT d.id, d.location_id, d.label, d.created_at, d.expires_at, d.revoked_at FROM kiosk_devices d
     JOIN locations l ON l.id = d.location_id
     WHERE d.token_hash = ? AND d.revoked_at IS NULL AND d.expires_at > ? AND l.active = 1`,
  ).bind(await sha256(secret), now()).first<DeviceRow>();
}
export function deviceView(row: DeviceRow): Device {
  return { id: row.id, locationId: row.location_id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at };
}

/** A kiosk operator must be active, PIN-enabled, allowed to record attendance, and assigned to the device's location. */
export async function getOperator(c: Ctx, device: DeviceRow) {
  const secret = getCookie(c, SESSION_COOKIE);
  if (!secret) return null;
  const row = await c.env.CRM_DB.prepare(
    `SELECT s.id, s.email, s.display_name, s.role, s.active, s.session_version, k.id AS session_id, k.expires_at
     FROM kiosk_sessions k JOIN staff s ON s.id = k.staff_id
     WHERE k.device_id = ? AND k.token_hash = ? AND k.expires_at > ? AND s.active = 1 AND s.kiosk_enabled = 1
       AND s.role IN ('owner', 'manager', 'front_desk') AND s.session_version = k.staff_version
       AND (s.role = 'owner' OR EXISTS (SELECT 1 FROM staff_locations sl WHERE sl.staff_id = s.id AND sl.location_id = ?))`,
  ).bind(device.id, await sha256(secret), now(), device.location_id).first<StaffRow & { session_id: number; expires_at: string }>();
  return row ? { actor: actorOf(row, 'kiosk', device.id), sessionId: row.session_id, expiresAt: row.expires_at } : null;
}

export const kioskAuth = createMiddleware<AppEnv>(async (c, next) => {
  const device = await getDevice(c);
  if (!device) throw new ApiProblem(401, 'DEVICE_REQUIRED', 'Enroll this kiosk with an owner’s enrollment code.');
  const operator = await getOperator(c, device);
  if (!operator) throw new ApiProblem(401, 'PIN_REQUIRED', 'Unlock the kiosk with your staff PIN.');
  c.set('actor', operator.actor);
  c.set('deviceId', device.id);
  c.set('sessionId', operator.sessionId);
  c.set('locationId', device.location_id);
  c.set('locationIds', [device.location_id]);
  await next();
});

export async function createOperatorSession(c: Ctx, deviceId: number, staffId: number, version: number) {
  const secret = token();
  const timestamp = now();
  const expires = new Date(Date.now() + KIOSK_SESSION_MINUTES * 60000).toISOString();
  await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE device_id = ? OR expires_at < ?').bind(deviceId, timestamp),
    c.env.CRM_DB.prepare('INSERT INTO kiosk_sessions (device_id, staff_id, token_hash, staff_version, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(deviceId, staffId, await sha256(secret), version, timestamp, expires),
  ]);
  setCookie(c, SESSION_COOKIE, secret, cookieOptions(c, KIOSK_SESSION_MINUTES * 60));
  return expires;
}

export async function touchOperator(c: Ctx) {
  const expires = new Date(Date.now() + KIOSK_SESSION_MINUTES * 60000).toISOString();
  await c.env.CRM_DB.prepare('UPDATE kiosk_sessions SET expires_at = ? WHERE id = ? AND expires_at > ?').bind(expires, c.var.sessionId, now()).run();
  const secret = getCookie(c, SESSION_COOKIE);
  if (secret) setCookie(c, SESSION_COOKIE, secret, cookieOptions(c, KIOSK_SESSION_MINUTES * 60));
  return expires;
}
