PRAGMA foreign_keys = ON;
CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
INSERT INTO schema_versions(version) VALUES (1);
CREATE TABLE centers (id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles', created_at TEXT NOT NULL);
CREATE TABLE staff (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), email TEXT NOT NULL COLLATE NOCASE, display_name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','manager','front_desk','instructor')), active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 kiosk_enabled INTEGER NOT NULL DEFAULT 0 CHECK(kiosk_enabled IN (0,1)), pin_hash TEXT, pin_salt TEXT, pin_iterations INTEGER,
 session_version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(center_id,email)
);
CREATE TRIGGER last_owner_update BEFORE UPDATE ON staff WHEN OLD.role='owner' AND OLD.active=1 AND (NEW.role!='owner' OR NEW.active=0)
 AND NOT EXISTS(SELECT 1 FROM staff WHERE center_id=OLD.center_id AND id!=OLD.id AND role='owner' AND active=1)
 BEGIN SELECT RAISE(ABORT,'LAST_OWNER'); END;
CREATE TRIGGER last_owner_delete BEFORE DELETE ON staff WHEN OLD.role='owner' AND OLD.active=1
 AND NOT EXISTS(SELECT 1 FROM staff WHERE center_id=OLD.center_id AND id!=OLD.id AND role='owner' AND active=1)
 BEGIN SELECT RAISE(ABORT,'LAST_OWNER'); END;
