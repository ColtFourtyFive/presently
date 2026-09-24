-- Operational bookkeeping only. No publication, cleanup scheduler, or proof
-- authority is granted by a lifecycle timestamp or revision.
CREATE TABLE archive_semantic_lifecycle (
  verification_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  admitted_at TEXT NOT NULL,
  last_progress_at TEXT,
  progress_revision INTEGER NOT NULL DEFAULT 0 CHECK(progress_revision>=0),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=progress_revision),
  verified_at TEXT,
  renewal_deadline_at TEXT NOT NULL,
  migration_grace_until TEXT,
  due_at TEXT NOT NULL,
  PRIMARY KEY(verification_id,generation),
  FOREIGN KEY(verification_id,generation) REFERENCES archive_semantic_sessions(verification_id,generation),
  CHECK((progress_revision=0 AND last_progress_at IS NULL) OR (progress_revision>0 AND last_progress_at IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX archive_semantic_lifecycle_due ON archive_semantic_lifecycle(due_at,verification_id,generation);

-- Historical last-progress and first-verification times are unknown. Retain
-- original admission and grant explicit migration grace, never invented work.
-- Seed before maintenance guards so a maintenance-fenced migration can run.
INSERT INTO archive_semantic_lifecycle(verification_id,generation,admitted_at,last_progress_at,progress_revision,revision,verified_at,renewal_deadline_at,migration_grace_until,due_at)
SELECT verification_id,generation,created_at,NULL,0,0,NULL,
  strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+14 days'),
  CASE WHEN status='invalid' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') END,
  CASE WHEN status='invalid' THEN strftime('%Y-%m-%dT%H:%M:%fZ','now') ELSE
    max(strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'),strftime('%Y-%m-%dT%H:%M:%fZ',created_at,'+1 day')) END
FROM archive_semantic_sessions;

CREATE TRIGGER archive_lifecycle_insert_guard BEFORE INSERT ON archive_semantic_lifecycle
WHEN NEW.last_progress_at IS NOT NULL OR NEW.progress_revision!=0 OR NEW.revision!=0
  OR NEW.verified_at IS NOT NULL OR NEW.migration_grace_until IS NOT NULL
  OR NEW.renewal_deadline_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.admitted_at,'+14 days')
  OR NEW.due_at IS NOT strftime('%Y-%m-%dT%H:%M:%fZ',NEW.admitted_at,'+1 day')
  OR EXISTS(SELECT 1 FROM archive_semantic_lifecycle WHERE verification_id=NEW.verification_id AND generation=NEW.generation)
  OR NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
    WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='staging' AND s.created_at=NEW.admitted_at)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_LIFECYCLE_INVALID'); END;

-- These shapes prevent accidental metadata drift. The database administrator
-- remains trusted, as for the underlying private verification tables.
CREATE TRIGGER archive_lifecycle_update_guard BEFORE UPDATE ON archive_semantic_lifecycle
WHEN NEW.verification_id IS NOT OLD.verification_id OR NEW.generation IS NOT OLD.generation
  OR NEW.admitted_at IS NOT OLD.admitted_at OR NEW.renewal_deadline_at IS NOT OLD.renewal_deadline_at
  OR NEW.migration_grace_until IS NOT OLD.migration_grace_until OR NEW.revision!=OLD.revision+1
  OR NOT coalesce((
    (NEW.progress_revision=OLD.progress_revision+1 AND NEW.last_progress_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NEW.verified_at IS OLD.verified_at
      AND NEW.due_at=max(coalesce(NEW.migration_grace_until,''),min(NEW.renewal_deadline_at,
        strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(NEW.verified_at,NEW.last_progress_at,NEW.admitted_at),'+1 day')))
      AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
        WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status IN ('staging','frozen','verified')))
    OR (NEW.progress_revision=OLD.progress_revision AND NEW.last_progress_at IS OLD.last_progress_at
      AND OLD.verified_at IS NULL AND NEW.verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND NEW.due_at=max(coalesce(NEW.migration_grace_until,''),min(NEW.renewal_deadline_at,
        strftime('%Y-%m-%dT%H:%M:%fZ',NEW.verified_at,'+1 day')))
      AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
        WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='verified'))
    OR (NEW.progress_revision=OLD.progress_revision AND NEW.last_progress_at IS OLD.last_progress_at
      AND NEW.verified_at IS OLD.verified_at AND NEW.due_at=min(OLD.due_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND EXISTS(SELECT 1 FROM archive_semantic_sessions s
        WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='invalid'))
  ),0)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_LIFECYCLE_INVALID'); END;

