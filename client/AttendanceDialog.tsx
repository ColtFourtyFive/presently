import { useState, useCallback, type FormEvent } from 'react';
import { ArrowDownLeft, ArrowUpRight, ShieldCheck, AlertTriangle, Clock3, Check } from 'lucide-react';
import { Avatar, Badge, Modal, SubjectTags } from './components';
import { mutate } from './api';
import { errorMessage, fullName, openVisit, shortTime } from './utils';
import type { Bootstrap, Student, AttendanceInput } from '../shared/types';

export default function AttendanceDialog({student,data,onClose,onSaved,notify}:{student:Student;data:Bootstrap;onClose:()=>void;onSaved:()=>Promise<void>;notify:(message:string,kind?:'success'|'error')=>void}) {
  const visit=openVisit(data,student.id);const [action,setAction]=useState<AttendanceInput['action']>(visit?'check_out':'check_in');
  const [guardianId,setGuardianId]=useState(student.guardians.find(g=>g.canPickup)?.id||'');const [reason,setReason]=useState('');const [confirmed,setConfirmed]=useState(false);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [eventId,setEventId]=useState(()=>crypto.randomUUID());
  const isDeparture=action!=='check_in';const isException=action==='exceptional_departure';
  const close=useCallback(()=>{if(!busy)onClose();},[busy,onClose]);
  const changeAction=(a:AttendanceInput['action'])=>{setAction(a);setEventId(crypto.randomUUID());setError('');setConfirmed(false);};
  async function submit(e:FormEvent){e.preventDefault();if(!confirmed)return;setBusy(true);setError('');try{await mutate('/attendance',{eventId,studentId:student.id,action,...(action==='check_out'?{guardianId}:{}),...(isException?{reason}:{})});await onSaved();notify(`${student.firstName}'s ${isDeparture?'departure':'arrival'} is recorded.`);onClose();}catch(e){setError(errorMessage(e));}finally{setBusy(false);}}
  return <Modal title={isException?'Record an exceptional departure':isDeparture?'Check out student':'Check in student'} subtitle="Record what is happening at the center right now." onClose={close}>
    <div className="student-confirmation"><Avatar name={fullName(student)} size="lg"/><div><h3>{fullName(student)}</h3><p>{student.studentNumber} <span>·</span> {student.grade||'Student'}</p><SubjectTags subjects={student.subjects}/></div><Badge tone={visit?'green':'gray'}>{visit?'Here now':'Not checked in'}</Badge></div>
    {visit&&<div className="detail-line"><Clock3 size={15}/> Arrived at {shortTime(visit.checkedInAt,data.center.timezone)}</div>}
    <form onSubmit={submit}>
      {isDeparture&&!isException&&<><div className="field"><label htmlFor="pickup-guardian">Who is picking up?</label><select id="pickup-guardian" value={guardianId} onChange={e=>{setGuardianId(e.target.value);setEventId(crypto.randomUUID());}} required><option value="">Select an authorized adult</option>{student.guardians.filter(g=>g.canPickup).map(g=><option key={g.id} value={g.id}>{g.name} · {g.relationship}</option>)}</select></div>{student.pickupAlert?<div className="notice notice-amber"><AlertTriangle size={18}/><div><strong>Manager review required</strong><p>{student.pickupAlert}</p><p>A normal check-out is restricted for this student. Verify the release procedure with the manager.</p></div></div>:<div className="notice notice-subtle"><ShieldCheck size={18}/><p>Confirm this adult's identity and pickup authorization before releasing the student.</p></div>}</>}
      {isException&&<><div className="notice notice-amber"><AlertTriangle size={18}/><div><strong>Use only when the student has actually left.</strong><p>This records the departure and opens an incident for the manager. It does not authorize a release.</p></div></div><div className="field"><label htmlFor="departure-reason">What happened?</label><textarea id="departure-reason" value={reason} onChange={e=>{setReason(e.target.value);setEventId(crypto.randomUUID());}} placeholder="Record the observed facts and who was notified." required minLength={8} rows={3}/></div></>}
      {!isDeparture&&<div className="notice notice-subtle"><ArrowDownLeft size={18}/><p>The arrival time will be recorded when you confirm. Scheduled times do not change attendance.</p></div>}
      <label className="confirm-checkbox"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span>{isDeparture?'I have observed that this student has left the center.':'I have confirmed this student is physically at the center.'}</span></label>
      {error&&<div className="form-error" role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="btn btn-secondary" onClick={close} disabled={busy}>Cancel</button><button className={`btn ${isException?'btn-danger':'btn-primary'}`} type="submit" disabled={busy||!confirmed||(isDeparture&&!isException&&!!student.pickupAlert)}>{busy?<span className="spinner"/>:isDeparture?<ArrowUpRight size={17}/>:<Check size={17}/>} {busy?'Saving…':isException?'Record departure and incident':isDeparture?'Confirm check-out':'Confirm check-in'}</button></div>
    </form>
    <div className="exception-switch">{isException?<button onClick={()=>changeAction(visit?'check_out':'check_in')} className="text-button">Back to normal attendance</button>:<button onClick={()=>changeAction('exceptional_departure')} className="text-button">Student left unexpectedly? Record an exceptional departure</button>}</div>
  </Modal>;
}
