import type { Context } from 'hono';
import type { AppEnv, Env } from './types';
import type { Role } from '../shared/types';

export class ApiProblem extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export type Ctx = Context<AppEnv>;
export type Row = Record<string, unknown>;

export const now = () => new Date().toISOString();
export const iso = (ms: unknown) => (ms === null || ms === undefined ? null : new Date(Number(ms)).toISOString());
export const isoRequired = (ms: unknown) => new Date(Number(ms)).toISOString();

export const staffRoles: Role[] = ['owner', 'manager', 'front_desk', 'instructor'];
export const attendanceRoles: Role[] = ['owner', 'manager', 'front_desk'];
export const managementRoles: Role[] = ['owner', 'manager'];

export function requireRole(c: Ctx, roles: Role[]) {
  if (!roles.includes(c.var.actor.role)) throw new ApiProblem(403, 'FORBIDDEN', 'Your staff role does not allow this action.');
}
export function requireAdmin(c: Ctx) {
  if (c.var.actor.channel !== 'admin') throw new ApiProblem(403, 'ADMIN_REQUIRED', 'Use the staff workspace for this action.');
}

export function base64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
export function token() {
  return base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export async function sha256(value: string) {
  return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

/**
 * Kiosk PINs are short, so a slow hash would not stop an offline guess of a
 * copied database and would exceed the Workers Free CPU allowance. Instead the
 * hash is an HMAC keyed by a Worker secret that is never stored in D1, and
 * online guessing is limited by per-device and per-staff lockouts.
 */
export async function pinHash(env: Env, staffId: number, pin: string) {
  if (!env.PIN_PEPPER || env.PIN_PEPPER.length < 32) throw new ApiProblem(503, 'PIN_PEPPER_MISSING', 'Kiosk PINs are not configured for this installation.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.PIN_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`pin:v1:${staffId}:${pin}`));
  return `v1:${base64(new Uint8Array(mac))}`;
}
export function equalSecret(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function textValue(value: unknown, field: string, max = 200, required = true) {
  if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim()))
    throw new ApiProblem(400, 'INVALID_INPUT', `${field} must be ${required ? 'nonempty text' : 'text'} of at most ${max} characters.`);
  return value.trim();
}
export function dateValue(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new ApiProblem(400, 'INVALID_INPUT', `${field} must be an ISO timestamp.`);
  return Date.parse(value);
}
export function uuidValue(value: unknown, field: string) {
  const text = textValue(value, field, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text))
    throw new ApiProblem(400, 'INVALID_INPUT', `${field} must be a UUID.`);
  return text.toLowerCase();
}
export function idValue(value: unknown, field: string) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new ApiProblem(400, 'INVALID_INPUT', `${field} must be a record identifier.`);
  return n;
}
export const paramId = (c: Ctx, name = 'id') => {
  const value = c.req.param(name);
  if (!value || !/^\d{1,15}$/.test(value)) throw new ApiProblem(404, 'NOT_FOUND', 'Record was not found.');
  return Number(value);
};

export async function body(c: Ctx, limit = 100_000): Promise<Row> {
  if (Number(c.req.header('content-length') || 0) > limit) throw new ApiProblem(413, 'BODY_TOO_LARGE', 'Request is too large.');
  const reader = c.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ApiProblem(413, 'BODY_TOO_LARGE', 'Request is too large.'); }
      chunks.push(part.value);
    }
  }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value as Row;
  } catch {
    throw new ApiProblem(400, 'INVALID_JSON', 'Provide a JSON object.');
  }
}

export function pagination(c: Ctx, maxSize = 50) {
  const page = Number(c.req.query('page') || 1);
  const pageSize = Number(c.req.query('pageSize') || 25);
  if (!Number.isInteger(page) || page < 1 || page > 10000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > maxSize)
    throw new ApiProblem(400, 'INVALID_PAGE', `Use a positive page number and a page size of 1–${maxSize}.`);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Audit statement for administrative changes. Attendance records audit themselves. */
export function audit(c: Ctx, action: string, entityType: string, entityId: string | number, detail: unknown = {}, locationId: number | null = null) {
  return c.env.CRM_DB.prepare(
    'INSERT INTO audit_entries (location_id, actor_id, actor_name, action, entity_type, entity_id, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(locationId, c.var.actor.id, c.var.actor.displayName, action, entityType, String(entityId), JSON.stringify(detail), now());
}

export function validTimezone(value: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: string) {
  let value = formatters.get(timezone);
  if (!value) {
    value = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timezone, value);
  }
  return value;
}
export function localParts(ms: number, timezone: string) {
  const p = Object.fromEntries(formatter(timezone).formatToParts(ms).map(part => [part.type, part.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), year: Number(p.year) };
}
/** Epoch milliseconds of local midnight at the start of `day` in `timezone`. */
export function localMidnight(day: string, timezone: string) {
  const target = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(target) || new Date(target).toISOString().slice(0, 10) !== day) throw new ApiProblem(400, 'INVALID_DATE', 'Use a valid calendar date.');
  let candidate = target;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(formatter(timezone).formatToParts(candidate).map(part => [part.type, part.value]));
    const local = Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}.000Z`);
    candidate += target - local;
  }
  return candidate;
}
export const addDays = (day: string, count: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + count * 86400000).toISOString().slice(0, 10);
