-- Internal immutable monthly publication foundation. No source deletion, route,
-- scheduler, legacy-location activation, or availability reconciliation authority.
CREATE TABLE archive_publication_builds (
 publication_id TEXT PRIMARY KEY,
 verification_id TEXT NOT NULL, generation TEXT NOT NULL, run_id TEXT NOT NULL,
 snapshot_commit_token TEXT NOT NULL, graph_sha256 TEXT NOT NULL CHECK(length(graph_sha256)=64 AND graph_sha256 NOT GLOB '*[^a-f0-9]*'),
 validator_version INTEGER NOT NULL CHECK(validator_version=1),
 archive_id TEXT NOT NULL, center_id TEXT NOT NULL, month TEXT NOT NULL, timezone TEXT NOT NULL,
 root_reference_json TEXT NOT NULL CHECK(json_valid(root_reference_json) AND json_type(root_reference_json)='object' AND length(CAST(root_reference_json AS BLOB))<=2048),
 header_json TEXT NOT NULL CHECK(json_valid(header_json) AND json_type(header_json)='object' AND length(CAST(header_json AS BLOB))<=49152),
 header_sha256 TEXT NOT NULL CHECK(length(header_sha256)=64 AND header_sha256 NOT GLOB '*[^a-f0-9]*'),
 part_count INTEGER NOT NULL CHECK(typeof(part_count)='integer' AND part_count BETWEEN 0 AND 512),
 record_count INTEGER NOT NULL CHECK(typeof(record_count)='integer' AND record_count BETWEEN 0 AND 20000),
 state TEXT NOT NULL CHECK(state IN ('building','published','invalid')),
 revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
 lease_token TEXT, lease_expires_at TEXT,
 next_part INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_part)='integer' AND next_part BETWEEN 0 AND part_count),
 next_offset INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_offset)='integer' AND next_offset BETWEEN 0 AND 255),
 indexed_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(indexed_count)='integer' AND indexed_count BETWEEN 0 AND record_count),
 request_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(request_count)='integer' AND request_count BETWEEN 0 AND indexed_count),
 counts_json TEXT NOT NULL DEFAULT '{"centers":0,"students":0,"guardians":0,"student_guardians":0,"staff":0,"visits":0,"attendance_events":0,"attendance_corrections":0,"reviews":0,"audit_entries":0}' CHECK(json_valid(counts_json) AND json_type(counts_json)='object' AND length(CAST(counts_json AS BLOB))<=2048),
 locator_digest TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000' CHECK(length(locator_digest)=64 AND locator_digest NOT GLOB '*[^a-f0-9]*'),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 CHECK((lease_token IS NULL AND lease_expires_at IS NULL) OR (state='building' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
 CHECK(json_extract(header_json,'$.format') IS 'kumon-history-archive-v2' AND json_extract(header_json,'$.kind') IS 'monthly' AND json_type(header_json,'$.references') IS 'array' AND json_array_length(header_json,'$.references')=0 AND json_extract(header_json,'$.archiveId') IS archive_id AND json_extract(header_json,'$.centerId') IS center_id AND json_extract(header_json,'$.month') IS month AND json_extract(header_json,'$.timezone') IS timezone AND json_extract(header_json,'$.recordCount') IS record_count AND json_extract(root_reference_json,'$.archiveId') IS archive_id AND json_extract(root_reference_json,'$.kind') IS 'monthly' AND json_type(root_reference_json,'$.manifestObjectKey') IS 'text' AND length(json_extract(root_reference_json,'$.manifestObjectKey')) BETWEEN 1 AND 1024 AND length(json_extract(root_reference_json,'$.manifestSha256'))=64 AND json_extract(root_reference_json,'$.manifestSha256') NOT GLOB '*[^a-f0-9]*'),
 CHECK(json_type(counts_json,'$.centers') IS 'integer' AND json_extract(counts_json,'$.centers') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.students') IS 'integer' AND json_extract(counts_json,'$.students') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.guardians') IS 'integer' AND json_extract(counts_json,'$.guardians') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.student_guardians') IS 'integer' AND json_extract(counts_json,'$.student_guardians') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.staff') IS 'integer' AND json_extract(counts_json,'$.staff') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.visits') IS 'integer' AND json_extract(counts_json,'$.visits') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.attendance_events') IS 'integer' AND json_extract(counts_json,'$.attendance_events') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.attendance_corrections') IS 'integer' AND json_extract(counts_json,'$.attendance_corrections') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.reviews') IS 'integer' AND json_extract(counts_json,'$.reviews') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.audit_entries') IS 'integer' AND json_extract(counts_json,'$.audit_entries') BETWEEN 0 AND 20000 AND json_remove(counts_json,'$.centers','$.students','$.guardians','$.student_guardians','$.staff','$.visits','$.attendance_events','$.attendance_corrections','$.reviews','$.audit_entries')='{}' AND json_extract(counts_json,'$.centers')+json_extract(counts_json,'$.students')+json_extract(counts_json,'$.guardians')+json_extract(counts_json,'$.student_guardians')+json_extract(counts_json,'$.staff')+json_extract(counts_json,'$.visits')+json_extract(counts_json,'$.attendance_events')+json_extract(counts_json,'$.attendance_corrections')+json_extract(counts_json,'$.reviews')+json_extract(counts_json,'$.audit_entries')=indexed_count)
) WITHOUT ROWID;
CREATE UNIQUE INDEX archive_publication_month_owner ON archive_publication_builds(center_id,month) WHERE state!='invalid';
CREATE INDEX archive_publication_build_proof ON archive_publication_builds(verification_id,generation,state);
CREATE INDEX archive_publication_build_run ON archive_publication_builds(run_id,state);

