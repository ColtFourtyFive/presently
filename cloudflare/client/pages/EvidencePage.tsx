import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Printer, XCircle } from 'lucide-react';
import { NON_AFFILIATION_NOTICE, PRODUCT_NAME } from '../../shared/types';
import { REQUIREMENTS, type EvidenceItem, type EvidenceReport, type Requirement } from '../../shared/evidence';
import type { PageProps } from '../App';
import { messageOf } from '../api';
import { Alert, Badge, Button, Card, Field, PageHeader, Spinner } from '../components';
import { formatDate, formatDateTime, localDate } from '../format';
import './reports.css';

export default function EvidencePage({ api, location }: PageProps) {
  const timezone = location.timezone;
  const currentYear = Number(localDate(timezone).slice(0, 4));
  const years = [currentYear, currentYear - 1, currentYear - 2];
  const [year, setYear] = useState(currentYear);
  const [report, setReport] = useState<EvidenceReport | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const value = await api.get<EvidenceReport>(`/evidence?year=${year}`, signal);
      setReport(value);
      setError('');
    } catch (e) {
      if (!signal?.aborted) setError(messageOf(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [api, year]);

  useEffect(() => {
    const controller = new AbortController();
    setReport(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const items = report
    ? REQUIREMENTS.map(requirement => ({ requirement, item: report.items.find(i => i.number === requirement.number) ?? null }))
    : [];
  const met = report?.items.filter(i => i.status === 'met').length ?? 0;
  const attested = report?.items.filter(i => i.attestation?.confirmed).length ?? 0;
  const total = REQUIREMENTS.length;

  return (
    <div className="content">
      <div className="no-print">
        <PageHeader
          title="Evidence report"
          description="An annual summary of what the system records show for each check-in/check-out requirement, alongside the center’s own attestations."
          actions={
            <>
              <Field label="Year">
                <select value={year} onChange={e => setYear(Number(e.target.value))}>
                  {years.map(y => <option key={y} value={y}>{y}</option>)}
                </select>
              </Field>
              <Button variant="primary" disabled={!report} onClick={() => window.print()} style={{ alignSelf: 'end' }}>
                <Printer size={18} aria-hidden="true" /> Download PDF
              </Button>
            </>
          }
        />
        <p className="muted small" style={{ marginTop: 8 }}>
          “Download PDF” opens your browser’s print dialog. Choose “Save as PDF” as the destination to keep a copy.
        </p>
      </div>

      <Alert>{error}</Alert>
      {loading && !report && <Spinner label="Building the report" />}

      {report && (
        <>
          <Card>
            <div className="report-header">
              <span className="product">{PRODUCT_NAME}</span>
              <h1>Check-in/check-out evidence report</h1>
              <p><strong>{report.business}</strong></p>
              <p>
                {report.location.name}
                {report.location.address && <span className="muted"> · {report.location.address}</span>}
              </p>
              <dl className="facts" style={{ marginTop: 8 }}>
                <dt>Period</dt>
                <dd>{formatDate(`${report.period.from}T12:00:00Z`, 'UTC')} to {formatDate(`${report.period.to}T12:00:00Z`, 'UTC')} ({report.year})</dd>
                <dt>Time zone</dt>
                <dd>{report.location.timezone}</dd>
                <dt>Generated</dt>
                <dd>{formatDateTime(report.generatedAt, report.location.timezone)} by {report.generatedBy}</dd>
              </dl>
            </div>
            <div className="stats">
              <div className="stat">
                <strong>{met} of {total}</strong>
                <span>Software checks met</span>
              </div>
              <div className="stat">
                <strong>{attested} of {total}</strong>
                <span>Confirmed by the center</span>
              </div>
            </div>
            <p className="small muted">
              This report summarizes records kept in {PRODUCT_NAME} and attestations recorded by center staff. It does not itself certify
              compliance with any franchisor requirement; the center remains responsible for its own certification.
            </p>
          </Card>

          <Card title={`Requirements for ${report.year}`} actions={loading ? <span className="muted small no-print">Refreshing…</span> : undefined}>
            <div>
              {items.map(({ requirement, item }) => (
                <RequirementSection
                  key={requirement.number}
                  requirement={requirement}
                  item={item}
                  timezone={report.location.timezone}
                  onAttest={async (confirmed, note) => {
                    await api.post('/attestations', { requirement: requirement.number, year: report.year, confirmed, note });
                    await load();
                  }}
                />
              ))}
            </div>
          </Card>

          <div className="print-only">
            <div className="signature">
              <div>Certified by</div>
              <div>Title</div>
              <div>Date</div>
            </div>
          </div>
          <p className="report-footer">{NON_AFFILIATION_NOTICE}</p>
        </>
      )}
    </div>
  );
}

function RequirementSection({ requirement, item, timezone, onAttest }: {
  requirement: Requirement; item: EvidenceItem | null; timezone: string;
  onAttest: (confirmed: boolean, note: string) => Promise<void>;
}) {
  const headingId = `requirement-${requirement.number}`;
  return (
    <section className="requirement" aria-labelledby={headingId}>
      <div className="requirement-head">
        <div>
          <h3 id={headingId}>{requirement.number}. {requirement.title}</h3>
          <p className="muted">{requirement.summary}</p>
        </div>
        {item && (item.status === 'met'
          ? <Badge tone="green">Software checks met</Badge>
          : <Badge tone="amber">Needs attention</Badge>)}
      </div>

      {item && item.facts.length > 0 && (
        <dl className="facts">
          {item.facts.map(fact => (
            <div key={fact.label} style={{ display: 'contents' }}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {item && item.attention.length > 0 && (
        <ul className="attention-list">
          {item.attention.map(text => (
            <li key={text}><AlertTriangle size={14} aria-hidden="true" /> {text}</li>
          ))}
        </ul>
      )}
      {!item && <p className="muted">The server did not return evidence for this requirement.</p>}

      <div className="attestation">
        <strong>Center attestation</strong>
        <p>{requirement.centerAttests}</p>
        {item?.attestation
          ? (
            <p>
              {item.attestation.confirmed
                ? <><CheckCircle2 size={16} aria-hidden="true" style={{ color: 'var(--green)', verticalAlign: '-3px' }} /> <strong>Confirmed</strong></>
                : <><XCircle size={16} aria-hidden="true" style={{ color: 'var(--red)', verticalAlign: '-3px' }} /> <strong>Not confirmed</strong></>}
              {' '}by {item.attestation.attestedBy} on {formatDateTime(item.attestation.attestedAt, timezone)}
              {item.attestation.note && <><br /><span className="muted">Note: {item.attestation.note}</span></>}
            </p>
          )
          : <p className="muted">Not yet attested.</p>}
        <AttestationForm label={requirement.title} number={requirement.number} onAttest={onAttest} />
      </div>
    </section>
  );
}

function AttestationForm({ label, number, onAttest }: { label: string; number: number; onAttest: (confirmed: boolean, note: string) => Promise<void> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'yes' | 'no' | null>(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  async function submit(confirmed: boolean) {
    setBusy(confirmed ? 'yes' : 'no');
    setError('');
    setSaved('');
    try {
      await onAttest(confirmed, note.trim());
      setNote('');
      setSaved(confirmed ? 'Confirmation recorded.' : 'Recorded as not confirmed.');
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack no-print" style={{ gap: 8 }}>
      <Field label="Note (optional)" hint="Attestations are kept permanently. Recording again adds a new entry; the latest one is shown.">
        <textarea
          rows={2}
          maxLength={1000}
          value={note}
          aria-label={`Attestation note for requirement ${number}, ${label}`}
          onChange={e => setNote(e.target.value)}
        />
      </Field>
      <div className="row">
        <Button variant="primary" busy={busy === 'yes'} disabled={busy !== null} onClick={() => void submit(true)}>
          <CheckCircle2 size={18} aria-hidden="true" /> Confirm
        </Button>
        <Button busy={busy === 'no'} disabled={busy !== null} onClick={() => void submit(false)}>
          <XCircle size={18} aria-hidden="true" /> Not confirmed
        </Button>
      </div>
      <Alert>{error}</Alert>
      <Alert tone="success">{saved}</Alert>
    </div>
  );
}
