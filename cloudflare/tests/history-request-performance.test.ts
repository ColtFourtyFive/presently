import { describe, expect, it } from 'vitest';
import { createStudent, observation, startApp } from './helpers';

type Metrics = { rowsRead: number; rowsWritten: number; statements: number; unmeasuredCalls: number };

describe('permanent request lookup database work', () => {
  it('uses bounded indexed reads as unrelated permanent request history grows', async () => {
    const app = await startApp({ metrics: true });
    try {
      const { student } = await createStudent(app);
      const accepted = observation(student.id, 'check_in');
      expect((await app.request('/api/admin/attendance', { token: app.token, body: accepted })).status).toBe(201);
      async function measure(body?: unknown) {
        const response = await app.request(body ? '/api/admin/attendance' : `/api/admin/attendance/events/${accepted.eventId}`, { token: app.token, ...(body ? { body } : {}) });
        expect(response.status, await response.text()).toBe(200);
        const raw = response.headers.get('x-isolated-d1-metrics');
        expect(raw).not.toBeNull();
        return JSON.parse(raw!) as Metrics;
      }
      const beforeStatus = await measure(), beforeRetry = await measure(accepted);
      // Native triggers reserve each audit ID. None of this synthetic history
      // belongs to the queried request, so lookup must not scan it.
      await app.db.prepare(`WITH RECURSIVE sequence(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<5000)
        INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
        SELECT 'unrelated-history-'||printf('%06d',n),'test-center',NULL,'Synthetic fixture','history_fixture','center','test-center','{}','2024-01-01T00:00:00.000Z' FROM sequence`).run();
      expect(await app.db.prepare("SELECT count(*) AS n FROM history_request_keys WHERE request_id LIKE 'unrelated-history-%'").first('n')).toBe(5000);
      const afterStatus = await measure(), afterRetry = await measure(accepted);
      for (const [before, after] of [[beforeStatus, afterStatus], [beforeRetry, afterRetry]]) {
        expect(after.unmeasuredCalls).toBe(0);
        expect(after.statements).toBe(before.statements);
        expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 2);
        expect(after.rowsRead).toBeLessThan(100);
        expect(after.rowsWritten).toBe(before.rowsWritten);
      }
    } finally { await app.close(); }
  });
});
