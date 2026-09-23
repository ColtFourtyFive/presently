import type { Context } from 'hono';
import type { AppEnv } from './types';
import type { Role } from '../shared/types';
export class ApiProblem extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const centerId = (c: Context<AppEnv>) => c.env.CENTER_ID || 'main-center';
export function requireRole(c: Context<AppEnv>, roles: Role[]) { if (!roles.includes(c.var.actor.role)) throw new ApiProblem(403, 'FORBIDDEN', 'Your staff role does not allow this action.'); }
export function base64(bytes: Uint8Array) { return btoa(String.fromCharCode(...bytes)); }
export function unbase64(value: string) { return Uint8Array.from(atob(value), x => x.charCodeAt(0)); }
export function token() { return base64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export async function sha256(value: string) { return base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))); }
export async function pinHash(pin: string, salt: string, iterations = 600000) { const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']); return base64(new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(salt), iterations }, key, 256))); }
export function equalSecret(a: string, b: string) { let diff = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return diff === 0; }
export function textValue(value: unknown, field: string, max = 200, required = true) { if (typeof value !== 'string' || value.trim().length > max || (required && !value.trim())) throw new ApiProblem(400, 'INVALID_INPUT', `${field} must be ${required ? 'nonempty text' : 'text'} of at most ${max} characters.`); return value.trim(); }
export function dateValue(value: unknown, field: string) { if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value) || !Number.isFinite(Date.parse(value))) throw new ApiProblem(400, 'INVALID_INPUT', `${field} must be an ISO timestamp.`); return new Date(value).toISOString(); }
export function uuidValue(value: unknown, field: string) { const s = textValue(value, field, 36); if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) throw new ApiProblem(400, 'INVALID_INPUT', `${field} must be a UUID.`); return s; }
export async function body(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  if (Number(c.req.header('content-length') || 0) > 100000) throw new ApiProblem(413, 'BODY_TOO_LARGE', 'Request is too large.');
  const reader = c.req.raw.body?.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  if (reader) { for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 100000) { await reader.cancel(); throw new ApiProblem(413, 'BODY_TOO_LARGE', 'Request is too large.'); } chunks.push(part.value); } }
  const buffer = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  try { const value: unknown = JSON.parse(new TextDecoder().decode(buffer)); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); return value as Record<string, unknown>; } catch { throw new ApiProblem(400, 'INVALID_JSON', 'Provide a JSON object.'); }
}
export function audit(c: Context<AppEnv>, action: string, entityType: string, entityId: string, detail: unknown = {}, createdAt: string = now()) { return c.env.CRM_DB.prepare('INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id(), centerId(c), c.var.actor.id, c.var.actor.displayName, action, entityType, entityId, JSON.stringify(detail), createdAt); }
export const staffRoles: Role[] = ['owner', 'manager', 'front_desk', 'instructor'];
export const attendanceRoles: Role[] = ['owner', 'manager', 'front_desk'];
export const managementRoles: Role[] = ['owner', 'manager'];
