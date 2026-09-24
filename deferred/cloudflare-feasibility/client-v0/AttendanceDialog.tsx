import { useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, RefreshCw } from 'lucide-react';
import { Avatar, Badge, Modal } from './shared/components';
import type { AttendanceRequest, AttendanceResult, Center, StudentDetail } from '../shared/types';
import { displayTime, toDateTimeInput } from './utils';

export type PendingAttendance = { request: AttendanceRequest; studentName: string; actorId: string; state: 'sending' | 'uncertain' | 'confirmed' | 'rejected'; message?: string; result?: AttendanceResult };

export default function AttendanceDialog({ detail, center, departure, pending, onSend, onRetry, onResolve, onClose }: { detail: StudentDetail; center: Center; departure: boolean; pending: PendingAttendance | null; onSend: (request: AttendanceRequest) => void; onRetry: () => void; onResolve: () => void; onClose: () => void }) {
  const requestId = useRef(crypto.randomUUID());
  const unmatchedDeparture = departure && !detail.visits.some(visit => !visit.checkOutAt);
  const [exceptional, setExceptional] = useState(unmatchedDeparture);
  const [guardianId, setGuardianId] = useState('');
  const [reason, setReason] = useState('');
  const [earlier, setEarlier] = useState(false);
  const [observedAt, setObservedAt] = useState(toDateTimeInput(new Date().toISOString()));
  const [confirmedObservation, setConfirmedObservation] = useState(false);
  const [error, setError] = useState('');
  const active = pending?.state === 'sending' || pending?.state === 'uncertain';
  const allowed = detail.guardians.filter(guardian => guardian.pickupAuthority === 'allowed');
  const close = () => { if (!active) onClose(); };
  const submit = () => {
    setError('');
    if (!confirmedObservation) return setError('Confirm that you observed this arrival or departure.');
    if (departure && !exceptional && detail.student.pickupAlert) return setError('Standard pickup is blocked while this restriction is active. Ask a manager to review it.');
    if (departure && !exceptional && !guardianId) return setError('Choose a guardian with verified pickup authority.');
    if (departure && (exceptional || earlier) && reason.trim().length < 5) return setError('Add a note explaining the observation.');
    const time = earlier ? new Date(observedAt) : new Date();
    if (!Number.isFinite(time.getTime()) || time.getTime() > Date.now() + 60000 || time.getTime() < Date.now() - 86400000) return setError('Enter the actual observation time within the past 24 hours. Ask a manager to correct older records.');
    onSend({ eventId: requestId.current, studentId: detail.student.id, action: departure ? exceptional ? 'exceptional_departure' : 'check_out' : 'check_in', observedAt: time.toISOString(), ...(departure && !exceptional ? { guardianId } : {}), ...(departure && reason.trim() ? { reason: reason.trim() } : {}) });
  };
  return <Modal title={pending?.state === 'confirmed' ? 'Attendance confirmed' : departure ? 'Record a departure' : 'Record an arrival'} subtitle="Record the event you observed. A scheduled lesson does not confirm attendance." onClose={close}>
    {pending?.state === 'confirmed' ? <div className="cf-attendance-confirm"><CheckCircle2 size={42} /><h3>{pending.result?.event.action === 'check_in' ? 'Arrival recorded.' : 'Departure recorded.'}</h3><p>{detail.student.displayName}<br />{pending.result && displayTime(pending.result.event.observedAt, center.timezone)} · {center.timezone.replaceAll('_', ' ')}</p>{pending.result?.visit?.reviewStatus === 'pending' && <div className="cf-notice amber">This departure needs a manager's review. Recording it does not grant pickup permission.</div>}<button className="btn btn-primary" onClick={close}>Done</button></div> : <div className="cf-attendance">
      <div className="cf-profile-heading"><Avatar name={detail.student.displayName} size="lg" /><div><h3>{detail.student.displayName}</h3><p>{detail.student.studentCode}</p></div></div>
      {active ? <><div className={`cf-notice ${pending.state === 'uncertain' ? 'amber' : ''}`} role="status"><strong>{pending.state === 'sending' ? 'Waiting for confirmation...' : 'This attendance request is not yet confirmed.'}</strong><br />{pending.message || 'Keep this window open until the result is confirmed.'}</div><p className="cf-modal-lock-note">Do not record this event again. Checking the result or retrying below will use this same request. Other attendance actions stay locked until it is resolved.</p>{pending.state === 'uncertain' && <div className="modal-actions"><button className="btn btn-secondary" onClick={onResolve}><RefreshCw size={15} />Check result</button><button className="btn btn-primary" onClick={onRetry}>Retry this request</button></div>}<p className="cf-request-ref">Request reference: {pending.request.eventId}</p></> : <>
        {detail.student.pickupAlert && <div className="cf-notice amber"><AlertTriangle size={15} /> <strong>Pickup restriction</strong><br />{detail.student.pickupAlert}</div>}
        {departure && <>{unmatchedDeparture && <div className="cf-notice amber">No recorded arrival is open for this student. Record an exceptional departure only if you observed the student leave, and explain the missing arrival record for manager review.</div>}<div className="cf-observation-options"><label><input type="radio" name="departure-mode" disabled={Boolean(detail.student.pickupAlert) || unmatchedDeparture} checked={!exceptional} onChange={() => setExceptional(false)} /><span><strong>Authorized pickup observed</strong><small>Use only after checking the guardian. Standard pickup is blocked while a pickup restriction is active.</small></span></label><label><input type="radio" name="departure-mode" checked={exceptional} onChange={() => setExceptional(true)} /><span><strong>Departure outside the normal pickup process</strong><small>The student has actually left. Record what happened for manager review. This does not authorize release.</small></span></label></div>{!exceptional && <label className="field"><span>Guardian who collected the student</span><select value={guardianId} onChange={event => setGuardianId(event.target.value)}><option value="">Choose an authorized guardian</option>{allowed.map(guardian => <option value={guardian.id} key={guardian.id}>{guardian.displayName} · {guardian.relationship}</option>)}</select>{!allowed.length && <small className="form-error">No verified pickup authority is recorded. Ask the manager to review the student's guardian details.</small>}</label>}{exceptional && <Badge tone="amber">Manager review required</Badge>}</>}
        <div className="cf-observation-options"><label><input type="radio" name="observation-time" checked={!earlier} onChange={() => setEarlier(false)} /><span><strong>Observed now</strong><small>The observation time is recorded when you confirm.</small></span></label><label><input type="radio" name="observation-time" checked={earlier} onChange={() => setEarlier(true)} /><span><strong>Observed earlier</strong><small>Use the actual time within the past 24 hours. Older records need a manager correction.</small></span></label></div>
        {earlier && <label className="field"><span>Observation time · this device's time zone</span><input type="datetime-local" value={observedAt} onChange={event => setObservedAt(event.target.value)} /></label>}
        {departure && <label className="field"><span>{exceptional || earlier ? 'Observation note · required' : 'Observation note · optional'}</span><textarea rows={3} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder={exceptional ? 'What happened, who was present, and who was notified?' : 'Add any relevant details'} /></label>}
        <label className="cf-check-label"><input type="checkbox" checked={confirmedObservation} onChange={event => setConfirmedObservation(event.target.checked)} /><span>I observed this {departure ? 'departure' : 'arrival'} and have checked the student and time.</span></label>
        {error && <p className="form-error" role="alert">{error}</p>}
        {pending?.message && <p className="form-error" role="alert">{pending.message}</p>}
        <div className="modal-actions"><button className="btn btn-secondary" onClick={close}>Cancel</button><button className="btn btn-primary" disabled={!confirmedObservation} onClick={submit}>Record {departure ? 'departure' : 'arrival'}</button></div>
      </>}
    </div>}
  </Modal>;
}
