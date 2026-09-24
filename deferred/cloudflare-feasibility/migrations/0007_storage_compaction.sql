-- Apply atomically with normal writes stopped. D1 batch tests verify rollback.
-- The update lock stays set. Only its two migration-specific guards are replaced
-- within this transaction; source observations, corrections, hashes, and nonces stay intact.
CREATE TABLE storage_compaction_guard(audit_count INTEGER NOT NULL,event_count INTEGER NOT NULL,correction_count INTEGER NOT NULL,verified INTEGER NOT NULL DEFAULT 1 CHECK(verified=1));
INSERT INTO storage_compaction_guard(audit_count,event_count,correction_count)
SELECT (SELECT count(*) FROM audit_entries),(SELECT count(*) FROM attendance_events),(SELECT count(*) FROM attendance_corrections);
DROP TRIGGER attendance_no_update;
DROP TRIGGER audit_no_delete;
DROP TRIGGER backup_guard_attendance_events_update;
DROP TRIGGER backup_guard_audit_entries_delete;

-- Tuple v2: [version,studentName,studentCode,active,checkInAt,
-- originalCheckInAt,checkInBy,checkOutBy,guardianName,visitVersion].
UPDATE attendance_events SET result_visit=json_array(2,
 json_extract(result_visit,'$.studentName'),json_extract(result_visit,'$.studentCode'),json_extract(result_visit,'$.active'),
 json_extract(result_visit,'$.checkInAt'),json_extract(result_visit,'$.originalCheckInAt'),json_extract(result_visit,'$.checkInBy'),
 json_extract(result_visit,'$.checkOutBy'),json_extract(result_visit,'$.guardianName'),json_extract(result_visit,'$.version'))
WHERE json_valid(result_visit) AND json_type(result_visit)='object'
 AND (SELECT count(*) FROM json_each(result_visit))=15
 AND json_extract(result_visit,'$.id') IS visit_id AND json_extract(result_visit,'$.studentId') IS student_id
 AND json_extract(result_visit,'$.checkOutAt') IS iif(action='check_in',NULL,observed_at)
 AND json_extract(result_visit,'$.originalCheckOutAt') IS iif(action='check_in',NULL,observed_at)
 AND json_extract(result_visit,'$.departureType') IS iif(action='check_in',NULL,action)
 AND json_extract(result_visit,'$.reviewStatus') IS iif(action='exceptional_departure','pending','none')
 AND json_type(result_visit,'$.checkOutAt') IN ('text','null')
 AND json_type(result_visit,'$.originalCheckOutAt') IN ('text','null')
 AND json_type(result_visit,'$.departureType') IN ('text','null')
 AND json_type(result_visit,'$.active') IN ('true','false')
 AND json_type(result_visit,'$.version')='integer' AND json_extract(result_visit,'$.version')>=1
 AND json_type(result_visit,'$.studentName')='text'
 AND json_type(result_visit,'$.studentCode')='text'
 AND json_type(result_visit,'$.checkInAt')='text'
 AND json_type(result_visit,'$.originalCheckInAt')='text'
 AND json_type(result_visit,'$.checkInBy')='text'
 AND json_type(result_visit,'$.checkOutBy') IN ('text','null')
 AND json_type(result_visit,'$.guardianName') IN ('text','null');

-- Canonical audit fields are derived solely from immutable source columns.
CREATE VIEW attendance_audit_source AS
 SELECT id,center_id,actor_id,actor_name,action,'attendance_event' AS entity_type,id AS entity_id,
 json_object('studentId',student_id,'observedAt',observed_at,'receivedAt',received_at,'channel',channel,'deviceId',device_id) AS detail,
 received_at AS created_at FROM attendance_events
 UNION ALL
 SELECT id,center_id,actor_id,actor_name,'attendance_correction','visit',visit_id,
 json_object('reason',reason,'priorCheckInAt',prior_check_in_at,'priorCheckOutAt',prior_check_out_at,'checkInAt',check_in_at,'checkOutAt',check_out_at),
 recorded_at FROM attendance_corrections;

-- Remove only byte-equivalent generated copies. Divergent or custom audits stay.
DELETE FROM audit_entries WHERE EXISTS (
 SELECT 1 FROM attendance_audit_source p WHERE p.id=audit_entries.id
 AND p.center_id IS audit_entries.center_id
 AND p.actor_id IS audit_entries.actor_id
 AND p.actor_name IS audit_entries.actor_name
 AND p.action IS audit_entries.action
 AND p.entity_type IS audit_entries.entity_type
 AND p.entity_id IS audit_entries.entity_id
 AND p.detail IS audit_entries.detail
 AND p.created_at IS audit_entries.created_at
 );
