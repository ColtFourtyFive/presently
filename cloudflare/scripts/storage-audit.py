"""Profile an isolated SQLite fixture and disposable copies, never a live database.

Called by storage-audit.ts with the ephemeral test database. dbstat separates
table payload, indexes, allocated slack, and free pages. Counterfactual copies
are attribution experiments, not application-compatible migrations.
"""
import json
import sqlite3
import sys
from pathlib import Path

source, output = Path(sys.argv[1]), Path(sys.argv[2])
if not any(part.startswith('kumon-cloudflare-test-') for part in source.parts):
    raise SystemExit('Source must be the isolated Cloudflare test runtime.')
output.mkdir(parents=True, exist_ok=True)
baseline = output / 'baseline.sqlite'
if baseline.exists():
    raise SystemExit('Refusing to overwrite existing diagnostic evidence.')

def connect(path):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return con

original = sqlite3.connect(f'{source.as_uri()}?mode=ro', uri=True)
con = connect(baseline)
original.backup(con)
original.close()
if not con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attendance_events'").fetchone():
    raise SystemExit('The isolated source does not contain the expected CRM schema.')

def size(db):
    page_size = db.execute('PRAGMA page_size').fetchone()[0]
    pages = db.execute('PRAGMA page_count').fetchone()[0]
    free = db.execute('PRAGMA freelist_count').fetchone()[0]
    return dict(pageSize=page_size, pages=pages, freePages=free,
                databaseBytes=page_size*pages, freeBytes=page_size*free)

def quoted(name):
    return '"' + name.replace('"', '""') + '"'

objects = [dict(r) for r in con.execute("SELECT name,type,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index')")]
stats = [dict(r) for r in con.execute('SELECT name, count(*) pages, sum(pgsize) bytes, sum(payload) payloadBytes, sum(unused) unusedBytes, sum(ncell) cells FROM dbstat GROUP BY name ORDER BY bytes DESC')]
object_by_name = {o['name']:o for o in objects}
for row in stats:
    row.update({k:object_by_name.get(row['name'],{}).get(k) for k in ['type','tbl_name']})
tables = {}
for table in [o['name'] for o in objects if o['type']=='table' and not o['name'].startswith(('sqlite_', '_cf_'))]:
    q = quoted(table)
    columns = []
    for c in con.execute(f'PRAGMA table_info({q})').fetchall():
        name = c['name']; col = quoted(name)
        total, average, maximum, blobs = con.execute(f'SELECT coalesce(sum(length(CAST({col} AS BLOB))),0), avg(length(CAST({col} AS BLOB))), max(length(CAST({col} AS BLOB))), sum(typeof({col})=\'blob\') FROM {q}').fetchone()
        columns.append(dict(name=name, declaredType=c['type'], logicalBytes=total, averageBytes=average, maxBytes=maximum, blobRows=blobs or 0))
    tables[table] = dict(rows=con.execute(f'SELECT count(*) FROM {q}').fetchone()[0], columns=columns)

report = dict(sqliteVersion=sqlite3.sqlite_version, fixture=json.loads((output/'fixture.json').read_text()),
              baseline=size(con), objects=stats, tables=tables,
              centers=[dict(r) for r in con.execute('SELECT id,name FROM centers')],
              integrity=con.execute('PRAGMA quick_check').fetchone()[0],
              foreignKeyViolations=len(con.execute('PRAGMA foreign_key_check').fetchall()))

def experiment(name, sql=None):
    target = output / (name+'.sqlite')
    if target.exists():
        raise RuntimeError('Refusing to overwrite experiment: '+name)
    copy = connect(target)
    con.backup(copy)
    if sql:
        copy.executescript(sql)
    copy.execute('VACUUM')
    result = size(copy)
    result['integrity'] = copy.execute('PRAGMA quick_check').fetchone()[0]
    copy.close()
    result['savedBytesFromBaseline'] = report['baseline']['databaseBytes']-result['databaseBytes']
    return result

