CREATE TABLE archive_correction_addendum_builds (
  publication_id TEXT PRIMARY KEY,
  correction_id TEXT NOT NULL REFERENCES history_correction_outbox(id),
  generation TEXT NOT NULL,
  archive_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('pending','published','invalid')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(created_at=updated_at OR state!='pending')
) WITHOUT ROWID;

CREATE UNIQUE INDEX archive_correction_addendum_active_build
  ON archive_correction_addendum_builds(correction_id)
  WHERE state IN ('pending','published');

CREATE TABLE archive_correction_addendum_publications (
  publication_id TEXT PRIMARY KEY REFERENCES archive_correction_addendum_builds(publication_id),
  correction_id TEXT NOT NULL UNIQUE REFERENCES history_correction_outbox(id),
  generation TEXT NOT NULL,
  archive_id TEXT NOT NULL UNIQUE,
  center_id TEXT NOT NULL,
  visit_id TEXT NOT NULL,
  month TEXT NOT NULL CHECK(month GLOB '20[0-9][0-9]-[01][0-9]'),
  timezone TEXT NOT NULL CHECK(length(timezone) BETWEEN 1 AND 100),
  expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version>=1),
  resulting_version INTEGER NOT NULL CHECK(resulting_version=expected_version+1),
  parent_kind TEXT NOT NULL CHECK(parent_kind IN ('monthly','addendum')),
  parent_publication_id TEXT NOT NULL,
  parent_reference_json TEXT NOT NULL CHECK(json_valid(parent_reference_json) AND length(CAST(parent_reference_json AS BLOB))<=2048),
  chain_depth INTEGER NOT NULL CHECK(typeof(chain_depth)='integer' AND chain_depth BETWEEN 1 AND 16),
  root_reference_json TEXT NOT NULL CHECK(json_valid(root_reference_json) AND length(CAST(root_reference_json AS BLOB))<=2048),
  header_json TEXT NOT NULL CHECK(json_valid(header_json) AND length(CAST(header_json AS BLOB))<=49152),
  header_sha256 TEXT NOT NULL CHECK(length(header_sha256)=64 AND header_sha256 NOT GLOB '*[^a-f0-9]*'),
  manifest_object_key TEXT NOT NULL CHECK(length(manifest_object_key) BETWEEN 1 AND 1024),
  manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
  part_descriptor_json TEXT NOT NULL CHECK(json_valid(part_descriptor_json) AND length(CAST(part_descriptor_json AS BLOB))<=8192),
  part_descriptor_sha256 TEXT NOT NULL CHECK(length(part_descriptor_sha256)=64 AND part_descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
  records_sha256 TEXT NOT NULL CHECK(length(records_sha256)=64 AND records_sha256 NOT GLOB '*[^a-f0-9]*'),
  published_at TEXT NOT NULL,
  CHECK(json_extract(parent_reference_json,'$.kind') IS parent_kind),
  CHECK(json_type(parent_reference_json,'$.archiveId')='text' AND length(json_extract(parent_reference_json,'$.archiveId')) BETWEEN 1 AND 100),
  CHECK(json_type(parent_reference_json,'$.manifestObjectKey')='text' AND length(json_extract(parent_reference_json,'$.manifestObjectKey')) BETWEEN 1 AND 1024),
  CHECK(length(json_extract(parent_reference_json,'$.manifestSha256'))=64 AND json_extract(parent_reference_json,'$.manifestSha256') NOT GLOB '*[^a-f0-9]*'),
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
  CHECK(json_extract(header_json,'$.references[0].archiveId') IS json_extract(parent_reference_json,'$.archiveId')),
  CHECK(json_extract(header_json,'$.references[0].kind') IS parent_kind),
  CHECK(json_extract(header_json,'$.references[0].manifestObjectKey') IS json_extract(parent_reference_json,'$.manifestObjectKey')),
  CHECK(json_extract(header_json,'$.references[0].manifestSha256') IS json_extract(parent_reference_json,'$.manifestSha256')),
  CHECK(json_extract(header_json,'$.recordCount')=3),
  CHECK(json_extract(header_json,'$.recordCounts.visits')=1),
  CHECK(json_extract(header_json,'$.recordCounts.attendance_corrections')=1),
  CHECK(json_extract(header_json,'$.recordCounts.audit_entries')=1),
  CHECK(json_extract(header_json,'$.recordCounts.centers')=0 AND json_extract(header_json,'$.recordCounts.students')=0),
  CHECK(json_extract(header_json,'$.recordCounts.guardians')=0 AND json_extract(header_json,'$.recordCounts.student_guardians')=0),
  CHECK(json_extract(header_json,'$.recordCounts.staff')=0 AND json_extract(header_json,'$.recordCounts.attendance_events')=0),
  CHECK(json_extract(header_json,'$.recordCounts.reviews')=0),
  CHECK(json_extract(header_json,'$.parts[0].index')=0),
  CHECK(json_extract(header_json,'$.parts') IS NULL),
  CHECK(json_extract(part_descriptor_json,'$.index')=0)
) WITHOUT ROWID;

