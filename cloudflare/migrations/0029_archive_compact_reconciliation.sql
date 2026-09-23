-- Fresh proof and bounded two-way reconciliation for restored compact catalogs.

CREATE TABLE archive_compact_reconciliation_jobs (
  reconciliation_id TEXT PRIMARY KEY CHECK(length(reconciliation_id) BETWEEN 1 AND 200),
  publication_id TEXT NOT NULL REFERENCES archive_compact_publications(publication_id),
  execution_generation TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_commit_token TEXT NOT NULL,
  graph_sha256 TEXT NOT NULL CHECK(length(graph_sha256)=64 AND graph_sha256 NOT GLOB '*[^a-f0-9]*'),
  validator_version INTEGER NOT NULL CHECK(validator_version=1),
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND json_type(descriptor_json)='object' AND length(CAST(descriptor_json AS BLOB))<=131072),
  descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
  expected_parts INTEGER NOT NULL CHECK(typeof(expected_parts)='integer' AND expected_parts BETWEEN 0 AND 512),
  state TEXT NOT NULL CHECK(state IN ('pending','running','complete','invalid')),
  phase TEXT NOT NULL CHECK(phase IN ('records','catalog_requests','complete')),
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0),
  lease_token TEXT,
  lease_expires_at TEXT,
  cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json) AND json_type(cursor_json)='object' AND length(CAST(cursor_json AS BLOB))<=2048),
  counters_json TEXT NOT NULL CHECK(json_valid(counters_json) AND json_type(counters_json)='object' AND length(CAST(counters_json AS BLOB))<=4096),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK((lease_token IS NULL AND lease_expires_at IS NULL) OR (state='running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((state='complete' AND phase='complete' AND lease_token IS NULL) OR state!='complete'),
  CHECK((state='invalid' AND lease_token IS NULL) OR state!='invalid')
) WITHOUT ROWID;
CREATE UNIQUE INDEX archive_compact_reconciliation_active_publication
  ON archive_compact_reconciliation_jobs(publication_id,execution_generation) WHERE state!='invalid';
CREATE INDEX archive_compact_reconciliation_job_proof
  ON archive_compact_reconciliation_jobs(verification_id,execution_generation,state);
CREATE INDEX archive_compact_reconciliation_job_run
  ON archive_compact_reconciliation_jobs(run_id,state);

CREATE TABLE archive_compact_reconciliation_receipts (
  reconciliation_id TEXT PRIMARY KEY CHECK(length(reconciliation_id) BETWEEN 1 AND 200),
  publication_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  verification_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  snapshot_commit_token TEXT NOT NULL,
  graph_sha256 TEXT NOT NULL CHECK(length(graph_sha256)=64 AND graph_sha256 NOT GLOB '*[^a-f0-9]*'),
  validator_version INTEGER NOT NULL CHECK(validator_version=1),
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND json_type(descriptor_json)='object' AND length(CAST(descriptor_json AS BLOB))<=131072),
  descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
  expected_parts INTEGER NOT NULL CHECK(typeof(expected_parts)='integer' AND expected_parts BETWEEN 0 AND 512),
  counters_json TEXT NOT NULL CHECK(json_valid(counters_json) AND json_type(counters_json)='object' AND length(CAST(counters_json AS BLOB))<=4096),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64 AND evidence_digest NOT GLOB '*[^a-f0-9]*'),
  completed_at TEXT NOT NULL,
  FOREIGN KEY(reconciliation_id) REFERENCES archive_compact_reconciliation_jobs(reconciliation_id),
  FOREIGN KEY(publication_id) REFERENCES archive_compact_publications(publication_id),
  UNIQUE(publication_id,execution_generation)
) WITHOUT ROWID;

ALTER TABLE archive_compact_availability ADD COLUMN reconciliation_id TEXT REFERENCES archive_compact_reconciliation_receipts(reconciliation_id);

