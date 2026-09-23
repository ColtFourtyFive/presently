import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Clock3, History, FileUp, LockKeyhole, MessagesSquare, Plus, RefreshCw, Search, Settings, Users } from 'lucide-react';
import { Avatar, Badge, EmptyState } from './shared/components';
import type { AdminSession, AttendanceEvent, AttendanceRequest, AttendanceResult, KioskStatus, Page, RosterPollResponse, RosterResponse, Student, StudentDetail, VisitSummary } from '../shared/types';
import { RequestError, messageOf, request, send } from './api';
import { KioskEnroll, KioskUnlock, StaffSignIn } from './AuthScreens';
import AttendanceDialog, { type PendingAttendance } from './AttendanceDialog';
import { AddStudentDialog, StudentProfile } from './StudentDialogs';
import NetworkBanner, { type ConnectionState } from './NetworkBanner';
import SettingsPage from './SettingsPage';
import SchedulePage from './SchedulePage';
import InquiriesPage from './InquiriesPage';
import type { InquiryInput } from '../shared/inquiries';
import type { InteractionDraft } from './InteractionHistory';
import FrontDeskToday from './FrontDeskToday';
import type { ManagementDraft } from './StudentManagement';
import HistoryPage from './HistoryPage';
import VisitCorrectionDialog, { type CorrectionDraft } from './VisitCorrections';
import type { ObservationCorrectionDraft } from './ObservationCorrections';
import ImportPage, { type ImportDraft } from './ImportPage';
import DirectoryPage from './DirectoryPage';
import { displayTime } from './utils';

type Section = 'attendance' | 'inquiries' | 'students' | 'schedule' | 'history' | 'settings' | 'import';
const isKiosk = location.pathname.startsWith('/kiosk');
const base = isKiosk ? '/api/kiosk' : '/api/admin';
const matchesRequest = (event: AttendanceEvent, value: AttendanceRequest) => event.id === value.eventId && event.studentId === value.studentId && event.action === value.action && new Date(event.observedAt).getTime() === new Date(value.observedAt).getTime() && (event.guardianId || '') === (value.guardianId || '') && (event.reason || '') === (value.reason || '');
const kioskLocallyLocked = () => { try { return sessionStorage.getItem('kumon-kiosk-locked') === '1'; } catch { return false; } };
const markKioskLocked = (locked: boolean) => { try { if (locked) sessionStorage.setItem('kumon-kiosk-locked', '1'); else sessionStorage.removeItem('kumon-kiosk-locked'); } catch { /* Server-side kiosk expiry still applies when browser storage is unavailable. */ } };

