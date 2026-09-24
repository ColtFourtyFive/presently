-- CRM conversion retains grade and allocates center-local student references.
ALTER TABLE students ADD COLUMN grade TEXT NOT NULL DEFAULT '' CHECK(length(grade)<=30);
ALTER TABLE centers ADD COLUMN student_sequence INTEGER NOT NULL DEFAULT 0 CHECK(student_sequence>=0);

CREATE TABLE inquiries (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id),
 contact_name TEXT NOT NULL, student_name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
 subjects TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(subjects)),
 stage TEXT NOT NULL DEFAULT 'New' CHECK(stage IN ('New','Contacted','Assessment scheduled','Assessment completed','Enrolled','Closed lost','Do not contact')),
 source TEXT NOT NULL, owner_name TEXT NOT NULL, next_action TEXT NOT NULL DEFAULT '', due_at TEXT,
 notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 converted_student_id TEXT REFERENCES students(id), version INTEGER NOT NULL DEFAULT 1 CHECK(version>0),
 creation_hash TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES staff(id),
 last_actor_id TEXT NOT NULL REFERENCES staff(id), last_actor_name TEXT NOT NULL,
 CHECK((stage='Enrolled')=(converted_student_id IS NOT NULL))
);
CREATE INDEX inquiries_center_stage ON inquiries(center_id,stage,created_at,id);
CREATE INDEX inquiries_center_created ON inquiries(center_id,created_at,id);
CREATE UNIQUE INDEX inquiry_converted_student ON inquiries(converted_student_id) WHERE converted_student_id IS NOT NULL;
CREATE TABLE inquiry_stage_history (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), inquiry_id TEXT NOT NULL REFERENCES inquiries(id),
 from_stage TEXT, to_stage TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES staff(id), actor_name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX inquiry_history_page ON inquiry_stage_history(center_id,inquiry_id,created_at,id);
CREATE TABLE tasks (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
 due_at TEXT NOT NULL, completed_at TEXT, type TEXT NOT NULL DEFAULT 'follow_up' CHECK(type IN ('follow_up','assessment','operations')),
 inquiry_id TEXT REFERENCES inquiries(id), completed_by TEXT REFERENCES staff(id), completed_by_name TEXT
);
CREATE INDEX tasks_center_due ON tasks(center_id,completed_at,due_at,id);
CREATE INDEX tasks_inquiry ON tasks(center_id,inquiry_id,completed_at);

CREATE TRIGGER inquiry_validate_update BEFORE UPDATE ON inquiries BEGIN
 SELECT CASE WHEN NEW.id!=OLD.id OR NEW.center_id!=OLD.center_id OR NEW.creation_hash!=OLD.creation_hash OR NEW.created_by!=OLD.created_by
   OR NEW.version!=OLD.version+1 THEN RAISE(ABORT,'INQUIRY_INVALID_UPDATE') END;
 SELECT CASE WHEN OLD.converted_student_id IS NOT NULL AND (NEW.stage!='Enrolled' OR NEW.converted_student_id IS NOT OLD.converted_student_id)
   THEN RAISE(ABORT,'INQUIRY_ALREADY_ENROLLED') END;
 SELECT CASE WHEN NEW.stage='Closed lost' AND trim(NEW.notes)='' THEN RAISE(ABORT,'INQUIRY_REASON_REQUIRED') END;
 SELECT CASE WHEN NEW.converted_student_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM students WHERE id=NEW.converted_student_id AND center_id=NEW.center_id)
   THEN RAISE(ABORT,'INQUIRY_STUDENT_NOT_FOUND') END;
 SELECT CASE WHEN OLD.stage IN ('Closed lost','Do not contact') AND NEW.converted_student_id IS NOT NULL
   THEN RAISE(ABORT,'INQUIRY_CLOSED') END;
