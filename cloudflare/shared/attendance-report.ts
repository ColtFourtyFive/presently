export const REPORT_PHASES = ['visits', 'corrections', 'observations', 'unmatched'] as const;
export type ReportPhase = typeof REPORT_PHASES[number];
export type ReportRow = Record<string, unknown> & { id: string };
export type ReportItem = { key: string[]; data: ReportRow };
export type ReportCounts = Record<ReportPhase, number>;
export type ReportRange = { from: string; to: string; fromISO: string; toISO: string; timezone: string };
export type ReportPage = {
  phase: ReportPhase; items: ReportItem[]; next: string | null; epoch: number; generation: string;
  range: ReportRange; exporter: { id: string; name: string };
  initial?: { counts: ReportCounts; exportedAt: string };
};
export const REPORT_LIMITS = { pageRows: 100, visits: 10000, corrections: 50000, observations: 30000, unmatched: 10000, bytes: 32 * 1024 * 1024, pageBytes: 512 * 1024 } as const;
export const ATTENDANCE_CSV_HEADERS = ['Visit ID', 'Student ID', 'Student code', 'Student', 'Original arrival UTC', 'Original departure UTC', 'Effective arrival UTC', 'Effective departure UTC', 'Arrival staff', 'Departure staff', 'Pickup guardian', 'Departure type', 'Review status', 'Center timezone', 'Exported at UTC', 'Exported by', 'Corrections JSON', 'Observations JSON'];

/** Quote every cell and neutralize spreadsheet formulas, including leading whitespace. */
export function reportCsvCell(value: unknown): string {
  let text = value == null ? '' : String(value);
  if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
export function compareReportKeys(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return a.length - b.length;
}
export type ReportEvidence = Record<ReportPhase, ReportRow[]>;
const correction = (r: ReportRow) => ({ id: r.id, visitId: r.visit_id, priorCheckInAt: r.prior_check_in_at, priorCheckOutAt: r.prior_check_out_at, checkInAt: r.check_in_at, checkOutAt: r.check_out_at, reason: r.reason, actorName: r.actor_name, recordedAt: r.recorded_at });
const observationCorrections = (row: ReportRow): unknown[] => {
 try {
 const value = JSON.parse(String(row.observation_corrections_json ?? '[]'));
 return Array.isArray(value) ? value : [];
 } catch { return []; }
};
const observation = (r: ReportRow, unmatched = false) => ({
 id: r.id, observedAt: r.observed_at, receivedAt: r.received_at,
 actorName: r.actor_name, action: r.action, channel: r.channel, reason: r.reason,
 ...(unmatched ? {
 unmatched: true,
 originalObservedAt: r.observed_at,
 effectiveObservedAt: r.effective_observed_at ?? r.observed_at,
 version: r.observation_version ?? 1,
 corrections: observationCorrections(r),
 } : {}),
});

/** Called only after all pages, counts and relations have verified. */
export function attendanceCsv(evidence: ReportEvidence, range: ReportRange, exportedAt: string, exportedBy: string): string {
  const corrections = new Map<string, ReturnType<typeof correction>[]>(), observations = new Map<string, ReturnType<typeof observation>[]>();
  for (const row of evidence.corrections) { const key = String(row.visit_id); const group = corrections.get(key) || []; group.push(correction(row)); corrections.set(key, group); }
  for (const row of evidence.observations) { const key = String(row.visit_id); const group = observations.get(key) || []; group.push(observation(row)); observations.set(key, group); }
  const lines = [ATTENDANCE_CSV_HEADERS.map(reportCsvCell).join(',')];
  for (const row of evidence.visits) lines.push([
    row.id, row.student_id, row.student_code, row.student_name, row.original_check_in_at, row.original_check_out_at,
    row.check_in_at, row.check_out_at, row.in_name, row.out_name, row.guardian_name, row.departure_type, row.review_status,
    range.timezone, exportedAt, exportedBy, JSON.stringify(corrections.get(row.id) || []), JSON.stringify(observations.get(row.id) || []),
  ].map(reportCsvCell).join(','));
  for (const row of evidence.unmatched) lines.push([
    '', row.student_id, row.student_code, row.student_name, '', row.observed_at, '', row.effective_observed_at ?? row.observed_at, '', row.actor_name,
    '', row.action, row.review_status, range.timezone, exportedAt, exportedBy, '[]', JSON.stringify([observation(row, true)]),
  ].map(reportCsvCell).join(','));
  return '\uFEFF' + lines.join('\r\n');
}
