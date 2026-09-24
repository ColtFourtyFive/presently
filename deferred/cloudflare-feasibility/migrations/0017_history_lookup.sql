-- Durable request ownership and shadow visit intervals. No deletion or archive
-- activation is enabled by this migration. Backfill runs in bounded D1 batches.
CREATE TABLE history_request_keys (
  request_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('event','correction','audit')),
  center_id TEXT NOT NULL REFERENCES centers(id),
  payload_hash TEXT,
  hash_encoding TEXT NOT NULL CHECK(hash_encoding IN ('hex-sha256','base64-sha256','base64url-sha256','opaque','none')),
  canonicalization TEXT NOT NULL DEFAULT 'legacy-unverified' CHECK(canonicalization='legacy-unverified'),
  CHECK((source_kind='audit' AND payload_hash IS NULL AND hash_encoding='none') OR
        (source_kind!='audit' AND payload_hash IS NOT NULL AND hash_encoding!='none'))
) WITHOUT ROWID;
CREATE TABLE history_visit_heads (
  visit_id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  original_check_in_at TEXT NOT NULL,
  original_check_out_at TEXT,
  check_in_at TEXT NOT NULL,
  check_out_at TEXT,
  version INTEGER NOT NULL CHECK(version>=1),
  review_status TEXT NOT NULL CHECK(review_status IN ('none','pending','resolved')),
  residency TEXT NOT NULL DEFAULT 'live' CHECK(residency='live'),
  CHECK(check_out_at IS NULL OR check_out_at>=check_in_at)
) WITHOUT ROWID;
CREATE INDEX history_heads_student_interval ON history_visit_heads(student_id,check_in_at,check_out_at);
CREATE INDEX history_heads_center_interval ON history_visit_heads(center_id,check_in_at,visit_id);
CREATE TABLE history_record_locations (
  record_kind TEXT NOT NULL CHECK(record_kind IN ('event','correction','audit','visit')),
  record_id TEXT NOT NULL,
  center_id TEXT NOT NULL REFERENCES centers(id),
  archive_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  PRIMARY KEY(record_kind,record_id)
) WITHOUT ROWID;
CREATE TRIGGER history_locations_disabled BEFORE INSERT ON history_record_locations
BEGIN SELECT RAISE(ABORT,'HISTORY_ARCHIVE_ACTIVATION_DISABLED'); END;
CREATE TRIGGER history_locations_no_update BEFORE UPDATE ON history_record_locations
BEGIN SELECT RAISE(ABORT,'HISTORY_ARCHIVE_ACTIVATION_DISABLED'); END;
CREATE TRIGGER history_locations_no_delete BEFORE DELETE ON history_record_locations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_LOCATION'); END;
CREATE TABLE history_runtime (
  id INTEGER PRIMARY KEY CHECK(id=1),
  generation TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('backfilling','ready')),
  updated_at TEXT NOT NULL
);
CREATE TABLE history_backfill_jobs (
  source TEXT PRIMARY KEY CHECK(source IN ('events','corrections','audits','visits')),
  generation TEXT NOT NULL,
  cursor TEXT,
  processed INTEGER NOT NULL DEFAULT 0 CHECK(processed>=0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete')),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
-- Seed before maintenance barriers: the installer migrates under a write lock.
INSERT INTO history_runtime VALUES(1,lower(hex(randomblob(16))),'backfilling',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO history_backfill_jobs(source,generation,updated_at)
SELECT value,generation,updated_at FROM history_runtime,json_each('["events","corrections","audits","visits"]');
CREATE TRIGGER history_runtime_assert BEFORE UPDATE ON history_runtime
WHEN NEW.state NOT IN ('backfilling','ready') BEGIN
  SELECT CASE WHEN NEW.state='stale' THEN RAISE(ABORT,'HISTORY_BACKFILL_STALE')
    ELSE RAISE(ABORT,'HISTORY_PROJECTION_MISMATCH') END;
END;
CREATE TRIGGER history_runtime_no_delete BEFORE DELETE ON history_runtime
BEGIN SELECT RAISE(ABORT,'HISTORY_RUNTIME_REQUIRED'); END;
CREATE TRIGGER history_keys_no_replace BEFORE INSERT ON history_request_keys
WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_KEY'); END;
CREATE TRIGGER history_keys_no_update BEFORE UPDATE ON history_request_keys
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_KEY'); END;
CREATE TRIGGER history_keys_no_delete BEFORE DELETE ON history_request_keys
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_KEY'); END;
CREATE TRIGGER history_heads_no_delete BEFORE DELETE ON history_visit_heads
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_HEAD'); END;

-- Source rows own their keys; physical audit aliases never claim ownership.
CREATE TRIGGER history_event_reservation BEFORE INSERT ON attendance_events
WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id)
    OR NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id
      AND source_kind='event' AND center_id=NEW.center_id AND payload_hash IS NEW.payload_hash)
    THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END;
END;
CREATE TRIGGER history_event_capture AFTER INSERT ON attendance_events
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
    THEN RAISE(ABORT,'IMMUTABLE_HISTORY_SOURCE') END;
  INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding)
  SELECT NEW.id,'event',NEW.center_id,NEW.payload_hash,iif(length(NEW.payload_hash)=64 AND NEW.payload_hash NOT GLOB '*[^0-9a-fA-F]*','hex-sha256',iif(length(NEW.payload_hash)=44 AND substr(NEW.payload_hash,44,1)='=' AND substr(NEW.payload_hash,1,43) NOT GLOB '*[^A-Za-z0-9+/]*','base64-sha256',iif(length(NEW.payload_hash)=43 AND NEW.payload_hash NOT GLOB '*[^A-Za-z0-9_-]*','base64url-sha256','opaque')))
  WHERE NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id);
