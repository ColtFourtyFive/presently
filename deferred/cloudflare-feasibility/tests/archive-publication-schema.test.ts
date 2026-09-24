import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ARCHIVE_TABLES, type ArchiveCounts, type ArchiveRecord } from '../shared/archive-format';
import { archivePublicationProofSql, archivePublicationVisibleSql, type ArchivePublicationBuildRow } from '../worker/archive-publication-schema';
import { createPublicationFixture, createPublicationSeed } from './archive-publication-fixture';

let seed: Awaited<ReturnType<typeof createPublicationSeed>>;
let fixture: Awaited<ReturnType<typeof createPublicationFixture>>;
beforeAll(async () => { seed = await createPublicationSeed(); });
beforeEach(async () => { fixture = await createPublicationFixture(seed); });
afterEach(async () => { await fixture?.app.close(); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const build = (id: string) => fixture.app.db.prepare('SELECT * FROM archive_publication_builds WHERE publication_id=?').bind(id).first<ArchivePublicationBuildRow>();
async function begin(id = crypto.randomUUID()) {
  const run = await fixture.app.db.prepare('SELECT header_json FROM archive_semantic_runs WHERE run_id=?').bind(fixture.handle.runId).first<{ header_json: string }>();
  await fixture.app.db.prepare(`INSERT INTO archive_publication_builds(publication_id,verification_id,generation,run_id,snapshot_commit_token,graph_sha256,validator_version,archive_id,center_id,month,timezone,root_reference_json,header_json,header_sha256,part_count,record_count,state,created_at,updated_at)
    SELECT ?,r.verification_id,r.generation,r.run_id,r.snapshot_commit_token,r.graph_sha256,r.validator_version,r.archive_id,json_extract(r.header_json,'$.centerId'),json_extract(r.header_json,'$.month'),json_extract(r.header_json,'$.timezone'),s.root_reference_json,r.header_json,?,m.part_count,m.record_count,'building',${now},${now}
    FROM archive_semantic_runs r JOIN archive_semantic_sessions s ON s.verification_id=r.verification_id AND s.generation=r.generation
    JOIN archive_semantic_manifests m ON m.verification_id=s.verification_id AND m.generation=s.generation AND m.archive_id=r.archive_id WHERE r.run_id=?`).bind(id, hash(run!.header_json), fixture.handle.runId).run();
  return id;
}
async function claim(id: string) {
  await fixture.app.db.prepare(`UPDATE archive_publication_builds SET lease_token=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds'),revision=revision+1,updated_at=${now} WHERE publication_id=?`).bind(crypto.randomUUID(), id).run();
}
async function page(id: string, maximum = 8) {
  const db = fixture.app.db, before = (await build(id))!;
  await claim(id);
  const descriptor = fixture.archive.manifest.parts[before.next_part];
  const start = fixture.archive.manifest.parts.slice(0, before.next_part).reduce((sum, part) => sum + part.recordCount, 0) + before.next_offset;
  const records = fixture.records.slice(start, start + Math.min(maximum, descriptor.recordCount - before.next_offset));
  const nextOffset = before.next_offset + records.length, complete = nextOffset === descriptor.recordCount;
  const counts = JSON.parse(before.counts_json) as ArchiveCounts;
  for (const record of records) counts[record.table]++;
  const requests = records.filter(record => record.table === 'attendance_events' || record.table === 'attendance_corrections');
  const statements = [];
  if (before.next_offset === 0) statements.push(db.prepare('INSERT INTO archive_publication_parts(publication_id,part_index,descriptor_json,descriptor_sha256,record_count) VALUES(?,?,?,?,?)').bind(id, before.next_part, JSON.stringify(descriptor), hash(JSON.stringify(descriptor)), descriptor.recordCount));
  for (const [index, record] of records.entries()) {
    const json = JSON.stringify(record);
    statements.push(db.prepare('INSERT INTO archive_publication_records VALUES(?,?,?,?,?,?,?,?)').bind(id, record.table, record.key, before.next_part, before.next_offset + index, hash(JSON.stringify(descriptor)), hash(json), Buffer.byteLength(json)));
    if (record.table === 'attendance_events' || record.table === 'attendance_corrections') statements.push(db.prepare('INSERT INTO archive_publication_requests VALUES(?,?,?,?,?,?,?)').bind(record.key, id, record.table === 'attendance_events' ? 'event' : 'correction', fixture.archive.manifest.centerId, record.row.payload_hash, record.table, record.key));
  }
  statements.push(db.prepare('UPDATE archive_publication_parts SET indexed_count=?,completed=? WHERE publication_id=? AND part_index=?').bind(nextOffset, complete ? 1 : 0, id, before.next_part));
  statements.push(db.prepare(`UPDATE archive_publication_builds SET next_part=?,next_offset=?,indexed_count=indexed_count+?,request_count=request_count+?,counts_json=?,locator_digest=?,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now} WHERE publication_id=?`)
    .bind(before.next_part + (complete ? 1 : 0), complete ? 0 : nextOffset, records.length, requests.length, JSON.stringify(counts), hash(before.locator_digest + JSON.stringify(records)), id));
  await db.batch(statements);
}
async function finish(id: string) {
  await claim(id);
  const db = fixture.app.db;
  await db.batch([
    db.prepare(`UPDATE archive_publication_builds SET state='published',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=${now} WHERE publication_id=?`).bind(id),
    db.prepare(`INSERT INTO archive_publications(publication_id,verification_id,generation,run_id,snapshot_commit_token,graph_sha256,validator_version,archive_id,center_id,month,timezone,root_reference_json,header_json,header_sha256,manifest_object_key,manifest_sha256,format,locator_version,record_count,request_count,counts_json,locator_digest,published_at)
      SELECT publication_id,verification_id,generation,run_id,snapshot_commit_token,graph_sha256,validator_version,archive_id,center_id,month,timezone,root_reference_json,header_json,header_sha256,json_extract(root_reference_json,'$.manifestObjectKey'),json_extract(root_reference_json,'$.manifestSha256'),'kumon-history-archive-v2',1,record_count,request_count,counts_json,locator_digest,${now} FROM archive_publication_builds WHERE publication_id=?`).bind(id),
    db.prepare("INSERT INTO archive_publication_availability(publication_id,generation,status) SELECT publication_id,generation,'ready' FROM archive_publications WHERE publication_id=?").bind(id),
  ]);
}
async function publish() { const id = await begin(); while ((await build(id))!.next_part < fixture.archive.manifest.parts.length) await page(id); await finish(id); return id; }
const visible = () => fixture.app.db.prepare(`SELECT p.publication_id FROM archive_publications p JOIN archive_publication_availability a ON a.publication_id=p.publication_id JOIN history_runtime h ON h.id=1 WHERE ${archivePublicationVisibleSql()}`).all();

describe('schema25 publication foundation', () => {
  it('requires the completed validator run even when its old session remains verified', async () => {
    const db = fixture.app.db;
    await db.prepare("UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL WHERE run_id=?").bind(fixture.handle.runId).run();
    expect(await db.prepare('SELECT status FROM archive_semantic_sessions WHERE verification_id=?').bind(fixture.handle.verificationId).first('status')).toBe('verified');
    await expect(begin()).rejects.toThrow('ARCHIVE_PUBLICATION_PROOF_INVALID');
    expect(await db.prepare('SELECT count(*) n FROM archive_publication_builds').first('n')).toBe(0);
    expect(() => archivePublicationProofSql('b;DROP TABLE x')).toThrow('SQL_ALIAS_INVALID');
  });

  it('admits only completed current proof, keeps partial candidates hidden, and validates terminal totals', async () => {
    expect(await fixture.app.db.prepare('SELECT max(version) version FROM schema_versions').first('version')).toBe(42);
    const id = await begin();
    expect(await fixture.app.db.prepare(`SELECT ${archivePublicationProofSql()} AS valid FROM archive_publication_builds b WHERE publication_id=?`).bind(id).first('valid')).toBe(1);
    await expect(begin()).rejects.toThrow();
    await page(id);
    expect((await visible()).results).toEqual([]);
    await expect(finish(id)).rejects.toThrow('ARCHIVE_PUBLICATION_BUILD_INVALID');
    // The failed final batch leaves its acquired lease; release it without progress.
    await fixture.app.db.prepare(`UPDATE archive_publication_builds SET lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=${now} WHERE publication_id=?`).bind(id).run();
    while ((await build(id))!.next_part < fixture.archive.manifest.parts.length) await page(id);
    await finish(id);
    expect((await visible()).results).toEqual([{ publication_id: id }]);
    expect((await build(id))!.indexed_count).toBe(fixture.archive.manifest.recordCount);
    const recordCounts = JSON.parse((await build(id))!.counts_json) as ArchiveCounts;
    for (const table of ARCHIVE_TABLES) expect(recordCounts[table]).toBe(fixture.archive.manifest.recordCounts[table]);
  });

  it('refuses record, descriptor, request and published-build mutation or replacement', async () => {
    const id = await publish(), db = fixture.app.db;
    await expect(db.prepare('UPDATE archive_publication_records SET record_sha256=? WHERE publication_id=?').bind('f'.repeat(64), id).run()).rejects.toThrow();
    await expect(db.prepare('DELETE FROM archive_publication_records WHERE publication_id=?').bind(id).run()).rejects.toThrow();
    await expect(db.prepare('INSERT OR REPLACE INTO archive_publications SELECT * FROM archive_publications WHERE publication_id=?').bind(id).run()).rejects.toThrow();
    await expect(db.prepare('INSERT OR REPLACE INTO archive_publication_requests SELECT * FROM archive_publication_requests WHERE publication_id=?').bind(id).run()).rejects.toThrow();
    await expect(db.prepare(`UPDATE archive_publication_builds SET state='building',revision=revision+1,updated_at=${now} WHERE publication_id=?`).bind(id).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE archive_publications SET header_json='{}' WHERE publication_id=?").bind(id).run()).rejects.toThrow();
  });

  it('invalidates unfinished builds on restore, preserves published proof and disables availability', async () => {
    const id = await publish(), db = fixture.app.db;
    const descriptor = await db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(id).first();
    const availability = await db.prepare('SELECT * FROM archive_publication_availability WHERE publication_id=?').bind(id).first();
    await db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    expect(await db.prepare('SELECT * FROM archive_publications WHERE publication_id=?').bind(id).first()).toEqual(descriptor);
    expect(await db.prepare('SELECT * FROM archive_publication_availability WHERE publication_id=?').bind(id).first()).toEqual({ ...availability, status: 'unavailable' });
    expect((await build(id))!.state).toBe('published');
    expect((await visible()).results).toEqual([]);
    await expect(db.prepare("UPDATE archive_publication_availability SET status='ready' WHERE publication_id=?").bind(id).run()).rejects.toThrow();
  });

  it('fences pending work on generation reset and maintenance without deleting live source rows', async () => {
    const id = await begin(), db = fixture.app.db;
    await page(id);
    const prior = (await build(id))!, events = await db.prepare('SELECT count(*) n FROM attendance_events').first<number>('n');
    await db.prepare("UPDATE backup_runtime SET write_locked_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+5 minutes') WHERE id=1").run();
    await expect(claim(id)).rejects.toThrow('backup_maintenance');
    await db.prepare('UPDATE backup_runtime SET write_locked_until=NULL WHERE id=1').run();
    await db.prepare("UPDATE history_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1").run();
    expect(await build(id)).toMatchObject({ ...prior, state: 'invalid', revision: prior.revision + 1, lease_token: null, lease_expires_at: null, updated_at: expect.any(String) });
    await expect(claim(id)).rejects.toThrow();
    expect(await db.prepare('SELECT count(*) n FROM attendance_events').first('n')).toBe(events);
    expect((await visible()).results).toEqual([]);
  });

  it('blocks replacement through alternate month and part-ordinal unique keys', async () => {
    const id = await begin(), db = fixture.app.db;
    const original = (await build(id))!, candidate = { ...original, publication_id: crypto.randomUUID() };
    const columns = Object.keys(candidate), values = Object.entries(candidate).filter(([column]) => column !== 'created_at' && column !== 'updated_at').map(([, value]) => value);
    await expect(db.prepare(`INSERT OR REPLACE INTO archive_publication_builds(${columns.join(',')}) VALUES(${columns.map(column => column === 'created_at' || column === 'updated_at' ? now : '?').join(',')})`).bind(...values).run()).rejects.toThrow();
    expect(await build(id)).toEqual(original);
    await claim(id);
    const descriptor = fixture.archive.manifest.parts[0], first = fixture.records[0], second = fixture.records[1];
    await db.prepare('INSERT INTO archive_publication_parts(publication_id,part_index,descriptor_json,descriptor_sha256,record_count) VALUES(?,?,?,?,?)').bind(id, 0, JSON.stringify(descriptor), hash(JSON.stringify(descriptor)), descriptor.recordCount).run();
    const insert = (record: ArchiveRecord, replace = false) => db.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO archive_publication_records VALUES(?,?,?,?,?,?,?,?)`).bind(id, record.table, record.key, 0, 0, hash(JSON.stringify(descriptor)), hash(JSON.stringify(record)), Buffer.byteLength(JSON.stringify(record)));
    await insert(first).run();
    await expect(insert(second, true).run()).rejects.toThrow();
    expect((await db.prepare('SELECT table_name,record_key FROM archive_publication_records WHERE publication_id=?').bind(id).all()).results).toEqual([{ table_name: first.table, record_key: first.key }]);
  });

  it('rejects an ordinal gap and rolls back its whole candidate page', async () => {
    const id = await begin(), db = fixture.app.db;
    await claim(id);
    const descriptor = fixture.archive.manifest.parts[0], record = fixture.records[1], text = JSON.stringify(record);
    await expect(db.batch([
      db.prepare('INSERT INTO archive_publication_parts(publication_id,part_index,descriptor_json,descriptor_sha256,record_count) VALUES(?,?,?,?,?)').bind(id, 0, JSON.stringify(descriptor), hash(JSON.stringify(descriptor)), descriptor.recordCount),
      db.prepare('INSERT INTO archive_publication_records VALUES(?,?,?,?,?,?,?,?)').bind(id, record.table, record.key, 0, 1, hash(JSON.stringify(descriptor)), hash(text), Buffer.byteLength(text)),
      db.prepare('UPDATE archive_publication_parts SET indexed_count=1 WHERE publication_id=? AND part_index=0').bind(id),
    ])).rejects.toThrow('ARCHIVE_PUBLICATION_PART_INVALID');
    expect(await db.prepare('SELECT count(*) n FROM archive_publication_records WHERE publication_id=?').bind(id).first('n')).toBe(0);
    expect(await db.prepare('SELECT count(*) n FROM archive_publication_parts WHERE publication_id=?').bind(id).first('n')).toBe(0);
    expect((await build(id))!.indexed_count).toBe(0);
  });

  it('checks whether immutable audit source equality uses bounded point lookups', async () => {
    const record = fixture.records.find(record => record.table === 'audit_entries')!;
    const equal = Object.keys(record.row).map(column => `s."${column}" IS json_extract(payload.j,'$.${column}')`).join(' AND ');
    const sql = `WITH payload(j) AS (SELECT ?) SELECT EXISTS(SELECT 1 FROM audit_timeline s,payload WHERE s.id=? AND ${equal})`;
    const plan = (await fixture.app.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(JSON.stringify(record.row), record.key).all<{ detail: string }>()).results;
    await mkdir('tmp', { recursive: true });
    await writeFile('tmp/publication25-audit-plan.json', JSON.stringify({ sql, plan }, null, 2));
    expect(plan.map(row => row.detail).join('\n')).not.toMatch(/SCAN (?:audit_entries|attendance_events|attendance_corrections|e\b|c\b)/);
  });
});
