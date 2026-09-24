import { request } from './api';
import { REPORT_LIMITS, REPORT_PHASES, attendanceCsv, compareReportKeys, type ReportEvidence, type ReportPage, type ReportPhase, type ReportRow } from '../shared/attendance-report';

type Options = {
  signal?: AbortSignal;
  onProgress?: (rows: number) => void;
  readPage?: (path: string, signal?: AbortSignal) => Promise<ReportPage>;
};
const fail = (message = 'The attendance export could not be verified. Start it again.'): never => { throw new Error(message); };
const encoder = new TextEncoder();
const keyFor = (phase: ReportPhase, row: ReportRow, visits: Map<string, ReportRow>): string[] => {
  if (phase === 'visits') return [String(row.check_in_at), row.id];
  if (phase === 'unmatched') { if (row.visit_id !== null) fail(); return [String(row.observed_at), row.id]; }
  if (typeof row.visit_id !== 'string' || !visits.has(row.visit_id)) fail('The report contains evidence without its visit. Start the export again.');
  const visitId = String(row.visit_id);
  return [String(visits.get(visitId)!.check_in_at), visitId, String(row[phase === 'corrections' ? 'recorded_at' : 'received_at']), row.id];
};

/** No file/URL is created until every page has passed these completeness checks. */
export async function collectAttendanceExport(from: string, to: string, options: Options = {}): Promise<{ csv: string; filename: string; rows: number }> {
  const read = options.readPage || ((path, signal) => request<ReportPage>(path, { signal }));
  const evidence: ReportEvidence = { visits: [], corrections: [], observations: [], unmatched: [] };
  const visits = new Map<string, ReportRow>(), events = new Set<string>();
  let first: ReportPage | undefined, bytes = 0, count = 0;
  for (const phase of REPORT_PHASES) {
    let after: string | null = null, previous: string[] | undefined;
    const seen = new Set<string>();
    do {
      options.signal?.throwIfAborted();
      const params = new URLSearchParams({ from, to, phase });
      if (first) { params.set('epoch', String(first.epoch)); params.set('generation', first.generation); }
      if (after) params.set('after', after);
      const page = await read(`/api/admin/reports/attendance/pages?${params}`, options.signal);
      options.signal?.throwIfAborted();
      if (!page || page.phase !== phase || !Array.isArray(page.items) || page.items.length > REPORT_LIMITS.pageRows || !Number.isSafeInteger(page.epoch) || page.epoch < 0 || typeof page.generation !== 'string' || !/^[a-f0-9]{32}$/.test(page.generation) || !page.range || page.range.from !== from || page.range.to !== to || !page.exporter || typeof page.exporter.id !== 'string' || typeof page.exporter.name !== 'string' || (page.next !== null && typeof page.next !== 'string')) fail();
      if (!first) {
        if (!page.initial || !page.initial.counts || typeof page.initial.counts !== 'object' || typeof page.initial.exportedAt !== 'string' || !Number.isFinite(Date.parse(page.initial.exportedAt)) || REPORT_PHASES.some(kind => !Number.isSafeInteger(page.initial!.counts[kind]) || page.initial!.counts[kind] < 0 || page.initial!.counts[kind] > REPORT_LIMITS[kind]) || page.initial.counts.visits + page.initial.counts.unmatched > REPORT_LIMITS.visits) fail();
        first = page;
      } else if (page.initial || page.epoch !== first.epoch || page.generation !== first.generation || JSON.stringify(page.range) !== JSON.stringify(first.range) || page.exporter.id !== first.exporter.id || page.exporter.name !== first.exporter.name) fail('Attendance changed while the export was being prepared. Start the export again.');
      bytes += encoder.encode(JSON.stringify(page)).length;
      if (bytes > REPORT_LIMITS.bytes) fail('This attendance report is larger than 32 MiB. Choose a smaller date range.');
      for (const item of page.items) {
        if (!item || !Array.isArray(item.key) || !item.data || typeof item.data.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(item.data.id) || seen.has(item.data.id) || item.key.some(part => typeof part !== 'string')) fail();
        if (JSON.stringify(item.key) !== JSON.stringify(keyFor(phase, item.data, visits)) || previous && compareReportKeys(previous, item.key) >= 0) fail();
        previous = item.key; seen.add(item.data.id);
        if (phase === 'visits') visits.set(item.data.id, item.data);
        if (phase === 'observations' || phase === 'unmatched') { if (events.has(item.data.id)) fail(); events.add(item.data.id); }
        evidence[phase].push(item.data); count++;
      }
      if (evidence[phase].length > first.initial!.counts[phase]) fail();
      after = page.next;
      if (after !== null && (!page.items.length || after !== btoa(JSON.stringify(page.items.at(-1)!.key)))) fail();
      options.onProgress?.(count);
    } while (after !== null);
    if (evidence[phase].length !== first!.initial!.counts[phase]) fail('Some attendance evidence was missing. No file was downloaded; start the export again.');
  }
  // Let a queued Cancel/navigation event run before and after formatting a large file.
  await new Promise(resolve => setTimeout(resolve, 0));
  options.signal?.throwIfAborted();
  const csv = attendanceCsv(evidence, first!.range, first!.initial!.exportedAt, first!.exporter.name);
  if (encoder.encode(csv).length > REPORT_LIMITS.bytes) fail('This attendance CSV is larger than 32 MiB. Choose a smaller date range.');
  await new Promise(resolve => setTimeout(resolve, 0));
  options.signal?.throwIfAborted();
  return { csv, filename: `attendance-${from}-${to}.csv`, rows: evidence.visits.length + evidence.unmatched.length };
}