END;

-- Source rows own their keys; physical audit aliases never claim ownership.
CREATE TRIGGER history_correction_reservation BEFORE INSERT ON attendance_corrections
WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id)
    OR NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id
      AND source_kind='correction' AND center_id=NEW.center_id AND payload_hash IS NEW.payload_hash)
    THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END;
END;
CREATE TRIGGER history_correction_capture AFTER INSERT ON attendance_corrections
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
    THEN RAISE(ABORT,'IMMUTABLE_HISTORY_SOURCE') END;
  INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding)
  SELECT NEW.id,'correction',NEW.center_id,NEW.payload_hash,iif(length(NEW.payload_hash)=64 AND NEW.payload_hash NOT GLOB '*[^0-9a-fA-F]*','hex-sha256',iif(length(NEW.payload_hash)=44 AND substr(NEW.payload_hash,44,1)='=' AND substr(NEW.payload_hash,1,43) NOT GLOB '*[^A-Za-z0-9+/]*','base64-sha256',iif(length(NEW.payload_hash)=43 AND NEW.payload_hash NOT GLOB '*[^A-Za-z0-9_-]*','base64url-sha256','opaque')))
  WHERE NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id);
END;

-- Source rows own their keys; physical audit aliases never claim ownership.
CREATE TRIGGER history_audit_reservation BEFORE INSERT ON audit_entries
WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM audit_entries WHERE id=NEW.id)
    OR NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id
      AND source_kind='audit' AND center_id=NEW.center_id AND payload_hash IS NULL)
    THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END;
END;
CREATE TRIGGER history_audit_capture AFTER INSERT ON audit_entries
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id)
    THEN RAISE(ABORT,'IMMUTABLE_HISTORY_SOURCE') END;
  INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding)
  SELECT NEW.id,'audit',NEW.center_id,NULL,'none'
  WHERE NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id);
END;

CREATE TRIGGER history_heads_validate_insert BEFORE INSERT ON history_visit_heads
WHEN NEW.residency!='live' OR NOT EXISTS(SELECT 1 FROM visits v WHERE v.id=NEW.visit_id AND v.center_id IS NEW.center_id AND v.student_id IS NEW.student_id AND v.original_check_in_at IS NEW.original_check_in_at AND v.original_check_out_at IS NEW.original_check_out_at AND v.check_in_at IS NEW.check_in_at AND v.check_out_at IS NEW.check_out_at AND v.version IS NEW.version AND v.review_status IS NEW.review_status)
BEGIN SELECT RAISE(ABORT,'HISTORY_PROJECTION_MISMATCH'); END;

