import { randomBytes, scrypt as nodeScrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request } from 'express';
import type { Staff } from '../shared/types.js';

const scrypt = promisify(nodeScrypt);
export const SESSION_COOKIE = 'kumon_session';
export const SESSION_IDLE_MS = 15 * 60 * 1000;
export interface Actor extends Staff { centerId: string }
export type AuthenticatedRequest = Request & { actor: Actor };
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [method, salt, hash] = encoded.split(':');
  if (method !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(password, salt, 64) as Buffer;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
}
export function newSession(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url'); return { token, hash: tokenHash(token) };
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
