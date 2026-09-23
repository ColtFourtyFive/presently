import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { createFetchMock, Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const testIssuer = 'https://isolated-test.cloudflareaccess.com';
export const testAudience = 'isolated-test-application';

export async function createSigner() {
  const keys = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...await exportJWK(keys.publicKey), kid: crypto.randomUUID(), alg: 'RS256', use: 'sig' };
  return {
    jwk,
    async token(payload: JWTPayload = {}, headers: Record<string, string> = {}) {
      return new SignJWT({ email: 'owner@example.test', type: 'app', ...payload })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, ...headers })
        .setIssuer(payload.iss ?? testIssuer)
        .setAudience(payload.aud ?? testAudience)
        .setSubject(payload.sub ?? 'test-owner')
        .setIssuedAt(payload.iat ?? Math.floor(Date.now() / 1000))
        .setExpirationTime(payload.exp ?? Math.floor(Date.now() / 1000) + 3600)
        .sign(keys.privateKey);
    },
  };
}

export type RuntimeOptions = {
  bindings: Record<string, string>;
  signer?: Awaited<ReturnType<typeof createSigner>>;
  metrics?: boolean;
  migrate?: boolean;
  r2?: boolean;
  receiptRace?: { requestId: string; observationClock?: string };
};

/** Actual workerd/D1 runtime, temporary storage, no production credentials or network. */
export async function createRuntime(options: RuntimeOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'kumon-cloudflare-test-'));
  const signer = options.signer ?? await createSigner();
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get(testIssuer).intercept({ path: '/cdn-cgi/access/certs' })
    .reply(200, { keys: [signer.jwk] }, { headers: { 'content-type': 'application/json' } }).persist();
  const entry = join(projectRoot, 'worker/index.ts');
  const controlKey = crypto.randomUUID();
  const result = await build({
    stdin: { contents: instrumentedWorker(entry, controlKey, options.metrics ?? false, options.receiptRace), resolveDir: projectRoot, sourcefile: 'isolated-test-worker.ts', loader: 'ts' as const },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  });
  const runtime = new Miniflare({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: '2026-06-11',
    d1Databases: { CRM_DB: 'isolated-test-database' },
    d1Persist: join(directory, 'd1'),
    ...(options.r2 ? { r2Buckets: { BACKUP_BUCKET: 'isolated-test-backups' }, r2Persist: join(directory, 'r2') } : {}),
    bindings: options.bindings,
    fetchMock,
  });
  try {
    await runtime.ready;
    const query = async (body: unknown) => {
      const response = await runtime.dispatchFetch('http://localhost/__isolated/sql', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-isolated-key': controlKey }, body: JSON.stringify(body),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Isolated D1 query failed');
      return result;
    };
    const db = new IsolatedDatabase(query);
    if (options.migrate !== false) {
      const migrations = (await readdir(join(projectRoot, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
      for (const name of migrations) {
        const statements = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
        await db.batch(statements.map(sql => db.prepare(sql)));
      }
    }
    return {
      runtime, db, signer, directory, fetchMock,
      async request(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
        const headers = new Headers(init.headers);
        if (init.token) headers.set('Cf-Access-Jwt-Assertion', init.token);
        if (init.body !== undefined) headers.set('content-type', 'application/json');
        return runtime.dispatchFetch(`https://crm.example.test${path}`, {
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
          headers: Object.fromEntries(headers.entries()),
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
      },
      async close() {
        await runtime.dispose();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await runtime.dispose();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export type TestRuntime = Awaited<ReturnType<typeof createRuntime>>;

/** Instrumentation exists only in the benchmark bundle, never in the product worker. */
function instrumentedWorker(entry: string, controlKey: string, enableMetrics: boolean, receiptRace?: RuntimeOptions['receiptRace']) {
  return `import worker from ${JSON.stringify(entry)};
function measuredDatabase(database, metrics) {
  const original = new WeakMap();
  function record(result) {
    for (const item of Array.isArray(result) ? result : [result]) {
      if (item?.meta) { metrics.rowsRead += item.meta.rows_read ?? 0; metrics.rowsWritten += item.meta.rows_written ?? 0; metrics.statements++; }
    }
    return result;
  }
  function statement(target) {
    const proxy = new Proxy(target, {get(target, key) {
      if (key === 'bind') return (...values) => statement(target.bind(...values));
      if (key === 'all' || key === 'run' || key === 'raw') return async (...args) => {
        if (key === 'raw') { metrics.unmeasuredCalls++; return target.raw(...args); }
        return record(await target[key](...args));
      };
      // D1 first() omits metadata. Execute the same SQL once through all() so the
      // benchmark can count its database work; preserve first-row/column behavior.
      if (key === 'first') return async (column) => {
        const result = record(await target.all());
        const row = result.results?.[0];
        if (!row) return null;
        if (column === undefined) return row;
        if (!(column in row)) throw new Error('D1 column not found: ' + column);
        return row[column];
      };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    original.set(proxy, target);
    return proxy;
  }
  return new Proxy(database, {get(target, key) {
    if (key === 'prepare') return sql => statement(target.prepare(sql));
    if (key === 'batch') return async statements => record(await target.batch(statements.map(s => original.get(s) ?? s)));
    if (key === 'withSession') return (...args) => measuredDatabase(target.withSession(...args), metrics);
    if (key === 'exec') return async (...args) => { metrics.unmeasuredCalls++; return target.exec(...args); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
// Test-only visibility seam simulates an earlier unused-ID snapshot. Later
// reads and insertion attempts run on real isolated D1. Old event fixtures
// shift only the post-lookup observation-age clock after authentication.
function receiptRaceDatabase(database, state, race) {
  const original = new WeakMap(), details = new WeakMap();
  function statement(target, sql, args = []) {
    const proxy = new Proxy(target, {get(target, key) {
      if (key === 'bind') return (...values) => statement(target.bind(...values), sql, values);
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    original.set(proxy, target); details.set(proxy, {sql, args}); return proxy;
  }
  return new Proxy(database, {get(target, key) {
    if (key === 'prepare') return sql => statement(target.prepare(sql), sql);
    if (key === 'batch') return async statements => {
      const first = details.get(statements[0]);
      const lookup = first?.sql === 'SELECT * FROM history_request_keys WHERE request_id=?' && first.args[0] === race.requestId;
      const mutation = first?.sql.startsWith('INSERT INTO attendance_events') || first?.sql.startsWith('INSERT INTO attendance_corrections');
      if (mutation) state.insertBatches++;
      let result;
      try { result = await target.batch(statements.map(item => original.get(item) ?? item)); }
      catch (error) { if (mutation) state.insertErrors++; throw error; }
      if (lookup && state.hiddenSnapshots === 0) {
        state.hiddenSnapshots++;
        if (race.observationClock) { Date.now = () => Date.parse(race.observationClock); state.observationClockShifted = true; }
        return result.map((row, index) => index === 3 ? row : {...row, results: []});
      }
      if (lookup) state.nativeReplaySnapshots++;
      if (mutation && result[0].results.length === 0 && result[1].results.length === 0) state.missingRowBatches++;
      return result;
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
export default {async fetch(request, env, ctx) {
  if (new URL(request.url).pathname === '/__isolated/sql' && request.headers.get('x-isolated-key') === ${JSON.stringify(controlKey)}) {
    try {
      const input = await request.json();
      if (input.kind === 'exec') return Response.json(await env.CRM_DB.exec(input.sql));
      const prepared = item => env.CRM_DB.prepare(item.sql).bind(...(item.args ?? []));
      return Response.json(input.kind === 'batch' ? await env.CRM_DB.batch(input.statements.map(prepared)) : await prepared(input).all());
    } catch (error) { return Response.json({error:String(error)}, {status:400}); }
  }
  if (!${enableMetrics}) return worker.fetch(request, env, ctx);
  const metrics = {rowsRead:0, rowsWritten:0, statements:0, unmeasuredCalls:0};
  const archiveReads = [], archiveWrites = [];
  const archiveBucket = env.BACKUP_BUCKET && new Proxy(env.BACKUP_BUCKET, {get(target, key) {
    if (key === 'get') return async (...args) => { archiveReads.push(args[0]); return target.get(...args); };
    if (key === 'put' || key === 'delete') return async (...args) => { archiveWrites.push({method:key, key:args[0]}); return target[key](...args); };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  const race = ${JSON.stringify(receiptRace ?? null)}, raceState = {hiddenSnapshots:0, nativeReplaySnapshots:0, insertBatches:0, insertErrors:0, missingRowBatches:0, observationClockShifted:false};
  const database = race ? receiptRaceDatabase(env.CRM_DB, raceState, race) : env.CRM_DB;
  const originalNow = Date.now;
  let response;
  try { response = await worker.fetch(request, {...env, CRM_DB: measuredDatabase(database, metrics), ...(archiveBucket ? {BACKUP_BUCKET:archiveBucket} : {})}, ctx); }
  finally { Date.now = originalNow; }
  const output = new Response(response.body, response);
  output.headers.set('x-isolated-d1-metrics', JSON.stringify(metrics));
  output.headers.set('x-isolated-r2-reads', JSON.stringify(archiveReads));
  output.headers.set('x-isolated-r2-writes', JSON.stringify(archiveWrites));
  if (race) output.headers.set('x-isolated-receipt-race', JSON.stringify(raceState));
  return output;
}};`;
}

export type QueryResult<T = Record<string, unknown>> = {
  success: boolean; results: T[];
  meta: { rows_read: number; rows_written: number; size_after?: number; duration?: number; [key: string]: unknown };
};
type QueryTransport = (body: unknown) => Promise<unknown>;

export class IsolatedStatement {
  constructor(readonly transport: QueryTransport, readonly sql: string, readonly args: unknown[] = []) {}
  bind(...args: unknown[]) { return new IsolatedStatement(this.transport, this.sql, args); }
  async all<T = Record<string, unknown>>() { return await this.transport({ sql: this.sql, args: this.args }) as QueryResult<T>; }
  async run<T = Record<string, unknown>>() { return this.all<T>(); }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (await this.all()).results[0];
    return (row ? column === undefined ? row : row[column] : null) as T | null;
  }
}
export class IsolatedDatabase {
  constructor(private readonly transport: QueryTransport) {}
  prepare(sql: string) { return new IsolatedStatement(this.transport, sql); }
  async exec(sql: string) { return await this.transport({ kind: 'exec', sql }); }
  async batch<T = Record<string, unknown>>(statements: IsolatedStatement[]) {
    return await this.transport({ kind: 'batch', statements: statements.map(({ sql, args }) => ({ sql, args })) }) as QueryResult<T>[];
  }
}