CREATE TRIGGER history_heads_validate_update BEFORE UPDATE ON history_visit_heads
WHEN NEW.visit_id IS NOT OLD.visit_id OR NEW.residency!='live' OR NOT EXISTS(SELECT 1 FROM visits v WHERE v.id=NEW.visit_id AND v.center_id IS NEW.center_id AND v.student_id IS NEW.student_id AND v.original_check_in_at IS NEW.original_check_in_at AND v.original_check_out_at IS NEW.original_check_out_at AND v.check_in_at IS NEW.check_in_at AND v.check_out_at IS NEW.check_out_at AND v.version IS NEW.version AND v.review_status IS NEW.review_status)
BEGIN SELECT RAISE(ABORT,'HISTORY_PROJECTION_MISMATCH'); END;

CREATE TRIGGER history_visit_insert AFTER INSERT ON visits BEGIN
  INSERT INTO history_visit_heads(visit_id,center_id,student_id,original_check_in_at,original_check_out_at,check_in_at,check_out_at,version,review_status,residency)
  VALUES(NEW.id,NEW.center_id,NEW.student_id,NEW.original_check_in_at,NEW.original_check_out_at,NEW.check_in_at,NEW.check_out_at,NEW.version,NEW.review_status,'live')
  ON CONFLICT(visit_id) DO UPDATE SET center_id=excluded.center_id,student_id=excluded.student_id,original_check_in_at=excluded.original_check_in_at,original_check_out_at=excluded.original_check_out_at,check_in_at=excluded.check_in_at,check_out_at=excluded.check_out_at,version=excluded.version,review_status=excluded.review_status,residency='live';
END;

CREATE TRIGGER history_visit_update AFTER UPDATE ON visits BEGIN
  INSERT INTO history_visit_heads(visit_id,center_id,student_id,original_check_in_at,original_check_out_at,check_in_at,check_out_at,version,review_status,residency)
  VALUES(NEW.id,NEW.center_id,NEW.student_id,NEW.original_check_in_at,NEW.original_check_out_at,NEW.check_in_at,NEW.check_out_at,NEW.version,NEW.review_status,'live')
  ON CONFLICT(visit_id) DO UPDATE SET center_id=excluded.center_id,student_id=excluded.student_id,original_check_in_at=excluded.original_check_in_at,original_check_out_at=excluded.original_check_out_at,check_in_at=excluded.check_in_at,check_out_at=excluded.check_out_at,version=excluded.version,review_status=excluded.review_status,residency='live';
END;

CREATE TRIGGER backup_guard_history_request_keys_insert BEFORE INSERT ON history_request_keys
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_request_keys_update BEFORE UPDATE ON history_request_keys
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_request_keys_delete BEFORE DELETE ON history_request_keys
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_visit_heads_insert BEFORE INSERT ON history_visit_heads
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_visit_heads_update BEFORE UPDATE ON history_visit_heads
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_visit_heads_delete BEFORE DELETE ON history_visit_heads
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_record_locations_insert BEFORE INSERT ON history_record_locations
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_record_locations_update BEFORE UPDATE ON history_record_locations
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_record_locations_delete BEFORE DELETE ON history_record_locations
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_runtime_insert BEFORE INSERT ON history_runtime
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_runtime_update BEFORE UPDATE ON history_runtime
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_runtime_delete BEFORE DELETE ON history_runtime
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_backfill_jobs_insert BEFORE INSERT ON history_backfill_jobs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_backfill_jobs_update BEFORE UPDATE ON history_backfill_jobs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_guard_history_backfill_jobs_delete BEFORE DELETE ON history_backfill_jobs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

-- Keep immutable request ownership even while legacy rows await backfill.
-- BEFORE triggers reserve the old owner on ignored retries. AFTER triggers only
-- run for a physical insertion, so an already-reserved ID there means REPLACE.
CREATE TRIGGER history_event_retry_reserve BEFORE INSERT ON attendance_events
WHEN EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id)
  AND NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
