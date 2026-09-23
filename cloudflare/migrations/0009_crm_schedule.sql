-- Weekly wall-clock slots use the center timezone. They are plans, not visits.
CREATE TABLE schedules (
  id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers(id),
  student_id TEXT NOT NULL REFERENCES students(id),
  day_of_week INTEGER NOT NULL CHECK(typeof(day_of_week)='integer' AND day_of_week BETWEEN 0 AND 6),
  start_time TEXT NOT NULL CHECK(length(start_time)=5 AND start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time<'24:00'),
  start_minute INTEGER NOT NULL CHECK(start_minute=CAST(substr(start_time,1,2) AS INTEGER)*60+CAST(substr(start_time,4,2) AS INTEGER)),
  duration_minutes INTEGER NOT NULL CHECK(typeof(duration_minutes)='integer' AND duration_minutes BETWEEN 15 AND 180),
  subject TEXT NOT NULL CHECK(subject IN ('Math','Reading')),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(start_minute+duration_minutes<=1440)
);
CREATE INDEX schedules_center_week ON schedules(center_id,active,day_of_week,start_time,id);
CREATE INDEX schedules_student_day ON schedules(center_id,student_id,day_of_week,active,start_minute);

CREATE TRIGGER schedule_validate_insert BEFORE INSERT ON schedules BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND center_id=NEW.center_id)
    THEN RAISE(ABORT,'SCHEDULE_STUDENT_NOT_FOUND') END;
  SELECT CASE WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND active=0)
    THEN RAISE(ABORT,'SCHEDULE_STUDENT_INACTIVE') END;
  SELECT CASE WHEN NEW.active=1 AND NOT EXISTS(SELECT 1 FROM students s,json_each(s.subjects) subject WHERE s.id=NEW.student_id AND subject.value=NEW.subject)
    THEN RAISE(ABORT,'SCHEDULE_SUBJECT_REQUIRED') END;
  SELECT CASE WHEN NEW.active=1 AND EXISTS(SELECT 1 FROM schedules WHERE center_id=NEW.center_id AND student_id=NEW.student_id
    AND day_of_week=NEW.day_of_week AND active=1 AND start_minute<NEW.start_minute+NEW.duration_minutes
    AND start_minute+duration_minutes>NEW.start_minute) THEN RAISE(ABORT,'SCHEDULE_OVERLAP') END;
END;

CREATE TRIGGER schedule_validate_update BEFORE UPDATE ON schedules
WHEN NEW.active=1 AND (OLD.active=0 OR NEW.center_id!=OLD.center_id OR NEW.student_id!=OLD.student_id
  OR NEW.day_of_week!=OLD.day_of_week OR NEW.start_minute!=OLD.start_minute
  OR NEW.duration_minutes!=OLD.duration_minutes OR NEW.subject!=OLD.subject)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND center_id=NEW.center_id)
    THEN RAISE(ABORT,'SCHEDULE_STUDENT_NOT_FOUND') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND active=0)
    THEN RAISE(ABORT,'SCHEDULE_STUDENT_INACTIVE') END;
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM students s,json_each(s.subjects) subject WHERE s.id=NEW.student_id AND subject.value=NEW.subject)
    THEN RAISE(ABORT,'SCHEDULE_SUBJECT_REQUIRED') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM schedules WHERE id!=OLD.id AND center_id=NEW.center_id AND student_id=NEW.student_id
    AND day_of_week=NEW.day_of_week AND active=1 AND start_minute<NEW.start_minute+NEW.duration_minutes
    AND start_minute+duration_minutes>NEW.start_minute) THEN RAISE(ABORT,'SCHEDULE_OVERLAP') END;
END;

CREATE TRIGGER backup_guard_schedules_insert BEFORE INSERT ON schedules WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_schedules_update BEFORE UPDATE ON schedules WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_schedules_delete BEFORE DELETE ON schedules WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(9);
