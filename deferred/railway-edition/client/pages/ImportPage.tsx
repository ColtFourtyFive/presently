import { useCallback, useEffect, useState, type ChangeEvent, type MutableRefObject } from 'react';
import { AlertCircle, ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Download, FileUp, History, RefreshCw, ShieldCheck, Users } from 'lucide-react';
import type { PageProps } from '../../shared/types';
import { IMPORT_FIELDS, type ImportDecision, type ImportMapping, type ImportPreview, type ImportPreviewRow, type ImportReceipt, type ImportReceiptRow, type ImportSummary } from '../../shared/import-types';
import { api, ApiError, mutate } from '../api';
import { Badge, EmptyState } from '../components';
import { errorMessage } from '../utils';
import { PageIntro } from './page-components';
import { downloadCsv, readRosterFile } from './import-file';
import './import.css';

type ImportState = 'idle' | 'reading' | 'previewing' | 'review' | 'committing' | 'uncertain' | 'resumable' | 'complete';
export type ImportDraft = {
  staffId: string; csv: string; filename: string; headers: string[]; mapping: ImportMapping; decisions: Record<string, ImportDecision>;
  preview: ImportPreview | null; receipt: ImportReceipt | null; state: ImportState; error: string; accepted: boolean; decisionsDirty: boolean; page: number;
};
const emptyDraft = (staffId: string): ImportDraft => ({ staffId, csv: '', filename: '', headers: [], mapping: {}, decisions: {}, preview: null, receipt: null, state: 'idle', error: '', accepted: false, decisionsDirty: false, page: 1 });
const unresolved = (state: ImportState) => ['committing', 'uncertain', 'resumable'].includes(state);
const rowCount = (count: number) => `${count} row${count === 1 ? '' : 's'}`;
const actionLabel = { create: 'New student', update: 'Update', skip: 'Skip', reject: 'Rejected', review: 'Needs decision' };
const formatDate = (value: string) => new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

