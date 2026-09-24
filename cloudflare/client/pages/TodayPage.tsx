import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ClipboardCheck, Search, Users } from 'lucide-react';
import type { AttendanceResult, Page, Review, RosterPollResponse, RosterResponse, StudentListItem, VisitSummary } from '../../shared/types';
import type { PageProps } from '../App';
import { messageOf, type Api } from '../api';
import { AttendanceSheet } from '../attendance';
import { Alert, Badge, Button, Card, ConnectionBar, EmptyState, PageHeader, Spinner } from '../components';
import { formatDateTime, formatDuration, formatTime } from '../format';

export type ConnectionState = 'online' | 'refreshing' | 'offline';

const ROSTER_POLL_MS = 10000;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * Who is here now, kept current by polling with the last known revision.
 * Polling pauses while the page is hidden and never overlaps requests.
 * On failure the last roster stays on screen and the state becomes offline.
 */
export function useRosterPolling(api: Api) {
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [state, setState] = useState<ConnectionState>('refreshing');
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);
  const revision = useRef<number | null>(null);
  const inFlight = useRef(false);
  const queued = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const disposed = useRef(false);
  const loadRef = useRef<() => Promise<void>>(async () => {});

  const load = useCallback(async () => {
    if (disposed.current) return;
    if (inFlight.current) {
      // A refresh was asked for while one is running: run once more afterwards.
      queued.current = true;
      return;
    }
    inFlight.current = true;
    const abort = new AbortController();
    controller.current = abort;
    setState('refreshing');
    try {
      const query = revision.current ? `?revision=${revision.current}` : '';
      const value = await api.get<RosterPollResponse>(`/roster${query}`, abort.signal);
      if (abort.signal.aborted || disposed.current) return;
      if (!('unchanged' in value)) setRoster(value);
      revision.current = value.revision;
      setLastRefresh(value.asOf);
      setState('online');
    } catch {
      if (!abort.signal.aborted && !disposed.current) setState('offline');
    } finally {
      // Only the request that is still current may release the lock; a cancelled one must not.
      if (controller.current === abort) {
        inFlight.current = false;
        controller.current = null;
        if (queued.current && !disposed.current) {
          queued.current = false;
          void loadRef.current();
        }
      }
    }
  }, [api]);
  loadRef.current = load;

  useEffect(() => {
    disposed.current = false;
    revision.current = null;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, ROSTER_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      disposed.current = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
      controller.current?.abort();
      controller.current = null;
      inFlight.current = false;
      queued.current = false;
    };
  }, [load]);

  return { roster, state, lastRefresh, refresh: load };
}

