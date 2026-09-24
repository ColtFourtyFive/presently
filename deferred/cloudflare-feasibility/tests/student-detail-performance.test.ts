import { describe, expect, it } from 'vitest';
import { createStudent, seedHistoricalVisit, startApp } from './helpers';

type Metrics = {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
  unmeasuredCalls: number;
};

describe('student detail database work', () => {
  it('seeks retention candidates in original attendance order', async () => {
    const app = await startApp();
    try {
      const plan = await app.db.prepare(`EXPLAIN QUERY PLAN
        SELECT h.visit_id
        FROM history_visit_heads h
        JOIN history_retention_source_closures c ON c.visit_id=h.visit_id AND c.center_id=h.center_id
        JOIN history_source_revisions sr ON sr.visit_id=h.visit_id
        WHERE h.center_id=? AND h.residency='live'
          AND h.original_check_out_at IS NOT NULL AND h.original_check_out_at<?
          AND h.check_out_at IS NOT NULL AND h.check_out_at<?
          AND h.review_status!='pending'
          AND (h.original_check_in_at>? OR (h.original_check_in_at=? AND h.visit_id>?))
        ORDER BY h.original_check_in_at,h.visit_id
        LIMIT 1`)
        .bind('test-center', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '', '', '')
        .all<{ detail: string }>();
      const detail = plan.results.map(row => row.detail).join(' ');
      expect(detail).toContain('history_heads_center_original_cursor');
      expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY');
    } finally {
      await app.close();
    }
  });

  it('does not scan unrelated attendance history', async () => {
    const app = await startApp({ metrics: true });
    try {
      const target = await createStudent(app, {
        studentCode: 'PERF-TARGET',
        firstName: 'Profile',
        lastName: 'Target',
      });
      await seedHistoricalVisit(
        app,
        target,
        '2025-01-05T17:00:00.000Z',
        '2025-01-05T18:00:00.000Z',
      );

      async function measure(): Promise<Metrics> {
        const response = await app.request(`/api/admin/students/${target.student.id}`, {
          token: app.token,
        });
        expect(response.status, await response.text()).toBe(200);
        const raw = response.headers.get('x-isolated-d1-metrics');
        expect(raw).not.toBeNull();
        return JSON.parse(raw!) as Metrics;
      }

      const before = await measure();
      const unrelated = await createStudent(app, {
        studentCode: 'PERF-UNRELATED',
        firstName: 'Unrelated',
        lastName: 'History',
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
        'unrelated-visit-'||printf('%05d',n),'test-center',?,
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2+1)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2)||' minutes'),
        strftime('%Y-%m-%dT%H:%M:%fZ','2024-01-01','+'||(n*2+1)||' minutes'),
        ?,?,NULL,'check_out','none',1
      FROM sequence`).bind(unrelated.student.id, app.actor.id, app.actor.id).run();

      await app.db.prepare(`WITH RECURSIVE sequence(n) AS (
        SELECT 1 UNION ALL SELECT n+1 FROM sequence WHERE n<200
      )
      INSERT INTO attendance_corrections(
        id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,
        check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash
      )
      SELECT
        'unrelated-correction-'||printf('%05d',n),'test-center',v.id,1,
        v.check_in_at,v.check_out_at,v.check_in_at,v.check_out_at,
        'Synthetic unrelated correction',?,?,
        '2026-09-01T00:00:00.000Z',printf('%064d',n)
      FROM sequence
      JOIN visits v ON v.id='unrelated-visit-'||printf('%05d',n)`)
        .bind(app.actor.id, app.actor.displayName).run();

      const after = await measure();
      expect(after.unmeasuredCalls).toBe(0);
      expect(after.statements).toBe(before.statements);
      expect(after.rowsRead).toBeLessThanOrEqual(before.rowsRead + 12);
      expect(after.rowsRead).toBeLessThan(150);
      expect(after.rowsWritten).toBe(before.rowsWritten);
    } finally {
      await app.close();
    }
  });
});
