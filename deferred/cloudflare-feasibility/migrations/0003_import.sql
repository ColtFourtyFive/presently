ALTER TABLE guardians ADD COLUMN import_ref TEXT;
ALTER TABLE students ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
CREATE TRIGGER students_revision AFTER UPDATE ON students WHEN NEW.revision=OLD.revision BEGIN UPDATE students SET revision=OLD.revision+1 WHERE id=NEW.id; END;
CREATE TRIGGER guardian_revision AFTER UPDATE ON guardians BEGIN UPDATE students SET revision=revision+1 WHERE id IN (SELECT student_id FROM student_guardians WHERE guardian_id=NEW.id); END;
CREATE TRIGGER guardian_link_insert_revision AFTER INSERT ON student_guardians BEGIN UPDATE students SET revision=revision+1 WHERE id=NEW.student_id; END;
CREATE TRIGGER guardian_link_update_revision AFTER UPDATE ON student_guardians BEGIN UPDATE students SET revision=revision+1 WHERE id=NEW.student_id; END;
CREATE TRIGGER guardian_link_delete_revision AFTER DELETE ON student_guardians BEGIN UPDATE students SET revision=revision+1 WHERE id=OLD.student_id; END;
CREATE UNIQUE INDEX guardians_import_ref ON guardians(center_id,import_ref) WHERE import_ref IS NOT NULL;
CREATE INDEX students_exact_name ON students(center_id,lower(first_name || ' ' || last_name));
CREATE TABLE roster_imports(id TEXT PRIMARY KEY,center_id TEXT NOT NULL REFERENCES centers(id),source_hash TEXT NOT NULL,mapping_hash TEXT NOT NULL,preview_token TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES staff(id),created_at TEXT NOT NULL,expires_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('preview','committing','completed','expired')),total_rows INTEGER NOT NULL,mapping_json TEXT NOT NULL,UNIQUE(center_id,source_hash,mapping_hash));
CREATE TABLE roster_import_rows(import_id TEXT NOT NULL REFERENCES roster_imports(id),row_number INTEGER NOT NULL,action TEXT NOT NULL CHECK(action IN ('create','update','skip','reject','review')),status TEXT NOT NULL CHECK(status IN ('pending','applied','skipped','rejected','review')),student_id TEXT,guardian_id TEXT,expected_student_revision INTEGER,payload_json TEXT,problem TEXT,applied_at TEXT,applied_student_revision INTEGER,PRIMARY KEY(import_id,row_number));
CREATE INDEX import_rows_pending ON roster_import_rows(import_id,status,row_number);
CREATE INDEX imports_cleanup ON roster_imports(status,expires_at);
CREATE INDEX import_payload_cleanup ON roster_import_rows(import_id) WHERE payload_json IS NOT NULL;
CREATE TRIGGER import_apply BEFORE UPDATE OF status ON roster_import_rows WHEN OLD.status='pending' AND NEW.status='applied' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM roster_imports WHERE id=OLD.import_id AND status IN ('preview','committing') AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN RAISE(ABORT,'IMPORT_EXPIRED') END;
  SELECT CASE WHEN EXISTS(SELECT 1 FROM students s WHERE s.id=OLD.student_id AND s.revision!=coalesce(OLD.expected_student_revision,-1) AND s.revision!=coalesce((SELECT max(applied_student_revision) FROM roster_import_rows WHERE import_id=OLD.import_id AND student_id=OLD.student_id AND status='applied'),-1)) THEN RAISE(ABORT,'IMPORT_STALE') END;
  SELECT CASE WHEN OLD.expected_student_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM students WHERE id=OLD.student_id) THEN RAISE(ABORT,'IMPORT_STALE') END;
  INSERT INTO students(id,center_id,student_code,first_name,last_name,active,subjects,pickup_alert,created_at,updated_at)
  SELECT OLD.student_id,i.center_id,json_extract(OLD.payload_json,'$.studentCode'),json_extract(OLD.payload_json,'$.firstName'),json_extract(OLD.payload_json,'$.lastName'),1,json_extract(OLD.payload_json,'$.subjects'),json_extract(OLD.payload_json,'$.pickupAlert'),json_extract(OLD.payload_json,'$.appliedVersion'),json_extract(OLD.payload_json,'$.appliedVersion') FROM roster_imports i WHERE i.id=OLD.import_id
  ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,subjects=excluded.subjects,pickup_alert=excluded.pickup_alert,updated_at=excluded.updated_at;
  SELECT CASE WHEN OLD.guardian_id IS NOT NULL AND EXISTS(SELECT 1 FROM guardians g WHERE g.id=OLD.guardian_id AND (g.display_name!=json_extract(OLD.payload_json,'$.guardianName') OR g.email!=json_extract(OLD.payload_json,'$.guardianEmail') OR g.phone!=json_extract(OLD.payload_json,'$.guardianPhone'))) THEN RAISE(ABORT,'IMPORT_GUARDIAN_CHANGED') END;
  SELECT CASE WHEN OLD.guardian_id IS NOT NULL AND EXISTS(SELECT 1 FROM guardians g JOIN roster_imports i ON i.id=OLD.import_id WHERE g.center_id=i.center_id AND g.import_ref=nullif(json_extract(OLD.payload_json,'$.guardianReference'),'') AND g.id!=OLD.guardian_id) THEN RAISE(ABORT,'IMPORT_GUARDIAN_CHANGED') END;
  INSERT OR IGNORE INTO guardians(id,center_id,display_name,email,phone,created_at,import_ref)
  SELECT OLD.guardian_id,i.center_id,json_extract(OLD.payload_json,'$.guardianName'),json_extract(OLD.payload_json,'$.guardianEmail'),json_extract(OLD.payload_json,'$.guardianPhone'),json_extract(OLD.payload_json,'$.appliedVersion'),nullif(json_extract(OLD.payload_json,'$.guardianReference'),'') FROM roster_imports i WHERE i.id=OLD.import_id AND OLD.guardian_id IS NOT NULL;
  INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note)
  SELECT OLD.student_id,OLD.guardian_id,json_extract(OLD.payload_json,'$.guardianRelationship'),json_extract(OLD.payload_json,'$.pickupAuthority'),json_extract(OLD.payload_json,'$.pickupAuthorityNote') WHERE OLD.guardian_id IS NOT NULL
  ON CONFLICT(student_id,guardian_id) DO UPDATE SET relationship=excluded.relationship,pickup_authority=excluded.pickup_authority,authority_note=excluded.authority_note;
  INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
  SELECT OLD.import_id||':'||OLD.row_number,i.center_id,s.id,s.display_name,'roster_import','student',OLD.student_id,json_object('importId',OLD.import_id,'row',OLD.row_number,'action',OLD.action),NEW.applied_at FROM roster_imports i JOIN staff s ON s.id=i.created_by WHERE i.id=OLD.import_id;
END;
CREATE TRIGGER import_capture_revision AFTER UPDATE OF status ON roster_import_rows WHEN OLD.status='pending' AND NEW.status='applied' BEGIN UPDATE roster_import_rows SET applied_student_revision=(SELECT revision FROM students WHERE id=NEW.student_id) WHERE import_id=NEW.import_id AND row_number=NEW.row_number; END;
INSERT INTO schema_versions(version) VALUES(3);
