import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, History, RefreshCw } from 'lucide-react';
import type { AuditActivityPage, AuditFilters, AuditSource } from '../shared/audit-reader';
import { EmptyState } from './shared/components';
import { messageOf, request } from './api';
import { centerDay, displayDate } from './utils';
import './audit-activity.css';

const initialFilters = (timezone: string): AuditFilters => {
  const to = centerDay(new Date().toISOString(), timezone);
  return { from: new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86400000).toISOString().slice(0, 10), to, actor: '', action: '', entityType: '', entityId: '' };
};
const sources: Record<AuditSource, string> = { 'stored-audit': 'Stored audit entry', 'attendance-event-projection': 'Immutable attendance observation', 'attendance-correction-projection': 'Immutable attendance correction' };
export default function AuditActivity({ timezone }: { timezone: string }) {
  const [form, setForm] = useState(() => initialFilters(timezone)), [filters, setFilters] = useState(form);
  const [cursors, setCursors] = useState<(string | null)[]>([null]), [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<AuditActivityPage | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  useEffect(() => { const value = initialFilters(timezone); setForm(value); setFilters(value); setCursors([null]); }, [timezone]);
  useEffect(() => {
    const controller = new AbortController(); let current = true; setLoading(true); setError(''); setResult(null);
    void request<AuditActivityPage>('/api/admin/audit/query', { method: 'POST', body: JSON.stringify({ ...filters, limit: 25, cursor: cursors.at(-1) }), signal: controller.signal })
      .then(value => { if (current) setResult(value); })
      .catch(failure => { if (current) setError(messageOf(failure)); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [filters, cursors, refresh]);
  const update = (key: keyof AuditFilters, value: string) => setForm(current => ({ ...current, [key]: value }));
  const search = (event: FormEvent) => { event.preventDefault(); setFilters({ ...form }); setCursors([null]); };
  const reset = () => { const value = initialFilters(timezone); setForm(value); setFilters(value); setCursors([null]); };
  const clock = (value: string) => new Intl.DateTimeFormat('en-US', { timeZone: result?.range.timezone || timezone, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(value));
  return <section className="card cf-settings-card cf-settings-wide cf-audit-activity" aria-label="Audit activity">
    <div className="cf-inline-actions" style={{ justifyContent: 'space-between' }}><div><h2>Audit activity</h2><p>Review who recorded an action, when it was recorded, and the affected record.</p></div><button className="btn btn-secondary btn-sm" disabled={loading} onClick={() => { setCursors([null]); setRefresh(value => value + 1); }}><RefreshCw size={14} />Refresh activity</button></div>
    <p className="cf-table-note">Read-only activity from the current database. Attendance records remain here while storage cleanup is disabled. Historical copies can be reviewed separately above.</p>
    <form onSubmit={search} className="cf-audit-filters">
      <label className="field"><span>From</span><input type="date" required min="2000-01-01" max={form.to || '2099-12-31'} value={form.from} onChange={event => update('from', event.target.value)} /></label>
      <label className="field"><span>To</span><input type="date" required min={form.from || '2000-01-01'} max="2099-12-31" value={form.to} onChange={event => update('to', event.target.value)} /></label>
      <label className="field"><span>Staff name contains</span><input aria-label="Audit staff name" maxLength={100} value={form.actor} onChange={event => update('actor', event.target.value)} placeholder="Any staff member" /></label>
      <label className="field"><span>Action</span><input aria-label="Audit action" maxLength={64} pattern="[a-z][a-z0-9_]*" list="cf-audit-actions" value={form.action} onChange={event => update('action', event.target.value)} placeholder="Any action" /><datalist id="cf-audit-actions">{['check_in', 'check_out', 'exceptional_departure', 'attendance_correction', 'student_created', 'student_updated', 'guardian_authority_updated', 'interaction_logged', 'inquiry_created', 'inquiry_updated', 'inquiry_converted', 'schedule_created', 'center_updated', 'staff_created', 'staff_updated'].map(action => <option key={action} value={action} />)}</datalist></label>
      <label className="field"><span>Record type</span><input aria-label="Audit record type" maxLength={64} pattern="[a-z][a-z0-9_]*" list="cf-audit-types" value={form.entityType} onChange={event => update('entityType', event.target.value)} placeholder="Any record type" /><datalist id="cf-audit-types">{['student', 'attendance_event', 'visit', 'inquiry', 'task', 'interaction', 'schedule', 'review', 'center', 'staff', 'kiosk_device', 'report', 'archive'].map(type => <option key={type} value={type} />)}</datalist></label>
      <label className="field"><span>Exact record ID</span><input aria-label="Audit record ID" maxLength={100} pattern="[A-Za-z0-9_-]+" value={form.entityId} onChange={event => update('entityId', event.target.value)} placeholder="Any record ID" /></label>
      <div className="cf-inline-actions cf-audit-filter-actions"><button className="btn btn-primary" disabled={loading}>Apply filters</button><button type="button" className="btn btn-secondary" disabled={loading} onClick={reset}>Reset filters</button><span className="cf-table-note">Choose up to 31 days. Dates use {timezone.replaceAll('_', ' ')}. Filters stay out of the page address.</span></div>
    </form>
    {error && <div className="cf-notice error" role="alert">{error} Activity could not be read. This is not an empty history result.</div>}
    {loading ? <p className="cf-table-note" role="status">Reading audit activity...</p> : result && <>
      {result.items.length ? <div className="table-wrap"><table className="data-table cf-audit-table"><thead><tr><th>Recorded at</th><th>Staff member</th><th>Action</th><th>Record</th><th>Source and detail</th></tr></thead><tbody>{result.items.map(item => <tr key={item.id}>
        <td>{displayDate(item.recordedAt, result.range.timezone)}<small>{clock(item.recordedAt)}</small></td><td><strong>{item.actorName || 'No name recorded'}</strong><small>{item.actorId || 'No staff ID recorded'}</small></td><td><code>{item.action}</code></td><td><span>{item.entityType}</span><small>{item.entityId}</small></td>
        <td><span>{sources[item.source]}</span><details><summary>View recorded detail</summary><p className="cf-table-note">Audit ID: {item.id}</p><pre>{item.detail}</pre>{item.detailTruncated && <p className="cf-notice amber">Detail exceeds the display limit. Only the first 4,000 characters are shown.</p>}</details></td>
      </tr>)}</tbody></table></div> : <EmptyState icon={History} title="No matching entries on this page" description={result.nextCursor ? 'More activity remains in this date range. Continue to the next page or narrow the dates.' : 'No more matching entries remain in the selected date range.'} />}
      <div className="cf-pagination"><span>{result.items.length} entries shown · {result.scanned} activity records checked · Page {cursors.length}</span><div><button className="btn btn-secondary btn-sm" disabled={loading || cursors.length === 1} onClick={() => setCursors(current => current.slice(0, -1))}><ArrowLeft size={14} />Previous</button><button className="btn btn-secondary btn-sm" disabled={loading || !result.nextCursor} onClick={() => setCursors(current => [...current, result.nextCursor])}>Older activity<ArrowRight size={14} /></button></div></div>
      <p className="cf-table-note">{result.searchComplete ? 'End of this date range.' : 'More activity remains in this date range.'} Read at {displayDate(result.asOf, result.range.timezone)} {clock(result.asOf)}. Refresh to include newly recorded actions.</p>
    </>}
  </section>;
}
