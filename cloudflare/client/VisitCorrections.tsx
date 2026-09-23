import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import type { Actor, Center, Correction, CorrectionInput, VisitSummary } from '../shared/types';
import { Modal } from './shared/components';
import { RequestError, messageOf, request, send } from './api';
import { correctionPayload, localTimeInput } from './management-state';
import { displayDate, displayTime } from './utils';
import './student-management.css';

export type CorrectionDraft = { actorId: string; visit: VisitSummary; request: CorrectionInput; state: 'sending' | 'uncertain' | 'confirmed'; correction?: Correction };
const label = (value: string | null, center: Center) => value ? `${displayDate(value, center.timezone)} ${displayTime(value, center.timezone)}` : 'No departure recorded';

export default function VisitCorrectionDialog({ initialVisit, center, actor, draftStore, onBusyChange, onAccessExpired, onSaved, onClose }: {
  initialVisit: VisitSummary; center: Center; actor: Actor; draftStore: MutableRefObject<CorrectionDraft | null>;
  onBusyChange: (busy: boolean) => void; onAccessExpired: () => void; onSaved: () => Promise<void>; onClose: () => void;
}) {
  const initial = draftStore.current?.visit || initialVisit;
  const [visit, setVisit] = useState(initial), [arrival, setArrival] = useState(localTimeInput(initial.checkInAt)), [departure, setDeparture] = useState(initial.checkOutAt ? localTimeInput(initial.checkOutAt) : '');
  const [reason, setReason] = useState(draftStore.current?.request.reason || ''), [draft, setDraft] = useState(draftStore.current);
  const [sending, setSending] = useState(false), [error, setError] = useState(''), [stale, setStale] = useState(false);
  const inFlight = useRef(false), mounted = useRef(true);
  const unresolved = sending || Boolean(draft && draft.state !== 'confirmed');
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const retain = (value: CorrectionDraft | null) => { draftStore.current = value; if (mounted.current) setDraft(value); };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange(false); }; }, [onBusyChange]);
  useEffect(() => { onBusyChange(unresolved); }, [unresolved, onBusyChange]);
  const failAccess = (failure: unknown) => { if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired(); };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (inFlight.current || stale) return; setError('');
    let payload: CorrectionInput;
    try { payload = draft?.request || correctionPayload(visit, arrival, departure, reason, crypto.randomUUID()); }
    catch (failure) { setError(messageOf(failure)); return; }
    if (draft && draft.actorId !== actor.id) { setError('Sign in as the manager who submitted this correction to resolve its result.'); return; }
    inFlight.current = true; setSending(true);
    const pending: CorrectionDraft = { actorId: actor.id, visit, request: payload, state: 'sending' }; retain(pending);
    try {
      const result = await send<{ correction: Correction; replayed: boolean }>(`/api/admin/visits/${visit.id}/corrections`, payload);
      if (result.correction.id !== payload.correctionId || result.correction.visitId !== visit.id) throw new RequestError('The returned correction did not match the submitted request.');
      retain({ ...pending, state: 'confirmed', correction: result.correction });
      try { await onSaved(); } catch { if (mounted.current) setError('The correction is saved. Refresh attendance before recording another observation.'); }
    } catch (failure) {
      if (!(failure instanceof RequestError) || failure.uncertain) { retain({ ...pending, state: 'uncertain' }); if (mounted.current) setError('The result could not be confirmed. Retry this same correction when connected. Its original request ID prevents a second correction.'); }
      else if ([401, 403].includes(failure.status)) { retain({ ...pending, state: 'uncertain' }); if (mounted.current) setError('Sign in again, then retry this same correction to confirm its result.'); failAccess(failure); }
      else { retain(null); if (mounted.current) { setError(messageOf(failure)); setStale(failure.code === 'STALE_VISIT'); } }
    } finally { inFlight.current = false; if (mounted.current) setSending(false); }
  };
  const reload = async () => {
    if (inFlight.current) return; inFlight.current = true; setSending(true); setError('');
    try { const result = await request<{ visit: VisitSummary }>(`/api/admin/visits/${visit.id}`); setVisit(result.visit); setArrival(localTimeInput(result.visit.checkInAt)); setDeparture(result.visit.checkOutAt ? localTimeInput(result.visit.checkOutAt) : ''); setReason(''); setStale(false); retain(null); }
    catch (failure) { setError(messageOf(failure)); failAccess(failure); }
    finally { inFlight.current = false; setSending(false); }
  };
  const confirmed = draft?.state === 'confirmed';
  return <Modal title={confirmed ? 'Attendance correction saved' : `Correct ${visit.studentName}'s visit`} subtitle="A manager correction preserves the original observations and records a reason." onClose={() => { if (!unresolved) { retain(null); onClose(); } }} wide>
    {confirmed ? <><div className="cf-notice success" role="status">The correction has been recorded once. The original arrival and departure remain unchanged in the audit history.</div><div className="cf-correction-original"><h3>Saved effective times · {center.timezone.replaceAll('_', ' ')}</h3><p>Arrival: {label(draft.correction!.checkInAt, center)}</p><p>Departure: {label(draft.correction!.checkOutAt, center)}</p><p>Reason: {draft.correction!.reason}</p></div>{error && <div className="cf-notice amber" role="alert">{error}</div>}<div className="modal-actions"><button className="btn btn-primary" onClick={() => { retain(null); onClose(); }}>Done</button></div></> : <form className="cf-attendance" onSubmit={save}>
      <div className="cf-correction-original"><h3>Original observations · {center.timezone.replaceAll('_', ' ')}</h3><p>Arrival: {label(visit.originalCheckInAt, center)}</p><p>Departure: {label(visit.originalCheckOutAt, center)}</p></div>
      <p className="cf-management-hint">Enter the actual times in your computer's time zone, <strong>{timezone.replaceAll('_', ' ')}</strong>. This visit was last reviewed at version {visit.version}.</p>
      <fieldset className="cf-correction-fields" disabled={sending || Boolean(draft) || stale}><div className="cf-correction-times">
        <label className="field"><span>Actual arrival time</span><input type="datetime-local" step={1} required value={arrival} onChange={event => setArrival(event.target.value)} /></label>
        {visit.checkOutAt ? <label className="field"><span>Actual departure time</span><input type="datetime-local" step={1} required value={departure} onChange={event => setDeparture(event.target.value)} /></label> : <p className="cf-management-hint">This visit has no recorded departure. Use the attendance workflow when a departure is observed.</p>}
      </div><label className="field" style={{ marginTop: 18 }}><span>Reason for correction</span><textarea aria-label="Reason for correction" rows={3} required minLength={5} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} placeholder="Explain the factual correction and what you verified." /></label></fieldset>
      {draft && <p className="cf-correction-request">Request reference: {draft.request.correctionId}. Submitted arrival: {label(draft.request.checkInAt, center)}. Submitted departure: {label(draft.request.checkOutAt, center)}.</p>}
      {error && <div className={`cf-notice ${draft ? 'amber' : 'error'}`} role="alert">{error}</div>}
      <div className="modal-actions"><button type="button" className="btn btn-secondary" disabled={unresolved} onClick={() => { retain(null); onClose(); }}>Cancel</button>{stale ? <button type="button" className="btn btn-primary" disabled={sending} onClick={() => void reload()}>Reload current visit</button> : <button className="btn btn-primary" disabled={sending}>{sending ? 'Saving...' : draft ? 'Retry same correction' : 'Save correction'}</button>}</div>
    </form>}
  </Modal>;
}
