-- Optimistic report snapshots: date-scoped counters plus an identity/timezone counter.
-- Reads of epoch, page rows and counts share one D1 batch transaction. No report lock.
-- Recovery rotates this value so restored counters cannot resume an older export.
CREATE TABLE report_runtime(id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL CHECK(length(generation)=32));
INSERT INTO report_runtime(id,generation) VALUES(1,lower(hex(randomblob(16))));
CREATE TABLE report_epochs(center_id TEXT NOT NULL, day TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), PRIMARY KEY(center_id,day));
INSERT INTO report_epochs(center_id,day) SELECT id,'*' FROM centers;
CREATE TRIGGER report_visits_insert AFTER INSERT ON visits BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(NEW.center_id,substr(NEW.check_in_at,1,10),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_visits_update AFTER UPDATE ON visits BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,substr(OLD.check_in_at,1,10),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.center_id,substr(NEW.check_in_at,1,10),1 WHERE OLD.center_id IS NOT NEW.center_id OR substr(OLD.check_in_at,1,10) IS NOT substr(NEW.check_in_at,1,10) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_visits_delete AFTER DELETE ON visits BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,substr(OLD.check_in_at,1,10),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_attendance_events_insert AFTER INSERT ON attendance_events BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(NEW.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),substr(NEW.observed_at,1,10)),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_attendance_events_update AFTER UPDATE ON attendance_events WHEN NEW.center_id IS NOT OLD.center_id OR NEW.student_id IS NOT OLD.student_id OR NEW.visit_id IS NOT OLD.visit_id OR NEW.action IS NOT OLD.action OR NEW.observed_at IS NOT OLD.observed_at OR NEW.received_at IS NOT OLD.received_at OR NEW.actor_id IS NOT OLD.actor_id OR NEW.actor_name IS NOT OLD.actor_name OR NEW.channel IS NOT OLD.channel OR NEW.guardian_id IS NOT OLD.guardian_id OR NEW.reason IS NOT OLD.reason BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),substr(OLD.observed_at,1,10)),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),substr(NEW.observed_at,1,10)),1 WHERE OLD.center_id IS NOT NEW.center_id OR coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),substr(OLD.observed_at,1,10)) IS NOT coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),substr(NEW.observed_at,1,10)) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_attendance_events_delete AFTER DELETE ON attendance_events BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),substr(OLD.observed_at,1,10)),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_attendance_corrections_insert AFTER INSERT ON attendance_corrections BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(NEW.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),substr(NEW.check_in_at,1,10)),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_attendance_corrections_update AFTER UPDATE ON attendance_corrections BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),substr(OLD.check_in_at,1,10)),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),substr(NEW.check_in_at,1,10)),1 WHERE OLD.center_id IS NOT NEW.center_id OR coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),substr(OLD.check_in_at,1,10)) IS NOT coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),substr(NEW.check_in_at,1,10)) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_attendance_corrections_delete AFTER DELETE ON attendance_corrections BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),substr(OLD.check_in_at,1,10)),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_reviews_insert AFTER INSERT ON reviews BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(NEW.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),(SELECT substr(observed_at,1,10) FROM attendance_events WHERE id=NEW.event_id),'*'),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_reviews_update AFTER UPDATE ON reviews BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),(SELECT substr(observed_at,1,10) FROM attendance_events WHERE id=OLD.event_id),'*'),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),(SELECT substr(observed_at,1,10) FROM attendance_events WHERE id=NEW.event_id),'*'),1 WHERE OLD.center_id IS NOT NEW.center_id OR coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),(SELECT substr(observed_at,1,10) FROM attendance_events WHERE id=OLD.event_id),'*') IS NOT coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=NEW.visit_id),(SELECT substr(observed_at,1,10) FROM attendance_events WHERE id=NEW.event_id),'*') ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_reviews_delete AFTER DELETE ON reviews BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,coalesce((SELECT substr(check_in_at,1,10) FROM visits WHERE id=OLD.visit_id),(SELECT substr(observed_at,1,10) FROM attendance_events WHERE id=OLD.event_id),'*'),1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_students_identity_update AFTER UPDATE ON students WHEN NEW.center_id IS NOT OLD.center_id OR NEW.first_name IS NOT OLD.first_name OR NEW.last_name IS NOT OLD.last_name OR NEW.student_code IS NOT OLD.student_code BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.center_id,'*',1 WHERE OLD.center_id IS NOT NEW.center_id OR '*' IS NOT '*' ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_students_identity_delete AFTER DELETE ON students BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_staff_identity_update AFTER UPDATE ON staff WHEN NEW.center_id IS NOT OLD.center_id OR NEW.display_name IS NOT OLD.display_name BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.center_id,'*',1 WHERE OLD.center_id IS NOT NEW.center_id OR '*' IS NOT '*' ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_staff_identity_delete AFTER DELETE ON staff BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_guardians_identity_update AFTER UPDATE ON guardians WHEN NEW.center_id IS NOT OLD.center_id OR NEW.display_name IS NOT OLD.display_name BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.center_id,'*',1 WHERE OLD.center_id IS NOT NEW.center_id OR '*' IS NOT '*' ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_guardians_identity_delete AFTER DELETE ON guardians BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.center_id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_centers_identity_update AFTER UPDATE ON centers WHEN NEW.id IS NOT OLD.id OR NEW.timezone IS NOT OLD.timezone BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
 INSERT INTO report_epochs(center_id,day,version) SELECT NEW.id,'*',1 WHERE OLD.id IS NOT NEW.id OR '*' IS NOT '*' ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
CREATE TRIGGER report_centers_identity_delete AFTER DELETE ON centers BEGIN
 INSERT INTO report_epochs(center_id,day,version) VALUES(OLD.id,'*',1) ON CONFLICT(center_id,day) DO UPDATE SET version=version+1;
END;
-- Extend the existing prefixes with stable tie-breakers rather than duplicating
-- three large history indexes. Existing lookups retain their indexed prefixes.
DROP INDEX visits_center_history;
DROP INDEX corrections_visit;
DROP INDEX attendance_events_visit;
CREATE INDEX visits_center_history ON visits(center_id,check_in_at,id);
CREATE INDEX corrections_visit ON attendance_corrections(visit_id,recorded_at,id);
CREATE INDEX attendance_events_visit ON attendance_events(visit_id,received_at,id);
CREATE INDEX report_unmatched_page ON attendance_events(center_id,observed_at,id) WHERE visit_id IS NULL;
INSERT INTO schema_versions(version) VALUES(10);
