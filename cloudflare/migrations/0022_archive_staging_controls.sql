-- Internal lifecycle controls only. No scheduler, operator route, budget
-- reservation, publication authority, or automatic diagnostic pruning.
ALTER TABLE archive_semantic_lifecycle ADD COLUMN pause_reason TEXT;
ALTER TABLE archive_semantic_lifecycle ADD COLUMN paused_at TEXT;
ALTER TABLE archive_semantic_lifecycle ADD COLUMN next_eligible_at TEXT;
ALTER TABLE archive_semantic_lifecycle ADD COLUMN resume_grace_until TEXT;
ALTER TABLE archive_semantic_lifecycle ADD COLUMN renewed_at TEXT;
ALTER TABLE archive_semantic_lifecycle ADD COLUMN renewal_count INTEGER NOT NULL DEFAULT 0 CHECK(renewal_count>=0);
ALTER TABLE archive_semantic_lifecycle ADD COLUMN cleanup_lease_until TEXT;

CREATE TABLE archive_semantic_diagnostics (
  event_id TEXT PRIMARY KEY CHECK(length(event_id) BETWEEN 1 AND 1024),
  verification_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('pause','resume','renew','expired','cleanup_claim','cleanup_complete','restore_invalidated')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64 AND reason_code NOT GLOB '*[^A-Z0-9_]*'),
  actor_id TEXT CHECK(actor_id IS NULL OR length(actor_id) BETWEEN 1 AND 100),
  request_sha256 TEXT CHECK(request_sha256 IS NULL OR (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*')),
  created_at TEXT NOT NULL,
  lifecycle_revision INTEGER NOT NULL CHECK(lifecycle_revision>=0),
  archive_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  runner_error_code TEXT CHECK(runner_error_code IS NULL OR (length(runner_error_code) BETWEEN 1 AND 120 AND runner_error_code NOT GLOB '*[^A-Z0-9_]*')),
  cleanup_token_sha256 TEXT CHECK(cleanup_token_sha256 IS NULL OR (length(cleanup_token_sha256)=64 AND cleanup_token_sha256 NOT GLOB '*[^a-f0-9]*')),
  detail_json TEXT NOT NULL CHECK(json_valid(detail_json) AND json_type(detail_json)='object' AND length(CAST(detail_json AS BLOB))<=4096),
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=4096),
  CHECK((kind='restore_invalidated' AND request_sha256 IS NULL) OR (kind!='restore_invalidated' AND request_sha256 IS NOT NULL)),
  CHECK((kind IN ('cleanup_claim','cleanup_complete') AND cleanup_token_sha256 IS NOT NULL) OR (kind NOT IN ('cleanup_claim','cleanup_complete') AND cleanup_token_sha256 IS NULL))
) WITHOUT ROWID;
CREATE INDEX archive_semantic_diagnostics_session ON archive_semantic_diagnostics(verification_id,generation,created_at,event_id);
CREATE INDEX archive_semantic_diagnostics_created ON archive_semantic_diagnostics(created_at,event_id);
CREATE TRIGGER archive_diagnostics_no_replace BEFORE INSERT ON archive_semantic_diagnostics
WHEN EXISTS(SELECT 1 FROM archive_semantic_diagnostics WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_DIAGNOSTIC'); END;
CREATE TRIGGER archive_diagnostics_no_update BEFORE UPDATE ON archive_semantic_diagnostics
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_DIAGNOSTIC'); END;
CREATE TRIGGER archive_diagnostics_no_delete BEFORE DELETE ON archive_semantic_diagnostics
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_DIAGNOSTIC'); END;

CREATE VIEW archive_semantic_work_control AS
SELECT l.verification_id,l.generation,
  CASE WHEN s.status='verified' AND l.due_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'ARCHIVE_STAGING_EXPIRED'
    WHEN l.pause_reason IS NOT NULL THEN 'ARCHIVE_STAGING_PAUSED'
    WHEN max(l.renewal_deadline_at,coalesce(l.migration_grace_until,''))<=strftime('%Y-%m-%dT%H:%M:%fZ','now') THEN 'ARCHIVE_STAGING_RENEWAL_REQUIRED'
    ELSE NULL END AS work_error
FROM archive_semantic_lifecycle l JOIN archive_semantic_sessions s USING(verification_id,generation);

CREATE TRIGGER archive_lifecycle_control_insert_guard BEFORE INSERT ON archive_semantic_lifecycle
WHEN NEW.pause_reason IS NOT NULL OR NEW.paused_at IS NOT NULL OR NEW.next_eligible_at IS NOT NULL
  OR NEW.resume_grace_until IS NOT NULL OR NEW.renewed_at IS NOT NULL OR NEW.renewal_count!=0 OR NEW.cleanup_lease_until IS NOT NULL
BEGIN SELECT RAISE(ABORT,'ARCHIVE_LIFECYCLE_INVALID'); END;

DROP TRIGGER archive_lifecycle_update_guard;
CREATE TRIGGER archive_lifecycle_update_guard BEFORE UPDATE ON archive_semantic_lifecycle
WHEN NEW.verification_id IS NOT OLD.verification_id OR NEW.generation IS NOT OLD.generation
  OR NEW.admitted_at IS NOT OLD.admitted_at OR NEW.migration_grace_until IS NOT OLD.migration_grace_until
  OR NEW.revision!=OLD.revision+1
  OR NOT coalesce((
    ((NEW.progress_revision=OLD.progress_revision AND NEW.last_progress_at IS OLD.last_progress_at)
      OR (NEW.progress_revision=OLD.progress_revision+1 AND NEW.last_progress_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND NEW.pause_reason IS NULL AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
          WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status IN ('staging','frozen','verified'))))
    AND (NEW.verified_at IS OLD.verified_at OR (OLD.verified_at IS NULL AND NEW.verified_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
        WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='verified')))
    AND (
      (NEW.renewal_deadline_at IS OLD.renewal_deadline_at AND NEW.renewed_at IS OLD.renewed_at AND NEW.renewal_count=OLD.renewal_count)
      OR (NEW.renewal_deadline_at>OLD.renewal_deadline_at AND NEW.renewal_deadline_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+14 days')
        AND NEW.renewed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.renewal_count=OLD.renewal_count+1
        AND NEW.progress_revision=OLD.progress_revision AND NEW.verified_at IS OLD.verified_at
        AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
          WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status IN ('staging','frozen'))
        AND NOT EXISTS(SELECT 1 FROM archive_semantic_runs r WHERE r.verification_id=NEW.verification_id AND r.generation=NEW.generation
          AND r.status='running' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))))
    AND ((NEW.pause_reason IS NULL AND NEW.paused_at IS NULL AND NEW.next_eligible_at IS NULL)
      OR (NEW.pause_reason IN ('maintenance','daily_budget','capacity','size_unavailable') AND NEW.paused_at IS NOT NULL
        AND NEW.next_eligible_at>NEW.paused_at AND NEW.next_eligible_at<=max(NEW.renewal_deadline_at,coalesce(NEW.migration_grace_until,''))
        AND EXISTS(SELECT 1 FROM archive_semantic_sessions s WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status IN ('staging','frozen'))))
    AND (NEW.resume_grace_until IS OLD.resume_grace_until
      OR (NEW.resume_grace_until IS NULL AND EXISTS(SELECT 1 FROM archive_semantic_sessions s WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='invalid'))
      OR (OLD.pause_reason IS NOT NULL AND NEW.pause_reason IS NULL
        AND NEW.resume_grace_until=min(max(NEW.renewal_deadline_at,coalesce(NEW.migration_grace_until,'')),strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day'))))
    AND (NEW.cleanup_lease_until IS OLD.cleanup_lease_until
      OR (NEW.cleanup_lease_until IS NULL AND EXISTS(SELECT 1 FROM archive_semantic_sessions s WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='invalid' AND s.cleanup_token IS NULL))
      OR (NEW.cleanup_lease_until=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds')
        AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
          WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL)))
    AND EXISTS(SELECT 1 FROM archive_semantic_sessions s WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation
      AND (
        (s.status='invalid' AND NEW.pause_reason IS NULL AND NEW.resume_grace_until IS NULL
          AND ((NEW.cleanup_lease_until IS NULL AND NEW.due_at=min(OLD.due_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')))
            OR (NEW.cleanup_lease_until IS NOT NULL AND NEW.due_at=NEW.cleanup_lease_until)))
        OR (s.status='verified' AND NEW.pause_reason IS NULL AND NEW.due_at=max(coalesce(NEW.migration_grace_until,''),min(NEW.renewal_deadline_at,strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(NEW.verified_at,NEW.last_progress_at,NEW.admitted_at),'+1 day'))))
        OR (s.status IN ('staging','frozen') AND NEW.due_at=CASE WHEN NEW.pause_reason IS NOT NULL THEN NEW.next_eligible_at ELSE
          max(coalesce(NEW.migration_grace_until,''),min(NEW.renewal_deadline_at,max(coalesce(NEW.resume_grace_until,''),strftime('%Y-%m-%dT%H:%M:%fZ',coalesce(NEW.last_progress_at,NEW.admitted_at),'+1 day')))) END)
      ))
  ),0)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_LIFECYCLE_INVALID'); END;

DROP TRIGGER archive_lifecycle_invalidated;
CREATE TRIGGER archive_lifecycle_invalidated AFTER UPDATE ON archive_semantic_sessions
WHEN NEW.status='invalid' AND (OLD.status!='invalid' OR (NEW.cleanup_token IS NULL AND NEW.cleanup_generation IS NULL AND EXISTS(
  SELECT 1 FROM archive_semantic_lifecycle l WHERE l.verification_id=NEW.verification_id AND l.generation=NEW.generation
    AND (l.pause_reason IS NOT NULL OR l.resume_grace_until IS NOT NULL OR l.cleanup_lease_until IS NOT NULL))))
BEGIN
  INSERT INTO archive_semantic_diagnostics(event_id,verification_id,generation,execution_generation,kind,reason_code,request_sha256,created_at,lifecycle_revision,archive_id,manifest_sha256,runner_error_code,detail_json,result_json)
  SELECT 'restore-'||lower(hex(NEW.verification_id))||'-'||lower(hex(NEW.generation)),NEW.verification_id,NEW.generation,h.generation,'restore_invalidated','RUNTIME_RESTORED',NULL,
    strftime('%Y-%m-%dT%H:%M:%fZ','now'),l.revision+1,NEW.root_archive_id,NEW.root_manifest_sha256,
    (SELECT CASE WHEN error_code NOT GLOB '*[^A-Z0-9_]*' AND length(error_code) BETWEEN 1 AND 120 THEN error_code ELSE NULL END FROM archive_semantic_runs r WHERE r.verification_id=NEW.verification_id AND r.generation=NEW.generation AND error_code IS NOT NULL ORDER BY run_id LIMIT 1),
    json_object('admittedAt',l.admitted_at,'lastProgressAt',l.last_progress_at,'progressRevision',l.progress_revision,'verifiedAt',l.verified_at,
      'renewalDeadlineAt',l.renewal_deadline_at,'renewalCount',l.renewal_count,'renewedAt',l.renewed_at,'pauseReason',l.pause_reason,'pausedAt',l.paused_at,'nextEligibleAt',l.next_eligible_at,'resumeGraceUntil',l.resume_grace_until),
    json_object('status','invalidated','revision',l.revision+1)
  FROM archive_semantic_lifecycle l JOIN history_runtime h ON h.id=1
  WHERE l.verification_id=NEW.verification_id AND l.generation=NEW.generation AND h.generation!=NEW.generation
    AND NOT EXISTS(SELECT 1 FROM archive_semantic_diagnostics WHERE event_id='restore-'||lower(hex(NEW.verification_id))||'-'||lower(hex(NEW.generation)));
  UPDATE archive_semantic_lifecycle SET due_at=min(due_at,strftime('%Y-%m-%dT%H:%M:%fZ','now')),revision=revision+1,
    pause_reason=NULL,paused_at=NULL,next_eligible_at=NULL,resume_grace_until=NULL,cleanup_lease_until=NULL
  WHERE verification_id=NEW.verification_id AND generation=NEW.generation;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING') END;
END;

CREATE TRIGGER archive_control_manifests_insert BEFORE INSERT ON archive_semantic_manifests
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation) THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_PAUSED') THEN RAISE(ABORT,'ARCHIVE_STAGING_PAUSED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_RENEWAL_REQUIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_RENEWAL_REQUIRED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_EXPIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_EXPIRED') END;
END;

