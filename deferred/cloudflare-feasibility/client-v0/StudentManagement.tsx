import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { Pencil, ShieldCheck, X } from 'lucide-react';
import type { Guardian, Student, StudentDetail } from '../shared/types';
import { RequestError, messageOf, request, send } from './api';
import { changedFields, fieldsMatch, guardianFields, studentFields, type GuardianEdit, type StudentEdit } from './management-state';
import './student-management.css';

type Attempt = { mode: string; patch: Partial<StudentEdit> | Partial<GuardianEdit> };
export type ManagementDraft = Attempt & { actorId: string; baseline: StudentDetail; state: 'uncertain' | 'confirmed' };
const studentForm = (student: Student): StudentEdit => ({ firstName: student.firstName, lastName: student.lastName, grade: student.grade, subjects: [...student.subjects], pickupAlert: student.pickupAlert, active: student.active });
const guardianForm = (guardian: Guardian): GuardianEdit => ({ displayName: guardian.displayName, relationship: guardian.relationship, phone: guardian.phone, email: guardian.email, pickupAuthority: guardian.pickupAuthority, authorityNote: guardian.authorityNote });

export default function StudentManagement({ detail, actorId, draftStore, disabled = false, onUpdated, onBusyChange, onAccessExpired }: {
  detail: StudentDetail; actorId: string; draftStore: MutableRefObject<ManagementDraft | null>; disabled?: boolean; onUpdated: (detail: StudentDetail) => Promise<void>; onBusyChange: (busy: boolean) => void; onAccessExpired: () => void;
}) {
  const initial = draftStore.current?.baseline || detail;
  const [mode, setMode] = useState<string | null>(draftStore.current?.mode || null), [baseline, setBaseline] = useState(initial);
  const [student, setStudent] = useState(() => ({ ...studentForm(initial.student), ...(draftStore.current?.mode === 'student' ? draftStore.current.patch as Partial<StudentEdit> : {}) })), [guardian, setGuardian] = useState<GuardianEdit | null>(() => {
    const draft = draftStore.current, current = initial.guardians.find(item => item.id === draft?.mode);
    return current ? { ...guardianForm(current), ...draft!.patch as Partial<GuardianEdit> } : null;
  });
  const [state, setState] = useState<'editing' | 'saving' | 'uncertain' | 'confirmed' | 'stale'>(draftStore.current?.state || 'editing');
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const attempt = useRef<Attempt | null>(draftStore.current), inFlight = useRef(false);
  const blocked = state === 'saving' || state === 'uncertain' || state === 'confirmed';
  useEffect(() => { onBusyChange(blocked); }, [blocked, onBusyChange]);
  useEffect(() => () => onBusyChange(Boolean(draftStore.current)), [draftStore, onBusyChange]);
  const accessFailure = (failure: unknown) => { if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); };
  const start = (next: 'student' | Guardian) => {
    setBaseline(detail); setMode(next === 'student' ? 'student' : next.id); setState('editing'); setError(''); setNotice(''); attempt.current = null; draftStore.current = null;
    if (next === 'student') setStudent(studentForm(detail.student)); else setGuardian(guardianForm(next));
  };
  const read = () => request<StudentDetail>(`/api/admin/students/${detail.student.id}`);
  const finished = async (latest: StudentDetail) => { await onUpdated(latest); draftStore.current = null; setMode(null); setNotice('Student record updated.'); setState('editing'); attempt.current = null; };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!mode || inFlight.current || state !== 'editing') return;
    const patch = mode === 'student' ? changedFields(studentForm(baseline.student), { ...student, firstName: student.firstName.trim(), lastName: student.lastName.trim(), grade: student.grade.trim(), pickupAlert: student.pickupAlert.trim() }, studentFields)
      : changedFields(guardianForm(baseline.guardians.find(item => item.id === mode)!), Object.fromEntries(Object.entries(guardian!).map(([key, value]) => [key, value.trim()])) as GuardianEdit, guardianFields);
    if (!Object.keys(patch).length) { setError('Change a field before saving.'); return; }
    attempt.current = { mode, patch }; inFlight.current = true; setState('saving'); setError('');
    const pending: ManagementDraft = { actorId, baseline, mode, patch, state: 'uncertain' }; draftStore.current = pending;
    let saved = false;
    try {
      await send(`/api/admin/students/${detail.student.id}${mode === 'student' ? '' : `/guardians/${mode}`}`, { ...patch, expectedRevision: baseline.student.revision }, 'PATCH');
      saved = true; draftStore.current = { ...pending, state: 'confirmed' }; setState('confirmed'); await finished(await read());
    } catch (failure) {
      if (saved) { setState('confirmed'); setError('Changes were saved, but the profile could not refresh. Refresh the saved record before continuing.'); }
      else if (!(failure instanceof RequestError) || failure.uncertain) { setState('uncertain'); setError('The save result is unknown. Check the saved record before making another change.'); }
      else if ([401, 403].includes(failure.status)) { setState('uncertain'); setError('Sign in again, then check the saved record to confirm this change.'); }
      else { draftStore.current = null; setState(failure.code === 'STALE_STUDENT' ? 'stale' : 'editing'); setError(messageOf(failure)); }
      accessFailure(failure);
    } finally { inFlight.current = false; }
  };
  const check = async (reload = false) => {
    if (inFlight.current) return; inFlight.current = true; const previous = state; setState('saving'); setError('');
    try {
      const latest = await read(), pending = attempt.current;
      if (!reload && previous !== 'confirmed' && pending) {
        const matches = pending.mode === 'student' ? fieldsMatch(latest.student, pending.patch as Partial<Student>)
          : latest.guardians.some(item => item.id === pending.mode && fieldsMatch(item, pending.patch as Partial<Guardian>));
        if (!matches) { draftStore.current = null; setState('stale'); setError('The saved record differs from the requested changes. Reload it and review the current values before editing again.'); return; }
      }
      if (reload) {
        await onUpdated(latest);
        setBaseline(latest); setStudent(studentForm(latest.student)); const selected = latest.guardians.find(item => item.id === mode); if (selected) setGuardian(guardianForm(selected)); else if (mode !== 'student') setMode(null);
        draftStore.current = null; setState('editing'); attempt.current = null; setNotice('Current saved values loaded.');
      } else await finished(latest);
    } catch (failure) { setState(previous); setError(messageOf(failure)); accessFailure(failure); }
    finally { inFlight.current = false; }
  };
  return <section className="cf-management"><h4>Manager controls</h4>{notice && <div className="cf-notice success" role="status">{notice}</div>}
    {!mode ? <div className="cf-management-options"><button className="btn btn-secondary btn-sm" disabled={disabled} onClick={() => start('student')}><Pencil size={14} />Edit student profile</button>{detail.guardians.map(item => <button className="btn btn-secondary btn-sm" key={item.id} disabled={disabled} onClick={() => start(item)}><ShieldCheck size={14} />Manage {item.displayName}</button>)}</div> : <form onSubmit={save} className="cf-management-form">
      <div className="cf-management-heading"><h3>{mode === 'student' ? 'Edit student profile' : 'Guardian contact and pickup authority'}</h3><button type="button" className="icon-button" aria-label="Close editor" disabled={blocked} onClick={() => { setMode(null); setError(''); }}><X size={17} /></button></div>
      <fieldset disabled={state !== 'editing'}><div className="cf-form-grid">{mode === 'student' ? <>
        <label className="field"><span>First name</span><input required maxLength={100} value={student.firstName} onChange={event => setStudent(current => ({ ...current, firstName: event.target.value }))} /></label>
        <label className="field"><span>Last name</span><input maxLength={100} value={student.lastName} onChange={event => setStudent(current => ({ ...current, lastName: event.target.value }))} /></label>
        <label className="field"><span>Grade</span><input maxLength={30} value={student.grade} onChange={event => setStudent(current => ({ ...current, grade: event.target.value }))} /></label>
        <label className="field"><span>Enrollment status</span><select aria-label="Enrollment status" value={student.active ? 'active' : 'inactive'} onChange={event => setStudent(current => ({ ...current, active: event.target.value === 'active' }))}><option value="active">Active</option><option value="inactive">Inactive</option></select></label>
        <div className="field cf-form-wide"><span>Subjects</span><div className="cf-subject-options">{[...new Set(['Math', 'Reading', ...baseline.student.subjects])].map(subject => <label key={subject}><input type="checkbox" checked={student.subjects.includes(subject)} onChange={event => setStudent(current => ({ ...current, subjects: event.target.checked ? [...current.subjects, subject] : current.subjects.filter(value => value !== subject) }))} />{subject}</label>)}</div></div>
        <label className="field cf-form-wide"><span>Pickup restriction or alert</span><textarea aria-label="Pickup restriction or alert" rows={3} maxLength={1000} value={student.pickupAlert} onChange={event => setStudent(current => ({ ...current, pickupAlert: event.target.value }))} /></label>
      </> : guardian && <>
        <label className="field"><span>Guardian name</span><input required maxLength={150} value={guardian.displayName} onChange={event => setGuardian(current => ({ ...current!, displayName: event.target.value }))} /></label>
        <label className="field"><span>Relationship</span><input maxLength={100} value={guardian.relationship} onChange={event => setGuardian(current => ({ ...current!, relationship: event.target.value }))} /></label>
        <label className="field"><span>Email</span><input type="email" maxLength={200} value={guardian.email} onChange={event => setGuardian(current => ({ ...current!, email: event.target.value }))} /></label>
        <label className="field"><span>Phone</span><input type="tel" maxLength={50} value={guardian.phone} onChange={event => setGuardian(current => ({ ...current!, phone: event.target.value }))} /></label>
        <label className="field cf-form-wide"><span>Pickup authority for this student</span><select aria-label="Pickup authority for this student" value={guardian.pickupAuthority} onChange={event => setGuardian(current => ({ ...current!, pickupAuthority: event.target.value as Guardian['pickupAuthority'] }))}><option value="unverified">Unverified</option><option value="allowed">Authorized for pickup</option><option value="denied">Not authorized for pickup</option></select></label>
        <label className="field cf-form-wide"><span>Verification evidence or restriction note</span><textarea aria-label="Verification evidence or restriction note" rows={3} maxLength={1000} required={guardian.pickupAuthority === 'allowed'} minLength={guardian.pickupAuthority === 'allowed' ? 5 : undefined} value={guardian.authorityNote} onChange={event => setGuardian(current => ({ ...current!, authorityNote: event.target.value }))} placeholder="Record what you verified and when." /></label>
      </>}</div></fieldset>
      <p className="cf-management-hint">{mode === 'student' ? 'Changing enrollment keeps attendance history and scheduled lessons. An open visit still needs its observed departure recorded.' : 'Contact details may be shared with other students linked to this guardian. Pickup authority applies to this student. Record evidence before authorizing pickup.'}</p>
      {error && <div className={`cf-notice ${state === 'uncertain' ? 'amber' : 'error'}`} role="alert">{error}</div>}
      <div className="modal-actions">{state === 'uncertain' || state === 'confirmed' ? <button type="button" className="btn btn-primary" onClick={() => void check()}>{state === 'confirmed' ? 'Refresh saved record' : 'Check saved record'}</button> : state === 'stale' ? <button type="button" className="btn btn-primary" onClick={() => void check(true)}>Reload current record</button> : <><button type="button" className="btn btn-secondary" disabled={blocked} onClick={() => { setMode(null); setError(''); }}>Cancel</button><button className="btn btn-primary" disabled={blocked}>{state === 'saving' ? 'Saving...' : mode === 'student' ? 'Save student profile' : 'Save guardian details'}</button></>}</div>
    </form>}
  </section>;
}
