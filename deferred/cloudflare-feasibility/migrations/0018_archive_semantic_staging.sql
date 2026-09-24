-- Private, nonauthoritative v2 verification staging. No archive publication,
-- record location, live deletion, or public-reader authority is enabled here.
CREATE TABLE archive_semantic_sessions (
  verification_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  root_archive_id TEXT NOT NULL,
  root_manifest_sha256 TEXT NOT NULL,
  root_reference_json TEXT NOT NULL CHECK(json_valid(root_reference_json)),
  status TEXT NOT NULL CHECK(status IN ('staging','frozen','verified','invalid')),
  commit_token TEXT,
  graph_sha256 TEXT,
  cleanup_generation TEXT,
  cleanup_token TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(verification_id,generation),
  CHECK((cleanup_generation IS NULL AND cleanup_token IS NULL) OR (status='invalid' AND cleanup_generation IS NOT NULL AND cleanup_token IS NOT NULL)),
  CHECK((status IN ('staging','invalid') AND commit_token IS NULL AND graph_sha256 IS NULL)
    OR (status IN ('frozen','verified') AND commit_token IS NOT NULL AND graph_sha256 IS NOT NULL))
) WITHOUT ROWID;
CREATE TABLE archive_semantic_manifests (
  verification_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  plaintext_bytes INTEGER NOT NULL CHECK(plaintext_bytes BETWEEN 0 AND 536870912),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 0 AND 512),
  record_count INTEGER NOT NULL CHECK(record_count BETWEEN 0 AND 131072),
  PRIMARY KEY(verification_id,generation,archive_id),
  FOREIGN KEY(verification_id,generation) REFERENCES archive_semantic_sessions(verification_id,generation)
) WITHOUT ROWID;
CREATE TABLE archive_semantic_parts (
  verification_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  part_index INTEGER NOT NULL CHECK(part_index BETWEEN 0 AND 511),
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json)),
  descriptor_sha256 TEXT NOT NULL,
  rowset_sha256 TEXT NOT NULL,
  commit_token TEXT NOT NULL,
  PRIMARY KEY(verification_id,generation,archive_id,part_index),
  UNIQUE(verification_id,generation,archive_id,part_index,commit_token),
  FOREIGN KEY(verification_id,generation,archive_id)
    REFERENCES archive_semantic_manifests(verification_id,generation,archive_id)
) WITHOUT ROWID;
CREATE TABLE archive_semantic_rows (
  verification_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  table_name TEXT NOT NULL CHECK(table_name IN ('centers','students','guardians','student_guardians','staff','visits','attendance_events','attendance_corrections','reviews','audit_entries')),
  record_key TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  part_commit_token TEXT NOT NULL,
  record_json TEXT NOT NULL CHECK(json_valid(record_json) AND length(CAST(record_json AS BLOB))<=65536),
  visit_id TEXT,
  event_id TEXT,
  entity_id TEXT,
  PRIMARY KEY(verification_id,generation,archive_id,table_name,record_key),
  FOREIGN KEY(verification_id,generation,archive_id,part_index,part_commit_token)
    REFERENCES archive_semantic_parts(verification_id,generation,archive_id,part_index,commit_token)
) WITHOUT ROWID;
CREATE INDEX archive_semantic_rows_visit ON archive_semantic_rows(verification_id,generation,archive_id,table_name,visit_id,record_key);
CREATE INDEX archive_semantic_rows_event ON archive_semantic_rows(verification_id,generation,archive_id,table_name,event_id,record_key);
CREATE INDEX archive_semantic_rows_entity ON archive_semantic_rows(verification_id,generation,archive_id,table_name,entity_id,record_key);

CREATE TRIGGER archive_semantic_session_insert BEFORE INSERT ON archive_semantic_sessions
WHEN NEW.status!='staging' OR NEW.commit_token IS NOT NULL OR NEW.graph_sha256 IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=NEW.generation)
  OR EXISTS(SELECT 1 FROM archive_semantic_sessions WHERE verification_id=NEW.verification_id AND generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_SESSION_INVALID'); END;
CREATE TRIGGER archive_semantic_session_update BEFORE UPDATE ON archive_semantic_sessions
WHEN NEW.verification_id IS NOT OLD.verification_id OR NEW.generation IS NOT OLD.generation
  OR NEW.root_archive_id IS NOT OLD.root_archive_id OR NEW.root_manifest_sha256 IS NOT OLD.root_manifest_sha256
  OR NEW.root_reference_json IS NOT OLD.root_reference_json OR NEW.created_at IS NOT OLD.created_at
  OR NOT (
    (NEW.status='invalid' AND NEW.commit_token IS NULL AND NEW.graph_sha256 IS NULL AND (
      (NEW.cleanup_generation IS NULL AND NEW.cleanup_token IS NULL) OR
      (NEW.cleanup_token IS NOT NULL AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=NEW.cleanup_generation))
    ))
    OR (EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=OLD.generation) AND (
      (OLD.status='staging' AND NEW.status='frozen' AND NEW.commit_token IS NOT NULL AND NEW.graph_sha256 IS NOT NULL)
      OR (OLD.status IN ('frozen','verified') AND NEW.status='verified' AND NEW.commit_token IS OLD.commit_token AND NEW.graph_sha256 IS OLD.graph_sha256)
    ))
  )
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_TRANSITION_INVALID'); END;
CREATE TRIGGER archive_semantic_session_no_delete BEFORE DELETE ON archive_semantic_sessions
WHEN OLD.status!='invalid' OR OLD.cleanup_token IS NULL OR NOT EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=OLD.cleanup_generation)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;

