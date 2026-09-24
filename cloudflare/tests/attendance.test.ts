import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AttendanceResult, Correction, Review, RosterPollResponse, RosterResponse, StudentDetail, VisitSummary } from '../shared/types';
import { createStudent, json, observation, startApp, type App } from './helpers';

const allowed = (detail: StudentDetail) => detail.guardians.find(g => g.pickupAuthority === 'allowed')!.id;
const code = async (response: { status: number; text(): Promise<string> }, status: number) => (await json<{ error: { code: string } }>(response, status)).error.code;

describe('attendance', () => {
  let app: App;
  beforeAll(async () => { app = await startApp(); });
  afterAll(async () => { await app?.close(); });

  it('records an arrival and an authorized departure as one visit', async () => {
    const detail = await createStudent(app);
    const arrival = await json<AttendanceResult>(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in') }), 201);
    expect(arrival.visit).toMatchObject({ studentId: detail.student.id, checkOutAt: null, reviewStatus: 'none', version: 1, checkInBy: 'owner' });
    expect(arrival.event.visitId).toBe(arrival.visit!.id);
    const departure = await json<AttendanceResult>(await app.admin('/attendance', { body: observation(detail.student.id, 'check_out', { guardianId: allowed(detail) }) }), 201);
    expect(departure.visit).toMatchObject({ id: arrival.visit!.id, departureType: 'check_out', guardianName: 'Approved Guardian', version: 2, corrected: false });
    expect(departure.visit!.originalCheckOutAt).toBe(departure.visit!.checkOutAt);
  });

  it('replays an identical retry and rejects a reused request id with different content', async () => {
    const detail = await createStudent(app);
    const body = observation(detail.student.id, 'check_in');
    const first = await json<AttendanceResult>(await app.admin('/attendance', { body }), 201);
    const retry = await json<AttendanceResult>(await app.admin('/attendance', { body }));
    expect(retry.replayed).toBe(true);
    expect(retry.event.id).toBe(first.event.id);
    const lookup = await json<AttendanceResult>(await app.admin(`/attendance/events/${body.eventId}`));
    expect(lookup.event.id).toBe(first.event.id);
    expect(await code(await app.admin('/attendance', { body: { ...body, observedAt: new Date().toISOString() } }), 409)).toBe('REQUEST_ID_REUSED');
    const count = await app.db.prepare('SELECT count(*) AS n FROM attendance_events WHERE request_id = ?').bind(body.eventId).first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it('enforces presence, pickup authority and pickup alerts in the database', async () => {
    const detail = await createStudent(app);
    const id = detail.student.id;
    expect(await code(await app.admin('/attendance', { body: observation(id, 'check_out', { guardianId: allowed(detail) }) }), 409)).toBe('NOT_PRESENT');
    await json(await app.admin('/attendance', { body: observation(id, 'check_in') }), 201);
    expect(await code(await app.admin('/attendance', { body: observation(id, 'check_in') }), 409)).toBe('ALREADY_PRESENT');
    const unverified = detail.guardians.find(g => g.pickupAuthority === 'unverified')!.id;
    const denied = detail.guardians.find(g => g.pickupAuthority === 'denied')!.id;
    expect(await code(await app.admin('/attendance', { body: observation(id, 'check_out', { guardianId: unverified }) }), 409)).toBe('PICKUP_UNVERIFIED');
    expect(await code(await app.admin('/attendance', { body: observation(id, 'check_out', { guardianId: denied }) }), 409)).toBe('PICKUP_UNVERIFIED');
    await json(await app.admin(`/students/${id}`, { method: 'PATCH', body: { pickupAlert: 'Custody order: call the center director first' } }));
    expect(await code(await app.admin('/attendance', { body: observation(id, 'check_out', { guardianId: allowed(detail) }) }), 409)).toBe('PICKUP_ALERT');
  });

  it('records an exceptional departure as a fact and opens a manager review', async () => {
    const detail = await createStudent(app, { pickupAlert: 'Only the listed parent may collect' });
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in') }), 201);
    expect(await code(await app.admin('/attendance', { body: observation(detail.student.id, 'exceptional_departure', { reason: 'no' }) }), 400)).toBe('REASON_REQUIRED');
    const left = await json<AttendanceResult>(await app.admin('/attendance', { body: observation(detail.student.id, 'exceptional_departure', { reason: 'Left with an unlisted adult; director called parent' }) }), 201);
    expect(left.visit).toMatchObject({ departureType: 'exceptional_departure', reviewStatus: 'pending' });
    const reviews = await json<{ items: Review[] }>(await app.admin('/reviews'));
    const review = reviews.items.find(r => r.visitId === left.visit!.id)!;
    expect(review.reason).toContain('unlisted adult');
    await json(await app.admin(`/reviews/${review.id}/resolve`, { body: { resolution: 'Parent confirmed the pickup by phone.' } }));
    expect(await code(await app.admin(`/reviews/${review.id}/resolve`, { body: { resolution: 'Second resolution attempt' } }), 409)).toBe('REVIEW_RESOLVED');
    const visit = await json<{ visit: VisitSummary }>(await app.admin(`/visits/${left.visit!.id}`));
    expect(visit.visit.reviewStatus).toBe('resolved');
  });

  it('allows an exceptional departure with no open visit and keeps it unmatched', async () => {
    const detail = await createStudent(app);
    const result = await json<AttendanceResult>(await app.admin('/attendance', { body: observation(detail.student.id, 'exceptional_departure', { reason: 'Seen leaving; arrival was never recorded' }) }), 201);
    expect(result.event.visitId).toBeNull();
    expect(result.visit).toBeNull();
  });

  it('rejects observations outside the recording window and inactive arrivals', async () => {
    const detail = await createStudent(app);
    const old = observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() - 25 * 3600000).toISOString() });
    expect(await code(await app.admin('/attendance', { body: old }), 400)).toBe('OBSERVATION_OUT_OF_RANGE');
    const future = observation(detail.student.id, 'check_in', { observedAt: new Date(Date.now() + 5 * 60000).toISOString() });
    expect(await code(await app.admin('/attendance', { body: future }), 400)).toBe('OBSERVATION_OUT_OF_RANGE');
    await json(await app.admin(`/students/${detail.student.id}`, { method: 'PATCH', body: { active: false } }));
    expect(await code(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in') }), 409)).toBe('STUDENT_INACTIVE');
  });

  it('keeps original observations immutable while managers correct visit times with a reason', async () => {
    const detail = await createStudent(app);
    const arrivedAt = new Date(Date.now() - 3 * 3600000);
    const arrival = await json<AttendanceResult>(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in', { observedAt: arrivedAt.toISOString() }) }), 201);
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_out', { guardianId: allowed(detail), observedAt: new Date(Date.now() - 3600000).toISOString() }) }), 201);
    const correctionId = crypto.randomUUID();
    const input = { correctionId, expectedVersion: 2, checkInAt: new Date(arrivedAt.getTime() - 10 * 60000).toISOString(), checkOutAt: new Date(Date.now() - 3600000).toISOString(), reason: 'Arrived before the iPad was unlocked' };
    const corrected = await json<{ correction: Correction; visit: VisitSummary }>(await app.admin(`/visits/${arrival.visit!.id}/corrections`, { body: input }), 201);
    expect(corrected.visit).toMatchObject({ version: 3, corrected: true, checkInAt: input.checkInAt, originalCheckInAt: arrivedAt.toISOString() });
    expect(corrected.correction.priorCheckInAt).toBe(arrivedAt.toISOString());
    const replay = await json<{ replayed: boolean }>(await app.admin(`/visits/${arrival.visit!.id}/corrections`, { body: input }));
    expect(replay.replayed).toBe(true);
    expect(await code(await app.admin(`/visits/${arrival.visit!.id}/corrections`, { body: { ...input, correctionId: crypto.randomUUID() } }), 409)).toBe('STALE_VISIT');
    expect(await code(await app.admin(`/visits/${arrival.visit!.id}/corrections`, { body: { ...input, correctionId: crypto.randomUUID(), expectedVersion: 3, checkInAt: new Date(Date.now() + 3600000).toISOString(), checkOutAt: null } }), 409)).toBe('FUTURE_CORRECTION');
    await expect(app.db.prepare('UPDATE attendance_events SET observed_at = 0 WHERE id = ?').bind(arrival.event.id).run()).rejects.toThrow(/IMMUTABLE_ATTENDANCE/);
    await expect(app.db.prepare('DELETE FROM attendance_events WHERE id = ?').bind(arrival.event.id).run()).rejects.toThrow(/IMMUTABLE_ATTENDANCE/);
    await expect(app.db.prepare('DELETE FROM attendance_corrections').run()).rejects.toThrow(/IMMUTABLE_CORRECTION/);
    await expect(app.db.prepare('DELETE FROM visits').run()).rejects.toThrow(/IMMUTABLE_ATTENDANCE/);
    const history = await json<StudentDetail>(await app.admin(`/students/${detail.student.id}`));
    expect(history.corrections).toHaveLength(1);
  });

  it('rejects a correction that would overlap another visit', async () => {
    const detail = await createStudent(app);
    const t = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600000).toISOString();
    const first = await json<AttendanceResult>(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in', { observedAt: t(5) }) }), 201);
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_out', { guardianId: allowed(detail), observedAt: t(4) }) }), 201);
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in', { observedAt: t(2) }) }), 201);
    const overlap = { correctionId: crypto.randomUUID(), expectedVersion: 2, checkInAt: t(5), checkOutAt: t(1.5), reason: 'Testing overlap protection' };
    expect(await code(await app.admin(`/visits/${first.visit!.id}/corrections`, { body: overlap }), 409)).toBe('OVERLAPPING_VISIT');
  });

  it('serves the live roster with revision-based polling', async () => {
    const roster = await json<RosterResponse>(await app.admin('/roster'));
    const unchanged = await json<RosterPollResponse>(await app.admin(`/roster?revision=${roster.revision}`));
    expect(unchanged).toMatchObject({ unchanged: true, revision: roster.revision });
    const detail = await createStudent(app);
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in') }), 201);
    const changed = await json<RosterResponse>(await app.admin(`/roster?revision=${roster.revision}`));
    expect(changed.revision).toBeGreaterThan(roster.revision);
    expect(changed.items.some(v => v.studentId === detail.student.id)).toBe(true);
  });

  it('pages history within a date range and filters by student', async () => {
    const detail = await createStudent(app);
    await json(await app.admin('/attendance', { body: observation(detail.student.id, 'check_in') }), 201);
    const page = await json<{ items: VisitSummary[]; total: number }>(await app.admin(`/history?studentId=${detail.student.id}`));
    expect(page.total).toBe(1);
    expect(page.items[0].studentId).toBe(detail.student.id);
    expect((await app.admin('/history?from=2020-01-01&to=2022-01-01')).status).toBe(400);
  });

  it('limits front desk staff to recording attendance', async () => {
    await json(await app.admin('/staff', { location: null, body: { email: 'desk@example.test', displayName: 'Dee Desk', role: 'front_desk', locationIds: [app.locationId] } }), 201);
    const token = await app.signer.token({ email: 'desk@example.test', sub: 'desk' });
    const detail = await createStudent(app);
    await json(await app.admin('/attendance', { token, body: observation(detail.student.id, 'check_in') }), 201);
    expect((await app.admin('/history', { token })).status).toBe(403);
    expect((await app.admin('/reviews', { token })).status).toBe(403);
    expect((await app.admin(`/students/${detail.student.id}`, { token, method: 'PATCH', body: { firstName: 'X' } })).status).toBe(403);
    const profile = await json<StudentDetail>(await app.admin(`/students/${detail.student.id}`, { token }));
    expect(profile.guardians[0].phone).toBeTruthy();
  });
});
