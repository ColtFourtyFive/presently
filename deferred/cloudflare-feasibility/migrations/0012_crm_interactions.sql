CREATE TABLE interactions (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), student_id TEXT NOT NULL REFERENCES students(id),
 channel TEXT NOT NULL CHECK(channel IN ('Phone','Email','Meeting','Other')),
 summary TEXT NOT NULL CHECK(length(trim(summary))>0 AND length(summary)<=2000),
 actor_id TEXT NOT NULL REFERENCES staff(id), actor_name TEXT NOT NULL,
 occurred_at TEXT NOT NULL, creation_hash TEXT NOT NULL
);
CREATE INDEX interactions_student_history ON interactions(center_id,student_id,occurred_at DESC,id DESC);
CREATE TRIGGER interaction_validate_insert BEFORE INSERT ON interactions BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM students WHERE id=NEW.student_id AND center_id=NEW.center_id)
  THEN RAISE(ABORT,'STUDENT_NOT_FOUND') END;
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM staff WHERE id=NEW.actor_id AND center_id=NEW.center_id AND active=1 AND role IN ('owner','manager','front_desk'))
  THEN RAISE(ABORT,'INTERACTION_FORBIDDEN') END;
END;
CREATE TRIGGER interaction_created AFTER INSERT ON interactions BEGIN
 INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
 VALUES('interaction:'||NEW.id,NEW.center_id,NEW.actor_id,NEW.actor_name,'interaction_logged','interaction',NEW.id,
  json_object('studentId',NEW.student_id,'channel',NEW.channel),NEW.occurred_at);
END;
CREATE TRIGGER interaction_no_update BEFORE UPDATE ON interactions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INTERACTION'); END;
CREATE TRIGGER interaction_no_delete BEFORE DELETE ON interactions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INTERACTION'); END;
CREATE TRIGGER backup_guard_interactions_insert BEFORE INSERT ON interactions
 WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
 BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
INSERT INTO schema_versions(version) VALUES(12);
