import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import type { ArchiveReference } from '../shared/archive-format';
import { compareArchiveRecords, createArchive } from '../worker/archive-codec';
import { D1ArchiveSemanticStaging } from '../worker/archive-semantic-store';
import type { MonthlySemanticAdvance, MonthlySemanticRunHandle } from '../worker/archive-semantic-runner';
import { nativeSemanticFixture } from './archive-semantic-fixture';
import { projectRoot } from './runtime';

describe('monthly semantic verification inside actual Worker invocations', () => {
  it('runs the browser bundle with native D1, concurrent calls and measured per-request statements', async () => {
    const source = await nativeSemanticFixture(9);
    const script = `
      import { startMonthlySemanticVerification, advanceMonthlySemanticVerification } from './worker/archive-semantic-runner.ts';
      export default { async fetch(request, env) {
        let statements = 0;
        const db = {
          prepare(sql) { return env.CRM_DB.prepare(sql); },
          async batch(items) { statements += items.length; return env.CRM_DB.batch(items); }
        };
        try {
          const handle = await request.json();
          const result = new URL(request.url).pathname === '/start'
            ? await startMonthlySemanticVerification(db, handle)
            : await advanceMonthlySemanticVerification(db, handle);
          return Response.json({ result, statements });
        } catch (error) {
          return Response.json({ error: String(error), statements }, { status: 500 });
        }
      } };`;
    const built = await build({ stdin: { contents: script, resolveDir: projectRoot, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
    const runtime = new Miniflare({ modules: true, script: built.outputFiles[0].text, compatibilityDate: '2026-06-11', d1Databases: { CRM_DB: 'semantic-worker-private-test' } });
    try {
      await runtime.ready;
      const db = await runtime.getD1Database('CRM_DB');
      for (const name of (await readdir(join(projectRoot, 'migrations'))).filter(name => name.endsWith('.sql')).sort()) {
        const statements = unstable_splitSqlQuery(await readFile(join(projectRoot, 'migrations', name), 'utf8'));
        await db.batch(statements.map(sql => db.prepare(sql)));
      }
      const objects = new Map<string, Uint8Array>();
      const sealed = await createArchive(source.key, source.metadata, source.records.sort(compareArchiveRecords), async (part, bytes) => { objects.set(part.objectKey, bytes); });
      const reference: ArchiveReference = { archiveId: sealed.manifest.archiveId, kind: sealed.manifest.kind, manifestObjectKey: sealed.objectKey, manifestSha256: sealed.sha256 };
      const staging = await D1ArchiveSemanticStaging.create(db, source.key, reference);
      await staging.registerManifest(reference, sealed.encrypted);
      for (const part of sealed.manifest.parts) await staging.stageEncryptedPart(sealed.manifest.archiveId, part.index, objects.get(part.objectKey)!);
      const snapshot = await staging.freeze();
      const request = async <T,>(path: string, body: unknown) => {
        const response = await runtime.dispatchFetch(`https://semantic-worker.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        expect(response.status, text).toBe(200);
        const value = JSON.parse(text) as { result: T; statements: number };
        expect(value.statements).toBeLessThanOrEqual(40);
        return value;
      };
      const { result: handle } = await request<MonthlySemanticRunHandle>('/start', { ...staging.handle, commitToken: snapshot.commitToken, graphSha256: snapshot.graphSha256 });
      const concurrent = await Promise.all([request<MonthlySemanticAdvance>('/advance', handle), request<MonthlySemanticAdvance>('/advance', handle)]);
      for (const item of concurrent) {
        expect(['pending', 'busy']).toContain(item.result.status);
        expect(item.result.queries).toBe(item.statements);
      }
      let complete = false, calls = 0;
      for (; calls < 2_000; calls++) {
        const step = await request<MonthlySemanticAdvance>('/advance', handle);
        expect(step.result.queries).toBe(step.statements);
        if (step.result.status === 'complete') { complete = true; break; }
        expect(step.result.status).toBe('pending');
      }
      expect(complete).toBe(true);
      expect(calls).toBeGreaterThan(10);
      expect((await request<MonthlySemanticAdvance>('/advance', handle)).result.status).toBe('complete');
      expect(await db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(staging.handle.verificationId).first('status')).toBe('verified');
      for (const table of ['attendance_events', 'attendance_corrections', 'visits', 'history_record_locations']) expect(await db.prepare(`SELECT count(*) n FROM ${table}`).first('n')).toBe(0);
    } finally { await runtime.dispose(); }
  }, 120_000);
});
