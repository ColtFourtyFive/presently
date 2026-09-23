import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { attendanceReportPage } from '../worker/attendance-report';
import type { AppEnv } from '../worker/types';
import { createStudent, json, seedHistoricalVisit, startApp } from './helpers';
import type { ReportPage } from '../shared/attendance-report';

describe('attendance report detail consistency', () => {
  it('rejects a student name change between the first report batch and selected visit details', async () => {
    const app = await startApp();
    try {
      const detail = await createStudent(app);
      await seedHistoricalVisit(
        app,
        detail,
        '2025-01-10T18:00:00.000Z',
        '2025-01-10T18:30:00.000Z',
      );
      const first = await json<ReportPage>(await app.request(
        '/api/admin/reports/attendance/pages?from=2025-01-01&to=2025-01-31',
        { token: app.token },
      ));
      let changed = false;
      const db = new Proxy(app.db, {
        get(target, key) {
          if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
            const result = await target.batch(statements);
            if (!changed && statements[0]?.sql.includes('SELECT coalesce(sum(version),0) AS epoch')) {
              changed = true;
              await target.prepare('UPDATE students SET first_name=? WHERE id=?')
                .bind('Changed between reads', detail.student.id).run();
            }
            return result;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const context = {
        env: { CRM_DB: db, CENTER_ID: 'test-center', ARCHIVE_ENABLED: 'false' },
        var: { actor: app.actor },
      } as unknown as Context<AppEnv>;

      await expect(attendanceReportPage(context, first.range, { phase: 'visits' }))
        .rejects.toMatchObject({ status: 409, code: 'REPORT_CHANGED' });
      expect(changed).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('rejects a change after visit source verification but before returning the page', async () => {
    const app = await startApp();
    try {
      const detail = await createStudent(app);
      await seedHistoricalVisit(
        app,
        detail,
        '2025-01-10T18:00:00.000Z',
        '2025-01-10T18:30:00.000Z',
      );
      const first = await json<ReportPage>(await app.request(
        '/api/admin/reports/attendance/pages?from=2025-01-01&to=2025-01-31',
        { token: app.token },
      ));
      let changed = false;
      const db = new Proxy(app.db, {
        get(target, key) {
          if (key === 'batch') return async (statements: Parameters<typeof target.batch>[0]) => {
            const result = await target.batch(statements);
            if (!changed && statements[1]?.sql.includes('FROM history_correction_outbox c')) {
              changed = true;
              await target.prepare('UPDATE students SET first_name=? WHERE id=?')
                .bind('Changed after verification', detail.student.id).run();
            }
            return result;
          };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const context = {
        env: { CRM_DB: db, CENTER_ID: 'test-center', ARCHIVE_ENABLED: 'false' },
        var: { actor: app.actor },
      } as unknown as Context<AppEnv>;

      await expect(attendanceReportPage(context, first.range, { phase: 'visits' }))
        .rejects.toMatchObject({ status: 409, code: 'REPORT_CHANGED' });
      expect(changed).toBe(true);
    } finally {
      await app.close();
    }
  });
});
