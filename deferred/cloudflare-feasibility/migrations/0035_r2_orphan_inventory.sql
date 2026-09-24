-- Reference-aware R2 orphan inventory. Cleanup remains dry-run only.

CREATE TABLE r2_orphan_inventory_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  inventory_enabled INTEGER NOT NULL DEFAULT 1 CHECK (inventory_enabled IN (0, 1)),
  delete_enabled INTEGER NOT NULL DEFAULT 0 CHECK (delete_enabled = 0),
  minimum_age_seconds INTEGER NOT NULL DEFAULT 604800 CHECK (minimum_age_seconds >= 86400),
  minimum_confirmations INTEGER NOT NULL DEFAULT 2 CHECK (minimum_confirmations >= 2),
  minimum_confirmation_interval_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (minimum_confirmation_interval_seconds >= 3600),
  page_size INTEGER NOT NULL DEFAULT 100 CHECK (page_size BETWEEN 1 AND 250),
  updated_at TEXT NOT NULL
);

INSERT INTO r2_orphan_inventory_policy(
  id, inventory_enabled, delete_enabled, minimum_age_seconds,
  minimum_confirmations, minimum_confirmation_interval_seconds, page_size, updated_at
) VALUES(1, 1, 0, 604800, 2, 86400, 100, '1970-01-01T00:00:00.000Z');

CREATE TABLE r2_orphan_inventory_runs (
  id TEXT PRIMARY KEY,
  active_slot INTEGER UNIQUE CHECK (active_slot IS NULL OR active_slot = 1),
  generation TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'building_references', 'listing', 'refreshing_references',
    'classifying', 'finalizing', 'complete', 'failed'
  )),
  reference_pass INTEGER NOT NULL DEFAULT 1 CHECK (reference_pass IN (1, 2)),
  reference_source_index INTEGER NOT NULL DEFAULT 0 CHECK (reference_source_index >= 0),
  reference_cursor TEXT NOT NULL DEFAULT '' CHECK (length(reference_cursor) <= 1024),
  r2_cursor TEXT,
  classification_cursor TEXT,
  finalization_cursor TEXT,
  policy_snapshot_json TEXT NOT NULL CHECK (json_valid(policy_snapshot_json)),
  delete_enabled INTEGER NOT NULL DEFAULT 0 CHECK (delete_enabled = 0),
  listed_count INTEGER NOT NULL DEFAULT 0 CHECK (listed_count >= 0),
  referenced_count INTEGER NOT NULL DEFAULT 0 CHECK (referenced_count >= 0),
  orphan_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (orphan_candidate_count >= 0),
  protected_count INTEGER NOT NULL DEFAULT 0 CHECK (protected_count >= 0),
  eligible_count INTEGER NOT NULL DEFAULT 0 CHECK (eligible_count >= 0),
  reference_completed_at TEXT,
  listing_completed_at TEXT,
  refreshed_at TEXT,
  completed_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status IN ('complete', 'failed') AND active_slot IS NULL) OR
         (status NOT IN ('complete', 'failed') AND active_slot = 1))
);

CREATE INDEX r2_orphan_inventory_runs_status_idx
  ON r2_orphan_inventory_runs(status, created_at);

CREATE TABLE r2_orphan_inventory_references (
  run_id TEXT NOT NULL REFERENCES r2_orphan_inventory_runs(id) ON DELETE RESTRICT,
  reference_prefix TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('manifest', 'archive_id', 'backup_prefix', 'backup_archive')),
  captured_at TEXT NOT NULL,
  PRIMARY KEY (run_id, reference_prefix)
);

CREATE INDEX r2_orphan_inventory_references_prefix_idx
  ON r2_orphan_inventory_references(run_id, reference_prefix);

CREATE TABLE r2_orphan_inventory_objects (
  run_id TEXT NOT NULL REFERENCES r2_orphan_inventory_runs(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  etag TEXT NOT NULL,
  version TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'pending' CHECK (classification IN (
    'pending', 'referenced', 'orphan_candidate', 'protected', 'unstable'
  )),
  matched_reference_prefix TEXT,
  matched_source_table TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, object_key)
);

