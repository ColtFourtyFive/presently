import { useEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import type {
  Actor,
  Center,
  CorrectableObservation,
  ObservationCorrection,
  ObservationCorrectionInput,
  ObservationCorrectionResult,
  ObservationEffectiveTime,
} from '../shared/types';
import { Modal } from './shared/components';
import { RequestError, messageOf, request, send } from './api';
import { editedTime, localTimeInput } from './management-state';
import { displayDate, displayTime } from './utils';

export type ObservationCorrectionDraft = {
  actorId: string;
  event: CorrectableObservation;
  request: ObservationCorrectionInput;
  state: 'sending' | 'uncertain' | 'confirmed';
  correction?: ObservationCorrection;
};

const label = (value: string, center: Center) =>
  `${displayDate(value, center.timezone)} ${displayTime(value, center.timezone)}`;

export default function ObservationCorrectionDialog({
  initialEvent,
  center,
  actor,
  draftStore,
  onBusyChange,
  onAccessExpired,
  onSaved,
  onClose,
}: {
  initialEvent: CorrectableObservation;
  center: Center;
  actor: Actor;
  draftStore: MutableRefObject<ObservationCorrectionDraft | null>;
  onBusyChange: (busy: boolean) => void;
  onAccessExpired: () => void;
  onSaved: () => void;
  onClose: () => void;
}) {
  const initial = draftStore.current?.event || initialEvent;
  const [event, setEvent] = useState(initial);
  const [effectiveTime, setEffectiveTime] = useState(localTimeInput(initial.effectiveObservedAt));
  const [reason, setReason] = useState(draftStore.current?.request.reason || '');
  const [draft, setDraft] = useState(draftStore.current);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const unresolved = sending || Boolean(draft && draft.state !== 'confirmed');
  const retain = (value: ObservationCorrectionDraft | null) => {
    draftStore.current = value;
    if (mounted.current) setDraft(value);
  };
  useEffect(() => () => { mounted.current = false; }, []);
  useEffect(() => { onBusyChange(unresolved); }, [unresolved, onBusyChange]);
  const failAccess = (failure: unknown) => {
    if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired();
  };

  const save = async (formEvent: FormEvent) => {
    formEvent.preventDefault();
    if (inFlight.current) return;
    let payload: ObservationCorrectionInput;
    try {
      if (draft) payload = draft.request;
      else {
        const effectiveObservedAt = editedTime(effectiveTime, event.effectiveObservedAt);
        if (Date.parse(effectiveObservedAt) > Date.now()) throw new Error('Corrected time cannot be in the future.');
        if (Date.parse(effectiveObservedAt) === Date.parse(event.effectiveObservedAt)) {
          throw new Error('Choose a different effective departure time.');
        }
        const trimmed = reason.trim();
        if (trimmed.length < 5 || trimmed.length > 2000) {
          throw new Error('Explain the factual correction in 5 to 2,000 characters.');
        }
        payload = {
          correctionId: crypto.randomUUID(),
          expectedVersion: event.observationVersion,
          effectiveObservedAt,
          reason: trimmed,
        };
      }
    } catch (failure) {
      setError(messageOf(failure));
      return;
    }
    if (draft && draft.actorId !== actor.id) {
      setError('Sign in as the manager who submitted this correction to resolve its result.');
      return;
    }
    inFlight.current = true;
    setSending(true);
    setError('');
    const pending: ObservationCorrectionDraft = {
      actorId: actor.id,
      event,
      request: payload,
      state: 'sending',
    };
    retain(pending);
    try {
      const result = await send<ObservationCorrectionResult>(
        `/api/admin/attendance/events/${event.id}/corrections`,
        payload,
      );
      if (
        result.correction.id !== payload.correctionId
        || result.correction.eventId !== event.id
        || result.correction.effectiveObservedAt !== payload.effectiveObservedAt
      ) throw new RequestError('The returned correction did not match the submitted request.');
      retain({ ...pending, state: 'confirmed', correction: result.correction });
      onSaved();
    } catch (failure) {
      if (!(failure instanceof RequestError) || failure.uncertain) {
        retain({ ...pending, state: 'uncertain' });
        setError('The result could not be confirmed. Retry the same correction when connected.');
      } else if ([401, 403].includes(failure.status)) {
        retain({ ...pending, state: 'uncertain' });
        setError('Sign in again, then retry the same correction to confirm its result.');
        failAccess(failure);
      } else {
        retain(null);
        setError(messageOf(failure));
        setStale(failure.code === 'STALE_OBSERVATION');
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  };

  const reload = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError('');
    try {
      const result = await request<{
        observation: ObservationEffectiveTime;
        corrections: ObservationCorrection[];
      }>(`/api/admin/attendance/events/${event.id}/corrections`);
      const refreshed: CorrectableObservation = {
        ...event,
        effectiveObservedAt: result.observation.effectiveObservedAt,
        observationVersion: result.observation.version,
        observationCorrections: result.corrections,
      };
      setEvent(refreshed);
      setEffectiveTime(localTimeInput(refreshed.effectiveObservedAt));
      setReason('');
      setStale(false);
      retain(null);
    } catch (failure) {
      setError(messageOf(failure));
      failAccess(failure);
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };

  const confirmed = draft?.state === 'confirmed';
  return <Modal
    title={confirmed ? 'Observation correction saved' : 'Correct unmatched departure time'}
    subtitle="The original observation and accepted receipt remain unchanged."
    onClose={() => { if (!unresolved) { retain(null); onClose(); } }}
  >
    {confirmed ? <>
      <div className="cf-notice success" role="status">The effective departure time was corrected once. The original observation remains in the record.</div>
      <div className="cf-correction-original">
        <h3>Saved correction · {center.timezone.replaceAll('_', ' ')}</h3>
        <p>Original observation: {label(draft.correction!.originalObservedAt, center)}</p>
        <p>Effective departure: {label(draft.correction!.effectiveObservedAt, center)}</p>
        <p>Reason: {draft.correction!.reason}</p>
      </div>
      {error && <div className="cf-notice amber" role="alert">{error}</div>}
      <div className="modal-actions"><button className="btn btn-primary" onClick={() => { retain(null); onClose(); }}>Done</button></div>
    </> : <form className="cf-attendance" onSubmit={save}>
      <div className="cf-correction-original">
        <h3>Immutable observation · {center.timezone.replaceAll('_', ' ')}</h3>
        <p>Originally observed: {label(event.observedAt, center)}</p>
        <p>Current effective time: {label(event.effectiveObservedAt, center)}</p>
      </div>
      <p className="cf-management-hint">This unmatched departure has no visit or arrival. You are correcting only its effective departure time at version {event.observationVersion}.</p>
      <fieldset className="cf-correction-fields" disabled={sending || Boolean(draft) || stale}>
        <label className="field"><span>Effective departure time</span><input type="datetime-local" step={1} required value={effectiveTime} onChange={input => setEffectiveTime(input.target.value)} /></label>
        <label className="field" style={{ marginTop: 18 }}><span>Reason for correction</span><textarea rows={3} required minLength={5} maxLength={2000} value={reason} onChange={input => setReason(input.target.value)} placeholder="Explain what source you verified." /></label>
      </fieldset>
      {draft && <p className="cf-correction-request">Request reference: {draft.request.correctionId}. Effective departure: {label(draft.request.effectiveObservedAt, center)}.</p>}
      {error && <div className={`cf-notice ${draft ? 'amber' : 'error'}`} role="alert">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn btn-secondary" disabled={unresolved} onClick={() => { retain(null); onClose(); }}>Cancel</button>
        {stale
          ? <button type="button" className="btn btn-primary" disabled={sending} onClick={() => void reload()}>Reload current observation</button>
          : <button className="btn btn-primary" disabled={sending}>{sending ? 'Saving...' : draft ? 'Retry same correction' : 'Save correction'}</button>}
      </div>
    </form>}
  </Modal>;
}
