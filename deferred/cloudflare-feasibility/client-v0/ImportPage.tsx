import { useEffect, useRef, useState, type ChangeEvent, type MutableRefObject, type SetStateAction } from 'react';
import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, FileUp, RefreshCw } from 'lucide-react';
import { Badge } from './shared/components';
import { messageOf, request, send } from './api';
import { readCsvFile } from './import-file';
import ImportHistory from './ImportHistory';
import { createImportOperationLock } from './import-operation';
import './ImportPage.css';

const fields = [ ['studentCode', 'Student reference', true], ['firstName', 'First name', true], ['lastName', 'Last name', true], ['grade', 'Grade', false], ['subjects', 'Subjects', false], ['pickupAlert', 'Pickup restriction', false], ['guardianReference', 'Guardian reference', false], ['guardianName', 'Guardian name', false], ['guardianEmail', 'Guardian email', false], ['guardianPhone', 'Guardian phone', false], ['guardianRelationship', 'Guardian relationship', false], ['pickupAuthority', 'Pickup authority', false], ['pickupAuthorityNote', 'Pickup authority evidence', false] ] as const;
type PreviewRow = { row: number; action: 'create' | 'update' | 'skip' | 'reject' | 'review'; studentId: string | null; existingStudentId: string | null; guardianId: string | null; problem: string | null; values: Record<string, unknown> };
type Preview = { importId: string; previewToken: string; status: 'preview'; totalRows: number; alreadyAppliedRows?: number[]; expiresAt: string; rows: PreviewRow[]; canCommit: boolean; summary: Record<string, number> };
type ReceiptRow = { row: number; row_number?: number; action: PreviewRow['action']; status: 'pending' | 'applied' | 'skipped' | 'rejected' | 'review'; studentId: string | null; student_id?: string | null; guardianId: string | null; problem: string | null; appliedAt: string | null };
type Receipt = { importId: string; status: string; totalRows: number; previewToken: string; createdAt: string; expiresAt: string; rows: ReceiptRow[]; remaining: number };
export type ImportDraft = { csv: string; filename: string; headers: string[]; mapping: Record<string, string>; decisions: Record<string, 'create' | 'update' | 'skip'>; preview: Preview | null; receipt: Receipt | null; state: 'idle' | 'previewing' | 'review' | 'committing' | 'uncertain' | 'resumable' | 'complete'; error: string; accepted: boolean; decisionsDirty: boolean; page: number };
const emptyDraft = (): ImportDraft => ({ csv: '', filename: '', headers: [], mapping: {}, decisions: {}, preview: null, receipt: null, state: 'idle', error: '', accepted: false, decisionsDirty: false, page: 1 });

