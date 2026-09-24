#!/usr/bin/env python3
"""Synthetic, local-only archive sizing; not a production archive/eviction tool."""
import argparse, collections, datetime as dt, gzip, hashlib, json, os, pathlib, sqlite3, tempfile, time, urllib.parse

parser=argparse.ArgumentParser()
parser.add_argument('--baseline', required=True)
parser.add_argument('--output-root', required=True)
parser.add_argument('--as-of', default=dt.datetime.now(dt.timezone.utc).date().isoformat())
args=parser.parse_args()
baseline=pathlib.Path(args.baseline).resolve()
if baseline.name != 'baseline.sqlite' or baseline.parent.name != 'storage-audit': raise SystemExit('Use the explicitly prepared synthetic storage-audit/baseline.sqlite only.')
root=pathlib.Path(args.output_root).resolve();root.mkdir(parents=True,exist_ok=True)
output=pathlib.Path(tempfile.mkdtemp(prefix='measurement-',dir=root));os.chmod(output,0o700)
source=sqlite3.connect('file:'+urllib.parse.quote(str(baseline))+'?mode=ro',uri=True);source.row_factory=sqlite3.Row
source.execute('PRAGMA temp_store=MEMORY');source.execute('PRAGMA foreign_keys=ON')
if source.execute("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE '%hold%'").fetchall(): raise SystemExit('Unrecognized holds schema: adapt hold eligibility before measuring.')
as_of=dt.datetime.fromisoformat(args.as_of).replace(tzinfo=dt.timezone.utc)
cutoff90=as_of-dt.timedelta(days=90)
cutoff=cutoff90.replace(day=1).isoformat(timespec='milliseconds').replace('+00:00','Z')
start=time.perf_counter()
source.execute('''CREATE TEMP TABLE eligible_visits AS SELECT v.id, substr(v.original_check_in_at,1,7) AS month FROM visits v
 WHERE v.check_out_at IS NOT NULL AND v.original_check_out_at IS NOT NULL
 AND v.original_check_in_at<? AND v.original_check_out_at<? AND v.check_in_at<? AND v.check_out_at<? AND v.review_status!='pending'
 AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.visit_id=v.id AND (r.status='pending' OR coalesce(r.resolved_at,r.created_at)>=?))
 AND NOT EXISTS(SELECT 1 FROM attendance_events e WHERE e.visit_id=v.id AND e.received_at>=?)
 AND NOT EXISTS(SELECT 1 FROM attendance_corrections c WHERE c.visit_id=v.id AND c.recorded_at>=?)''',[cutoff]*7)
source.execute('CREATE UNIQUE INDEX eligible_visit_id ON eligible_visits(id)')
source.execute('''CREATE TEMP TABLE eligible_events AS SELECT e.id,v.month FROM attendance_events e JOIN eligible_visits v ON v.id=e.visit_id
 UNION ALL SELECT e.id,substr(e.observed_at,1,7) FROM attendance_events e WHERE e.visit_id IS NULL AND e.observed_at<? AND e.received_at<?
 AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.event_id=e.id AND (r.status='pending' OR coalesce(r.resolved_at,r.created_at)>=?))''',[cutoff]*3)
source.execute('CREATE UNIQUE INDEX eligible_event_id ON eligible_events(id)')
source.execute('CREATE TEMP TABLE eligible_corrections AS SELECT c.id,v.month FROM attendance_corrections c JOIN eligible_visits v ON v.id=c.visit_id')
source.execute('CREATE UNIQUE INDEX eligible_correction_id ON eligible_corrections(id)')
source.execute('CREATE TEMP TABLE eligible_reviews AS SELECT r.id,e.month FROM reviews r JOIN eligible_events e ON e.id=r.event_id')
source.execute('CREATE UNIQUE INDEX eligible_review_id ON eligible_reviews(id)')
source.execute('''CREATE TEMP TABLE eligible_audit AS SELECT a.id,e.month FROM audit_entries a JOIN eligible_events e ON e.id=a.entity_id WHERE a.entity_type='attendance_event'
 UNION SELECT a.id,v.month FROM audit_entries a JOIN eligible_visits v ON v.id=a.entity_id WHERE a.entity_type='visit'
 UNION SELECT a.id,r.month FROM audit_entries a JOIN eligible_reviews r ON r.id=a.entity_id WHERE a.entity_type='review' ''')