CREATE TABLE archive_publication_parts (
 publication_id TEXT NOT NULL REFERENCES archive_publication_builds(publication_id),
 part_index INTEGER NOT NULL CHECK(typeof(part_index)='integer' AND part_index BETWEEN 0 AND 511),
 descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND json_type(descriptor_json)='object' AND length(CAST(descriptor_json AS BLOB))<=8192),
 descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
 record_count INTEGER NOT NULL CHECK(typeof(record_count)='integer' AND record_count BETWEEN 1 AND 256),
 indexed_count INTEGER NOT NULL DEFAULT 0 CHECK(typeof(indexed_count)='integer' AND indexed_count BETWEEN 0 AND record_count),
 completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0,1)),
 PRIMARY KEY(publication_id,part_index),
 CHECK(json_extract(descriptor_json,'$.index') IS part_index AND json_extract(descriptor_json,'$.recordCount') IS record_count),
 CHECK(completed=(indexed_count=record_count))
) WITHOUT ROWID;
CREATE TABLE archive_publication_records (
 publication_id TEXT NOT NULL, table_name TEXT NOT NULL CHECK(table_name IN ('centers','students','guardians','student_guardians','staff','visits','attendance_events','attendance_corrections','reviews','audit_entries')),
 record_key TEXT NOT NULL CHECK(length(record_key) BETWEEN 1 AND 210),
 part_index INTEGER NOT NULL,
 part_offset INTEGER NOT NULL CHECK(typeof(part_offset)='integer' AND part_offset BETWEEN 0 AND 255),
 descriptor_sha256 TEXT NOT NULL CHECK(length(descriptor_sha256)=64 AND descriptor_sha256 NOT GLOB '*[^a-f0-9]*'),
 record_sha256 TEXT NOT NULL CHECK(length(record_sha256)=64 AND record_sha256 NOT GLOB '*[^a-f0-9]*'),
 record_bytes INTEGER NOT NULL CHECK(typeof(record_bytes)='integer' AND record_bytes BETWEEN 1 AND 65536),
 PRIMARY KEY(publication_id,table_name,record_key),
 UNIQUE(publication_id,part_index,part_offset),
 FOREIGN KEY(publication_id,part_index) REFERENCES archive_publication_parts(publication_id,part_index)
) WITHOUT ROWID;
CREATE TABLE archive_publication_requests (
 request_id TEXT PRIMARY KEY REFERENCES history_request_keys(request_id),
 publication_id TEXT NOT NULL, source_kind TEXT NOT NULL CHECK(source_kind IN ('event','correction')),
 center_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
 table_name TEXT NOT NULL CHECK(table_name IN ('attendance_events','attendance_corrections')), record_key TEXT NOT NULL,
 UNIQUE(publication_id,table_name,record_key),
 FOREIGN KEY(publication_id,table_name,record_key) REFERENCES archive_publication_records(publication_id,table_name,record_key),
 CHECK(request_id=record_key AND ((source_kind='event' AND table_name='attendance_events') OR (source_kind='correction' AND table_name='attendance_corrections')))
) WITHOUT ROWID;
CREATE TABLE archive_publications (
 publication_id TEXT PRIMARY KEY REFERENCES archive_publication_builds(publication_id),
 verification_id TEXT NOT NULL, generation TEXT NOT NULL, run_id TEXT NOT NULL,
 snapshot_commit_token TEXT NOT NULL, graph_sha256 TEXT NOT NULL CHECK(length(graph_sha256)=64 AND graph_sha256 NOT GLOB '*[^a-f0-9]*'),
 validator_version INTEGER NOT NULL CHECK(validator_version=1),
 archive_id TEXT NOT NULL UNIQUE, center_id TEXT NOT NULL, month TEXT NOT NULL, timezone TEXT NOT NULL,
 root_reference_json TEXT NOT NULL CHECK(json_valid(root_reference_json) AND length(CAST(root_reference_json AS BLOB))<=2048),
 header_json TEXT NOT NULL CHECK(json_valid(header_json) AND length(CAST(header_json AS BLOB))<=49152),
 header_sha256 TEXT NOT NULL CHECK(length(header_sha256)=64 AND header_sha256 NOT GLOB '*[^a-f0-9]*'),
 manifest_object_key TEXT NOT NULL CHECK(length(manifest_object_key) BETWEEN 1 AND 1024),
 manifest_sha256 TEXT NOT NULL CHECK(length(manifest_sha256)=64 AND manifest_sha256 NOT GLOB '*[^a-f0-9]*'),
 format TEXT NOT NULL CHECK(format='kumon-history-archive-v2'), locator_version INTEGER NOT NULL CHECK(locator_version=1),
 record_count INTEGER NOT NULL CHECK(typeof(record_count)='integer' AND record_count BETWEEN 0 AND 20000),
 request_count INTEGER NOT NULL CHECK(typeof(request_count)='integer' AND request_count BETWEEN 0 AND record_count),
 counts_json TEXT NOT NULL CHECK(json_valid(counts_json) AND length(CAST(counts_json AS BLOB))<=2048),
 locator_digest TEXT NOT NULL CHECK(length(locator_digest)=64 AND locator_digest NOT GLOB '*[^a-f0-9]*'), published_at TEXT NOT NULL,
 UNIQUE(center_id,month),
 CHECK(json_extract(header_json,'$.format') IS 'kumon-history-archive-v2' AND json_extract(header_json,'$.kind') IS 'monthly' AND json_type(header_json,'$.references') IS 'array' AND json_array_length(header_json,'$.references')=0 AND json_extract(header_json,'$.archiveId') IS archive_id AND json_extract(header_json,'$.centerId') IS center_id AND json_extract(header_json,'$.month') IS month AND json_extract(header_json,'$.timezone') IS timezone AND json_extract(header_json,'$.recordCount') IS record_count AND json_extract(root_reference_json,'$.archiveId') IS archive_id AND json_extract(root_reference_json,'$.kind') IS 'monthly' AND json_type(root_reference_json,'$.manifestObjectKey') IS 'text' AND length(json_extract(root_reference_json,'$.manifestObjectKey')) BETWEEN 1 AND 1024 AND length(json_extract(root_reference_json,'$.manifestSha256'))=64 AND json_extract(root_reference_json,'$.manifestSha256') NOT GLOB '*[^a-f0-9]*'),
 CHECK(manifest_object_key IS json_extract(root_reference_json,'$.manifestObjectKey') AND manifest_sha256 IS json_extract(root_reference_json,'$.manifestSha256')),
 CHECK(json_type(counts_json,'$.centers') IS 'integer' AND json_extract(counts_json,'$.centers') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.students') IS 'integer' AND json_extract(counts_json,'$.students') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.guardians') IS 'integer' AND json_extract(counts_json,'$.guardians') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.student_guardians') IS 'integer' AND json_extract(counts_json,'$.student_guardians') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.staff') IS 'integer' AND json_extract(counts_json,'$.staff') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.visits') IS 'integer' AND json_extract(counts_json,'$.visits') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.attendance_events') IS 'integer' AND json_extract(counts_json,'$.attendance_events') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.attendance_corrections') IS 'integer' AND json_extract(counts_json,'$.attendance_corrections') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.reviews') IS 'integer' AND json_extract(counts_json,'$.reviews') BETWEEN 0 AND 20000 AND json_type(counts_json,'$.audit_entries') IS 'integer' AND json_extract(counts_json,'$.audit_entries') BETWEEN 0 AND 20000 AND json_remove(counts_json,'$.centers','$.students','$.guardians','$.student_guardians','$.staff','$.visits','$.attendance_events','$.attendance_corrections','$.reviews','$.audit_entries')='{}' AND json_extract(counts_json,'$.centers')+json_extract(counts_json,'$.students')+json_extract(counts_json,'$.guardians')+json_extract(counts_json,'$.student_guardians')+json_extract(counts_json,'$.staff')+json_extract(counts_json,'$.visits')+json_extract(counts_json,'$.attendance_events')+json_extract(counts_json,'$.attendance_corrections')+json_extract(counts_json,'$.reviews')+json_extract(counts_json,'$.audit_entries')=record_count)
) WITHOUT ROWID;
CREATE TABLE archive_publication_availability (
 publication_id TEXT PRIMARY KEY REFERENCES archive_publications(publication_id),
 generation TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','unavailable'))
) WITHOUT ROWID;

