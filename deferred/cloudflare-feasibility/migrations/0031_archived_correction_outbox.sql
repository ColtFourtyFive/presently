-- Accept corrections against an authenticated archived visit without recreating
-- its operational source row. These immutable rows remain in D1 until a later
-- release publishes and reconciles their archive addenda.
CREATE TABLE history_correction_outbox (
  id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers(id),
  visit_id TEXT NOT NULL,
  student_id TEXT NOT NULL REFERENCES students(id),
  expected_version INTEGER NOT NULL CHECK(expected_version>=1),
  prior_check_in_at TEXT NOT NULL,
  prior_check_out_at TEXT,
  check_in_at TEXT NOT NULL,
  check_out_at TEXT,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES staff(id),
  actor_name TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  original_check_in_at TEXT NOT NULL,
  original_check_out_at TEXT,
  check_in_by TEXT NOT NULL REFERENCES staff(id),
  check_out_by TEXT REFERENCES staff(id),
  guardian_id TEXT REFERENCES guardians(id),
  departure_type TEXT,
  review_status TEXT NOT NULL CHECK(review_status IN ('none','pending','resolved')),
  resulting_version INTEGER NOT NULL CHECK(resulting_version=expected_version+1),
  publication_state TEXT NOT NULL DEFAULT 'pending' CHECK(publication_state='pending'),
  CHECK(check_out_at IS NULL OR check_out_at>=check_in_at)
) WITHOUT ROWID;

CREATE INDEX history_correction_outbox_visit_version
  ON history_correction_outbox(center_id,visit_id,resulting_version DESC,id);
CREATE INDEX history_correction_outbox_student_time
  ON history_correction_outbox(center_id,student_id,recorded_at DESC,id);
CREATE INDEX history_correction_outbox_center_time
  ON history_correction_outbox(center_id,recorded_at DESC,id DESC);

CREATE VIEW attendance_correction_records AS
SELECT id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,
       check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash
FROM attendance_corrections
UNION ALL
SELECT id,center_id,visit_id,expected_version,prior_check_in_at,prior_check_out_at,
       check_in_at,check_out_at,reason,actor_id,actor_name,recorded_at,payload_hash
FROM history_correction_outbox;

DROP VIEW audit_timeline;
DROP VIEW attendance_audit_source;
CREATE VIEW attendance_audit_source AS
SELECT id,center_id,actor_id,actor_name,action,'attendance_event' AS entity_type,id AS entity_id,
       json_object('studentId',student_id,'observedAt',observed_at,'receivedAt',received_at,'channel',channel,'deviceId',device_id) AS detail,
       received_at AS created_at
FROM attendance_events
UNION ALL
SELECT id,center_id,actor_id,actor_name,'attendance_correction','visit',visit_id,
  json_object('reason',reason,'priorCheckInAt',prior_check_in_at,'priorCheckOutAt',prior_check_out_at,'checkInAt',check_in_at,'checkOutAt',check_out_at),
  recorded_at
FROM attendance_corrections;
CREATE VIEW audit_timeline_live AS
SELECT id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at
FROM audit_entries
UNION ALL
SELECT e.id,e.center_id,e.actor_id,e.actor_name,e.action,CAST('attendance_event' AS TEXT),e.id,
  CAST(json_object('studentId',e.student_id,'observedAt',e.observed_at,'receivedAt',e.received_at,'channel',e.channel,'deviceId',e.device_id) AS TEXT),
  e.received_at
FROM attendance_events e
WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=e.id)
UNION ALL
SELECT c.id,c.center_id,c.actor_id,c.actor_name,CAST('attendance_correction' AS TEXT),CAST('visit' AS TEXT),c.visit_id,
  CAST(json_object('reason',c.reason,'priorCheckInAt',c.prior_check_in_at,'priorCheckOutAt',c.prior_check_out_at,'checkInAt',c.check_in_at,'checkOutAt',c.check_out_at) AS TEXT),
  c.recorded_at
FROM attendance_corrections c
WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=c.id);
CREATE VIEW audit_timeline AS
SELECT id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at
FROM audit_timeline_live
UNION ALL
SELECT c.id,c.center_id,c.actor_id,c.actor_name,'attendance_correction','visit',c.visit_id,
  json_object('reason',c.reason,'priorCheckInAt',c.prior_check_in_at,'priorCheckOutAt',c.prior_check_out_at,'checkInAt',c.check_in_at,'checkOutAt',c.check_out_at),
  c.recorded_at
FROM history_correction_outbox c
WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=c.id);

DROP TRIGGER history_heads_validate_update;
CREATE TRIGGER history_heads_validate_update
BEFORE UPDATE ON history_visit_heads
WHEN NEW.visit_id IS NOT OLD.visit_id OR NEW.residency!='live' OR NOT (
  EXISTS(
    SELECT 1 FROM visits v
    WHERE v.id=NEW.visit_id AND v.center_id IS NEW.center_id
      AND v.student_id IS NEW.student_id
      AND v.original_check_in_at IS NEW.original_check_in_at
      AND v.original_check_out_at IS NEW.original_check_out_at
      AND v.check_in_at IS NEW.check_in_at AND v.check_out_at IS NEW.check_out_at
      AND v.version IS NEW.version AND v.review_status IS NEW.review_status
  ) OR EXISTS(
    SELECT 1 FROM history_correction_outbox c
    WHERE c.visit_id=NEW.visit_id AND c.center_id IS NEW.center_id
      AND c.student_id IS NEW.student_id
      AND c.original_check_in_at IS NEW.original_check_in_at
      AND c.original_check_out_at IS NEW.original_check_out_at
      AND c.check_in_at IS NEW.check_in_at AND c.check_out_at IS NEW.check_out_at
      AND c.resulting_version IS NEW.version AND c.review_status IS NEW.review_status
  )
)
BEGIN SELECT RAISE(ABORT,'HISTORY_PROJECTION_MISMATCH'); END;