CREATE VIEW audit_timeline AS
 SELECT id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at FROM audit_entries
 UNION ALL
 SELECT p.id,p.center_id,p.actor_id,p.actor_name,p.action,p.entity_type,p.entity_id,p.detail,p.created_at
 FROM attendance_audit_source p WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=p.id);

DROP TRIGGER attendance_apply;
DROP TRIGGER correction_apply;
CREATE TRIGGER attendance_apply AFTER INSERT ON attendance_events BEGIN
 INSERT INTO visits(id,center_id,student_id,check_in_at,original_check_in_at,check_in_by)
 SELECT NEW.visit_id,NEW.center_id,NEW.student_id,NEW.observed_at,NEW.observed_at,NEW.actor_id WHERE NEW.action='check_in';
 UPDATE visits SET check_out_at=NEW.observed_at,original_check_out_at=NEW.observed_at,check_out_by=NEW.actor_id,guardian_id=NEW.guardian_id,departure_type=NEW.action,review_status=CASE WHEN NEW.action='exceptional_departure' THEN 'pending' ELSE 'none' END,version=version+1 WHERE id=NEW.visit_id AND NEW.action!='check_in';
 INSERT INTO reviews(id,center_id,event_id,visit_id,student_id,reason,created_at)
 SELECT NEW.id,NEW.center_id,NEW.id,NEW.visit_id,NEW.student_id,NEW.reason,NEW.received_at WHERE NEW.action='exceptional_departure';
 UPDATE attendance_events SET result_visit=coalesce((SELECT json_array(2,s.first_name||' '||s.last_name,s.student_code,s.active,v.check_in_at,v.original_check_in_at,si.display_name,so.display_name,g.display_name,v.version) FROM visits v JOIN students s ON s.id=v.student_id JOIN staff si ON si.id=v.check_in_by LEFT JOIN staff so ON so.id=v.check_out_by LEFT JOIN guardians g ON g.id=v.guardian_id WHERE v.id=NEW.visit_id),'null') WHERE id=NEW.id;
END;
CREATE TRIGGER correction_apply AFTER INSERT ON attendance_corrections BEGIN
 UPDATE visits SET check_in_at=NEW.check_in_at,check_out_at=NEW.check_out_at,version=version+1 WHERE id=NEW.visit_id;
END;
-- Preserve the seal and reject every change to immutable source fields.
CREATE TRIGGER attendance_no_update BEFORE UPDATE ON attendance_events WHEN OLD.result_visit IS NOT NULL
 OR NEW.id IS NOT OLD.id
 OR NEW.center_id IS NOT OLD.center_id
 OR NEW.student_id IS NOT OLD.student_id
 OR NEW.visit_id IS NOT OLD.visit_id
 OR NEW.action IS NOT OLD.action
 OR NEW.observed_at IS NOT OLD.observed_at
 OR NEW.received_at IS NOT OLD.received_at
 OR NEW.actor_id IS NOT OLD.actor_id
 OR NEW.actor_name IS NOT OLD.actor_name
 OR NEW.channel IS NOT OLD.channel
 OR NEW.device_id IS NOT OLD.device_id
 OR NEW.guardian_id IS NOT OLD.guardian_id
 OR NEW.reason IS NOT OLD.reason
 OR NEW.payload_hash IS NOT OLD.payload_hash
 OR NEW.insertion_nonce IS NOT OLD.insertion_nonce
 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTENDANCE'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER backup_guard_attendance_events_update BEFORE UPDATE ON attendance_events WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_audit_entries_delete BEFORE DELETE ON audit_entries WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
-- The former physical audit primary key prevented collisions across source types.
CREATE TRIGGER attendance_audit_id_available BEFORE INSERT ON attendance_events
WHEN NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM audit_entries WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id) THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END;
END;
CREATE TRIGGER correction_audit_id_available BEFORE INSERT ON attendance_corrections
WHEN NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id) BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM audit_entries WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END;
END;
CREATE TRIGGER standalone_audit_id_available BEFORE INSERT ON audit_entries BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) OR EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id) THEN RAISE(ABORT,'AUDIT_ID_CONFLICT') END;
END;
DROP INDEX visits_center_open;
CREATE INDEX visits_center_open ON visits(center_id,check_in_at) WHERE check_out_at IS NULL;
-- Exact-field deletion above plus unchanged source records must preserve the
-- complete audit identity set. Unexpected legacy gaps/collisions abort atomically.
UPDATE storage_compaction_guard SET verified=iif(
 audit_count=(SELECT count(*) FROM audit_timeline)
 AND audit_count=(SELECT count(DISTINCT id) FROM audit_timeline)
 AND event_count=(SELECT count(*) FROM attendance_events)
 AND correction_count=(SELECT count(*) FROM attendance_corrections),1,0);
DROP TABLE storage_compaction_guard;
INSERT INTO schema_versions(version) VALUES(7);
