/**
 * Local capacity projection against the Workers Free plan.
 *
 *   npm run measure -- [--students 200] [--kiosks 1] [--hours 5]
 *
 * Runs one simulated center day in the local workerd/D1 runtime and reports
 * D1 rows read and written per operation and per day. This is a projection:
 * deployed CPU time must still be measured on a real account (docs/deployed-proof.md).
 */
import { createRuntime, testAudience, testIssuer } from '../tests/runtime';

const FREE = { rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, requestsPerDay: 100_000 };
const arg = (name: string, fallback: number) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
};
const students = arg('students', 200);
const kiosks = arg('kiosks', 1);
const hours = arg('hours', 5);
const attendanceShare = 0.4; // Share of the roster attending on a given day.

type Metrics = { rowsRead: number; rowsWritten: number; queries: number };
const totals = new Map<string, { count: number; read: number; written: number }>();
function track(name: string, response: { headers: { get(name: string): string | null } }) {
  const metrics = JSON.parse(response.headers.get('x-test-d1-metrics') || '{"rowsRead":0,"rowsWritten":0}') as Metrics;
  const entry = totals.get(name) ?? { count: 0, read: 0, written: 0 };
  entry.count++; entry.read += metrics.rowsRead; entry.written += metrics.rowsWritten;
  totals.set(name, entry);
}

const app = await createRuntime({
  bindings: { APP_ENV: 'production', APP_VERSION: 'measure', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', PIN_PEPPER: 'measure-pepper-0123456789abcdef0123456789' },
});
try {
  const token = await app.signer.token();
  const session = await (await app.request('/api/admin/session', { token })).json() as { locations: { id: number }[] };
  const location = String(session.locations[0].id);
  const admin = (path: string, body?: unknown) => app.request(`/api/admin${path}`, { token, body, headers: { 'x-location-id': location } });

  // Seed the roster directly; seeding is not part of the daily workload.
  const now = new Date().toISOString();
  await app.db.batch(Array.from({ length: students }, (_, i) => app.db.prepare(
    "INSERT INTO students (location_id, student_code, first_name, last_name, subjects, created_at, updated_at) VALUES (?, ?, 'Student', ?, '[\"Math\"]', ?, ?)",
  ).bind(Number(location), `K${i}`, `N${i}`, now, now)));
  await app.db.batch([
    app.db.prepare("INSERT INTO guardians (display_name, created_at) VALUES ('Parent', ?)").bind(now),
    app.db.prepare("INSERT INTO student_guardians (student_id, guardian_id, pickup_authority, authority_note) SELECT id, (SELECT max(id) FROM guardians), 'allowed', 'Verified ID' FROM students"),
  ]);
  const guardian = (await app.db.prepare('SELECT max(id) AS id FROM guardians').first<{ id: number }>())!.id;
  const ids = (await app.db.prepare('SELECT id FROM students').all<{ id: number }>()).results.map(r => r.id);
  const attending = ids.slice(0, Math.round(students * attendanceShare));

  let revision = 0;
  const poll = async () => {
    const response = await admin(`/roster${revision ? `?revision=${revision}` : ''}`);
    const body = await response.clone().json() as { revision: number; unchanged?: boolean };
    track(body.unchanged ? 'roster poll, unchanged' : 'roster poll, changed', response);
    revision = body.revision;
  };
  for (const id of attending) {
    track('search student', await admin(`/students?q=N${id}&pageSize=20`));
    track('open student', await admin(`/students/${id}?pageSize=5`));
    track('check in', await admin('/attendance', { eventId: crypto.randomUUID(), studentId: id, action: 'check_in', observedAt: new Date(Date.now() - 120000).toISOString() }));
    await poll();
  }
  for (const id of attending) {
    track('open student', await admin(`/students/${id}?pageSize=5`));
    track('check out', await admin('/attendance', { eventId: crypto.randomUUID(), studentId: id, action: 'check_out', guardianId: guardian, observedAt: new Date(Date.now() - 60000).toISOString() }));
    await poll();
  }
  for (let i = 0; i < 20; i++) await poll(); // Unchanged polls.
  track('history page', await admin('/history'));
  track('evidence report', await admin(`/evidence?year=${new Date().getUTCFullYear()}`));

  // Every 10 s on each kiosk plus one back-office screen. Each check-in or check-out makes one poll per screen see a change.
  const screens = kiosks + 1;
  const changedPolls = attending.length * 2 * screens;
  const polls = { 'roster poll, changed': changedPolls, 'roster poll, unchanged': Math.max(0, (hours * 3600) / 10 * screens - changedPolls) };
  const rows: [string, number, number, number][] = [];
  let dayRead = 0;
  let dayWritten = 0;
  let requests = 0;
  for (const [name, entry] of totals) {
    const daily = name in polls ? polls[name as keyof typeof polls] : entry.count;
    const read = (entry.read / entry.count) * daily;
    const written = (entry.written / entry.count) * daily;
    rows.push([name, daily, entry.read / entry.count, entry.written / entry.count]);
    dayRead += read; dayWritten += written; requests += daily;
  }
  console.log(`Simulated day: ${students} students, ${attending.length} visits, ${kiosks} kiosk(s) + 1 back-office screen open ${hours} h.\n`);
  console.log('Operation                               per day   rows read/op   rows written/op');
  for (const [name, daily, read, written] of rows) console.log(`${name.padEnd(38)} ${String(Math.round(daily)).padStart(8)} ${read.toFixed(1).padStart(14)} ${written.toFixed(1).padStart(17)}`);
  const pct = (value: number, limit: number) => `${((value / limit) * 100).toFixed(1)}% of Free`;
  console.log(`\nPer day: ${Math.round(dayRead).toLocaleString()} rows read (${pct(dayRead, FREE.rowsReadPerDay)}), ` +
    `${Math.round(dayWritten).toLocaleString()} rows written (${pct(dayWritten, FREE.rowsWrittenPerDay)}), ` +
    `${Math.round(requests).toLocaleString()} requests (${pct(requests, FREE.requestsPerDay)}).`);
  console.log('Row counts include index updates as D1 reports them locally. Deployed CPU time is measured separately.');
} finally {
  await app.close();
}