-- The parent has the existing generation/cleanup-token deletion guard. Its
-- AFTER DELETE hook removes bookkeeping in the same statement, before FK checks.
CREATE TRIGGER archive_lifecycle_delete_guard BEFORE DELETE ON archive_semantic_lifecycle
WHEN EXISTS(SELECT 1 FROM archive_semantic_sessions WHERE verification_id=OLD.verification_id AND generation=OLD.generation)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_LIFECYCLE_PARENT_PRESENT'); END;

CREATE TRIGGER archive_lifecycle_session_insert AFTER INSERT ON archive_semantic_sessions
BEGIN
  INSERT INTO archive_semantic_lifecycle(verification_id,generation,admitted_at,renewal_deadline_at,due_at)
  VALUES(NEW.verification_id,NEW.generation,NEW.created_at,
    strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+14 days'),strftime('%Y-%m-%dT%H:%M:%fZ',NEW.created_at,'+1 day'));
END;

CREATE TRIGGER archive_lifecycle_manifest_progress AFTER INSERT ON archive_semantic_manifests
BEGIN
  UPDATE archive_semantic_lifecycle SET last_progress_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),progress_revision=progress_revision+1,revision=revision+1,
    due_at=max(coalesce(migration_grace_until,''),min(renewal_deadline_at,
      strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(verified_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'+1 day')))
  WHERE verification_id=NEW.verification_id AND generation=NEW.generation;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING') END;
END;

CREATE TRIGGER archive_lifecycle_part_progress AFTER INSERT ON archive_semantic_parts
BEGIN
  UPDATE archive_semantic_lifecycle SET last_progress_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),progress_revision=progress_revision+1,revision=revision+1,
    due_at=max(coalesce(migration_grace_until,''),min(renewal_deadline_at,
      strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(verified_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'+1 day')))
  WHERE verification_id=NEW.verification_id AND generation=NEW.generation;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING') END;
END;

CREATE TRIGGER archive_lifecycle_runner_progress AFTER UPDATE ON archive_semantic_runs
WHEN OLD.status='running' AND NEW.status IN ('pending','complete') AND NEW.revision=OLD.revision+1
  AND (NEW.cursor_json IS NOT OLD.cursor_json OR NEW.phase IS NOT OLD.phase)
  AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
BEGIN
  UPDATE archive_semantic_lifecycle SET last_progress_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),progress_revision=progress_revision+1,revision=revision+1,
    due_at=max(coalesce(migration_grace_until,''),min(renewal_deadline_at,
      strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(verified_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),'+1 day')))
  WHERE verification_id=NEW.verification_id AND generation=NEW.generation;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING') END;
END;

CREATE TRIGGER archive_lifecycle_first_verified AFTER UPDATE ON archive_semantic_sessions
WHEN OLD.status!='verified' AND NEW.status='verified'
BEGIN
  UPDATE archive_semantic_lifecycle SET verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1,
    due_at=max(coalesce(migration_grace_until,''),min(renewal_deadline_at,strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day')))
  WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND verified_at IS NULL;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING') END;
END;

CREATE TRIGGER archive_lifecycle_invalidated AFTER UPDATE ON archive_semantic_sessions
WHEN OLD.status!='invalid' AND NEW.status='invalid'
BEGIN
  UPDATE archive_semantic_lifecycle SET due_at=min(due_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1
  WHERE verification_id=NEW.verification_id AND generation=NEW.generation;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING') END;
END;

CREATE TRIGGER archive_lifecycle_session_delete AFTER DELETE ON archive_semantic_sessions
BEGIN
  DELETE FROM archive_semantic_lifecycle WHERE verification_id=OLD.verification_id AND generation=OLD.generation;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING') END;
END;

CREATE TRIGGER backup_lock_archive_semantic_lifecycle_insert BEFORE INSERT ON archive_semantic_lifecycle
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_lifecycle_update BEFORE UPDATE ON archive_semantic_lifecycle
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_lifecycle_delete BEFORE DELETE ON archive_semantic_lifecycle
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(21);
