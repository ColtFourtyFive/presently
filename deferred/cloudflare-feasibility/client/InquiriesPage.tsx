import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { ArrowRight, Check, ChevronLeft, ChevronRight, Clock3, Mail, MessageCircle, Phone, Plus, RefreshCw, Search, UserPlus } from 'lucide-react';
import type { Center, Page } from '../shared/types';
import { inquiryStages, type FollowUpTask, type Inquiry, type InquiryConversion, type InquiryHistory, type InquiryInput, type InquiryList, type InquiryStage, type InquiryUpdate } from '../shared/inquiries';
import { RequestError, messageOf, request, send } from './api';
import { Avatar, Badge, EmptyState, Modal } from './shared/components';
import { centerDay, displayDate, displayTime } from './utils';
import './InquiriesPage.css';

const activeStages = inquiryStages.slice(0, 4);
const blank = (): InquiryInput => ({ inquiryId: crypto.randomUUID(), contactName: '', studentName: '', email: '', phone: '', subjects: ['Math'], source: 'Website', nextAction: '', dueAt: null, notes: '' });
// A date-only follow-up is stored at noon in the center's timezone, as on Railway.
function dueDate(day: string, zone: string) {
  if (!day) return null;
  const target = Date.parse(`${day}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(target));
  const part = (name: Intl.DateTimeFormatPartTypes) => Number(parts.find(item => item.type === name)?.value);
  return new Date(target - (Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second')) - target)).toISOString();
}
function Pager({ page, total, pageSize, busy, onPage }: { page: number; total: number; pageSize: number; busy: boolean; onPage: (page: number) => void }) {
  return <div className="cf-pagination"><span>{total} {total === 1 ? 'record' : 'records'} · Page {page} of {Math.max(1, Math.ceil(total / pageSize))}</span><div><button className="btn btn-secondary btn-sm" disabled={busy || page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={14} />Previous</button><button className="btn btn-secondary btn-sm" disabled={busy || page * pageSize >= total} onClick={() => onPage(page + 1)}>Next<ChevronRight size={14} /></button></div></div>;
}
function AddInquiry({ center, retained, onRetain, onBusy, onSaved, onClose, onFailure }: {
  center: Center; retained: InquiryInput | null; onRetain: (input: InquiryInput | null) => void; onBusy: (busy: boolean) => void;
  onSaved: (inquiry: Inquiry) => void; onClose: () => void; onFailure: (failure: unknown) => void;
}) {
  const [form, setForm] = useState<InquiryInput>(() => retained || blank()), [day, setDay] = useState(retained?.dueAt ? centerDay(retained.dueAt, center.timezone) : '');
  const [sending, setSending] = useState(false), [uncertain, setUncertain] = useState(Boolean(retained)), [error, setError] = useState(retained ? 'A previous save was not confirmed. Retry the same inquiry to check its result.' : '');
  const inFlight = useRef(false);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (inFlight.current) return; inFlight.current = true; setSending(true); setError(''); onBusy(true);
    const data = retained || { ...form, dueAt: dueDate(day, center.timezone) }; onRetain(data);
    try {
      const result = await send<{ inquiry: Inquiry }>('/api/admin/inquiries', data);
      onRetain(null); setUncertain(false); onSaved(result.inquiry);
    } catch (failure) {
      if (!(failure instanceof RequestError) || failure.uncertain) { setUncertain(true); setError('The save result is unknown. Retry the same inquiry when connected. This cannot create a second copy.'); }
      else { onRetain(null); setUncertain(false); setError(messageOf(failure)); onFailure(failure); }
    } finally { inFlight.current = false; setSending(false); onBusy(false); }
  };
  const update = (field: keyof InquiryInput, value: string) => setForm(current => ({ ...current, [field]: value }));
  return <Modal title="New family inquiry" subtitle="Save their contact details and the next step for your team." onClose={() => !sending && !uncertain && onClose()} wide><form className="cf-attendance" onSubmit={save}>
    <fieldset className="cf-inquiry-fields" disabled={sending || uncertain}><div className="cf-form-grid">
      <label className="field"><span>Contact name</span><input required maxLength={200} value={form.contactName} onChange={event => update('contactName', event.target.value)} autoFocus /></label>
      <label className="field"><span>Student name</span><input required maxLength={200} value={form.studentName} onChange={event => update('studentName', event.target.value)} /></label>
      <label className="field"><span>Email</span><input type="email" maxLength={254} value={form.email} onChange={event => update('email', event.target.value)} /></label>
      <label className="field"><span>Phone</span><input type="tel" maxLength={40} value={form.phone} onChange={event => update('phone', event.target.value)} /></label>
      <div className="field"><span>Subjects of interest</span><div className="cf-subject-options">{(['Math', 'Reading'] as const).map(subject => <label key={subject}><input type="checkbox" checked={form.subjects.includes(subject)} onChange={event => setForm(current => ({ ...current, subjects: event.target.checked ? [...current.subjects, subject] : current.subjects.filter(item => item !== subject) }))} />{subject}</label>)}</div></div>
      <label className="field"><span>Inquiry source</span><input required maxLength={200} value={form.source} onChange={event => update('source', event.target.value)} /></label>
      <label className="field"><span>Next step</span><input maxLength={300} value={form.nextAction} onChange={event => update('nextAction', event.target.value)} placeholder="Call to arrange an assessment" /></label>
      <label className="field"><span>Due date</span><input type="date" value={day} onChange={event => setDay(event.target.value)} /></label>
      <label className="field cf-form-wide"><span>Notes</span><textarea aria-label="Notes" rows={3} maxLength={2000} value={form.notes} onChange={event => update('notes', event.target.value)} /></label>
    </div></fieldset>
    <p className="cf-inquiry-hint">Provide an email address or phone number. A next step without a date is due tomorrow. Dates use {center.timezone.replaceAll('_', ' ')}.</p>
    {error && <div className={`cf-notice ${uncertain ? 'amber' : 'error'}`} role="alert">{error}</div>}
    <div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={sending || uncertain} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={sending}>{sending ? 'Saving...' : uncertain ? 'Retry same inquiry' : 'Add inquiry'}</button></div>
  </form></Modal>;
}
function InquiryDialog({ initial, center, onBusy, onChanged, onClose, onStudent, onFailure }: {
  initial: Inquiry; center: Center; onBusy: (busy: boolean) => void; onChanged: () => void; onClose: () => void; onStudent: (id: string) => void; onFailure: (failure: unknown) => void;
}) {
  const [row, setRow] = useState(initial), [edit, setEdit] = useState(() => ({ stage: initial.stage, nextAction: initial.nextAction, day: initial.dueAt ? centerDay(initial.dueAt, center.timezone) : '', notes: initial.notes, ownerName: initial.ownerName }));
  const [grade, setGrade] = useState(''), [enrolling, setEnrolling] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [needsReload, setNeedsReload] = useState(false), [history, setHistory] = useState<Page<InquiryHistory> | null>(null), [historyPage, setHistoryPage] = useState(1);
  const [historyError, setHistoryError] = useState(''); const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); setHistoryError('');
    void request<Page<InquiryHistory>>(`/api/admin/inquiries/${row.id}/history?page=${historyPage}&pageSize=5`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setHistory(value); }).catch(failure => { if (!controller.signal.aborted) { setHistoryError(messageOf(failure)); onFailure(failure); } });
    return () => controller.abort();
  }, [row.id, row.version, historyPage]);
  const reload = async () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); onBusy(true);
    try { const result = await request<{ inquiry: Inquiry }>(`/api/admin/inquiries/${row.id}`); setRow(result.inquiry); setEdit({ stage: result.inquiry.stage, nextAction: result.inquiry.nextAction, day: result.inquiry.dueAt ? centerDay(result.inquiry.dueAt, center.timezone) : '', notes: result.inquiry.notes, ownerName: result.inquiry.ownerName }); setNeedsReload(false); setEnrolling(false); setError(''); onChanged(); }
    catch (failure) { setError(messageOf(failure)); onFailure(failure); }
    finally { inFlight.current = false; setBusy(false); onBusy(false); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (inFlight.current || needsReload) return; inFlight.current = true; setBusy(true); onBusy(true); setError('');
    const input: InquiryUpdate = { expectedVersion: row.version, stage: edit.stage, nextAction: edit.nextAction, notes: edit.notes, ownerName: edit.ownerName,
      dueAt: edit.day === (row.dueAt ? centerDay(row.dueAt, center.timezone) : '') ? row.dueAt : dueDate(edit.day, center.timezone) };
    try { await send(`/api/admin/inquiries/${row.id}`, input, 'PATCH'); onChanged(); onClose(); }
    catch (failure) { setError(messageOf(failure)); if (!(failure instanceof RequestError) || failure.uncertain || failure.code === 'STALE_INQUIRY') setNeedsReload(true); onFailure(failure); }
    finally { inFlight.current = false; setBusy(false); onBusy(false); }
  };
  const convert = async () => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); onBusy(true); setError('');
    try { const result = await send<InquiryConversion>(`/api/admin/inquiries/${row.id}/convert`, { grade }); setRow(result.inquiry); setEdit({ stage: result.inquiry.stage, nextAction: '', day: '', notes: result.inquiry.notes, ownerName: result.inquiry.ownerName }); setEnrolling(false); onChanged(); }
    catch (failure) { setError(`${messageOf(failure)}${!(failure instanceof RequestError) || failure.uncertain ? ' You can retry enrollment safely; it creates at most one student.' : ''}`); onFailure(failure); }
    finally { inFlight.current = false; setBusy(false); onBusy(false); }
  };
  const dirty = edit.stage !== row.stage || edit.nextAction !== row.nextAction || edit.notes !== row.notes || edit.ownerName !== row.ownerName || edit.day !== (row.dueAt ? centerDay(row.dueAt, center.timezone) : '');
  return <Modal title={row.studentName} subtitle={`Family inquiry · ${row.source}`} onClose={() => !busy && onClose()} wide>
    <div className="cf-inquiry-contact"><Avatar name={row.contactName} /><div><strong>{row.contactName}</strong><span>{row.email && <a href={`mailto:${row.email}`}><Mail size={13} />{row.email}</a>}{row.phone && <a href={`tel:${row.phone}`}><Phone size={13} />{row.phone}</a>}</span></div></div>
    <p className="cf-inquiry-hint">Subjects: {row.subjects.join(' and ') || 'Not yet selected'}</p>
    {row.convertedStudentId && <div className="cf-notice success">Enrolled. The student record retains this family's contact details. Guardian pickup authority starts unverified.<button className="text-button" disabled={busy} onClick={() => { onClose(); onStudent(row.convertedStudentId!); }}>View student<ArrowRight size={14} /></button></div>}
    <form className="cf-attendance" onSubmit={save}><fieldset className="cf-inquiry-fields" disabled={busy || enrolling || needsReload}><div className="cf-form-grid">
      <label className="field"><span>Inquiry stage</span><select aria-label="Inquiry stage" value={edit.stage} disabled={!!row.convertedStudentId} onChange={event => setEdit(current => ({ ...current, stage: event.target.value as InquiryStage }))}>{inquiryStages.filter(stage => stage !== 'Enrolled' || row.convertedStudentId).map(stage => <option key={stage}>{stage}</option>)}</select></label>
      <label className="field"><span>Assigned to</span><input maxLength={200} value={edit.ownerName} onChange={event => setEdit(current => ({ ...current, ownerName: event.target.value }))} /></label>
      <label className="field"><span>Next step</span><input maxLength={300} value={edit.nextAction} onChange={event => setEdit(current => ({ ...current, nextAction: event.target.value }))} /></label>
      <label className="field"><span>Due date</span><input type="date" value={edit.day} onChange={event => setEdit(current => ({ ...current, day: event.target.value }))} /></label>
      <label className="field cf-form-wide"><span>Notes</span><textarea aria-label="Notes" maxLength={2000} rows={3} value={edit.notes} onChange={event => setEdit(current => ({ ...current, notes: event.target.value }))} /></label>
    </div></fieldset>
    {error && <div className="cf-notice error" role="alert">{error}</div>}
    {needsReload ? <div className="modal-actions"><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void reload()}>Reload saved inquiry</button></div> : enrolling ? <div className="cf-enrollment-confirm">
      <h3>Enroll {row.studentName}</h3><p>This creates one active student with {row.subjects.join(' and ') || 'Math'} and the saved guardian contact. Any pending follow-up is completed. Pickup authority must be verified separately.</p>
      <label className="field"><span>Grade · optional</span><input maxLength={30} value={grade} disabled={busy} onChange={event => setGrade(event.target.value)} /></label>
      <div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEnrolling(false)}>Back</button><button type="button" className="btn btn-primary" disabled={busy} onClick={() => void convert()}>{busy ? 'Enrolling...' : 'Confirm enrollment'}</button></div>
    </div> : <div className="modal-actions cf-inquiry-actions">{!row.convertedStudentId && !['Closed lost', 'Do not contact'].includes(row.stage) ? <button type="button" className="btn btn-secondary" disabled={busy || dirty} title={dirty ? 'Save your changes before enrolling.' : undefined} onClick={() => setEnrolling(true)}><UserPlus size={15} />Enroll student</button> : <span />}<button className="btn btn-primary" disabled={busy}>{busy ? 'Saving...' : 'Save changes'}</button></div>}
    {dirty && !enrolling && <p className="cf-inquiry-hint">Save your changes before enrolling. Closing this window discards unsaved edits.</p>}
    </form>
    <section className="cf-inquiry-history"><h3>Stage history</h3>{historyError ? <p role="alert">{historyError}</p> : history?.items.map(entry => <div key={entry.id}><strong>{entry.fromStage ? `${entry.fromStage} → ${entry.toStage}` : entry.toStage}</strong><small>{entry.actorName} · {displayDate(entry.createdAt, center.timezone)} {displayTime(entry.createdAt, center.timezone)}</small></div>)}{history && history.total > history.pageSize && <Pager {...history} busy={busy} onPage={setHistoryPage} />}</section>
  </Modal>;
}

export default function InquiriesPage({ center, onAccessExpired, onBusyChange, onStudent, draftStore }: {
  center: Center; onAccessExpired: () => void; onBusyChange: (busy: boolean) => void; onStudent: (id: string) => void; draftStore: MutableRefObject<InquiryInput | null>;
}) {
  const [view, setView] = useState<'active' | 'closed' | 'tasks'>('active'), [stage, setStage] = useState('all'), [status, setStatus] = useState('pending');
  const [query, setQuery] = useState(''), [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [result, setResult] = useState<InquiryList | null>(null), [taskResult, setTaskResult] = useState<Page<FollowUpTask> | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [opening, setOpening] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [retained, setRetained] = useState(draftStore.current), [adding, setAdding] = useState(Boolean(draftStore.current)), [selected, setSelected] = useState<Inquiry | null>(null);
  const inFlight = useRef(false), readGeneration = useRef(0);
  const retain = (value: InquiryInput | null) => { draftStore.current = value; setRetained(value); };
  const failure = (value: unknown) => { if (value instanceof RequestError && [401, 403].includes(value.status)) onAccessExpired(); };
  useEffect(() => { onBusyChange(busy || Boolean(retained)); }, [busy, retained, onBusyChange]);
  useEffect(() => () => onBusyChange(false), [onBusyChange]);
  useEffect(() => {
    const controller = new AbortController(), generation = ++readGeneration.current; setLoading(true); setError('');
    const timer = setTimeout(() => {
      const path = view === 'tasks' ? `/api/admin/tasks?status=${status}&page=${page}&pageSize=25` : `/api/admin/inquiries?view=${view}&q=${encodeURIComponent(query.trim())}&page=${page}&pageSize=25${stage !== 'all' ? `&stage=${encodeURIComponent(stage)}` : ''}`;
      void request<InquiryList | Page<FollowUpTask>>(path, { signal: controller.signal }).then(value => {
        if (controller.signal.aborted || generation !== readGeneration.current) return;
        if (view === 'tasks') setTaskResult(value as Page<FollowUpTask>); else setResult(value as InquiryList);
      }).catch(value => { if (!controller.signal.aborted && generation === readGeneration.current) { setError(messageOf(value)); if (view === 'tasks') setTaskResult(null); else setResult(null); failure(value); } })
        .finally(() => { if (!controller.signal.aborted && generation === readGeneration.current) setLoading(false); });
    }, query.trim() ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [view, status, query, stage, page, revision]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !busy && !adding && !selected) setRevision(value => value + 1); };
    const timer = setInterval(refresh, 60000); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [busy, adding, selected]);
  const open = async (inquiryId: string) => {
    if (inFlight.current) return; inFlight.current = true; setOpening(true); setError('');
    try { const response = await request<{ inquiry: Inquiry }>(`/api/admin/inquiries/${inquiryId}`); setSelected(response.inquiry); }
    catch (value) { setError(messageOf(value)); failure(value); }
    finally { inFlight.current = false; setOpening(false); }
  };
  const complete = async (task: FollowUpTask) => {
    if (inFlight.current) return; inFlight.current = true; setBusy(true); setError('');
    try { await send(`/api/admin/tasks/${task.id}/complete`, {}); setNotice('Follow-up marked complete.'); setRevision(value => value + 1); }
    catch (value) { setError(`${messageOf(value)}${!(value instanceof RequestError) || value.uncertain ? ' You can retry completion safely.' : ''}`); failure(value); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const blocked = busy || opening || Boolean(retained);
  return <>
    <div className="page-heading"><div><div className="eyebrow">FAMILY RELATIONSHIPS</div><h1>From first hello to enrollment.</h1><p>Keep family inquiries and the next step in one place.</p></div><button className="btn btn-primary" disabled={blocked} onClick={() => setAdding(true)}><Plus size={16} />New inquiry</button></div>
    {result && <div className="cf-inquiry-summary"><span><MessageCircle size={20} /><strong>{result.counts.active}</strong>active inquiries</span><span><UserPlus size={20} /><strong>{result.counts.enrolled}</strong>enrolled</span><small>Dates use {center.timezone.replaceAll('_', ' ')}.</small></div>}
    <div className="cf-inquiry-toolbar"><div className="cf-inquiry-tabs" role="group" aria-label="Inquiry views">{([{ value: 'active', label: 'Active pipeline' }, { value: 'closed', label: 'Enrolled & closed' }, { value: 'tasks', label: 'Follow-ups' }] as const).map(item => <button key={item.value} className={view === item.value ? 'active' : ''} aria-pressed={view === item.value} disabled={blocked} onClick={() => { setView(item.value); setPage(1); setStage('all'); setNotice(''); }}>{item.label}</button>)}</div><button className="btn btn-secondary" aria-label="Refresh inquiries" disabled={blocked || loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={16} />Refresh</button></div>
    <div className="cf-inquiry-filters">{view === 'tasks' ? <label className="field"><span>Task status</span><select aria-label="Task status" value={status} disabled={blocked} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="pending">Pending</option><option value="completed">Completed</option><option value="all">All tasks</option></select></label> : <><label className="field"><span>Find a family</span><div className="cf-search"><Search size={16} /><input aria-label="Search inquiries" value={query} disabled={blocked} maxLength={200} placeholder="Name, email, or phone" onChange={event => { setQuery(event.target.value); setPage(1); }} /></div></label><label className="field"><span>Stage</span><select aria-label="Stage filter" value={stage} disabled={blocked} onChange={event => { setStage(event.target.value); setPage(1); }}><option value="all">All stages</option>{(view === 'active' ? activeStages : inquiryStages.slice(4)).map(item => <option key={item}>{item}</option>)}</select></label></>}</div>
    {notice && <div className="cf-notice success" role="status">{notice}</div>}{error && <div className="cf-notice error" role="alert">{error}</div>}
    <section className="card"><div className="cf-roster-heading"><div><h2>{view === 'tasks' ? 'Your next steps' : view === 'active' ? 'Family inquiry pipeline' : 'Enrolled and closed inquiries'}</h2><p>{view === 'tasks' ? 'Follow-ups are ordered by their due date.' : 'Open an inquiry to update its stage, record notes, or enroll a student.'}</p></div></div>
      {loading ? <p className="cf-table-note" role="status">Loading {view === 'tasks' ? 'follow-ups' : 'inquiries'}...</p> : view === 'tasks' ? taskResult?.items.length ? <><div className="cf-followup-list">{taskResult.items.map(task => <div className="cf-followup-item" key={task.id}><button className="cf-task-check" aria-label={`Complete ${task.title || 'follow-up'}`} disabled={blocked || !!task.completedAt} onClick={() => void complete(task)}><Check size={16} /></button><div><strong>{task.title || 'Follow-up'}</strong><p>{task.detail}</p><small className={!task.completedAt && Date.parse(task.dueAt) < Date.now() ? 'overdue' : ''}><Clock3 size={12} />{task.completedAt ? `Completed ${displayDate(task.completedAt, center.timezone)}` : `${displayDate(task.dueAt, center.timezone)} · ${displayTime(task.dueAt, center.timezone)}`}</small></div>{task.inquiryId && <button className="text-button" disabled={blocked} onClick={() => void open(task.inquiryId!)}>View inquiry<ArrowRight size={14} /></button>}</div>)}</div><Pager {...taskResult} busy={blocked} onPage={setPage} /></> : <EmptyState icon={Check} title={error ? 'Follow-ups unavailable' : 'No follow-ups in this view'} description={error ? 'Refresh when the connection returns.' : 'Add a next step when creating an inquiry to schedule a follow-up.'} /> : result?.items.length ? <><div className="table-wrap"><table className="data-table cf-inquiries-table"><thead><tr><th>Family</th><th>Subjects</th><th>Stage</th><th>Next step</th><th>Assigned to</th></tr></thead><tbody>{result.items.map(row => <tr key={row.id}><td><button className="cf-student-button" disabled={blocked} onClick={() => void open(row.id)}><Avatar name={row.studentName} /><span><strong>{row.studentName}</strong><small>{row.contactName} · {row.source}</small></span></button></td><td>{row.subjects.join(' · ') || 'Not selected'}</td><td><Badge tone={row.stage === 'Enrolled' ? 'green' : row.stage === 'New' ? 'blue' : 'gray'}>{row.stage}</Badge></td><td><span className="cf-inquiry-next">{row.nextAction || 'No next step'}<small className={row.dueAt && activeStages.includes(row.stage) && Date.parse(row.dueAt) < Date.now() ? 'overdue' : ''}>{row.dueAt ? displayDate(row.dueAt, center.timezone) : 'No due date'}</small></span></td><td>{row.ownerName || 'Unassigned'}</td></tr>)}</tbody></table></div><Pager {...result} busy={blocked} onPage={setPage} /></> : <EmptyState icon={MessageCircle} title={error ? 'Inquiries unavailable' : 'No inquiries in this view'} description={error ? 'Refresh when the connection returns.' : query || stage !== 'all' ? 'Try a different search or stage.' : 'Add a family inquiry to begin the conversation.'} />}
    </section>
    {adding && <AddInquiry center={center} retained={retained} onRetain={retain} onBusy={setBusy} onSaved={row => { setAdding(false); setNotice(`Inquiry saved for ${row.studentName}.`); setRevision(value => value + 1); }} onClose={() => setAdding(false)} onFailure={failure} />}
    {selected && <InquiryDialog key={selected.id} initial={selected} center={center} onBusy={setBusy} onChanged={() => setRevision(value => value + 1)} onClose={() => setSelected(null)} onStudent={onStudent} onFailure={failure} />}
  </>;
}