source.execute('CREATE UNIQUE INDEX eligible_audit_id ON eligible_audit(id)')
month_rows=source.execute('SELECT DISTINCT month FROM eligible_events UNION SELECT DISTINCT month FROM eligible_visits ORDER BY month').fetchall()
months=[r[0] for r in month_rows]
archive_tables={'visits':'eligible_visits','attendance_events':'eligible_events','attendance_corrections':'eligible_corrections','reviews':'eligible_reviews','audit_entries':'eligible_audit'}
queries={name:f'SELECT t.* FROM "{name}" t JOIN {selection} e ON e.id=t.id WHERE e.month=? ORDER BY t.id' for name,selection in archive_tables.items()}
queries.update({
 'students':'''SELECT s.* FROM students s WHERE s.id IN (SELECT e.student_id FROM attendance_events e JOIN eligible_events x ON x.id=e.id WHERE x.month=?) ORDER BY s.id''',
 'student_guardians':'''SELECT g.* FROM student_guardians g WHERE g.student_id IN (SELECT e.student_id FROM attendance_events e JOIN eligible_events x ON x.id=e.id WHERE x.month=?) ORDER BY g.student_id,g.guardian_id''',
 'guardians':'''SELECT g.* FROM guardians g WHERE g.id IN (SELECT guardian_id FROM student_guardians WHERE student_id IN (SELECT e.student_id FROM attendance_events e JOIN eligible_events x ON x.id=e.id WHERE x.month=?)) ORDER BY g.id''',
 'staff':'''SELECT s.* FROM staff s WHERE s.id IN (SELECT e.actor_id FROM attendance_events e JOIN eligible_events x ON x.id=e.id WHERE x.month=? UNION SELECT c.actor_id FROM attendance_corrections c JOIN eligible_corrections x ON x.id=c.id WHERE x.month=? UNION SELECT r.resolved_by FROM reviews r JOIN eligible_reviews x ON x.id=r.id WHERE x.month=?) ORDER BY s.id''',
 'centers':'SELECT * FROM centers ORDER BY id'
})
archives=[];month_to_id={}
for month in months:
 archive_id='synthetic-'+month;month_to_id[month]=archive_id
 path=output/(month+'.jsonl.gz');raw_hash=hashlib.sha256();raw_bytes=0;counts=collections.Counter();archive_start=time.perf_counter()
 with path.open('xb') as file:
  os.chmod(path,0o600)
  with gzip.GzipFile(filename='',mode='wb',compresslevel=6,fileobj=file,mtime=0) as compressed:
   for table,sql in queries.items():
    parameters=[] if table=='centers' else [month]*sql.count('?')
    for row in source.execute(sql,parameters):
     line=(json.dumps({'table':table,'row':dict(row)},sort_keys=True,separators=(',',':'),ensure_ascii=False)+'\n').encode()
     raw_hash.update(line);raw_bytes+=len(line);counts[table]+=1;compressed.write(line)
 compressed_bytes=path.stat().st_size
 compressed_hash=hashlib.sha256(path.read_bytes()).hexdigest()
 verify_hash=hashlib.sha256();verify_counts=collections.Counter();verify_bytes=0
 with gzip.open(path,'rb') as inflated:
  for line in inflated:
   verify_hash.update(line);verify_bytes+=len(line);verify_counts[json.loads(line)['table']]+=1
 assert verify_hash.hexdigest()==raw_hash.hexdigest() and verify_counts==counts and verify_bytes==raw_bytes
 archives.append({'archiveId':archive_id,'month':month,'counts':dict(counts),'jsonlBytes':raw_bytes,'gzipBytes':compressed_bytes,'gzipFraction':compressed_bytes/raw_bytes,'plaintextSha256':raw_hash.hexdigest(),'compressedSha256':compressed_hash,'roundTripVerified':True,'localSeconds':time.perf_counter()-archive_start})