END;
CREATE TRIGGER inquiry_created AFTER INSERT ON inquiries BEGIN
 INSERT INTO inquiry_stage_history(id,center_id,inquiry_id,to_stage,actor_id,actor_name,created_at)
 VALUES(NEW.id||':1',NEW.center_id,NEW.id,'New',NEW.last_actor_id,NEW.last_actor_name,NEW.created_at);
 INSERT INTO tasks(id,center_id,title,detail,due_at,type,inquiry_id)
 SELECT NEW.id,NEW.center_id,NEW.next_action,NEW.contact_name||' · '||NEW.student_name,
   coalesce(NEW.due_at,strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+1 day')),'follow_up',NEW.id WHERE NEW.next_action!='';
 INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
 VALUES(NEW.id||':created',NEW.center_id,NEW.last_actor_id,NEW.last_actor_name,'inquiry_created','inquiry',NEW.id,'{}',NEW.created_at);
END;
CREATE TRIGGER inquiry_updated AFTER UPDATE ON inquiries BEGIN
 INSERT INTO inquiry_stage_history(id,center_id,inquiry_id,from_stage,to_stage,actor_id,actor_name,created_at)
 SELECT NEW.id||':'||NEW.version,NEW.center_id,NEW.id,OLD.stage,NEW.stage,NEW.last_actor_id,NEW.last_actor_name,NEW.updated_at WHERE NEW.stage!=OLD.stage;
 UPDATE tasks SET completed_at=NEW.updated_at WHERE center_id=NEW.center_id AND inquiry_id=NEW.id AND completed_at IS NULL
   AND NEW.stage IN ('Closed lost','Do not contact','Enrolled');
 -- Match Railway: changing a next step updates the existing pending task. Clearing
 -- the inquiry date retains that task's due date; completed tasks stay completed.
 UPDATE tasks SET title=NEW.next_action,due_at=coalesce(NEW.due_at,due_at)
   WHERE center_id=NEW.center_id AND inquiry_id=NEW.id AND completed_at IS NULL
   AND (NEW.next_action IS NOT OLD.next_action OR NEW.due_at IS NOT OLD.due_at);
 INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
 VALUES(NEW.id||':updated:'||NEW.version,NEW.center_id,NEW.last_actor_id,NEW.last_actor_name,
   CASE WHEN OLD.converted_student_id IS NULL AND NEW.converted_student_id IS NOT NULL THEN 'inquiry_enrolled' ELSE 'inquiry_updated' END,
   'inquiry',NEW.id,json_object('fromStage',OLD.stage,'toStage',NEW.stage,'studentId',NEW.converted_student_id),NEW.updated_at);
END;
CREATE TRIGGER task_validate_insert BEFORE INSERT ON tasks WHEN NEW.inquiry_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM inquiries WHERE id=NEW.inquiry_id AND center_id=NEW.center_id) THEN RAISE(ABORT,'INQUIRY_NOT_FOUND') END;
END;
CREATE TRIGGER task_completed AFTER UPDATE ON tasks WHEN OLD.completed_at IS NULL AND NEW.completed_at IS NOT NULL AND NEW.completed_by IS NOT NULL BEGIN
 INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
 VALUES(NEW.id||':completed',NEW.center_id,NEW.completed_by,NEW.completed_by_name,'task_completed','task',NEW.id,'{}',NEW.completed_at);
END;
CREATE TRIGGER inquiry_history_no_update BEFORE UPDATE ON inquiry_stage_history BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INQUIRY_HISTORY'); END;
CREATE TRIGGER inquiry_history_no_delete BEFORE DELETE ON inquiry_stage_history BEGIN SELECT RAISE(ABORT,'IMMUTABLE_INQUIRY_HISTORY'); END;

CREATE TRIGGER backup_guard_inquiries_insert BEFORE INSERT ON inquiries WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_inquiries_update BEFORE UPDATE ON inquiries WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_inquiries_delete BEFORE DELETE ON inquiries WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_inquiry_history_insert BEFORE INSERT ON inquiry_stage_history WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_inquiry_history_update BEFORE UPDATE ON inquiry_stage_history WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_inquiry_history_delete BEFORE DELETE ON inquiry_stage_history WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_tasks_insert BEFORE INSERT ON tasks WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_tasks_update BEFORE UPDATE ON tasks WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_tasks_delete BEFORE DELETE ON tasks WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
INSERT INTO schema_versions(version) VALUES(11);
