import { createHash } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyArchiveCounts } from '../worker/archive-codec';
import { advanceMonthlyPublication, startMonthlyPublication } from '../worker/archive-publication';
import { PUBLICATION_DESCRIPTOR_COLUMNS, advancePublicationReconciliation, startPublicationReconciliation, type PublicationReconciliationHandle } from '../worker/archive-publication-reconciliation';
import { archiveReconciliationLeaseSql, archiveReconciliationProofSql, type ArchiveReconciliationJobRow } from '../worker/archive-reconciliation-schema';
import { createPublicationFixture, createPublicationSeed } from './archive-publication-fixture';

let seed: Awaited<ReturnType<typeof createPublicationSeed>>;
let fixture: Awaited<ReturnType<typeof createPublicationFixture>>;
let publicationId: string;
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cursor = () => ({ version: 1, nextPart: 0, nextOffset: 0, partAfter: -1, recordPart: -1, recordOffset: -1, requestAfter: '' });
const counters = () => ({ parts: 0, records: 0, requests: 0, catalogParts: 0, catalogRecords: 0, catalogRequests: 0, counts: emptyArchiveCounts() });
beforeAll(async () => { seed = await createPublicationSeed(); });
beforeEach(async () => {
  fixture = await createPublicationFixture(seed);
  const published = await startMonthlyPublication(fixture.app.db, fixture.handle);
  publicationId = published.publicationId;
  for (let count = 0; count < 100; count++) {
    const row = await fixture.app.db.prepare('SELECT state,revision FROM archive_publication_builds WHERE publication_id=?').bind(publicationId).first<{ state: string; revision: number }>();
    if (row!.state === 'published') break;
    await advanceMonthlyPublication(fixture.app.db, { bucket: fixture.bucket, masterKey: fixture.key }, published, { expectedRevision: row!.revision });
  }
});
afterEach(async () => { await fixture?.app.close(); });
const read = (handle: PublicationReconciliationHandle) => fixture.app.db.prepare('SELECT * FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).first<ArchiveReconciliationJobRow>();
async function disable() { await fixture.app.db.prepare("UPDATE archive_publication_availability SET status='unavailable' WHERE publication_id=?").bind(publicationId).run(); }
async function begin() { await disable(); return startPublicationReconciliation(fixture.app.db, publicationId, fixture.handle); }
async function step(handle: PublicationReconciliationHandle) { return advancePublicationReconciliation(fixture.app.db, { bucket: fixture.bucket, masterKey: fixture.key }, handle, { expectedRevision: (await read(handle))!.revision }); }
async function until(handle: PublicationReconciliationHandle, phase: ArchiveReconciliationJobRow['phase']) {
  for (let count = 0; count < 100; count++) { if ((await read(handle))!.phase === phase) return; await step(handle); }
  throw new Error(`Did not reach ${phase}`);
}
async function claim(handle: PublicationReconciliationHandle, overrides = '') {
  await fixture.app.db.prepare(`UPDATE archive_publication_reconciliation_jobs SET state='running',lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),revision=revision+1,updated_at=${now}${overrides} WHERE reconciliation_id=?`).bind(crypto.randomUUID(), handle.reconciliationId).run();
}
async function update(handle: PublicationReconciliationHandle, assignment: string) {
  return fixture.app.db.prepare(`UPDATE archive_publication_reconciliation_jobs SET ${assignment},revision=revision+1,updated_at=${now} WHERE reconciliation_id=?`).bind(handle.reconciliationId).run();
}
async function candidate(overrides: Record<string, unknown> = {}) {
  const db = fixture.app.db;
  const descriptor = await db.prepare(`SELECT ${PUBLICATION_DESCRIPTOR_COLUMNS.join(',')} FROM archive_publications WHERE publication_id=?`).bind(publicationId).first();
  const descriptorJson = JSON.stringify(descriptor);
  return {
    reconciliation_id: crypto.randomUUID(), publication_id: publicationId, execution_generation: fixture.handle.generation,
    verification_id: fixture.handle.verificationId, run_id: fixture.handle.runId, snapshot_commit_token: fixture.handle.commitToken,
    graph_sha256: fixture.handle.graphSha256, validator_version: 1, descriptor_json: descriptorJson, descriptor_sha256: hash(descriptorJson),
    expected_parts: fixture.archive.manifest.parts.length, state: 'pending', phase: 'records', revision: 0,
    lease_token: null, lease_expires_at: null, cursor_json: JSON.stringify(cursor()), counters_json: JSON.stringify(counters()),
    locator_digest: '0'.repeat(64), ...overrides,
  };
}
async function insert(value: Awaited<ReturnType<typeof candidate>>) {
  const columns = Object.keys(value);
  return fixture.app.db.prepare(`INSERT INTO archive_publication_reconciliation_jobs(${columns.join(',')},created_at,updated_at) VALUES(${columns.map(() => '?').join(',')},${now},${now})`).bind(...Object.values(value)).run();
}

describe('schema26 archive reconciliation contract', () => {
  it('pins the complete original descriptor and requires exact current completed semantic proof', async () => {
    expect(await fixture.app.db.prepare('SELECT max(version) AS version FROM schema_versions').first('version')).toBe(42);
    await expect(insert(await candidate())).rejects.toThrow('ARCHIVE_RECONCILIATION_PROOF_INVALID');
    await disable();
    const valid = await candidate();
    const descriptor = JSON.parse(valid.descriptor_json);
    await expect(insert({ ...valid, descriptor_json: JSON.stringify({ ...descriptor, generation: 'relabeled' }) })).rejects.toThrow('ARCHIVE_RECONCILIATION_PROOF_INVALID');
    await expect(insert({ ...valid, expected_parts: valid.expected_parts + 1 })).rejects.toThrow('ARCHIVE_RECONCILIATION_PROOF_INVALID');
    await expect(insert({ ...valid, execution_generation: 'stale' })).rejects.toThrow('ARCHIVE_RECONCILIATION_PROOF_INVALID');
    await fixture.app.db.prepare("UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL WHERE run_id=?").bind(fixture.handle.runId).run();
    expect(await fixture.app.db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(fixture.handle.verificationId).first('status')).toBe('verified');
    await expect(insert(valid)).rejects.toThrow('ARCHIVE_RECONCILIATION_PROOF_INVALID');
    expect(() => archiveReconciliationProofSql('x;DELETE')).toThrow('SQL_ALIAS_INVALID');
    expect(() => archiveReconciliationLeaseSql('x.y')).toThrow('SQL_ALIAS_INVALID');
  });

  it('rejects malformed bounded cursors, counters, and alternate-key replacement', async () => {
    await disable(); const value = await candidate();
    for (const bad of [
      { cursor_json: JSON.stringify({ ...cursor(), extra: 0 }) },
      { cursor_json: JSON.stringify({ ...cursor(), nextOffset: 256 }) },
      { cursor_json: JSON.stringify({ ...cursor(), version: true }) },
      { counters_json: JSON.stringify({ ...counters(), extra: 0 }) },
      { counters_json: JSON.stringify({ ...counters(), counts: { ...emptyArchiveCounts(), reviews: -1 } }) },
      { descriptor_json: JSON.stringify({ ...JSON.parse(value.descriptor_json), extra: 0 }) },
      { descriptor_json: JSON.stringify({ ...JSON.parse(value.descriptor_json), validator_version: true }) },
    ]) await expect(insert({ ...value, ...bad })).rejects.toThrow();
    await insert(value);
    const handle = { reconciliationId: value.reconciliation_id, generation: value.execution_generation };
    const prior = (await read(handle))!;
    const columns = Object.keys(prior);
    await expect(fixture.app.db.prepare(`INSERT OR REPLACE INTO archive_publication_reconciliation_jobs(${columns.join(',')}) SELECT ${columns.map(column => column === 'reconciliation_id' ? "'replacement-id'" : column).join(',')} FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?`).bind(handle.reconciliationId).run()).rejects.toThrow();
    expect(await read(handle)).toEqual(prior);
  });

  it('fences claims by native time and revision and makes immutable job identity permanent', async () => {
    const handle = await begin(), db = fixture.app.db;
    expect(await db.prepare(`SELECT ${archiveReconciliationProofSql()} AS valid FROM archive_publication_reconciliation_jobs j WHERE reconciliation_id=?`).bind(handle.reconciliationId).first('valid')).toBe(1);
    await expect(update(handle, "descriptor_sha256='" + 'a'.repeat(64) + "'")).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
    await expect(db.prepare(`UPDATE archive_publication_reconciliation_jobs SET revision=revision+2,updated_at=${now} WHERE reconciliation_id=?`).bind(handle.reconciliationId).run()).rejects.toThrow();
    await expect(claim(handle, ",lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+31 seconds')")).rejects.toThrow();
    await claim(handle);
    expect(await db.prepare(`SELECT ${archiveReconciliationLeaseSql()} AS valid FROM archive_publication_reconciliation_jobs j WHERE reconciliation_id=?`).bind(handle.reconciliationId).first('valid')).toBe(1);
    const owned = (await read(handle))!;
    await expect(claim(handle)).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
    await expect(update(handle, "state='pending',phase='catalog_parts',lease_token=NULL,lease_expires_at=NULL")).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
    expect(await read(handle)).toEqual(owned);
    await update(handle, "state='pending',lease_token=NULL,lease_expires_at=NULL");
    expect((await read(handle))!.revision).toBe(owned.revision + 1);
  });

  it('requires each bounded reverse catalog walk and explicit EOF before terminal authority', async () => {
    const handle = await begin(); await until(handle, 'catalog_parts');
    await claim(handle);
    await expect(update(handle, "state='pending',phase='catalog_records',lease_token=NULL,lease_expires_at=NULL")).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
    await expect(update(handle, "state='complete',phase='complete',lease_token=NULL,lease_expires_at=NULL")).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
    await update(handle, "state='pending',lease_token=NULL,lease_expires_at=NULL");
    await until(handle, 'catalog_records');
    await claim(handle);
    await expect(update(handle, "state='pending',phase='catalog_requests',lease_token=NULL,lease_expires_at=NULL")).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
    await update(handle, "state='pending',lease_token=NULL,lease_expires_at=NULL");
    expect(await fixture.app.db.prepare('SELECT count(*) AS n FROM archive_publication_reconciliation_receipts').first('n')).toBe(0);
    expect(await fixture.app.db.prepare('SELECT status FROM archive_publication_availability WHERE publication_id=?').bind(publicationId).first('status')).toBe('unavailable');
    await until(handle, 'complete');
    expect(await fixture.app.db.prepare('SELECT status FROM archive_publication_availability WHERE publication_id=?').bind(publicationId).first('status')).toBe('ready');
  });

  it('rejects an expired lease checkpoint and permits a fresh fenced claim', async () => {
    const handle = await begin();
    await claim(handle, ",lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+0.01 seconds')");
    const expired = (await read(handle))!;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(await fixture.app.db.prepare(`SELECT ${archiveReconciliationLeaseSql()} AS valid FROM archive_publication_reconciliation_jobs j WHERE reconciliation_id=?`).bind(handle.reconciliationId).first('valid')).toBe(0);
    await expect(update(handle, "state='pending',lease_token=NULL,lease_expires_at=NULL")).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
    await claim(handle);
    const fresh = (await read(handle))!;
    expect(fresh.revision).toBe(expired.revision + 1);
    expect(fresh.lease_token).not.toBe(expired.lease_token);
    await expect(fixture.app.db.prepare("UPDATE archive_publication_reconciliation_jobs SET state='pending',lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at='2000-01-01T00:00:00.000Z' WHERE reconciliation_id=?").bind(handle.reconciliationId).run()).rejects.toThrow('ARCHIVE_RECONCILIATION_JOB_INVALID');
  });

  it('retains immutable completion receipts and rejects ready status without current receipt authority', async () => {
    const handle = await begin(); await until(handle, 'complete'); const db = fixture.app.db;
    const receipt = await db.prepare('SELECT * FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?').bind(handle.reconciliationId).first();
    for (const statement of [
      'UPDATE archive_publication_reconciliation_receipts SET completed_at=completed_at WHERE reconciliation_id=?',
      'DELETE FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?',
      'INSERT OR REPLACE INTO archive_publication_reconciliation_receipts SELECT * FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?',
    ]) await expect(db.prepare(statement).bind(handle.reconciliationId).run()).rejects.toThrow();
    const columns = Object.keys(receipt!);
    await expect(db.prepare(`INSERT OR REPLACE INTO archive_publication_reconciliation_receipts(${columns.join(',')}) SELECT ${columns.map(column => column === 'reconciliation_id' ? "'another-receipt'" : column === 'completed_at' ? now : column).join(',')} FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?`).bind(handle.reconciliationId).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE archive_publication_availability SET reconciliation_id=NULL WHERE publication_id=?").bind(publicationId).run()).rejects.toThrow('ARCHIVE_PUBLICATION_AVAILABILITY_INVALID');
    const prior = await db.prepare('SELECT * FROM archive_publication_availability WHERE publication_id=?').bind(publicationId).first();
    await db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    expect(await db.prepare('SELECT * FROM archive_publication_availability WHERE publication_id=?').bind(publicationId).first()).toEqual({ ...prior, status: 'unavailable' });
    expect(await db.prepare('SELECT * FROM archive_publication_reconciliation_receipts WHERE reconciliation_id=?').bind(handle.reconciliationId).first()).toEqual(receipt);
    expect((await read(handle))!.state).toBe('complete');
    await expect(db.prepare("UPDATE archive_publication_availability SET status='ready',generation=(SELECT generation FROM history_runtime WHERE id=1) WHERE publication_id=?").bind(publicationId).run()).rejects.toThrow('ARCHIVE_PUBLICATION_AVAILABILITY_INVALID');
  });

  it('invalidates unfinished leased work on generation reset without changing pinned provenance', async () => {
    const handle = await begin(); await step(handle); await claim(handle);
    const prior = (await read(handle))!, db = fixture.app.db;
    const publication = await db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(publicationId).first();
    await db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    expect(await read(handle)).toMatchObject({ ...prior, state: 'invalid', lease_token: null, lease_expires_at: null, revision: prior.revision + 1, updated_at: expect.any(String) });
    expect(await db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(publicationId).first()).toEqual(publication);
    await expect(claim(handle)).rejects.toThrow();
    await expect(db.prepare('DELETE FROM archive_publication_reconciliation_jobs WHERE reconciliation_id=?').bind(handle.reconciliationId).run()).rejects.toThrow('IMMUTABLE_ARCHIVE_RECONCILIATION');
  });

  it('guards all reconciliation and availability mutations during backup maintenance', async () => {
    const handle = await begin(); await until(handle, 'complete'); const db = fixture.app.db;
    await db.prepare("UPDATE backup_runtime SET write_locked_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=1").run();
    for (const table of ['archive_publication_reconciliation_jobs','archive_publication_reconciliation_receipts','archive_publication_availability']) {
      await expect(db.prepare(`UPDATE ${table} SET publication_id=publication_id WHERE publication_id=?`).bind(publicationId).run()).rejects.toThrow('backup_maintenance');
      await expect(db.prepare(`DELETE FROM ${table} WHERE publication_id=?`).bind(publicationId).run()).rejects.toThrow('backup_maintenance');
      await expect(db.prepare(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE publication_id=?`).bind(publicationId).run()).rejects.toThrow('backup_maintenance');
    }
    await db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    const requestPlan = await db.prepare('EXPLAIN QUERY PLAN SELECT request_id FROM archive_publication_requests INDEXED BY archive_publication_requests_publication_request WHERE publication_id=? AND request_id>? ORDER BY request_id LIMIT 8').bind(publicationId, '').all();
    expect(JSON.stringify(requestPlan.results)).toContain('archive_publication_requests_publication_request');
    const recordPlan = await db.prepare('EXPLAIN QUERY PLAN SELECT part_index,part_offset FROM archive_publication_records WHERE publication_id=? AND (part_index,part_offset)>(?,?) ORDER BY part_index,part_offset LIMIT 8').bind(publicationId, -1, -1).all();
    expect(JSON.stringify(recordPlan.results)).toContain('sqlite_autoindex_archive_publication_records_2');
    expect(JSON.stringify(recordPlan.results)).not.toContain('TEMP B-TREE');
  });
});