/** Debounced student search. Earlier searches are cancelled when the query changes. */
export function useStudentSearch(api: Api, query: string, pageSize: number, enabled: boolean) {
  const [result, setResult] = useState<Page<StudentListItem> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setResult(null);
      setLoading(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams({ q: query.trim(), status: 'active', pageSize: String(pageSize) });
      api.get<Page<StudentListItem>>(`/students?${params.toString()}`, controller.signal)
        .then(value => {
          setResult(value);
          setError('');
        })
        .catch(e => {
          if (!controller.signal.aborted) setError(messageOf(e));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [api, query, pageSize, enabled, nonce]);

  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { result, loading, error, reload };
}

function ReviewItem({ api, review, timezone, onResolved }: {
  api: Api; review: Review; timezone: string; onResolved: () => void;
}) {
  const [resolution, setResolution] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fieldId = `review-${review.id}-resolution`;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (resolution.trim().length < 5) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/reviews/${review.id}/resolve`, { resolution: resolution.trim() });
      onResolved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="card">
      <div className="card-header">
        <div>
          <h3>{review.studentName}</h3>
          <p className="muted small">Recorded {formatDateTime(review.createdAt, timezone)}</p>
        </div>
        <Badge tone="amber">Needs review</Badge>
      </div>
      <p><strong>What happened:</strong> {review.reason || 'No details were recorded.'}</p>
      <form className="stack" onSubmit={submit}>
        <label className="field" htmlFor={fieldId}>
          <span className="field-label">How was this resolved?</span>
          <textarea
            id={fieldId}
            rows={2}
            value={resolution}
            onChange={e => setResolution(e.target.value)}
            placeholder="Who you spoke with and what was confirmed"
          />
          <span className="field-hint">At least 5 characters. This becomes part of the permanent record.</span>
        </label>
        <Alert>{error}</Alert>
        <div className="row">
          <Button type="submit" variant="primary" busy={busy} disabled={resolution.trim().length < 5}>
            Mark as resolved
          </Button>
        </div>
      </form>
    </li>
  );
}

export default function TodayPage({ api, session, location }: PageProps) {
  const role = session.actor.role;
  const canRecord = role === 'owner' || role === 'manager' || role === 'front_desk';
  const canReview = role === 'owner' || role === 'manager';
  const timezone = location.timezone;

  const { roster, state, lastRefresh, refresh } = useRosterPolling(api);
  const [query, setQuery] = useState('');
  const search = useStudentSearch(api, query, 20, query.trim().length > 0);
  const [selected, setSelected] = useState<number | null>(null);

  const [reviews, setReviews] = useState<Review[] | null>(null);
  const [reviewError, setReviewError] = useState('');

  const loadReviews = useCallback(async () => {
    if (!canReview) return;
    try {
      const value = await api.get<{ items: Review[] }>('/reviews');
      setReviews(value.items);
      setReviewError('');
    } catch (e) {
      setReviewError(messageOf(e));
    }
  }, [api, canReview]);

  // Exceptional departures create reviews and change the roster, so reload reviews whenever the roster moves.
  const rosterRevision = roster?.revision;
  useEffect(() => {
    void loadReviews();
  }, [loadReviews, rosterRevision]);

  function onRecorded(_result: AttendanceResult) {
    void refresh();
    search.reload();
  }

  const present = roster?.items ?? [];

  function presentRow(visit: VisitSummary) {
    const content = (
      <>
        <span>
          <strong>{visit.studentName}</strong>
          <span className="muted small">
            {visit.studentCode} · Here since {formatTime(visit.checkInAt, timezone)} · {formatDuration(visit.checkInAt, null)}
          </span>
        </span>
        {visit.reviewStatus === 'pending' && <Badge tone="amber">Needs review</Badge>}
      </>
    );
    return (
      <li key={visit.id}>
        {canRecord ? (
          <button
            type="button"
            className="roster-item"
            onClick={() => setSelected(visit.studentId)}
            aria-label={`${visit.studentName}, here since ${formatTime(visit.checkInAt, timezone)}. Open check-out.`}
          >
            {content}
          </button>
        ) : (
          <div className="roster-item" style={{ cursor: 'default' }}>{content}</div>
        )}
      </li>
    );
  }

  function searchRow(student: StudentListItem) {
    const content = (
      <>
        <span>
          <strong>{student.displayName}</strong>
          <span className="muted small">
            {student.studentCode}{student.grade ? ` · Grade ${student.grade}` : ''}
          </span>
        </span>
        {student.present ? <Badge tone="green">Here now</Badge> : <Badge>Not here</Badge>}
      </>
    );
    return (
      <li key={student.id}>
        {canRecord ? (
          <button type="button" className="roster-item" onClick={() => setSelected(student.id)}>
            {content}
          </button>
        ) : (
          <div className="roster-item" style={{ cursor: 'default' }}>{content}</div>
        )}
      </li>
    );
  }

  return (
    <div className="content">
      <PageHeader
        title="Who’s here now"
        description={<>Students currently checked in at {location.name}. Times are shown in the location’s time zone.</>}
      />
      <ConnectionBar state={state} lastRefresh={lastRefresh} timezone={timezone} />

      <div className="stats">
        <div className="stat">
          <strong>{roster ? `${present.length}${roster.truncated ? '+' : ''}` : '—'}</strong>
          <span>Here now</span>
        </div>
        {canReview && (
          <div className="stat">
            <strong>{reviews ? reviews.length : '—'}</strong>
            <span>Departures to review</span>
          </div>
        )}
      </div>

      <Card title="Find a student">
        <label className="field">
          <span className="field-label">Name or student code</span>
          <input
            type="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Start typing a name"
            autoComplete="off"
          />
          {!canRecord && <span className="field-hint">Instructors can look students up. Check-in and check-out are recorded by front desk staff.</span>}
        </label>
        {query.trim() && (
          <div aria-live="polite">
            <Alert>{search.error}</Alert>
            {search.loading && !search.result && <Spinner label="Searching" />}
            {search.result && search.result.items.length === 0 && !search.loading && (
              <EmptyState icon={Search} title="No matching students">
                <p>Check the spelling or search by student code.</p>
              </EmptyState>
            )}
            {search.result && search.result.items.length > 0 && (
              <>
                <ul className="roster-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {search.result.items.map(searchRow)}
                </ul>
                {search.result.total > search.result.items.length && (
                  <p className="muted small">
                    Showing {search.result.items.length} of {search.result.total}. Type more of the name to narrow the list.
                  </p>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      <Card title={`Here now${roster ? ` (${present.length})` : ''}`}>
        {roster?.truncated && (
          <Alert tone="warning">Only the first {roster.limit} students are listed. Use search to find anyone else.</Alert>
        )}
        {!roster && state !== 'offline' && <Spinner label="Loading who’s here" />}
        {!roster && state === 'offline' && <Alert>The roster could not be loaded. It will retry automatically.</Alert>}
        {roster && present.length === 0 && (
          <EmptyState icon={Users} title="Nobody is checked in">
            <p>Students appear here as soon as they are checked in.</p>
          </EmptyState>
        )}
        {present.length > 0 && (
          <ul className="roster-list" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label="Students here now">
            {present.map(presentRow)}
          </ul>
        )}
      </Card>

      {canReview && (
        <Card title="Needs review">
          <Alert>{reviewError}</Alert>
          {!reviews && !reviewError && <Spinner label="Loading reviews" />}
          {reviews && reviews.length === 0 && (
            <EmptyState icon={ClipboardCheck} title="Nothing to review">
              <p>Departures recorded without a verified pickup will appear here.</p>
            </EmptyState>
          )}
          {reviews && reviews.length > 0 && (
            <ul className="stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {reviews.map(review => (
                <ReviewItem
                  key={review.id}
                  api={api}
                  review={review}
                  timezone={timezone}
                  onResolved={() => {
                    void loadReviews();
                    void refresh();
                  }}
                />
              ))}
            </ul>
          )}
        </Card>
      )}

      {selected !== null && canRecord && (
        <AttendanceSheet
          api={api}
          studentId={selected}
          timezone={timezone}
          onClose={() => setSelected(null)}
          onRecorded={onRecorded}
        />
      )}
    </div>
  );
}
