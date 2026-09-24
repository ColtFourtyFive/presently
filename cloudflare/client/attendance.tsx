import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, LogIn, LogOut, ShieldAlert } from 'lucide-react';
import type { AttendanceAction, AttendanceRequest, AttendanceResult, KioskGuardian, KioskStudentDetail, Student, StudentDetail, VisitSummary } from '../shared/types';
import { RequestError, messageOf, type Api } from './api';
import { Alert, Badge, Button, Modal, Spinner } from './components';
import { formatTime, newRequestId } from './format';

type Loaded = { student: Student; guardians: KioskGuardian[]; openVisit: VisitSummary | null };
export type Pending = { request: AttendanceRequest; studentName: string; message: string };

/**
 * Submit an observation. The request id stays the same across retries, so a
 * retry after a lost reply can never record the observation twice. When the
 * outcome is uncertain, look the request up before reporting anything.
 */
export async function submitAttendance(api: Api, request: AttendanceRequest): Promise<AttendanceResult> {
  try {
    return await api.post<AttendanceResult>('/attendance', request);
  } catch (error) {
    if (!(error instanceof RequestError) || !error.uncertain) throw error;
    try {
      return await api.get<AttendanceResult>(`/attendance/events/${request.eventId}`);
    } catch (lookup) {
      if (lookup instanceof RequestError && lookup.code === 'EVENT_NOT_FOUND') return api.post<AttendanceResult>('/attendance', request);
      throw error;
    }
  }
}

function toLoaded(value: StudentDetail | KioskStudentDetail): Loaded {
  if ('openVisit' in value) return value;
  return {
    student: value.student,
    guardians: value.guardians.map(g => ({ id: g.id, displayName: g.displayName, relationship: g.relationship, pickupAuthority: g.pickupAuthority })),
    openVisit: value.visits.find(v => v.checkOutAt === null) ?? null,
  };
}

