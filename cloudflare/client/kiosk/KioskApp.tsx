import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Delete, Lock, Search, Tablet, UserCheck, Users } from 'lucide-react';
import type { KioskStatus, StudentListItem, VisitSummary } from '../../shared/types';
import { NON_AFFILIATION_NOTICE, PRODUCT_NAME } from '../../shared/types';
import { RequestError, createApi, messageOf, request, type Api } from '../api';
import { AttendanceSheet } from '../attendance';
import { Alert, Badge, Button, ConnectionBar, EmptyState, Field, Spinner } from '../components';
import { formatDuration, formatTime } from '../format';
import { useRosterPolling, useStudentSearch } from '../pages/TodayPage';

const AUTO_LOCK_MS = 5 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;
const PIN_MIN = 8;
const PIN_MAX = 12;
const AUTH_LOST_CODES = ['PIN_REQUIRED', 'DEVICE_REQUIRED'];

const listStyle = { listStyle: 'none', padding: 0, margin: 0 } as const;

/** Wrap the kiosk API so that a lost device or operator session sends the kiosk back to its lock screen. */
function guardApi(inner: Api, onAuthLost: () => void): Api {
  function guard<T>(promise: Promise<T>): Promise<T> {
    return promise.catch((error: unknown) => {
      if (error instanceof RequestError && error.status === 401 && error.code && AUTH_LOST_CODES.includes(error.code)) onAuthLost();
      throw error;
    });
  }
  return {
    channel: inner.channel,
    get: (path, signal) => guard(inner.get(path, signal)),
    post: (path, body) => guard(inner.post(path, body)),
    patch: (path, body) => guard(inner.patch(path, body)),
  };
}

function Footer() {
  return (
    <footer className="muted small" style={{ padding: '12px 20px', textAlign: 'center' }}>
      {NON_AFFILIATION_NOTICE}
    </footer>
  );
}

