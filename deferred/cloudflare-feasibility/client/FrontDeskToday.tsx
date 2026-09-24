import { useEffect, useRef, useState } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import type { DailyObservation, DepartedStudent, FrontDeskResponse, FrontDeskView, PlannedStudent } from '../shared/frontdesk';
import type { FollowUpTask } from '../shared/inquiries';
import { RequestError, messageOf, request, send } from './api';
import { Badge, EmptyState } from './shared/components';
import { displayDate, displayTime } from './utils';
import './FrontDeskToday.css';

const views: { id: FrontDeskView; label: string; description: string }[] = [
  { id: 'expected', label: 'Scheduled today', description: 'Active weekly lessons for this center day. A lesson plan does not record an arrival or confirm presence.' },
  { id: 'awaiting', label: 'No arrival recorded', description: 'Scheduled students with no arrival or attendance observation recorded for this day and no open visit. Staff must verify actual presence.' },
  { id: 'departed', label: 'Departures recorded', description: 'Students with departures recorded for this day and no open visit in this snapshot. Repeated departures and inactive enrollments remain visible.' },
  { id: 'observations', label: 'Daily observations', description: 'Original observations for this center day, ordered by the time observed. Corrections remain in each student’s record.' },
  { id: 'followups', label: 'Due follow-ups', description: 'Incomplete follow-ups due by the end of this center day, including overdue work.' },
];

