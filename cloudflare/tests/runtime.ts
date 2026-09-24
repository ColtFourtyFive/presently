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
  migrate?: boolean;
  r2?: boolean;
  queue?: boolean;
  /** Configure the fetch mock before the runtime starts, for example to fake the D1 export API. */
  mockFetch?: (mock: ReturnType<typeof createFetchMock>) => void;
};

/** Split migrations with the same splitter `wrangler d1 migrations apply` uses. */
export async function migrationStatements() {
  const names = (await readdir(join(projectRoot, 'migrations'))).filter(name => name.endsWith('.sql')).sort();
  const statements: string[] = [];
  for (const name of names) statements.push(...unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8')));
  return statements;
}

/** Actual workerd/D1 runtime with temporary storage and no network access. */
export async function createRuntime(options: RuntimeOptions) {
  const directory = await mkdtemp(join(tmpdir(), 'presently-test-'));
  const signer = options.signer ?? await createSigner();
  const fetchMock = createFetchMock();
  fetchMock.disableNetConnect();
  fetchMock.get(testIssuer).intercept({ path: '/cdn-cgi/access/certs' })
    .reply(200, { keys: [signer.jwk] }, { headers: { 'content-type': 'application/json' } }).persist();
  options.mockFetch?.(fetchMock);
  const controlKey = crypto.randomUUID();
  const result = await build({
    stdin: { contents: testWorker(join(projectRoot, 'worker/index.ts'), controlKey), resolveDir: projectRoot, sourcefile: 'isolated-test-worker.ts', loader: 'ts' },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', write: false,
  });
  const runtime = new Miniflare({
    modules: true,
    script: result.outputFiles[0].text,
    compatibilityDate: '2026-06-11',
    d1Databases: { CRM_DB: 'isolated-test-database' },
    d1Persist: join(directory, 'd1'),
    ...(options.r2 ? { r2Buckets: { BACKUP_BUCKET: 'isolated-test-backups' }, r2Persist: join(directory, 'r2') } : {}),
    ...(options.queue ? { queueProducers: { BACKUP_QUEUE: 'isolated-test-queue' } } : {}),
    bindings: options.bindings,
    fetchMock,
  });
  const close = async () => { await runtime.dispose(); await rm(directory, { recursive: true, force: true }); };
  try {
    await runtime.ready;
    const transport = async (body: unknown) => {
      const response = await runtime.dispatchFetch('http://localhost/__isolated/sql', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-isolated-key': controlKey }, body: JSON.stringify(body),
      });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? 'Isolated D1 query failed');
      return value;
    };
    const db = new IsolatedDatabase(transport);
    if (options.migrate !== false) {
      const statements = await migrationStatements();
      await db.batch(statements.map(sql => db.prepare(sql)));
    }
    const control = async (body: unknown) => transport(body);
    return {
      runtime, db, signer, directory, fetchMock, close, control,
      async request(path: string, init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {}) {
        const headers = new Headers(init.headers);
        if (init.token) headers.set('Cf-Access-Jwt-Assertion', init.token);
        if (init.body !== undefined) headers.set('content-type', 'application/json');
        return runtime.dispatchFetch(`https://app.example.test${path}`, {
          method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
          headers: Object.fromEntries(headers.entries()),
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
      },
      /** Run the Worker's scheduled or queue handler inside the runtime. */
      async invoke(kind: 'scheduled' | 'queue', payload: unknown = {}) {
        const response = await runtime.dispatchFetch('http://localhost/__isolated/invoke', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-isolated-key': controlKey }, body: JSON.stringify({ kind, payload }),
        });
        const value = await response.json() as { error?: string; sent?: unknown[] };
        if (!response.ok) throw new Error(value.error ?? 'Invocation failed');
        return value;
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export type TestRuntime = Awaited<ReturnType<typeof createRuntime>>;

/**
 * Test entry point around the product worker. It adds a key-protected SQL
 * endpoint for assertions and a way to drive scheduled and queue handlers with
 * a recording queue. None of this is part of the product bundle.
 */
function testWorker(entry: string, controlKey: string) {
  return `import worker from ${JSON.stringify(entry)};
function metered(database, metrics) {
  const record = result => { for (const item of Array.isArray(result) ? result : [result]) if (item?.meta) { metrics.rowsRead += item.meta.rows_read ?? 0; metrics.rowsWritten += item.meta.rows_written ?? 0; metrics.queries++; } return result; };
  const originals = new WeakMap();
  const wrap = target => { const proxy = new Proxy(target, { get(t, key) {
    if (key === 'bind') return (...values) => wrap(t.bind(...values));
    if (key === 'all' || key === 'run') return async (...args) => record(await t[key](...args));
    if (key === 'first') return async column => { const result = record(await t.all()); const row = result.results?.[0]; if (!row) return null; return column === undefined ? row : row[column]; };
    const value = Reflect.get(t, key, t); return typeof value === 'function' ? value.bind(t) : value;
  } }); originals.set(proxy, target); return proxy; };
  return new Proxy(database, { get(t, key) {
    if (key === 'prepare') return sql => wrap(t.prepare(sql));
    if (key === 'batch') return async statements => { metrics.batches++; return record(await t.batch(statements.map(s => originals.get(s) ?? s))); };
    const value = Reflect.get(t, key, t); return typeof value === 'function' ? value.bind(t) : value;
  } });
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const authorized = request.headers.get('x-isolated-key') === ${JSON.stringify(controlKey)};
    if (url.pathname === '/__isolated/sql' && authorized) {
      try {
        const input = await request.json();
        const prepared = item => env.CRM_DB.prepare(item.sql).bind(...(item.args ?? []));
        return Response.json(input.kind === 'batch' ? await env.CRM_DB.batch(input.statements.map(prepared)) : await prepared(input).all());
      } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
    }
    if (url.pathname === '/__isolated/invoke' && authorized) {
      const input = await request.json();
      const sent = [];
      const queue = { send: async body => { sent.push(body); } };
      const testEnv = { ...env, BACKUP_QUEUE: env.BACKUP_QUEUE ? queue : undefined };
      try {
        if (input.kind === 'scheduled') await worker.scheduled({ scheduledTime: input.payload.at ?? Date.now(), cron: '0 * * * *' }, testEnv, ctx);
        else {
          const acked = [], retried = [];
          const messages = (input.payload.messages ?? []).map((body, i) => ({ id: String(i), body, attempts: 1, ack: () => acked.push(i), retry: () => retried.push(i) }));
          await worker.queue({ queue: 'test', messages }, testEnv, ctx);
          return Response.json({ sent, acked, retried });
        }
        return Response.json({ sent });
      } catch (error) { return Response.json({ error: String(error) }, { status: 400 }); }
    }
    const metrics = { rowsRead: 0, rowsWritten: 0, queries: 0, batches: 0 };
    const response = await worker.fetch(request, { ...env, CRM_DB: metered(env.CRM_DB, metrics) }, ctx);
    const output = new Response(response.body, response);
    output.headers.set('x-test-d1-metrics', JSON.stringify(metrics));
    return output;
  },
};`;
}

export type QueryResult<T = Record<string, unknown>> = {
  success: boolean; results: T[];
  meta: { rows_read: number; rows_written: number; size_after?: number; changes?: number; [key: string]: unknown };
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
  async batch<T = Record<string, unknown>>(statements: IsolatedStatement[]) {
    return await this.transport({ kind: 'batch', statements: statements.map(({ sql, args }) => ({ sql, args })) }) as QueryResult<T>[];
  }
}
