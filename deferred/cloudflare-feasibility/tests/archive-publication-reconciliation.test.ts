import { readFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import { startMonthlyPublication, advanceMonthlyPublication } from '../worker/archive-publication';
import { startPublicationReconciliation, advancePublicationReconciliation } from '../worker/archive-publication-reconciliation';
import { createPublicationFixture, snapshotPublicationDatabase, restorePublicationDatabase, refreshPublicationProof } from './archive-publication-fixture';
import type { ArchiveStagingDatabase } from '../worker/archive-semantic-store';
import type { ArchiveRecordEvidenceStorage } from '../worker/archive-record-evidence';
let base: { sql: string; key: string; objects: Map<string, Uint8Array>; publicationId: string; proof: Awaited<ReturnType<typeof refreshPublicationProof>>['handle']; original: Record<string, unknown> };
beforeAll(async () => {
  const source = await createPublicationFixture(); let restored: Awaited<ReturnType<typeof restorePublicationDatabase>> | undefined;
  try {
    const publication = await startMonthlyPublication(source.app.db, source.handle); let revision = 0;
    for (let step = 0; step < 100; step++) { const p = await advanceMonthlyPublication(source.app.db, { bucket: source.bucket, masterKey: source.key }, publication, { expectedRevision: revision }); revision = p.revision; if (p.state === 'published') break; if (step === 99) throw new Error('Publication did not finish'); }
    const original = (await source.app.db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(publication.publicationId).first())!;
    restored = await restorePublicationDatabase(await snapshotPublicationDatabase(source.app, { omitTables: ['attendance_events','attendance_corrections','reviews'] }));
    const reset = await readFile(new URL('../scripts/recovery-access-reset.sql', import.meta.url), 'utf8');
    await restored.db.batch(unstable_splitSqlQuery(reset).map(sql => restored!.db.prepare(sql)));
    const fresh = await refreshPublicationProof(restored, source);
    base = { sql: await snapshotPublicationDatabase(restored), key: source.key, objects: source.objects, publicationId: publication.publicationId, proof: fresh.handle, original };
  } finally { await restored?.close(); await source.app.close(); }
}, 120_000);
async function fixture(sql = base.sql) {
  const app = await restorePublicationDatabase(sql), bucket = await app.runtime.getR2Bucket('BACKUP_BUCKET');
  for (const [key, bytes] of base.objects) await bucket.put(key, bytes);
  return { app, storage: { bucket, masterKey: base.key } satisfies ArchiveRecordEvidenceStorage };
}
async function finish(f: Awaited<ReturnType<typeof fixture>>) {
  const handle = await startPublicationReconciliation(f.app.db, base.publicationId, base.proof); let revision = 0;
  for (let step = 0; step < 200; step++) { const p = await advancePublicationReconciliation(f.app.db, f.storage, handle, { expectedRevision: revision }); expect(p.processed).toBeLessThanOrEqual(8); expect(p.busy).toBe(false); revision = p.revision; if (p.state === 'complete') return { handle, progress: p }; }
  throw new Error('Reconciliation did not finish');
}
describe('restored catalog reconciliation', () => {
  it('restores current-generation availability without live evidence and preserves original provenance', async () => {
    const f = await fixture(); try {
      const { handle, progress } = await finish(f);
      expect(await f.app.db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(base.publicationId).first()).toEqual(base.original);
      expect(await f.app.db.prepare('SELECT generation,status,reconciliation_id FROM archive_publication_availability WHERE publication_id=?').bind(base.publicationId).first()).toEqual({ generation: handle.generation, status: 'ready', reconciliation_id: handle.reconciliationId });
      expect(await advancePublicationReconciliation(f.app.db, f.storage, handle, { expectedRevision: 0 })).toMatchObject({ state: 'complete', revision: progress.revision, processed: 0, busy: false, ready: true });
      expect(await startPublicationReconciliation(f.app.db, base.publicationId, base.proof, handle.reconciliationId)).toEqual(handle);
      await f.app.db.prepare('UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1').run();
      expect(await advancePublicationReconciliation(f.app.db,f.storage,handle,{expectedRevision:progress.revision})).toMatchObject({state:'complete',ready:false});
    } finally { await f.app.close(); }
  }, 120_000);
  it.each([
    ['record hash','archive_publication_records','record_sha256','f'.repeat(64)], ['record bytes','archive_publication_records','record_bytes',1],
    ['record descriptor','archive_publication_records','descriptor_sha256','e'.repeat(64)], ['part descriptor','archive_publication_parts','descriptor_sha256','e'.repeat(64)],
    ['claim fingerprint','archive_publication_requests','payload_hash','changed'], ['registry fingerprint','history_request_keys','payload_hash','changed'],
    ['registry encoding','history_request_keys','hash_encoding','opaque'], ['catalog digest','archive_publications','locator_digest','d'.repeat(64)],
  ])('rejects mismatched %s', async (_label, table, column, value) => {
    const pristine = await fixture(); let altered: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      let changed = false;
      const sql = await snapshotPublicationDatabase(pristine.app, { transformRow(name, row) {
        if (name === table && !changed && (name !== 'history_request_keys' || row.source_kind === 'event')) { changed = true; return { ...row, [column]: value }; } return row;
      } });
      expect(changed).toBe(true); altered = await fixture(sql);
      const before = await altered.app.db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(base.publicationId).first();
      await expect(finish(altered)).rejects.toThrow();
      expect(await altered.app.db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(base.publicationId).first()).toEqual(before);
      expect((await altered.app.db.prepare('SELECT status FROM archive_publication_availability WHERE publication_id=?').bind(base.publicationId).first())?.status).toBe('unavailable');
      expect((await altered.app.db.prepare('SELECT count(*) AS n FROM archive_publication_reconciliation_receipts').first<{ n: number }>())!.n).toBe(0);
    } finally { await altered?.app.close(); await pristine.app.close(); }
  }, 120_000);
  it('rolls back when the final native checkpoint guard no longer matches', async () => {
    const f = await fixture(); try {
      const db = f.app.db, handle = await startPublicationReconciliation(db, base.publicationId, base.proof);
      const fenced: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = { prepare(sql) { return db.prepare(sql.includes('SET state=?,phase=?') ? sql.replace('WHERE j.reconciliation_id=?','WHERE 0 AND j.reconciliation_id=?') : sql); }, batch: db.batch.bind(db) };
      await expect(advancePublicationReconciliation(fenced, f.storage, handle, { expectedRevision: 0 })).rejects.toThrow();
      const row = await db.prepare('SELECT state,counters_json,lease_token FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).first<{ state: string; counters_json: string; lease_token: null }>();
      expect(row?.state).toBe('pending'); expect(row?.lease_token).toBe(null); expect(JSON.parse(row!.counters_json).records).toBe(0);
    } finally { await f.app.close(); }
  }, 120_000);
  it('rejects an in-flight generation change', async () => {
    const f = await fixture(); try {
      const handle = await startPublicationReconciliation(f.app.db, base.publicationId, base.proof); let switched = false;
      const storage: ArchiveRecordEvidenceStorage = { masterKey: base.key, bucket: { async get(key) { const object = await f.storage.bucket.get(key); if (!switched) { switched = true; await f.app.db.prepare('UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1').run(); } return object; } } };
      await expect(advancePublicationReconciliation(f.app.db, storage, handle, { expectedRevision: 0 })).rejects.toThrow();
      expect((await f.app.db.prepare('SELECT state FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).first())?.state).toBe('invalid');
    } finally { await f.app.close(); }
  }, 120_000);
  it.each([['parts', ['archive_publication_parts','archive_publication_records','archive_publication_requests']], ['claims', ['archive_publication_requests']]])('rejects missing %s', async (_label, omitTables) => {
    const original = await fixture(); let missing: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      missing = await fixture(await snapshotPublicationDatabase(original.app, { omitTables: omitTables as string[] }));
      await expect(finish(missing)).rejects.toThrow();
      expect((await missing.app.db.prepare('SELECT count(*) AS n FROM archive_publication_reconciliation_receipts').first<{n:number}>())!.n).toBe(0);
    } finally { await missing?.app.close(); await original.app.close(); }
  }, 120_000);
  it('recreates a missing availability projection only after complete reconciliation', async () => {
    const original = await fixture(); let missing: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      missing = await fixture(await snapshotPublicationDatabase(original.app, { omitTables: ['archive_publication_availability'] }));
      const {handle} = await finish(missing);
      expect((await missing.app.db.prepare('SELECT reconciliation_id FROM archive_publication_availability WHERE publication_id=?').bind(base.publicationId).first())?.reconciliation_id).toBe(handle.reconciliationId);
    } finally { await missing?.app.close(); await original.app.close(); }
  }, 120_000);
  it('detects an extra locator in the reverse pass after all authenticated records match', async () => {
    const original = await fixture(); let extra: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      const last = (await original.app.db.prepare('SELECT * FROM archive_publication_records ORDER BY part_index DESC,part_offset DESC LIMIT 1').first())!;
      const row = {...last, table_name:'students', record_key:'extra-restored-record', part_offset:Number(last.part_offset)+1};
      const literal = (value: unknown) => typeof value === 'number' ? String(value) : "'"+String(value).replaceAll("'","''")+"'";
      const insert = `INSERT INTO archive_publication_records (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(literal).join(',')})`;
      const at = base.sql.search(/\nCREATE (?:UNIQUE )?(?:INDEX|TRIGGER) /i);
      expect(at).toBeGreaterThan(0);
      extra = await fixture(base.sql.slice(0,at)+'\n'+insert+';\n'+base.sql.slice(at));
      await expect(finish(extra)).rejects.toThrow('RECORD_CATALOG_MISMATCH');
      expect((await extra.app.db.prepare('SELECT phase FROM archive_publication_reconciliation_jobs').first())?.phase).toBe('catalog_records');
    } finally { await extra?.app.close(); await original.app.close(); }
  }, 120_000);
  it.each(['rollback','lost reply'])('keeps terminal activation atomic during a %s', async mode => {
    const f = await fixture(); try {
      const db=f.app.db, handle=await startPublicationReconciliation(db,base.publicationId,base.proof); let terminal=false, revision=0;
      const interrupted: ArchiveStagingDatabase<ReturnType<typeof db.prepare>> = {
        prepare(sql) { return db.prepare(mode==='rollback' && sql.includes('CASE WHEN EXISTS(SELECT 1 FROM archive_publication_availability') ? sql.replace('CASE WHEN EXISTS','CASE WHEN 0 AND EXISTS') : sql); },
        async batch<T>(statements: ReturnType<typeof db.prepare>[]) {
          const ending=statements.some(statement=>statement.sql.includes('INSERT INTO archive_publication_reconciliation_receipts'));
          try { const rows=await db.batch<T>(statements); if(ending && mode==='lost reply') {terminal=true;throw new Error('lost terminal reply');} return rows; }
          catch(error) { if(ending)terminal=true; throw error; }
        },
      };
      for(let step=0;step<200;step++) { try {const p=await advancePublicationReconciliation(interrupted,f.storage,handle,{expectedRevision:revision});revision=p.revision;} catch(error) {expect(terminal).toBe(true);break;} }
      expect(terminal).toBe(true);
      const receiptCount=(await db.prepare('SELECT count(*) AS n FROM archive_publication_reconciliation_receipts').first<{n:number}>())!.n;
      const status=(await db.prepare('SELECT status FROM archive_publication_availability WHERE publication_id=?').bind(base.publicationId).first())?.status;
      expect(receiptCount).toBe(mode==='rollback'?0:1); expect(status).toBe(mode==='rollback'?'unavailable':'ready');
      if(mode==='lost reply') expect(await advancePublicationReconciliation(db,f.storage,handle,{expectedRevision:revision})).toMatchObject({state:'complete',processed:0,busy:false});
    } finally {await f.app.close();}
  },120_000);

});
