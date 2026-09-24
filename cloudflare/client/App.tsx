import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { CalendarClock, ClipboardCheck, FileUp, History, Settings, UserCheck, Users } from 'lucide-react';
import type { AdminSession, Location } from '../shared/types';
import { NON_AFFILIATION_NOTICE, PRODUCT_NAME, PRODUCT_TAGLINE, ROLE_LABELS } from '../shared/types';
import { createApi, messageOf, request, type Api } from './api';
import { Alert, Spinner } from './components';
import TodayPage from './pages/TodayPage';
import StudentsPage from './pages/StudentsPage';
import ImportPage from './pages/ImportPage';
import HistoryPage from './pages/HistoryPage';
import EvidencePage from './pages/EvidencePage';
import SettingsPage from './pages/SettingsPage';

export type PageProps = { api: Api; session: AdminSession; location: Location; reloadSession: () => Promise<void> };
type Page = { id: string; label: string; icon: typeof Users; roles: string[]; component: (props: PageProps) => ReactElement };

const PAGES: Page[] = [
  { id: 'today', label: 'Who’s here now', icon: UserCheck, roles: ['owner', 'manager', 'front_desk', 'instructor'], component: TodayPage },
  { id: 'students', label: 'Roster', icon: Users, roles: ['owner', 'manager', 'front_desk', 'instructor'], component: StudentsPage },
  { id: 'import', label: 'CSV import', icon: FileUp, roles: ['owner', 'manager'], component: ImportPage },
  { id: 'history', label: 'History', icon: History, roles: ['owner', 'manager'], component: HistoryPage },
  { id: 'evidence', label: 'Evidence report', icon: ClipboardCheck, roles: ['owner', 'manager'], component: EvidencePage },
  { id: 'settings', label: 'Settings', icon: Settings, roles: ['owner'], component: SettingsPage },
];

const LOCATION_KEY = 'presently.location';
const readStoredLocation = () => { try { return Number(localStorage.getItem(LOCATION_KEY)) || null; } catch { return null; } };
const storeLocation = (id: number) => { try { localStorage.setItem(LOCATION_KEY, String(id)); } catch { /* Selection is still kept for this page view. */ } };
const currentHash = () => location.hash.replace(/^#\/?/, '') || 'today';

export default function AdminApp() {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [error, setError] = useState('');
  const [locationId, setLocationId] = useState<number | null>(readStoredLocation);
  const [page, setPage] = useState(currentHash);

  const loadSession = useCallback(async () => {
    try {
      const value = await request<AdminSession>('/api/admin/session');
      setSession(value);
      setError('');
      setLocationId(current => (value.locations.some(l => l.id === current) ? current : value.locations[0]?.id ?? null));
    } catch (e) {
      setError(messageOf(e));
    }
  }, []);
  useEffect(() => { void loadSession(); }, [loadSession]);
  useEffect(() => {
    const listener = () => setPage(currentHash());
    window.addEventListener('hashchange', listener);
    return () => window.removeEventListener('hashchange', listener);
  }, []);

  const location = session?.locations.find(l => l.id === locationId) ?? null;
  const api = useMemo(() => createApi('admin', location?.id ?? null), [location?.id]);
  if (!session) {
    return <div className="kiosk-center" style={{ minHeight: '100vh' }}>{error ? <Alert>{error} Sign in through your organization’s Cloudflare Access page.</Alert> : <Spinner />}</div>;
  }
  const visible = PAGES.filter(p => p.roles.includes(session.actor.role));
  const active = visible.find(p => p.id === page) ?? visible[0];
  const Component = active.component;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><UserCheck size={20} aria-hidden="true" /></span>
          <div><strong>{PRODUCT_NAME}</strong><small>{session.business.name}</small></div>
        </div>
        {session.locations.length > 0 && (
          <label className="location-switch">
            <span>Location</span>
            <select value={location?.id ?? ''} onChange={e => { const id = Number(e.target.value); setLocationId(id); storeLocation(id); }} disabled={session.locations.length < 2}>
              {session.locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
        )}
        <nav className="nav" aria-label="Main">
          {visible.map(p => (
            <a key={p.id} href={`#/${p.id}`} aria-current={p.id === active.id ? 'page' : undefined}>
              <p.icon size={18} aria-hidden="true" /> {p.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span>{session.actor.displayName} · {ROLE_LABELS[session.actor.role]}</span>
          <a href="/cdn-cgi/access/logout">Sign out</a>
          <span><CalendarClock size={12} aria-hidden="true" /> {PRODUCT_TAGLINE}</span>
          <span>{NON_AFFILIATION_NOTICE}</span>
        </div>
      </aside>
      <main className="main">
        {location
          ? <Component key={`${active.id}-${location.id}`} api={api} session={session} location={location} reloadSession={loadSession} />
          : <div className="content"><Alert tone="warning">You are not assigned to any active location. Ask the owner to assign you.</Alert></div>}
      </main>
    </div>
  );
}