BEGIN
  INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding)
  SELECT s.id,'event',s.center_id,s.payload_hash,iif(length(s.payload_hash)=64 AND s.payload_hash NOT GLOB '*[^0-9a-fA-F]*','hex-sha256',iif(length(s.payload_hash)=44 AND substr(s.payload_hash,44,1)='=' AND substr(s.payload_hash,1,43) NOT GLOB '*[^A-Za-z0-9+/]*','base64-sha256',iif(length(s.payload_hash)=43 AND s.payload_hash NOT GLOB '*[^A-Za-z0-9_-]*','base64url-sha256','opaque'))) FROM attendance_events s WHERE s.id=NEW.id;
END;
CREATE TRIGGER history_event_live_owner BEFORE INSERT ON attendance_events
WHEN EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id AND (center_id IS NOT NEW.center_id OR payload_hash IS NOT NEW.payload_hash))
BEGIN SELECT RAISE(ABORT,'AUDIT_ID_CONFLICT'); END;
CREATE TRIGGER history_correction_retry_reserve BEFORE INSERT ON attendance_corrections
WHEN EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id)
  AND NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
BEGIN
  INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding)
  SELECT s.id,'correction',s.center_id,s.payload_hash,iif(length(s.payload_hash)=64 AND s.payload_hash NOT GLOB '*[^0-9a-fA-F]*','hex-sha256',iif(length(s.payload_hash)=44 AND substr(s.payload_hash,44,1)='=' AND substr(s.payload_hash,1,43) NOT GLOB '*[^A-Za-z0-9+/]*','base64-sha256',iif(length(s.payload_hash)=43 AND s.payload_hash NOT GLOB '*[^A-Za-z0-9_-]*','base64url-sha256','opaque'))) FROM attendance_corrections s WHERE s.id=NEW.id;
END;
CREATE TRIGGER history_correction_live_owner BEFORE INSERT ON attendance_corrections
WHEN EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id AND (center_id IS NOT NEW.center_id OR payload_hash IS NOT NEW.payload_hash))
BEGIN SELECT RAISE(ABORT,'AUDIT_ID_CONFLICT'); END;
CREATE TRIGGER history_audit_retry_reserve BEFORE INSERT ON audit_entries
WHEN EXISTS(SELECT 1 FROM audit_entries WHERE id=NEW.id)
  AND NOT EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) AND NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id)
BEGIN
  INSERT INTO history_request_keys(request_id,source_kind,center_id,payload_hash,hash_encoding)
  SELECT s.id,'audit',s.center_id,NULL,'none' FROM audit_entries s WHERE s.id=NEW.id;
END;
CREATE TRIGGER history_audit_physical_immutable BEFORE INSERT ON audit_entries
WHEN EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=NEW.id AND (a.center_id IS NOT NEW.center_id OR a.actor_id IS NOT NEW.actor_id OR a.actor_name IS NOT NEW.actor_name OR a.action IS NOT NEW.action OR a.entity_type IS NOT NEW.entity_type OR a.entity_id IS NOT NEW.entity_id OR a.detail IS NOT NEW.detail OR a.created_at IS NOT NEW.created_at))
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER history_visit_no_reuse BEFORE INSERT ON visits
WHEN EXISTS(SELECT 1 FROM history_visit_heads WHERE visit_id=NEW.id) OR EXISTS(SELECT 1 FROM visits WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'HISTORY_VISIT_ID_CONFLICT'); END;
CREATE TRIGGER history_visit_stable_identity BEFORE UPDATE ON visits
WHEN NEW.id IS NOT OLD.id OR NEW.center_id IS NOT OLD.center_id OR NEW.student_id IS NOT OLD.student_id OR NEW.original_check_in_at IS NOT OLD.original_check_in_at
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_VISIT_IDENTITY'); END;
-- This prerequisite has no verified archive eviction authority yet.
CREATE TRIGGER history_visit_no_delete BEFORE DELETE ON visits
BEGIN SELECT RAISE(ABORT,'HISTORY_EVICTION_DISABLED'); END;

INSERT INTO schema_versions(version) VALUES(17);