CREATE INDEX r2_orphan_inventory_objects_classification_idx
  ON r2_orphan_inventory_objects(run_id, classification, object_key);

CREATE TABLE r2_orphan_observations (
  object_key TEXT PRIMARY KEY,
  etag TEXT NOT NULL,
  version TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at TEXT NOT NULL,
  first_candidate_at TEXT,
  last_candidate_at TEXT,
  confirmation_count INTEGER NOT NULL DEFAULT 0 CHECK (confirmation_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('candidate', 'eligible', 'referenced', 'protected', 'unstable')),
  generation TEXT NOT NULL,
  last_run_id TEXT NOT NULL REFERENCES r2_orphan_inventory_runs(id) ON DELETE RESTRICT,
  updated_at TEXT NOT NULL
);

CREATE INDEX r2_orphan_observations_status_idx
  ON r2_orphan_observations(status, updated_at);

CREATE TABLE r2_orphan_cleanup_plans (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES r2_orphan_inventory_runs(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL,
  etag TEXT NOT NULL,
  version TEXT,
  size INTEGER NOT NULL CHECK (size >= 0),
  uploaded_at TEXT NOT NULL,
  generation TEXT NOT NULL,
  confirmation_count INTEGER NOT NULL CHECK (confirmation_count >= 2),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  evidence_sha256 TEXT NOT NULL CHECK (length(evidence_sha256) = 64),
  delete_enabled INTEGER NOT NULL DEFAULT 0 CHECK (delete_enabled = 0),
  status TEXT NOT NULL DEFAULT 'dry_run_blocked' CHECK (status = 'dry_run_blocked'),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, object_key)
);

CREATE INDEX r2_orphan_cleanup_plans_object_idx
  ON r2_orphan_cleanup_plans(object_key, created_at);

-- A recovery changes the history generation. Any inventory assembled against
-- the former generation must stop before it can produce cleanup evidence.
CREATE TRIGGER r2_orphan_inventory_generation_reset
AFTER UPDATE OF generation ON history_runtime
WHEN OLD.generation <> NEW.generation
BEGIN
  UPDATE r2_orphan_inventory_runs
  SET status='failed',
      active_slot=NULL,
      error_code='R2_INVENTORY_GENERATION_CHANGED',
      completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE active_slot=1 AND status NOT IN ('complete','failed');
END;

-- Backup snapshots depend on a closed table inventory. Freeze every new
-- schema-35 table while the existing backup write barrier is active.
CREATE TRIGGER backup_lock_r2_orphan_inventory_policy_insert BEFORE INSERT ON r2_orphan_inventory_policy WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_policy_update BEFORE UPDATE ON r2_orphan_inventory_policy WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_policy_delete BEFORE DELETE ON r2_orphan_inventory_policy WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_runs_insert BEFORE INSERT ON r2_orphan_inventory_runs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_runs_update BEFORE UPDATE ON r2_orphan_inventory_runs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_runs_delete BEFORE DELETE ON r2_orphan_inventory_runs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_references_insert BEFORE INSERT ON r2_orphan_inventory_references WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_references_update BEFORE UPDATE ON r2_orphan_inventory_references WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_references_delete BEFORE DELETE ON r2_orphan_inventory_references WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_objects_insert BEFORE INSERT ON r2_orphan_inventory_objects WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_objects_update BEFORE UPDATE ON r2_orphan_inventory_objects WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_inventory_objects_delete BEFORE DELETE ON r2_orphan_inventory_objects WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_observations_insert BEFORE INSERT ON r2_orphan_observations WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_observations_update BEFORE UPDATE ON r2_orphan_observations WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_observations_delete BEFORE DELETE ON r2_orphan_observations WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_cleanup_plans_insert BEFORE INSERT ON r2_orphan_cleanup_plans WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_cleanup_plans_update BEFORE UPDATE ON r2_orphan_cleanup_plans WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_r2_orphan_cleanup_plans_delete BEFORE DELETE ON r2_orphan_cleanup_plans WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(35);
