import { expect } from 'vitest';
import type { AdminSession, GuardianInput, StudentDetail, StudentInput } from '../shared/types';
import { createRuntime, testAudience, testIssuer, type RuntimeOptions, type TestRuntime } from './runtime';

export const TEST_PEPPER = 'test-pepper-0123456789abcdef0123456789abcdef';

export async function startApp(extra: Partial<RuntimeOptions> = {}) {
  const app = await createRuntime({
    ...extra,
    bindings: {
      APP_ENV: 'production', APP_VERSION: 'test', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience,
      BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', PIN_PEPPER: TEST_PEPPER, ...extra.bindings,
    },
  });
  try {
    const token = await app.signer.token();
    const session = await json<AdminSession>(await app.request('/api/admin/session', { token }));
    const locationId = session.locations[0].id;
    return {
      ...app, token, actor: session.actor, locationId,
      /** Back-office request as the owner (or another token) against a location. */
      admin(path: string, init: { method?: string; body?: unknown; token?: string; location?: number | null } = {}) {
        const location = init.location === undefined ? locationId : init.location;
        return app.request(`/api/admin${path}`, {
          method: init.method, body: init.body, token: init.token ?? token,
          headers: location === null ? {} : { 'x-location-id': String(location) },
        });
      },
    };
  } catch (error) { await app.close(); throw error; }
}
export type App = Awaited<ReturnType<typeof startApp>>;

export async function json<T = Record<string, unknown>>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

export const allowedGuardian: GuardianInput = {
  displayName: 'Approved Guardian', relationship: 'Parent', phone: '555-0101', email: 'guardian@example.test', pickupAuthority: 'allowed', authorityNote: 'Checked photo ID at enrollment',
};

export async function createStudent(app: App, overrides: Partial<StudentInput> = {}, location = app.locationId): Promise<StudentDetail> {
  const { student } = await json<{ student: { id: number } }>(await app.admin('/students', {
    location,
    body: {
      studentCode: `S-${crypto.randomUUID().slice(0, 8)}`, firstName: 'Synthetic', lastName: 'Student', subjects: ['Math', 'Reading'],
      guardians: [
        allowedGuardian,
        { displayName: 'Unverified Contact', relationship: 'Aunt', phone: '555-0102', email: '', pickupAuthority: 'unverified', authorityNote: '' },
        { displayName: 'Restricted Contact', relationship: 'Other', phone: '555-0103', email: '', pickupAuthority: 'denied', authorityNote: 'Court order on file' },
      ],
      ...overrides,
    },
  }), 201);
  return json<StudentDetail>(await app.admin(`/students/${student.id}`, { location }));
}

export function observation(studentId: number, action: 'check_in' | 'check_out' | 'exceptional_departure', extra: Record<string, unknown> = {}) {
  return { eventId: crypto.randomUUID(), studentId, action, observedAt: new Date(Date.now() - 60_000).toISOString(), ...extra };
}

/** Browser-like cookie jar for one enrolled kiosk. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();
  header() { return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; '); }
  async request(app: TestRuntime, path: string, init: Parameters<TestRuntime['request']>[1] = {}) {
    const response = await app.request(path, { ...init, headers: { ...init.headers, cookie: this.header() } });
    for (const value of response.headers.getSetCookie()) {
      const [pair] = value.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index);
      const item = pair.slice(index + 1);
      if (!item || /max-age=0/i.test(value)) this.cookies.delete(key); else this.cookies.set(key, item);
    }
    return response;
  }
}

/** Create a PIN-enabled front-desk staff member and an enrolled, unlocked kiosk at a location. */
export async function unlockedKiosk(app: App, location = app.locationId, pin = '24681357') {
  const { staff } = await json<{ staff: { id: number } }>(await app.admin('/staff', {
    body: { displayName: `Desk ${crypto.randomUUID().slice(0, 4)}`, role: 'front_desk', kioskEnabled: true, pin, locationIds: [location] },
  }), 201);
  const { token } = await json<{ token: string }>(await app.admin('/devices/enrollment', { body: { locationId: location } }), 201);
  const jar = new CookieJar();
  await json(await jar.request(app, '/api/kiosk/enroll', { body: { token, label: 'Front desk iPad' } }), 201);
  await json(await jar.request(app, '/api/kiosk/unlock', { body: { staffId: staff.id, pin } }));
  return { jar, staffId: staff.id, pin };
}
