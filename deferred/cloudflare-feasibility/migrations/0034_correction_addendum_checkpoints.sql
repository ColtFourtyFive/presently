-- Correction checkpoints reset the external addendum reference depth while
-- retaining every correction and audit record. This migration does not delete
-- D1 source rows or R2 objects.

CREATE TABLE archive_correction_checkpoint_builds (
  publication_id TEXT PRIMARY KEY,
  generation TEXT NOT NULL,
  archive_id TEXT NOT NULL UNIQUE,
  center_id TEXT NOT NULL REFERENCES centers(id),
  visit_id TEXT NOT NULL,
  base_publication_id TEXT NOT NULL REFERENCES archive_publications(publication_id),
  target_version INTEGER NOT NULL CHECK(typeof(target_version)='integer' AND target_version>=13),
  correction_count INTEGER NOT NULL CHECK(typeof(correction_count)='integer' AND correction_count BETWEEN 12 AND 64),
  state TEXT NOT NULL CHECK(state IN ('pending','published','invalid')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(created_at=updated_at OR state!='pending')
) WITHOUT ROWID;

CREATE UNIQUE INDEX archive_correction_checkpoint_active_visit
ON archive_correction_checkpoint_builds(visit_id)
WHERE state='pending';

CREATE TABLE archive_correction_checkpoint_publications (
  publication_id TEXT PRIMARY KEY REFERENCES archive_correction_checkpoint_builds(publication_id),
  generation TEXT NOT NULL,
  archive_id TEXT NOT NULL UNIQUE,
  center_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK(month GLOB '20[0-9][0-9]-[01][0-9]'),
  timezone TEXT NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
  base_publication_id TEXT NOT NULL REFERENCES archive_publications(publication_id),
  base_reference_json TEXT NOT NULL CHECK(json_valid(base_reference_json) AND length(CAST(base_reference_json AS BLOB))<=2048),
  starting_version INTEGER NOT NULL CHECK(typeof(starting_version)='integer' AND starting_version>=1),
  resulting_version INTEGER NOT NULL CHECK(typeof(resulting_version)='integer' AND resulting_version>starting_version),
  correction_count INTEGER NOT NULL CHECK(typeof(correction_count)='integer' AND correction_count BETWEEN 12 AND 64),
  correction_ids_json TEXT NOT NULL CHECK(json_valid(correction_ids_json) AND json_type(correction_ids_json)='array' AND length(CAST(correction_ids_json AS BLOB))<=16384),
  member_digest TEXT NOT NULL CHECK(length(member_digest)=64 AND member_digest NOT GLOB '*[^a-f0-9]*'),
  chain_depth INTEGER NOT NULL DEFAULT 1 CHECK(chain_depth=1),
  root_reference_json TEXT NOT NULL CHECK(json_valid(root_reference_json) AND length(CAST(root_reference_json AS BLOB))<=2048),
  header_json TEXT NOT NULL CHECK(json_valid(header_json) AND length(CAST(header_json AS BLOB))<=49152),
  header_sha256 TEXT NOT NULL CHECK(length(header_sha256)=64 AND header_sha256 NOT GLOB '*[^a-f0-9]*'),
  manifest_object_key TEXT NOT NULL CHECK(length(manifest_object_key) BETWEEN 1 AND 1024),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
  part_descriptors_json TEXT NOT NULL CHECK(json_valid(part_descriptors_json) AND json_type(part_descriptors_json)='array' AND json_array_length(part_descriptors_json) BETWEEN 1 AND 8 AND length(CAST(part_descriptors_json AS BLOB))<=131072),
  part_descriptors_sha256 TEXT NOT NULL CHECK(length(part_descriptors_sha256)=64 AND part_descriptors_sha256 NOT GLOB '*[^a-f0-9]*'),
  records_sha256 TEXT NOT NULL CHECK(length(records_sha256)=64 AND records_sha256 NOT GLOB '*[^a-f0-9]*'),
  published_at TEXT NOT NULL,
  CHECK(resulting_version=starting_version+correction_count),
  CHECK(json_array_length(correction_ids_json)=correction_count),
  CHECK(json_extract(base_reference_json,'$.kind') IS 'monthly'),
  CHECK(json_extract(root_reference_json,'$.archiveId') IS archive_id),
  CHECK(json_extract(root_reference_json,'$.kind') IS 'addendum'),
  CHECK(json_extract(root_reference_json,'$.manifestObjectKey') IS manifest_object_key),
  CHECK(json_extract(root_reference_json,'$.manifestSha256') IS manifest_sha256),
  CHECK(json_extract(header_json,'$.format') IS 'kumon-history-archive-v2'),
  CHECK(json_extract(header_json,'$.archiveId') IS archive_id),
  CHECK(json_extract(header_json,'$.centerId') IS center_id),
  CHECK(json_extract(header_json,'$.month') IS month),
  CHECK(json_extract(header_json,'$.timezone') IS timezone),
  CHECK(json_extract(header_json,'$.kind') IS 'addendum'),
  CHECK(json_type(header_json,'$.references') IS 'array' AND json_array_length(header_json,'$.references')=1),
  CHECK(json_extract(header_json,'$.references[0].archiveId') IS json_extract(base_reference_json,'$.archiveId')),
  CHECK(json_extract(header_json,'$.references[0].manifestSha256') IS json_extract(base_reference_json,'$.manifestSha256')),
  CHECK(json_extract(header_json,'$.recordCount')=1+2*correction_count),
  CHECK(json_extract(header_json,'$.recordCounts.visits')=1),
  CHECK(json_extract(header_json,'$.recordCounts.attendance_corrections')=correction_count),
  CHECK(json_extract(header_json,'$.recordCounts.audit_entries')=correction_count),
  CHECK(json_extract(header_json,'$.recordCounts.centers')=0 AND json_extract(header_json,'$.recordCounts.students')=0),
  CHECK(json_extract(header_json,'$.recordCounts.guardians')=0 AND json_extract(header_json,'$.recordCounts.student_guardians')=0),
  CHECK(json_extract(header_json,'$.recordCounts.staff')=0 AND json_extract(header_json,'$.recordCounts.attendance_events')=0),
  CHECK(json_extract(header_json,'$.recordCounts.reviews')=0),
  CHECK(json_extract(header_json,'$.parts') IS NULL)
) WITHOUT ROWID;

CREATE INDEX archive_correction_checkpoints_visit_version
ON archive_correction_checkpoint_publications(visit_id,resulting_version DESC,published_at DESC,publication_id);

CREATE UNIQUE INDEX archive_correction_checkpoint_visit_result
ON archive_correction_checkpoint_publications(visit_id,resulting_version);

CREATE TABLE archive_correction_checkpoint_members (
  publication_id TEXT NOT NULL REFERENCES archive_correction_checkpoint_publications(publication_id),
  ordinal INTEGER NOT NULL CHECK(typeof(ordinal)='integer' AND ordinal BETWEEN 1 AND 64),
  correction_id TEXT NOT NULL REFERENCES history_correction_outbox(id),
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version>=1),
  resulting_version INTEGER NOT NULL CHECK(resulting_version=expected_version+1),
  source_publication_id TEXT NOT NULL REFERENCES archive_correction_addendum_publications(publication_id),
  source_manifest_sha256 TEXT NOT NULL CHECK(length(source_manifest_sha256)=64 AND source_manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY(publication_id,ordinal),
  UNIQUE(publication_id,correction_id)
) WITHOUT ROWID;

CREATE INDEX archive_correction_checkpoint_member_correction
ON archive_correction_checkpoint_members(correction_id,publication_id);

CREATE TABLE archive_correction_checkpoint_availability (
  publication_id TEXT PRIMARY KEY REFERENCES archive_correction_checkpoint_publications(publication_id),
  generation TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable')),
  reconciliation_id TEXT,
  CHECK(status='ready' OR reconciliation_id IS NULL)
) WITHOUT ROWID;

CREATE TABLE archive_correction_checkpoint_reconciliation_jobs (
  reconciliation_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES archive_correction_checkpoint_publications(publication_id),
  execution_generation TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=524288),
  descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','complete','invalid')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX archive_correction_checkpoint_reconciliation_publication
ON archive_correction_checkpoint_reconciliation_jobs(publication_id,execution_generation,state);

CREATE TABLE archive_correction_checkpoint_reconciliation_receipts (
  reconciliation_id TEXT PRIMARY KEY REFERENCES archive_correction_checkpoint_reconciliation_jobs(reconciliation_id),
  publication_id TEXT NOT NULL REFERENCES archive_correction_checkpoint_publications(publication_id),
  execution_generation TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=524288),
  descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
  completed_at TEXT NOT NULL,
  UNIQUE(publication_id,execution_generation)
) WITHOUT ROWID;

