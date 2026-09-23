import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime, createSigner, testAudience, testIssuer, type TestRuntime } from './runtime.js';

describe('Cloudflare Access validation in the actual Worker runtime', () => {
  let app: TestRuntime;
  beforeAll(async () => {
    app = await createRuntime({ bindings: {
      APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'isolated-test',
      ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
    } });
  });
  afterAll(async () => app?.close());

  it('rejects missing assertions and plain identity headers on the direct API', async () => {
    for (const headers of [{}, { 'Cf-Access-Authenticated-User-Email': 'owner@example.test' }] as Record<string, string>[]) {
      const response = await app.request('/api/admin/session', { headers });
      expect(response.status).toBe(401);
    }
  });

  it('accepts a correctly signed permitted identity through the remote JWKS path', async () => {
    const response = await app.request('/api/admin/session', { token: await app.signer.token() });
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('owner@example.test');
  });

  it.each([
    ['wrong audience', { aud: 'a-different-application' }],
    ['wrong issuer', { iss: 'https://other-team.cloudflareaccess.com' }],
    ['expired token', { exp: 1 }],
    ['not-yet-valid token', { nbf: Math.floor(Date.now() / 1000) + 3600 }],
  ])('rejects %s', async (_name, payload) => {
    const response = await app.request('/api/admin/session', { token: await app.signer.token(payload) });
    expect(response.status).toBe(401);
  });

  it('rejects a token signed with an unrelated private key', async () => {
    const other = await createSigner();
    const token = await other.token({}, { kid: app.signer.jwk.kid });
    expect((await app.request('/api/admin/session', { token })).status).toBe(401);
  });

  it('rejects an unsigned token and a changed signed payload', async () => {
    const token = await app.signer.token();
    const [header, payload, signature] = token.split('.');
    const unsigned = `${Buffer.from(JSON.stringify({ alg: 'none', kid: app.signer.jwk.kid })).toString('base64url')}.${payload}.`;
    const changed = `${header}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), email: 'attacker@example.test' })).toString('base64url')}.${signature}`;
    for (const invalid of [unsigned, changed]) expect((await app.request('/api/admin/session', { token: invalid })).status).toBe(401);
  });

  it('does not provision arbitrary identities that passed Access signature verification', async () => {
    const response = await app.request('/api/admin/session', { token: await app.signer.token({ email: 'unlisted@example.test', sub: 'unlisted' }) });
    expect(response.status).toBe(403);
  });
});
