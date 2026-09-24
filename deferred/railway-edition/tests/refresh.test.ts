import { describe, expect, it } from 'vitest';
import { createRefreshController, mergeLiveAttendance } from '../client/refresh';
import type { Bootstrap, LiveAttendance } from '../shared/types';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('workspace refresh ordering', () => {
  it('skips hidden and overlapping polls, then resumes with a narrow read', async () => {
    let visible = false;
    const first = deferred();
    const calls: string[] = [];
    const reads = createRefreshController({ visible: () => visible, run: async kind => {
      calls.push(kind); if (calls.length === 1) await first.promise;
    } });
    await reads.poll('attendance');
    expect(calls).toEqual([]);
    visible = true;
    const polling = reads.poll('attendance');
    await Promise.resolve();
    await reads.poll('attendance');
    await reads.poll('bootstrap');
    expect(calls).toEqual(['attendance']);
    first.resolve(); await polling;
    await reads.poll('attendance');
    expect(calls).toEqual(['attendance', 'attendance']);
  });

  it('makes a deliberate post-save refresh wait for older reads and fetch again', async () => {
    const oldRead = deferred();
    const calls: string[] = [];
    const reads = createRefreshController({ visible: () => true, run: async (kind, background) => {
      calls.push(`${kind}:${background}:start`);
      if (kind === 'attendance') await oldRead.promise;
      calls.push(`${kind}:finish`);
    } });
    const poll = reads.poll('attendance'); await Promise.resolve();
    const afterSave = reads.refresh();
    await reads.poll('attendance');
    expect(calls).toEqual(['attendance:true:start']);
    oldRead.resolve(); await Promise.all([poll, afterSave]);
    expect(calls).toEqual(['attendance:true:start', 'attendance:finish', 'bootstrap:false:start', 'bootstrap:finish']);
  });

  it('invalidates queued reads and aborts an old session response on logout', async () => {
    const oldRead = deferred();
    const applied: string[] = [];
    let oldSignal: AbortSignal | undefined;
    const reads = createRefreshController({ visible: () => true, run: async (kind, _background, signal) => {
      oldSignal = signal; await oldRead.promise;
      if (!signal.aborted) applied.push(kind);
    } });
    const poll = reads.poll('attendance'); await Promise.resolve();
    const queued = reads.refresh();
    reads.cancel();
    expect(oldSignal?.aborted).toBe(true);
    oldRead.resolve(); await Promise.all([poll, queued]);
    expect(applied).toEqual([]);
    await reads.refresh();
    expect(applied).toEqual(['bootstrap']);
  });

  it('allows explicit refresh while hidden and recovers after an unsuccessful request', async () => {
    let attempts = 0;
    const reads = createRefreshController({ visible: () => false, run: async () => {
      if (++attempts === 1) throw new Error('disconnected');
    } });
    await expect(reads.refresh()).rejects.toThrow('disconnected');
    await reads.refresh();
    expect(attempts).toBe(2);
  });
});

const before: Bootstrap = {
  center: { id: 'center', name: 'Center', timezone: 'America/Los_Angeles', location: '', operatingHours: '' },
  user: { id: 'owner', name: 'Owner', email: 'owner@test.invalid', role: 'owner' },
  students: [{ id: 'student', studentNumber: 'K-1', firstName: 'Test', lastName: 'Student', grade: '', subjects: [], status: 'active', guardians: [], pickupAlert: '', createdAt: '2024-01-01T00:00:00Z' }],
  visits: [
    { id: 'history', studentId: 'student', checkedInAt: '2024-01-01T16:00:00Z', checkedOutAt: '2024-01-01T17:00:00Z', status: 'closed', releaseBasis: 'Guardian', reconciliationStatus: 'clear' },
    { id: 'overnight', studentId: 'student', checkedInAt: '2026-09-14T23:00:00Z', checkedOutAt: null, status: 'open', releaseBasis: null, reconciliationStatus: 'review_needed' },
  ],
  incidents: [{ id: 'issue', studentId: 'student', visitId: 'overnight', type: 'review', summary: 'Verify presence', status: 'open', createdAt: '2026-09-14T23:00:00Z', resolvedAt: null }],
  schedules: [], inquiries: [], tasks: [], audit: [], interactions: [], events: [], corrections: [], serverTime: '2026-09-15T06:59:00Z', demo: false,
};
const live: LiveAttendance = {
  centerId: 'center', user: before.user, from: '2026-09-15T07:00:00Z', serverTime: '2026-09-15T08:00:00Z', complete: true,
  visits: [{ ...before.visits[1], checkedOutAt: '2026-09-15T07:30:00Z', status: 'closed', reconciliationStatus: 'clear' }],
  incidents: [{ ...before.incidents[0], status: 'resolved', resolvedAt: '2026-09-15T07:30:00Z' }], events: [], corrections: [],
};

describe('attendance snapshot merge', () => {
  it('removes old open statuses across midnight without dropping historical rows or other CRM data', () => {
    const merged = mergeLiveAttendance(before, live)!;
    expect(merged.visits.filter(row => row.status === 'open')).toEqual([]);
    expect(merged.incidents.filter(row => row.status === 'open')).toEqual([]);
    expect(merged.visits).toContainEqual(before.visits[0]);
    expect(merged.students).toBe(before.students);
    expect(merged.inquiries).toBe(before.inquiries);
    expect(merged.serverTime).toBe(live.serverTime);
  });

  it('updates historical corrections by ID without creating duplicate visits', () => {
    const corrected = { ...before.visits[0], checkedInAt: '2023-12-31T23:00:00Z' };
    const merged = mergeLiveAttendance(before, { ...live, visits: [...live.visits, corrected] })!;
    expect(merged.visits).toHaveLength(2);
    expect(merged.visits.find(row => row.id === 'history')).toEqual(corrected);
  });

  it('requires a full reconciliation for truncated snapshots, missing open rows, unfamiliar students, and identity changes', () => {
    expect(mergeLiveAttendance(before, { ...live, complete: false })).toBeNull();
    expect(mergeLiveAttendance(before, { ...live, visits: [] })).toBeNull();
    expect(mergeLiveAttendance(before, { ...live, incidents: [] })).toBeNull();
    expect(mergeLiveAttendance(before, { ...live, visits: [{ ...live.visits[0], studentId: 'new' }] })).toBeNull();
    expect(mergeLiveAttendance(before, { ...live, user: { ...live.user, role: 'instructor' } })).toBeNull();
    expect(mergeLiveAttendance(before, { ...live, centerId: 'other' })).toBeNull();
  });
});