CREATE TRIGGER archive_correction_checkpoint_build_insert_guard
BEFORE INSERT ON archive_correction_checkpoint_builds
WHEN NEW.state!='pending' OR NEW.revision!=0 OR NEW.created_at!=NEW.updated_at
OR NOT EXISTS(
  SELECT 1
  FROM history_runtime h
  JOIN history_visit_heads v ON v.visit_id=NEW.visit_id AND v.center_id=NEW.center_id
  JOIN archive_publications p ON p.publication_id=NEW.base_publication_id AND p.center_id=NEW.center_id
  JOIN archive_publication_records r ON r.publication_id=p.publication_id AND r.table_name='visits' AND r.record_key=NEW.visit_id
  JOIN archive_publication_availability a ON a.publication_id=p.publication_id
  WHERE h.id=1 AND h.state='ready' AND h.generation=NEW.generation
  AND a.status='ready' AND a.generation=NEW.generation
  AND v.version=NEW.target_version
)
OR (SELECT count(*) FROM archive_correction_addendum_publications p
    JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
    WHERE p.visit_id=NEW.visit_id
    AND a.status='ready' AND a.generation=NEW.generation)!=NEW.correction_count
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_BUILD_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_build_update_guard
BEFORE UPDATE ON archive_correction_checkpoint_builds
WHEN NEW.publication_id IS NOT OLD.publication_id
OR NEW.generation IS NOT OLD.generation
OR NEW.archive_id IS NOT OLD.archive_id
OR NEW.center_id IS NOT OLD.center_id
OR NEW.visit_id IS NOT OLD.visit_id
OR NEW.base_publication_id IS NOT OLD.base_publication_id
OR NEW.target_version IS NOT OLD.target_version
OR NEW.correction_count IS NOT OLD.correction_count
OR NEW.created_at IS NOT OLD.created_at
OR NEW.revision!=OLD.revision+1
OR NEW.updated_at<=OLD.updated_at
OR NOT (OLD.state='pending' AND NEW.state IN ('published','invalid'))
OR (NEW.state='published' AND NOT EXISTS(
  SELECT 1 FROM archive_correction_checkpoint_publications p
  JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
  WHERE p.publication_id=NEW.publication_id AND p.generation=NEW.generation
  AND p.archive_id=NEW.archive_id AND p.center_id=NEW.center_id AND p.visit_id=NEW.visit_id
  AND p.base_publication_id=NEW.base_publication_id AND p.resulting_version=NEW.target_version
  AND p.correction_count=NEW.correction_count AND a.status='ready' AND a.generation=NEW.generation
  AND (SELECT count(*) FROM archive_correction_checkpoint_members m WHERE m.publication_id=p.publication_id)=p.correction_count
  AND (SELECT min(ordinal) FROM archive_correction_checkpoint_members m WHERE m.publication_id=p.publication_id)=1
  AND (SELECT max(ordinal) FROM archive_correction_checkpoint_members m WHERE m.publication_id=p.publication_id)=p.correction_count
  AND NOT EXISTS(
    SELECT 1 FROM json_each(p.correction_ids_json) ids
    LEFT JOIN archive_correction_checkpoint_members m
      ON m.publication_id=p.publication_id AND m.ordinal=CAST(ids.key AS INTEGER)+1
    WHERE ids.type!='text' OR m.correction_id IS NOT ids.value
  )
))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_BUILD_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_build_no_delete
BEFORE DELETE ON archive_correction_checkpoint_builds
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT'); END;

