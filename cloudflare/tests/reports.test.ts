import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { EvidenceReport } from '../shared/evidence';
import type { AttendanceSummary, AuditPage, Correction, VisitSummary } from '../shared/types';
import { createStudent, json, observation, startApp, type App } from './helpers';

describe('reports, evidence and audit', () => {
  let app: App;
  beforeAll(async () => {
    app = await startApp();
    const detail = await createStudent(app, { studentCode: 'R-1' });
    const guardianId = detail.guardians.find(g => g.pickupAuthority === 'allowed')!.id;
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 2 * 3600000).toISOString() }) }), 201);
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_out', { guardianId, observedAt: new Date(Date.now() - 3600000).toISOString() }) }), 201);
    const other = await createStudent(app, { studentCode: 'R-2' });
    await json(await app.admin('/attendance', { body: observation(other.student.id, 'check_in') }), 201);
  });
  afterAll(async () => { await app?.close(); });

  it('builds the evidence report for the eight requirements with software facts and attestations', async () => {
    const year = new Date().getUTCFullYear();
    const first = await json<EvidenceReport>(await app.admin(`/evidence?year=${year}`));
    expect(first.items.map(i => i.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(first.items[0]).toMatchObject({ status: 'met' });
    expect(first.items[0].facts[0]).toEqual({ label: 'Arrivals and departures recorded', value: '3' });
    expect(first.items[5]).toMatchObject({ status: 'attention' }); // Backups are not enabled in this test.
    expect(first.items.every(i => i.attestation === null)).toBe(true);
    expect(first.location.name).toBe('My center');

    await json(await app.admin('/attestations', { body: { requirement: 4, year, confirmed: true, note: 'Trained all three front-desk staff on Sept 3' } }), 201);
    await json(await app.admin('/attestations', { body: { requirement: 4, year, confirmed: false, note: 'New hire not yet trained' } }), 201);
    const second = await json<EvidenceReport>(await app.admin(`/evidence?year=${year}`));
    expect(second.items[3].attestation).toMatchObject({ confirmed: false, note: 'New hire not yet trained', attestedBy: 'owner' });
    expect((await app.admin('/attestations', { body: { requirement: 9, year, confirmed: true } })).status).toBe(400);
    await expect(app.db.prepare('DELETE FROM attestations').run()).rejects.toThrow(/IMMUTABLE_ATTESTATION/);
  });

  it('exports visits page by page with corrections for the browser to assemble', async () => {
    const page = await json<{ total: number; visits: VisitSummary[]; corrections: Correction[]; range: { timezone: string } }>(await app.admin('/reports/attendance'));
    expect(page.total).toBe(2);
    expect(page.visits.map(v => v.studentCode).sort()).toEqual(['R-1', 'R-2']);
    expect(page.range.timezone).toBe('America/Los_Angeles');
  });

  it('summarizes attendance by local day', async () => {
    const summary = await json<AttendanceSummary>(await app.admin('/reports/attendance/summary'));
    expect(summary.totals.visits).toBe(2);
    expect(summary.totals.closedVisits).toBe(1);
    expect(summary.enrollment).toMatchObject({ activeStudents: 2, math: 2, reading: 2, both: 2 });
    expect(summary.days).toHaveLength(30);
  });

  it('shows one audit timeline of administrative changes, observations and corrections', async () => {
    const page = await json<AuditPage>(await app.admin('/audit'));
    const sources = new Set(page.items.map(i => i.source));
    expect(sources.has('admin')).toBe(true);
    expect(sources.has('attendance')).toBe(true);
    expect(page.items.some(i => i.action === 'student_created')).toBe(true);
    expect(page.items.find(i => i.source === 'attendance')!.entityId).toMatch(/Synthetic Student \(R-\d\)/);
  });
});