CREATE INDEX archive_correction_addenda_visit_version
  ON archive_correction_addendum_publications(center_id,visit_id,resulting_version DESC,publication_id);
CREATE INDEX archive_correction_addenda_parent
  ON archive_correction_addendum_publications(parent_kind,parent_publication_id);

CREATE TABLE archive_correction_addendum_availability (
  publication_id TEXT PRIMARY KEY REFERENCES archive_correction_addendum_publications(publication_id),
  generation TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','unavailable')),
  reconciliation_id TEXT,
  CHECK((status='ready') OR reconciliation_id IS NULL)
) WITHOUT ROWID;

CREATE TABLE archive_correction_addendum_reconciliation_jobs (
  reconciliation_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES archive_correction_addendum_publications(publication_id),
  execution_generation TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=16384),
  descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK(state IN ('pending','complete','invalid')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX archive_correction_addendum_reconciliation_publication
  ON archive_correction_addendum_reconciliation_jobs(publication_id,execution_generation,state);

CREATE TABLE archive_correction_addendum_reconciliation_receipts (
  reconciliation_id TEXT PRIMARY KEY REFERENCES archive_correction_addendum_reconciliation_jobs(reconciliation_id),
  publication_id TEXT NOT NULL REFERENCES archive_correction_addendum_publications(publication_id),
  execution_generation TEXT NOT NULL,
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=16384),
  descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
  evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64 AND evidence_sha256 NOT GLOB '*[^a-f0-9]*'),
  completed_at TEXT NOT NULL,
  UNIQUE(publication_id,execution_generation)
) WITHOUT ROWID;

CREATE VIEW archive_correction_addendum_descriptors AS
SELECT publication_id,
  json_object(
    'publication_id',publication_id,
    'correction_id',correction_id,
    'generation',generation,
    'archive_id',archive_id,
    'center_id',center_id,
    'visit_id',visit_id,
    'month',month,
    'timezone',timezone,
    'expected_version',expected_version,
    'resulting_version',resulting_version,
    'parent_kind',parent_kind,
    'parent_publication_id',parent_publication_id,
    'parent_reference_json',parent_reference_json,
    'chain_depth',chain_depth,
    'root_reference_json',root_reference_json,
    'header_json',header_json,
    'header_sha256',header_sha256,
    'manifest_object_key',manifest_object_key,
    'manifest_sha256',manifest_sha256,
    'part_descriptor_json',part_descriptor_json,
    'part_descriptor_sha256',part_descriptor_sha256,
    'records_sha256',records_sha256,
    'published_at',published_at
  ) AS descriptor_json
FROM archive_correction_addendum_publications;

CREATE TRIGGER archive_correction_addendum_build_insert_guard
BEFORE INSERT ON archive_correction_addendum_builds
WHEN NEW.state!='pending' OR NEW.revision!=0 OR NEW.created_at!=NEW.updated_at
  OR NOT EXISTS(
    SELECT 1 FROM history_correction_outbox c
    JOIN history_runtime h ON h.id=1 AND h.state='ready'
    WHERE c.id=NEW.correction_id AND c.publication_state='pending'
      AND h.generation=NEW.generation
  )
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_BUILD_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_build_update_guard
BEFORE UPDATE ON archive_correction_addendum_builds
WHEN NEW.publication_id IS NOT OLD.publication_id
  OR NEW.correction_id IS NOT OLD.correction_id
  OR NEW.generation IS NOT OLD.generation
  OR NEW.archive_id IS NOT OLD.archive_id
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision!=OLD.revision+1
  OR NEW.updated_at<=OLD.updated_at
  OR NOT ((OLD.state='pending' AND NEW.state IN ('published','invalid')) OR (OLD.state=NEW.state AND OLD.state IN ('published','invalid')))
  OR (NEW.state='published' AND NOT EXISTS(
    SELECT 1 FROM archive_correction_addendum_publications p
    WHERE p.publication_id=NEW.publication_id AND p.correction_id=NEW.correction_id
      AND p.generation=NEW.generation AND p.archive_id=NEW.archive_id
  ))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_BUILD_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_build_no_delete