CREATE TRIGGER archive_correction_checkpoint_publication_insert_guard
BEFORE INSERT ON archive_correction_checkpoint_publications
WHEN NOT EXISTS(
  SELECT 1 FROM archive_correction_checkpoint_builds b
  JOIN history_runtime h ON h.id=1 AND h.state='ready' AND h.generation=b.generation
  JOIN history_visit_heads v ON v.visit_id=b.visit_id AND v.center_id=b.center_id
  JOIN archive_publications p ON p.publication_id=b.base_publication_id
  JOIN archive_publication_availability a ON a.publication_id=p.publication_id
  WHERE b.publication_id=NEW.publication_id AND b.state='pending'
  AND b.generation=NEW.generation AND b.archive_id=NEW.archive_id
  AND b.center_id=NEW.center_id AND b.visit_id=NEW.visit_id
  AND b.base_publication_id=NEW.base_publication_id
  AND b.target_version=NEW.resulting_version AND b.correction_count=NEW.correction_count
  AND v.version=NEW.resulting_version
  AND p.center_id=NEW.center_id AND p.month=NEW.month AND p.timezone=NEW.timezone
  AND p.root_reference_json=NEW.base_reference_json
  AND a.status='ready' AND a.generation=NEW.generation
)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_PUBLICATION_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_publication_no_update
BEFORE UPDATE ON archive_correction_checkpoint_publications
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT'); END;