clone_path=output/'detail-eviction-projection.sqlite';clone=sqlite3.connect(clone_path);clone.row_factory=sqlite3.Row;source.backup(clone);os.chmod(clone_path,0o600)
clone.execute('PRAGMA journal_mode=DELETE');clone.execute('PRAGMA foreign_keys=ON')
original_counts={table:source.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in archive_tables}
selected_counts={table:source.execute(f'SELECT count(*) FROM {selection}').fetchone()[0] for table,selection in archive_tables.items()}
for selection in archive_tables.values():
 clone.execute(f'CREATE TEMP TABLE {selection}(id TEXT PRIMARY KEY,month TEXT)')
 clone.executemany(f'INSERT INTO {selection} VALUES(?,?)',[tuple(r) for r in source.execute(f'SELECT id,month FROM {selection}')])
# These guards are removed ONLY from this disposable sizing clone. A real product
# requires narrowly authorized verified-archive eviction, never disabling guards.
for trigger in ['attendance_no_delete','correction_no_delete','audit_no_delete']:
 clone.execute(f'DROP TRIGGER IF EXISTS {trigger}')
for table in ['reviews','attendance_corrections','attendance_events','visits','audit_entries']:
 clone.execute(f'DELETE FROM {table} WHERE id IN (SELECT id FROM {archive_tables[table]})')
clone.commit();violations=[tuple(row) for row in clone.execute('PRAGMA foreign_key_check')];assert not violations,violations
clone.execute('VACUUM');no_catalog_bytes=clone_path.stat().st_size
# Keep conservative entity tombstones and effective visit intervals in the model.
# They preserve storage for future duplicate-ID lookup and cross-tier overlap
# validation, but this script DOES NOT implement those application behaviors.
clone.executescript('''
CREATE TABLE diagnostic_archive_catalog(id TEXT PRIMARY KEY,month TEXT NOT NULL,filename TEXT NOT NULL,plaintext_sha256 TEXT NOT NULL,compressed_sha256 TEXT NOT NULL,gzip_bytes INTEGER NOT NULL,counts_json TEXT NOT NULL,verified_at TEXT NOT NULL);
CREATE TABLE diagnostic_archived_visits(id TEXT PRIMARY KEY,student_id TEXT NOT NULL,archive_id TEXT NOT NULL REFERENCES diagnostic_archive_catalog(id),check_in_at TEXT NOT NULL,check_out_at TEXT NOT NULL,version INTEGER NOT NULL);
CREATE INDEX diagnostic_archived_visit_intervals ON diagnostic_archived_visits(student_id,check_in_at,check_out_at);
CREATE TABLE diagnostic_archived_events(id TEXT PRIMARY KEY,student_id TEXT NOT NULL,visit_id TEXT,archive_id TEXT NOT NULL REFERENCES diagnostic_archive_catalog(id),payload_hash TEXT NOT NULL,observed_at TEXT NOT NULL);
CREATE TABLE diagnostic_archived_corrections(id TEXT PRIMARY KEY,visit_id TEXT NOT NULL,archive_id TEXT NOT NULL REFERENCES diagnostic_archive_catalog(id),payload_hash TEXT NOT NULL);
CREATE TABLE diagnostic_archive_student_month(student_id TEXT NOT NULL,archive_id TEXT NOT NULL REFERENCES diagnostic_archive_catalog(id),PRIMARY KEY(student_id,archive_id));
''')
for record in archives:
 clone.execute('INSERT INTO diagnostic_archive_catalog VALUES(?,?,?,?,?,?,?,?)',[record['archiveId'],record['month'],record['month']+'.jsonl.gz',record['plaintextSha256'],record['compressedSha256'],record['gzipBytes'],json.dumps(record['counts']),args.as_of])
