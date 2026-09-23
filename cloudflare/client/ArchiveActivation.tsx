import { useEffect, useRef, useState } from 'react';
import { messageOf, request, send } from './api';

type Activation = {
  archiveId: string;
  session: { status: string } | null;
  staging: { partCount: number; stagedParts: number; nextPart: number | null };
  run: { status: string; phase: string; revision: number } | null;
  publication: { state: string; phase: string; revision: number } | null;
  sourceEvictionEnabled: boolean;
};

type Step = { message: string; continue: boolean };

async function advance(jobId: string, state: Activation): Promise<Step> {
  const path = `/api/admin/archives/semantic/${jobId}`;
  if (state.publication?.state === 'published') return { message: 'Historical lookup is published.', continue: false };
  if (state.publication && state.publication.state !== 'building') throw new Error(`Publication stopped: ${state.publication.state}`);
  if (state.run && !['pending', 'complete'].includes(state.run.status)) {
    if (['running', 'busy', 'paused'].includes(state.run.status)) return { message: `Verification ${state.run.status}. Check status before continuing.`, continue: false };
    throw new Error(`Verification stopped: ${state.run.status}`);
  }
  if (!state.session) {
    const backfill = await send<{ state: string; processed: number }>('/api/admin/archives/semantic/maintenance/backfill/advance', {});
    if (backfill.state === 'paused') return { message: 'History backfill paused. Review its status before continuing.', continue: false };
    if (backfill.state !== 'ready') return { message: `Indexed ${backfill.processed} history rows in this step.`, continue: true };
    await send(`${path}/start`, {});
    return { message: 'Encrypted archive manifest authenticated. Staging parts next.', continue: true };
  }
  if (state.session.status === 'staging') {
    if (state.staging.nextPart !== null) {
      await send(`${path}/parts/${state.staging.nextPart}`, {});
      return { message: `Staged encrypted part ${state.staging.nextPart + 1} of ${state.staging.partCount}.`, continue: true };
    }
    await send(`${path}/freeze`, {});
    return { message: 'Complete encrypted copy frozen for semantic verification.', continue: true };
  }
  if (!['frozen', 'verified'].includes(state.session.status)) throw new Error(`Staging stopped: ${state.session.status}`);
  if (!state.run) {
    await send(`${path}/freeze`, {});
    return { message: 'Semantic verification started.', continue: true };
  }
  if (state.run.status !== 'complete') {
    const result = await send<{ status: string; phase: string; processed: number }>(`${path}/verify/advance`, {});
    return { message: `Verification ${result.status}: ${result.phase}, ${result.processed} rows.`, continue: !['busy', 'paused'].includes(result.status) };
  }
  if (!state.publication) {
    await send(`${path}/publish/start`, {});
    return { message: 'Historical lookup publication started.', continue: true };
  }
  const result = await send<{ state: string; phase: string; processed: number }>(`${path}/publish/advance`, {});
  return { message: result.state === 'published' ? 'Historical lookup is published.' : `Publication ${result.phase}: ${result.processed} rows.`, continue: result.state === 'building' };
}

export default function ArchiveActivation({ jobId, month, onClose }: { jobId: string; month: string; onClose: () => void }) {
  const [status, setStatus] = useState<Activation | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const stopRequested = useRef(false);
  const path = `/api/admin/archives/semantic/${jobId}`;
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { setStatus(await request<Activation>(path)); setError(''); }
    catch (failure) { setError(messageOf(failure)); }
    finally { inFlight.current = false; }
  };
  useEffect(() => {
    void refresh();
    return () => { stopRequested.current = true; };
  }, [jobId]);
  const continueActivation = async () => {
    if (busy) return;
    stopRequested.current = false;
    setBusy(true); setError('');
    try {
      for (let step = 0; step < 2_000 && !stopRequested.current; step++) {
        const current = await request<Activation>(path);
        setStatus(current);
        const result = await advance(jobId, current);
        setMessage(result.message);
        if (!result.continue) break;
      }
      setStatus(await request<Activation>(path));
    } catch (failure) {
      setError(`${messageOf(failure)} Check status before trying again; a timed-out step may have completed.`);
      try { setStatus(await request<Activation>(path)); } catch { /* Keep the first error visible. */ }
    } finally { setBusy(false); }
  };
  return <div className="cf-notice" style={{ marginTop: 16 }}>
    <div className="cf-inline-actions" style={{ justifyContent: 'space-between' }}>
      <strong>Verify {month} for historical lookup</strong>
      <button className="btn btn-secondary btn-sm" onClick={onClose}>Close</button>
    </div>
    <p>This runs up to 2,000 separate, bounded requests. You can stop between requests and resume later. Attendance remains in D1. Check account usage before continuing.</p>
    {status && <p role="status">Encrypted parts: {status.staging.stagedParts}/{status.staging.partCount}. Verification: {status.run?.status || status.session?.status || 'not started'}. Publication: {status.publication?.state || 'not started'}.</p>}
    {status?.sourceEvictionEnabled && <p className="cf-notice error">Source eviction policy is enabled. Review retention controls before any deletion.</p>}
    {message && <p>{message}</p>}
    {error && <p className="cf-notice error" role="alert">{error}</p>}
    <div className="cf-inline-actions">
      <button className="btn btn-primary btn-sm" disabled={busy || status?.publication?.state === 'published'} onClick={() => void continueActivation()}>{busy ? 'Working...' : 'Continue verification'}</button>
      {busy && <button className="btn btn-secondary btn-sm" onClick={() => { stopRequested.current = true; }}>Stop after this request</button>}
      <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void refresh()}>Refresh status</button>
    </div>
  </div>;
}
