import { expect } from 'vitest';
import type { AdminSession, StudentDetail, StudentInput } from '../shared/types.js';
import { createRuntime, testAudience, testIssuer, type RuntimeOptions, type TestRuntime } from './runtime.js';

export async function startApp(extra: Partial<RuntimeOptions> = {}) {
  const app = await createRuntime({ ...extra, bindings: {
    APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'isolated-test',
    ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
    ...extra.bindings,
  } });
  try {
    const token = await app.signer.token();
    const session = await json<AdminSession>(await app.request('/api/admin/session', { token }));
    return { ...app, token, actor: session.actor };
  } catch (error) { await app.close(); throw error; }
}
export type App = Awaited<ReturnType<typeof startApp>>;

export async function json<T = Record<string, unknown>>(response: Response | Awaited<ReturnType<TestRuntime['request']>>, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

export async function createStudent(app: App, overrides: Partial<StudentInput> = {}): Promise<StudentDetail> {
  const response = await app.request('/api/admin/students', { token: app.token, body: {
    studentCode: `T-${crypto.randomUUID()}`, firstName: 'Synthetic', lastName: 'Student', subjects: ['Math', 'Reading'],
    guardians: [
      { displayName: 'Approved Guardian', relationship: 'Parent', phone: '555-0101', email: 'guardian@example.test', pickupAuthority: 'allowed', authorityNote: 'Synthetic test verification' },
      { displayName: 'Unverified Contact', relationship: 'Contact', phone: '555-0102', email: '', pickupAuthority: 'unverified', authorityNote: '' },
      { displayName: 'Restricted Contact', relationship: 'Contact', phone: '555-0103', email: '', pickupAuthority: 'denied', authorityNote: 'Synthetic restriction' },
    ], ...overrides,
  } });
  const { student } = await json<{ student: { id: string } }>(response, 201);
  return json<StudentDetail>(await app.request(`/api/admin/students/${student.id}`, { token: app.token }));
}

export function observation(studentId: string, action: 'check_in' | 'check_out' | 'exceptional_departure', extra: Record<string, unknown> = {}) {
  return { eventId: crypto.randomUUID(), studentId, action, observedAt: new Date(Date.now() - 60_000).toISOString(), ...extra };
}

export async function seedHistoricalVisit(app: App, detail: StudentDetail, arrived: string, departed: string) {
  const visitId = crypto.randomUUID();
  const arrivalId = crypto.randomUUID();
  const departureId = crypto.randomUUID();
  const sql = 'INSERT INTO attendance_events(id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,guardian_id,payload_hash,insertion_nonce) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)';
  await app.db.batch([
    app.db.prepare(sql).bind(arrivalId, 'test-center', detail.student.id, visitId, 'check_in', arrived, arrived, app.actor.id, app.actor.displayName, 'admin', null, arrivalId, arrivalId),
    app.db.prepare(sql).bind(departureId, 'test-center', detail.student.id, visitId, 'check_out', departed, departed, app.actor.id, app.actor.displayName, 'admin', detail.guardians.find(g => g.pickupAuthority === 'allowed')!.id, departureId, departureId),
  ]);
  return { visitId, arrivalId, departureId };
}

/** Browser-like cookie jar for a single synthetic enrolled kiosk. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();
  header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  async request(app: TestRuntime, path: string, init: Parameters<TestRuntime['request']>[1] = {}) {
    const response = await app.request(path, { ...init, headers: { ...init.headers, cookie: this.header() } });
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index), item = pair.slice(index + 1);
      if (!item || /max-age=0/i.test(value)) this.cookies.delete(key); else this.cookies.set(key, item);
    }
    return response;
  }
}