CREATE TABLE device_enrollments (id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES staff(id), created_at TEXT NOT NULL, consumed_at TEXT);
CREATE TABLE kiosk_devices (id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), enrollment_id TEXT NOT NULL UNIQUE REFERENCES device_enrollments(id), token_hash TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT);
CREATE TABLE kiosk_sessions (id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), device_id TEXT NOT NULL REFERENCES kiosk_devices(id), staff_id TEXT NOT NULL REFERENCES staff(id), token_hash TEXT NOT NULL UNIQUE, staff_version INTEGER NOT NULL, created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE INDEX kiosk_sessions_device ON kiosk_sessions(device_id);
CREATE TABLE pin_throttles (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start TEXT NOT NULL, locked_until TEXT);
CREATE TABLE students (id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), student_code TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), subjects TEXT NOT NULL DEFAULT '[]', pickup_alert TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(center_id,student_code));
CREATE INDEX students_name ON students(center_id,last_name,first_name);
CREATE TABLE guardians (id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), display_name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE student_guardians (student_id TEXT NOT NULL REFERENCES students(id), guardian_id TEXT NOT NULL REFERENCES guardians(id), relationship TEXT NOT NULL DEFAULT '', pickup_authority TEXT NOT NULL DEFAULT 'unverified' CHECK(pickup_authority IN ('unverified','allowed','denied')), authority_note TEXT NOT NULL DEFAULT '', PRIMARY KEY(student_id,guardian_id));
CREATE TABLE visits (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), student_id TEXT NOT NULL REFERENCES students(id),
 check_in_at TEXT NOT NULL, check_out_at TEXT, original_check_in_at TEXT NOT NULL, original_check_out_at TEXT,
 check_in_by TEXT NOT NULL REFERENCES staff(id), check_out_by TEXT REFERENCES staff(id), guardian_id TEXT REFERENCES guardians(id), departure_type TEXT CHECK(departure_type IN ('check_out','exceptional_departure')),
 review_status TEXT NOT NULL DEFAULT 'none' CHECK(review_status IN ('none','pending','resolved')), version INTEGER NOT NULL DEFAULT 1,
 CHECK(check_out_at IS NULL OR check_out_at>=check_in_at)
);
CREATE UNIQUE INDEX one_open_visit ON visits(student_id) WHERE check_out_at IS NULL;
CREATE INDEX visits_center_open ON visits(center_id,check_out_at,check_in_at);
CREATE INDEX visits_student_history ON visits(student_id,check_in_at DESC);
CREATE INDEX visits_center_history ON visits(center_id,check_in_at DESC);
CREATE TABLE attendance_events (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), student_id TEXT NOT NULL REFERENCES students(id), visit_id TEXT,
 action TEXT NOT NULL CHECK(action IN ('check_in','check_out','exceptional_departure')), observed_at TEXT NOT NULL, received_at TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES staff(id), actor_name TEXT NOT NULL, channel TEXT NOT NULL CHECK(channel IN ('admin','kiosk')), device_id TEXT,
 guardian_id TEXT, reason TEXT, payload_hash TEXT NOT NULL, insertion_nonce TEXT NOT NULL, result_visit TEXT
);
CREATE INDEX attendance_center_history ON attendance_events(center_id,observed_at DESC);
CREATE TABLE attendance_corrections (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), visit_id TEXT NOT NULL REFERENCES visits(id), expected_version INTEGER NOT NULL,
 prior_check_in_at TEXT NOT NULL, prior_check_out_at TEXT, check_in_at TEXT NOT NULL, check_out_at TEXT,
 reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES staff(id), actor_name TEXT NOT NULL, recorded_at TEXT NOT NULL, payload_hash TEXT NOT NULL
);
CREATE INDEX corrections_visit ON attendance_corrections(visit_id,recorded_at);
CREATE TABLE reviews (id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), event_id TEXT NOT NULL UNIQUE REFERENCES attendance_events(id), visit_id TEXT REFERENCES visits(id), student_id TEXT NOT NULL REFERENCES students(id), reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved')), created_at TEXT NOT NULL, resolved_at TEXT, resolved_by TEXT REFERENCES staff(id), resolution TEXT);
CREATE TABLE audit_entries (id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), actor_id TEXT, actor_name TEXT NOT NULL, action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX audit_center_date ON audit_entries(center_id,created_at DESC);
CREATE TRIGGER attendance_validate BEFORE INSERT ON attendance_events WHEN NOT EXISTS(SELECT 1 FROM attendance_events WHERE id=NEW.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND center_id=NEW.center_id) THEN RAISE(ABORT,'STUDENT_NOT_FOUND') END;
 SELECT CASE WHEN NEW.action='check_in' AND EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND active=0) THEN RAISE(ABORT,'STUDENT_INACTIVE') END;
 SELECT CASE WHEN NEW.action='check_in' AND EXISTS(SELECT 1 FROM visits WHERE student_id=NEW.student_id AND check_out_at IS NULL) THEN RAISE(ABORT,'ALREADY_PRESENT') END;
 SELECT CASE WHEN NEW.action='check_out' AND NOT EXISTS(SELECT 1 FROM visits WHERE student_id=NEW.student_id AND check_out_at IS NULL) THEN RAISE(ABORT,'NOT_PRESENT') END;
 SELECT CASE WHEN NEW.action='check_out' AND NOT EXISTS(SELECT 1 FROM student_guardians WHERE student_id=NEW.student_id AND guardian_id=NEW.guardian_id AND pickup_authority='allowed') THEN RAISE(ABORT,'PICKUP_UNVERIFIED') END;
 SELECT CASE WHEN NEW.action='check_out' AND EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND pickup_alert!='') THEN RAISE(ABORT,'PICKUP_ALERT') END;
 SELECT CASE WHEN NEW.action='exceptional_departure' AND length(trim(coalesce(NEW.reason,'')))<5 THEN RAISE(ABORT,'REASON_REQUIRED') END;
 SELECT CASE WHEN NEW.action!='check_in' AND EXISTS(SELECT 1 FROM visits WHERE student_id=NEW.student_id AND check_out_at IS NULL AND check_in_at>NEW.observed_at) THEN RAISE(ABORT,'DEPARTURE_BEFORE_ARRIVAL') END;
 SELECT CASE WHEN NEW.action='check_in' AND EXISTS(SELECT 1 FROM visits WHERE student_id=NEW.student_id AND check_out_at IS NOT NULL AND check_out_at>NEW.observed_at) THEN RAISE(ABORT,'OVERLAPPING_VISIT') END;
