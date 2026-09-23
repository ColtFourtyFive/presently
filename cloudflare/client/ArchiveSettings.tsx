import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Archive, RefreshCw } from 'lucide-react';
import { Badge } from './shared/components';
import { messageOf, request, send } from './api';
import ArchiveReader from './ArchiveReader';
import ArchiveActivation from './ArchiveActivation';

type Status = {
  enabled: boolean; mode: 'verified-copy'; retentionDays: number;
  jobs: { id: string; month: string; status: string; format_version: number; created_at: string; completed_at: string | null; error_code: string | null; next_part: number; verify_part: number }[];
  holds: { id: string; student_id: string | null; visit_id: string | null; reason: string; created_at: string }[];
};

export default function ArchiveSettings({ owner = true }: { owner?: boolean }) {
  const [review, setReview] = useState<string | null>(null);
  const [activation, setActivation] = useState<{ id: string; month: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [month, setMonth] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const inFlight = useRef(false);
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try { setStatus(await request<Status>('/api/admin/archives')); setError(''); }
    catch (failure) { setError(messageOf(failure)); }
    finally { inFlight.current = false; }
  };
  const active = status?.jobs.some(job => ['parts', 'verify'].includes(job.status));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (!active) return;
    const tick = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(tick, 10_000);
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [active]);
  const start = async (event: FormEvent) => {
    event.preventDefault(); setBusy('start'); setError(''); setNotice('');
    try {
      await send('/api/admin/archives/start', { month });
      setNotice('The historical copy is being prepared. Completion appears after its stored files pass verification.');
      await refresh();
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(''); }
  };
  const cancel = async (jobId: string) => {
    setBusy(jobId); setError('');
    try { await send(`/api/admin/archives/${jobId}/cancel`, {}); setNotice('Copy cancelled. Attendance records remain available.'); await refresh(); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(''); }
  };
  const labels: Record<string, string> = { parts: 'Copying', verify: 'Verifying', complete: 'Verified copy', failed: 'Failed', cancelled: 'Cancelled' };
  return <section className="card cf-settings-card cf-settings-wide">
    <div className="cf-inline-actions" style={{ justifyContent: 'space-between' }}><h2>Historical records</h2><button className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={14} />Refresh status</button></div>
    <p>Keep encrypted copies of completed attendance months in private Cloudflare R2 storage.</p>
    <div className="cf-notice">This release creates verified copies. Attendance records stay in the live database, and storage cleanup is not enabled.</div>
    <button className="btn btn-secondary" onClick={() => setReview('')}>Review historical copies</button>
    {error && <div className="cf-notice error" role="alert">{error}</div>}
    {notice && <div className="cf-notice" role="status">{notice}</div>}
    {!status && !error && <p className="cf-table-note">Checking historical copies...</p>}
    {status && <>
      {!status.enabled && <p className="cf-table-note">Historical copying is disabled. Completed copies can still be reviewed when private storage and the recovery key are available.</p>}
      {owner && <form className="cf-inline-actions" onSubmit={start} style={{ marginTop: 20, alignItems: 'end' }}>
        <label className="field"><span>Completed month</span><input type="month" required value={month} onChange={event => setMonth(event.target.value)} disabled={!status.enabled || Boolean(busy) || active} /></label>
        <button className="btn btn-primary" disabled={!status.enabled || Boolean(busy) || active}><Archive size={16} />{busy === 'start' ? 'Starting...' : 'Create historical copy'}</button>
      </form>}
      <p className="cf-table-note">The entire month must be at least {status.retentionDays} days old. Open visits, pending reviews and records on hold stay live. {owner ? 'You can cancel an unfinished copy to make a historical correction immediately.' : 'Ask the owner to cancel an unfinished copy if a historical correction is needed.'}</p>
      {status.jobs.length ? <div className="table-wrap"><table className="data-table"><thead><tr><th>Month</th><th>Status</th><th>Verified on</th><th>Action</th></tr></thead><tbody>{status.jobs.map(job => <tr key={job.id}>
        <td>{job.month}</td><td><Badge tone={job.status === 'complete' ? 'green' : job.status === 'failed' ? 'red' : 'amber'}>{labels[job.status] || job.status}</Badge>{job.error_code && <small className="cf-request-ref" style={{ display: 'block' }}>{job.error_code}</small>}</td>
        <td>{job.completed_at ? new Date(job.completed_at).toLocaleString() : 'Not confirmed'}</td>
        <td>{job.status === 'complete' && job.format_version === 2 && owner ? <button className="btn btn-secondary btn-sm" onClick={() => setActivation({ id: job.id, month: job.month })}>Verify history</button> : job.status === 'complete' && job.format_version === 1 ? <button className="btn btn-secondary btn-sm" onClick={() => setReview(job.id)}>Review copy</button> : owner && ['parts', 'verify'].includes(job.status) ? <button className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void cancel(job.id)}>Cancel copy</button> : '—'}</td>
      </tr>)}</tbody></table></div> : <p className="cf-table-note">No historical copies have been requested.</p>}
      {status.holds.length > 0 && <p className="cf-table-note">{status.holds.length} active preservation {status.holds.length === 1 ? 'hold' : 'holds'}. Held records are excluded from archiving.</p>}
    </>}
    {review !== null && <ArchiveReader initialArchiveId={review || undefined} onClose={() => setReview(null)} />}
    {activation && <ArchiveActivation key={activation.id} jobId={activation.id} month={activation.month} onClose={() => setActivation(null)} />}
  </section>;
}