CREATE TRIGGER archive_correction_checkpoint_publication_no_delete
BEFORE DELETE ON archive_correction_checkpoint_publications
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT'); END;

CREATE TRIGGER archive_correction_checkpoint_member_insert_guard
BEFORE INSERT ON archive_correction_checkpoint_members
WHEN NOT EXISTS(
  SELECT 1 FROM archive_correction_checkpoint_publications c
  JOIN archive_correction_checkpoint_builds b ON b.publication_id=c.publication_id AND b.state='pending'
  JOIN history_correction_outbox o ON o.id=NEW.correction_id
  JOIN archive_correction_addendum_publications p ON p.publication_id=NEW.source_publication_id AND p.correction_id=o.id
  JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
  WHERE c.publication_id=NEW.publication_id
  AND NEW.ordinal BETWEEN 1 AND c.correction_count
  AND NEW.expected_version=c.starting_version+NEW.ordinal-1
  AND NEW.resulting_version=c.starting_version+NEW.ordinal
  AND o.center_id=c.center_id AND o.visit_id=c.visit_id
  AND o.expected_version=NEW.expected_version AND o.resulting_version=NEW.resulting_version
  AND p.center_id=c.center_id AND p.visit_id=c.visit_id
  AND p.expected_version=NEW.expected_version AND p.resulting_version=NEW.resulting_version
  AND p.manifest_sha256=NEW.source_manifest_sha256
  AND a.status='ready' AND a.generation=c.generation
)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_MEMBER_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_member_no_update
BEFORE UPDATE ON archive_correction_checkpoint_members
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT'); END;

CREATE TRIGGER archive_correction_checkpoint_member_no_delete
BEFORE DELETE ON archive_correction_checkpoint_members
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT'); END;

CREATE TRIGGER archive_correction_checkpoint_availability_insert_guard
BEFORE INSERT ON archive_correction_checkpoint_availability
WHEN NEW.status!='ready' OR NEW.reconciliation_id IS NOT NULL
OR NOT EXISTS(
  SELECT 1 FROM archive_correction_checkpoint_publications p
  JOIN archive_correction_checkpoint_builds b ON b.publication_id=p.publication_id AND b.state='pending'
  JOIN history_runtime h ON h.id=1 AND h.state='ready'
  WHERE p.publication_id=NEW.publication_id AND p.generation=NEW.generation AND h.generation=NEW.generation
)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_AVAILABILITY_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_availability_update_guard
BEFORE UPDATE ON archive_correction_checkpoint_availability
WHEN NEW.publication_id IS NOT OLD.publication_id
OR NOT (
  (NEW.status='unavailable' AND NEW.reconciliation_id IS NULL)
  OR (NEW.status='ready' AND NEW.reconciliation_id IS NOT NULL AND EXISTS(
    SELECT 1 FROM archive_correction_checkpoint_reconciliation_jobs j
    JOIN archive_correction_checkpoint_reconciliation_receipts r ON r.reconciliation_id=j.reconciliation_id
    JOIN history_runtime h ON h.id=1 AND h.state='ready' AND h.generation=j.execution_generation
    WHERE j.reconciliation_id=NEW.reconciliation_id AND j.state='complete'
    AND j.publication_id=NEW.publication_id AND j.execution_generation=NEW.generation
    AND r.publication_id=NEW.publication_id AND r.execution_generation=NEW.generation
  ))
)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_AVAILABILITY_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_availability_no_delete
BEFORE DELETE ON archive_correction_checkpoint_availability
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT'); END;