export default function FrontDeskToday({ refreshKey, fresh, disabled, onStudent, onInquiries, onAccessExpired }: {
  refreshKey: string | null; fresh: boolean; disabled: boolean; onStudent: (id: string) => void; onInquiries: () => void; onAccessExpired: () => void;
}) {
  const [view, setView] = useState<FrontDeskView>('expected'), [page, setPage] = useState(1), [reload, setReload] = useState(0);
  const [visible, setVisible] = useState(document.visibilityState === 'visible');
  const [data, setData] = useState<FrontDeskResponse | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [completing, setCompleting] = useState<string | null>(null), [taskMessage, setTaskMessage] = useState('');
  const generation = useRef(0), dayRef = useRef<string | null>(null), mounted = useRef(true);
  const pageSize = view === 'observations' || view === 'followups' ? 5 : 25;
  useEffect(() => { mounted.current = true; const changed = () => setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', changed); return () => { mounted.current = false; document.removeEventListener('visibilitychange', changed); }; }, []);
  useEffect(() => {
    const current = ++generation.current, controller = new AbortController();
    if (!visible) { setLoading(false); return; }
    setLoading(true); setError('');
    void request<FrontDeskResponse>(`/api/admin/frontdesk/today?view=${view}&page=${page}&pageSize=${pageSize}`, { signal: controller.signal }).then(result => {
      if (current !== generation.current) return;
      if (page > 1 && (dayRef.current && dayRef.current !== result.day.date || !result.items.length)) { dayRef.current = result.day.date; setData(null); setPage(1); return; }
      dayRef.current = result.day.date; setData(result);
    }).catch(failure => {
      if (current !== generation.current) return; setError(messageOf(failure));
      if (failure instanceof RequestError && [401, 403].includes(failure.status)) { setData(null); onAccessExpired(); }
    }).finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; controller.abort(); };
  }, [view, page, pageSize, refreshKey, reload, visible, onAccessExpired]);
  const choose = (next: FrontDeskView) => { setView(next); setPage(1); setData(null); setTaskMessage(''); };
  const complete = async (task: FollowUpTask) => {
    if (completing || disabled) return; setCompleting(task.id); setTaskMessage('');
    try {
      const result = await send<{ task: FollowUpTask }>(`/api/admin/tasks/${encodeURIComponent(task.id)}/complete`, {});
      if (!result.task || result.task.id !== task.id || !result.task.completedAt) throw new RequestError('Completion could not be verified.');
      if (mounted.current) { setTaskMessage('Follow-up completed.'); setPage(1); setReload(value => value + 1); }
    } catch (failure) {
      if (!mounted.current) return;
      setTaskMessage(`${messageOf(failure)} Completion is not confirmed. Refresh or retry the same follow-up.`);
      if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired();
    } finally { if (mounted.current) setCompleting(null); }
  };
  const current = data?.view === view && data.page === page ? data : null, description = views.find(item => item.id === view)!.description;
  const isFresh = current && fresh && Date.now() - Date.parse(current.day.asOf) < 60000;
  const student = (row: PlannedStudent | DepartedStudent | DailyObservation) => <button className="cf-student-button" disabled={disabled} onClick={() => onStudent(row.studentId)}><span><strong>{row.studentName}</strong><small>{row.studentCode}{!row.active ? ' · Inactive enrollment' : ''}</small></span></button>;
  return <section className="card cf-frontdesk-today">
    <div className="cf-roster-heading"><div><h2>Today’s plans and records</h2><p>Use the current presence roster above when recording attendance.</p></div><button className="btn btn-secondary btn-sm" disabled={loading || disabled || !!completing} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />Refresh view</button></div>
    <div className="cf-frontdesk-tabs" role="tablist" aria-label="Today’s plans and records">{views.map(item => <button type="button" role="tab" aria-selected={view === item.id} className={view === item.id ? 'active' : ''} disabled={disabled || !!completing} key={item.id} onClick={() => choose(item.id)}>{item.label}</button>)}</div>
    <p className="cf-frontdesk-description">{description}</p>
    {current && <p className={`cf-frontdesk-snapshot ${isFresh ? '' : 'stale'}`}>Center day {current.day.date} · {current.day.timezone.replaceAll('_', ' ')} · Snapshot {displayTime(current.day.asOf, current.day.timezone)}{loading ? ' · Refreshing this view...' : !isFresh ? ' · May be out of date' : ''}</p>}
    {error && <p className="cf-notice error" role="alert">{error}{current ? ' The previous snapshot is still shown.' : ''}</p>}
    {taskMessage && <p className="cf-notice" role="status">{taskMessage}</p>}
    {!current ? loading ? <p className="cf-table-note">Loading this view...</p> : <p className="cf-table-note">Refresh this view when connected.</p> : <>
      {!current.items.length ? <EmptyState icon={CalendarDays} title={view === 'expected' ? 'No weekly lessons scheduled today' : view === 'awaiting' ? 'No scheduled students match this record check' : view === 'departed' ? 'No departures match this view' : view === 'observations' ? 'No observations recorded for this day' : 'No follow-ups due today or overdue'} description={view === 'expected' ? 'Weekly lessons can be added from Schedule.' : view === 'followups' ? 'Create an inquiry with a next step to add a follow-up.' : 'This view shows recorded information for the selected center day.'} /> : view === 'expected' || view === 'awaiting' ?
        <div className="table-wrap"><table className="data-table cf-data-table"><thead><tr><th>Student</th><th>First lesson</th><th>Weekly lessons</th><th>Recorded activity</th></tr></thead><tbody>{(current.items as PlannedStudent[]).map(row => <tr key={row.studentId}><td>{student(row)}</td><td>{row.firstLessonTime}</td><td>{row.lessonCount} {row.lessonCount === 1 ? 'lesson' : 'lessons'}<small className="cf-frontdesk-secondary">{row.subjects.join(' · ')}</small></td><td><Badge tone={row.openVisitNeedsReview ? 'amber' : 'gray'}>{row.openVisitNeedsReview ? 'Open visit needs review' : row.openVisitRecorded ? 'Open visit recorded' : row.arrivalRecorded ? 'Arrival recorded today' : row.observationRecorded ? 'Observation recorded today' : 'No arrival recorded'}</Badge></td></tr>)}</tbody></table></div> : view === 'departed' ?
        <div className="table-wrap"><table className="data-table cf-data-table"><thead><tr><th>Student</th><th>Last recorded departure</th><th>Departures today</th><th>Review</th></tr></thead><tbody>{(current.items as DepartedStudent[]).map(row => <tr key={row.studentId}><td>{student(row)}</td><td>{displayTime(row.lastDepartureAt, current.day.timezone)}</td><td>{row.departureCount}</td><td>{row.needsReview && <Badge tone="amber">Needs review</Badge>}{row.includesUnmatched && <small className="cf-frontdesk-secondary">Includes a departure without a matching arrival</small>}{!row.needsReview && !row.includesUnmatched && <span>No pending review</span>}</td></tr>)}</tbody></table></div> : view === 'observations' ?
        <div className="cf-frontdesk-list">{(current.items as DailyObservation[]).map(row => <article key={row.id}><div>{student(row)}<p>{row.action === 'check_in' ? 'Arrival observed' : row.action === 'check_out' ? 'Departure observed' : 'Exceptional departure observed'}{row.unmatched ? ' · no matching arrival' : ''}</p><small>{row.actorName} · {row.channel === 'kiosk' ? 'Kiosk' : 'Staff workspace'}</small></div><time dateTime={row.observedAt}>{displayTime(row.observedAt, current.day.timezone)}</time></article>)}</div> :
        <div className="cf-frontdesk-list">{(current.items as FollowUpTask[]).map(task => <article key={task.id}><div><strong>{task.title}</strong><p>{task.detail}</p><small>{Date.parse(task.dueAt) < Date.parse(current.day.asOf) ? 'Overdue' : 'Due today'} · {displayDate(task.dueAt, current.day.timezone)} · {displayTime(task.dueAt, current.day.timezone)}</small></div><button className="btn btn-secondary btn-sm" aria-label={`Complete ${task.title}`} disabled={disabled || !!completing} onClick={() => void complete(task)}><Check size={14} />{completing === task.id ? 'Saving...' : 'Complete'}</button></article>)}</div>}
      {current.counts && (view === 'expected' || view === 'awaiting') && <p className="cf-frontdesk-description">{current.counts.expectedStudents} scheduled students · {current.counts.expectedLessons} weekly lessons. {current.counts.excludedInactiveLessons > 0 && `${current.counts.excludedInactiveLessons} lessons excluded for inactive enrollment. `}{current.counts.excludedSubjectLessons > 0 && `${current.counts.excludedSubjectLessons} lessons excluded because the subject is no longer assigned. `}</p>}
      <div className="cf-pagination"><span>{current.total} {view === 'observations' ? 'observations' : view === 'followups' ? 'follow-ups' : 'students'} · Page {current.page}</span><div><button className="btn btn-secondary btn-sm" disabled={page <= 1 || loading || disabled || !!completing} onClick={() => setPage(value => value - 1)}><ChevronLeft size={13} />Previous</button><button className="btn btn-secondary btn-sm" disabled={page * pageSize >= current.total || loading || disabled || !!completing} onClick={() => setPage(value => value + 1)}>Next<ChevronRight size={13} /></button></div></div>
    </>}
    {view === 'followups' && <div className="cf-frontdesk-footer"><button className="text-button" disabled={disabled || !!completing} onClick={onInquiries}>Open inquiries and follow-ups</button></div>}
  </section>;
}