type Props = PageProps & { draftStore: MutableRefObject<ImportDraft | null>; onBusyChange: (busy: boolean) => void; onDirectory: () => void };
export default function ImportPage({ data, refresh, notify, draftStore, onBusyChange, onDirectory }: Props) {
  const [renderDraft, setRenderDraft] = useState(() => draftStore.current || emptyDraft(data.user.id));
  const [recent, setRecent] = useState<ImportSummary[]>([]); const [historyError, setHistoryError] = useState('');
  const allowed = data.user.role === 'owner' || data.user.role === 'manager';
  const draft = draftStore.current || renderDraft;
  if (!draftStore.current) draftStore.current = draft;
  const patch = useCallback((change: Partial<ImportDraft>) => {
    const current = draftStore.current;
    if (!current || current.staffId !== data.user.id) return;
    const next = { ...current, ...change }; draftStore.current = next; setRenderDraft(next); onBusyChange(unresolved(next.state));
  }, [data.user.id, draftStore, onBusyChange]);
  const { csv, filename, headers, mapping, decisions, preview, receipt, state, error, accepted, decisionsDirty, page } = draft;
  const busy = ['reading', 'previewing', 'committing'].includes(state); const locked = unresolved(state);
  const refreshHistory = useCallback(async () => {
    if (!allowed) return;
    try { const result = await api<{ imports: ImportSummary[] }>('/imports'); setRecent(result.imports); setHistoryError(''); }
    catch (failure) { setHistoryError(errorMessage(failure)); }
  }, [allowed]);
  useEffect(() => { void refreshHistory(); }, [refreshHistory]);
  useEffect(() => { onBusyChange(locked); }, [locked, onBusyChange]);
  const handleAuth = async (failure: unknown) => { if (failure instanceof ApiError && failure.status === 401) await refresh().catch(() => {}); };
  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]; if (!file || busy) return;
    const recovering = Boolean(receipt && state !== 'complete');
    patch({ state: 'reading', error: '', accepted: false });
    try {
      const loaded = await readRosterFile(file);
      patch({ ...loaded, filename: file.name, decisions: {}, decisionsDirty: false, preview: null, ...(recovering ? {} : { receipt: null }), state: recovering ? 'resumable' : 'idle', page: 1 });
    } catch (failure) { patch({ error: errorMessage(failure), state: recovering ? 'resumable' : preview ? 'review' : 'idle' }); }
    event.target.value = '';
  };
  const buildPreview = async () => {
    const current = draftStore.current; if (!current || ['reading', 'previewing', 'committing', 'uncertain'].includes(current.state)) return;
    const priorReceipt = current.receipt;
    patch({ state: 'previewing', error: '', accepted: false, page: 1 });
    try {
      const result = await mutate<ImportPreview | ImportReceipt>('/imports/preview', { csv: current.csv, mapping: current.mapping, decisions: current.decisions, ...(priorReceipt ? { revalidate: true } : {}) });
      if (priorReceipt && result.importId !== priorReceipt.importId) throw new Error('This file or column mapping does not match the saved import. Use its original CSV and mappings to recover the remaining rows.');
      if ('canCommit' in result) patch({ preview: result, receipt: null, state: 'review', decisionsDirty: false });
      else patch({ receipt: result, preview: null, state: result.status === 'completed' ? 'complete' : 'resumable' });
      void refreshHistory();
    } catch (failure) { patch({ error: errorMessage(failure), state: priorReceipt ? 'resumable' : current.preview ? 'review' : 'idle' }); await handleAuth(failure); }
  };
  const commit = async () => {
    const current = draftStore.current; if (!current || current.state === 'committing' || !current.accepted || current.decisionsDirty || !current.preview?.canCommit) return;
    const source = current.receipt || current.preview;
    if (current.receipt && (current.receipt.previewToken !== current.preview.previewToken || current.receipt.status === 'expired' || current.receipt.rows.some(row => row.status === 'review'))) return;
    patch({ state: 'committing', error: '' });
    try {
      let latest: ImportReceipt | null = null;
      for (let batch = 0; batch < 50; batch++) {
        latest = await mutate<ImportReceipt>(`/imports/${source.importId}/commit`, { previewToken: source.previewToken });
        patch({ receipt: latest });
        if (latest.status === 'completed' || latest.remaining === 0 || latest.status === 'expired' || latest.rows.some(row => row.status === 'review')) break;
      }
      if (!latest) throw new Error('No import receipt was returned.');
      patch({ state: latest.status === 'completed' ? 'complete' : 'resumable' });
      await refresh().catch(() => {}); void refreshHistory();
      if (latest.status === 'completed') notify('Roster import completed. Your student directory is updated.');
    } catch (failure) { patch({ error: `${errorMessage(failure)} The last batch may have been saved. Check its status before continuing.`, state: 'uncertain' }); await handleAuth(failure); }
  };
  const checkStatus = async (importId?: string) => {
    const current = draftStore.current; if (!current || ['reading', 'previewing', 'committing'].includes(current.state)) return;
    const id = importId || current.receipt?.importId || current.preview?.importId; if (!id) return;
    const previousId = current.receipt?.importId || current.preview?.importId;
    patch({ state: 'committing', error: '', page: 1 });
    try {
      const result = await api<ImportReceipt>(`/imports/${id}`);
      patch({ receipt: result, state: result.status === 'completed' ? 'complete' : 'resumable', ...(id !== previousId ? { preview: null, csv: '', filename: '', headers: [], mapping: {}, decisions: {}, accepted: false } : {}) });
      if (result.status === 'completed') await refresh().catch(() => {});
    } catch (failure) { patch({ error: `${errorMessage(failure)} This import's result is still unverified.`, state: id === previousId ? 'uncertain' : current.state }); await handleAuth(failure); }
  };
  const reset = () => { const next = emptyDraft(data.user.id); draftStore.current = next; setRenderDraft(next); onBusyChange(false); void refreshHistory(); };
  const changeMapping = (key: keyof ImportMapping, value: string) => { patch({ mapping: { ...mapping, [key]: value }, preview: null, decisions: {}, decisionsDirty: false, accepted: false }); };
  const displayRows = receipt?.rows || preview?.rows || [];
  const shown = displayRows.slice((page - 1) * 25, page * 25);
  const applied = receipt?.rows.filter(row => row.status === 'applied').length || preview?.alreadyAppliedRows.length || 0;
  const canContinue = Boolean(receipt && preview?.canCommit && accepted && !decisionsDirty && receipt.previewToken === preview.previewToken && receipt.status !== 'expired' && !receipt.rows.some(row => row.status === 'review'));
  const missingMappings = IMPORT_FIELDS.filter(([key, , required]) => required && !mapping[key]);
  const currentId = receipt?.importId || preview?.importId;
  const exportReceipt = () => { if (!receipt) return; downloadCsv(`roster-import-${receipt.importId}.csv`, [['Row', 'Student record', 'Action', 'Result', 'Details', 'Applied at'], ...receipt.rows.map(row => [row.row, row.studentId, row.action, row.status, row.problem, row.appliedAt])]); };

  if (!allowed) return <><PageIntro eyebrow="ROSTER IMPORT" title="Import roster" description="Bring existing students and guardian contacts into your center workspace." /><section className="card"><EmptyState icon={ShieldCheck} title="An owner or manager can import a roster" description="Ask your center owner or manager to review and import the file." action={<button className="btn btn-secondary" onClick={onDirectory}>View students</button>} /></section></>;
  return <div className="roster-import-page">
    <PageIntro eyebrow="ROSTER IMPORT" title="Bring your students together." description="Upload a CSV, match your columns, and review each change before it reaches your directory." action={<button className="btn btn-secondary" onClick={onDirectory}><Users size={16} />View students</button>} />
    <ol className="roster-import-steps" aria-label="Import steps">{['Choose a file', 'Match columns', 'Review & import'].map((label, index) => <li key={label} className={(index === 0 && !headers.length && !receipt) || (index === 1 && headers.length && !preview && !receipt) || (index === 2 && (preview || receipt)) ? 'is-current' : ''}><span>{index + 1}</span>{label}</li>)}</ol>
    {error && <div className="roster-import-notice error" role="alert"><AlertCircle size={19} /><p>{error}</p></div>}
    {state === 'complete' && <div className="roster-import-notice success" role="status"><CheckCircle2 size={21} /><div><strong>Import completed</strong><p>{rowCount(applied)} applied · {receipt?.rows.filter(row => row.status === 'skipped').length || 0} skipped · {receipt?.rows.filter(row => row.status === 'rejected').length || 0} rejected. Your full receipt is below.</p></div><button className="btn btn-secondary btn-sm" onClick={onDirectory}>Open students<ArrowRight size={14} /></button></div>}
    {locked && <div className="roster-import-notice warning" role="status"><RefreshCw size={20} className={state === 'committing' ? 'roster-import-spin' : ''} /><div><strong>{state === 'committing' ? 'Saving your roster in small batches…' : state === 'uncertain' ? 'Confirm the last batch before continuing.' : receipt?.status === 'expired' ? 'Recheck the remaining rows to continue.' : 'This import has saved progress.'}</strong><p>{receipt ? `${rowCount(applied)} confirmed as applied. ${rowCount(receipt.remaining)} ${receipt.remaining === 1 ? 'remains' : 'remain'}.` : 'No applied rows have been confirmed yet.'} Keep this tab open. You can use other pages while it works.</p>{currentId && <small>Import reference: {currentId}</small>}</div></div>}

    {state !== 'complete' && state !== 'committing' && state !== 'uncertain' && <section className="card roster-import-setup">
      <div className="roster-import-upload-layout"><div><h2>{receipt ? 'Reattach the original roster' : 'Choose your CSV file'}</h2><p>{receipt ? 'Use the same file and column mappings to recheck the rows that remain. Rows already applied stay recorded.' : 'Each student needs a stable reference, first name, and last name. You will review the proposed changes before anything is saved.'}</p>
        <label className={`roster-import-upload ${state === 'reading' ? 'is-loading' : ''}`}><FileUp size={27} /><span><strong>{state === 'reading' ? 'Reading CSV…' : filename || 'Choose a CSV roster'}</strong><small>{filename ? `${headers.length} columns · Choose a different file` : 'CSV UTF-8 · up to 500 rows, 40 columns, 512 KiB'}</small></span><input type="file" accept=".csv,text/csv" aria-label={receipt ? 'Reattach the original CSV roster' : 'Choose a CSV roster'} onChange={event => void loadFile(event)} disabled={busy} /></label>
        <button className="roster-import-text-button" onClick={() => downloadCsv('kumon-roster-template.csv', [IMPORT_FIELDS.map(([key]) => key)])}><Download size={14} />Download an empty CSV template</button>
      </div><aside className="roster-import-guidance"><ShieldCheck size={20} /><h3>Review before saving</h3><ul><li>Student references identify existing records. Matching names always need a decision.</li><li>Imported guardian contacts do not receive pickup permission. Review authority in the student profile.</li><li>Your CSV stays in memory until you request a preview. Saved import progress can be reopened below.</li></ul></aside></div>
      {headers.length > 0 && <div className="roster-import-mapping-section"><h2>Match your columns</h2><p>Check the suggested matches. “Not included” preserves that field for existing students. An empty value in a mapped grade, subjects, or pickup restriction column clears it; blank subjects end active enrollments. Existing guardian contacts are preserved and must be edited in the student profile.</p><div className="roster-import-mapping">{IMPORT_FIELDS.map(([key, label, required]) => <label className="field" key={key}><span>{label}{required && <small>Required</small>}</span><select value={mapping[key] || ''} disabled={busy} onChange={event => changeMapping(key, event.target.value)}><option value="">{required ? 'Choose a column' : 'Not included'}</option>{headers.map(header => <option value={header} key={header}>{header}</option>)}</select></label>)}</div><div className="roster-import-actions"><button className="btn btn-primary" disabled={busy || missingMappings.length > 0} onClick={() => void buildPreview()}>{state === 'previewing' ? 'Preparing preview…' : receipt ? 'Recheck remaining rows' : preview ? 'Rebuild preview' : 'Preview roster'}<ArrowRight size={16} /></button>{missingMappings.length > 0 && <span className="muted">Match {missingMappings.map(([, label]) => label.toLowerCase()).join(', ')} to continue.</span>}</div></div>}
    </section>}

    {(preview || receipt) && <section className="card roster-import-review" aria-label={receipt ? 'Import receipt' : 'Import preview'}>
      <div className="card-header roster-import-review-heading"><div><h2>{receipt ? 'Import receipt' : 'Review proposed changes'}</h2><p>{(receipt || preview)!.totalRows} source {(receipt || preview)!.totalRows === 1 ? 'row' : 'rows'} · {receipt ? `Status: ${receipt.status}` : `Preview expires ${formatDate(preview!.expiresAt)}`}</p>{currentId && <small className="roster-import-reference">{currentId}</small>}</div>{receipt && <button className="btn btn-secondary btn-sm" onClick={exportReceipt}><Download size={14} />Download receipt</button>}</div>
      {preview && !receipt && <div className="roster-import-summary"><span><strong>{preview.summary.create || 0}</strong> new students</span><span><strong>{preview.summary.update || 0}</strong> updates</span><span><strong>{preview.summary.review || 0}</strong> need a decision</span><span><strong>{preview.summary.skip || 0}</strong> skipped</span><span><strong>{preview.summary.reject || 0}</strong> rejected</span>{applied > 0 && <span><strong>{applied}</strong> already applied</span>}</div>}
      <div className="table-wrap"><table className="data-table roster-import-table"><thead><tr><th scope="col">Row</th><th scope="col">Student</th><th scope="col">Action</th><th scope="col">{receipt ? 'Result' : 'Decision'}</th><th scope="col">Details</th></tr></thead><tbody>{shown.map(row => {
        const source = 'values' in row ? row as ImportPreviewRow : preview?.rows.find(candidate => candidate.row === row.row);
        const outcome = 'status' in row ? row as ImportReceiptRow : null;
        const code = source?.values.studentNumber || '';
        return <tr key={row.row}><td data-label="Row">{row.row}</td><td data-label="Student"><span className="table-text-stack"><strong>{source ? `${source.values.firstName || ''} ${source.values.lastName || ''}` : 'Student record'}</strong><small className="roster-import-reference">{code || row.studentId || 'No student created'}</small></span></td><td data-label="Action"><Badge tone={row.action === 'reject' ? 'red' : row.action === 'review' ? 'amber' : row.action === 'skip' ? 'gray' : 'blue'}>{actionLabel[row.action]}</Badge></td><td data-label={receipt ? 'Result' : 'Decision'}>{outcome ? <Badge tone={outcome.status === 'applied' ? 'green' : outcome.status === 'rejected' ? 'red' : outcome.status === 'review' ? 'amber' : 'gray'}>{outcome.status}</Badge> : source?.action === 'review' ? <select aria-label={`Decision for row ${row.row}`} value={decisions[code] || ''} disabled={busy} onChange={event => patch({ decisions: { ...decisions, [code]: event.target.value as ImportDecision }, accepted: false, decisionsDirty: true })}><option value="">Choose a decision</option><option value={source.existingStudentId ? 'update' : 'create'}>{source.existingStudentId ? 'Update this student reference' : 'Create a separate student'}</option><option value="skip">Skip this row</option></select> : <span className="muted">{row.action === 'reject' ? 'Will not import' : row.action === 'skip' ? 'Will not change' : 'Ready for review'}</span>}</td><td data-label="Details" className="roster-import-details"><span>{row.problem || (outcome ? 'Recorded in receipt' : 'No validation issue')}</span>{source && <details className="roster-import-row-values"><summary>View mapped values<span className="sr-only"> for row {row.row}</span></summary><dl>{IMPORT_FIELDS.filter(([key]) => mapping[key]).map(([key, label]) => {
          const value = source.values[key]; const text = Array.isArray(value) ? value.join(', ') : value || '';
          const existing = Boolean(source.existingStudentId);
          const emptyLabel = existing && key === 'subjects' ? 'Clear subjects; end active enrollments' : existing && key === 'pickupAlert' ? 'Clear pickup restriction' : existing && key === 'grade' ? 'Clear grade' : 'Not supplied';
          return <div key={key}><dt>{label}</dt><dd className={text ? '' : 'is-empty'}>{text || emptyLabel}</dd></div>;
        })}</dl><p>Fields not included in this import preserve existing values. Existing guardian contacts remain unchanged.</p></details>}</td></tr>;
      })}</tbody></table></div>
      <div className="roster-import-pagination"><span>Page {page} of {Math.max(1, Math.ceil(displayRows.length / 25))}</span><div><button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => patch({ page: page - 1 })}><ChevronLeft size={14} />Previous</button><button className="btn btn-secondary btn-sm" disabled={page * 25 >= displayRows.length} onClick={() => patch({ page: page + 1 })}>Next<ChevronRight size={14} /></button></div></div>
      <div className="roster-import-confirm">{preview && !receipt && !busy && <>{!preview.canCommit || decisionsDirty ? <><p className="roster-import-inline-warning">Resolve rows that need a decision, then rebuild the preview. Rejected rows will not be imported.</p><button className="btn btn-secondary" onClick={() => void buildPreview()}>Apply decisions and rebuild preview<RefreshCw size={15} /></button></> : <><label className="roster-import-check"><input type="checkbox" checked={accepted} onChange={event => patch({ accepted: event.target.checked })} /><span>I reviewed the new students, updates, skipped and rejected rows, including changes to subjects and pickup restrictions.</span></label><button className="btn btn-primary" disabled={!accepted} onClick={() => void commit()}>Confirm and import roster<ArrowRight size={16} /></button></>}</>}
        {state === 'uncertain' && <button className="btn btn-primary" onClick={() => void checkStatus()}><RefreshCw size={15} />Check import status</button>}
        {state === 'resumable' && <><p>{canContinue ? 'The confirmed preview still matches this import. Continue from its saved progress.' : 'Recheck and confirm the remaining rows before continuing. If you reopened this import, attach the original CSV above and match its columns.'}</p><div className="roster-import-actions"><button className="btn btn-secondary" onClick={() => void checkStatus()}><RefreshCw size={15} />Check status</button>{canContinue && <button className="btn btn-primary" onClick={() => void commit()}>Continue this import<ArrowRight size={15} /></button>}{csv && <button className="btn btn-secondary" onClick={() => void buildPreview()}>Recheck remaining rows</button>}</div></>}
        {state === 'complete' && <div className="roster-import-actions"><button className="btn btn-primary" onClick={onDirectory}>View student directory<ArrowRight size={15} /></button><button className="btn btn-secondary" onClick={reset}>Import another file</button></div>}
      </div>
    </section>}
    <section className="card roster-import-history"><div className="card-header"><div><h2><History size={18} />Recent imports</h2><p>Reopen a saved receipt or recover an interrupted import.</p></div><button className="icon-button" aria-label="Refresh recent imports" disabled={busy} onClick={() => void refreshHistory()}><RefreshCw size={16} /></button></div>{historyError ? <p className="roster-import-history-message" role="alert">{historyError}</p> : recent.length ? <div className="roster-import-history-list">{recent.map(item => <div key={item.importId}><span><strong>{formatDate(item.createdAt)}</strong><small>{rowCount(item.totalRows)} · {item.remaining} remaining</small></span><Badge tone={item.status === 'completed' ? 'green' : item.status === 'expired' ? 'gray' : 'amber'}>{item.status}</Badge><button className="btn btn-secondary btn-sm" disabled={busy || (locked && item.importId !== currentId)} onClick={() => void checkStatus(item.importId)}>{item.status === 'completed' ? 'View receipt' : 'Open import'}<ArrowRight size={14} /></button></div>)}</div> : <p className="roster-import-history-message">Your imports will appear here after you request a preview.</p>}</section>
  </div>;
}