CREATE TRIGGER archive_compact_reconciliation_job_insert_guard
BEFORE INSERT ON archive_compact_reconciliation_jobs
WHEN EXISTS(SELECT 1 FROM archive_compact_reconciliation_jobs WHERE reconciliation_id=NEW.reconciliation_id)
 OR EXISTS(SELECT 1 FROM archive_compact_reconciliation_jobs WHERE publication_id=NEW.publication_id AND execution_generation=NEW.execution_generation AND state!='invalid')
 OR NEW.state!='pending' OR NEW.phase!='records' OR NEW.revision!=0 OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.cursor_json!='{"version":1,"nextPart":0,"nextOffset":0,"requestAfter":""}'
 OR NEW.counters_json!='{"parts":0,"records":0,"requests":0,"catalogRequests":0,"counts":{"centers":0,"students":0,"guardians":0,"student_guardians":0,"staff":0,"visits":0,"attendance_events":0,"attendance_corrections":0,"reviews":0,"audit_entries":0}}'
 OR NEW.evidence_digest!='0000000000000000000000000000000000000000000000000000000000000000'
 OR NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.updated_at IS NOT NEW.created_at
 OR NEW.descriptor_json IS NOT (SELECT json_object(
      'publication_id',p.publication_id,'verification_id',p.verification_id,'generation',p.generation,'run_id',p.run_id,
      'snapshot_commit_token',p.snapshot_commit_token,'graph_sha256',p.graph_sha256,'validator_version',p.validator_version,
      'archive_id',p.archive_id,'center_id',p.center_id,'month',p.month,'timezone',p.timezone,
      'root_reference_json',p.root_reference_json,'header_json',p.header_json,'header_sha256',p.header_sha256,
      'part_count',p.part_count,'record_count',p.record_count,'catalog_version',p.catalog_version,
      'request_count',p.request_count,'counts_json',p.counts_json,'published_at',p.published_at)
    FROM archive_compact_publications p WHERE p.publication_id=NEW.publication_id)
 OR NOT EXISTS(SELECT 1 FROM archive_compact_publications cp
    JOIN archive_semantic_runs rr ON rr.run_id=NEW.run_id
    JOIN archive_semantic_sessions rs ON rs.verification_id=rr.verification_id AND rs.generation=rr.generation
    JOIN archive_semantic_manifests rm ON rm.verification_id=rs.verification_id AND rm.generation=rs.generation AND rm.archive_id=rr.archive_id
    JOIN archive_semantic_lifecycle rl ON rl.verification_id=rs.verification_id AND rl.generation=rs.generation
    JOIN history_runtime rh ON rh.id=1 AND rh.generation=rs.generation
    WHERE cp.publication_id=NEW.publication_id
      AND rr.verification_id=NEW.verification_id AND rr.generation=NEW.execution_generation
      AND rr.snapshot_commit_token=NEW.snapshot_commit_token AND rr.graph_sha256=NEW.graph_sha256
      AND rr.validator_version=NEW.validator_version AND rr.validator_version=1
      AND rr.status='complete' AND rr.phase='complete' AND rr.archive_id=cp.archive_id AND rr.header_json=cp.header_json
      AND rs.status='verified' AND rs.commit_token=NEW.snapshot_commit_token AND rs.graph_sha256=NEW.graph_sha256
      AND rs.root_archive_id=cp.archive_id AND rs.root_reference_json=cp.root_reference_json
      AND rm.manifest_sha256=rs.root_manifest_sha256 AND rm.manifest_sha256=json_extract(cp.root_reference_json,'$.manifestSha256')
      AND rm.part_count=NEW.expected_parts AND rm.part_count=cp.part_count AND rm.record_count=cp.record_count
      AND json_remove(rm.manifest_json,'$.parts')=cp.header_json
      AND rh.state='ready' AND rl.pause_reason IS NULL AND rl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPACT_RECONCILIATION_JOB_INVALID'); END;

CREATE TRIGGER archive_compact_reconciliation_job_update_guard
BEFORE UPDATE ON archive_compact_reconciliation_jobs
WHEN NOT (NEW.reconciliation_id IS OLD.reconciliation_id AND NEW.publication_id IS OLD.publication_id
      AND NEW.execution_generation IS OLD.execution_generation AND NEW.verification_id IS OLD.verification_id
      AND NEW.run_id IS OLD.run_id AND NEW.snapshot_commit_token IS OLD.snapshot_commit_token
      AND NEW.graph_sha256 IS OLD.graph_sha256 AND NEW.validator_version IS OLD.validator_version
      AND NEW.descriptor_json IS OLD.descriptor_json AND NEW.descriptor_sha256 IS OLD.descriptor_sha256
      AND NEW.expected_parts IS OLD.expected_parts AND NEW.created_at IS OLD.created_at)
 OR NEW.revision!=OLD.revision+1 OR NEW.updated_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT COALESCE(CASE
   WHEN NEW.state='running' THEN
     OLD.state IN ('pending','running') AND NEW.phase IS OLD.phase
     AND NEW.cursor_json IS OLD.cursor_json AND NEW.counters_json IS OLD.counters_json AND NEW.evidence_digest IS OLD.evidence_digest
     AND NEW.lease_token IS NOT NULL AND NEW.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND EXISTS(SELECT 1 FROM archive_compact_publications cp
       JOIN archive_semantic_runs rr ON rr.run_id=OLD.run_id
       JOIN archive_semantic_sessions rs ON rs.verification_id=rr.verification_id AND rs.generation=rr.generation
       JOIN archive_semantic_manifests rm ON rm.verification_id=rs.verification_id AND rm.generation=rs.generation AND rm.archive_id=rr.archive_id
       JOIN archive_semantic_lifecycle rl ON rl.verification_id=rs.verification_id AND rl.generation=rs.generation
       JOIN history_runtime rh ON rh.id=1 AND rh.generation=rs.generation
       WHERE cp.publication_id=OLD.publication_id AND rr.verification_id=OLD.verification_id AND rr.generation=OLD.execution_generation
         AND rr.snapshot_commit_token=OLD.snapshot_commit_token AND rr.graph_sha256=OLD.graph_sha256 AND rr.validator_version=1
         AND rr.status='complete' AND rr.phase='complete' AND rr.archive_id=cp.archive_id AND rr.header_json=cp.header_json
         AND rs.status='verified' AND rs.commit_token=OLD.snapshot_commit_token AND rs.graph_sha256=OLD.graph_sha256
         AND rs.root_archive_id=cp.archive_id AND rs.root_reference_json=cp.root_reference_json
         AND rm.manifest_sha256=rs.root_manifest_sha256 AND rm.manifest_sha256=json_extract(cp.root_reference_json,'$.manifestSha256')
         AND rm.part_count=OLD.expected_parts AND rm.part_count=cp.part_count AND rm.record_count=cp.record_count
         AND json_remove(rm.manifest_json,'$.parts')=cp.header_json
         AND rh.state='ready' AND rl.pause_reason IS NULL AND rl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   WHEN NEW.state IN ('pending','complete') THEN
     OLD.state='running' AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
     AND OLD.lease_token IS NOT NULL AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND ((NEW.phase IS OLD.phase AND NEW.cursor_json IS OLD.cursor_json AND NEW.counters_json IS OLD.counters_json AND NEW.evidence_digest IS OLD.evidence_digest)
       OR (OLD.phase='records' AND NEW.phase='records'
         AND json_extract(NEW.counters_json,'$.records') BETWEEN json_extract(OLD.counters_json,'$.records')+1 AND json_extract(OLD.counters_json,'$.records')+8
         AND json_extract(NEW.counters_json,'$.requests') BETWEEN json_extract(OLD.counters_json,'$.requests') AND json_extract(OLD.counters_json,'$.requests')+8
         AND NEW.evidence_digest IS NOT OLD.evidence_digest)
       OR (OLD.phase='records' AND NEW.phase='catalog_requests' AND NEW.cursor_json IS OLD.cursor_json
         AND NEW.counters_json IS OLD.counters_json AND NEW.evidence_digest IS OLD.evidence_digest)
       OR (OLD.phase='catalog_requests' AND NEW.phase='catalog_requests'
         AND json_extract(NEW.counters_json,'$.catalogRequests') BETWEEN json_extract(OLD.counters_json,'$.catalogRequests')+1 AND json_extract(OLD.counters_json,'$.catalogRequests')+8
         AND json_extract(NEW.cursor_json,'$.requestAfter')>json_extract(OLD.cursor_json,'$.requestAfter')
         AND NEW.evidence_digest IS NOT OLD.evidence_digest)
       OR (OLD.phase='catalog_requests' AND NEW.phase='complete' AND NEW.cursor_json IS OLD.cursor_json
         AND NEW.counters_json IS OLD.counters_json AND NEW.evidence_digest IS OLD.evidence_digest))
     AND (NEW.state!='complete' OR NEW.phase='complete')
   WHEN NEW.state='invalid' THEN OLD.state IN ('pending','running') AND NEW.phase IS OLD.phase
     AND NEW.cursor_json IS OLD.cursor_json AND NEW.counters_json IS OLD.counters_json AND NEW.evidence_digest IS OLD.evidence_digest
     AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
   ELSE 0 END,0)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPACT_RECONCILIATION_JOB_INVALID'); END;

CREATE TRIGGER archive_compact_reconciliation_receipt_insert_guard
BEFORE INSERT ON archive_compact_reconciliation_receipts
WHEN EXISTS(SELECT 1 FROM archive_compact_reconciliation_receipts WHERE reconciliation_id=NEW.reconciliation_id OR (publication_id=NEW.publication_id AND execution_generation=NEW.execution_generation))
 OR NEW.completed_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM archive_compact_reconciliation_jobs j
      JOIN archive_compact_publications p ON p.publication_id=j.publication_id
      JOIN history_runtime h ON h.id=1 AND h.generation=j.execution_generation AND h.state='ready'
    WHERE j.reconciliation_id=NEW.reconciliation_id AND j.state='complete' AND j.phase='complete'
      AND NEW.publication_id IS j.publication_id AND NEW.execution_generation IS j.execution_generation
      AND NEW.verification_id IS j.verification_id AND NEW.run_id IS j.run_id
      AND NEW.snapshot_commit_token IS j.snapshot_commit_token AND NEW.graph_sha256 IS j.graph_sha256
      AND NEW.validator_version IS j.validator_version AND NEW.descriptor_json IS j.descriptor_json
      AND NEW.descriptor_sha256 IS j.descriptor_sha256 AND NEW.expected_parts IS j.expected_parts
      AND NEW.counters_json IS j.counters_json AND NEW.evidence_digest IS j.evidence_digest
      AND NEW.descriptor_json IS json_object(
        'publication_id',p.publication_id,'verification_id',p.verification_id,'generation',p.generation,'run_id',p.run_id,
        'snapshot_commit_token',p.snapshot_commit_token,'graph_sha256',p.graph_sha256,'validator_version',p.validator_version,
        'archive_id',p.archive_id,'center_id',p.center_id,'month',p.month,'timezone',p.timezone,
        'root_reference_json',p.root_reference_json,'header_json',p.header_json,'header_sha256',p.header_sha256,
        'part_count',p.part_count,'record_count',p.record_count,'catalog_version',p.catalog_version,
        'request_count',p.request_count,'counts_json',p.counts_json,'published_at',p.published_at)
      AND json_extract(NEW.counters_json,'$.parts')=p.part_count
      AND json_extract(NEW.counters_json,'$.records')=p.record_count
      AND json_extract(NEW.counters_json,'$.requests')=p.request_count
      AND json_extract(NEW.counters_json,'$.catalogRequests')=p.request_count
      AND json_remove(NEW.counters_json,'$.parts','$.records','$.requests','$.catalogRequests','$.counts')='{}'
      AND json_remove(json_extract(NEW.counters_json,'$.counts'),'$.centers','$.students','$.guardians','$.student_guardians','$.staff','$.visits','$.attendance_events','$.attendance_corrections','$.reviews','$.audit_entries')='{}'
      AND json_extract(NEW.counters_json,'$.counts')=json(p.counts_json)
      AND EXISTS(SELECT 1 FROM archive_semantic_runs rr
        JOIN archive_semantic_sessions rs ON rs.verification_id=rr.verification_id AND rs.generation=rr.generation
        JOIN archive_semantic_manifests rm ON rm.verification_id=rs.verification_id AND rm.generation=rs.generation AND rm.archive_id=rr.archive_id
        JOIN archive_semantic_lifecycle rl ON rl.verification_id=rs.verification_id AND rl.generation=rs.generation
        WHERE rr.run_id=j.run_id AND rr.verification_id=j.verification_id AND rr.generation=j.execution_generation
          AND rr.snapshot_commit_token=j.snapshot_commit_token AND rr.graph_sha256=j.graph_sha256
          AND rr.validator_version=1 AND rr.status='complete' AND rr.phase='complete'
          AND rr.archive_id=p.archive_id AND rr.header_json=p.header_json
          AND rs.status='verified' AND rs.commit_token=j.snapshot_commit_token AND rs.graph_sha256=j.graph_sha256
          AND rs.root_archive_id=p.archive_id AND rs.root_reference_json=p.root_reference_json
          AND rm.manifest_sha256=rs.root_manifest_sha256 AND rm.manifest_sha256=json_extract(p.root_reference_json,'$.manifestSha256')
          AND rm.part_count=j.expected_parts AND rm.part_count=p.part_count AND rm.record_count=p.record_count
          AND json_remove(rm.manifest_json,'$.parts')=p.header_json
          AND rl.pause_reason IS NULL AND rl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPACT_RECONCILIATION_RECEIPT_INVALID'); END;

DROP TRIGGER archive_compact_availability_insert;
DROP TRIGGER archive_compact_availability_update;
DROP TRIGGER archive_compact_generation_reset;

CREATE TRIGGER archive_compact_availability_insert
BEFORE INSERT ON archive_compact_availability
WHEN EXISTS(SELECT 1 FROM archive_compact_availability WHERE publication_id=NEW.publication_id)
 OR NEW.status!='ready'
 OR NOT ((NEW.reconciliation_id IS NULL AND EXISTS(SELECT 1 FROM archive_compact_publications p
      JOIN archive_compact_builds b ON b.publication_id=p.publication_id AND b.state='published'
      JOIN history_runtime h ON h.id=1 AND h.generation=p.generation AND h.state='ready'
      WHERE p.publication_id=NEW.publication_id AND NEW.generation=p.generation
        AND p.verification_id=b.verification_id AND p.generation=b.generation AND p.run_id=b.run_id
        AND p.snapshot_commit_token=b.snapshot_commit_token AND p.graph_sha256=b.graph_sha256
        AND p.archive_id=b.archive_id AND p.header_json=b.header_json AND p.root_reference_json=b.root_reference_json))
   OR (NEW.reconciliation_id IS NOT NULL AND EXISTS(SELECT 1 FROM archive_compact_reconciliation_receipts r
      JOIN history_runtime h ON h.id=1 AND h.generation=r.execution_generation AND h.state='ready'
      WHERE r.reconciliation_id=NEW.reconciliation_id AND r.publication_id=NEW.publication_id
        AND r.execution_generation=NEW.generation)))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPACT_AVAILABILITY_INVALID'); END;

CREATE TRIGGER archive_compact_availability_update
BEFORE UPDATE ON archive_compact_availability
WHEN NEW.publication_id IS NOT OLD.publication_id
 OR NOT ((NEW.status='unavailable' AND ((NEW.generation IS OLD.generation AND NEW.reconciliation_id IS OLD.reconciliation_id)
       OR (NEW.generation IS NOT OLD.generation AND NEW.reconciliation_id IS NULL
         AND EXISTS(SELECT 1 FROM history_runtime h WHERE h.id=1 AND h.generation=NEW.generation))))
   OR (NEW.status='ready' AND NEW.reconciliation_id IS NOT NULL AND EXISTS(SELECT 1 FROM archive_compact_reconciliation_receipts r
      JOIN history_runtime h ON h.id=1 AND h.generation=r.execution_generation AND h.state='ready'
      WHERE r.reconciliation_id=NEW.reconciliation_id AND r.publication_id=NEW.publication_id
        AND r.execution_generation=NEW.generation)))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_COMPACT_AVAILABILITY_INVALID'); END;

CREATE TRIGGER archive_compact_generation_reset
AFTER UPDATE OF generation ON history_runtime WHEN NEW.generation!=OLD.generation
BEGIN
  UPDATE archive_compact_builds SET state='invalid',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state='building';
  UPDATE archive_compact_reconciliation_jobs SET state='invalid',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state IN ('pending','running');
  UPDATE archive_compact_availability SET generation=NEW.generation,status='unavailable',reconciliation_id=NULL;
END;

CREATE TRIGGER archive_compact_reconciliation_session_invalidated
AFTER UPDATE OF status ON archive_semantic_sessions WHEN NEW.status='invalid'
BEGIN
  UPDATE archive_compact_reconciliation_jobs SET state='invalid',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE verification_id=NEW.verification_id AND execution_generation=NEW.generation AND state IN ('pending','running');
END;
CREATE TRIGGER archive_compact_reconciliation_run_invalidated
AFTER UPDATE OF status ON archive_semantic_runs WHEN NEW.status='invalid'
BEGIN
  UPDATE archive_compact_reconciliation_jobs SET state='invalid',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE run_id=NEW.run_id AND state IN ('pending','running');
END;

CREATE TRIGGER archive_compact_reconciliation_jobs_no_delete BEFORE DELETE ON archive_compact_reconciliation_jobs
WHEN 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_COMPACT_RECONCILIATION'); END;
CREATE TRIGGER archive_compact_reconciliation_receipts_no_update BEFORE UPDATE ON archive_compact_reconciliation_receipts
WHEN 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_COMPACT_RECONCILIATION'); END;
CREATE TRIGGER archive_compact_reconciliation_receipts_no_delete BEFORE DELETE ON archive_compact_reconciliation_receipts
WHEN 1 BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_COMPACT_RECONCILIATION'); END;

CREATE TRIGGER backup_lock_archive_compact_reconciliation_jobs_insert BEFORE INSERT ON archive_compact_reconciliation_jobs
WHEN NOT (NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_compact_reconciliation_jobs_update BEFORE UPDATE ON archive_compact_reconciliation_jobs
WHEN NOT (NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_compact_reconciliation_jobs_delete BEFORE DELETE ON archive_compact_reconciliation_jobs
WHEN NOT (NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_compact_reconciliation_receipts_insert BEFORE INSERT ON archive_compact_reconciliation_receipts
WHEN NOT (NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_compact_reconciliation_receipts_update BEFORE UPDATE ON archive_compact_reconciliation_receipts
WHEN NOT (NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_compact_reconciliation_receipts_delete BEFORE DELETE ON archive_compact_reconciliation_receipts
WHEN NOT (NOT EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(29);
