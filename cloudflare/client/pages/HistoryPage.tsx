import { useEffect, useMemo, useState } from 'react';
import { Download, History, Search, X } from 'lucide-react';
import type {
  AttendanceSummary, AuditEntry, AuditPage, Correction, HistoryRange, Page, StudentListItem, VisitSummary,
} from '../../shared/types';
import type { PageProps } from '../App';
import { messageOf } from '../api';
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Pager, Spinner } from '../components';
import {
  addDays, csvCell, downloadFile, formatDate, formatDateTime, formatDuration, formatTime, isoToZonedInput, localDate,
} from '../format';
import './reports.css';

type Tab = 'visits' | 'summary' | 'audit';
type PickedStudent = { id: number; name: string; code: string };
type HistoryResponse = Page<VisitSummary> & { range: HistoryRange };
type ExportPage = {
  range: HistoryRange; page: number; pageSize: number; total: number;
  visits: VisitSummary[]; corrections: Correction[]; exportedAt: string; exportedBy: string;
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'visits', label: 'Visits' },
  { id: 'summary', label: 'Summary' },
  { id: 'audit', label: 'Audit log' },
];

/** "attendance_exported" → "Attendance exported" */
export function humanize(value: string) {
  const text = value.replace(/[_.:-]+/g, ' ').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : value;
}

/** Wall-clock time at the location, in a spreadsheet-friendly form. */
const localStamp = (iso: string | null, timezone: string) => (iso ? isoToZonedInput(iso, timezone).replace('T', ' ') : '');

function VisitBadges({ visit }: { visit: VisitSummary }) {
  return (
    <span className="badges">
      {!visit.checkOutAt && <Badge tone="blue">Here now</Badge>}
      {visit.corrected && <Badge tone="blue">Corrected</Badge>}
      {visit.reviewStatus === 'pending' && <Badge tone="amber">Needs review</Badge>}
      {visit.reviewStatus === 'resolved' && <Badge tone="green">Reviewed</Badge>}
      {visit.departureType === 'exceptional_departure' && <Badge tone="red">Exceptional</Badge>}
    </span>
  );
}

