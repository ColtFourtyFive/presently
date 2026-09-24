import { Hono } from 'hono';
import { afterEach, expect, it, vi } from 'vitest';
import { createHistoryRouter } from '../worker/records';
import type { AppEnv, Env } from '../worker/types';

afterEach(() => vi.restoreAllMocks());
it('uses the accepted resolution timestamp for its audit when the clock advances between statements', async () => {
  const before = '2026-09-16T12:00:00.000Z', after = '2026-09-16T12:00:00.001Z';
  let current = before;
  vi.spyOn(Date.prototype, 'toISOString').mockImplementation(() => current);
  const committed: { sql: string; args: unknown[] }[] = [];
  const database = {
    prepare(sql: string) {
      return { bind(...args: unknown[]) {
        // A real clock tick after binding the review must not produce a
        // different immutable audit timestamp for the same accepted action.
        if (sql.startsWith('UPDATE reviews')) current = after;
        return { sql, args, first: async () => ({ id: 'review-1', visit_id: 'visit-1', status: 'pending' }) };
      } };
    },
    async batch(statements: { sql: string; args: unknown[] }[]) { committed.push(...statements); return []; },
  };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('actor', { id: 'owner-1', email: 'owner@example.test', displayName: 'Owner', role: 'owner', channel: 'admin' });
    await next();
  });
  app.route('/', createHistoryRouter());
  const response = await app.request('/reviews/review-1/resolve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ resolution: 'Paper register reviewed' }) }, { CRM_DB: database, CENTER_ID: 'test-center' } as unknown as Env);
  expect(response.status).toBe(200);
  const review = committed.find(statement => statement.sql.startsWith('UPDATE reviews'))!;
  const audit = committed.find(statement => statement.sql.startsWith('INSERT INTO audit_entries'))!;
  expect(current).toBe(after);
  expect(review.args[0]).toBe(before);
  expect(audit.args.at(-1)).toBe(review.args[0]);
});
