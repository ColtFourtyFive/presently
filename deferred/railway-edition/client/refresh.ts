import type { Bootstrap, LiveAttendance } from '../shared/types';

export type RefreshKind = 'bootstrap' | 'attendance';

/** Serialize reads; a refresh requested after a save must read after any older read. */
export function createRefreshController(options: {
  run: (kind: RefreshKind, background: boolean, signal: AbortSignal) => Promise<void>;
  visible: () => boolean;
}) {
  let tail = Promise.resolve();
  let pending = 0;
  let generation = 0;
  let active: AbortController | null = null;

  function enqueue(kind: RefreshKind, background: boolean) {
    const requestGeneration = generation;
    pending++;
    const result = tail.then(async () => {
      if (requestGeneration !== generation || background && !options.visible()) return;
      const controller = new AbortController();
      active = controller;
      try { await options.run(kind, background, controller.signal); }
      finally { if (active === controller) active = null; }
    }).finally(() => { pending--; });
    tail = result.catch(() => {});
    return result;
  }

  return {
    refresh: () => enqueue('bootstrap', false),
    poll: (kind: RefreshKind) => pending || !options.visible() ? Promise.resolve() : enqueue(kind, true),
    cancel() { generation++; active?.abort(); },
  };
}

function mergeRows<T extends { id: string }>(previous: T[], incoming: T[], order: (row: T) => string): T[] {
  const rows = new Map(previous.map(row => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => order(b).localeCompare(order(a)) || a.id.localeCompare(b.id));
}

/** A live snapshot replaces matching rows, never the historical collection. */
export function mergeLiveAttendance(current: Bootstrap, next: LiveAttendance): Bootstrap | null {
  if (!next.complete || current.center.id !== next.centerId || current.user.id !== next.user.id || current.user.role !== next.user.role) return null;
  const students = new Set(current.students.map(student => student.id));
  if ([...next.visits, ...next.events, ...next.incidents].some(row => !students.has(row.studentId))) return null;
  const visits = new Set(next.visits.map(visit => visit.id));
  const incidents = new Set(next.incidents.map(incident => incident.id));
  // A missing formerly-open row can indicate a reset/deletion. Reconcile fully
  // instead of retaining false presence or silently discarding historical rows.
  if (current.visits.some(visit => visit.status === 'open' && !visits.has(visit.id)) ||
      current.incidents.some(incident => incident.status === 'open' && !incidents.has(incident.id))) return null;
  return {
    ...current, user: next.user, serverTime: next.serverTime,
    visits: mergeRows(current.visits, next.visits, row => row.checkedInAt),
    events: mergeRows(current.events, next.events, row => row.occurredAt),
    incidents: mergeRows(current.incidents, next.incidents, row => row.createdAt),
    corrections: mergeRows(current.corrections || [], next.corrections, row => row.createdAt),
  };
}
