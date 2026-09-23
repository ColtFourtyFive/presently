-- Admission for one private monthly proof. Existing sessions are retained;
-- an over-capacity database can still be inspected, invalidated and cleaned.
-- No physical disk reservation or archive publication authority is granted.
CREATE VIEW archive_semantic_admitted_sessions AS
SELECT s.verification_id,s.generation
FROM archive_semantic_sessions s
WHERE NOT EXISTS(SELECT 1 FROM archive_semantic_sessions LIMIT 1 OFFSET 1)
  AND json_extract(s.root_reference_json,'$.kind')='monthly'
  AND NOT EXISTS(SELECT 1 FROM archive_semantic_manifests m
    WHERE m.verification_id=s.verification_id AND m.generation=s.generation LIMIT 1 OFFSET 1)
  AND NOT EXISTS(SELECT 1 FROM archive_semantic_manifests m
    WHERE m.verification_id=s.verification_id AND m.generation=s.generation AND (
      m.archive_id IS NOT s.root_archive_id OR
      m.manifest_sha256 IS NOT s.root_manifest_sha256 OR
      m.plaintext_bytes>16777216 OR m.record_count>20000 OR
      json_extract(m.manifest_json,'$.format') IS NOT 'kumon-history-archive-v2' OR
      json_extract(m.manifest_json,'$.kind') IS NOT 'monthly' OR
      json_type(m.manifest_json,'$.references') IS NOT 'array' OR
      json_array_length(m.manifest_json,'$.references') IS NOT 0 OR
      json_extract(m.manifest_json,'$.plaintextBytes') IS NOT m.plaintext_bytes OR
      json_extract(m.manifest_json,'$.recordCount') IS NOT m.record_count))
  AND NOT EXISTS(SELECT 1 FROM archive_semantic_runs r
    WHERE r.verification_id=s.verification_id AND r.generation=s.generation LIMIT 1 OFFSET 1);

CREATE TRIGGER archive_admission_session_insert BEFORE INSERT ON archive_semantic_sessions
WHEN EXISTS(SELECT 1 FROM archive_semantic_sessions)
  OR json_extract(NEW.root_reference_json,'$.kind') IS NOT 'monthly'
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_session_update BEFORE UPDATE ON archive_semantic_sessions
WHEN NEW.status!='invalid' AND NOT EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a
  WHERE a.verification_id=OLD.verification_id AND a.generation=OLD.generation)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_manifest_insert BEFORE INSERT ON archive_semantic_manifests
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a
    WHERE a.verification_id=NEW.verification_id AND a.generation=NEW.generation)
  OR EXISTS(SELECT 1 FROM archive_semantic_manifests m
    WHERE m.verification_id=NEW.verification_id AND m.generation=NEW.generation)
  OR NEW.plaintext_bytes>16777216 OR NEW.record_count>20000
  OR json_extract(NEW.manifest_json,'$.format') IS NOT 'kumon-history-archive-v2'
  OR json_extract(NEW.manifest_json,'$.kind') IS NOT 'monthly'
  OR json_type(NEW.manifest_json,'$.references') IS NOT 'array'
  OR json_array_length(NEW.manifest_json,'$.references') IS NOT 0
  OR json_extract(NEW.manifest_json,'$.plaintextBytes') IS NOT NEW.plaintext_bytes
  OR json_extract(NEW.manifest_json,'$.recordCount') IS NOT NEW.record_count
  OR NOT EXISTS(SELECT 1 FROM archive_semantic_sessions s
    WHERE s.verification_id=NEW.verification_id AND s.generation=NEW.generation
      AND s.root_archive_id=NEW.archive_id AND s.root_manifest_sha256=NEW.manifest_sha256)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_part_insert BEFORE INSERT ON archive_semantic_parts
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a
  WHERE a.verification_id=NEW.verification_id AND a.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_row_insert BEFORE INSERT ON archive_semantic_rows
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a
  WHERE a.verification_id=NEW.verification_id AND a.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_run_insert BEFORE INSERT ON archive_semantic_runs
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a
    WHERE a.verification_id=NEW.verification_id AND a.generation=NEW.generation)
  OR EXISTS(SELECT 1 FROM archive_semantic_runs r
    WHERE r.verification_id=NEW.verification_id AND r.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_run_update BEFORE UPDATE ON archive_semantic_runs
WHEN NEW.status!='invalid' AND NOT EXISTS(SELECT 1 FROM archive_semantic_admitted_sessions a
  WHERE a.verification_id=NEW.verification_id AND a.generation=NEW.generation)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_operation_insert BEFORE INSERT ON archive_semantic_operations
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_admitted_sessions a
  USING(verification_id,generation) WHERE r.run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_total_insert BEFORE INSERT ON archive_semantic_visit_totals
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_admitted_sessions a
  USING(verification_id,generation) WHERE r.run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_total_update BEFORE UPDATE ON archive_semantic_visit_totals
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_admitted_sessions a
  USING(verification_id,generation) WHERE r.run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

CREATE TRIGGER archive_admission_witness_insert BEFORE INSERT ON archive_semantic_review_witnesses
WHEN NOT EXISTS(SELECT 1 FROM archive_semantic_runs r JOIN archive_semantic_admitted_sessions a
  USING(verification_id,generation) WHERE r.run_id=NEW.run_id)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_STAGING_ADMISSION_LIMIT'); END;

INSERT INTO schema_versions(version) VALUES(20);