CREATE TRIGGER archive_semantic_manifests_insert BEFORE INSERT ON archive_semantic_manifests
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='staging')
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_STALE'); END;
CREATE TRIGGER archive_semantic_manifests_no_update BEFORE UPDATE ON archive_semantic_manifests
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;
CREATE TRIGGER archive_semantic_manifests_no_delete BEFORE DELETE ON archive_semantic_manifests
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;
CREATE TRIGGER archive_semantic_manifests_no_replace BEFORE INSERT ON archive_semantic_manifests
WHEN EXISTS(SELECT 1 FROM archive_semantic_manifests WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND archive_id=NEW.archive_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;

CREATE TRIGGER archive_semantic_parts_insert BEFORE INSERT ON archive_semantic_parts
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='staging')
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_STALE'); END;
CREATE TRIGGER archive_semantic_parts_no_update BEFORE UPDATE ON archive_semantic_parts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;
CREATE TRIGGER archive_semantic_parts_no_delete BEFORE DELETE ON archive_semantic_parts
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;
CREATE TRIGGER archive_semantic_parts_no_replace BEFORE INSERT ON archive_semantic_parts
WHEN EXISTS(SELECT 1 FROM archive_semantic_parts WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND archive_id=NEW.archive_id AND part_index=NEW.part_index)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;

CREATE TRIGGER archive_semantic_rows_insert BEFORE INSERT ON archive_semantic_rows
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.generation
  WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation AND s.status='staging')
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_STALE'); END;
CREATE TRIGGER archive_semantic_rows_no_update BEFORE UPDATE ON archive_semantic_rows
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;
CREATE TRIGGER archive_semantic_rows_no_delete BEFORE DELETE ON archive_semantic_rows
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s JOIN history_runtime h ON h.id=1 AND h.generation=s.cleanup_generation
  WHERE s.verification_id=OLD.verification_id AND s.generation=OLD.generation AND s.status='invalid' AND s.cleanup_token IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;
CREATE TRIGGER archive_semantic_rows_no_replace BEFORE INSERT ON archive_semantic_rows
WHEN EXISTS(SELECT 1 FROM archive_semantic_rows WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND archive_id=NEW.archive_id AND table_name=NEW.table_name AND record_key=NEW.record_key)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_STAGING'); END;

CREATE TRIGGER archive_semantic_manifest_capacity BEFORE INSERT ON archive_semantic_manifests
WHEN (SELECT count(*) FROM archive_semantic_manifests WHERE verification_id=NEW.verification_id AND generation=NEW.generation)>=32
 OR (SELECT coalesce(sum(plaintext_bytes),0) FROM archive_semantic_manifests WHERE verification_id=NEW.verification_id AND generation=NEW.generation)+NEW.plaintext_bytes>536870912
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_GRAPH_BOUND'); END;
CREATE TRIGGER backup_lock_archive_semantic_sessions_insert BEFORE INSERT ON archive_semantic_sessions
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_sessions_update BEFORE UPDATE ON archive_semantic_sessions
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_sessions_delete BEFORE DELETE ON archive_semantic_sessions
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_manifests_insert BEFORE INSERT ON archive_semantic_manifests
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_manifests_update BEFORE UPDATE ON archive_semantic_manifests
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_manifests_delete BEFORE DELETE ON archive_semantic_manifests
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_parts_insert BEFORE INSERT ON archive_semantic_parts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_parts_update BEFORE UPDATE ON archive_semantic_parts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_parts_delete BEFORE DELETE ON archive_semantic_parts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_rows_insert BEFORE INSERT ON archive_semantic_rows
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_rows_update BEFORE UPDATE ON archive_semantic_rows
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_semantic_rows_delete BEFORE DELETE ON archive_semantic_rows
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(18);
