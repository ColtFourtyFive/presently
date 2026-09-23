import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from 'jose';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { Actor, Device, Role } from '../shared/types';
import type { AppEnv } from './types';
import { ApiProblem, centerId, id, now, sha256, token } from './util';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const DEVICE_COOKIE = 'crm_kiosk_device';
const SESSION_COOKIE = 'crm_kiosk_operator';
type StaffRow = { id: string; email: string; display_name: string; role: Role; active: number; kiosk_enabled: number; session_version: number };
function actor(row: StaffRow, channel: 'admin' | 'kiosk', deviceId?: string): Actor { return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, channel, ...(deviceId ? { deviceId } : {}) }; }
function cookieOptions(c: Context<AppEnv>, maxAge: number) { return { httpOnly: true, secure: new URL(c.req.url).protocol === 'https:' || c.env.APP_ENV !== 'local', sameSite: 'Strict' as const, path: '/api/kiosk', maxAge }; }
export function setDeviceCookie(c: Context<AppEnv>, value: string) { setCookie(c, DEVICE_COOKIE, value, cookieOptions(c, 90 * 86400)); }
export function clearOperatorCookie(c: Context<AppEnv>) { deleteCookie(c, SESSION_COOKIE, { path: '/api/kiosk' }); }

export const adminAuth = createMiddleware<AppEnv>(async (c, next) => {
  const issuer = c.env.ACCESS_ISSUER?.replace(/\/$/, '');
  const audience = c.env.ACCESS_AUD;
  if (!issuer || !audience) throw new ApiProblem(503, 'ACCESS_NOT_CONFIGURED', 'Cloudflare Access is not configured.');
  const hostname = new URL(c.req.url).hostname;
  const local = c.env.APP_ENV === 'local' && c.env.LOCAL_ACCESS_TEST_MODE === 'true' && ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
  const jwt = c.req.header('cf-access-jwt-assertion');
  if (!jwt) throw new ApiProblem(401, 'ACCESS_REQUIRED', 'Sign in through Cloudflare Access.');
  let email: string;
  try {
    const issuerUrl = new URL(issuer);
    if (!local && (issuerUrl.protocol !== 'https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuerUrl.hostname) || issuerUrl.pathname !== '/' || issuerUrl.port || issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash)) throw new Error('Invalid issuer');
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
    email = verified.payload.email.trim().toLowerCase();
  } catch { throw new ApiProblem(401, 'ACCESS_INVALID', 'Cloudflare Access identity could not be verified.'); }
  const db = c.env.CRM_DB;
  const center = centerId(c);
  let row = await db.prepare('SELECT * FROM staff WHERE center_id=? AND email=? COLLATE NOCASE AND active=1').bind(center, email).first<StaffRow>();
  if (!row && email === c.env.BOOTSTRAP_OWNER_EMAIL?.trim().toLowerCase()) {
    const timestamp = now();
    await db.batch<Record<string, unknown>>([
      db.prepare('INSERT INTO centers(id,name,timezone,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM centers) ON CONFLICT(id) DO NOTHING').bind(center, 'My Kumon Center', 'America/Los_Angeles', timestamp),
      db.prepare("INSERT INTO staff(id,center_id,email,display_name,role,active,kiosk_enabled,created_at,updated_at) SELECT ?,?,?,?,'owner',1,0,?,? WHERE EXISTS(SELECT 1 FROM centers WHERE id=?) AND NOT EXISTS(SELECT 1 FROM staff)").bind(id(), center, email, email.split('@')[0], timestamp, timestamp, center),
    ]);
    row = await db.prepare('SELECT * FROM staff WHERE center_id=? AND email=? COLLATE NOCASE AND active=1').bind(center, email).first<StaffRow>();
  }
  if (!row) throw new ApiProblem(403, 'STAFF_NOT_ALLOWED', 'This identity is not active on this center’s staff allowlist.');
  c.set('actor', actor(row, 'admin'));
  await next();
});

export async function getDevice(c: Context<AppEnv>) {
  const secret = getCookie(c, DEVICE_COOKIE);
  if (!secret) return null;
  return c.env.CRM_DB.prepare('SELECT * FROM kiosk_devices WHERE center_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>?').bind(centerId(c), await sha256(secret), now()).first<{ id: string; label: string; created_at: string; expires_at: string; revoked_at: string | null }>();
}
export function deviceView(row: { id: string; label: string; created_at: string; expires_at: string; revoked_at: string | null }): Device { return { id: row.id, label: row.label, createdAt: row.created_at, expiresAt: row.expires_at, revokedAt: row.revoked_at }; }
export async function getOperator(c: Context<AppEnv>, deviceId: string) {
  const secret = getCookie(c, SESSION_COOKIE);
  if (!secret) return null;
  const row = await c.env.CRM_DB.prepare("SELECT s.*,k.id AS session_id,k.expires_at FROM kiosk_sessions k JOIN staff s ON s.id=k.staff_id WHERE k.center_id=? AND k.device_id=? AND k.token_hash=? AND k.expires_at>? AND s.active=1 AND s.kiosk_enabled=1 AND s.role IN ('owner','manager','front_desk') AND s.session_version=k.staff_version").bind(centerId(c), deviceId, await sha256(secret), now()).first<StaffRow & { session_id: string; expires_at: string }>();
  return row ? { actor: actor(row, 'kiosk', deviceId), sessionId: row.session_id, expiresAt: row.expires_at } : null;
}
export const kioskAuth = createMiddleware<AppEnv>(async (c, next) => {
  const device = await getDevice(c);
  if (!device) throw new ApiProblem(401, 'DEVICE_REQUIRED', 'Enroll this kiosk with an owner’s enrollment code.');
  const operator = await getOperator(c, device.id);
  if (!operator) throw new ApiProblem(401, 'PIN_REQUIRED', 'Unlock the kiosk with your staff PIN.');
  c.set('actor', operator.actor); c.set('deviceId', device.id); c.set('sessionId', operator.sessionId);
  await next();
});
export async function createOperatorSession(c: Context<AppEnv>, deviceId: string, staffId: string, version: number) {
  const secret = token(); const timestamp = now(); const expires = new Date(Date.now() + 15 * 60000).toISOString();
  await c.env.CRM_DB.batch<Record<string, unknown>>([
    c.env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE device_id=? OR expires_at<?').bind(deviceId, timestamp),
    c.env.CRM_DB.prepare('INSERT INTO kiosk_sessions(id,center_id,device_id,staff_id,token_hash,staff_version,created_at,last_activity_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id(), centerId(c), deviceId, staffId, await sha256(secret), version, timestamp, timestamp, expires),
  ]);
  setCookie(c, SESSION_COOKIE, secret, cookieOptions(c, 15 * 60));
  return expires;
}
export async function touchOperator(c: Context<AppEnv>) {
  const expires = new Date(Date.now() + 15 * 60000).toISOString();
  await c.env.CRM_DB.prepare('UPDATE kiosk_sessions SET last_activity_at=?,expires_at=? WHERE id=? AND expires_at>?').bind(now(), expires, c.var.sessionId, now()).run();
  const secret = getCookie(c, SESSION_COOKIE); if (secret) setCookie(c, SESSION_COOKIE, secret, cookieOptions(c, 15 * 60));
  return expires;
}
