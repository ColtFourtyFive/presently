import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Download, FileUp, RotateCcw, Upload } from 'lucide-react';
import {
  IMPORT_FIELDS, IMPORT_FIELD_LABELS, REQUIRED_IMPORT_FIELDS,
  type ImportField, type ImportPreview, type ImportRow, type ImportSummary,
} from '../../shared/import';
import type { PageProps } from '../App';
import { RequestError, messageOf } from '../api';
import { Alert, Badge, Button, Card, EmptyState, Field, PageHeader, Spinner } from '../components';
import { csvCell, downloadFile, formatDateTime } from '../format';
import './roster.css';

const MAX_BYTES = 512 * 1024;
/** Matches the server's per-request limit (COMMIT_ROWS in worker/import.ts). */
const CHUNK_SIZE = 8;

type Decision = 'create' | 'update' | 'skip';
type Mapping = Partial<Record<ImportField, string>>;
type LoadedFile = { name: string; text: string; headers: string[] };
type Progress = { done: number; total: number };

const DECISION_LABELS: Record<Decision, string> = { create: 'Create', update: 'Update', skip: 'Skip' };

const TEMPLATE_EXAMPLE: Record<ImportField, string> = {
  studentCode: 'S-1001',
  firstName: 'Ada',
  lastName: 'Lovelace',
  grade: '3',
  subjects: 'Math; Reading',
  pickupAlert: '',
  guardianReference: 'FAMILY-1001',
  guardianName: 'Grace Lovelace',
  guardianEmail: 'grace@example.com',
  guardianPhone: '555-0100',
  guardianRelationship: 'Mother',
  pickupAuthority: 'allowed',
  pickupAuthorityNote: 'Photo ID checked against enrollment form',
};

const STATUS_TONE: Record<ImportSummary['status'], 'blue' | 'green' | 'gray'> = { preview: 'blue', completed: 'green', expired: 'gray' };
const STATUS_LABEL: Record<ImportSummary['status'], string> = { preview: 'Awaiting import', completed: 'Completed', expired: 'Expired' };

function downloadTemplate() {
  const header = IMPORT_FIELDS.map(field => csvCell(IMPORT_FIELD_LABELS[field])).join(',');
  const example = IMPORT_FIELDS.map(field => csvCell(TEMPLATE_EXAMPLE[field])).join(',');
  downloadFile('presently-roster-template.csv', `${header}\r\n${example}\r\n`);
}

/** Read only the header row. The server parses and validates the whole file. */
function parseHeaderRow(text: string): string[] {
  const source = text.replace(/^﻿/, '').replace(/^[\r\n]+/, '');
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      cells.push(cell.trim());
      cell = '';
    } else if (ch === '\n' || ch === '\r') break;
    else cell += ch;
  }
  cells.push(cell.trim());
  return cells;
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');

function autoMap(headers: string[]): Mapping {
  const mapping: Mapping = {};
  const used = new Set<string>();
  for (const field of IMPORT_FIELDS) {
    const candidates = [normalize(IMPORT_FIELD_LABELS[field]), normalize(field)];
    const match = headers.find(h => h && !used.has(h) && candidates.includes(normalize(h)));
    if (match) {
      mapping[field] = match;
      used.add(match);
    }
  }
  return mapping;
}

function mappingProblem(mapping: Mapping): string | null {
  const missing = REQUIRED_IMPORT_FIELDS.filter(field => !mapping[field]);
  if (missing.length) return `Choose a column for: ${missing.map(f => IMPORT_FIELD_LABELS[f]).join(', ')}.`;
  const columns = Object.values(mapping).filter(Boolean);
  if (new Set(columns).size !== columns.length) return 'Each CSV column can be used for only one field.';
  return null;
}

function initialDecisions(preview: ImportPreview): Record<number, Decision> {
  const decisions: Record<number, Decision> = {};
  for (const row of preview.rows) {
    if (row.status === 'pending' && row.action !== 'reject') decisions[row.row] = row.action;
  }
  return decisions;
}

function decisionOf(row: ImportRow, decisions: Record<number, Decision>): Decision {
  return decisions[row.row] ?? (row.action === 'reject' ? 'skip' : row.action);
}