function csvHeaders(csv: string) {
  const source = csv.replace(/^\uFEFF/, '');
  const headers: string[] = []; let value = ''; let quoted = false;
  for (let i = 0; i < source.length; i++) { const char = source[i]; if (char === '"') { if (quoted && source[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; } else if (char === ',' && !quoted) { headers.push(value.trim()); value = ''; } else if ((char === '\n' || char === '\r') && !quoted) { headers.push(value.trim()); return headers; } else value += char; }
  if (quoted) throw new Error('The CSV header contains an unfinished quoted field.'); headers.push(value.trim()); return headers;
}

export default function ImportPage({ onBusyChange, draftStore }: { onBusyChange: (busy: boolean) => void; draftStore: MutableRefObject<ImportDraft | null> }) {
  const [initialDraft, setDraft] = useState(() => draftStore.current || emptyDraft());
  const draft = draftStore.current || initialDraft;
  if (!draftStore.current) draftStore.current = draft;
  const { csv, filename, headers, mapping, decisions, preview, receipt, state, error, accepted, decisionsDirty, page } = draft;
  const [working, setWorking] = useState(false);
  const operationLock = useRef<ReturnType<typeof createImportOperationLock> | null>(null);
  const retainsProgress = (value: ImportDraft | null) => Boolean(value && ['committing', 'uncertain', 'resumable'].includes(value.state));
  if (!operationLock.current) operationLock.current = createImportOperationLock(busy => {
    setWorking(busy);
    onBusyChange(busy || retainsProgress(draftStore.current));
  });
  const replaceDraft = (next: ImportDraft) => {
    draftStore.current = next; setDraft(next);
    // Retain only in memory so reauthentication cannot discard an uncertain batch.
    onBusyChange(operationLock.current!.busy || retainsProgress(next));
  };
  const field = <K extends keyof ImportDraft>(key: K) => (value: SetStateAction<ImportDraft[K]>) => {
    const current = draftStore.current || draft;
    replaceDraft({ ...current, [key]: typeof value === 'function' ? (value as (previous: ImportDraft[K]) => ImportDraft[K])(current[key]) : value });
  };
  const setCsv = field('csv'), setFilename = field('filename'), setHeaders = field('headers'), setMapping = field('mapping'), setDecisions = field('decisions'), setPreview = field('preview'), setReceipt = field('receipt'), setState = field('state'), setError = field('error'), setAccepted = field('accepted'), setDecisionsDirty = field('decisionsDirty'), setPage = field('page');
  const locked = retainsProgress(draft);
  const beginRead = () => {
    const previous = draftStore.current || draft;
    return operationLock.current!.begin(() => replaceDraft(previous));
  };
  useEffect(() => {
    onBusyChange(operationLock.current!.busy || retainsProgress(draftStore.current));
    return () => operationLock.current!.cancelRead();
  }, [onBusyChange]);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (operationLock.current!.busy || retainsProgress(draftStore.current)) event.preventDefault(); }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, []);
  const loadFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Let staff reattach the same original file after opening its saved receipt.
    event.target.value = '';
    if (!file || ['previewing', 'committing', 'uncertain'].includes(draftStore.current!.state)) return;
    const operation = beginRead(); if (!operation) return;
    const recovering = Boolean(receipt && state !== 'complete');
    setError(''); setPreview(null); if (!recovering) setReceipt(null); setAccepted(false); setState(recovering ? 'resumable' : 'idle'); setDecisions({}); setDecisionsDirty(false);
    try {
      const text = await readCsvFile(file);
      if (!operationLock.current!.current(operation)) return;
      const columns = csvHeaders(text);
      if (!columns.length || columns.length > 40 || columns.some(column => !column) || new Set(columns).size !== columns.length) throw new Error('Use 1 to 40 distinct, non-empty column headers.');
      setCsv(text); setFilename(file.name); setHeaders(columns);
      const normalized = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
      setMapping(Object.fromEntries(fields.map(([field, label]) => [field, columns.find(column => normalized(column) === normalized(field) || normalized(column) === normalized(label)) || ''])));
    } catch (failure) {
      if (operationLock.current!.current(operation)) { setCsv(''); setFilename(''); setHeaders([]); setError(messageOf(failure)); }
    } finally { operationLock.current!.finish(operation); }
  };
  const buildPreview = async (revalidate = false) => {
    if (['previewing', 'committing', 'uncertain'].includes(draftStore.current!.state)) return;
    const operation = beginRead(); if (!operation) return;
    setError(''); setState('previewing'); setAccepted(false); setPage(1);
    try {
      const result = await send<Preview | Receipt>('/api/admin/imports/preview', { csv, mapping, decisions, ...(revalidate || receipt ? { revalidate: true } : {}) });
      if (!operationLock.current!.current(operation)) return;
      if (receipt && receipt.status !== 'completed' && result.importId !== receipt.importId) throw new Error('Reattach the original file and match its original columns to recover this import.');
      setDecisionsDirty(false);
      if ('canCommit' in result) { setPreview(result); setReceipt(null); setState('review'); }
      else { setReceipt(result); setState(result.status === 'completed' ? 'complete' : 'resumable'); }
    } catch (failure) {
      if (operationLock.current!.current(operation)) { setError(messageOf(failure)); setState(receipt ? 'resumable' : preview ? 'review' : 'idle'); }
    } finally { operationLock.current!.finish(operation); }
  };
  const commit = async () => {
    const source = draftStore.current!;
    const current = source.receipt || source.preview;
    if (!current || !['review', 'resumable'].includes(source.state) || !source.accepted || source.decisionsDirty || !source.preview?.canCommit || source.receipt && source.receipt.previewToken !== source.preview.previewToken) return;
    const operation = operationLock.current!.begin(); if (!operation) return;
    setState('committing'); setError('');
    try {
      let latest: Receipt | null = null;
      for (let batch = 0; batch < 50; batch++) { latest = await send<Receipt>(`/api/admin/imports/${current.importId}/commit`, { previewToken: current.previewToken }); setReceipt(latest); if (latest.status === 'completed' || latest.remaining === 0) break; }
      if (!latest) throw new Error('No import receipt was returned.');
      setState(latest.status === 'completed' ? 'complete' : 'resumable');
    } catch (failure) { setError(`${messageOf(failure)} The last batch may have been saved. Check this import's status before continuing.`); setState('uncertain'); }
    finally { operationLock.current!.finish(operation); }
  };
  const checkStatus = async () => {
    const source = draftStore.current!;
    const current = source.receipt || source.preview;
    if (!current || !['uncertain', 'resumable'].includes(source.state)) return;
    const operation = operationLock.current!.begin(); if (!operation) return;
    setState('committing'); setError('');
    try { const result = await request<Receipt>(`/api/admin/imports/${current.importId}`); setReceipt(result); setState(result.status === 'completed' ? 'complete' : 'resumable'); }
    catch (failure) { setError(`${messageOf(failure)} The import result is still unverified.`); setState('uncertain'); }
    finally { operationLock.current!.finish(operation); }
  };
  const openReceipt = async (importId: string) => {
    if (retainsProgress(draftStore.current) || draftStore.current!.state === 'previewing') return;
    const operation = beginRead(); if (!operation) return;
    try {
      const next = await request<Receipt>(`/api/admin/imports/${importId}`);
      if (operationLock.current!.current(operation)) replaceDraft({ ...emptyDraft(), receipt: next, state: next.status === 'completed' ? 'complete' : 'resumable' });
    } catch (failure) {
      if (operationLock.current!.current(operation)) setError(messageOf(failure));
    } finally { operationLock.current!.finish(operation); }
  };
  const displayRows = receipt?.rows || preview?.rows || [];
  const shown = displayRows.slice((page - 1) * 25, page * 25);
  const applied = receipt?.rows.filter(row => row.status === 'applied').length || preview?.alreadyAppliedRows?.length || 0;
  const canContinue = Boolean(receipt && preview && preview.canCommit && accepted && !decisionsDirty && receipt.previewToken === preview.previewToken && receipt.status !== 'expired' && !receipt.rows.some(row => row.status === 'review'));
  const reset = () => { if (operationLock.current!.busy) return; setCsv(''); setFilename(''); setHeaders([]); setMapping({}); setDecisions({}); setDecisionsDirty(false); setPreview(null); setReceipt(null); setState('idle'); setError(''); setAccepted(false); setPage(1); };
  return <><div className="page-heading"><div><div className="eyebrow">ROSTER IMPORT</div><h1>Bring your student roster.</h1><p>Map your columns, review every row, and confirm the changes before importing.</p></div></div>{working && !locked && <div className="cf-notice" role="status">Loading import details. Keep this page open.</div>}{error && <div className="cf-notice error" role="alert">{error}</div>}{state === 'complete' && <div className="cf-notice success" role="status"><CheckCircle2 size={16} /> Import completed. {applied} rows were applied, {receipt?.rows.filter(row => row.status === 'skipped').length || 0} skipped, and {receipt?.rows.filter(row => row.status === 'rejected').length || 0} rejected. Review the full receipt below.</div>}{locked && <div className="cf-notice amber" role="status"><strong>{state === 'committing' ? 'Importing in small batches...' : state === 'uncertain' ? 'The last batch needs confirmation.' : 'This import has saved progress and can continue.'}</strong><br />{receipt ? `${applied} rows confirmed as applied. ${receipt.remaining} rows remain.` : 'No applied rows have been confirmed yet.'} Keep this window open. Do not start another import for these records.{(receipt || preview) && <p className="cf-request-ref">Import reference: {(receipt || preview)!.importId}</p>}</div>}
    {!['committing', 'uncertain', 'complete'].includes(state) && <section className="card cf-settings-card" style={{ marginBottom: 23 }}><h2>{receipt ? "Reattach the original CSV roster" : "1. Choose your CSV file"}</h2><p>Use a stable student reference for each student. A guardian reference can link siblings to the same guardian. Maximum 500 rows, 40 columns, and 512 KB.</p><label className="cf-import-upload"><FileUp size={24} /><span><strong>{filename || 'Choose a CSV roster'}</strong><small>Your file stays in this page until you request a preview.</small></span><input type="file" accept=".csv,text/csv" aria-label="Choose a CSV roster" onChange={event => void loadFile(event)} disabled={working || state === 'previewing'} /></label><button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => { const url = URL.createObjectURL(new Blob([fields.map(([key]) => key).join(',') + '\r\n'], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = 'kumon-roster-template.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }}>Download empty CSV template</button>{receipt && <p>Use the same file and mappings to recheck the remaining rows. Already applied rows stay recorded.</p>}{headers.length > 0 && <><h2 style={{ marginTop: 30 }}>2. Match your columns</h2><p>Check the suggested mappings. Fields marked Not included keep existing values when updating. Blank mapped grade, subjects or pickup restrictions clear those fields. Blank pickup authority resets it to unverified; a contact name does not grant permission. Existing guardian contact changes require review in the guardian record.</p><div className="cf-import-mapping">{fields.map(([field, label, required]) => <label className="field" key={field}><span>{label}{required ? ' · required' : ''}</span><select value={mapping[field] || ''} disabled={working || state === 'previewing'} onChange={event => { if (operationLock.current!.busy) return; setMapping(current => ({ ...current, [field]: event.target.value })); setPreview(null); setDecisions({}); setAccepted(false); }}><option value="">{required ? 'Choose a column' : 'Not included'}</option>{headers.map(header => <option value={header} key={header}>{header}</option>)}</select></label>)}</div><button className="btn btn-primary" disabled={working || state === 'previewing' || !mapping.studentCode || !mapping.firstName || !mapping.lastName} onClick={() => void buildPreview()}>{state === 'previewing' ? 'Preparing preview...' : preview ? 'Rebuild preview' : 'Preview roster'}<ArrowRight size={15} /></button></>}</section>}
    {(preview || receipt) && <section className="card"><div className="cf-roster-heading"><div><h2>{receipt ? 'Import receipt' : '3. Review proposed changes'}</h2><p>{(receipt || preview)!.totalRows} source rows · {receipt ? `Status: ${receipt.status}` : `Preview expires ${new Date(preview!.expiresAt).toLocaleTimeString()}`}</p></div>{preview && !receipt && <span className="cf-import-summary">{applied > 0 ? `${applied} already applied · ` : ''}{preview.summary.create || 0} new · {preview.summary.update || 0} updates · {preview.summary.review || 0} need review · {preview.summary.reject || 0} rejected</span>}</div><div className="table-wrap"><table className="data-table cf-data-table"><thead><tr><th>Row</th><th>{receipt ? 'Student record' : 'Student'}</th><th>Action</th><th>{receipt ? 'Result' : 'Review decision'}</th><th>Details</th></tr></thead><tbody>{shown.map(row => {
      const source = 'values' in row ? row as PreviewRow : null; const outcome = 'status' in row ? row as ReceiptRow : null; const rowNumber = row.row ?? outcome?.row_number; const code = String(source?.values.studentCode || '');
      return <tr key={rowNumber}><td>{rowNumber}</td><td>{source ? <span><strong>{String(source.values.firstName || '')} {String(source.values.lastName || '')}</strong><small className="cf-request-ref" style={{ display: 'block' }}>{code}</small></span> : <span className="cf-request-ref">{outcome?.studentId || outcome?.student_id || 'No student created'}</span>}</td><td><Badge tone={row.action === 'reject' ? 'red' : row.action === 'review' ? 'amber' : 'blue'}>{row.action}</Badge></td><td>{outcome ? <Badge tone={outcome.status === 'applied' ? 'green' : outcome.status === 'rejected' ? 'red' : 'gray'}>{outcome.status}</Badge> : source?.action === 'review' ? <select aria-label={`Decision for row ${rowNumber}`} value={decisions[code] || ''} disabled={working || state === 'previewing'} onChange={event => { if (operationLock.current!.busy) return; const value = event.target.value as 'create' | 'update' | 'skip'; setDecisions(current => ({ ...current, [code]: value })); setDecisionsDirty(true); setAccepted(false); }}><option value="">Choose a decision</option><option value={source.existingStudentId ? 'update' : 'create'}>{source.existingStudentId ? 'Update this student reference' : 'Create a separate student'}</option><option value="skip">Skip this row</option></select> : <span className="muted">{source?.action === 'reject' ? 'Will not import' : 'Ready for your review'}</span>}</td><td style={{ maxWidth: 310, whiteSpace: 'normal' }}>{row.problem || (source ? 'No validation issue' : 'Recorded in receipt')}{source && <details className="cf-import-values"><summary>View mapped values for row {rowNumber}</summary><dl>{fields.filter(([key]) => mapping[key]).map(([key, label]) => { const value = source.values[key]; const text = Array.isArray(value) ? value.join(', ') : String(value ?? ''); return <div key={key}><dt>{label}</dt><dd>{text || (source.existingStudentId && ['grade', 'subjects', 'pickupAlert'].includes(key) ? 'Clear existing value' : key === 'pickupAuthority' ? 'Unverified' : 'Blank')}</dd></div>; })}</dl><p>Unmapped fields preserve existing values.</p></details>}</td></tr>;
    })}</tbody></table></div><div className="cf-pagination"><span>Page {page} of {Math.max(1, Math.ceil(displayRows.length / 25))}</span><div><button className="btn btn-secondary btn-sm" disabled={working || page === 1} onClick={() => setPage(current => current - 1)}><ChevronLeft size={13} />Previous</button><button className="btn btn-secondary btn-sm" disabled={working || page * 25 >= displayRows.length} onClick={() => setPage(current => current + 1)}>Next<ChevronRight size={13} /></button></div></div><div className="cf-import-confirm">{preview && !receipt && !locked && <>{(!preview.canCommit || decisionsDirty) ? <><div className="cf-notice amber">Resolve rows marked for review, then rebuild the preview. Students are never merged solely because their names match.</div><button className="btn btn-secondary" disabled={working || state === 'previewing'} onClick={() => void buildPreview()}>Apply decisions and rebuild preview</button></> : <><label className="cf-check-label"><input type="checkbox" checked={accepted} disabled={working} onChange={event => { if (!operationLock.current!.busy) setAccepted(event.target.checked); }} /><span>I reviewed the proposed creates, updates, skipped rows, and rejected rows, including guardian pickup authority.</span></label><button className="btn btn-primary" style={{ marginTop: 20 }} disabled={working || !accepted} onClick={() => void commit()}>Confirm and import roster<ArrowRight size={15} /></button></>}</>}{state === 'uncertain' && <button className="btn btn-primary" disabled={working} onClick={() => void checkStatus()}><RefreshCw size={15} />Check import status</button>}{state === 'resumable' && <>{!canContinue && <p className="cf-notice amber">Recheck the remaining rows and confirm their preview before continuing. Applied rows will stay recorded.</p>}<div className="cf-inline-actions"><button className="btn btn-secondary" disabled={working} onClick={() => void checkStatus()}><RefreshCw size={15} />Check status</button><button className="btn btn-primary" disabled={working || !canContinue} onClick={() => void commit()}>Continue this import</button>{csv && <button className="btn btn-secondary" disabled={working} onClick={() => void buildPreview(true)}>Recheck remaining rows</button>}</div></>}{(state === 'complete' || receipt?.status === 'expired') && <button className="btn btn-secondary" disabled={working} onClick={reset}>Choose another import</button>}</div></section>}<ImportHistory refreshKey={`${state}:${receipt?.importId || preview?.importId || ''}`} disabled={working || locked || state === 'previewing'} onOpen={openReceipt} />
  </>;
}