export default function App() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [kiosk, setKiosk] = useState<KioskStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [section, setSection] = useState<Section>('attendance');
  const [connection, setConnection] = useState<ConnectionState>('refreshing');
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [students, setStudents] = useState<Page<Student> | null>(null);
  const [studentPage, setStudentPage] = useState(1);
  const [directoryRevision, setDirectoryRevision] = useState(0);
  const [studentLoading, setStudentLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<StudentDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState('');
  const [attendanceMode, setAttendanceMode] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PendingAttendance | null>(null);
  const [addingStudent, setAddingStudent] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [scheduleBusy, setScheduleBusy] = useState(false);
  const [inquiryBusy, setInquiryBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState(false);
 const [observationCorrectionBusy, setObservationCorrectionBusy] = useState(false);
  const [correctionVisit, setCorrectionVisit] = useState<VisitSummary | null>(null);
  const [historyRevision, setHistoryRevision] = useState(0);
  const correctionDraft = useRef<CorrectionDraft | null>(null);
 const observationCorrectionDraft = useRef<ObservationCorrectionDraft | null>(null);
  const interactionDraft = useRef<InteractionDraft | null>(null);
  const managementDraft = useRef<ManagementDraft | null>(null);
  const inquiryDraft = useRef<InquiryInput | null>(null);
  const importDraft = useRef<ImportDraft | null>(null);
  const accessGeneration = useRef(0);
  const readingRoster = useRef<number | null>(null);
  const rosterRevision = useRef<number | null>(null);
  const rosterActor = useRef<string | null>(null);
  const locking = useRef(false);
  const searchGeneration = useRef(0);
  const lastActivity = useRef(Date.now());
  const lastKioskTouch = useRef(Date.now());
  const actor = isKiosk ? kiosk?.operator : session?.actor;
  const center = isKiosk ? kiosk?.center : session?.center;
  const unresolved = pending?.state === 'sending' || pending?.state === 'uncertain' || importBusy || scheduleBusy || inquiryBusy || profileBusy || correctionBusy || observationCorrectionBusy || Boolean(interactionDraft.current || managementDraft.current || correctionDraft.current && correctionDraft.current.state !== 'confirmed' || observationCorrectionDraft.current && observationCorrectionDraft.current.state !== 'confirmed');
  const actorRef = useRef(actor); actorRef.current = actor;
  const pendingRef = useRef(pending); pendingRef.current = pending;
  const importBusyRef = useRef(importBusy); importBusyRef.current = importBusy;
  const changeImportBusy = useCallback((busy: boolean) => { importBusyRef.current = busy; setImportBusy(busy); }, []);
  const scheduleBusyRef = useRef(scheduleBusy); scheduleBusyRef.current = scheduleBusy;
  const inquiryBusyRef = useRef(inquiryBusy); inquiryBusyRef.current = inquiryBusy;
  const profileBusyRef = useRef(profileBusy); profileBusyRef.current = profileBusy;

  const expireAccess = useCallback(() => {
    accessGeneration.current++; searchGeneration.current++; actorRef.current = undefined;
    rosterRevision.current = null; rosterActor.current = null; setRoster(null); setStudents(null); setStudentLoading(false); setDetailBusy(''); setLastRefresh(null); setQuery(''); setStudentPage(1); setAddingStudent(false); setError('');
    if ((!pendingRef.current || ['confirmed', 'rejected'].includes(pendingRef.current.state)) && !interactionDraft.current && !managementDraft.current) { setDetail(null); setAttendanceMode(null); setPending(null); }
    if (isKiosk) setKiosk(current => current ? { ...current, operator: undefined } : current); else setSession(null);
    setConnection('disconnected');
  }, []);
  const loadSession = useCallback(async () => {
    const generation = accessGeneration.current; setAuthError('');
    try {
      if (isKiosk) { const state = await request<KioskStatus>('/api/kiosk/status'); if (generation === accessGeneration.current) setKiosk(kioskLocallyLocked() ? { ...state, operator: undefined } : state); }
      else { const state = await request<AdminSession>('/api/admin/session'); if (generation !== accessGeneration.current) return; const retained = pendingRef.current; if (retained && ['sending', 'uncertain'].includes(retained.state) && retained.actorId !== state.actor.id) throw new Error('Sign in as the staff member who recorded the pending attendance observation.'); if (correctionDraft.current && correctionDraft.current.actorId !== state.actor.id) throw new Error('Sign in as the manager who submitted the pending correction.'); if (observationCorrectionDraft.current && observationCorrectionDraft.current.actorId !== state.actor.id) throw new Error('Sign in as the manager who submitted the pending observation correction.'); if (managementDraft.current && managementDraft.current.actorId !== state.actor.id) throw new Error('Sign in as the manager who submitted the pending student change.'); if (interactionDraft.current && interactionDraft.current.actorId !== state.actor.id) throw new Error('Sign in as the staff member who logged the pending communication entry.'); setSession(state); }
    }
    catch (failure) { if (generation === accessGeneration.current) { setAuthError(messageOf(failure)); if (!isKiosk) setSession(null); } throw failure; }
    finally { if (generation === accessGeneration.current) setLoading(false); }
  }, []);
  const refreshRoster = useCallback(async () => {
    const generation = accessGeneration.current;
    const currentActor = actorRef.current;
    if (readingRoster.current === generation || !currentActor || document.visibilityState === 'hidden') return;
    if (rosterActor.current !== currentActor.id) { rosterActor.current = currentActor.id; rosterRevision.current = null; }
    const actorId = currentActor.id;
    readingRoster.current = generation; setConnection('refreshing');
    try { const response = await request<RosterPollResponse>(`${base}/roster${rosterRevision.current === null ? '' : `?revision=${rosterRevision.current}`}`); if (generation !== accessGeneration.current || actorRef.current?.id !== actorId) return; rosterRevision.current = response.revision; if (!('unchanged' in response)) setRoster(response); setLastRefresh(response.asOf); setConnection('connected'); }
    catch (failure) { if (generation !== accessGeneration.current) return; setConnection('disconnected'); if (failure instanceof RequestError && [401, 403].includes(failure.status)) { setAuthError('Your staff access needs to be verified again.'); expireAccess(); } }
    finally { if (readingRoster.current === generation) readingRoster.current = null; }
  }, [expireAccess]);
  const loadStudents = useCallback(async () => {
    if (!actorRef.current) return;
    const generation = ++searchGeneration.current; setStudentLoading(true); setError('');
    try { const result = await request<Page<Student>>(`${base}/students?q=${encodeURIComponent(query.trim())}&page=${studentPage}&pageSize=25`); if (generation === searchGeneration.current && actorRef.current) setStudents(result); }
    catch (failure) { if (generation === searchGeneration.current) { setStudents(null); setError(messageOf(failure)); if (failure instanceof RequestError && [401, 403].includes(failure.status)) expireAccess(); } }
    finally { if (generation === searchGeneration.current) setStudentLoading(false); }
  }, [query, studentPage, expireAccess]);

  useEffect(() => { void loadSession().catch(() => {}); }, [loadSession]);
  useEffect(() => { if (!actor) return; void refreshRoster(); const interval = setInterval(() => { if (document.visibilityState === 'visible') void refreshRoster(); }, 30000); const onVisible = () => { if (document.visibilityState === 'visible') void refreshRoster(); }; document.addEventListener('visibilitychange', onVisible); return () => { clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); }; }, [actor?.id, refreshRoster]);
  useEffect(() => { if (!actor || section !== 'attendance' || !query.trim()) { setStudents(null); return; } const generation = ++searchGeneration.current; const timer = setTimeout(() => { if (generation === searchGeneration.current) void loadStudents(); }, 300); return () => { clearTimeout(timer); searchGeneration.current++; }; }, [query, studentPage, section, actor?.id, loadStudents]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (pendingRef.current?.state === 'sending' || pendingRef.current?.state === 'uncertain' || importBusyRef.current || scheduleBusyRef.current || inquiryBusyRef.current || profileBusyRef.current || interactionDraft.current || managementDraft.current || correctionDraft.current && correctionDraft.current.state !== 'confirmed' || observationCorrectionDraft.current && observationCorrectionDraft.current.state !== 'confirmed') event.preventDefault(); }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, []);
  useEffect(() => { if (!actor || !lastRefresh || connection !== 'connected') return; const remaining = Math.max(0, 60000 - (Date.now() - new Date(lastRefresh).getTime())); const timer = setTimeout(() => setConnection('disconnected'), remaining); return () => clearTimeout(timer); }, [actor?.id, lastRefresh, connection]);
  const lock = useCallback(async () => {
    if (locking.current) return;
    locking.current = true; setAuthBusy(true);
    markKioskLocked(true);
    setAuthError('');
    expireAccess();
    try { await send('/api/kiosk/lock', {}); }
    catch { setAuthError('The kiosk is locked here. The connection must return before it can be unlocked.'); }
    finally { locking.current = false; setAuthBusy(false); }
  }, [expireAccess]);
  useEffect(() => {
    if (!isKiosk || !actor) return;
    lastActivity.current = Date.now();
    const generation = accessGeneration.current;
    const activity = (event: Event) => { if (!event.isTrusted || generation !== accessGeneration.current || !actorRef.current) return; lastActivity.current = Date.now(); if (document.visibilityState === 'visible' && Date.now() - lastKioskTouch.current >= 60000) { lastKioskTouch.current = Date.now(); void send('/api/kiosk/touch', {}).catch(failure => { if (generation !== accessGeneration.current) return; setConnection('disconnected'); if (failure instanceof RequestError && [401, 403].includes(failure.status)) { markKioskLocked(true); expireAccess(); } }); } };
    for (const name of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(name, activity, { passive: true });
    const interval = setInterval(() => { if (Date.now() - lastActivity.current >= 5 * 60000) void lock(); }, 15000);
    return () => { clearInterval(interval); for (const name of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(name, activity); };
  }, [actor?.id, lock, expireAccess]);

  const openStudent = async (id: string, attendance?: boolean) => {
    if (unresolved) return;
    const generation = accessGeneration.current;
    setDetailBusy(id); setError(''); setDetail(null); setAttendanceMode(null); setPending(null);
    try { const response = await request<StudentDetail>(`${base}/students/${encodeURIComponent(id)}`); if (generation !== accessGeneration.current || !actorRef.current) return; setDetail(response); if (attendance !== undefined) setAttendanceMode(attendance || response.visits.some(visit => !visit.checkOutAt)); }
    catch (failure) { if (generation !== accessGeneration.current) return; setError(messageOf(failure)); if (failure instanceof RequestError && [401, 403].includes(failure.status)) expireAccess(); }
    finally { if (generation === accessGeneration.current) setDetailBusy(''); }
  };
  const confirmAttendance = async (payload: AttendanceRequest, retry = false) => {
    const previous = pendingRef.current;
    if (previous?.state === 'sending') return;
    if (!actorRef.current || (previous && retry && previous.actorId !== actorRef.current.id)) { setPending(current => current ? { ...current, state: 'uncertain', message: 'Unlock as the staff member who recorded this observation to resolve it.' } : current); return; }
    const retained: PendingAttendance = { request: payload, studentName: detail?.student.displayName || previous?.studentName || '', actorId: previous?.actorId || actorRef.current.id, state: 'sending' };
    pendingRef.current = retained; setPending(retained);
    try { const response = await send<AttendanceResult>(`${base}/attendance`, payload); if (!matchesRequest(response.event, payload)) throw new RequestError('The returned attendance record did not match this request.'); setPending({ ...retained, state: 'confirmed', result: response }); await refreshRoster(); }
    catch (failure) { const uncertain = retry || !(failure instanceof RequestError) || failure.uncertain; setPending({ ...retained, state: uncertain ? 'uncertain' : 'rejected', message: uncertain ? `${messageOf(failure)} The result is still unknown. Keep this window open and check the same request.` : messageOf(failure) }); if (failure instanceof RequestError && [401, 403].includes(failure.status)) expireAccess(); }
  };
  const resolveAttendance = async () => {
    const previous = pendingRef.current; if (!previous || previous.state === 'sending') return;
    if (!actorRef.current || actorRef.current.id !== previous.actorId) { setPending({ ...previous, state: 'uncertain', message: 'Unlock as the staff member who recorded this observation to resolve it.' }); return; }
    const checking: PendingAttendance = { ...previous, state: 'sending', message: 'Checking whether the original attendance request was recorded...' }; pendingRef.current = checking; setPending(checking);
    try { const response = await request<AttendanceResult>(`${base}/attendance/events/${previous.request.eventId}`); if (!matchesRequest(response.event, previous.request)) throw new RequestError('The returned attendance record did not match this request.'); setPending({ ...previous, state: 'confirmed', result: response }); await refreshRoster(); }
    catch (failure) { setPending({ ...previous, state: 'uncertain', message: failure instanceof RequestError && failure.status === 404 ? 'No confirmed record was found yet. Retry this same request when connected. Do not create another attendance event.' : `${messageOf(failure)} The original request remains unconfirmed.` }); if (failure instanceof RequestError && [401, 403].includes(failure.status)) expireAccess(); }
  };
  const changeSection = (next: Section) => { if (unresolved || importBusyRef.current) return; setSection(next); setQuery(''); setStudentPage(1); setError(''); };
  const openCorrection = (visit: VisitSummary) => { if (unresolved || isKiosk) return; setDetail(null); setCorrectionVisit(visit); };
  const profileUpdated = async (updated: StudentDetail) => {
    if (!actorRef.current) return;
    setDetail(updated); setDirectoryRevision(value => value + 1); await refreshRoster();
    if (query.trim()) await loadStudents();
  };
  const closeDetail = () => { if (!unresolved) { setDetail(null); setAttendanceMode(null); setPending(null); } };

  if (loading) return <div className="cf-loading"><span className="brand-mark">k</span><span className="spinner" /><p>Opening your center...</p></div>;
  if (!isKiosk && !session) return <StaffSignIn error={authError} pending={Boolean(unresolved)} retry={() => { setLoading(true); void loadSession().catch(() => {}); }} />;
  if (isKiosk && !kiosk) return <main className="cf-page-error"><AlertTriangle size={32} /><h1>The kiosk could not connect.</h1><p>{authError}</p><button className="btn btn-primary" onClick={() => { setLoading(true); void loadSession().catch(() => {}); }}>Try again</button></main>;
  if (isKiosk && !kiosk?.enrolled) return <KioskEnroll busy={authBusy} error={authError} onEnroll={async code => { setAuthBusy(true); setAuthError(''); try { await send('/api/kiosk/enroll', { token: code, label: 'Front desk kiosk' }); await loadSession(); } catch (failure) { setAuthError(messageOf(failure)); } finally { setAuthBusy(false); } }} />;
  if (isKiosk && !kiosk?.operator) return <KioskUnlock centerName={kiosk?.center.name || ''} deviceName={kiosk?.device?.label || ''} staff={kiosk?.staff.map(person => ({ id: person.id, name: person.displayName })) || []} pending={Boolean(unresolved)} busy={authBusy} error={authError} onRefresh={() => { setAuthBusy(true); void loadSession().catch(() => {}).finally(() => setAuthBusy(false)); }} onUnlock={async (staffId, pin) => { if (locking.current) return; const retained = pendingRef.current; if (retained && ['sending', 'uncertain'].includes(retained.state) && retained.actorId !== staffId) { setAuthError('Unlock as the staff member who recorded the pending observation.'); return; } setAuthBusy(true); setAuthError(''); try { await send('/api/kiosk/unlock', { staffId, pin }); markKioskLocked(false); await loadSession(); } catch (failure) { setAuthError(messageOf(failure)); } finally { setAuthBusy(false); } }} />;
  if (!actor || !center) return null;
  const canRecord = actor.role !== 'instructor';
  const canManage = actor.role === 'owner' || actor.role === 'manager';
  const fresh = connection === 'connected' && lastRefresh !== null && Date.now() - new Date(lastRefresh).getTime() < 60000;
  const readyToRecord = canRecord && fresh && !unresolved && !detailBusy;
  const present = roster?.items.filter(visit => !visit.checkOutAt && visit.reviewStatus !== 'pending') || [];
  const review = roster?.items.filter(visit => visit.reviewStatus === 'pending') || [];
  const searching = section === 'students' || Boolean(query.trim());

  return <div className="cf-app"><header className="cf-header"><a className="brand" href={isKiosk ? '/kiosk' : '/admin'} onClick={event => { event.preventDefault(); changeSection('attendance'); }}><span className="brand-mark">k</span><div><strong>kumon</strong><span>CENTER WORKSPACE</span></div></a><div className="cf-header-side"><span className="cf-account"><Avatar name={actor.displayName} /><span><strong>{actor.displayName}</strong><small>{isKiosk ? kiosk?.device?.label : actor.role.replaceAll('_', ' ')}</small></span></span>{isKiosk ? <button className="btn btn-secondary" onClick={() => void lock()}><LockKeyhole size={15} />Lock</button> : <a className="btn btn-secondary" href="/cdn-cgi/access/logout" onClick={event => { if (unresolved) event.preventDefault(); }} aria-disabled={unresolved}>Sign out</a>}</div></header>{!isKiosk && <nav className="cf-nav" aria-label="Workspace sections">{([{ key: 'attendance', label: 'Front desk', icon: Users }, { key: 'students', label: 'Students', icon: Search }, { key: 'inquiries', label: 'Inquiries', icon: MessagesSquare }, { key: 'schedule', label: 'Schedule', icon: CalendarDays }, { key: 'history', label: 'History', icon: History }, { key: 'import', label: 'Import roster', icon: FileUp }, { key: 'settings', label: 'Center settings', icon: Settings }] as const).filter(item => item.key === 'attendance' || item.key === 'schedule' || item.key === 'settings' || (item.key === 'students' || item.key === 'inquiries') && canRecord || (item.key === 'history' || item.key === 'import') && canManage).map(item => <button key={item.key} className={section === item.key ? 'active' : ''} disabled={unresolved} onClick={() => changeSection(item.key)}><item.icon size={17} />{item.label}</button>)}</nav>}
    <main className="cf-main"><NetworkBanner state={connection} lastRefresh={lastRefresh} onRetry={() => void refreshRoster()} />{section === 'students' && !isKiosk && canRecord ? <DirectoryPage canManage={canManage} disabled={Boolean(unresolved || detailBusy)} revision={directoryRevision} onStudent={id => void openStudent(id)} onAdd={() => setAddingStudent(true)} onImport={() => changeSection('import')} onAccessExpired={expireAccess} /> : section === 'inquiries' && !isKiosk && canRecord ? <InquiriesPage center={center} onAccessExpired={expireAccess} onBusyChange={setInquiryBusy} onStudent={id => void openStudent(id)} draftStore={inquiryDraft} /> : section === 'schedule' && !isKiosk ? <SchedulePage center={center} actor={actor} onAccessExpired={expireAccess} onBusyChange={setScheduleBusy} /> : section === 'import' && !isKiosk && canManage ? <ImportPage onBusyChange={changeImportBusy} draftStore={importDraft} /> : section === 'settings' && !isKiosk ? <SettingsPage center={center} actor={actor} onCenterUpdated={loadSession} /> : section === 'history' && !isKiosk && canManage ? <HistoryPage center={center} actor={actor} onStudent={id => void openStudent(id)} onCorrect={openCorrection} observationCorrectionDraft={observationCorrectionDraft} onObservationCorrectionBusyChange={setObservationCorrectionBusy} onAccessExpired={expireAccess} revision={historyRevision} /> : <>
      <div className="page-heading"><div><div className="cf-center-label">{center.name}</div><h1>{section === 'students' ? 'Students and families.' : 'A clear view of the front desk.'}</h1><p>{section === 'students' ? 'Find student records and verified guardian details.' : 'Record each arrival and departure when you observe it.'}</p></div>{!isKiosk && canManage && <button className="btn btn-primary" disabled={unresolved} onClick={() => setAddingStudent(true)}><Plus size={16} />Add student</button>}</div>
      {section === 'attendance' && <div className="cf-presence-summary"><span className="cf-presence-count"><Users size={22} /><strong>{present.length}</strong>recorded at center</span>{review.length > 0 && <span className="cf-presence-count review"><AlertTriangle size={21} /><strong>{review.length}</strong>need review</span>}<span className={`cf-connection ${fresh ? '' : 'stale'}`}><i />{lastRefresh ? `Last refreshed ${displayTime(lastRefresh, center.timezone)}` : 'Awaiting a current roster'}</span></div>}
      {error && <div className="cf-notice error" role="alert">{error}</div>}
      <section className="card"><div className="cf-roster-heading"><div><h2>{section === 'students' ? 'Student directory' : searching ? 'Find a student' : 'Current presence'}</h2><p>{searching ? 'Search by student name or reference. Results are limited to 25 per page.' : 'Search to record an arrival or view a student’s guardian details.'}</p></div>{canRecord && <div className="cf-search"><Search size={18} /><input aria-label="Find a student" value={query} onChange={event => { setQuery(event.target.value); setStudentPage(1); }} placeholder="Student name or reference" disabled={unresolved} /></div>}</div>
      {searching ? studentLoading ? <p className="cf-table-note">Finding students...</p> : students?.items.length ? <><div className="table-wrap"><table className="data-table cf-data-table"><thead><tr><th>Student</th><th>Subjects</th><th>Enrollment</th><th className="align-right">Attendance</th></tr></thead><tbody>{students.items.map(student => { const open = roster?.items.find(visit => visit.studentId === student.id && !visit.checkOutAt); return <tr key={student.id}><td><button className="cf-student-button" disabled={unresolved || Boolean(detailBusy)} onClick={() => void openStudent(student.id)}><Avatar name={student.displayName} /><span><strong>{student.displayName}</strong><small>{student.studentCode}</small></span></button></td><td>{student.subjects.join(' · ') || 'Not recorded'}</td><td><Badge tone={student.active ? 'blue' : 'gray'}>{student.active ? 'Active' : 'Inactive'}</Badge></td><td><div className="cf-row-actions">{canRecord && <button className="btn btn-secondary" disabled={!readyToRecord || (!student.active && !open)} onClick={() => void openStudent(student.id, Boolean(open))}>{detailBusy === student.id ? 'Loading...' : open ? 'Record departure' : 'Record arrival'}{open ? <ArrowUpRight size={14} /> : <ArrowDownLeft size={14} />}</button>}</div></td></tr>; })}</tbody></table></div><div className="cf-pagination"><span>{students.total} students · Page {students.page}</span><div><button className="btn btn-secondary btn-sm" disabled={studentPage <= 1 || studentLoading} onClick={() => setStudentPage(current => current - 1)}><ChevronLeft size={13} />Previous</button><button className="btn btn-secondary btn-sm" disabled={studentPage * students.pageSize >= students.total || studentLoading} onClick={() => setStudentPage(current => current + 1)}>Next<ChevronRight size={13} /></button></div></div></> : <EmptyState icon={Users} title={query.trim() ? 'No matching students' : 'Your student directory is empty'} description={query.trim() ? 'Try another name or student reference.' : isKiosk ? 'A staff administrator can add or import students from the staff workspace.' : 'Add your first student and guardian to get started.'} /> : roster?.items.length ? <><div className="table-wrap"><table className="data-table cf-data-table"><thead><tr><th>Student</th><th>Recorded arrival</th><th>Presence</th><th className="align-right">Action</th></tr></thead><tbody>{roster.items.map(visit => <tr key={visit.id}><td><button className="cf-student-button" disabled={!canRecord || unresolved || Boolean(detailBusy)} onClick={() => void openStudent(visit.studentId)}><Avatar name={visit.studentName} /><span><strong>{visit.studentName}</strong><small>{visit.studentCode}{!visit.active ? ' · Inactive enrollment' : ''}</small></span></button></td><td>{displayTime(visit.checkInAt, center.timezone)}</td><td><Badge tone={!fresh || visit.reviewStatus === 'pending' ? 'amber' : 'green'}>{!fresh ? 'Snapshot may be stale' : visit.reviewStatus === 'pending' ? 'Verify presence' : visit.checkOutAt ? 'Departed' : 'At center'}</Badge></td><td><div className="cf-row-actions">{canRecord && <button className="btn btn-secondary" disabled={!readyToRecord || Boolean(visit.checkOutAt)} onClick={() => void openStudent(visit.studentId, true)}>Record departure<ArrowUpRight size={14} /></button>}</div></td></tr>)}</tbody></table></div>{roster.truncated && <div className="cf-notice amber">This roster has reached its display limit. Search individual students to verify their records; the counts shown are not the complete center total.</div>}</> : <EmptyState icon={Users} title={roster ? 'No students are currently checked in' : 'Waiting for the current roster'} description={roster ? 'Search for a student above to record an observed arrival. A lesson schedule does not check a student in.' : 'Current presence will appear after the connection is verified.'} />}
      </section>{section === 'attendance' && !isKiosk && canRecord && <FrontDeskToday refreshKey={lastRefresh} fresh={fresh} disabled={Boolean(unresolved || detailBusy)} onStudent={id => void openStudent(id)} onInquiries={() => changeSection('inquiries')} onAccessExpired={expireAccess} />}</>}
      <footer className="cf-footer"><span>Kumon center workspace</span><span>{center.timezone.replaceAll('_', ' ')} · Attendance is confirmed after it is saved.</span></footer>
    </main>
    {correctionVisit && !isKiosk && canManage && <VisitCorrectionDialog key={correctionVisit.id} initialVisit={correctionVisit} center={center} actor={actor} draftStore={correctionDraft} onBusyChange={setCorrectionBusy} onAccessExpired={expireAccess} onSaved={async () => { await refreshRoster(); setHistoryRevision(value => value + 1); }} onClose={() => setCorrectionVisit(null)} />}
    {addingStudent && <AddStudentDialog onClose={() => setAddingStudent(false)} onSaved={async () => { changeSection('students'); setDirectoryRevision(value => value + 1); await refreshRoster(); }} />}
    {detail && attendanceMode === null && <StudentProfile detail={detail} center={center} actor={actor} canLogInteraction={!isKiosk && canRecord} interactionDraft={interactionDraft} managementDraft={managementDraft} onBusyChange={setProfileBusy} onAccessExpired={expireAccess} onUpdated={profileUpdated} onCorrect={openCorrection} canRecord={Boolean(readyToRecord)} onRecord={departure => setAttendanceMode(departure)} onClose={closeDetail} />}
    {detail && attendanceMode !== null && <AttendanceDialog key={detail.student.id} detail={detail} center={center} departure={attendanceMode} pending={pending} onSend={payload => void confirmAttendance(payload)} onRetry={() => { if (pending) void confirmAttendance(pending.request, true); }} onResolve={() => void resolveAttendance()} onClose={closeDetail} />}
  </div>;
}