BEFORE DELETE ON archive_correction_addendum_builds
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_ADDENDUM'); END;

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
    (NEW.parent_kind='addendum' AND NEW.chain_depth BETWEEN 2 AND 16 AND EXISTS(
      SELECT 1 FROM archive_correction_addendum_publications p
      JOIN archive_correction_addendum_availability a ON a.publication_id=p.publication_id
      WHERE p.publication_id=NEW.parent_publication_id
        AND p.center_id=NEW.center_id AND p.visit_id=NEW.visit_id
        AND p.month=NEW.month AND p.timezone=NEW.timezone
        AND p.resulting_version=NEW.expected_version
        AND p.chain_depth=NEW.chain_depth-1
        AND p.root_reference_json=NEW.parent_reference_json
        AND a.status='ready' AND a.generation=NEW.generation
    ))
  )
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_PROOF_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_publication_no_update
BEFORE UPDATE ON archive_correction_addendum_publications
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_ADDENDUM'); END;
CREATE TRIGGER archive_correction_addendum_publication_no_delete
BEFORE DELETE ON archive_correction_addendum_publications
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_ADDENDUM'); END;

CREATE TRIGGER archive_correction_addendum_availability_insert_guard
BEFORE INSERT ON archive_correction_addendum_availability
WHEN NEW.status!='ready' OR NEW.reconciliation_id IS NOT NULL
  OR NOT EXISTS(
    SELECT 1 FROM archive_correction_addendum_publications p
    JOIN history_runtime h ON h.id=1 AND h.state='ready'
    WHERE p.publication_id=NEW.publication_id
      AND p.generation=NEW.generation AND h.generation=NEW.generation
  )
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_AVAILABILITY_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_availability_update_guard
BEFORE UPDATE ON archive_correction_addendum_availability
WHEN NEW.publication_id IS NOT OLD.publication_id
  OR NOT (
    (NEW.status='unavailable' AND NEW.reconciliation_id IS NULL
      AND EXISTS(SELECT 1 FROM history_runtime h WHERE h.id=1 AND h.generation=NEW.generation))
    OR
    (NEW.status='ready' AND NEW.reconciliation_id IS NOT NULL AND EXISTS(
      SELECT 1 FROM archive_correction_addendum_reconciliation_receipts r
      JOIN archive_correction_addendum_publications p ON p.publication_id=r.publication_id
      JOIN history_runtime h ON h.id=1 AND h.state='ready' AND h.generation=r.execution_generation
      WHERE r.reconciliation_id=NEW.reconciliation_id
        AND r.publication_id=NEW.publication_id
        AND r.execution_generation=NEW.generation
        AND r.descriptor_json=(
          SELECT descriptor_json FROM archive_correction_addendum_reconciliation_jobs j
          WHERE j.reconciliation_id=r.reconciliation_id AND j.state='complete'
        )
        AND r.descriptor_sha256=(
          SELECT descriptor_sha256 FROM archive_correction_addendum_reconciliation_jobs j
          WHERE j.reconciliation_id=r.reconciliation_id AND j.state='complete'
        )
    ))
  )
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_AVAILABILITY_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_availability_no_delete
BEFORE DELETE ON archive_correction_addendum_availability
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_ADDENDUM'); END;