/** Arrival and departure for one student, used by both the kiosk and the back office. */
export function AttendanceSheet({ api, studentId, timezone, onClose, onRecorded }: {
  api: Api; studentId: number; timezone: string; onClose: () => void; onRecorded: (result: AttendanceResult) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [guardianId, setGuardianId] = useState<number | null>(null);
  const [exceptional, setExceptional] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState<AttendanceResult | null>(null);
  const pending = useRef<AttendanceRequest | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.get<StudentDetail | KioskStudentDetail>(`/students/${studentId}?pageSize=5`, controller.signal)
      .then(value => setLoaded(toLoaded(value)))
      .catch(e => { if (!controller.signal.aborted) setError(messageOf(e)); });
    return () => controller.abort();
  }, [api, studentId]);

  async function record(action: AttendanceAction) {
    // Reuse the pending request id when retrying the same action.
    const reuse = pending.current && pending.current.action === action && pending.current.studentId === studentId;
    const request: AttendanceRequest = reuse ? pending.current! : {
      eventId: newRequestId(), studentId, action, observedAt: new Date().toISOString(),
      ...(action === 'check_out' && guardianId ? { guardianId } : {}),
      ...(action === 'exceptional_departure' ? { reason: reason.trim() } : {}),
    };
    pending.current = request;
    setBusy(true);
    setError('');
    try {
      const result = await submitAttendance(api, request);
      pending.current = null;
      setConfirmed(result);
      onRecorded(result);
    } catch (e) {
      if (e instanceof RequestError && !e.uncertain) pending.current = null;
      setError(e instanceof RequestError && e.uncertain
        ? 'Not confirmed. The connection dropped before the server replied. Tap the same button again to retry safely.'
        : messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  const name = loaded?.student.displayName ?? 'Student';
  if (confirmed) {
    const arrived = confirmed.event.action === 'check_in';
    return (
      <Modal title={name} onClose={onClose}>
        <div className="confirmation">
          <CheckCircle2 size={48} aria-hidden="true" />
          <p className="confirmation-title">{arrived ? 'Checked in' : confirmed.event.action === 'exceptional_departure' ? 'Departure recorded for review' : 'Checked out'}</p>
          <p className="muted">Saved at {formatTime(confirmed.event.observedAt, timezone)} by {confirmed.event.actorName}{confirmed.replayed ? ' (already saved earlier)' : ''}.</p>
          <Button variant="primary" onClick={onClose}>Done</Button>
        </div>
      </Modal>
    );
  }
  const allowed = loaded?.guardians.filter(g => g.pickupAuthority === 'allowed') ?? [];
  const present = !!loaded?.openVisit;
  return (
    <Modal title={name} subtitle={loaded ? `Student code ${loaded.student.studentCode}` : undefined} onClose={onClose}>
      {!loaded && !error && <Spinner />}
      <Alert>{error}</Alert>
      {loaded && (
        <div className="attendance-sheet">
          {!loaded.student.active && <Alert tone="warning">This student is inactive and cannot be checked in.</Alert>}
          {loaded.student.pickupAlert && (
            <div className="pickup-alert"><ShieldAlert size={20} aria-hidden="true" /><div><strong>Pickup alert</strong><p>{loaded.student.pickupAlert}</p></div></div>
          )}
          <p className="status-line">
            {present ? <>Here since <strong>{formatTime(loaded.openVisit!.checkInAt, timezone)}</strong></> : 'Not checked in'}
          </p>
          {!present && (
            <Button variant="primary" className="btn-xl" busy={busy} disabled={!loaded.student.active} onClick={() => record('check_in')}>
              <LogIn size={22} aria-hidden="true" /> Check in now
            </Button>
          )}
          {present && !exceptional && (
            <>
              <fieldset className="guardian-choice">
                <legend>Who is picking up?</legend>
                {allowed.length === 0 && <p className="muted">No guardian has verified pickup authority. Use “Record a different departure”.</p>}
                {allowed.map(g => (
                  <label key={g.id} className={`choice ${guardianId === g.id ? 'choice-selected' : ''}`}>
                    <input type="radio" name="guardian" checked={guardianId === g.id} onChange={() => setGuardianId(g.id)} />
                    <span><strong>{g.displayName}</strong>{g.relationship && <span className="muted"> · {g.relationship}</span>}</span>
                    <Badge tone="green">Verified</Badge>
                  </label>
                ))}
                {loaded.guardians.filter(g => g.pickupAuthority !== 'allowed').map(g => (
                  <div key={g.id} className="choice choice-disabled">
                    <span><strong>{g.displayName}</strong>{g.relationship && <span className="muted"> · {g.relationship}</span>}</span>
                    <Badge tone={g.pickupAuthority === 'denied' ? 'red' : 'amber'}>{g.pickupAuthority === 'denied' ? 'Not allowed' : 'Not verified'}</Badge>
                  </div>
                ))}
              </fieldset>
              <Button variant="primary" className="btn-xl" busy={busy} disabled={!guardianId || !!loaded.student.pickupAlert} onClick={() => record('check_out')}>
                <LogOut size={22} aria-hidden="true" /> Check out now
              </Button>
              <Button variant="ghost" onClick={() => setExceptional(true)}><AlertTriangle size={18} aria-hidden="true" /> Record a different departure</Button>
            </>
          )}
          {present && exceptional && (
            <div className="exceptional">
              <p>Use this when the student has already left without a verified pickup. It records what happened and alerts a manager. It is not permission to release a student.</p>
              <label className="field">
                <span className="field-label">What happened?</span>
                <textarea rows={3} value={reason} onChange={e => setReason(e.target.value)} placeholder="Who the student left with, and what staff did" />
              </label>
              <div className="row">
                <Button variant="ghost" onClick={() => setExceptional(false)}>Back</Button>
                <Button variant="danger" busy={busy} disabled={reason.trim().length < 5} onClick={() => record('exceptional_departure')}>Record departure for review</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
