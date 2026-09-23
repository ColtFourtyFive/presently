CREATE INDEX attendance_events_visit ON attendance_events(visit_id,received_at);
INSERT INTO schema_versions(version) VALUES(4);