CREATE TRIGGER archive_publication_build_insert_guard BEFORE INSERT ON archive_publication_builds
WHEN EXISTS(SELECT 1 FROM archive_publication_builds WHERE publication_id=NEW.publication_id)
 OR EXISTS(SELECT 1 FROM archive_publication_builds WHERE center_id=NEW.center_id AND month=NEW.month AND state!='invalid')
 OR NEW.state!='building' OR NEW.revision!=0 OR NEW.lease_token IS NOT NULL OR NEW.lease_expires_at IS NOT NULL
 OR NEW.next_part!=0 OR NEW.next_offset!=0 OR NEW.indexed_count!=0 OR NEW.request_count!=0 OR NEW.locator_digest!='0000000000000000000000000000000000000000000000000000000000000000'
 OR NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now') OR NEW.updated_at IS NOT NEW.created_at OR NOT EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=NEW.run_id AND pr.verification_id=NEW.verification_id AND pr.generation=NEW.generation
      AND pr.snapshot_commit_token=NEW.snapshot_commit_token AND pr.graph_sha256=NEW.graph_sha256 AND pr.validator_version=NEW.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=NEW.archive_id AND pr.header_json=NEW.header_json
      AND ps.status='verified' AND ps.commit_token=NEW.snapshot_commit_token AND ps.graph_sha256=NEW.graph_sha256
      AND ps.root_archive_id=NEW.archive_id AND ps.root_reference_json=NEW.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(NEW.root_reference_json,'$.manifestSha256')
      AND pm.part_count=NEW.part_count AND pm.record_count=NEW.record_count AND json_remove(pm.manifest_json,'$.parts')=NEW.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_PROOF_INVALID'); END;

