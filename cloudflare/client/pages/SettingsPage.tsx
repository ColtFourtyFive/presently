import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { DatabaseBackup, KeyRound, MapPin, Plus, Tablet, UserPlus } from 'lucide-react';
import type { BackupStatus, Business, Device, Location, Role, Staff, StaffInput } from '../../shared/types';
import { ROLE_LABELS } from '../../shared/types';
import type { PageProps } from '../App';
import { messageOf, type Api } from '../api';
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Spinner } from '../components';
import { formatDateTime } from '../format';
import './reports.css';

const TIMEZONES = [
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
  'Pacific/Honolulu', 'America/Puerto_Rico', 'America/Detroit', 'America/Indiana/Indianapolis', 'America/Boise',
  'America/Toronto', 'America/Vancouver', 'America/Edmonton', 'America/Winnipeg', 'America/Regina', 'America/Halifax',
  'America/St_Johns', 'America/Moncton', 'America/Whitehorse',
];
const ROLES: Role[] = ['owner', 'manager', 'front_desk', 'instructor'];

const hourLabel = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12}:00 ${hour < 12 ? 'AM' : 'PM'}`;
const formatBytes = (bytes: number | null) => {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

function TimezoneInput({ value, onChange, id }: { value: string; onChange: (value: string) => void; id: string }) {
  return (
    <>
      <input list={id} value={value} onChange={e => onChange(e.target.value)} placeholder="America/New_York" autoComplete="off" required />
      <datalist id={id}>
        {TIMEZONES.map(zone => <option key={zone} value={zone} />)}
      </datalist>
    </>
  );
}

export default function SettingsPage(props: PageProps) {
  const { api, session, reloadSession } = props;
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [locationsError, setLocationsError] = useState('');

  const loadLocations = useCallback(async () => {
    try {
      const value = await api.get<{ items: Location[] }>('/locations');
      setLocations(value.items);
      setLocationsError('');
    } catch (e) {
      setLocationsError(messageOf(e));
    }
  }, [api]);
  useEffect(() => { void loadLocations(); }, [loadLocations]);

  if (session.actor.role !== 'owner') {
    return <div className="content"><Alert tone="warning">Only the owner can change settings.</Alert></div>;
  }
  return (
    <div className="content">
      <PageHeader title="Settings" description="Business details, locations, staff access, kiosks and backups." />
      <BusinessCard api={api} business={session.business} reloadSession={reloadSession} />
      <LocationsCard
        api={api}
        locations={locations}
        error={locationsError}
        onChanged={async () => { await loadLocations(); await reloadSession(); }}
      />
      <StaffCard api={api} locations={locations ?? []} />
      <DevicesCard api={api} locations={locations ?? []} />
      <BackupsCard api={api} />
    </div>
  );
}

/* Business */

function BusinessCard({ api, business, reloadSession }: { api: Api; business: Business; reloadSession: () => Promise<void> }) {
  const [name, setName] = useState(business.name);
  const [timezone, setTimezone] = useState(business.timezone);
  const [backupHour, setBackupHour] = useState(business.backupHour);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.patch('/business', { name: name.trim(), timezone: timezone.trim(), backupHour });
      await reloadSession();
      setMessage({ tone: 'success', text: 'Business settings saved.' });
    } catch (e) {
      setMessage({ tone: 'error', text: messageOf(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Business">
      <form className="stack" onSubmit={save}>
        <div className="grid-2">
          <Field label="Business name">
            <input value={name} onChange={e => setName(e.target.value)} maxLength={150} required />
          </Field>
          <Field label="Business time zone" hint="Used to schedule the nightly backup. Each location has its own time zone for attendance.">
            <TimezoneInput id="business-timezones" value={timezone} onChange={setTimezone} />
          </Field>
          <Field label="Nightly backup time" hint="Pick an hour when the center is closed; the database is briefly busy during a backup.">
            <select value={backupHour} onChange={e => setBackupHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
            </select>
          </Field>
        </div>
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        <div className="row">
          <Button type="submit" variant="primary" busy={busy}>Save business settings</Button>
        </div>
      </form>
    </Card>
  );
}

/* Locations */

type LocationDraft = { id: number | null; name: string; timezone: string; address: string; operatingHours: string; active: boolean };

function LocationsCard({ api, locations, error, onChanged }: {
  api: Api; locations: Location[] | null; error: string; onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<LocationDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true);
    setFormError('');
    const payload = {
      name: draft.name.trim(), timezone: draft.timezone.trim(), address: draft.address.trim(),
      operatingHours: draft.operatingHours.trim(), active: draft.active,
    };
    try {
      if (draft.id === null) await api.post('/locations', payload);
      else await api.patch(`/locations/${draft.id}`, payload);
      await onChanged();
      setDraft(null);
    } catch (e) {
      setFormError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card
      title="Locations"
      actions={
        <Button onClick={() => { setFormError(''); setDraft({ id: null, name: '', timezone: 'America/New_York', address: '', operatingHours: '', active: true }); }}>
          <Plus size={18} aria-hidden="true" /> Add location
        </Button>
      }
    >
      <Alert>{error}</Alert>
      {!locations && !error && <Spinner />}
      {locations && locations.length === 0 && <EmptyState icon={MapPin} title="No locations yet" />}
      {locations && locations.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Time zone</th>
                <th scope="col">Address</th>
                <th scope="col">Hours</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {locations.map(l => (
                <tr key={l.id}>
                  <td><strong>{l.name}</strong></td>
                  <td>{l.timezone}</td>
                  <td>{l.address || '—'}</td>
                  <td className="small">{l.operatingHours || '—'}</td>
                  <td>{l.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td>
                    <Button variant="ghost" aria-label={`Edit ${l.name}`} onClick={() => { setFormError(''); setDraft({ ...l }); }}>Edit</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {draft && (
        <Modal title={draft.id === null ? 'Add location' : `Edit ${draft.name || 'location'}`} onClose={() => setDraft(null)}>
          <form className="stack" onSubmit={save}>
            <Field label="Name">
              <input value={draft.name} maxLength={150} required onChange={e => setDraft({ ...draft, name: e.target.value })} />
            </Field>
            <Field label="Time zone" hint="All attendance times for this location are recorded and shown in this time zone (IANA name).">
              <TimezoneInput id="location-timezones" value={draft.timezone} onChange={timezone => setDraft({ ...draft, timezone })} />
            </Field>
            <Field label="Address (optional)">
              <input value={draft.address} maxLength={300} onChange={e => setDraft({ ...draft, address: e.target.value })} />
            </Field>
            <Field label="Operating hours (optional)" hint="For example: Mon & Thu 3–7 PM, Sat 9 AM–12 PM">
              <textarea rows={2} maxLength={500} value={draft.operatingHours} onChange={e => setDraft({ ...draft, operatingHours: e.target.value })} />
            </Field>
            {draft.id !== null && (
              <label className="checkbox">
                <input type="checkbox" checked={draft.active} onChange={e => setDraft({ ...draft, active: e.target.checked })} />
                <span>Active (uncheck to deactivate; records are kept)</span>
              </label>
            )}
            <Alert>{formError}</Alert>
            <div className="row">
              <Button type="submit" variant="primary" busy={busy}>{draft.id === null ? 'Add location' : 'Save location'}</Button>
              <Button variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </form>
        </Modal>
      )}
    </Card>
  );
}

/* Staff */

type StaffDraft = {
  id: number | null; displayName: string; email: string; role: Role; locationIds: number[];
  kioskEnabled: boolean; hasPin: boolean; pin: string; active: boolean;
};

function StaffCard({ api, locations }: { api: Api; locations: Location[] }) {
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState<StaffDraft | null>(null);

  const load = useCallback(async () => {
    try {
      const value = await api.get<{ items: Staff[] }>('/staff');
      setStaff(value.items);
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const locationName = (id: number) => locations.find(l => l.id === id)?.name ?? `Location ${id}`;
  const newDraft = (): StaffDraft => ({
    id: null, displayName: '', email: '', role: 'front_desk', locationIds: locations.length === 1 ? [locations[0].id] : [],
    kioskEnabled: true, hasPin: false, pin: '', active: true,
  });

  return (
    <Card title="Staff" actions={<Button onClick={() => setDraft(newDraft())}><UserPlus size={18} aria-hidden="true" /> Add staff</Button>}>
      <Alert>{error}</Alert>
      {!staff && !error && <Spinner />}
      {staff && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Email</th>
                <th scope="col">Role</th>
                <th scope="col">Locations</th>
                <th scope="col">Kiosk PIN</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {staff.map(s => (
                <tr key={s.id}>
                  <td><strong>{s.displayName}</strong></td>
                  <td>{s.email ?? <span className="muted">PIN only</span>}</td>
                  <td>{ROLE_LABELS[s.role]}</td>
                  <td className="small">
                    {s.role === 'owner' ? 'All locations' : s.locationIds.length ? s.locationIds.map(locationName).join(', ') : <span className="muted">None</span>}
                  </td>
                  <td>
                    {s.kioskEnabled
                      ? (s.hasPin ? <Badge tone="green">Enabled</Badge> : <Badge tone="amber">PIN missing</Badge>)
                      : <Badge>Off</Badge>}
                  </td>
                  <td>{s.active ? <Badge tone="green">Active</Badge> : <Badge>Inactive</Badge>}</td>
                  <td>
                    <Button
                      variant="ghost"
                      aria-label={`Edit ${s.displayName}`}
                      onClick={() => setDraft({
                        id: s.id, displayName: s.displayName, email: s.email ?? '', role: s.role, locationIds: s.locationIds,
                        kioskEnabled: s.kioskEnabled, hasPin: s.hasPin, pin: '', active: s.active,
                      })}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {draft && (
        <StaffModal
          api={api}
          draft={draft}
          locations={locations}
          onClose={() => setDraft(null)}
          onSaved={async () => { setDraft(null); await load(); }}
        />
      )}
    </Card>
  );
}

function StaffModal({ api, draft: initial, locations, onClose, onSaved }: {
  api: Api; draft: StaffDraft; locations: Location[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<StaffDraft>) => setDraft(current => ({ ...current, ...patch }));
  const isOwner = draft.role === 'owner';
  const kioskAllowed = draft.role !== 'instructor';
  const pinInvalid = draft.pin !== '' && !/^\d{8,12}$/.test(draft.pin);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (pinInvalid) {
      setError('The PIN must be 8 to 12 digits.');
      return;
    }
    setBusy(true);
    setError('');
    const input: StaffInput = {
      displayName: draft.displayName.trim(),
      email: draft.email.trim() || null,
      role: draft.role,
      active: draft.active,
      kioskEnabled: kioskAllowed && draft.kioskEnabled,
      ...(draft.pin ? { pin: draft.pin } : {}),
      ...(isOwner ? {} : { locationIds: draft.locationIds }),
    };
    try {
      if (draft.id === null) await api.post('/staff', input);
      else await api.patch(`/staff/${draft.id}`, input);
      await onSaved();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={draft.id === null ? 'Add staff member' : `Edit ${initial.displayName}`} onClose={onClose} wide>
      <form className="stack" onSubmit={save}>
        <div className="grid-2">
          <Field label="Name">
            <input value={draft.displayName} maxLength={150} required onChange={e => set({ displayName: e.target.value })} />
          </Field>
          <Field label="Role">
            <select value={draft.role} onChange={e => set({ role: e.target.value as Role })}>
              {ROLES.map(role => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}
            </select>
          </Field>
        </div>
        <Field
          label={isOwner ? 'Email' : 'Email (optional)'}
          hint={
            <>
              Needed to sign in to the back office (required for owners). Sign-in happens through Cloudflare Access, so this email must
              also be allowed in your Access policy. Leave blank for kiosk-only staff who use a PIN.
            </>
          }
        >
          <input type="email" value={draft.email} maxLength={200} autoComplete="off" required={isOwner} onChange={e => set({ email: e.target.value })} />
        </Field>
        {isOwner
          ? <p className="muted small">Owners have access to all locations.</p>
          : (
            <fieldset>
              <legend>Locations</legend>
              {locations.length === 0 && <p className="muted">Add a location first.</p>}
              <div className="location-checks">
                {locations.map(l => (
                  <label key={l.id} className="checkbox">
                    <input
                      type="checkbox"
                      checked={draft.locationIds.includes(l.id)}
                      onChange={e => set({
                        locationIds: e.target.checked ? [...draft.locationIds, l.id] : draft.locationIds.filter(id => id !== l.id),
                      })}
                    />
                    <span>{l.name}{l.active ? '' : ' (inactive)'}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
        {kioskAllowed
          ? (
            <div className="grid-2">
              <label className="checkbox">
                <input type="checkbox" checked={draft.kioskEnabled} onChange={e => set({ kioskEnabled: e.target.checked })} />
                <span>Can operate the front-desk kiosk with a personal PIN</span>
              </label>
              <Field
                label={draft.hasPin ? 'New kiosk PIN' : 'Kiosk PIN'}
                hint={draft.hasPin ? '8–12 digits. Leave blank to keep the current PIN.' : '8–12 digits, unique to this person.'}
              >
                <input
                  type="password"
                  inputMode="numeric"
                  pattern="\d{8,12}"
                  autoComplete="new-password"
                  maxLength={12}
                  value={draft.pin}
                  aria-invalid={pinInvalid || undefined}
                  onChange={e => set({ pin: e.target.value.replace(/\D/g, '') })}
                />
              </Field>
            </div>
          )
          : <p className="muted small">Instructors see the roster only and cannot operate the kiosk.</p>}
        <label className="checkbox">
          <input type="checkbox" checked={draft.active} onChange={e => set({ active: e.target.checked })} />
          <span>Active (inactive staff cannot sign in or use the kiosk)</span>
        </label>
        {draft.id !== null && <p className="muted small">Saving signs this person out of any open kiosk session.</p>}
        <Alert>{error}</Alert>
        <div className="row">
          <Button type="submit" variant="primary" busy={busy}>{draft.id === null ? 'Add staff member' : 'Save changes'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}

/* Kiosk devices */

function DevicesCard({ api, locations }: { api: Api; locations: Location[] }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [error, setError] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [revoking, setRevoking] = useState<Device | null>(null);

  const load = useCallback(async () => {
    try {
      const value = await api.get<{ items: Device[] }>('/devices');
      setDevices(value.items);
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  const locationOf = (id: number) => locations.find(l => l.id === id);
  const now = Date.now();

  return (
    <Card title="Kiosk devices" actions={<Button onClick={() => setEnrolling(true)}><Tablet size={18} aria-hidden="true" /> Enroll a kiosk</Button>}>
      <Alert>{error}</Alert>
      {!devices && !error && <Spinner />}
      {devices && devices.length === 0 && (
        <EmptyState icon={Tablet} title="No kiosks enrolled">
          <p>Enroll the front-desk iPad so staff can check students in and out with their PIN.</p>
        </EmptyState>
      )}
      {devices && devices.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Location</th>
                <th scope="col">Enrolled</th>
                <th scope="col">Expires</th>
                <th scope="col">Status</th>
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {devices.map(d => {
                const loc = locationOf(d.locationId);
                const tz = loc?.timezone ?? 'UTC';
                const expired = Date.parse(d.expiresAt) <= now;
                return (
                  <tr key={d.id}>
                    <td><strong>{d.label}</strong></td>
                    <td>{loc?.name ?? `Location ${d.locationId}`}</td>
                    <td>{formatDateTime(d.createdAt, tz)}</td>
                    <td>{formatDateTime(d.expiresAt, tz)}</td>
                    <td>
                      {d.revokedAt
                        ? <Badge tone="red">Revoked</Badge>
                        : expired ? <Badge>Expired</Badge> : <Badge tone="green">Active</Badge>}
                    </td>
                    <td>
                      {!d.revokedAt && !expired && (
                        <Button variant="ghost" aria-label={`Revoke ${d.label}`} onClick={() => setRevoking(d)}>Revoke</Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {enrolling && <EnrollModal api={api} locations={locations} onClose={() => { setEnrolling(false); void load(); }} />}
      {revoking && <RevokeModal api={api} device={revoking} onClose={() => setRevoking(null)} onRevoked={async () => { setRevoking(null); await load(); }} />}
    </Card>
  );
}

function RevokeModal({ api, device, onClose, onRevoked }: { api: Api; device: Device; onClose: () => void; onRevoked: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function revoke() {
    setBusy(true);
    setError('');
    try {
      await api.post(`/devices/${device.id}/revoke`, {});
      await onRevoked();
    } catch (e) {
      setError(messageOf(e));
      setBusy(false);
    }
  }
  return (
    <Modal title={`Revoke ${device.label}?`} onClose={onClose}>
      <p>The kiosk is signed out immediately and cannot record attendance until it is enrolled again. Records it already made are kept.</p>
      <Alert>{error}</Alert>
      <div className="row">
        <Button variant="danger" busy={busy} onClick={() => void revoke()}>Revoke kiosk</Button>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
      </div>
    </Modal>
  );
}

function EnrollModal({ api, locations, onClose }: { api: Api; locations: Location[]; onClose: () => void }) {
  const active = locations.filter(l => l.active);
  const [locationId, setLocationId] = useState<number | ''>(active.length === 1 ? active[0].id : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ token: string; expiresAt: string } | null>(null);
  const kioskUrl = `${window.location.origin}/kiosk`;
  const chosen = active.find(l => l.id === locationId);

  async function enroll(event: FormEvent) {
    event.preventDefault();
    if (!locationId) return;
    setBusy(true);
    setError('');
    try {
      setResult(await api.post<{ token: string; expiresAt: string }>('/devices/enrollment', { locationId }));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Enroll a kiosk" onClose={onClose}>
      {!result
        ? (
          <form className="stack" onSubmit={enroll}>
            <Field label="Location" hint="The kiosk can only record attendance for this location.">
              <select value={locationId} required onChange={e => setLocationId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Choose a location</option>
                {active.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </Field>
            <Alert>{error}</Alert>
            <div className="row">
              <Button type="submit" variant="primary" busy={busy} disabled={!locationId}>Create enrollment code</Button>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </form>
        )
        : (
          <div className="stack">
            <p>Enrollment code for <strong>{chosen?.name}</strong>:</p>
            <div className="enroll-code" aria-label="Enrollment code">{result.token}</div>
            <ol className="stack" style={{ gap: 6, paddingLeft: 20, margin: 0 }}>
              <li>On the front-desk iPad, open <strong>{kioskUrl}</strong> in Safari.</li>
              <li>Enter this code before {formatDateTime(result.expiresAt, chosen?.timezone ?? 'UTC')} (within 10 minutes).</li>
              <li>Add the page to the Home Screen and use Guided Access to keep it on the kiosk.</li>
            </ol>
            <Alert tone="info">The code works once and is not shown again. Close this window when the iPad shows the staff PIN screen.</Alert>
            <div className="row"><Button variant="primary" onClick={onClose}>Done</Button></div>
          </div>
        )}
    </Modal>
  );
}

/* Backups */

const JOB_TONES: Record<string, 'green' | 'red' | 'blue'> = { complete: 'green', failed: 'red' };
const JOB_LABELS: Record<string, string> = {
  export: 'Exporting', parts: 'Encrypting and uploading', manifest: 'Finishing', complete: 'Complete', failed: 'Failed',
};

function BackupsCard({ api }: { api: Api }) {
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.get<BackupStatus>('/backups'));
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }, [api]);
  useEffect(() => { void load(); }, [load]);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/backups/start', {});
      setMessage({ tone: 'success', text: 'Backup started. It runs in the background and usually finishes within a few minutes.' });
      await load();
    } catch (e) {
      setMessage({ tone: 'error', text: messageOf(e) });
    } finally {
      setBusy(false);
    }
  }

  const running = status?.jobs.some(job => job.status !== 'complete' && job.status !== 'failed');
  return (
    <Card
      title="Backups"
      actions={
        <>
          <Button variant="ghost" onClick={() => void load()}>Refresh</Button>
          <Button variant="primary" busy={busy} disabled={!status?.configured} onClick={() => void start()}>
            <DatabaseBackup size={18} aria-hidden="true" /> Back up now
          </Button>
        </>
      }
    >
      <Alert>{error}</Alert>
      {!status && !error && <Spinner />}
      {status && (
        <>
          <dl className="facts">
            <dt>Nightly backups</dt>
            <dd>{status.enabled ? <Badge tone="green">Enabled</Badge> : <Badge tone="amber">Not enabled</Badge>}</dd>
            <dt>Configuration</dt>
            <dd>{status.configured ? <Badge tone="green">Complete</Badge> : <Badge tone="red">Incomplete</Badge>}</dd>
            <dt>Schedule</dt>
            <dd>Every night at {hourLabel(status.backupHour)} ({status.timezone})</dd>
            <dt>Last completed backup</dt>
            <dd>{status.lastCompletedAt ? formatDateTime(status.lastCompletedAt, status.timezone) : 'None yet'}</dd>
          </dl>
          {!status.configured && (
            <Alert tone="error">
              Backups cannot run until these settings are added to the Worker: {status.missing.join(', ')}.
            </Alert>
          )}
          {status.configured && !status.enabled && (
            <Alert tone="warning">Nightly backups are turned off. Set BACKUP_ENABLED to “true” in the Worker settings to schedule them.</Alert>
          )}
          {status.stale && (
            <Alert tone="warning">No backup has completed in the last 26 hours. Check the jobs below or run a backup now.</Alert>
          )}
          {running && <Alert tone="info">A backup is in progress. Refresh to see its progress.</Alert>}
          {message && <Alert tone={message.tone}>{message.text}</Alert>}
          {status.jobs.length > 0 && (
            <div className="table-wrap">
              <table>
                <caption className="visually-hidden">Recent backup jobs</caption>
                <thead>
                  <tr>
                    <th scope="col">Started</th>
                    <th scope="col">Reason</th>
                    <th scope="col">Status</th>
                    <th scope="col">Size</th>
                    <th scope="col">Parts</th>
                    <th scope="col">Error</th>
                  </tr>
                </thead>
                <tbody>
                  {status.jobs.map(job => (
                    <tr key={job.id}>
                      <td>{formatDateTime(job.createdAt, status.timezone)}</td>
                      <td>{job.reason === 'manual' ? 'Manual' : 'Scheduled'}</td>
                      <td><Badge tone={JOB_TONES[job.status] ?? 'blue'}>{JOB_LABELS[job.status] ?? job.status}</Badge></td>
                      <td>{formatBytes(job.sqlBytes)}</td>
                      <td>{job.parts}</td>
                      <td className="small">{job.errorCode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small">
            <KeyRound size={14} aria-hidden="true" style={{ verticalAlign: '-2px' }} /> Backups are encrypted and stored in your private
            storage bucket. Restoring requires the recovery key and follows the documented recovery procedure in docs/operations.md.
            Keep the recovery key somewhere safe outside this system.
          </p>
        </>
      )}
    </Card>
  );
}