function EnrollScreen({ api, onEnrolled }: { api: Api; onEnrolled: () => void }) {
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('Front desk iPad');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/enroll', { token: code.trim(), label: label.trim() });
      onEnrolled();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kiosk-center" style={{ minHeight: '100vh' }}>
      <form className="kiosk-panel" onSubmit={submit}>
        <div className="row">
          <Tablet size={28} aria-hidden="true" />
          <h1>Set up this kiosk</h1>
        </div>
        <p>
          This device is not set up yet. Ask the owner to open <strong>Settings</strong> in {PRODUCT_NAME}, create a kiosk
          enrollment code for this location, and enter it below. Each code works once.
        </p>
        <Field label="Enrollment code">
          <input
            value={code}
            onChange={e => setCode(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            required
            maxLength={100}
          />
        </Field>
        <Field label="Device name" hint="Helps the owner recognize this device later.">
          <input value={label} onChange={e => setLabel(e.target.value)} required maxLength={100} />
        </Field>
        <Alert>{error}</Alert>
        <Button type="submit" variant="primary" className="btn-xl" busy={busy} disabled={!code.trim() || !label.trim()}>
          Set up kiosk
        </Button>
      </form>
      <Footer />
    </div>
  );
}

function UnlockScreen({ api, status, onUnlocked }: { api: Api; status: KioskStatus; onUnlocked: () => void }) {
  const [staff, setStaff] = useState<{ id: number; displayName: string } | null>(null);
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const addDigit = useCallback((digit: string) => {
    setError('');
    setPin(current => (current.length >= PIN_MAX ? current : current + digit));
  }, []);
  const backspace = useCallback(() => setPin(current => current.slice(0, -1)), []);

  async function submit() {
    if (!staff || pin.length < PIN_MIN || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.post('/unlock', { staffId: staff.id, pin });
      setPin('');
      onUnlocked();
    } catch (e) {
      setPin('');
      if (e instanceof RequestError && e.code === 'DEVICE_REQUIRED') onUnlocked();
      if (e instanceof RequestError && e.code === 'PIN_LOCKED') setError(e.message);
      else if (e instanceof RequestError && e.code === 'PIN_INVALID') setError('That PIN did not match. Check that you chose your own name and try again.');
      else setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  const submitRef = useRef(submit);
  submitRef.current = submit;

  // A hardware keyboard works too, without ever putting the PIN in a visible field.
  useEffect(() => {
    if (!staff) return;
    const listener = (event: KeyboardEvent) => {
      if (/^\d$/.test(event.key)) addDigit(event.key);
      else if (event.key === 'Backspace') backspace();
      else if (event.key === 'Enter') void submitRef.current();
      else if (event.key === 'Escape') {
        setStaff(null);
        setPin('');
      }
      else return;
      event.preventDefault();
    };
    document.addEventListener('keydown', listener);
    return () => document.removeEventListener('keydown', listener);
  }, [staff, addDigit, backspace]);

  const locationName = status.location?.name ?? 'This location';
  return (
    <div className="kiosk-center" style={{ minHeight: '100vh' }}>
      <div className="kiosk-panel">
        <div>
          <p className="muted small">{PRODUCT_NAME} kiosk{status.device ? ` · ${status.device.label}` : ''}</p>
          <h1>{locationName}</h1>
        </div>
        {!staff && (
          <>
            <h2>Who is unlocking the kiosk?</h2>
            {status.staff.length === 0 ? (
              <Alert tone="warning">
                No staff can unlock this kiosk yet. The owner can turn on kiosk access and set a PIN for staff in Settings.
              </Alert>
            ) : (
              <div className="staff-grid">
                {status.staff.map(person => (
                  <button
                    key={person.id}
                    type="button"
                    onClick={() => {
                      setStaff(person);
                      setPin('');
                      setError('');
                    }}
                  >
                    {person.displayName}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {staff && (
          <>
            <div>
              <h2>Enter your PIN, {staff.displayName}</h2>
              <p className="muted small">Your PIN has {PIN_MIN} to {PIN_MAX} digits.</p>
            </div>
            <div className="pin-dots" role="status" aria-live="polite" aria-label={`${pin.length} digits entered`}>
              {Array.from({ length: pin.length }, (_, i) => <span key={i} aria-hidden="true" />)}
            </div>
            <Alert>{error}</Alert>
            <div className="keypad" role="group" aria-label="PIN keypad">
              {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(digit => (
                <button key={digit} type="button" onClick={() => addDigit(digit)} disabled={busy}>{digit}</button>
              ))}
              <button type="button" onClick={() => setPin('')} disabled={busy} aria-label="Clear PIN" style={{ fontSize: '1rem' }}>
                Clear
              </button>
              <button type="button" onClick={() => addDigit('0')} disabled={busy}>0</button>
              <button type="button" onClick={backspace} disabled={busy} aria-label="Delete last digit">
                <Delete size={24} aria-hidden="true" />
              </button>
            </div>
            <Button variant="primary" className="btn-xl" busy={busy} disabled={pin.length < PIN_MIN} onClick={() => void submit()}>
              Unlock
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setStaff(null);
                setPin('');
                setError('');
              }}
            >
              Not {staff.displayName}? Choose a different name
            </Button>
          </>
        )}
      </div>
      <Footer />
    </div>
  );
}

function Workspace({ api, status, onLock }: { api: Api; status: KioskStatus; onLock: () => void }) {
  const timezone = status.location?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const { roster, state, lastRefresh, refresh } = useRosterPolling(api);
  const [query, setQuery] = useState('');
  const search = useStudentSearch(api, query, 30, true);
  const [selected, setSelected] = useState<number | null>(null);
  const [recorded, setRecorded] = useState(false);

  // Auto-lock after inactivity, and keep the server session alive while staff are using the kiosk.
  const lastActivity = useRef(Date.now());
  const lastTouch = useRef(Date.now());
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;
  useEffect(() => {
    const activity = () => {
      const at = Date.now();
      lastActivity.current = at;
      if (at - lastTouch.current >= TOUCH_INTERVAL_MS) {
        lastTouch.current = at;
        api.post('/touch').catch(() => {
          // A lost session is handled by the guarded API; a network failure will be retried on the next touch.
          lastTouch.current = 0;
        });
      }
    };
    const events = ['pointerdown', 'keydown', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, activity, { capture: true, passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - lastActivity.current >= AUTO_LOCK_MS) onLockRef.current();
    }, 5000);
    return () => {
      for (const name of events) window.removeEventListener(name, activity, { capture: true });
      window.clearInterval(timer);
    };
  }, [api]);

  function closeSheet() {
    setSelected(null);
    // After a recorded arrival or departure, start fresh for the next family.
    if (recorded) setQuery('');
    setRecorded(false);
  }

  const present = roster?.items ?? [];

  function studentButton(student: StudentListItem) {
    return (
      <li key={student.id}>
        <button type="button" className="roster-item" onClick={() => setSelected(student.id)}>
          <span>
            <strong>{student.displayName}</strong>
            <span className="muted small">{student.studentCode}{student.grade ? ` · Grade ${student.grade}` : ''}</span>
          </span>
          {student.present ? <Badge tone="green">Here now</Badge> : <Badge>Not here</Badge>}
        </button>
      </li>
    );
  }

  function visitButton(visit: VisitSummary) {
    return (
      <li key={visit.id}>
        <button
          type="button"
          className="roster-item"
          onClick={() => setSelected(visit.studentId)}
          aria-label={`${visit.studentName}, here since ${formatTime(visit.checkInAt, timezone)}. Open check-out.`}
        >
          <span>
            <strong>{visit.studentName}</strong>
            <span className="muted small">
              Since {formatTime(visit.checkInAt, timezone)} · {formatDuration(visit.checkInAt, null)}
            </span>
          </span>
          {visit.reviewStatus === 'pending' && <Badge tone="amber">Needs review</Badge>}
        </button>
      </li>
    );
  }

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <div>
          <h1 style={{ fontSize: '1.4rem' }}>{status.location?.name ?? PRODUCT_NAME}</h1>
          <p className="muted small">Unlocked by {status.operator?.displayName}. Locks after 5 minutes without use.</p>
        </div>
        <Button onClick={onLock}>
          <Lock size={18} aria-hidden="true" /> Lock
        </Button>
      </header>
      <ConnectionBar state={state} lastRefresh={lastRefresh} timezone={timezone} />
      <main className="kiosk-body">
        <section className="stack" aria-labelledby="kiosk-search-heading">
          <h2 id="kiosk-search-heading">Check in or check out</h2>
          <label className="field kiosk-search">
            <span className="field-label">Student name or code</span>
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Start typing a name"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </label>
          <div aria-live="polite">
            <Alert>{search.error}</Alert>
            {search.loading && !search.result && <Spinner label="Searching" />}
            {search.result && search.result.items.length === 0 && !search.loading && (
              <EmptyState icon={Search} title="No matching students">
                <p>Check the spelling or try the student code.</p>
              </EmptyState>
            )}
            {search.result && search.result.items.length > 0 && (
              <div className="stack">
                <ul className="roster-list" style={listStyle}>
                  {search.result.items.map(studentButton)}
                </ul>
                {search.result.total > search.result.items.length && (
                  <p className="muted small">
                    Showing {search.result.items.length} of {search.result.total}. Type more of the name to narrow the list.
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
        <section className="stack" aria-labelledby="kiosk-roster-heading">
          <h2 id="kiosk-roster-heading">
            <UserCheck size={20} aria-hidden="true" /> Here now{roster ? ` (${present.length}${roster.truncated ? '+' : ''})` : ''}
          </h2>
          {!roster && state !== 'offline' && <Spinner label="Loading who’s here" />}
          {!roster && state === 'offline' && <Alert>The list of students here could not be loaded. It will retry automatically.</Alert>}
          {roster && present.length === 0 && (
            <EmptyState icon={Users} title="Nobody is checked in">
              <p>Students appear here as soon as they are checked in.</p>
            </EmptyState>
          )}
          {present.length > 0 && (
            <ul className="roster-list" style={listStyle} aria-label="Students here now">
              {present.map(visitButton)}
            </ul>
          )}
        </section>
      </main>
      <Footer />
      {selected !== null && (
        <AttendanceSheet
          api={api}
          studentId={selected}
          timezone={timezone}
          onClose={closeSheet}
          onRecorded={() => {
            setRecorded(true);
            void refresh();
            search.reload();
          }}
        />
      )}
    </div>
  );
}

export default function KioskApp() {
  const [status, setStatus] = useState<KioskStatus | null>(null);
  const [error, setError] = useState('');
  const sequence = useRef(0);

  const loadStatus = useCallback(async () => {
    // Only the latest status request may apply, so an older reply can never reopen a locked kiosk.
    const current = ++sequence.current;
    try {
      const value = await request<KioskStatus>('/api/kiosk/status');
      if (current !== sequence.current) return;
      setStatus(value);
      setError('');
    } catch (e) {
      if (current === sequence.current) setError(messageOf(e));
    }
  }, []);
  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const rawApi = useMemo(() => createApi('kiosk', null), []);
  const api = useMemo(() => guardApi(rawApi, () => {
    // Hide the workspace at once, then learn from the server whether the device or only the PIN session was lost.
    setStatus(current => (current ? { ...current, operator: undefined, sessionExpiresAt: undefined } : current));
    void loadStatus();
  }), [rawApi, loadStatus]);

  const lock = useCallback(() => {
    // Lock on screen immediately, even if the connection is down; the server session also expires on its own.
    setStatus(current => (current ? { ...current, operator: undefined, sessionExpiresAt: undefined } : current));
    rawApi.post('/lock')
      .catch(() => undefined)
      .finally(() => void loadStatus());
  }, [rawApi, loadStatus]);

  if (!status) {
    return (
      <div className="kiosk-center" style={{ minHeight: '100vh' }}>
        <div className="kiosk-panel">
          {error ? (
            <>
              <Alert>{error}</Alert>
              <p>Check the internet connection. If it is down, follow the outage procedure and record times on paper.</p>
              <Button variant="primary" className="btn-xl" onClick={() => void loadStatus()}>Try again</Button>
            </>
          ) : (
            <Spinner label="Starting kiosk" />
          )}
        </div>
        <Footer />
      </div>
    );
  }
  if (!status.enrolled) return <EnrollScreen api={rawApi} onEnrolled={() => void loadStatus()} />;
  if (!status.operator) return <UnlockScreen api={rawApi} status={status} onUnlocked={() => void loadStatus()} />;
  return <Workspace key={status.operator.id} api={api} status={status} onLock={lock} />;
}