CREATE TRIGGER archive_correction_checkpoint_reconciliation_insert_guard
BEFORE INSERT ON archive_correction_checkpoint_reconciliation_jobs
WHEN NEW.state!='pending' OR NEW.revision!=0 OR NEW.created_at!=NEW.updated_at
OR NOT EXISTS(
  SELECT 1 FROM archive_correction_checkpoint_publications p
  JOIN history_runtime h ON h.id=1 AND h.state='ready'
  WHERE p.publication_id=NEW.publication_id AND h.generation=NEW.execution_generation
)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_RECONCILIATION_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_reconciliation_update_guard
BEFORE UPDATE ON archive_correction_checkpoint_reconciliation_jobs
WHEN NEW.reconciliation_id IS NOT OLD.reconciliation_id
OR NEW.publication_id IS NOT OLD.publication_id
OR NEW.execution_generation IS NOT OLD.execution_generation
OR NEW.descriptor_json IS NOT OLD.descriptor_json
OR NEW.descriptor_sha256 IS NOT OLD.descriptor_sha256
OR NEW.created_at IS NOT OLD.created_at
OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<=OLD.updated_at
OR NOT (OLD.state='pending' AND NEW.state IN ('complete','invalid'))
OR (NEW.state='complete' AND NOT EXISTS(
  SELECT 1 FROM archive_correction_checkpoint_reconciliation_receipts r
  WHERE r.reconciliation_id=NEW.reconciliation_id AND r.publication_id=NEW.publication_id
  AND r.execution_generation=NEW.execution_generation
  AND r.descriptor_json=NEW.descriptor_json AND r.descriptor_sha256=NEW.descriptor_sha256
))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_RECONCILIATION_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_reconciliation_no_delete
BEFORE DELETE ON archive_correction_checkpoint_reconciliation_jobs
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT_RECONCILIATION'); END;

CREATE TRIGGER archive_correction_checkpoint_receipt_insert_guard
BEFORE INSERT ON archive_correction_checkpoint_reconciliation_receipts
WHEN NOT EXISTS(
  SELECT 1 FROM archive_correction_checkpoint_reconciliation_jobs j
  JOIN history_runtime h ON h.id=1 AND h.state='ready'
  WHERE j.reconciliation_id=NEW.reconciliation_id AND j.state='pending'
  AND j.publication_id=NEW.publication_id AND j.execution_generation=NEW.execution_generation
  AND j.descriptor_json=NEW.descriptor_json AND j.descriptor_sha256=NEW.descriptor_sha256
  AND h.generation=NEW.execution_generation
)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_CHECKPOINT_RECEIPT_INVALID'); END;

CREATE TRIGGER archive_correction_checkpoint_receipt_no_update
BEFORE UPDATE ON archive_correction_checkpoint_reconciliation_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT_RECONCILIATION'); END;

CREATE TRIGGER archive_correction_checkpoint_receipt_no_delete
BEFORE DELETE ON archive_correction_checkpoint_reconciliation_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_CHECKPOINT_RECONCILIATION'); END;

CREATE TRIGGER history_runtime_invalidate_correction_checkpoints
AFTER UPDATE OF generation ON history_runtime
WHEN NEW.generation!=OLD.generation
BEGIN
  UPDATE archive_correction_checkpoint_availability
  SET generation=NEW.generation,status='unavailable',reconciliation_id=NULL;
  UPDATE archive_correction_checkpoint_builds
  SET state='invalid',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE state='pending';
  UPDATE archive_correction_checkpoint_reconciliation_jobs
  SET state='invalid',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE state='pending';
END;

-- A checkpoint may become the parent of selected evidence. Any change to its
-- authority invalidates a pending retention job for that visit.
CREATE TRIGGER history_retention_checkpoint_insert_drift
AFTER INSERT ON archive_correction_checkpoint_publications
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,NEW.visit_id,'checkpoint-added',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_ADDENDUM_CHANGED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;

CREATE TRIGGER history_retention_checkpoint_availability_drift
AFTER UPDATE ON archive_correction_checkpoint_availability
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,p.visit_id,'checkpoint-availability-changed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM archive_correction_checkpoint_publications p
  JOIN history_retention_items i ON i.visit_id=p.visit_id
  JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE p.publication_id=NEW.publication_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_ADDENDUM_CHANGED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (
    SELECT i.job_id FROM archive_correction_checkpoint_publications p
    JOIN history_retention_items i ON i.visit_id=p.visit_id
    WHERE p.publication_id=NEW.publication_id
  );
END;