-- CASE is deliberately lazy: whole-publication counts run only at terminal publication.
CREATE TRIGGER archive_publication_build_update_guard BEFORE UPDATE ON archive_publication_builds
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.verification_id IS NOT OLD.verification_id OR NEW.generation IS NOT OLD.generation OR NEW.run_id IS NOT OLD.run_id OR NEW.snapshot_commit_token IS NOT OLD.snapshot_commit_token OR NEW.graph_sha256 IS NOT OLD.graph_sha256 OR NEW.validator_version IS NOT OLD.validator_version OR NEW.archive_id IS NOT OLD.archive_id OR NEW.center_id IS NOT OLD.center_id OR NEW.month IS NOT OLD.month OR NEW.timezone IS NOT OLD.timezone OR NEW.root_reference_json IS NOT OLD.root_reference_json OR NEW.header_json IS NOT OLD.header_json OR NEW.header_sha256 IS NOT OLD.header_sha256 OR NEW.part_count IS NOT OLD.part_count OR NEW.record_count IS NOT OLD.record_count OR NEW.created_at IS NOT OLD.created_at OR NEW.revision!=OLD.revision+1 OR NEW.updated_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT coalesce((CASE WHEN OLD.state!='building' THEN 0 WHEN NEW.state='invalid' THEN (OLD.state='building' AND NEW.state='invalid' AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL AND NEW.next_part IS OLD.next_part AND NEW.next_offset IS OLD.next_offset AND NEW.indexed_count IS OLD.indexed_count AND NEW.request_count IS OLD.request_count AND NEW.counts_json IS OLD.counts_json AND NEW.locator_digest IS OLD.locator_digest) WHEN NEW.state='published' THEN (OLD.state='building' AND NEW.state='published' AND OLD.lease_token IS NOT NULL AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL AND NEW.next_part IS OLD.next_part AND NEW.next_offset IS OLD.next_offset AND NEW.indexed_count IS OLD.indexed_count AND NEW.request_count IS OLD.request_count AND NEW.counts_json IS OLD.counts_json AND NEW.locator_digest IS OLD.locator_digest AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=NEW.run_id AND pr.verification_id=NEW.verification_id AND pr.generation=NEW.generation
      AND pr.snapshot_commit_token=NEW.snapshot_commit_token AND pr.graph_sha256=NEW.graph_sha256 AND pr.validator_version=NEW.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=NEW.archive_id AND pr.header_json=NEW.header_json
      AND ps.status='verified' AND ps.commit_token=NEW.snapshot_commit_token AND ps.graph_sha256=NEW.graph_sha256
      AND ps.root_archive_id=NEW.archive_id AND ps.root_reference_json=NEW.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(NEW.root_reference_json,'$.manifestSha256')
      AND pm.part_count=NEW.part_count AND pm.record_count=NEW.record_count AND json_remove(pm.manifest_json,'$.parts')=NEW.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NEW.next_part=NEW.part_count AND NEW.next_offset=0 AND NEW.indexed_count=NEW.record_count
    AND NEW.request_count=json_extract(NEW.header_json,'$.recordCounts.attendance_events')+json_extract(NEW.header_json,'$.recordCounts.attendance_corrections')
    AND (SELECT count(*) FROM archive_publication_parts WHERE publication_id=NEW.publication_id)=NEW.part_count
    AND NOT EXISTS(SELECT 1 FROM archive_publication_parts WHERE publication_id=NEW.publication_id AND completed!=1)
    AND (SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id)=NEW.record_count
    AND (SELECT count(*) FROM archive_publication_requests WHERE publication_id=NEW.publication_id)=NEW.request_count
    AND json_extract(NEW.counts_json,'$.centers')=json_extract(NEW.header_json,'$.recordCounts.centers') AND json_extract(NEW.counts_json,'$.centers')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='centers') AND json_extract(NEW.counts_json,'$.students')=json_extract(NEW.header_json,'$.recordCounts.students') AND json_extract(NEW.counts_json,'$.students')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='students') AND json_extract(NEW.counts_json,'$.guardians')=json_extract(NEW.header_json,'$.recordCounts.guardians') AND json_extract(NEW.counts_json,'$.guardians')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='guardians') AND json_extract(NEW.counts_json,'$.student_guardians')=json_extract(NEW.header_json,'$.recordCounts.student_guardians') AND json_extract(NEW.counts_json,'$.student_guardians')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='student_guardians') AND json_extract(NEW.counts_json,'$.staff')=json_extract(NEW.header_json,'$.recordCounts.staff') AND json_extract(NEW.counts_json,'$.staff')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='staff') AND json_extract(NEW.counts_json,'$.visits')=json_extract(NEW.header_json,'$.recordCounts.visits') AND json_extract(NEW.counts_json,'$.visits')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='visits') AND json_extract(NEW.counts_json,'$.attendance_events')=json_extract(NEW.header_json,'$.recordCounts.attendance_events') AND json_extract(NEW.counts_json,'$.attendance_events')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='attendance_events') AND json_extract(NEW.counts_json,'$.attendance_corrections')=json_extract(NEW.header_json,'$.recordCounts.attendance_corrections') AND json_extract(NEW.counts_json,'$.attendance_corrections')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='attendance_corrections') AND json_extract(NEW.counts_json,'$.reviews')=json_extract(NEW.header_json,'$.recordCounts.reviews') AND json_extract(NEW.counts_json,'$.reviews')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='reviews') AND json_extract(NEW.counts_json,'$.audit_entries')=json_extract(NEW.header_json,'$.recordCounts.audit_entries') AND json_extract(NEW.counts_json,'$.audit_entries')=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name='audit_entries')) WHEN NEW.state='building' THEN CASE WHEN NEW.lease_token IS NOT NULL THEN (OLD.state='building' AND NEW.state='building' AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=NEW.run_id AND pr.verification_id=NEW.verification_id AND pr.generation=NEW.generation
      AND pr.snapshot_commit_token=NEW.snapshot_commit_token AND pr.graph_sha256=NEW.graph_sha256 AND pr.validator_version=NEW.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=NEW.archive_id AND pr.header_json=NEW.header_json
      AND ps.status='verified' AND ps.commit_token=NEW.snapshot_commit_token AND ps.graph_sha256=NEW.graph_sha256
      AND ps.root_archive_id=NEW.archive_id AND ps.root_reference_json=NEW.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(NEW.root_reference_json,'$.manifestSha256')
      AND pm.part_count=NEW.part_count AND pm.record_count=NEW.record_count AND json_remove(pm.manifest_json,'$.parts')=NEW.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (OLD.lease_token IS NULL OR OLD.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND NEW.lease_token IS NOT NULL AND NEW.lease_token IS NOT OLD.lease_token AND NEW.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.lease_expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now','+30 seconds') AND NEW.next_part IS OLD.next_part AND NEW.next_offset IS OLD.next_offset AND NEW.indexed_count IS OLD.indexed_count AND NEW.request_count IS OLD.request_count AND NEW.counts_json IS OLD.counts_json AND NEW.locator_digest IS OLD.locator_digest) WHEN NEW.indexed_count=OLD.indexed_count THEN (OLD.state='building' AND NEW.state='building' AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=NEW.run_id AND pr.verification_id=NEW.verification_id AND pr.generation=NEW.generation
      AND pr.snapshot_commit_token=NEW.snapshot_commit_token AND pr.graph_sha256=NEW.graph_sha256 AND pr.validator_version=NEW.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=NEW.archive_id AND pr.header_json=NEW.header_json
      AND ps.status='verified' AND ps.commit_token=NEW.snapshot_commit_token AND ps.graph_sha256=NEW.graph_sha256
      AND ps.root_archive_id=NEW.archive_id AND ps.root_reference_json=NEW.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(NEW.root_reference_json,'$.manifestSha256')
      AND pm.part_count=NEW.part_count AND pm.record_count=NEW.record_count AND json_remove(pm.manifest_json,'$.parts')=NEW.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND OLD.lease_token IS NOT NULL AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL AND NEW.next_part IS OLD.next_part AND NEW.next_offset IS OLD.next_offset AND NEW.indexed_count IS OLD.indexed_count AND NEW.request_count IS OLD.request_count AND NEW.counts_json IS OLD.counts_json AND NEW.locator_digest IS OLD.locator_digest) ELSE (OLD.state='building' AND NEW.state='building' AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=NEW.run_id AND pr.verification_id=NEW.verification_id AND pr.generation=NEW.generation
      AND pr.snapshot_commit_token=NEW.snapshot_commit_token AND pr.graph_sha256=NEW.graph_sha256 AND pr.validator_version=NEW.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=NEW.archive_id AND pr.header_json=NEW.header_json
      AND ps.status='verified' AND ps.commit_token=NEW.snapshot_commit_token AND ps.graph_sha256=NEW.graph_sha256
      AND ps.root_archive_id=NEW.archive_id AND ps.root_reference_json=NEW.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(NEW.root_reference_json,'$.manifestSha256')
      AND pm.part_count=NEW.part_count AND pm.record_count=NEW.record_count AND json_remove(pm.manifest_json,'$.parts')=NEW.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND OLD.lease_token IS NOT NULL AND OLD.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.lease_token IS NULL AND NEW.lease_expires_at IS NULL
 AND NEW.indexed_count>OLD.indexed_count AND NEW.indexed_count-OLD.indexed_count<=64 AND NEW.locator_digest!=OLD.locator_digest
 AND EXISTS(SELECT 1 FROM archive_publication_parts p WHERE p.publication_id=OLD.publication_id AND p.part_index=OLD.next_part
   AND p.indexed_count=OLD.next_offset+NEW.indexed_count-OLD.indexed_count
   AND ((p.completed=0 AND NEW.next_part=OLD.next_part AND NEW.next_offset=p.indexed_count) OR (p.completed=1 AND NEW.next_part=OLD.next_part+1 AND NEW.next_offset=0))
   AND NEW.request_count=OLD.request_count+(SELECT count(*) FROM archive_publication_records ri
     JOIN archive_publication_requests rq ON rq.publication_id=ri.publication_id AND rq.table_name=ri.table_name AND rq.record_key=ri.record_key
     WHERE ri.publication_id=OLD.publication_id AND ri.part_index=OLD.next_part AND ri.part_offset>=OLD.next_offset AND ri.part_offset<p.indexed_count))) END ELSE 0 END),0)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_BUILD_INVALID'); END;

