-- Compact immutable index for student correction history. Detailed correction
-- evidence remains in live D1 or authenticated archives.
CREATE TABLE history_correction_heads (
  correction_id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers(id),
  visit_id TEXT NOT NULL,
  student_id TEXT NOT NULL REFERENCES students(id),
  recorded_at TEXT NOT NULL,
  residency TEXT NOT NULL DEFAULT 'live' CHECK(residency='live')
) WITHOUT ROWID;
CREATE INDEX history_correction_heads_student_time
  ON history_correction_heads(center_id,student_id,recorded_at DESC,correction_id);
CREATE INDEX history_correction_heads_visit
  ON history_correction_heads(visit_id,recorded_at DESC,correction_id);

-- Existing releases have not enabled source eviction, so migration can derive
-- every correction owner directly from retained source rows.
INSERT INTO history_correction_heads(
  correction_id,center_id,visit_id,student_id,recorded_at,residency
)
SELECT c.id,c.center_id,c.visit_id,v.student_id,c.recorded_at,'live'
FROM attendance_corrections c JOIN visits v ON v.id=c.visit_id;
SELECT CASE WHEN
  (SELECT count(*) FROM history_correction_heads)!=(SELECT count(*) FROM attendance_corrections)
  THEN json_extract('HISTORY_CORRECTION_HEAD_BACKFILL_FAILED','$') END;

CREATE TRIGGER history_correction_heads_validate_insert
BEFORE INSERT ON history_correction_heads
WHEN NEW.residency!='live' OR NOT EXISTS(
  SELECT 1 FROM attendance_corrections c JOIN visits v ON v.id=c.visit_id
  WHERE c.id=NEW.correction_id AND c.center_id IS NEW.center_id
    AND c.visit_id IS NEW.visit_id AND v.student_id IS NEW.student_id
    AND c.recorded_at IS NEW.recorded_at
)
BEGIN SELECT RAISE(ABORT,'HISTORY_CORRECTION_PROJECTION_MISMATCH'); END;
CREATE TRIGGER history_correction_heads_no_update
BEFORE UPDATE ON history_correction_heads
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_CORRECTION_HEAD'); END;
CREATE TRIGGER history_correction_heads_no_delete
BEFORE DELETE ON history_correction_heads
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_CORRECTION_HEAD'); END;
CREATE TRIGGER history_correction_head_capture
AFTER INSERT ON attendance_corrections
BEGIN
  INSERT INTO history_correction_heads(
    correction_id,center_id,visit_id,student_id,recorded_at,residency
  )
  SELECT NEW.id,NEW.center_id,NEW.visit_id,v.student_id,NEW.recorded_at,'live'
  FROM visits v WHERE v.id=NEW.visit_id;
END;

CREATE TRIGGER backup_guard_history_correction_heads_insert
BEFORE INSERT ON history_correction_heads
WHEN EXISTS(SELECT 1 FROM backup_runtime
  WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_history_correction_heads_update
BEFORE UPDATE ON history_correction_heads
WHEN EXISTS(SELECT 1 FROM backup_runtime
  WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_history_correction_heads_delete
BEFORE DELETE ON history_correction_heads
WHEN EXISTS(SELECT 1 FROM backup_runtime
  WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(30);