END;
CREATE TRIGGER attendance_apply AFTER INSERT ON attendance_events BEGIN
 INSERT INTO visits(id,center_id,student_id,check_in_at,original_check_in_at,check_in_by)
 SELECT NEW.visit_id,NEW.center_id,NEW.student_id,NEW.observed_at,NEW.observed_at,NEW.actor_id WHERE NEW.action='check_in';
 UPDATE visits SET check_out_at=NEW.observed_at,original_check_out_at=NEW.observed_at,check_out_by=NEW.actor_id,guardian_id=NEW.guardian_id,departure_type=NEW.action,review_status=CASE WHEN NEW.action='exceptional_departure' THEN 'pending' ELSE 'none' END,version=version+1 WHERE id=NEW.visit_id AND NEW.action!='check_in';
 INSERT INTO reviews(id,center_id,event_id,visit_id,student_id,reason,created_at)
 SELECT NEW.id,NEW.center_id,NEW.id,NEW.visit_id,NEW.student_id,NEW.reason,NEW.received_at WHERE NEW.action='exceptional_departure';
 UPDATE attendance_events SET result_visit=coalesce((SELECT json_object('id',v.id,'studentId',v.student_id,'studentName',s.first_name||' '||s.last_name,'studentCode',s.student_code,'active',json(CASE s.active WHEN 1 THEN 'true' ELSE 'false' END),'checkInAt',v.check_in_at,'checkOutAt',v.check_out_at,'originalCheckInAt',v.original_check_in_at,'originalCheckOutAt',v.original_check_out_at,'checkInBy',si.display_name,'checkOutBy',so.display_name,'guardianName',g.display_name,'departureType',v.departure_type,'reviewStatus',v.review_status,'version',v.version) FROM visits v JOIN students s ON s.id=v.student_id JOIN staff si ON si.id=v.check_in_by LEFT JOIN staff so ON so.id=v.check_out_by LEFT JOIN guardians g ON g.id=v.guardian_id WHERE v.id=NEW.visit_id),'null') WHERE id=NEW.id;
 INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(NEW.id,NEW.center_id,NEW.actor_id,NEW.actor_name,NEW.action,'attendance_event',NEW.id,json_object('studentId',NEW.student_id,'observedAt',NEW.observed_at,'receivedAt',NEW.received_at,'channel',NEW.channel,'deviceId',NEW.device_id),NEW.received_at);
END;
CREATE TRIGGER attendance_no_delete BEFORE DELETE ON attendance_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTENDANCE'); END;
CREATE TRIGGER attendance_no_update BEFORE UPDATE ON attendance_events WHEN OLD.result_visit IS NOT NULL OR NEW.id!=OLD.id OR NEW.payload_hash!=OLD.payload_hash OR NEW.action!=OLD.action OR NEW.observed_at!=OLD.observed_at BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTENDANCE'); END;
CREATE TRIGGER correction_validate BEFORE INSERT ON attendance_corrections WHEN NOT EXISTS(SELECT 1 FROM attendance_corrections WHERE id=NEW.id) BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM visits WHERE id=NEW.visit_id AND center_id=NEW.center_id AND version=NEW.expected_version) THEN RAISE(ABORT,'STALE_VISIT') END;
 SELECT CASE WHEN NEW.check_out_at IS NOT NULL AND NEW.check_out_at<NEW.check_in_at THEN RAISE(ABORT,'DEPARTURE_BEFORE_ARRIVAL') END;
 SELECT CASE WHEN NEW.check_in_at>NEW.recorded_at OR NEW.check_out_at>NEW.recorded_at THEN RAISE(ABORT,'FUTURE_CORRECTION') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM visits v JOIN visits current ON current.id=NEW.visit_id WHERE v.student_id=current.student_id AND v.id!=NEW.visit_id AND v.check_in_at<coalesce(NEW.check_out_at,'9999') AND coalesce(v.check_out_at,'9999')>NEW.check_in_at) THEN RAISE(ABORT,'OVERLAPPING_VISIT') END;
END;
CREATE TRIGGER correction_apply AFTER INSERT ON attendance_corrections BEGIN
 UPDATE visits SET check_in_at=NEW.check_in_at,check_out_at=NEW.check_out_at,version=version+1 WHERE id=NEW.visit_id;
 INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at) VALUES(NEW.id,NEW.center_id,NEW.actor_id,NEW.actor_name,'attendance_correction','visit',NEW.visit_id,json_object('reason',NEW.reason,'priorCheckInAt',NEW.prior_check_in_at,'priorCheckOutAt',NEW.prior_check_out_at,'checkInAt',NEW.check_in_at,'checkOutAt',NEW.check_out_at),NEW.recorded_at);
END;
CREATE TRIGGER correction_no_update BEFORE UPDATE ON attendance_corrections BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CORRECTION'); END;
CREATE TRIGGER correction_no_delete BEFORE DELETE ON attendance_corrections BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CORRECTION'); END;
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;