CREATE TRIGGER archive_publication_part_insert_guard BEFORE INSERT ON archive_publication_parts
WHEN EXISTS(SELECT 1 FROM archive_publication_parts WHERE publication_id=NEW.publication_id AND part_index=NEW.part_index)
 OR NEW.indexed_count!=0 OR NEW.completed!=0
 OR NOT EXISTS(SELECT 1 FROM archive_publication_builds b JOIN archive_semantic_parts sp ON sp.verification_id=b.verification_id AND sp.generation=b.generation AND sp.archive_id=b.archive_id AND sp.part_index=NEW.part_index
   WHERE b.publication_id=NEW.publication_id AND b.next_part=NEW.part_index AND b.next_offset=0 AND NEW.part_index<b.part_count
     AND NEW.descriptor_json=sp.descriptor_json AND NEW.descriptor_sha256=sp.descriptor_sha256 AND b.state='building' AND b.lease_token IS NOT NULL AND b.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=b.run_id AND pr.verification_id=b.verification_id AND pr.generation=b.generation
      AND pr.snapshot_commit_token=b.snapshot_commit_token AND pr.graph_sha256=b.graph_sha256 AND pr.validator_version=b.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=b.archive_id AND pr.header_json=b.header_json
      AND ps.status='verified' AND ps.commit_token=b.snapshot_commit_token AND ps.graph_sha256=b.graph_sha256
      AND ps.root_archive_id=b.archive_id AND ps.root_reference_json=b.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(b.root_reference_json,'$.manifestSha256')
      AND pm.part_count=b.part_count AND pm.record_count=b.record_count AND json_remove(pm.manifest_json,'$.parts')=b.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_PART_INVALID'); END;
CREATE TRIGGER archive_publication_part_update_guard BEFORE UPDATE ON archive_publication_parts
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.part_index IS NOT OLD.part_index OR NEW.descriptor_json IS NOT OLD.descriptor_json OR NEW.descriptor_sha256 IS NOT OLD.descriptor_sha256 OR NEW.record_count IS NOT OLD.record_count
 OR OLD.completed=1 OR NEW.indexed_count<=OLD.indexed_count OR NEW.indexed_count-OLD.indexed_count>64
 OR NEW.indexed_count!=(SELECT count(*) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND part_index=NEW.part_index)
 OR (SELECT min(part_offset) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND part_index=NEW.part_index)!=0
 OR (SELECT max(part_offset) FROM archive_publication_records WHERE publication_id=NEW.publication_id AND part_index=NEW.part_index)!=NEW.indexed_count-1
 OR NOT EXISTS(SELECT 1 FROM archive_publication_builds b WHERE b.publication_id=NEW.publication_id AND b.next_part=NEW.part_index AND b.next_offset=OLD.indexed_count AND b.state='building' AND b.lease_token IS NOT NULL AND b.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=b.run_id AND pr.verification_id=b.verification_id AND pr.generation=b.generation
      AND pr.snapshot_commit_token=b.snapshot_commit_token AND pr.graph_sha256=b.graph_sha256 AND pr.validator_version=b.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=b.archive_id AND pr.header_json=b.header_json
      AND ps.status='verified' AND ps.commit_token=b.snapshot_commit_token AND ps.graph_sha256=b.graph_sha256
      AND ps.root_archive_id=b.archive_id AND ps.root_reference_json=b.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(b.root_reference_json,'$.manifestSha256')
      AND pm.part_count=b.part_count AND pm.record_count=b.record_count AND json_remove(pm.manifest_json,'$.parts')=b.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_PART_INVALID'); END;
CREATE TRIGGER archive_publication_record_insert_guard BEFORE INSERT ON archive_publication_records
WHEN EXISTS(SELECT 1 FROM archive_publication_records WHERE publication_id=NEW.publication_id AND table_name=NEW.table_name AND record_key=NEW.record_key)
 OR EXISTS(SELECT 1 FROM archive_publication_records WHERE publication_id=NEW.publication_id AND part_index=NEW.part_index AND part_offset=NEW.part_offset)
 OR NOT EXISTS(SELECT 1 FROM archive_publication_builds b JOIN archive_publication_parts p ON p.publication_id=b.publication_id AND p.part_index=b.next_part
   JOIN archive_semantic_rows sr ON sr.verification_id=b.verification_id AND sr.generation=b.generation AND sr.archive_id=b.archive_id AND sr.table_name=NEW.table_name AND sr.record_key=NEW.record_key
   WHERE b.publication_id=NEW.publication_id AND NEW.part_index=b.next_part AND p.completed=0 AND NEW.descriptor_sha256=p.descriptor_sha256
     AND NEW.part_offset>=b.next_offset AND NEW.part_offset<b.next_offset+64 AND NEW.part_offset<p.record_count
     AND sr.part_index=NEW.part_index AND length(CAST(sr.record_json AS BLOB))=NEW.record_bytes AND b.state='building' AND b.lease_token IS NOT NULL AND b.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=b.run_id AND pr.verification_id=b.verification_id AND pr.generation=b.generation
      AND pr.snapshot_commit_token=b.snapshot_commit_token AND pr.graph_sha256=b.graph_sha256 AND pr.validator_version=b.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=b.archive_id AND pr.header_json=b.header_json
      AND ps.status='verified' AND ps.commit_token=b.snapshot_commit_token AND ps.graph_sha256=b.graph_sha256
      AND ps.root_archive_id=b.archive_id AND ps.root_reference_json=b.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(b.root_reference_json,'$.manifestSha256')
      AND pm.part_count=b.part_count AND pm.record_count=b.record_count AND json_remove(pm.manifest_json,'$.parts')=b.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_RECORD_INVALID'); END;
CREATE TRIGGER archive_publication_request_insert_guard BEFORE INSERT ON archive_publication_requests
WHEN EXISTS(SELECT 1 FROM archive_publication_requests WHERE request_id=NEW.request_id)
 OR NOT EXISTS(SELECT 1 FROM history_request_keys k
   JOIN archive_publication_builds b ON b.publication_id=NEW.publication_id
   JOIN archive_publication_records r ON r.publication_id=b.publication_id AND r.table_name=NEW.table_name AND r.record_key=NEW.record_key
   JOIN archive_semantic_rows sr ON sr.verification_id=b.verification_id AND sr.generation=b.generation AND sr.archive_id=b.archive_id AND sr.table_name=r.table_name AND sr.record_key=r.record_key
   WHERE k.request_id=NEW.request_id AND k.source_kind=NEW.source_kind AND k.center_id=NEW.center_id AND k.payload_hash=NEW.payload_hash
     AND b.center_id=NEW.center_id AND r.part_index=b.next_part AND r.part_offset>=b.next_offset AND r.part_offset<b.next_offset+64
     AND json_extract(sr.record_json,'$.row.payload_hash')=NEW.payload_hash AND b.state='building' AND b.lease_token IS NOT NULL AND b.lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=b.run_id AND pr.verification_id=b.verification_id AND pr.generation=b.generation
      AND pr.snapshot_commit_token=b.snapshot_commit_token AND pr.graph_sha256=b.graph_sha256 AND pr.validator_version=b.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=b.archive_id AND pr.header_json=b.header_json
      AND ps.status='verified' AND ps.commit_token=b.snapshot_commit_token AND ps.graph_sha256=b.graph_sha256
      AND ps.root_archive_id=b.archive_id AND ps.root_reference_json=b.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(b.root_reference_json,'$.manifestSha256')
      AND pm.part_count=b.part_count AND pm.record_count=b.record_count AND json_remove(pm.manifest_json,'$.parts')=b.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_REQUEST_INVALID'); END;

CREATE TRIGGER archive_publication_descriptor_insert_guard BEFORE INSERT ON archive_publications
WHEN EXISTS(SELECT 1 FROM archive_publications WHERE publication_id=NEW.publication_id)
 OR EXISTS(SELECT 1 FROM archive_publications WHERE archive_id=NEW.archive_id)
 OR EXISTS(SELECT 1 FROM archive_publications WHERE center_id=NEW.center_id AND month=NEW.month)
 OR NEW.published_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM archive_publication_builds b WHERE b.publication_id=NEW.publication_id AND b.state='published'
   AND NEW.publication_id IS b.publication_id AND NEW.verification_id IS b.verification_id AND NEW.generation IS b.generation AND NEW.run_id IS b.run_id AND NEW.snapshot_commit_token IS b.snapshot_commit_token AND NEW.graph_sha256 IS b.graph_sha256 AND NEW.validator_version IS b.validator_version AND NEW.archive_id IS b.archive_id AND NEW.center_id IS b.center_id AND NEW.month IS b.month AND NEW.timezone IS b.timezone AND NEW.root_reference_json IS b.root_reference_json AND NEW.header_json IS b.header_json AND NEW.header_sha256 IS b.header_sha256 AND NEW.record_count IS b.record_count AND NEW.request_count IS b.request_count AND NEW.counts_json IS b.counts_json AND NEW.locator_digest IS b.locator_digest AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=b.run_id AND pr.verification_id=b.verification_id AND pr.generation=b.generation
      AND pr.snapshot_commit_token=b.snapshot_commit_token AND pr.graph_sha256=b.graph_sha256 AND pr.validator_version=b.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=b.archive_id AND pr.header_json=b.header_json
      AND ps.status='verified' AND ps.commit_token=b.snapshot_commit_token AND ps.graph_sha256=b.graph_sha256
      AND ps.root_archive_id=b.archive_id AND ps.root_reference_json=b.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(b.root_reference_json,'$.manifestSha256')
      AND pm.part_count=b.part_count AND pm.record_count=b.record_count AND json_remove(pm.manifest_json,'$.parts')=b.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_COMMIT_INVALID'); END;
CREATE TRIGGER archive_publication_availability_insert_guard BEFORE INSERT ON archive_publication_availability
WHEN EXISTS(SELECT 1 FROM archive_publication_availability WHERE publication_id=NEW.publication_id)
 OR NEW.status!='ready' OR NOT EXISTS(SELECT 1 FROM archive_publications p JOIN archive_publication_builds b ON b.publication_id=p.publication_id
   WHERE p.publication_id=NEW.publication_id AND b.state='published' AND NEW.generation=b.generation AND EXISTS(SELECT 1 FROM archive_semantic_runs pr
    JOIN archive_semantic_sessions ps ON ps.verification_id=pr.verification_id AND ps.generation=pr.generation
    JOIN archive_semantic_manifests pm ON pm.verification_id=ps.verification_id AND pm.generation=ps.generation AND pm.archive_id=pr.archive_id
    JOIN archive_semantic_lifecycle pl ON pl.verification_id=ps.verification_id AND pl.generation=ps.generation
    JOIN history_runtime ph ON ph.id=1 AND ph.generation=ps.generation
    WHERE pr.run_id=b.run_id AND pr.verification_id=b.verification_id AND pr.generation=b.generation
      AND pr.snapshot_commit_token=b.snapshot_commit_token AND pr.graph_sha256=b.graph_sha256 AND pr.validator_version=b.validator_version AND pr.validator_version=1
      AND pr.status='complete' AND pr.phase='complete' AND pr.archive_id=b.archive_id AND pr.header_json=b.header_json
      AND ps.status='verified' AND ps.commit_token=b.snapshot_commit_token AND ps.graph_sha256=b.graph_sha256
      AND ps.root_archive_id=b.archive_id AND ps.root_reference_json=b.root_reference_json
      AND pm.manifest_sha256=ps.root_manifest_sha256 AND pm.manifest_sha256=json_extract(b.root_reference_json,'$.manifestSha256')
      AND pm.part_count=b.part_count AND pm.record_count=b.record_count AND json_remove(pm.manifest_json,'$.parts')=b.header_json
      AND ph.state='ready' AND pl.pause_reason IS NULL AND pl.due_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_AVAILABILITY_INVALID'); END;
CREATE TRIGGER archive_publication_availability_update_guard BEFORE UPDATE ON archive_publication_availability
WHEN NEW.publication_id IS NOT OLD.publication_id OR NEW.generation IS NOT OLD.generation OR NEW.status!='unavailable'
BEGIN SELECT RAISE(ABORT,'ARCHIVE_PUBLICATION_AVAILABILITY_INVALID'); END;

CREATE TRIGGER archive_publication_generation_changed AFTER UPDATE OF generation ON history_runtime
WHEN NEW.generation!=OLD.generation
BEGIN
 UPDATE archive_publication_builds SET state='invalid',lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE state='building';
 UPDATE archive_publication_availability SET status='unavailable' WHERE status='ready';
END;
CREATE TRIGGER archive_publication_session_invalidated AFTER UPDATE OF status ON archive_semantic_sessions
WHEN NEW.status='invalid'
BEGIN UPDATE archive_publication_builds SET state='invalid',lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE verification_id=NEW.verification_id AND generation=NEW.generation AND state='building'; END;
CREATE TRIGGER archive_publication_run_invalidated AFTER UPDATE OF status ON archive_semantic_runs
WHEN NEW.status='invalid'
BEGIN UPDATE archive_publication_builds SET state='invalid',lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE run_id=NEW.run_id AND state='building'; END;

CREATE TRIGGER archive_publication_builds_no_delete BEFORE DELETE ON archive_publication_builds
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER backup_lock_archive_publication_builds_insert BEFORE INSERT ON archive_publication_builds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_builds_update BEFORE UPDATE ON archive_publication_builds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_builds_delete BEFORE DELETE ON archive_publication_builds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER archive_publication_parts_no_delete BEFORE DELETE ON archive_publication_parts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER backup_lock_archive_publication_parts_insert BEFORE INSERT ON archive_publication_parts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_parts_update BEFORE UPDATE ON archive_publication_parts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_parts_delete BEFORE DELETE ON archive_publication_parts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER archive_publication_records_no_delete BEFORE DELETE ON archive_publication_records
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER archive_publication_records_no_update BEFORE UPDATE ON archive_publication_records
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER backup_lock_archive_publication_records_insert BEFORE INSERT ON archive_publication_records
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_records_update BEFORE UPDATE ON archive_publication_records
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_records_delete BEFORE DELETE ON archive_publication_records
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER archive_publication_requests_no_delete BEFORE DELETE ON archive_publication_requests
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER archive_publication_requests_no_update BEFORE UPDATE ON archive_publication_requests
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER backup_lock_archive_publication_requests_insert BEFORE INSERT ON archive_publication_requests
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_requests_update BEFORE UPDATE ON archive_publication_requests
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_requests_delete BEFORE DELETE ON archive_publication_requests
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER archive_publications_no_delete BEFORE DELETE ON archive_publications
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER archive_publications_no_update BEFORE UPDATE ON archive_publications
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER backup_lock_archive_publications_insert BEFORE INSERT ON archive_publications
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publications_update BEFORE UPDATE ON archive_publications
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publications_delete BEFORE DELETE ON archive_publications
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER archive_publication_availability_no_delete BEFORE DELETE ON archive_publication_availability
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_PUBLICATION'); END;
CREATE TRIGGER backup_lock_archive_publication_availability_insert BEFORE INSERT ON archive_publication_availability
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_availability_update BEFORE UPDATE ON archive_publication_availability
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_publication_availability_delete BEFORE DELETE ON archive_publication_availability
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(25);