export default function HistoryPage({ api, location }: PageProps) {
  const timezone = location.timezone;
  const today = localDate(timezone);
  const [tab, setTab] = useState<Tab>('visits');
  const [from, setFrom] = useState(addDays(today, -29));
  const [to, setTo] = useState(today);
  const [student, setStudent] = useState<PickedStudent | null>(null);

  const rangeError = !from || !to
    ? 'Choose both dates.'
    : from > to
      ? 'The start date must be on or before the end date.'
      : (Date.parse(to) - Date.parse(from)) / 86400000 > 365
        ? 'Choose a date range of at most 366 days.'
        : '';

  return (
    <div className="content">
      <PageHeader
        title="Attendance history"
        description={`Visits, totals and the audit trail for ${location.name}. Times are shown in ${timezone}.`}
      />
      <div className="toolbar" role="group" aria-label="Filters">
        <Field label="From">
          <input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <input type="date" value={to} min={from || undefined} max={today} onChange={e => setTo(e.target.value)} />
        </Field>
        {tab === 'visits' && <StudentPicker api={api} value={student} onChange={setStudent} />}
      </div>
      <Alert tone="warning">{rangeError}</Alert>
      <div className="tabs" role="tablist" aria-label="History views">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`history-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`history-panel-${t.id}`}
            className="tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`history-panel-${tab}`} aria-labelledby={`history-tab-${tab}`} className="stack">
        {rangeError ? null : tab === 'visits'
          ? <VisitsTab key={`${from}|${to}|${student?.id ?? ''}`} api={api} location={location} from={from} to={to} student={student} />
          : tab === 'summary'
            ? <SummaryTab api={api} timezone={timezone} from={from} to={to} />
            : <AuditTab api={api} timezone={timezone} from={from} to={to} />}
      </div>
    </div>
  );
}

function StudentPicker({ api, value, onChange }: { api: PageProps['api']; value: PickedStudent | null; onChange: (value: PickedStudent | null) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StudentListItem[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      api.get<Page<StudentListItem>>(`/students?q=${encodeURIComponent(q)}&status=all&pageSize=10`, controller.signal)
        .then(page => { setResults(page.items); setError(''); })
        .catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [api, query]);

  if (value) {
    return (
      <div className="field">
        <span className="field-label">Student</span>
        <div className="picker-selected">
          <span><strong>{value.name}</strong> <span className="muted">· {value.code}</span></span>
          <button type="button" className="icon-button" aria-label={`Clear student filter (${value.name})`} onClick={() => onChange(null)}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="student-picker">
      <Field label="Student (optional)" hint={error || undefined}>
        <input
          type="search"
          value={query}
          placeholder="Name or student code"
          autoComplete="off"
          onChange={e => setQuery(e.target.value)}
        />
      </Field>
      {results.length > 0 && (
        <div className="picker-results" aria-label="Matching students">
          {results.map(s => (
            <button
              key={s.id}
              type="button"
              onClick={() => {
                onChange({ id: s.id, name: s.displayName, code: s.studentCode });
                setQuery('');
                setResults([]);
              }}
            >
              <strong>{s.displayName}</strong> <span className="muted">· {s.studentCode}{s.active ? '' : ' · inactive'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function VisitsTab({ api, location, from, to, student }: {
  api: PageProps['api']; location: PageProps['location']; from: string; to: string; student: PickedStudent | null;
}) {
  const timezone = location.timezone;
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openVisit, setOpenVisit] = useState<number | null>(null);
  const [exporting, setExporting] = useState<{ done: number; total: number } | null>(null);
  const [exportMessage, setExportMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const params = new URLSearchParams({ from, to, page: String(page), pageSize: '25' });
    if (student) params.set('studentId', String(student.id));
    api.get<HistoryResponse>(`/history?${params}`, controller.signal)
      .then(value => { setData(value); setError(''); })
      .catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, from, to, page, student]);

  async function exportCsv() {
    setExportMessage(null);
    setExporting({ done: 0, total: 0 });
    try {
      const visits: VisitSummary[] = [];
      const corrections: Correction[] = [];
      let first: ExportPage | null = null;
      for (let n = 1; ; n++) {
        const chunk: ExportPage = await api.get<ExportPage>(`/reports/attendance?${new URLSearchParams({ from, to, page: String(n) })}`);
        first ??= chunk;
        visits.push(...chunk.visits);
        corrections.push(...chunk.corrections);
        setExporting({ done: visits.length, total: chunk.total });
        if (chunk.visits.length < chunk.pageSize || n * chunk.pageSize >= chunk.total) break;
      }
      const byVisit = new Map<number, Correction[]>();
      for (const c of corrections) byVisit.set(c.visitId, [...(byVisit.get(c.visitId) ?? []), c]);
      const header = [
        'Visit ID', 'Student code', 'Student', 'Arrival (location time)', 'Departure (location time)',
        'Original arrival UTC', 'Original departure UTC', 'Current arrival UTC', 'Current departure UTC',
        'Arrival recorded by', 'Departure recorded by', 'Pickup guardian', 'Departure type', 'Review status',
        'Corrections (count)', 'Corrections detail JSON', 'Time zone', 'Exported at UTC', 'Exported by',
      ];
      const zone = first?.range.timezone ?? timezone;
      const rows = visits.map(v => {
        const trail = byVisit.get(v.id) ?? [];
        return [
          v.id, v.studentCode, v.studentName, localStamp(v.checkInAt, zone), localStamp(v.checkOutAt, zone),
          v.originalCheckInAt, v.originalCheckOutAt ?? '', v.checkInAt, v.checkOutAt ?? '',
          v.checkInBy, v.checkOutBy ?? '', v.guardianName ?? '', v.departureType ?? '', v.reviewStatus,
          trail.length,
          trail.length ? JSON.stringify(trail.map(c => ({
            recordedAt: c.recordedAt, by: c.actorName, reason: c.reason,
            priorCheckInAt: c.priorCheckInAt, priorCheckOutAt: c.priorCheckOutAt, checkInAt: c.checkInAt, checkOutAt: c.checkOutAt,
          }))) : '',
          zone, first?.exportedAt ?? '', first?.exportedBy ?? '',
        ];
      });
      const csv = '﻿' + [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
      downloadFile(`attendance-${location.name}-${from}-to-${to}.csv`, csv);
      setExportMessage({ tone: 'success', text: `Exported ${visits.length.toLocaleString('en-US')} visits.` });
    } catch (e) {
      setExportMessage({ tone: 'error', text: `Export stopped: ${messageOf(e)} No file was downloaded.` });
    } finally {
      setExporting(null);
    }
  }

  return (
    <Card
      title="Visits"
      actions={
        <Button onClick={() => void exportCsv()} busy={!!exporting} className="no-print">
          <Download size={18} aria-hidden="true" /> Export CSV
        </Button>
      }
    >
      <p className="muted small">
        The CSV export covers every visit at this location in the selected dates (the student filter does not apply) and includes original and corrected times.
      </p>
      {exporting && (
        <div className="stack" role="status" aria-live="polite">
          <span>Preparing export… {exporting.total ? `${exporting.done.toLocaleString('en-US')} of ${exporting.total.toLocaleString('en-US')} visits` : 'starting'}</span>
          {exporting.total > 0 && (
            <div className="bar-track" aria-hidden="true">
              <div className="bar-fill" style={{ width: `${Math.min(100, (exporting.done / exporting.total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}
      {exportMessage && <Alert tone={exportMessage.tone}>{exportMessage.text}</Alert>}
      <Alert>{error}</Alert>
      {loading && !data && <Spinner />}
      {data && data.items.length === 0 && (
        <EmptyState icon={History} title="No visits in this range">
          <p>Try a wider date range{student ? ' or clear the student filter' : ''}.</p>
        </EmptyState>
      )}
      {data && data.items.length > 0 && (
        <>
          <div className="table-wrap" aria-busy={loading || undefined}>
            <table>
              <caption className="visually-hidden">Visits from {from} to {to}. Select a row to see its details.</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Student</th>
                  <th scope="col">Arrival</th>
                  <th scope="col">Departure</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Recorded by</th>
                  <th scope="col">Pickup</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(v => (
                  <tr
                    key={v.id}
                    className="clickable"
                    tabIndex={0}
                    aria-label={`Visit details for ${v.studentName}, ${formatDate(v.checkInAt, timezone)}`}
                    onClick={() => setOpenVisit(v.id)}
                    onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpenVisit(v.id); } }}
                  >
                    <td>{formatDate(v.checkInAt, timezone)}</td>
                    <td><strong>{v.studentName}</strong><br /><span className="muted small">{v.studentCode}</span></td>
                    <td>{formatTime(v.checkInAt, timezone)}</td>
                    <td>{v.checkOutAt ? formatTime(v.checkOutAt, timezone) : '—'}</td>
                    <td>{v.checkOutAt ? formatDuration(v.checkInAt, v.checkOutAt) : 'In progress'}</td>
                    <td className="small">In: {v.checkInBy}<br />Out: {v.checkOutBy ?? '—'}</td>
                    <td>{v.guardianName ?? '—'}</td>
                    <td><VisitBadges visit={v} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
          <p className="muted small">{data.total.toLocaleString('en-US')} visits</p>
        </>
      )}
      {openVisit !== null && <VisitModal api={api} visitId={openVisit} timezone={timezone} onClose={() => setOpenVisit(null)} />}
    </Card>
  );
}

function VisitModal({ api, visitId, timezone, onClose }: { api: PageProps['api']; visitId: number; timezone: string; onClose: () => void }) {
  const [data, setData] = useState<{ visit: VisitSummary; corrections: Correction[] } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    api.get<{ visit: VisitSummary; corrections: Correction[] }>(`/visits/${visitId}`, controller.signal)
      .then(setData)
      .catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); });
    return () => controller.abort();
  }, [api, visitId]);

  const v = data?.visit;
  return (
    <Modal
      title={v ? v.studentName : 'Visit'}
      subtitle={v ? `Student code ${v.studentCode} · ${formatDate(v.checkInAt, timezone)}` : undefined}
      onClose={onClose}
      wide
    >
      <Alert>{error}</Alert>
      {!data && !error && <Spinner />}
      {v && data && (
        <>
          <VisitBadges visit={v} />
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th scope="col" /><th scope="col">Originally recorded</th><th scope="col">Current</th></tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row">Arrival</th>
                  <td>{formatDateTime(v.originalCheckInAt, timezone)}</td>
                  <td>{formatDateTime(v.checkInAt, timezone)}</td>
                </tr>
                <tr>
                  <th scope="row">Departure</th>
                  <td>{formatDateTime(v.originalCheckOutAt, timezone)}</td>
                  <td>{formatDateTime(v.checkOutAt, timezone)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <dl className="facts">
            <dt>Arrival recorded by</dt><dd>{v.checkInBy}</dd>
            <dt>Departure recorded by</dt><dd>{v.checkOutBy ?? '—'}</dd>
            <dt>Pickup guardian</dt><dd>{v.guardianName ?? '—'}</dd>
            <dt>Departure type</dt>
            <dd>{v.departureType === 'exceptional_departure' ? 'Exceptional departure' : v.departureType === 'check_out' ? 'Normal check-out' : 'Still here'}</dd>
            <dt>Duration</dt><dd>{v.checkOutAt ? formatDuration(v.checkInAt, v.checkOutAt) : 'In progress'}</dd>
            <dt>Visit ID</dt><dd>{v.id}</dd>
          </dl>
          <h3>Correction trail</h3>
          {data.corrections.length === 0
            ? <p className="muted">No corrections. These are the times as originally recorded.</p>
            : (
              <ol className="trail">
                {data.corrections.map(c => (
                  <li key={c.id}>
                    <strong>{formatDateTime(c.recordedAt, timezone)}</strong> by {c.actorName}
                    <div className="small">
                      Arrival {formatDateTime(c.priorCheckInAt, timezone)} → {formatDateTime(c.checkInAt, timezone)}
                      <br />
                      Departure {formatDateTime(c.priorCheckOutAt, timezone)} → {formatDateTime(c.checkOutAt, timezone)}
                    </div>
                    <div>Reason: {c.reason}</div>
                  </li>
                ))}
              </ol>
            )}
        </>
      )}
    </Modal>
  );
}