CREATE TRIGGER archive_correction_addendum_reconciliation_insert_guard
BEFORE INSERT ON archive_correction_addendum_reconciliation_jobs
WHEN NEW.state!='pending' OR NEW.revision!=0 OR NEW.created_at!=NEW.updated_at
  OR NOT EXISTS(
    SELECT 1 FROM archive_correction_addendum_publications p
    JOIN history_runtime h ON h.id=1 AND h.state='ready'
    WHERE p.publication_id=NEW.publication_id AND h.generation=NEW.execution_generation
  )
  OR NOT EXISTS(
    SELECT 1 FROM archive_correction_addendum_descriptors d
    WHERE d.publication_id=NEW.publication_id AND d.descriptor_json=NEW.descriptor_json
  )
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_RECONCILIATION_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_reconciliation_update_guard
BEFORE UPDATE ON archive_correction_addendum_reconciliation_jobs
WHEN NEW.reconciliation_id IS NOT OLD.reconciliation_id
  OR NEW.publication_id IS NOT OLD.publication_id
  OR NEW.execution_generation IS NOT OLD.execution_generation
  OR NEW.descriptor_json IS NOT OLD.descriptor_json
  OR NEW.descriptor_sha256 IS NOT OLD.descriptor_sha256
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.revision!=OLD.revision+1 OR NEW.updated_at<=OLD.updated_at
  OR NOT (OLD.state='pending' AND NEW.state IN ('complete','invalid'))
  OR (NEW.state='complete' AND NOT EXISTS(
    SELECT 1 FROM archive_correction_addendum_reconciliation_receipts r
    WHERE r.reconciliation_id=NEW.reconciliation_id
      AND r.publication_id=NEW.publication_id
      AND r.execution_generation=NEW.execution_generation
      AND r.descriptor_json=NEW.descriptor_json
      AND r.descriptor_sha256=NEW.descriptor_sha256
  ))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_RECONCILIATION_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_reconciliation_no_delete
BEFORE DELETE ON archive_correction_addendum_reconciliation_jobs
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_ADDENDUM_RECONCILIATION'); END;

CREATE TRIGGER archive_correction_addendum_receipt_insert_guard
BEFORE INSERT ON archive_correction_addendum_reconciliation_receipts
WHEN NOT EXISTS(
    SELECT 1 FROM archive_correction_addendum_reconciliation_jobs j
    JOIN archive_correction_addendum_publications p ON p.publication_id=j.publication_id
    JOIN history_runtime h ON h.id=1 AND h.state='ready'
    WHERE j.reconciliation_id=NEW.reconciliation_id AND j.state='pending'
      AND j.publication_id=NEW.publication_id
      AND j.execution_generation=NEW.execution_generation
      AND j.descriptor_json=NEW.descriptor_json
      AND j.descriptor_sha256=NEW.descriptor_sha256
      AND h.generation=NEW.execution_generation
  )
BEGIN SELECT RAISE(ABORT,'ARCHIVE_ADDENDUM_RECEIPT_INVALID'); END;

CREATE TRIGGER archive_correction_addendum_receipt_no_update
BEFORE UPDATE ON archive_correction_addendum_reconciliation_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_ADDENDUM_RECONCILIATION'); END;
CREATE TRIGGER archive_correction_addendum_receipt_no_delete
BEFORE DELETE ON archive_correction_addendum_reconciliation_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_ADDENDUM_RECONCILIATION'); END;

CREATE TRIGGER history_runtime_invalidate_correction_addenda
AFTER UPDATE OF generation ON history_runtime
WHEN NEW.generation!=OLD.generation
BEGIN
  UPDATE archive_correction_addendum_availability
  SET generation=NEW.generation,status='unavailable',reconciliation_id=NULL;
  UPDATE archive_correction_addendum_reconciliation_jobs
  SET state='invalid',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE state='pending';
  UPDATE archive_correction_addendum_builds
  SET state='invalid',revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE state='pending';
END;

CREATE TRIGGER backup_lock_archive_correction_addendum_builds_insert
BEFORE INSERT ON archive_correction_addendum_builds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_addendum_builds_update
BEFORE UPDATE ON archive_correction_addendum_builds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_addendum_publications_insert
BEFORE INSERT ON archive_correction_addendum_publications
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_addendum_availability_insert
BEFORE INSERT ON archive_correction_addendum_availability
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_addendum_availability_update
BEFORE UPDATE ON archive_correction_addendum_availability
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_addendum_reconciliation_insert
BEFORE INSERT ON archive_correction_addendum_reconciliation_jobs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_addendum_reconciliation_update
BEFORE UPDATE ON archive_correction_addendum_reconciliation_jobs
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_correction_addendum_receipts_insert
BEFORE INSERT ON archive_correction_addendum_reconciliation_receipts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(32);
