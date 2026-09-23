import { useEffect, useState, type FormEvent } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import type { ArchiveRecord, ArchiveTable, JsonValue } from '../shared/archive-format';
import type { ArchiveCatalog, ArchiveRecordPage } from '../shared/archive-reader';
import { messageOf, request } from './api';
import { Modal } from './shared/components';
import './archive-reader.css';

const groups: [ArchiveTable, string][] = [
  ['students', 'Students at capture'], ['visits', 'Recorded visits'], ['attendance_events', 'Original observations'],
  ['attendance_corrections', 'Corrections'], ['reviews', 'Review decisions'], ['audit_entries', 'Audit history'],
  ['guardians', 'Guardians at capture'], ['student_guardians', 'Pickup relationships at capture'], ['staff', 'Staff at capture'], ['centers', 'Center details at capture'],
];
const studentGroups: ArchiveTable[] = ['students', 'visits', 'attendance_events', 'reviews', 'student_guardians'];
const label = (name: string) => ({ result_visit: 'Accepted attendance response', check_in_at: 'Effective arrival', check_out_at: 'Effective departure', original_check_in_at: 'Original arrival', original_check_out_at: 'Original departure', check_in_by: 'Arrival recorded by (reference)', check_out_by: 'Departure recorded by (reference)', payload_hash: 'Request fingerprint', insertion_nonce: 'Insertion reference' }[name] || name.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase()));
const date = (value: string, timezone?: string) => { try { return new Date(value).toLocaleString([], timezone ? { timeZone: timezone, timeZoneName: 'short' } : {}); } catch { return value; } };
const display = (value: JsonValue): string => value === null ? 'Not recorded' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
function heading(record: ArchiveRecord, timezone: string) {
  const row = record.row;
  if (record.table === 'students') return `${row.first_name} ${row.last_name} · ${row.student_code}`;
  if (row.display_name) return String(row.display_name);
  if (record.table === 'visits') return `Arrival ${date(String(row.original_check_in_at), timezone)}`;
  if (record.table === 'attendance_events') return `${String(row.action).replaceAll('_', ' ')} · ${date(String(row.observed_at), timezone)}`;
  if (record.table === 'attendance_corrections') return `Correction · ${date(String(row.recorded_at), timezone)}`;
  if (record.table === 'reviews') return `Review · ${String(row.status)}`;
  if (record.table === 'audit_entries') return `${String(row.action).replaceAll('_', ' ')} · ${date(String(row.created_at), timezone)}`;
  return record.table === 'centers' ? String(row.name) : `Pickup relationship · ${String(row.relationship || 'Not recorded')}`;
}
function Evidence({ record, onStudent, timezone }: { record: ArchiveRecord; timezone: string; onStudent: (record: ArchiveRecord) => void }) {
  const reference = (key: string) => key === 'id' || key.endsWith('_id') || key.endsWith('_hash') || key.endsWith('_nonce');
  const fields = Object.entries(record.row).filter(([key]) => !reference(key));
  const references = Object.entries(record.row).filter(([key]) => reference(key));
  return <article className="cf-archive-record">
    <div className="cf-inline-actions" style={{ justifyContent: 'space-between' }}><strong>{heading(record, timezone)}</strong>{record.table === 'students' && <button className="btn btn-secondary btn-sm" onClick={() => onStudent(record)}>Review attendance</button>}</div>
    <details><summary>View recorded details</summary><dl>{fields.map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{key.endsWith('_at') && typeof value === 'string' ? `${date(value, timezone)} (${value})` : display(value)}</dd></div>)}</dl>
      {references.length > 0 && <details><summary>Record references</summary><dl>{references.map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{key.endsWith('_at') && typeof value === 'string' ? `${date(value, timezone)} (${value})` : display(value)}</dd></div>)}</dl></details>}
    </details>
  </article>;
}

