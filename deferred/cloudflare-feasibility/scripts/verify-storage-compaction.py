#!/usr/bin/env python3
"""Apply the shipped migration to a private fixture copy and measure equivalence."""
import argparse
import hashlib
import json
from pathlib import Path
import sqlite3
import time

parser = argparse.ArgumentParser()
parser.add_argument('source', type=Path)
parser.add_argument('destination', type=Path)
parser.add_argument('--result', type=Path, required=True)
args = parser.parse_args()
if args.destination.exists():
    raise SystemExit('Refusing to overwrite an existing database')
args.destination.parent.mkdir(parents=True, exist_ok=True)

def rows_digest(connection, query):
    digest, count = hashlib.sha256(), 0
    for row in connection.execute(query):
        digest.update(json.dumps(row, separators=(',', ':'), ensure_ascii=False).encode())
        digest.update(b'\n')
        count += 1
    return {'sha256': digest.hexdigest(), 'count': count}

with sqlite3.connect(f'file:{args.source.resolve()}?mode=ro', uri=True) as source:
    with sqlite3.connect(args.destination) as db:
        source.backup(db)
        before = rows_digest(db, 'SELECT * FROM audit_entries ORDER BY id')
        events_before = rows_digest(db, 'SELECT id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce FROM attendance_events ORDER BY id')
        corrections_before = rows_digest(db, 'SELECT * FROM attendance_corrections ORDER BY id')
        initial_bytes = args.destination.stat().st_size
        started = time.monotonic()
        sql = (Path(__file__).resolve().parents[1] / 'migrations/0007_storage_compaction.sql').read_text()
        try:
            db.executescript('BEGIN IMMEDIATE;\n' + sql + '\nCOMMIT;')
        except BaseException:
            db.rollback()
            raise
        migration_seconds = time.monotonic() - started
        after = rows_digest(db, 'SELECT * FROM audit_timeline ORDER BY id')
        events_after = rows_digest(db, 'SELECT id,center_id,student_id,visit_id,action,observed_at,received_at,actor_id,actor_name,channel,device_id,guardian_id,reason,payload_hash,insertion_nonce FROM attendance_events ORDER BY id')
        corrections_after = rows_digest(db, 'SELECT * FROM attendance_corrections ORDER BY id')
        assert before == after, 'Logical audit differs'
        assert events_before == events_after, 'Immutable observations differ'
        assert corrections_before == corrections_after, 'Immutable corrections differ'
        assert db.execute('PRAGMA integrity_check').fetchall() == [('ok',)]
        assert db.execute('PRAGMA foreign_key_check').fetchall() == []
        pages_after = db.execute('PRAGMA page_count').fetchone()[0]
        free_after = db.execute('PRAGMA freelist_count').fetchone()[0]
        page_size = db.execute('PRAGMA page_size').fetchone()[0]
        physical_audits = db.execute('SELECT count(*) FROM audit_entries').fetchone()[0]
        db.execute('VACUUM')
        result = {'source': str(args.source), 'migration': '0007_storage_compaction.sql',
                  'initialBytes': initial_bytes, 'beforeVacuumBytes': pages_after * page_size,
                  'reusableFreeBytes': free_after * page_size, 'vacuumedBytes': args.destination.stat().st_size,
                  'migrationSeconds': round(migration_seconds, 3), 'audit': after,
                  'physicalAuditRows': physical_audits, 'events': events_after, 'corrections': corrections_after,
                  'integrity': 'ok', 'foreignKeys': 'ok',
                  'limitation': 'Local SQLite fixture copy. This does not measure a deployed D1 migration or Workers CPU.'}
        args.result.parent.mkdir(parents=True, exist_ok=True)
        args.result.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2))