-- Extend the schema-32 addendum guard so a ready checkpoint can be the exact
-- preceding addendum parent. The stored parent_kind remains 'addendum' because
-- the encrypted checkpoint is an addendum archive.
DROP TRIGGER archive_correction_addendum_publication_insert_guard;
CREATE TRIGGER archive_correction_addendum_publication_insert_guard
BEFORE INSERT ON archive_correction_addendum_publications
WHEN NOT EXISTS(
  SELECT 1 FROM archive_correction_addendum_builds b
  JOIN history_correction_outbox c ON c.id=b.correction_id
  JOIN history_visit_heads v ON v.visit_id=c.visit_id
  JOIN history_runtime h ON h.id=1 AND h.state='ready'
  WHERE b.publication_id=NEW.publication_id AND b.state='pending'
  AND b.correction_id=NEW.correction_id AND b.generation=NEW.generation
  AND b.archive_id=NEW.archive_id AND h.generation=NEW.generation
  AND c.center_id=NEW.center_id AND c.visit_id=NEW.visit_id
  AND c.expected_version=NEW.expected_version AND c.resulting_version=NEW.resulting_version
  AND c.publication_state='pending'
  AND v.center_id=c.center_id AND v.student_id=c.student_id
  AND v.version=c.resulting_version AND v.check_in_at IS c.check_in_at
  AND v.check_out_at IS c.check_out_at AND v.review_status IS c.review_status
)
OR NOT (
  (NEW.parent_kind='monthly' AND NEW.chain_depth=1 AND EXISTS(
    SELECT 1 FROM archive_publications p
    JOIN archive_publication_availability a ON a.publication_id=p.publication_id
    JOIN archive_publication_records r ON r.publication_id=p.publication_id
    WHERE p.publication_id=NEW.parent_publication_id
    AND p.center_id=NEW.center_id AND p.month=NEW.month AND p.timezone=NEW.timezone
    AND p.root_reference_json=NEW.parent_reference_json
    AND a.status='ready' AND a.generation=NEW.generation
    AND r.table_name='visits' AND r.record_key=NEW.visit_id
  ))
  OR
  (NEW.parent_kind='addendum' AND NEW.chain_depth BETWEEN 2 AND 16 AND (
    EXISTS(
      SELECT 1 FROM archive_correction_addendum_publications p
      JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
      WHERE p.publication_id=NEW.parent_publication_id
      AND p.center_id=NEW.center_id AND p.visit_id=NEW.visit_id
      AND p.month=NEW.month AND p.timezone=NEW.timezone
      AND p.resulting_version=NEW.expected_version
      AND p.chain_depth=NEW.chain_depth-1
      AND p.root_reference_json=NEW.parent_reference_json
      AND a.status='ready' AND a.generation=NEW.generation
    )
    OR EXISTS(
      SELECT 1 FROM archive_correction_checkpoint_publications p
      JOIN archive_correction_checkpoint_availability a ON a.publication_id=p.publication_id
      WHERE p.publication_id=NEW.parent_publication_id
      AND p.center_id=NEW.center_id AND p.visit_id=NEW.visit_id
      AND p.month=NEW.month AND p.timezone=NEW.timezone
      AND p.resulting_version=NEW.expected_version
      AND NEW.chain_depth=2
      AND p.root_reference_json=NEW.parent_reference_json
      AND a.status='ready' AND a.generation=NEW.generation
    )
  ))
)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_PROOF_INVALID'); END;

-- Backup maintenance blocks every checkpoint mutation.
CREATE TRIGGER backup_lock_archive_correction_checkpoint_builds_insert BEFORE INSERT ON archive_correction_checkpoint_builds WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_builds_update BEFORE UPDATE ON archive_correction_checkpoint_builds WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_publications_insert BEFORE INSERT ON archive_correction_checkpoint_publications WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_members_insert BEFORE INSERT ON archive_correction_checkpoint_members WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_availability_insert BEFORE INSERT ON archive_correction_checkpoint_availability WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_availability_update BEFORE UPDATE ON archive_correction_checkpoint_availability WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_reconciliation_jobs_insert BEFORE INSERT ON archive_correction_checkpoint_reconciliation_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_reconciliation_jobs_update BEFORE UPDATE ON archive_correction_checkpoint_reconciliation_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_checkpoint_reconciliation_receipts_insert BEFORE INSERT ON archive_correction_checkpoint_reconciliation_receipts WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(34);