export default function ImportPage({ api, location }: PageProps) {
  const timezone = location.timezone;
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [mapping, setMapping] = useState<Mapping>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [decisions, setDecisions] = useState<Record<number, Decision>>({});
  const [busy, setBusy] = useState<'reading' | 'preview' | 'commit' | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState('');
  const [inputKey, setInputKey] = useState(0);
  const [imports, setImports] = useState<ImportSummary[] | null>(null);
  const [importsError, setImportsError] = useState('');

  const loadImports = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await api.get<{ items: ImportSummary[] }>('/imports', signal);
      setImports(result.items);
      setImportsError('');
    } catch (e) {
      if (!signal?.aborted) setImportsError(messageOf(e));
    }
  }, [api]);

  useEffect(() => {
    const controller = new AbortController();
    void loadImports(controller.signal);
    return () => controller.abort();
  }, [loadImports]);

  function startOver() {
    setFile(null);
    setMapping({});
    setPreview(null);
    setDecisions({});
    setProgress(null);
    setError('');
    setInputKey(key => key + 1);
  }

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const chosen = event.target.files?.[0];
    setPreview(null);
    setDecisions({});
    setProgress(null);
    setError('');
    setFile(null);
    if (!chosen) return;
    if (!/\.csv$/i.test(chosen.name)) {
      setError('Choose a .csv file. In a spreadsheet app, use “Save as” or “Download” and pick CSV.');
      return;
    }
    if (chosen.size > MAX_BYTES) {
      setError('The file is larger than 512 KB. Split it into smaller files of at most 500 students each.');
      return;
    }
    setBusy('reading');
    try {
      const text = await chosen.text();
      const headers = parseHeaderRow(text);
      if (!text.trim() || headers.every(h => !h)) {
        setError('The file is empty or has no header row.');
        return;
      }
      setFile({ name: chosen.name, text, headers });
      setMapping(autoMap(headers));
    } catch {
      setError('The file could not be read. Check that it is a plain CSV file and try again.');
    } finally {
      setBusy(null);
    }
  }

  async function requestPreview() {
    if (!file) return;
    const problem = mappingProblem(mapping);
    if (problem) {
      setError(problem);
      return;
    }
    const sentMapping: Mapping = {};
    for (const field of IMPORT_FIELDS) if (mapping[field]) sentMapping[field] = mapping[field];
    setBusy('preview');
    setError('');
    try {
      const result = await api.post<ImportPreview>('/imports/preview', { csv: file.text, mapping: sentMapping, sourceName: file.name });
      setPreview(result);
      setDecisions(initialDecisions(result));
      setProgress(null);
      void loadImports();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  async function commit() {
    if (!preview) return;
    const pending = preview.rows.filter(row => row.status === 'pending');
    if (!pending.length) return;
    setBusy('commit');
    setError('');
    setProgress({ done: 0, total: pending.length });
    try {
      for (let start = 0; start < pending.length; start += CHUNK_SIZE) {
        const chunk = pending.slice(start, start + CHUNK_SIZE).map(row => ({ row: row.row, action: decisionOf(row, decisions) }));
        const result = await api.post<ImportPreview>(`/imports/${preview.importId}/commit`, { rows: chunk });
        setPreview(result);
        setProgress({ done: Math.min(start + CHUNK_SIZE, pending.length), total: pending.length });
      }
    } catch (e) {
      if (e instanceof RequestError && e.code === 'IMPORT_CLOSED') {
        setError('This import is no longer open (previews expire after 24 hours). Upload the file again to start a new preview.');
      } else if (e instanceof RequestError && e.uncertain) {
        setError('The import stopped because the connection dropped. Rows already confirmed are saved. Select “Continue import” to finish; rows are never applied twice.');
      } else {
        setError(`The import stopped: ${messageOf(e)} Rows already confirmed are saved.`);
      }
    } finally {
      setBusy(null);
      void loadImports();
    }
  }

  async function openImport(importId: number) {
    setError('');
    try {
      const result = await api.get<ImportPreview>(`/imports/${importId}`);
      setFile(null);
      setInputKey(key => key + 1);
      setPreview(result);
      setDecisions(initialDecisions(result));
      setProgress(null);
    } catch (e) {
      setError(messageOf(e));
    }
  }

  const counts = useMemo(() => {
    const value = { create: 0, update: 0, skip: 0, reject: 0, applied: 0, skipped: 0, rejected: 0, pending: 0 };
    for (const row of preview?.rows ?? []) {
      if (row.status === 'pending') {
        value.pending++;
        value[decisionOf(row, decisions)]++;
      } else if (row.status === 'rejected') {
        value.reject++;
        value.rejected++;
      } else if (row.status === 'applied') value.applied++;
      else value.skipped++;
    }
    return value;
  }, [preview, decisions]);

  const toApply = counts.create + counts.update;
  const completed = preview?.status === 'completed';
  const started = counts.applied + counts.skipped > 0;
  const headerOptions = file?.headers.filter(Boolean) ?? [];

  return (
    <div className="content">
      <PageHeader
        title="CSV import"
        description={`Add or update students at ${location.name} from a spreadsheet.`}
        actions={(
          <Button onClick={downloadTemplate}>
            <Download size={18} aria-hidden="true" /> Download template
          </Button>
        )}
      />

      <Card title="How it works">
        <ol className="steps">
          <li><strong>Choose a CSV file</strong> exported from your spreadsheet (up to 500 students, 512 KB). The template shows the expected columns.</li>
          <li><strong>Match the columns</strong> to Presently’s fields and preview. Nothing is saved yet.</li>
          <li><strong>Review each row</strong>, then import. Students are matched by student code, so importing again updates rather than duplicates.</li>
        </ol>
      </Card>

      <Alert>{error}</Alert>

      {!preview && (
        <Card title="1. Choose a file">
          <Field label="CSV file" hint="Only .csv files up to 512 KB.">
            <input key={inputKey} type="file" accept=".csv,text/csv" onChange={chooseFile} disabled={busy !== null} />
          </Field>
          {busy === 'reading' && <Spinner label="Reading file" />}
          {file && (
            <p className="muted small">
              {file.name}: {file.headers.length} {file.headers.length === 1 ? 'column' : 'columns'} found.
            </p>
          )}
        </Card>
      )}

      {!preview && file && (
        <Card title="2. Match columns">
          <p className="muted">
            Columns were matched by name where possible. Fields marked required must be matched. Leave a field as “Not in file” to keep existing values.
          </p>
          <div className="mapping-grid">
            {IMPORT_FIELDS.map(field => {
              const required = REQUIRED_IMPORT_FIELDS.includes(field);
              return (
                <Field key={field} label={`${IMPORT_FIELD_LABELS[field]}${required ? ' (required)' : ''}`}>
                  <select
                    value={mapping[field] ?? ''}
                    required={required}
                    onChange={e => setMapping(current => ({ ...current, [field]: e.target.value || undefined }))}
                  >
                    <option value="">Not in file</option>
                    {headerOptions.map(header => <option key={header} value={header}>{header}</option>)}
                  </select>
                </Field>
              );
            })}
          </div>
          <div className="form-actions">
            <Button variant="ghost" onClick={startOver}>Choose a different file</Button>
            <Button variant="primary" busy={busy === 'preview'} onClick={requestPreview}>
              <FileUp size={18} aria-hidden="true" /> Preview
            </Button>
          </div>
        </Card>
      )}

      {preview && (
        <Card
          title={completed ? 'Import receipt' : '3. Review and import'}
          actions={(
            <Button variant="ghost" onClick={startOver} disabled={busy === 'commit'}>
              <RotateCcw size={16} aria-hidden="true" /> Start a new import
            </Button>
          )}
        >
          <p className="muted small">
            {preview.sourceName} · {preview.totalRows} {preview.totalRows === 1 ? 'row' : 'rows'} · previewed {formatDateTime(preview.createdAt, timezone)}
            {!completed && preview.status === 'preview' && <> · preview expires {formatDateTime(preview.expiresAt, timezone)}</>}
          </p>

          {completed && (
            <Alert tone="success">
              Import completed {formatDateTime(preview.completedAt, timezone)}: {counts.applied} applied, {counts.skipped} skipped, {counts.rejected} rejected.
            </Alert>
          )}
          {preview.status === 'expired' && (
            <Alert tone="warning">This preview expired before it was imported. Upload the file again to continue.</Alert>
          )}

          <div className="stats">
            {completed || started
              ? (
                <>
                  <div className="stat"><strong>{counts.applied}</strong><span>Applied</span></div>
                  <div className="stat"><strong>{counts.skipped}</strong><span>Skipped</span></div>
                  <div className="stat"><strong>{counts.rejected}</strong><span>Rejected</span></div>
                  {!completed && <div className="stat"><strong>{counts.pending}</strong><span>Still to import</span></div>}
                </>
              )
              : (
                <>
                  <div className="stat"><strong>{counts.create}</strong><span>New students</span></div>
                  <div className="stat"><strong>{counts.update}</strong><span>Updates</span></div>
                  <div className="stat"><strong>{counts.skip}</strong><span>Skipped</span></div>
                  <div className="stat"><strong>{counts.reject}</strong><span>Rejected</span></div>
                </>
              )}
          </div>

          {counts.reject > 0 && !completed && (
            <Alert tone="warning">
              {counts.reject} {counts.reject === 1 ? 'row has' : 'rows have'} a problem and will not be imported. Fix them in your file and import it again afterwards.
            </Alert>
          )}

          {progress && (
            <div className="stack" style={{ gap: 6 }}>
              <div
                className="progress"
                role="progressbar"
                aria-label="Import progress"
                aria-valuemin={0}
                aria-valuemax={progress.total}
                aria-valuenow={progress.done}
              >
                <span style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} />
              </div>
              <span className="small muted" aria-live="polite">{progress.done} of {progress.total} rows processed</span>
            </div>
          )}

          {preview.status === 'preview' && counts.pending === 0 && (
            <Alert tone="info">There are no rows to import. Every row was rejected; fix the file and upload it again.</Alert>
          )}

          {preview.status === 'preview' && counts.pending > 0 && (
            <div className="form-actions">
              <Button variant="primary" busy={busy === 'commit'} onClick={commit}>
                <Upload size={18} aria-hidden="true" />
                {started ? `Continue import (${counts.pending} left)` : `Import ${toApply} ${toApply === 1 ? 'row' : 'rows'}`}
              </Button>
            </div>
          )}

          <p className="small muted">
            When a code already exists the row updates that student; otherwise a new student is created. Rows marked as a possible duplicate are skipped unless you choose Create.
          </p>

          <div className="table-wrap table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Code</th>
                  <th scope="col">Name</th>
                  <th scope="col">Action</th>
                  <th scope="col">Notes</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map(row => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>{row.studentCode || '—'}</td>
                    <td>{row.studentName || '—'}</td>
                    <td>
                      {row.status === 'pending' && preview.status === 'preview'
                        ? (
                          <select
                            aria-label={`Action for row ${row.row}`}
                            value={decisionOf(row, decisions)}
                            disabled={busy === 'commit'}
                            onChange={e => setDecisions(current => ({ ...current, [row.row]: e.target.value as Decision }))}
                          >
                            {(Object.keys(DECISION_LABELS) as Decision[]).map(d => <option key={d} value={d}>{DECISION_LABELS[d]}</option>)}
                          </select>
                        )
                        : <RowStatus row={row} />}
                    </td>
                    <td>{row.problem ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Recent imports">
        <Alert>{importsError}</Alert>
        {!imports && !importsError && <Spinner />}
        {imports && imports.length === 0 && <EmptyState icon={FileUp} title="No imports yet" />}
        {imports && imports.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">File</th>
                  <th scope="col">Previewed</th>
                  <th scope="col">Rows</th>
                  <th scope="col">Applied</th>
                  <th scope="col">Status</th>
                  <th scope="col">Completed</th>
                  <th scope="col"><span className="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {imports.map(item => (
                  <tr key={item.importId}>
                    <td>{item.sourceName}</td>
                    <td>{formatDateTime(item.createdAt, timezone)}</td>
                    <td>{item.totalRows}</td>
                    <td>{item.applied}</td>
                    <td><Badge tone={STATUS_TONE[item.status]}>{STATUS_LABEL[item.status]}</Badge></td>
                    <td>{formatDateTime(item.completedAt, timezone)}</td>
                    <td>
                      <Button
                        variant="ghost"
                        disabled={busy === 'commit'}
                        onClick={() => openImport(item.importId)}
                        aria-label={`${item.status === 'preview' ? 'Resume' : 'View'} import of ${item.sourceName}`}
                      >
                        {item.status === 'preview' ? 'Resume' : 'View'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function RowStatus({ row }: { row: ImportRow }) {
  if (row.status === 'applied') return <Badge tone="green">{row.action === 'update' ? 'Updated' : 'Created'}</Badge>;
  if (row.status === 'skipped') return <Badge>Skipped</Badge>;
  if (row.status === 'rejected') return <Badge tone="red">Rejected</Badge>;
  return <Badge tone="blue">{DECISION_LABELS[row.action === 'reject' ? 'skip' : row.action]}</Badge>;
}
