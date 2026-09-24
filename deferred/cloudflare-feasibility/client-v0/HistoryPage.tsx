import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { collectAttendanceExport } from './attendance-export';
import { ArrowDownToLine, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react';
import { Badge, EmptyState } from './shared/components';
import type { Actor, Center, Page, VisitSummary } from '../shared/types';
import { messageOf, request } from './api';
import { centerDay, displayDate, displayTime } from './utils';
import ReviewPanel from './ReviewPanel';
import type { ObservationCorrectionDraft } from './ObservationCorrections';
import AttendanceSummary, { reportDateOffset } from './AttendanceSummary';

export default function HistoryPage({ center, actor, onStudent, onCorrect, observationCorrectionDraft, onObservationCorrectionBusyChange, onAccessExpired, revision = 0 }: { center: Center; actor: Actor; onStudent: (id: string) => void; onCorrect: (visit: VisitSummary) => void; observationCorrectionDraft: MutableRefObject<ObservationCorrectionDraft | null>; onObservationCorrectionBusyChange: (busy: boolean) => void; onAccessExpired: () => void; revision?: number }) {
  const today = centerDay(new Date().toISOString(), center.timezone);
  const [from, setFrom] = useState(reportDateOffset(today, -6));
  const [to, setTo] = useState(today);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Page<VisitSummary> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [exportProgress, setExportProgress] = useState(0);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => {
    setExporting(false); setExportError(''); setExportProgress(0);
    return () => { exportController.current?.abort(); exportController.current = null; };
  }, [from, to]);
  async function exportAttendance() {
    if (exportController.current) return;
    const controller = new AbortController(); exportController.current = controller;
    setExporting(true); setExportError(''); setExportProgress(0);
    try {
      const report = await collectAttendanceExport(from, to, { signal: controller.signal, onProgress: setExportProgress });
      if (controller.signal.aborted || exportController.current !== controller) return;
      const url = URL.createObjectURL(new Blob([report.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = report.filename;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (exportController.current === controller) setExportError(`${messageOf(failure)} No file was downloaded.`);
    } finally {
      if (exportController.current === controller) { exportController.current = null; setExporting(false); }
    }
  }
  function cancelExport() {
    exportController.current?.abort(); exportController.current = null;
    setExporting(false); setExportError('Export cancelled. No file was downloaded.');
  }
  const valid = Boolean(from && to && from <= to && (Date.parse(to) - Date.parse(from)) / 86400000 <= 365);
  function setPreset(days: number) { if (exportController.current) cancelExport(); setFrom(reportDateOffset(today, 1 - days)); setTo(today); setPage(1); }
  useEffect(() => { let current = true; if (!valid) { setResult(null); setLoading(false); return; } setLoading(true); setError(''); request<Page<VisitSummary>>(`/api/admin/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&page=${page}&pageSize=25`).then(data => { if (current) setResult(data); }).catch(failure => { if (current) { setError(messageOf(failure)); setResult(null); } }).finally(() => { if (current) setLoading(false); }); return () => { current = false; }; }, [from, to, page, valid, revision]);
  return <><div className="page-heading"><div><div className="eyebrow">ATTENDANCE HISTORY</div><h1>Every recorded visit.</h1><p>Review recent attendance by date. Original observations stay in the student's record.</p></div>{['owner', 'manager'].includes(actor.role) && valid && <div className="cf-inline-actions"><button className="btn btn-secondary" type="button" disabled={exporting} onClick={exportAttendance}><ArrowDownToLine size={16} />{exporting ? 'Preparing export…' : 'Export attendance'}</button>{exporting && <button className="btn btn-secondary" type="button" onClick={cancelExport}>Cancel</button>}</div>}</div><div className="cf-inline-actions" style={{ marginBottom: 24, flexWrap: 'wrap' }}><label className="field"><span>From</span><input aria-label="Report start date" type="date" value={from} max={to} onChange={event => { if (exportController.current) cancelExport(); setFrom(event.target.value); setPage(1); }} /></label><label className="field"><span>To</span><input aria-label="Report end date" type="date" value={to} min={from} onChange={event => { if (exportController.current) cancelExport(); setTo(event.target.value); setPage(1); }} /></label><div className="cf-report-presets"><button type="button" className="btn btn-secondary btn-sm" aria-pressed={from === reportDateOffset(today, -6) && to === today} onClick={() => setPreset(7)}>Last 7 days</button><button type="button" className="btn btn-secondary btn-sm" aria-pressed={from === reportDateOffset(today, -29) && to === today} onClick={() => setPreset(30)}>Last 30 days</button></div></div>{!valid && <div className="cf-notice amber">Choose a valid date range of at most 366 days.</div>}{exporting && <div className="cf-notice" role="status">Preparing attendance export · {exportProgress.toLocaleString()} records received.</div>}{exportError && <div className="cf-notice error" role="alert">{exportError}</div>}{error && <div className="cf-notice error" role="alert">{error} No current history is displayed.</div>}{valid && <AttendanceSummary from={from} to={to} revision={revision} />}<section className="card"><div className="cf-roster-heading"><div><h2>Recorded visits</h2><p>Dates and times use {center.timezone.replaceAll('_', ' ')}.</p></div></div>{loading ? <p className="cf-table-note">Loading attendance...</p> : result?.items.length ? <><div className="table-wrap"><table className="data-table cf-data-table"><thead><tr><th>Student</th><th>Date</th><th>Arrival</th><th>Departure</th><th>Duration</th><th>Review</th><th>Correction</th></tr></thead><tbody>{result.items.map(visit => <tr key={visit.id}><td><button className="cf-student-button" onClick={() => onStudent(visit.studentId)}><span><strong>{visit.studentName}</strong><small>{visit.studentCode}</small></span></button></td><td>{displayDate(visit.checkInAt, center.timezone)}</td><td>{displayTime(visit.checkInAt, center.timezone)}</td><td>{visit.checkOutAt ? displayTime(visit.checkOutAt, center.timezone) : visit.reviewStatus === 'pending' ? 'Presence unverified' : 'Still checked in'}</td><td>{visit.reviewStatus === 'pending' ? 'Needs review' : visit.checkOutAt ? `${Math.max(0, Math.round((new Date(visit.checkOutAt).getTime() - new Date(visit.checkInAt).getTime()) / 60000))} min` : 'In progress'}</td><td><Badge tone={visit.reviewStatus === 'pending' ? 'amber' : 'gray'}>{visit.reviewStatus === 'pending' ? 'Needs review' : visit.reviewStatus === 'resolved' ? 'Reviewed' : 'No pending review'}</Badge></td><td><button className="text-button" onClick={() => onCorrect(visit)}>Correct times</button></td></tr>)}</tbody></table></div><div className="cf-pagination"><span>{result.total} recorded visits · Page {result.page}</span><div><button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(current => current - 1)}><ChevronLeft size={14} />Previous</button><button className="btn btn-secondary btn-sm" disabled={page * result.pageSize >= result.total} onClick={() => setPage(current => current + 1)}>Next<ChevronRight size={14} /></button></div></div></> : <EmptyState icon={Clock3} title="No recorded visits in this range" description="Try another date range or record a student's first observed arrival." />}</section><ReviewPanel center={center} actor={actor} from={from} to={to} onStudent={onStudent} correctionDraft={observationCorrectionDraft} onCorrectionBusyChange={onObservationCorrectionBusyChange} onAccessExpired={onAccessExpired} /></>;
}
