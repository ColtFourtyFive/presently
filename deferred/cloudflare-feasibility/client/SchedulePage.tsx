import { useEffect, useState, type FormEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus, RefreshCw, Search } from 'lucide-react';
import type { Actor, Center, Page, Student } from '../shared/types';
import type { Schedule, ScheduleInput, ScheduleSubject, SchedulesResponse } from '../shared/schedules';
import { RequestError, messageOf, request, send } from './api';
import { Avatar, Badge, EmptyState, Modal } from './shared/components';
import './SchedulePage.css';

const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const clockTime = (minutes: number) => minutes === 1440 ? 'midnight' : `${Math.floor(minutes / 60) % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${minutes < 720 ? 'AM' : 'PM'}`;
function slotTime(slot: Pick<Schedule, 'startTime' | 'durationMinutes'>) {
  const [hours, minutes] = slot.startTime.split(':').map(Number); const start = hours * 60 + minutes;
  return `${clockTime(start)} to ${clockTime(start + slot.durationMinutes)}`;
}
const subjectsFor = (student: Student) => student.subjects.filter((subject): subject is ScheduleSubject => subject === 'Math' || subject === 'Reading');

function AddLesson({ center, busy, onAdd, onSaved, onClose, onAccessExpired }: {
  center: Center; busy: boolean; onAdd: (input: ScheduleInput) => Promise<Schedule>; onSaved: (schedule: Schedule) => void;
  onClose: () => void; onAccessExpired: () => void;
}) {
  const [query, setQuery] = useState(''); const [page, setPage] = useState(1);
  const [results, setResults] = useState<Page<Student> | null>(null); const [searching, setSearching] = useState(false);
  const [student, setStudent] = useState<Student | null>(null);
  const [form, setForm] = useState({ dayOfWeek: 1, startTime: '15:00', durationMinutes: 30, subject: 'Math' as ScheduleSubject });
  const [error, setError] = useState(''); const [uncertain, setUncertain] = useState<ScheduleInput | null>(null); const [checking, setChecking] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    if (student || !query.trim()) { setResults(null); setSearching(false); return; }
    setResults(null); setSearching(true);
    const timer = setTimeout(() => {
      void request<Page<Student>>(`/api/admin/students?q=${encodeURIComponent(query.trim())}&page=${page}&pageSize=25`, { signal: controller.signal })
        .then(result => { if (!controller.signal.aborted) setResults(result); })
        .catch(failure => { if (!controller.signal.aborted) { setError(messageOf(failure)); if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); } })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, page, student, onAccessExpired]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!student || busy || uncertain) return; setError('');
    const input = { studentId: student.id, ...form };
    try { onSaved(await onAdd(input)); }
    catch (failure) {
      if (failure instanceof RequestError && failure.uncertain) { setUncertain(input); setError('The result could not be confirmed. Check whether the lesson was recorded before submitting again.'); }
      else setError(messageOf(failure));
    }
  };
  const checkSaved = async () => {
    if (!uncertain) return; setChecking(true); setError('');
    try {
      // Active slots cannot overlap, so one student has at most 96 fifteen-minute
      // slots in a day. Two 50-row pages cover this lookup without a full roster.
      for (let page = 1; page <= 2; page++) {
        const result = await request<SchedulesResponse>(`/api/admin/schedules?studentId=${uncertain.studentId}&dayOfWeek=${uncertain.dayOfWeek}&active=true&pageSize=50&page=${page}`);
        const found = result.items.find(slot => slot.startTime === uncertain.startTime && slot.durationMinutes === uncertain.durationMinutes && slot.subject === uncertain.subject);
        if (found) { onSaved(found); return; }
        if (page * result.pageSize >= result.total) break;
      }
      setUncertain(null); setError('No matching active lesson was found. You can try adding it again; overlapping lessons are rejected.');
    } catch (failure) { setError(messageOf(failure)); if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); }
    finally { setChecking(false); }
  };
  return <Modal title="Add weekly lesson" subtitle={`This lesson repeats each week in ${center.timezone.replaceAll('_', ' ')}.`} onClose={() => !busy && !checking && onClose()}>
    <form className="cf-attendance" onSubmit={submit}>
      <fieldset className="cf-schedule-fields" disabled={busy || checking || !!uncertain}>
        {student ? <div className="cf-schedule-selected"><Avatar name={student.displayName} /><div><strong>{student.displayName}</strong><small>{student.studentCode} · {student.subjects.join(' and ')}</small></div><button type="button" className="text-button" onClick={() => setStudent(null)}>Change</button></div> : <>
          <label className="field"><span>Find a student</span><div className="cf-search"><Search size={15} /><input value={query} onChange={event => { setQuery(event.target.value); setPage(1); setError(''); }} placeholder="Name or student reference" autoFocus /></div></label>
          {searching && <p className="cf-schedule-hint" role="status">Searching students...</p>}
          {results && <div className="cf-schedule-search-results">{results.items.length ? results.items.map(item => <button type="button" key={item.id} disabled={!item.active || !subjectsFor(item).length} onClick={() => { setStudent(item); setForm(current => ({ ...current, subject: subjectsFor(item)[0] })); setError(''); }}><span><strong>{item.displayName}</strong><small>{item.studentCode} · {item.active ? item.subjects.join(' and ') || 'No subject enrollment' : 'Inactive student'}</small></span><ChevronRight size={15} /></button>) : <p className="cf-schedule-hint">No students match this search.</p>}
            {results.total > results.pageSize && <div className="cf-pagination"><span>Page {page}</span><div><button type="button" className="btn btn-secondary btn-sm" disabled={page === 1} onClick={() => setPage(value => value - 1)}>Previous</button><button type="button" className="btn btn-secondary btn-sm" disabled={page * results.pageSize >= results.total} onClick={() => setPage(value => value + 1)}>Next</button></div></div>}
          </div>}
        </>}
        <div className="cf-form-grid">
          <label className="field"><span>Day of week</span><select aria-label="Day of week" value={form.dayOfWeek} onChange={event => setForm(current => ({ ...current, dayOfWeek: Number(event.target.value) }))}>{days.map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>
          <label className="field"><span>Subject</span><select aria-label="Subject" value={form.subject} disabled={!student} onChange={event => setForm(current => ({ ...current, subject: event.target.value as ScheduleSubject }))}>{(student ? subjectsFor(student) : ['Math', 'Reading']).map(subject => <option key={subject}>{subject}</option>)}</select></label>
          <label className="field"><span>Start time</span><input type="time" required value={form.startTime} onChange={event => setForm(current => ({ ...current, startTime: event.target.value }))} /></label>
          <label className="field"><span>Duration in minutes</span><input type="number" required min={15} max={180} step={1} value={form.durationMinutes} onChange={event => setForm(current => ({ ...current, durationMinutes: Number(event.target.value) }))} /></label>
        </div>
      </fieldset>
      <p className="cf-schedule-hint">Lessons must fit within one day and cannot overlap another active lesson for this student.</p>
      {error && <div className={`cf-notice ${uncertain ? 'amber' : 'error'}`} role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={busy || checking} onClick={onClose}>Close</button>{uncertain ? <button type="button" className="btn btn-primary" disabled={checking} onClick={() => void checkSaved()}>{checking ? 'Checking...' : 'Check saved schedule'}</button> : <button className="btn btn-primary" disabled={!student || busy}>{busy ? 'Adding...' : 'Add weekly lesson'}</button>}</div>
    </form>
  </Modal>;
}

export default function SchedulePage({ center, actor, onAccessExpired, onBusyChange }: {
  center: Center; actor: Actor; onAccessExpired: () => void; onBusyChange: (busy: boolean) => void;
}) {
  const [day, setDay] = useState('all'), [subject, setSubject] = useState('all'), [active, setActive] = useState('true');
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0);
  const [result, setResult] = useState<SchedulesResponse | null>(null), [loading, setLoading] = useState(true);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false), [selected, setSelected] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState(false), [mutationError, setMutationError] = useState('');
  const canWrite = ['owner', 'manager', 'front_desk'].includes(actor.role);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    const query = new URLSearchParams({ active, page: String(page), pageSize: '25' });
    if (day !== 'all') query.set('dayOfWeek', day); if (subject !== 'all') query.set('subject', subject);
    void request<SchedulesResponse>(`/api/admin/schedules?${query}`, { signal: controller.signal }).then(data => {
      if (controller.signal.aborted) return;
      if (page > 1 && (page - 1) * data.pageSize >= data.total) { setPage(1); return; }
      setResult(data);
    }).catch(failure => { if (!controller.signal.aborted) { setResult(null); setError(messageOf(failure)); if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [day, subject, active, page, revision, actor.id, onAccessExpired]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible' && !busy) setRevision(value => value + 1); };
    const timer = setInterval(refresh, 60000); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [busy]);
  const saved = () => { setRevision(value => value + 1); setPage(1); };
  const add = async (input: ScheduleInput) => {
    setBusy(true); setNotice('');
    try { return (await send<{ schedule: Schedule }>('/api/admin/schedules', input)).schedule; }
    catch (failure) { if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); throw failure; }
    finally { setBusy(false); }
  };
  const changeStatus = async () => {
    if (!selected || busy) return; setBusy(true); setMutationError(''); setNotice('');
    try {
      const result = await send<{ schedule: Schedule }>(`/api/admin/schedules/${selected.id}`, { active: !selected.active }, 'PATCH');
      setNotice(result.schedule.active ? 'Weekly lesson restored.' : 'Weekly lesson canceled. Its record is retained.'); setSelected(null); saved();
    } catch (failure) {
      setMutationError(failure instanceof RequestError && failure.uncertain ? 'This change could not be confirmed. Retry the same change, or close this dialog and refresh the schedule to check its saved status.' : messageOf(failure));
      if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired();
    } finally { setBusy(false); }
  };
  return <>
    <div className="page-heading"><div><div className="eyebrow">CENTER CALENDAR</div><h1>Weekly lessons.</h1><p>Plan recurring Math and Reading lessons for your students.</p></div>{canWrite && <button className="btn btn-primary" onClick={() => setAdding(true)} disabled={busy}><Plus size={16} />Add lesson</button>}</div>
    <div className="cf-schedule-filters">
      <label className="field"><span>Day</span><select aria-label="Day" value={day} disabled={busy} onChange={event => { setDay(event.target.value); setPage(1); }}><option value="all">All days</option>{days.map((name, index) => <option value={index} key={name}>{name}</option>)}</select></label>
      <label className="field"><span>Subject</span><select aria-label="Subject" value={subject} disabled={busy} onChange={event => { setSubject(event.target.value); setPage(1); }}><option value="all">All subjects</option><option>Math</option><option>Reading</option></select></label>
      <label className="field"><span>Status</span><select aria-label="Status" value={active} disabled={busy} onChange={event => { setActive(event.target.value); setPage(1); }}><option value="true">Active lessons</option><option value="false">Canceled lessons</option><option value="all">All lessons</option></select></label>
      <button className="btn btn-secondary" disabled={loading || busy} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} />Refresh schedule</button>
    </div>
    {notice && <div className="cf-notice success" role="status">{notice}</div>}{error && <div className="cf-notice error" role="alert">{error} No current schedule is displayed.</div>}
    <section className="card"><div className="cf-roster-heading"><div><h2>Recurring lessons</h2><p><Clock3 size={12} /> All times use {center.timezone.replaceAll('_', ' ')}. Attendance is recorded separately when a student arrives.</p></div></div>
      {loading ? <p className="cf-table-note" role="status">Loading schedule...</p> : result?.items.length ? <>
        <div className="table-wrap"><table className="data-table cf-data-table cf-schedule-table"><thead><tr><th>Student</th><th>Day and time</th><th>Subject</th><th>Status</th>{canWrite && <th className="align-right">Action</th>}</tr></thead><tbody>{result.items.map(slot => <tr key={slot.id}>
          <td><div className="cf-schedule-student"><Avatar name={slot.studentName} size="sm" /><span><strong>{slot.studentName}</strong><small>{slot.studentCode}{!slot.studentActive ? ' · Inactive student' : ''}</small></span></div></td>
          <td><strong>{days[slot.dayOfWeek]}</strong><span className="cf-schedule-time">{slotTime(slot)} · {slot.durationMinutes} min</span></td>
          <td><Badge tone={slot.subject === 'Math' ? 'blue' : 'purple'}>{slot.subject}</Badge></td><td><Badge tone={slot.active ? 'green' : 'gray'}>{slot.active ? 'Active' : 'Canceled'}</Badge></td>
          {canWrite && <td className="align-right"><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => { setSelected(slot); setMutationError(''); }}>{slot.active ? 'Cancel lesson' : 'Restore lesson'}</button></td>}
        </tr>)}</tbody></table></div>
        <div className="cf-pagination"><span>{result.total} lessons · Page {page} of {Math.max(1, Math.ceil(result.total / result.pageSize))}</span><div><button className="btn btn-secondary btn-sm" disabled={page === 1 || busy} onClick={() => setPage(value => value - 1)}><ChevronLeft size={14} />Previous</button><button className="btn btn-secondary btn-sm" disabled={page * result.pageSize >= result.total || busy} onClick={() => setPage(value => value + 1)}>Next<ChevronRight size={14} /></button></div></div>
      </> : <EmptyState icon={CalendarDays} title={error ? 'Schedule unavailable' : 'No lessons in this view'} description={error ? 'Refresh the schedule when the connection returns.' : 'Try another filter or add a recurring lesson for an active student.'} />}
    </section>
    {adding && canWrite && <AddLesson center={center} busy={busy} onAdd={add} onSaved={() => { setAdding(false); setNotice('Weekly lesson is recorded.'); saved(); }} onClose={() => setAdding(false)} onAccessExpired={onAccessExpired} />}
    {selected && canWrite && <Modal title={selected.active ? 'Cancel weekly lesson' : 'Restore weekly lesson'} subtitle={selected.studentName} onClose={() => !busy && setSelected(null)}><p className="cf-schedule-confirm">{selected.subject} every {days[selected.dayOfWeek]}, {slotTime(selected)}.<br />{center.timezone.replaceAll('_', ' ')}</p><p className="cf-schedule-hint">{selected.active ? 'This removes the recurring lesson from the active schedule. Recorded attendance stays in the student history.' : 'The student must have an active enrollment in this subject, and the lesson must fit their current schedule.'}</p>{mutationError && <div className="cf-notice error" role="alert">{mutationError}</div>}<div className="modal-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => setSelected(null)}>Keep current status</button><button className="btn btn-primary" disabled={busy} onClick={() => void changeStatus()}>{busy ? 'Saving...' : selected.active ? 'Confirm cancellation' : 'Confirm restoration'}</button></div></Modal>}
  </>;
}
