import { useCallback, useEffect, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { interactionChannels, type Interaction, type InteractionInput, type InteractionPage, type InteractionResult } from '../shared/interactions';
import { RequestError, messageOf, request, send } from './api';
import { displayDate, displayTime } from './utils';
import './Interactions.css';

export type InteractionDraft = { actorId: string; studentId: string; input: InteractionInput };
export default function InteractionHistory({ studentId, actorId, timezone, draftStore, onBusyChange, onAccessExpired, disabled = false }: {
  studentId: string; actorId: string; timezone: string; draftStore: MutableRefObject<InteractionDraft | null>;
  onBusyChange: (busy: boolean) => void; onAccessExpired: () => void; disabled?: boolean;
}) {
  const retained = draftStore.current?.studentId === studentId ? draftStore.current : null;
  const [channel, setChannel] = useState<InteractionInput['channel']>(retained?.input.channel || 'Phone');
  const [summary, setSummary] = useState(retained?.input.summary || '');
  const [pending, setPending] = useState<InteractionDraft | null>(retained);
  const [sending, setSending] = useState(false), [saveError, setSaveError] = useState(''), [saved, setSaved] = useState(false);
  const [items, setItems] = useState<Interaction[]>([]), [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [loadError, setLoadError] = useState('');
  const readGeneration = useRef(0), reading = useRef<AbortController | null>(null), submitting = useRef(false);
  const path = `/api/admin/students/${encodeURIComponent(studentId)}/interactions`;
  const load = useCallback(async (after: string | null = null) => {
    const generation = ++readGeneration.current; reading.current?.abort(); reading.current = new AbortController();
    setLoading(true); setLoadError('');
    try {
      const page = await request<InteractionPage>(`${path}${after ? `?after=${encodeURIComponent(after)}` : ''}`, { signal: reading.current.signal });
      if (generation !== readGeneration.current) return;
      setItems(current => after ? [...current, ...page.items.filter(row => !current.some(old => old.id === row.id))] : page.items); setNext(page.next); setLoaded(true);
    } catch (failure) {
      if (generation !== readGeneration.current) return;
      setLoadError(messageOf(failure));
      if (failure instanceof RequestError && [401, 403].includes(failure.status)) { setItems([]); onAccessExpired(); }
    } finally { if (generation === readGeneration.current) setLoading(false); }
  }, [path, onAccessExpired]);
  useEffect(() => { void load(); return () => { readGeneration.current++; reading.current?.abort(); }; }, [load]);
  useEffect(() => { onBusyChange(Boolean(pending) || sending); }, [pending, sending, onBusyChange]);
  useEffect(() => () => onBusyChange(Boolean(draftStore.current)), [draftStore, onBusyChange]);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (submitting.current || disabled) return;
    const previous = draftStore.current;
    if (previous && (previous.actorId !== actorId || previous.studentId !== studentId)) { setSaveError('Sign in as the original staff member to confirm the pending communication entry.'); return; }
    const draft = previous || { actorId, studentId, input: { interactionId: crypto.randomUUID(), channel, summary: summary.trim() } };
    draftStore.current = draft; setPending(draft); submitting.current = true; setSending(true); onBusyChange(true); setSaveError(''); setSaved(false);
    try {
      const result = await send<InteractionResult>(path, draft.input), row = result.interaction;
      if (!row || row.id !== draft.input.interactionId || row.studentId !== studentId || row.actorId !== actorId || row.channel !== draft.input.channel || row.summary !== draft.input.summary || !Number.isFinite(Date.parse(row.occurredAt)))
        throw new RequestError('The saved communication entry could not be verified.');
      draftStore.current = null; setPending(null); setSummary(''); setSaved(true); onBusyChange(false);
      setItems(current => [row, ...current.filter(old => old.id !== row.id)]); setLoaded(true);
      void load();
    } catch (failure) {
      const uncertain = Boolean(previous) || !(failure instanceof RequestError) || failure.uncertain;
      if (!uncertain) { draftStore.current = null; setPending(null); onBusyChange(false); }
      setSaveError(uncertain ? `${messageOf(failure)} Keep this window open and retry the same entry to confirm it.` : messageOf(failure));
      if (failure instanceof RequestError && [401, 403].includes(failure.status)) onAccessExpired();
    } finally { submitting.current = false; setSending(false); }
  };
  return <section className="cf-interactions" aria-labelledby="communication-history-title">
    <div className="cf-interaction-heading"><h4 id="communication-history-title">Communication history</h4><button className="btn btn-secondary btn-sm" type="button" disabled={loading || sending} onClick={() => void load()}>Refresh</button></div>
    <p className="cf-interaction-help">Log calls, emails, and meetings that have already taken place. Entries record the staff member and time saved.</p>
    {loadError && <p className="form-error" role="alert">{loadError}</p>}
    {!loaded && loading ? <p className="cf-table-note">Loading communication history...</p> : loaded && items.length === 0 ? <p className="cf-table-note">No communication has been logged.</p> : null}
    <div className="cf-interaction-list">{items.map(row => <article key={row.id}><div><strong>{row.channel}</strong><time dateTime={row.occurredAt}>{displayDate(row.occurredAt, timezone)} · {displayTime(row.occurredAt, timezone)}</time></div><p>{row.summary}</p><small>Logged by {row.actorName}</small></article>)}</div>
    {next && <button className="btn btn-secondary btn-sm" type="button" disabled={loading} onClick={() => void load(next)}>{loading ? 'Loading...' : 'Load older entries'}</button>}
    <form className="cf-interaction-form" onSubmit={submit}>
      <label className="field"><span>Contact channel</span><select aria-label="Contact channel" value={channel} disabled={Boolean(pending) || sending || disabled} onChange={event => { setChannel(event.target.value as InteractionInput['channel']); setSaved(false); }}>{interactionChannels.map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="field"><span>Communication summary</span><textarea aria-label="Communication summary" rows={3} required maxLength={2000} value={summary} disabled={Boolean(pending) || sending || disabled} onChange={event => { setSummary(event.target.value); setSaved(false); }} placeholder="What was discussed and any agreed next steps" /></label>
      <p className="cf-interaction-help">Saved entries cannot be edited. Add a new entry to clarify an earlier note. Closing this window discards unsaved text.</p>
      {saveError && <p className="form-error" role="alert">{saveError}</p>}
      {pending && !sending && <p className="cf-notice amber">This entry is awaiting confirmation. Retry it before leaving this student record.</p>}
      {saved && <p className="cf-notice success" role="status">Communication logged.</p>}
      <button className="btn btn-primary" disabled={sending || disabled || !summary.trim()}>{sending ? 'Saving...' : pending ? 'Retry same entry' : 'Log communication'}</button>
    </form>
  </section>;
}