export default function ArchiveReader({ initialArchiveId, onClose }: { initialArchiveId?: string; onClose: () => void }) {
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(initialArchiveId || '');
  const [catalog, setCatalog] = useState<ArchiveCatalog | null>(null), [catalogCursor, setCatalogCursor] = useState(''), [catalogBack, setCatalogBack] = useState<string[]>([]);
  const [month, setMonth] = useState(''), [catalogMonth, setCatalogMonth] = useState('');
  const [table, setTable] = useState<ArchiveTable>('students');
  const [draft, setDraft] = useState({ q: '', recordId: '', studentId: '' }), [filters, setFilters] = useState(draft);
  const [studentName, setStudentName] = useState('');
  const [cursor, setCursor] = useState(''), [back, setBack] = useState<string[]>([]);
  const [page, setPage] = useState<ArchiveRecordPage | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (selected) return;
    const controller = new AbortController(); setCatalog(null); setError(''); setBusy(true);
    const query = new URLSearchParams({ limit: '10', ...(catalogMonth ? { month: catalogMonth } : {}), ...(catalogCursor ? { cursor: catalogCursor } : {}) });
    void request<ArchiveCatalog>(`/api/admin/archive-history?${query}`, { signal: controller.signal }).then(value => { if (!controller.signal.aborted) setCatalog(value); }).catch(failure => { if (!controller.signal.aborted) setError(messageOf(failure)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [selected, catalogMonth, catalogCursor, reload]);
  useEffect(() => {
    setPage(null); if (!selected) return;
    const controller = new AbortController(); setError(''); setBusy(true);
    const query = { table, limit: 25, ...filters, ...(cursor ? { cursor } : {}) };
    void request<ArchiveRecordPage>(`/api/admin/archive-history/${encodeURIComponent(selected)}/records/query`, { method: 'POST', body: JSON.stringify(query), signal: controller.signal }).then(value => { if (!controller.signal.aborted) setPage(value); }).catch(failure => { if (!controller.signal.aborted) setError(messageOf(failure)); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [selected, table, filters, cursor, reload]);
  const resetPage = () => { setCursor(''); setBack([]); };
  const choose = (id: string) => { setSelected(id); setTable('students'); setFilters({ q: '', recordId: '', studentId: '' }); setDraft({ q: '', recordId: '', studentId: '' }); setStudentName(''); resetPage(); };
  const search = (event: FormEvent) => { event.preventDefault(); setFilters({ ...draft }); resetPage(); };
  const pickStudent = (record: ArchiveRecord) => { const next = { q: '', recordId: '', studentId: String(record.row.id) }; setTable('visits'); setFilters(next); setDraft(next); setStudentName(`${record.row.first_name} ${record.row.last_name}`); resetPage(); };
  return <Modal title="Review historical copies" subtitle="Read-only records from a completed monthly copy." wide onClose={onClose}>
    <div className="cf-archive-reader">
      <div className="cf-notice">These are copies captured at a point in time. Attendance remains in the live database; later corrections may differ. This view does not change records or authorize current pickup.</div>
      {selected ? <>
        <button className="text-button" onClick={() => { setSelected(''); resetPage(); }}><ArrowLeft size={14} />All historical copies</button>
        {page && <p className="cf-table-note">{page.snapshot.month} · Captured {date(page.snapshot.capturedAt, page.snapshot.timezone)} · Copy verified {date(page.snapshot.verifiedAt, page.snapshot.timezone)} · {page.snapshot.timezone}</p>}
        <form className="cf-archive-filters" onSubmit={search}>
          <label className="field"><span>Evidence</span><select aria-label="Evidence" value={table} onChange={event => { const next = event.target.value as ArchiveTable; setTable(next); const clean = { ...filters, recordId: '', ...(studentGroups.includes(next) ? {} : { studentId: '' }) }; setDraft(clean); setFilters(clean); if (!studentGroups.includes(next)) setStudentName(''); resetPage(); }}>{groups.map(([value, name]) => <option value={value} key={value}>{name}</option>)}</select></label>
          <label className="field"><span>Name, reference, or note</span><input maxLength={100} value={draft.q} onChange={event => setDraft(current => ({ ...current, q: event.target.value }))} /></label>
          <label className="field"><span>Exact record reference</span><input maxLength={210} value={draft.recordId} onChange={event => setDraft(current => ({ ...current, recordId: event.target.value }))} /></label>
          {studentGroups.includes(table) && <label className="field"><span>Student reference{studentName ? ` · ${studentName}` : ''}</span><input maxLength={100} value={draft.studentId} onChange={event => { setStudentName(''); setDraft(current => ({ ...current, studentId: event.target.value })); }} /></label>}
          <button className="btn btn-primary" disabled={busy}><Search size={15} />Review records</button>
        </form>
        {page && <>
          <p className="cf-table-note">Page {back.length + 1} · {page.items.length} matching {page.items.length === 1 ? 'record' : 'records'} on this page. Each page is checked when opened; other files are not rechecked by this request.</p>
          {page.items.length ? page.items.map(record => <Evidence key={`${record.table}:${record.key}`} record={record} timezone={page.snapshot.timezone} onStudent={pickStudent} />) : <p role="status">{page.nextCursor ? 'No matches on this page. More archived records remain to check.' : 'No matches on this final page.'}</p>}
          <div className="cf-inline-actions cf-archive-pagination"><button className="btn btn-secondary" disabled={busy || !back.length} onClick={() => { setCursor(back.at(-1)!); setBack(current => current.slice(0, -1)); }}>Previous page</button><button className="btn btn-secondary" disabled={busy || !page.nextCursor} onClick={() => { setBack(current => [...current, cursor]); setCursor(page.nextCursor!); }}>Next page</button>{page.searchComplete && <span className="cf-table-note">End of this review.</span>}</div>
        </>}
      </> : <>
        <form className="cf-inline-actions" onSubmit={event => { event.preventDefault(); setCatalogMonth(month); setCatalogCursor(''); setCatalogBack([]); }}><label className="field"><span>Month (optional)</span><input type="month" value={month} onChange={event => setMonth(event.target.value)} /></label><button className="btn btn-secondary" disabled={busy}>Find copies</button></form>
        {catalog && <><div className="cf-archive-catalog">{catalog.items.map(copy => <button key={copy.id} className="cf-archive-copy" onClick={() => choose(copy.id)}><strong>{copy.month}</strong><span>Captured {date(copy.capturedAt, copy.timezone)}</span><span>Review records →</span></button>)}</div>{!catalog.items.length && <p>No completed copies were found for this selection.</p>}<div className="cf-inline-actions cf-archive-pagination"><button className="btn btn-secondary" disabled={busy || !catalogBack.length} onClick={() => { setCatalogCursor(catalogBack.at(-1)!); setCatalogBack(current => current.slice(0, -1)); }}>Previous copies</button><button className="btn btn-secondary" disabled={busy || !catalog.nextCursor} onClick={() => { setCatalogBack(current => [...current, catalogCursor]); setCatalogCursor(catalog.nextCursor!); }}>More copies</button></div></>}
      </>}
      {busy && <p role="status">Verifying historical records...</p>}
      {error && <div className="cf-notice error" role="alert">{error}<button className="btn btn-secondary btn-sm" onClick={() => setReload(value => value + 1)}>Try again</button></div>}
      <p className="cf-table-note">Historical records stay in this tab's memory and are not saved as an offline copy.</p>
    </div>
  </Modal>;
}