compact_receipt_sql = """DROP TRIGGER attendance_no_update;
UPDATE attendance_events SET result_visit=CASE WHEN json_type(result_visit)='null' THEN 'null' ELSE
json_array(2,json_extract(result_visit,'$.studentName'),json_extract(result_visit,'$.studentCode'),
json_extract(result_visit,'$.active'),json_extract(result_visit,'$.checkInAt'),
json_extract(result_visit,'$.originalCheckInAt'),json_extract(result_visit,'$.checkInBy'),
json_extract(result_visit,'$.checkOutBy'),json_extract(result_visit,'$.guardianName'),
json_extract(result_visit,'$.version')) END;
"""
partial_open_index_sql = """DROP INDEX visits_center_open;
CREATE INDEX visits_center_open ON visits(center_id,check_in_at) WHERE check_out_at IS NULL;
"""
report['experiments'] = {
  'vacuumOnly': experiment('vacuum-only'),
  'omitResponseSnapshotAttributionOnly': experiment('omit-response-snapshot', 'DROP TRIGGER attendance_no_update; UPDATE attendance_events SET result_visit=NULL;'),
  'omitDuplicateAttendanceAuditAttributionOnly': experiment('omit-attendance-audit', "DROP TRIGGER audit_no_delete; DELETE FROM audit_entries WHERE entity_type='attendance_event';"),
  'omitBothAttributionOnly': experiment('omit-both', "DROP TRIGGER attendance_no_update; UPDATE attendance_events SET result_visit=NULL; DROP TRIGGER audit_no_delete; DELETE FROM audit_entries WHERE entity_type='attendance_event';"),
  'compactReceiptCandidate': experiment('compact-receipts', compact_receipt_sql),
  'partialOpenVisitIndex': experiment('partial-open-index', partial_open_index_sql),
  'compactReceiptAndLogicalAuditCandidate': experiment('compact-and-logical-audit', compact_receipt_sql + "DROP TRIGGER audit_no_delete; DELETE FROM audit_entries WHERE entity_type='attendance_event';" + partial_open_index_sql),
}
checked = 0
compact = connect(output / 'compact-receipts.sqlite')
original_rows = con.execute('SELECT id,result_visit,visit_id,student_id,action,observed_at FROM attendance_events ORDER BY id')
compact_rows = compact.execute('SELECT id,result_visit FROM attendance_events ORDER BY id')
for row, encoded in zip(original_rows, compact_rows, strict=True):
    if row['id'] != encoded['id']:
        raise RuntimeError('Candidate receipt identity mismatch.')
    value = json.loads(row['result_visit'])
    decoded = json.loads(encoded['result_visit'])
    if value is None:
        if decoded is not None:
            raise RuntimeError('Candidate changed a sealed null receipt.')
        continue
    if decoded[0] != 2 or len(decoded) != 10:
        raise RuntimeError('Unexpected compact receipt version or fields.')
    restored = dict(zip(['studentName','studentCode','active','checkInAt','originalCheckInAt','checkInBy','checkOutBy','guardianName','version'], decoded[1:], strict=True))
    restored['active'] = bool(restored['active'])
    restored.update(id=row['visit_id'],studentId=row['student_id'],
        checkOutAt=None if row['action']=='check_in' else row['observed_at'],
        originalCheckOutAt=None if row['action']=='check_in' else row['observed_at'],
        departureType=None if row['action']=='check_in' else row['action'],
        reviewStatus='pending' if row['action']=='exceptional_departure' else 'none')
    if restored != value:
        raise RuntimeError('Candidate receipt reconstruction did not preserve fixture response.')
    checked += 1
compact.close()
report['candidateReceiptReconstruction'] = dict(checked=checked, matched=checked,
    limitation='Only fixture actions are verified here; product migration and exceptional/corrected/concurrent edge-case tests are still required.')
report['warning'] = 'Omission variants remove application data/guards only in disposable clones for storage attribution. They are not proposed production migrations or proof of equivalent behavior.'
con.close()
(output/'results.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['baseline','centers','integrity','foreignKeyViolations','experiments']},indent=2))
print('Detailed table, index, and column evidence: '+str(output/'results.json'))