function SummaryTab({ api, timezone, from, to }: { api: PageProps['api']; timezone: string; from: string; to: string }) {
  const [data, setData] = useState<AttendanceSummary | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError('');
    api.get<AttendanceSummary>(`/reports/attendance/summary?${new URLSearchParams({ from, to })}`, controller.signal)
      .then(setData)
      .catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); });
    return () => controller.abort();
  }, [api, from, to]);

  const max = useMemo(() => Math.max(1, ...(data?.days.map(d => d.visits) ?? [0])), [data]);
  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Spinner />;
  const t = data.totals;
  const n = (value: number) => value.toLocaleString('en-US');
  return (
    <>
      <div className="stats">
        <div className="stat"><strong>{n(t.visits)}</strong><span>Visits</span></div>
        <div className="stat"><strong>{n(t.uniqueStudents)}</strong><span>Unique students</span></div>
        <div className="stat">
          <strong>{t.averageVerifiedMinutes === null ? '—' : `${Math.round(t.averageVerifiedMinutes)} min`}</strong>
          <span>Average verified visit</span>
        </div>
        <div className="stat"><strong>{n(t.pendingReviewVisits)}</strong><span>Pending review</span></div>
      </div>
      <Card title="Enrollment" actions={<span className="muted small">As of {formatDateTime(data.asOf, timezone)}</span>}>
        <div className="stats">
          <div className="stat"><strong>{n(data.enrollment.activeStudents)}</strong><span>Active students</span></div>
          <div className="stat"><strong>{n(data.enrollment.math)}</strong><span>Math</span></div>
          <div className="stat"><strong>{n(data.enrollment.reading)}</strong><span>Reading</span></div>
          <div className="stat"><strong>{n(data.enrollment.both)}</strong><span>Both subjects</span></div>
        </div>
        <p className="muted small">{n(data.enrollment.inactiveStudents)} inactive students are also on file.</p>
      </Card>
      <Card title="Visits per day">
        <p className="muted small">
          Verified minutes count only closed visits that do not await manager review.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col" style={{ width: '40%' }}>Visits</th>
                <th scope="col">Students</th>
                <th scope="col">Pending review</th>
                <th scope="col">Verified hours</th>
              </tr>
            </thead>
            <tbody>
              {[...data.days].reverse().map(d => (
                <tr key={d.date}>
                  <td>{formatDate(`${d.date}T12:00:00Z`, 'UTC')}</td>
                  <td>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <div className="bar-track" style={{ flex: 1 }} aria-hidden="true">
                        <div className="bar-fill" style={{ width: `${(d.visits / max) * 100}%` }} />
                      </div>
                      <span style={{ minWidth: 32, textAlign: 'right' }}>{d.visits}</span>
                    </div>
                  </td>
                  <td>{d.students}</td>
                  <td>{d.pendingReviewVisits ? <Badge tone="amber">{d.pendingReviewVisits}</Badge> : 0}</td>
                  <td>{(d.verifiedMinutes / 60).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

const SOURCE_TONES: Record<AuditEntry['source'], 'blue' | 'green' | 'amber'> = { admin: 'blue', attendance: 'green', correction: 'amber' };
const SOURCE_LABELS: Record<AuditEntry['source'], string> = { admin: 'Admin', attendance: 'Attendance', correction: 'Correction' };

function prettyDetail(detail: string) {
  try {
    const value: unknown = JSON.parse(detail);
    if (value === null || (typeof value === 'object' && Object.keys(value as object).length === 0)) return '';
    return JSON.stringify(value, null, 2);
  } catch {
    return detail;
  }
}

function AuditTab({ api, timezone, from, to }: { api: PageProps['api']; timezone: string; from: string; to: string }) {
  const [items, setItems] = useState<AuditEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function load(next: string | null, signal?: AbortSignal) {
    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to });
      if (next) params.set('cursor', next);
      const page = await api.get<AuditPage>(`/audit?${params}`, signal);
      setItems(current => (next ? [...current, ...page.items] : page.items));
      setCursor(page.nextCursor);
      setError('');
    } catch (e) {
      if (!signal?.aborted) setError(messageOf(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setItems([]);
    setCursor(null);
    void load(null, controller.signal);
    return () => controller.abort();
  }, [api, from, to]);

  return (
    <Card title="Audit log">
      <p className="muted small">
        Every administrative change, attendance observation and correction, newest first. Entries cannot be edited or deleted.
      </p>
      <Alert>{error}</Alert>
      {!loading && !error && items.length === 0 && <EmptyState icon={Search} title="No activity in this range" />}
      <div className="audit-list">
        {items.map(entry => {
          const detail = prettyDetail(entry.detail);
          return (
            <div key={entry.key} className="audit-item">
              <div className="row">
                <strong>{humanize(entry.action)}</strong>
                <Badge tone={SOURCE_TONES[entry.source] ?? 'gray'}>{SOURCE_LABELS[entry.source] ?? entry.source}</Badge>
              </div>
              <div className="small muted">
                {formatDateTime(entry.recordedAt, timezone)} · {entry.actorName} · {humanize(entry.entityType)} {entry.entityId}
              </div>
              {detail && (
                <details>
                  <summary>Details</summary>
                  <pre>{detail}</pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
      {loading && <Spinner />}
      {cursor && !loading && (
        <div className="row">
          <Button onClick={() => void load(cursor)}>Load more</Button>
        </div>
      )}
    </Card>
  );
}