CREATE TRIGGER archive_control_parts_insert BEFORE INSERT ON archive_semantic_parts
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation) THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_PAUSED') THEN RAISE(ABORT,'ARCHIVE_STAGING_PAUSED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_RENEWAL_REQUIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_RENEWAL_REQUIRED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_EXPIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_EXPIRED') END;
END;

CREATE TRIGGER archive_control_rows_insert BEFORE INSERT ON archive_semantic_rows
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation) THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_PAUSED') THEN RAISE(ABORT,'ARCHIVE_STAGING_PAUSED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_RENEWAL_REQUIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_RENEWAL_REQUIRED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_EXPIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_EXPIRED') END;
END;

CREATE TRIGGER archive_control_runs_insert BEFORE INSERT ON archive_semantic_runs
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation) THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_PAUSED') THEN RAISE(ABORT,'ARCHIVE_STAGING_PAUSED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_RENEWAL_REQUIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_RENEWAL_REQUIRED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_EXPIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_EXPIRED') END;
END;

CREATE TRIGGER archive_control_runs_update BEFORE UPDATE ON archive_semantic_runs
WHEN NEW.status!='invalid' AND (NEW.status='running' OR NEW.status='complete' OR NEW.revision>OLD.revision)
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation) THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_PAUSED') THEN RAISE(ABORT,'ARCHIVE_STAGING_PAUSED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_RENEWAL_REQUIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_RENEWAL_REQUIRED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_EXPIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_EXPIRED') END;
END;

