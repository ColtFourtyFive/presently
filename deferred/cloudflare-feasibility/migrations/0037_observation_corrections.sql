-- Preserve an unmatched exceptional-departure observation while allowing a
-- manager to correct the time used by operational views and reports.
CREATE TABLE observation_effective_times (
  event_id TEXT PRIMARY KEY REFERENCES attendance_events(id),
  center_id TEXT NOT NULL REFERENCES centers(id),
  original_observed_at TEXT NOT NULL,
  effective_observed_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version)='integer' AND version>=1),
  last_correction_id TEXT,
  updated_at TEXT NOT NULL,
  CHECK((version=1 AND last_correction_id IS NULL) OR (version>1 AND last_correction_id IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX observation_effective_times_center_time
ON observation_effective_times(center_id,effective_observed_at,event_id);

CREATE TABLE observation_corrections (
  id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers(id),
  event_id TEXT NOT NULL REFERENCES attendance_events(id),
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version>=1),
  prior_effective_observed_at TEXT NOT NULL,
  effective_observed_at TEXT NOT NULL,
  reason TEXT NOT NULL CHECK(length(trim(reason))>=5 AND length(reason)<=2000),
  actor_id TEXT NOT NULL REFERENCES staff(id),
  actor_name TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  resulting_version INTEGER NOT NULL CHECK(resulting_version=expected_version+1),
  insertion_nonce TEXT NOT NULL,
  UNIQUE(event_id,resulting_version)
) WITHOUT ROWID;

CREATE INDEX observation_corrections_event_version
ON observation_corrections(event_id,resulting_version,id);

CREATE INDEX observation_corrections_center_recorded
ON observation_corrections(center_id,recorded_at,id);

-- Kept separate from history_request_keys because the existing publication
-- tables constrain that registry to archive-supported events and visit
-- corrections. This remains a permanent, explicit request namespace.
CREATE TABLE observation_correction_request_keys (
  request_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL DEFAULT 'observation_correction'
    CHECK(source_kind='observation_correction'),
  center_id TEXT NOT NULL REFERENCES centers(id),
  event_id TEXT NOT NULL REFERENCES attendance_events(id),
  payload_hash TEXT NOT NULL,
  hash_encoding TEXT NOT NULL
    CHECK(hash_encoding IN ('hex-sha256','base64-sha256','base64url-sha256','opaque')),
  canonicalization TEXT NOT NULL DEFAULT 'legacy-unverified'
    CHECK(canonicalization='legacy-unverified')
) WITHOUT ROWID;

CREATE INDEX observation_correction_request_event
ON observation_correction_request_keys(center_id,event_id,request_id);

CREATE TRIGGER observation_effective_validate_insert
BEFORE INSERT ON observation_effective_times
WHEN NOT EXISTS(
  SELECT 1 FROM attendance_events e
  WHERE e.id=NEW.event_id AND e.center_id=NEW.center_id
    AND e.visit_id IS NULL AND e.action='exceptional_departure'
    AND e.observed_at=NEW.original_observed_at
)
OR NOT (
  (NEW.version=1 AND NEW.effective_observed_at=NEW.original_observed_at
    AND NEW.last_correction_id IS NULL)
  OR EXISTS(
    SELECT 1 FROM observation_corrections c
    WHERE c.id=NEW.last_correction_id AND c.event_id=NEW.event_id
      AND c.center_id=NEW.center_id AND c.expected_version=1
      AND c.prior_effective_observed_at=NEW.original_observed_at
      AND c.effective_observed_at=NEW.effective_observed_at
      AND c.resulting_version=NEW.version AND c.recorded_at=NEW.updated_at
  )
)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_PROJECTION_MISMATCH'); END;

CREATE TRIGGER observation_effective_validate_update
BEFORE UPDATE ON observation_effective_times
WHEN NEW.event_id!=OLD.event_id OR NEW.center_id!=OLD.center_id
OR NEW.original_observed_at!=OLD.original_observed_at
OR NEW.version!=OLD.version+1
OR NOT EXISTS(
  SELECT 1 FROM observation_corrections c
  WHERE c.id=NEW.last_correction_id AND c.event_id=OLD.event_id
    AND c.center_id=OLD.center_id AND c.expected_version=OLD.version
    AND c.prior_effective_observed_at=OLD.effective_observed_at
    AND c.effective_observed_at=NEW.effective_observed_at
    AND c.resulting_version=NEW.version AND c.recorded_at=NEW.updated_at
)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_PROJECTION_MISMATCH'); END;

CREATE TRIGGER observation_effective_no_delete
BEFORE DELETE ON observation_effective_times
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_PROJECTION'); END;

CREATE TRIGGER observation_correction_validate
BEFORE INSERT ON observation_corrections
WHEN NOT EXISTS(
  SELECT 1
  FROM attendance_events e
  LEFT JOIN observation_effective_times p ON p.event_id=e.id
  WHERE e.id=NEW.event_id AND e.center_id=NEW.center_id
    AND e.visit_id IS NULL AND e.action='exceptional_departure'
    AND e.result_visit='null'
    AND coalesce(p.center_id,e.center_id)=e.center_id
    AND coalesce(p.original_observed_at,e.observed_at)=e.observed_at
    AND coalesce(p.version,1)=NEW.expected_version
    AND coalesce(p.effective_observed_at,e.observed_at)=NEW.prior_effective_observed_at
)
BEGIN SELECT RAISE(ABORT,'STALE_OBSERVATION'); END;

CREATE TRIGGER observation_correction_future
BEFORE INSERT ON observation_corrections
WHEN NEW.effective_observed_at>NEW.recorded_at
BEGIN SELECT RAISE(ABORT,'FUTURE_CORRECTION'); END;

CREATE TRIGGER observation_correction_history_id_collision
BEFORE INSERT ON observation_corrections
WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_CORRECTION_ID_REUSED'); END;

CREATE TRIGGER observation_correction_archive_fence
BEFORE INSERT ON observation_corrections
WHEN EXISTS(
  SELECT 1 FROM archive_members m
  WHERE m.table_name='attendance_events' AND m.record_key=NEW.event_id
)
OR EXISTS(SELECT 1 FROM archive_publication_requests q WHERE q.request_id=NEW.event_id)
OR EXISTS(SELECT 1 FROM archive_compact_requests q WHERE q.request_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_ARCHIVE_UNSUPPORTED'); END;

CREATE TRIGGER observation_correction_apply
AFTER INSERT ON observation_corrections
BEGIN
  INSERT INTO observation_effective_times(
    event_id,center_id,original_observed_at,effective_observed_at,
    version,last_correction_id,updated_at
  )
  SELECT e.id,e.center_id,e.observed_at,NEW.effective_observed_at,
    NEW.resulting_version,NEW.id,NEW.recorded_at
  FROM attendance_events e WHERE e.id=NEW.event_id
  ON CONFLICT(event_id) DO UPDATE SET
    effective_observed_at=excluded.effective_observed_at,
    version=excluded.version,
    last_correction_id=excluded.last_correction_id,
    updated_at=excluded.updated_at;

  INSERT INTO observation_correction_request_keys(
    request_id,center_id,event_id,payload_hash,hash_encoding
  ) VALUES(
    NEW.id,NEW.center_id,NEW.event_id,NEW.payload_hash,
    iif(length(NEW.payload_hash)=64 AND NEW.payload_hash NOT GLOB '*[^0-9a-fA-F]*','hex-sha256',
      iif(length(NEW.payload_hash)=44 AND substr(NEW.payload_hash,44,1)='='
        AND substr(NEW.payload_hash,1,43) NOT GLOB '*[^A-Za-z0-9+/]*','base64-sha256',
        iif(length(NEW.payload_hash)=43 AND NEW.payload_hash NOT GLOB '*[^A-Za-z0-9_-]*',
          'base64url-sha256','opaque')))
  );

  INSERT INTO audit_entries(
    id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at
  ) VALUES(
    'observation-correction-audit-'||NEW.id,NEW.center_id,NEW.actor_id,NEW.actor_name,
    'observation_time_corrected','attendance_event',NEW.event_id,
    json_object(
      'correctionId',NEW.id,
      'reason',NEW.reason,
      'priorEffectiveObservedAt',NEW.prior_effective_observed_at,
      'effectiveObservedAt',NEW.effective_observed_at,
      'expectedVersion',NEW.expected_version,
      'resultingVersion',NEW.resulting_version
    ),NEW.recorded_at
  );

  INSERT INTO report_epochs(center_id,day,version)
  VALUES(NEW.center_id,substr(NEW.prior_effective_observed_at,1,10),1)
  ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
  INSERT INTO report_epochs(center_id,day,version)
  SELECT NEW.center_id,substr(NEW.effective_observed_at,1,10),1
  WHERE substr(NEW.effective_observed_at,1,10)!=substr(NEW.prior_effective_observed_at,1,10)
  ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
  INSERT INTO report_epochs(center_id,day,version)
  VALUES(NEW.center_id,'*',1)
  ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;

CREATE TRIGGER observation_corrections_no_update
BEFORE UPDATE ON observation_corrections
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_CORRECTION'); END;

CREATE TRIGGER observation_corrections_no_delete
BEFORE DELETE ON observation_corrections
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_CORRECTION'); END;

CREATE TRIGGER observation_request_validate_insert
BEFORE INSERT ON observation_correction_request_keys
WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.request_id)
OR NOT EXISTS(
  SELECT 1 FROM observation_corrections c
  WHERE c.id=NEW.request_id AND c.center_id=NEW.center_id
    AND c.event_id=NEW.event_id AND c.payload_hash=NEW.payload_hash
)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_CORRECTION_ID_REUSED'); END;

CREATE TRIGGER observation_request_no_replace
BEFORE INSERT ON observation_correction_request_keys
WHEN EXISTS(SELECT 1 FROM observation_correction_request_keys WHERE request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_REQUEST'); END;

CREATE TRIGGER observation_request_no_update
BEFORE UPDATE ON observation_correction_request_keys
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_REQUEST'); END;

CREATE TRIGGER observation_request_no_delete
BEFORE DELETE ON observation_correction_request_keys
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_OBSERVATION_REQUEST'); END;

CREATE TRIGGER history_key_observation_collision
BEFORE INSERT ON history_request_keys
WHEN EXISTS(
  SELECT 1 FROM observation_correction_request_keys WHERE request_id=NEW.request_id
)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_SOURCE'); END;

-- Corrected unmatched events use an archive format that does not yet carry
-- their correction graph. Keep them live until that format is implemented.
CREATE TRIGGER observation_archive_member_fence
BEFORE INSERT ON archive_members
WHEN NEW.table_name='attendance_events' AND EXISTS(
  SELECT 1 FROM observation_effective_times p
  WHERE p.event_id=NEW.record_key AND p.version>1
)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_ARCHIVE_UNSUPPORTED'); END;

CREATE TRIGGER observation_publication_request_fence
BEFORE INSERT ON archive_publication_requests
WHEN EXISTS(
  SELECT 1 FROM observation_effective_times p
  WHERE p.event_id=NEW.request_id AND p.version>1
)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_ARCHIVE_UNSUPPORTED'); END;

CREATE TRIGGER observation_compact_request_fence
BEFORE INSERT ON archive_compact_requests
WHEN EXISTS(
  SELECT 1 FROM observation_effective_times p
  WHERE p.event_id=NEW.request_id AND p.version>1
)
BEGIN SELECT RAISE(ABORT,'OBSERVATION_ARCHIVE_UNSUPPORTED'); END;

CREATE TRIGGER backup_guard_observation_effective_times_insert
BEFORE INSERT ON observation_effective_times
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_effective_times_update
BEFORE UPDATE ON observation_effective_times
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_effective_times_delete
BEFORE DELETE ON observation_effective_times
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_corrections_insert
BEFORE INSERT ON observation_corrections
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_corrections_update
BEFORE UPDATE ON observation_corrections
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_corrections_delete
BEFORE DELETE ON observation_corrections
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_request_keys_insert
BEFORE INSERT ON observation_correction_request_keys
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_request_keys_update
BEFORE UPDATE ON observation_correction_request_keys
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_observation_request_keys_delete
BEFORE DELETE ON observation_correction_request_keys
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES (37);
