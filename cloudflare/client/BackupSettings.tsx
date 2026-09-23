import { useEffect, useState } from 'react';
import { ArrowUpRight, CloudUpload, RefreshCw } from 'lucide-react';
import { Badge } from './shared/components';
import { messageOf, request, send } from './api';

type BackupStatus = {
  provider: 'r2' | 'google-drive';
  storageConfigured: boolean;
  configured: boolean;
  schedulingConfigured: boolean;
  enabled: boolean;
  stale: boolean;
  alertConfigured: boolean;
  freshnessAlert: {
    staleAfterHours: number;
    monitorStartedAt: string | null;
    attemptedAt: string | null;
    deliveredAt: string | null;
  };
  jobs: {
    id: string;
    created_at: string;
    status: string;
    error_code: string | null;
    completed_at: string | null;
    alert_attempted_at: string | null;
    alert_delivered_at: string | null;
    storage_provider: 'r2' | 'google-drive';
  }[];
};

export default function BackupSettings() {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const refresh = async () => {
    setBusy('refresh'); setError('');
    try { setStatus(await request<BackupStatus>('/api/admin/backups')); }
    catch (failure) { setError(messageOf(failure)); setStatus(null); }
    finally { setBusy(''); }
  };
  useEffect(() => { void refresh(); }, []);

  const connect = async () => {
    setBusy('connect'); setError('');
    try {
      const result = await send<{ url: string }>('/api/admin/backups/connect', {});
      const url = new URL(result.url);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') throw new Error('The sign-in link could not be verified.');
      location.assign(url.href);
    } catch (failure) { setError(messageOf(failure)); setBusy(''); }
  };
  const start = async () => {
    setBusy('start'); setError(''); setMessage('');
    try {
      await send<{ jobId: string }>('/api/admin/backups/start', {});
      setMessage('A backup was requested. It is not complete until a verified completion appears below.');
      await refresh();
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(''); }
  };

  const automaticReady = status?.schedulingConfigured && status.enabled;
  const destination = status?.provider === 'google-drive' ? 'Google Drive' : 'Cloudflare R2';
  const freshnessDelivery = status?.freshnessAlert.deliveredAt
    ? `Delivered ${new Date(status.freshnessAlert.deliveredAt).toLocaleString()}`
    : status?.freshnessAlert.attemptedAt ? 'Delivery unconfirmed' : 'No alert attempted';
  return <section className="card cf-settings-card cf-settings-wide">
    <div className="cf-inline-actions" style={{ justifyContent: 'space-between' }}>
      <h2>Backup and recovery</h2>
      <button className="btn btn-secondary btn-sm" disabled={Boolean(busy)} onClick={() => void refresh()}><RefreshCw size={14} />Refresh status</button>
    </div>
    <p>Keep an encrypted recovery copy in your center's private backup storage. A completed backup and a successful restore are separate checks.</p>
    {error && <div className="cf-notice error" role="alert">{error} Refresh status to verify the current backup state.</div>}
    {message && <div className="cf-notice" role="status">{message}</div>}
    {status && <>
      <div className="cf-backup-status">
        <span>{destination}<Badge tone={status.storageConfigured ? 'green' : 'amber'}>{status.storageConfigured ? 'Configured' : 'Not configured'}</Badge></span>
        <span>Automatic backups<Badge tone={automaticReady ? 'blue' : 'amber'}>{automaticReady ? 'Configured' : 'Not configured'}</Badge></span>
        <span>Latest verified backup<Badge tone={status.stale ? 'amber' : 'green'}>{status.stale ? 'Missing or overdue' : `Within the last ${status.freshnessAlert.staleAfterHours} hours`}</Badge></span>
        <span>Failure notification<Badge tone={status.alertConfigured ? 'blue' : 'amber'}>{status.alertConfigured ? 'Configured, delivery not verified here' : 'Not configured'}</Badge></span>
        <span>Overdue notification<Badge tone={status.freshnessAlert.deliveredAt ? 'green' : status.stale ? 'amber' : 'blue'}>{status.stale ? freshnessDelivery : 'Not needed'}</Badge></span>
      </div>
      {!automaticReady && <div className="cf-notice amber">Backup setup is incomplete. Your installer must finish storage setup, scheduled delivery, and recovery-key handover before backups can be relied on.</div>}
      <div className="cf-inline-actions" style={{ flexWrap: 'wrap', marginBottom: 22 }}>
        {status.provider === 'google-drive' && <button className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => void connect()}>{busy === 'connect' ? 'Opening sign-in...' : status.storageConfigured ? 'Reconnect Google Drive' : 'Connect Google Drive'}<ArrowUpRight size={15} /></button>}
        <button className="btn btn-primary" disabled={Boolean(busy) || !status.schedulingConfigured} onClick={() => void start()}><CloudUpload size={16} />{busy === 'start' ? 'Requesting backup...' : 'Request backup'}</button>
      </div>
      <div className="cf-notice">Keep the recovery key separate from backup files and complete a restore drill before rollout.{status.provider === 'r2' && ' Keep an additional recovery copy outside this Cloudflare account so it remains available if access to the account is lost.'}</div>
      {status.jobs.length ? <div className="table-wrap"><table className="data-table">
        <thead><tr><th>Requested</th><th>Destination</th><th>Status</th><th>Verified completion</th><th>Failure notification</th></tr></thead>
        <tbody>{status.jobs.map(job => <tr key={job.id}>
          <td>{new Date(job.created_at).toLocaleString()}</td>
          <td>{job.storage_provider === 'r2' ? 'Cloudflare R2' : 'Google Drive'}</td>
          <td><Badge tone={job.status === 'complete' ? 'green' : job.status === 'failed' ? 'red' : 'amber'}>{job.status === 'complete' ? 'Complete' : job.status === 'failed' ? 'Failed' : 'In progress'}</Badge>{job.error_code && <small className="cf-request-ref" style={{ display: 'block' }}>{job.error_code}</small>}</td>
          <td>{job.status === 'complete' && job.completed_at ? new Date(job.completed_at).toLocaleString() : 'Not confirmed'}</td>
          <td>{job.alert_delivered_at ? `Delivered ${new Date(job.alert_delivered_at).toLocaleString()}` : job.alert_attempted_at ? `Delivery unconfirmed; last tried ${new Date(job.alert_attempted_at).toLocaleString()}` : job.status === 'failed' ? 'No alert attempted' : 'Not needed'}</td>
        </tr>)}</tbody>
      </table></div> : <p className="cf-table-note">No backup jobs are recorded.</p>}
    </>}
  </section>;
}