CREATE TRIGGER archive_control_sessions_update BEFORE UPDATE ON archive_semantic_sessions
WHEN NEW.status IN ('frozen','verified')
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation) THEN RAISE(ABORT,'ARCHIVE_LIFECYCLE_MISSING')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_PAUSED') THEN RAISE(ABORT,'ARCHIVE_STAGING_PAUSED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_RENEWAL_REQUIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_RENEWAL_REQUIRED')
    WHEN EXISTS(SELECT 1 FROM archive_semantic_work_control WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND work_error='ARCHIVE_STAGING_EXPIRED') THEN RAISE(ABORT,'ARCHIVE_STAGING_EXPIRED') END;
END;

CREATE TRIGGER archive_control_sessions_delete BEFORE DELETE ON archive_semantic_sessions
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER archive_control_manifests_delete BEFORE DELETE ON archive_semantic_manifests
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER archive_control_parts_delete BEFORE DELETE ON archive_semantic_parts
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER archive_control_rows_delete BEFORE DELETE ON archive_semantic_rows
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER archive_control_runs_delete BEFORE DELETE ON archive_semantic_runs
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER archive_control_operations_delete BEFORE DELETE ON archive_semantic_operations
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  JOIN archive_semantic_runs r ON r.verification_id=s.verification_id AND r.generation=s.generation
  WHERE r.run_id=OLD.run_id AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER archive_control_visit_totals_delete BEFORE DELETE ON archive_semantic_visit_totals
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  JOIN archive_semantic_runs r ON r.verification_id=s.verification_id AND r.generation=s.generation
  WHERE r.run_id=OLD.run_id AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER archive_control_review_witnesses_delete BEFORE DELETE ON archive_semantic_review_witnesses
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN archive_semantic_lifecycle l USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  JOIN archive_semantic_runs r ON r.verification_id=s.verification_id AND r.generation=s.generation
  WHERE r.run_id=OLD.run_id AND s.status='invalid' AND s.cleanup_token IS NOT NULL
    AND l.cleanup_lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_CLEANUP_STALE'); END;

CREATE TRIGGER backup_lock_archive_semantic_diagnostics_insert BEFORE INSERT ON archive_semantic_diagnostics
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_semantic_diagnostics_update BEFORE UPDATE ON archive_semantic_diagnostics
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_semantic_diagnostics_delete BEFORE DELETE ON archive_semantic_diagnostics
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(22);