clone.executemany('INSERT INTO diagnostic_archived_visits VALUES(?,?,?,?,?,?)',[(r['id'],r['student_id'],month_to_id[r['month']],r['check_in_at'],r['check_out_at'],r['version']) for r in source.execute('SELECT v.*,x.month FROM visits v JOIN eligible_visits x ON x.id=v.id')])
clone.executemany('INSERT INTO diagnostic_archived_events VALUES(?,?,?,?,?,?)',[(r['id'],r['student_id'],r['visit_id'],month_to_id[r['month']],r['payload_hash'],r['observed_at']) for r in source.execute('SELECT e.*,x.month FROM attendance_events e JOIN eligible_events x ON x.id=e.id')])
clone.executemany('INSERT INTO diagnostic_archived_corrections VALUES(?,?,?,?)',[(r['id'],r['visit_id'],month_to_id[r['month']],r['payload_hash']) for r in source.execute('SELECT c.*,x.month FROM attendance_corrections c JOIN eligible_corrections x ON x.id=c.id')])
clone.execute('INSERT INTO diagnostic_archive_student_month SELECT DISTINCT student_id,archive_id FROM diagnostic_archived_events')
clone.commit();assert not clone.execute('PRAGMA foreign_key_check').fetchall();clone.execute('VACUUM');with_catalog_bytes=clone_path.stat().st_size
retained_counts={table:clone.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0] for table in archive_tables}
assert all(original_counts[t]==selected_counts[t]+retained_counts[t] for t in archive_tables)
# Verify whole bundles can be rehydrated from the gzip archives without any lost
# source values. No import into the clone is attempted because production SQLite
# triggers replay business operations; a guarded archive restoration path is new work.
all_fields_verified=all(record['roundTripVerified'] for record in archives)
report={'syntheticOnly':True,'baseline':str(baseline),'output':str(output),'asOf':args.as_of,'ninetyDayCutoff':cutoff90.isoformat(),'fullMonthArchiveCutoff':cutoff,'bucketBasis':'Original arrival UTC month for synthetic sizing; production needs center timezone boundaries.',
 'baselineFileBytes':baseline.stat().st_size,'archivedMonths':len(archives),'originalCounts':original_counts,'archivedCounts':selected_counts,'retainedCounts':retained_counts,'jsonlBytes':sum(x['jsonlBytes'] for x in archives),'gzipBytes':sum(x['gzipBytes'] for x in archives),'evictedCloneBytesWithoutCatalog':no_catalog_bytes,'evictedCloneBytesWithIllustrativeCatalogAndIdentityIntervalRefs':with_catalog_bytes,'catalogReferenceBytes':with_catalog_bytes-no_catalog_bytes,'foreignKeyViolations':violations,'allArchiveRoundTripsVerified':all_fields_verified,'localSeconds':time.perf_counter()-start,'archives':archives,
 'limitations':['Synthetic IDs, repeated names/notes, and fixture structure can compress better than real customer data.','Includes every column of archived evidence and copied referenced identity rows; production must intentionally minimize authentication/PII fields in dictionaries.','Open visits, pending reviews, recent correction/receipt/resolution timestamps were excluded. No hold model exists in current schema; actual holds must be implemented before eviction.','Archive artifacts are plaintext gzip synthetic measurements, not encrypted production backups. Encryption framing, object metadata, independent copies and backup retention are excluded.','The clone drops immutable DELETE guards and VACUUMs ONLY for sizing. Production needs narrowly guarded verified archive eviction plus history/retry/correction/overlap readers across both stores.','Illustrative live catalogs and entity references are sized but not production implementations. Correction addenda, per-user authorization, real holds and reconciliation may add storage.','Historical latency and deployed Worker CPU/memory are not measured.','The original database was opened read-only; all profiling mutations were confined to the newly created diagnostic clone.']}
(report_path:=output/'report.json').write_text(json.dumps(report,indent=2)+'\n');os.chmod(report_path,0o600)
print(json.dumps({k:v for k,v in report.items() if k not in ['archives','limitations']},indent=2))
clone.close();source.close()
