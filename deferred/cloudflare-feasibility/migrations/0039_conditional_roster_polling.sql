CREATE TABLE roster_revisions (
  center_id TEXT PRIMARY KEY REFERENCES centers(id),
  version INTEGER NOT NULL CHECK(version >= 1)
);

INSERT INTO roster_revisions(center_id, version)
SELECT id, 1 FROM centers;

CREATE TRIGGER roster_revision_center_insert
AFTER INSERT ON centers
BEGIN
  INSERT INTO roster_revisions(center_id, version) VALUES(NEW.id, 1)
  ON CONFLICT(center_id) DO NOTHING;
END;

CREATE TRIGGER roster_revision_visit_insert
AFTER INSERT ON visits
BEGIN
  UPDATE roster_revisions SET version=version+1 WHERE center_id=NEW.center_id;
END;

CREATE TRIGGER roster_revision_visit_update
AFTER UPDATE ON visits
BEGIN
  UPDATE roster_revisions SET version=version+1 WHERE center_id=OLD.center_id;
  UPDATE roster_revisions SET version=version+1
    WHERE center_id=NEW.center_id AND NEW.center_id IS NOT OLD.center_id;
END;

CREATE TRIGGER roster_revision_visit_delete
AFTER DELETE ON visits
BEGIN
  UPDATE roster_revisions SET version=version+1 WHERE center_id=OLD.center_id;
END;

CREATE TRIGGER roster_revision_student_update
AFTER UPDATE OF center_id, student_code, first_name, last_name, active ON students
WHEN NEW.center_id IS NOT OLD.center_id
  OR NEW.student_code IS NOT OLD.student_code
  OR NEW.first_name IS NOT OLD.first_name
  OR NEW.last_name IS NOT OLD.last_name
  OR NEW.active IS NOT OLD.active
BEGIN
  UPDATE roster_revisions SET version=version+1 WHERE center_id=OLD.center_id;
  UPDATE roster_revisions SET version=version+1
    WHERE center_id=NEW.center_id AND NEW.center_id IS NOT OLD.center_id;
END;

CREATE TRIGGER roster_revision_staff_update
AFTER UPDATE OF center_id, display_name ON staff
WHEN NEW.center_id IS NOT OLD.center_id OR NEW.display_name IS NOT OLD.display_name
BEGIN
  UPDATE roster_revisions SET version=version+1 WHERE center_id=OLD.center_id;
  UPDATE roster_revisions SET version=version+1
    WHERE center_id=NEW.center_id AND NEW.center_id IS NOT OLD.center_id;
END;

CREATE TRIGGER roster_revision_guardian_update
AFTER UPDATE OF center_id, display_name ON guardians
WHEN NEW.center_id IS NOT OLD.center_id OR NEW.display_name IS NOT OLD.display_name
BEGIN
  UPDATE roster_revisions SET version=version+1 WHERE center_id=OLD.center_id;
  UPDATE roster_revisions SET version=version+1
    WHERE center_id=NEW.center_id AND NEW.center_id IS NOT OLD.center_id;
END;

CREATE TRIGGER backup_lock_roster_revisions_insert
BEFORE INSERT ON roster_revisions
WHEN EXISTS(
  SELECT 1 FROM backup_runtime
  WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
BEGIN
  SELECT RAISE(ABORT,'backup_maintenance');
END;

CREATE TRIGGER backup_lock_roster_revisions_update
BEFORE UPDATE ON roster_revisions
WHEN EXISTS(
  SELECT 1 FROM backup_runtime
  WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
BEGIN
  SELECT RAISE(ABORT,'backup_maintenance');
END;

CREATE TRIGGER backup_lock_roster_revisions_delete
BEFORE DELETE ON roster_revisions
WHEN EXISTS(
  SELECT 1 FROM backup_runtime
  WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')
)
BEGIN
  SELECT RAISE(ABORT,'backup_maintenance');
END;

INSERT INTO schema_versions(version) VALUES(39);
