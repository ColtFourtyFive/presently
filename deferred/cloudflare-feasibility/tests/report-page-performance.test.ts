import { describe, expect, it } from 'vitest';
import { createStudent, startApp } from './helpers';

type Metrics = {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
  unmeasuredCalls: number;
};

describe('attendance report page database work', () => {
  it('resolves selected visit IDs without scanning unrelated center history', async () => {
    const app = await startApp({ metrics: true });
    try {
      const target = await createStudent(app, {
        studentCode: 'REPORT-PERF-TARGET',
        firstName: 'Report',
        lastName: 'Target',
      });

      await app.db.prepare(`WITH RECURSIVE sequence(n) AS (
        SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<101
      )
      INSERT INTO visits(
        id,center_id,student_id,check_in_at,check_out_at,
        original_check_in_at,original_check_out_at,check_in_by,check_out_by,
        guardian_id,departure_type,review_status,version
      )
      SELECT
        'report-target-'||printf('%05d',n),'test-center',?,
        strftime('%Y-%m-%dT%H:%M:%fZ','2025-01-05','+'||(n*2)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2025-01-05','+'||(n*2+1)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2025-01-05','+'||(n*2)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2025-01-05','+'||(n*2+1)||' minutes'),
        ?,?,NULL,'check_out','none',1
      FROM sequence`).bind(target.student.id, app.actor.id, app.actor.id).run();

      async function measure(): Promise<Metrics> {
        const response = await app.request(
          '/api/admin/reports/attendance/pages?from=2025-01-01&to=2025-01-31&phase=visits',
          { token: app.token },
        );
        expect(response.status, await response.text()).toBe(200);
        const raw = response.headers.get('x-isolated-d1-metrics');
        expect(raw).not.toBeNull();
        return JSON.parse(raw!) as Metrics;
      }

      const before = await measure();
      const unrelated = await createStudent(app, {
        studentCode: 'REPORT-PERF-UNRELATED',
        firstName: 'Report',
        lastName: 'Unrelated',
      });

      await app.db.prepare(`WITH RECURSIVE sequence(n) AS (
        SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<4000
      )
      INSERT INTO visits(
        id,center_id,student_id,check_in_at,check_out_at,
        original_check_in_at,original_check_out_at,check_in_by,check_out_by,
        guardian_id,departure_type,review_status,version
      )
      SELECT
        'report-unrelated-'||printf('%05d',n),'test-center',?,
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2+1)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2+1)||' minutes'),
        ?,?,NULL,'check_out','none',1
      FROM sequence`).bind(unrelated.student.id, app.actor.id, app.actor.id).run();

      const after = await measure();
      expect(after.unmeasuredCalls).toBe(0);
      expect(after.statements).toBe(before.statements);
      expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 40);
      expect(after.rowsWritten).toBe(before.rowsWritten);
    } finally {
      await app.close();
    }
  });
});
