-- Audit activity is ordered by recording time, not the observed event time.
-- All three branches of audit_timeline need the same deterministic seek tuple.
DROP INDEX audit_center_date;
CREATE INDEX audit_center_date ON audit_entries(center_id,created_at DESC,id DESC);
CREATE INDEX attendance_audit_date ON attendance_events(center_id,received_at DESC,id DESC);
CREATE INDEX correction_audit_date ON attendance_corrections(center_id,recorded_at DESC,id DESC);
-- Flatten the existing UNION ALL without changing its rows or JSON field order.
-- The nested view prevented SQLite from merging the three ordered indexes.
-- TEXT casts align compound-column affinities with the stored audit table;
-- removing them prevents the ordered merge even though the values stay equal.
DROP VIEW audit_timeline;
CREATE VIEW audit_timeline AS
 SELECT id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at FROM audit_entries
 UNION ALL
 SELECT e.id,e.center_id,e.actor_id,e.actor_name,e.action,CAST('attendance_event' AS TEXT),e.id,
   CAST(json_object('studentId',e.student_id,'observedAt',e.observed_at,'receivedAt',e.received_at,'channel',e.channel,'deviceId',e.device_id) AS TEXT),
   e.received_at FROM attendance_events e WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=e.id)
 UNION ALL
 SELECT c.id,c.center_id,c.actor_id,c.actor_name,CAST('attendance_correction' AS TEXT),CAST('visit' AS TEXT),c.visit_id,
   CAST(json_object('reason',c.reason,'priorCheckInAt',c.prior_check_in_at,'priorCheckOutAt',c.prior_check_out_at,'checkInAt',c.check_in_at,'checkOutAt',c.check_out_at) AS TEXT),
   c.recorded_at FROM attendance_corrections c WHERE NOT EXISTS(SELECT 1 FROM audit_entries a WHERE a.id=c.id);
INSERT INTO schema_versions(version) VALUES(15);