DROP TRIGGER history_correction_heads_validate_insert;
CREATE TRIGGER history_correction_heads_validate_insert
BEFORE INSERT ON history_correction_heads
WHEN NEW.residency!='live' OR NOT (
  EXISTS(
    SELECT 1 FROM attendance_corrections c JOIN visits v ON v.id=c.visit_id
    WHERE c.id=NEW.correction_id AND c.center_id IS NEW.center_id
      AND c.visit_id IS NEW.visit_id AND v.student_id IS NEW.student_id
      AND c.recorded_at IS NEW.recorded_at
  ) OR EXISTS(
    SELECT 1 FROM history_correction_outbox c
    WHERE c.id=NEW.correction_id AND c.center_id IS NEW.center_id
      AND c.visit_id IS NEW.visit_id AND c.student_id IS NEW.student_id
      AND c.recorded_at IS NEW.recorded_at
  )
)
BEGIN SELECT RAISE(ABORT,'HISTORY_CORRECTION_PROJECTION_MISMATCH'); END;

CREATE TRIGGER history_correction_outbox_validate
BEFORE INSERT ON history_correction_outbox
BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM visits WHERE id=NEW.visit_id)
    THEN RAISE(ABORT,'LIVE_VISIT_CORRECTION_REQUIRED') END;
  SELECT CASE WHEN NOT EXISTS(
    SELECT 1 FROM history_visit_heads h
    WHERE h.visit_id=NEW.visit_id AND h.center_id=NEW.center_id
      AND h.student_id=NEW.student_id AND h.version=NEW.expected_version
      AND h.original_check_in_at IS NEW.original_check_in_at
      AND h.original_check_out_at IS NEW.original_check_out_at
      AND h.check_in_at IS NEW.prior_check_in_at
      AND h.check_out_at IS NEW.prior_check_out_at
      AND h.review_status IS NEW.review_status
  ) THEN RAISE(ABORT,'STALE_VISIT') END;
  SELECT CASE WHEN NEW.check_out_at IS NOT NULL AND NEW.check_out_at<NEW.check_in_at
    THEN RAISE(ABORT,'DEPARTURE_BEFORE_ARRIVAL') END;
  SELECT CASE WHEN NEW.check_in_at>NEW.recorded_at OR NEW.check_out_at>NEW.recorded_at
    THEN RAISE(ABORT,'FUTURE_CORRECTION') END;
  SELECT CASE WHEN EXISTS(
    SELECT 1 FROM history_visit_heads v
    WHERE v.center_id=NEW.center_id AND v.student_id=NEW.student_id
      AND v.visit_id!=NEW.visit_id
      AND v.check_in_at<coalesce(NEW.check_out_at,'9999')
      AND coalesce(v.check_out_at,'9999')>NEW.check_in_at
  ) THEN RAISE(ABORT,'OVERLAPPING_VISIT') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM history_request_keys WHERE request_id=NEW.id)
    OR EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id)
    OR EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id)
    OR EXISTS(SELECT 1 FROM audit_entries WHERE id=NEW.id)
    THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END;
END;

CREATE TRIGGER history_correction_outbox_apply
AFTER INSERT ON history_correction_outbox
BEGIN
  UPDATE history_visit_heads
  SET check_in_at=NEW.check_in_at,check_out_at=NEW.check_out_at,
      version=NEW.resulting_version
  WHERE visit_id=NEW.visit_id AND center_id=NEW.center_id
    AND student_id=NEW.student_id AND version=NEW.expected_version;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'STALE_VISIT') END;
  INSERT INTO history_correction_heads(
    correction_id,center_id,visit_id,student_id,recorded_at,residency
  ) VALUES(NEW.id,NEW.center_id,NEW.visit_id,NEW.student_id,NEW.recorded_at,'live');
  INSERT INTO history_request_keys(
    request_id,source_kind,center_id,payload_hash,hash_encoding
  ) VALUES(
    NEW.id,'correction',NEW.center_id,NEW.payload_hash,
    iif(length(NEW.payload_hash)=64 AND NEW.payload_hash NOT GLOB '*[^0-9a-fA-F]*','hex-sha256',
      iif(length(NEW.payload_hash)=44 AND substr(NEW.payload_hash,44,1)='=' AND substr(NEW.payload_hash,1,43) NOT GLOB '*[^A-Za-z0-9+/]*','base64-sha256',
        iif(length(NEW.payload_hash)=43 AND NEW.payload_hash NOT GLOB '*[^A-Za-z0-9_-]*','base64url-sha256','opaque')))
  );
END;

CREATE TRIGGER history_correction_outbox_no_update
BEFORE UPDATE ON history_correction_outbox
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVED_CORRECTION'); END;
CREATE TRIGGER history_correction_outbox_no_delete
BEFORE DELETE ON history_correction_outbox
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVED_CORRECTION'); END;
CREATE TRIGGER backup_guard_history_correction_outbox_insert
BEFORE INSERT ON history_correction_outbox
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_history_correction_outbox_update
BEFORE UPDATE ON history_correction_outbox
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_history_correction_outbox_delete
BEFORE DELETE ON history_correction_outbox
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(31);
