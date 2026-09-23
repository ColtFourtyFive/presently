-- Internal resumable semantic proof for one v2 monthly base. No publication.
CREATE TABLE archive_semantic_runs (
  run_id TEXT PRIMARY KEY,
  verification_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  snapshot_commit_token TEXT NOT NULL,
  graph_sha256 TEXT NOT NULL,
  validator_version INTEGER NOT NULL CHECK(validator_version=1),
  archive_id TEXT NOT NULL,
  header_json TEXT NOT NULL CHECK(json_valid(header_json) AND length(CAST(header_json AS BLOB))<=49152),
  status TEXT NOT NULL CHECK(status IN ('pending','running','complete','invalid')),
  phase TEXT NOT NULL CHECK(phase IN ('records','visits','reviews','complete')),
  error_code TEXT CHECK(error_code IS NULL OR length(error_code)<=120),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  lease_token TEXT,
  lease_expires_at TEXT,
  cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json) AND length(CAST(cursor_json AS BLOB))<=8192),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(verification_id,generation,snapshot_commit_token,validator_version),
  FOREIGN KEY(verification_id,generation) REFERENCES archive_semantic_sessions(verification_id,generation),
  CHECK((status='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status!='running' AND lease_token IS NULL AND lease_expires_at IS NULL)),
  CHECK(status!='complete' OR phase='complete')
) WITHOUT ROWID;
CREATE TABLE archive_semantic_operations (
  run_id TEXT NOT NULL REFERENCES archive_semantic_runs(run_id),
  request_id TEXT NOT NULL,
  source_table TEXT NOT NULL CHECK(source_table IN ('attendance_events','attendance_corrections')),
  record_key TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  operation_version INTEGER NOT NULL CHECK(operation_version BETWEEN 1 AND 9007199254740991),
  record_bytes INTEGER NOT NULL CHECK(record_bytes BETWEEN 1 AND 65536),
  PRIMARY KEY(run_id,request_id)
) WITHOUT ROWID;
CREATE INDEX archive_semantic_operations_visit ON archive_semantic_operations(run_id,visit_id,operation_version,request_id);
CREATE TABLE archive_semantic_visit_totals (
  run_id TEXT NOT NULL REFERENCES archive_semantic_runs(run_id),
  visit_id TEXT NOT NULL,
  operation_count INTEGER NOT NULL CHECK(operation_count BETWEEN 1 AND 2048),
  record_bytes INTEGER NOT NULL CHECK(record_bytes BETWEEN 1 AND 4194304),
  PRIMARY KEY(run_id,visit_id)
) WITHOUT ROWID;
CREATE TABLE archive_semantic_review_witnesses (
  run_id TEXT NOT NULL REFERENCES archive_semantic_runs(run_id),
  review_id TEXT NOT NULL,
  audit_key TEXT NOT NULL,
  PRIMARY KEY(run_id,review_id)
) WITHOUT ROWID;
CREATE TRIGGER archive_semantic_run_insert BEFORE INSERT ON archive_semantic_runs
WHEN NEW.status!='pending' OR NEW.phase!='records' OR NEW.revision!=0 OR EXISTS(SELECT 1 FROM archive_semantic_runs WHERE run_id=NEW.run_id)
  OR NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
    WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='frozen'
      AND s.commit_token=NEW.snapshot_commit_token AND s.graph_sha256=NEW.graph_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_run_update BEFORE UPDATE ON archive_semantic_runs
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.verification_id IS NOT OLD.verification_id OR NEW.generation IS NOT OLD.generation
  OR NEW.snapshot_commit_token IS NOT OLD.snapshot_commit_token OR NEW.graph_sha256 IS NOT OLD.graph_sha256
  OR NEW.validator_version IS NOT OLD.validator_version OR NEW.archive_id IS NOT OLD.archive_id OR NEW.header_json IS NOT OLD.header_json
  OR NEW.created_at IS NOT OLD.created_at OR NEW.revision<OLD.revision
  OR NOT ((NEW.status='invalid' AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL)
    OR (OLD.status!='invalid' AND EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
      WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status IN ('frozen','verified')
        AND s.commit_token=OLD.snapshot_commit_token AND s.graph_sha256=OLD.graph_sha256)))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_run_no_delete BEFORE DELETE ON archive_semantic_runs
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_operations_insert BEFORE INSERT ON archive_semantic_operations
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE r.run_id=NEW.run_id AND r.status='running' AND r.phase='records' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND s.status='frozen' AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_operations_update BEFORE UPDATE ON archive_semantic_operations
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE r.run_id=NEW.run_id AND r.status='running' AND r.phase='records' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND s.status='frozen' AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_operations_immutable BEFORE UPDATE ON archive_semantic_operations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_operations_no_replace BEFORE INSERT ON archive_semantic_operations
WHEN EXISTS(SELECT 1 FROM archive_semantic_operations WHERE run_id=NEW.run_id AND request_id=NEW.request_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_operations_no_delete BEFORE DELETE ON archive_semantic_operations
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  WHERE r.run_id=OLD.run_id AND s.status='invalid' AND s.cleanup_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_visit_totals_insert BEFORE INSERT ON archive_semantic_visit_totals
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE r.run_id=NEW.run_id AND r.status='running' AND r.phase='records' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND s.status='frozen' AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_visit_totals_update BEFORE UPDATE ON archive_semantic_visit_totals
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE r.run_id=NEW.run_id AND r.status='running' AND r.phase='records' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND s.status='frozen' AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_visit_totals_no_delete BEFORE DELETE ON archive_semantic_visit_totals
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  WHERE r.run_id=OLD.run_id AND s.status='invalid' AND s.cleanup_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_review_witnesses_insert BEFORE INSERT ON archive_semantic_review_witnesses
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE r.run_id=NEW.run_id AND r.status='running' AND r.phase='records' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND s.status='frozen' AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_review_witnesses_update BEFORE UPDATE ON archive_semantic_review_witnesses
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE r.run_id=NEW.run_id AND r.status='running' AND r.phase='records' AND r.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
    AND s.status='frozen' AND s.commit_token=r.snapshot_commit_token AND s.graph_sha256=r.graph_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_SEMANTIC_RUN_STALE'); END;
CREATE TRIGGER archive_semantic_review_witnesses_immutable BEFORE UPDATE ON archive_semantic_review_witnesses
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_review_witnesses_no_replace BEFORE INSERT ON archive_semantic_review_witnesses
WHEN EXISTS(SELECT 1 FROM archive_semantic_review_witnesses WHERE run_id=NEW.run_id AND review_id=NEW.review_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_review_witnesses_no_delete BEFORE DELETE ON archive_semantic_review_witnesses
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_sessions s USING(verification_id,generation)
  JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  WHERE r.run_id=OLD.run_id AND s.status='invalid' AND s.cleanup_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_totals_identity BEFORE UPDATE ON archive_semantic_visit_totals
WHEN NEW.run_id IS NOT OLD.run_id OR NEW.visit_id IS NOT OLD.visit_id
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_SEMANTIC_RUN'); END;
CREATE TRIGGER archive_semantic_totals_bound_insert BEFORE INSERT ON archive_semantic_visit_totals
WHEN NEW.operation_count>2048 OR NEW.record_bytes>4194304
BEGIN SELECT RAISE(ABORT,'SEMANTIC_VISIT_CLOSURE_BOUND'); END;
CREATE TRIGGER archive_semantic_totals_bound_update BEFORE UPDATE ON archive_semantic_visit_totals
WHEN NEW.operation_count>2048 OR NEW.record_bytes>4194304
BEGIN SELECT RAISE(ABORT,'SEMANTIC_VISIT_CLOSURE_BOUND'); END;
CREATE TRIGGER backup_lock_archive_semantic_runs_insert BEFORE INSERT ON archive_semantic_runs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_runs_update BEFORE UPDATE ON archive_semantic_runs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_runs_delete BEFORE DELETE ON archive_semantic_runs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_operations_insert BEFORE INSERT ON archive_semantic_operations
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_operations_update BEFORE UPDATE ON archive_semantic_operations
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_operations_delete BEFORE DELETE ON archive_semantic_operations
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_visit_totals_insert BEFORE INSERT ON archive_semantic_visit_totals
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_visit_totals_update BEFORE UPDATE ON archive_semantic_visit_totals
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_visit_totals_delete BEFORE DELETE ON archive_semantic_visit_totals
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_review_witnesses_insert BEFORE INSERT ON archive_semantic_review_witnesses
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_review_witnesses_update BEFORE UPDATE ON archive_semantic_review_witnesses
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_review_witnesses_delete BEFORE DELETE ON archive_semantic_review_witnesses
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(19);
