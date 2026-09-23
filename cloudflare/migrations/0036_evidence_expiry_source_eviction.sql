-- Explicit evidence-expiry schedules and an atomic live-source eviction gate.
-- R2 deletion is still impossible. Source eviction is disabled for every center
-- until a later, audited policy revision enables it after operational acceptance.

CREATE TABLE history_evidence_expiry_schedules (
  schedule_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES history_retention_jobs(job_id),
  sequence INTEGER NOT NULL,
  visit_id TEXT NOT NULL,
  center_id TEXT NOT NULL REFERENCES centers(id),
  generation TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  evidence_expires_at TEXT NOT NULL,
  base_publication_id TEXT NOT NULL,
  authority_digest TEXT NOT NULL CHECK(length(authority_digest)=44),
  delete_enabled INTEGER NOT NULL DEFAULT 0 CHECK(delete_enabled=0),
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status='scheduled'),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE(job_id,visit_id),
  FOREIGN KEY(job_id,sequence) REFERENCES history_retention_items(job_id,sequence)
) WITHOUT ROWID;

CREATE INDEX history_evidence_expiry_due
  ON history_evidence_expiry_schedules(center_id,evidence_expires_at,visit_id);

CREATE TRIGGER history_evidence_expiry_schedule_guard
BEFORE INSERT ON history_evidence_expiry_schedules
WHEN NEW.delete_enabled!=0 OR NEW.status!='scheduled' OR NOT EXISTS(
  SELECT 1
  FROM history_retention_jobs j
  JOIN history_retention_items i ON i.job_id=j.job_id AND i.sequence=NEW.sequence
  JOIN history_retention_permits rp ON rp.job_id=j.job_id
  JOIN history_retention_policies p ON p.center_id=j.center_id
  JOIN history_runtime h ON h.id=1
  WHERE j.job_id=NEW.job_id AND j.status='complete'
    AND j.center_id=NEW.center_id AND j.generation=NEW.generation
    AND j.policy_revision=NEW.policy_revision
    AND j.authority_digest=NEW.authority_digest
    AND rp.authority_digest=j.authority_digest AND rp.mode='dry_run' AND rp.delete_enabled=0
    AND i.visit_id=NEW.visit_id AND i.base_publication_id=NEW.base_publication_id
    AND p.revision=j.policy_revision AND p.evidence_expiry_enabled=1
    AND h.generation=j.generation AND h.state='ready'
    AND NEW.evidence_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',i.effective_check_out_at,'+'||j.evidence_retention_days||' days')
    AND NOT EXISTS(SELECT 1 FROM history_retention_invalidations x WHERE x.job_id=j.job_id)
    AND NOT EXISTS(
      SELECT 1 FROM history_holds x
      WHERE x.center_id=j.center_id AND (x.visit_id=i.visit_id OR x.student_id=i.student_id)
        AND NOT EXISTS(SELECT 1 FROM history_hold_releases r WHERE r.hold_id=x.hold_id)
    )
)
BEGIN SELECT RAISE(ABORT,'EVIDENCE_EXPIRY_SCHEDULE_INVALID'); END;

CREATE TRIGGER history_evidence_expiry_schedules_no_update
BEFORE UPDATE ON history_evidence_expiry_schedules
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE_EXPIRY_SCHEDULE'); END;

CREATE TRIGGER history_evidence_expiry_schedules_no_delete
BEFORE DELETE ON history_evidence_expiry_schedules
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE_EXPIRY_SCHEDULE'); END;

ALTER TABLE history_retention_items ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE history_source_revisions (
  visit_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK(revision>=0),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO history_source_revisions(visit_id,revision,updated_at)
SELECT id,0,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM visits;

CREATE TRIGGER history_source_revision_visit_insert AFTER INSERT ON visits
BEGIN
  INSERT INTO history_source_revisions(visit_id,revision,updated_at)
  VALUES(NEW.id,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(visit_id) DO UPDATE SET revision=revision+1,updated_at=excluded.updated_at;
END;
CREATE TRIGGER history_source_revision_visit_update AFTER UPDATE ON visits
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=NEW.id; END;
CREATE TRIGGER history_source_revision_visit_delete AFTER DELETE ON visits
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=OLD.id; END;
CREATE TRIGGER history_source_revision_event_insert AFTER INSERT ON attendance_events WHEN NEW.visit_id IS NOT NULL
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=NEW.visit_id; END;
CREATE TRIGGER history_source_revision_event_update AFTER UPDATE ON attendance_events WHEN NEW.visit_id IS NOT NULL
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=NEW.visit_id; END;
CREATE TRIGGER history_source_revision_event_delete AFTER DELETE ON attendance_events WHEN OLD.visit_id IS NOT NULL
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=OLD.visit_id; END;
CREATE TRIGGER history_source_revision_correction_insert AFTER INSERT ON attendance_corrections
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=NEW.visit_id; END;
CREATE TRIGGER history_source_revision_correction_delete AFTER DELETE ON attendance_corrections
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=OLD.visit_id; END;
CREATE TRIGGER history_source_revision_review_insert AFTER INSERT ON reviews WHEN NEW.visit_id IS NOT NULL
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=NEW.visit_id; END;
CREATE TRIGGER history_source_revision_review_update AFTER UPDATE ON reviews WHEN NEW.visit_id IS NOT NULL
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=NEW.visit_id; END;
CREATE TRIGGER history_source_revision_review_delete AFTER DELETE ON reviews WHEN OLD.visit_id IS NOT NULL
BEGIN UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE visit_id=OLD.visit_id; END;
CREATE TRIGGER history_source_revision_audit_insert AFTER INSERT ON audit_entries
BEGIN
  UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NEW.entity_type='visit' AND visit_id=NEW.entity_id;
  UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NEW.entity_type='attendance_event' AND visit_id=(SELECT visit_id FROM attendance_events WHERE id=NEW.entity_id);
  UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE NEW.entity_type='review' AND visit_id=(SELECT visit_id FROM reviews WHERE id=NEW.entity_id);
END;
CREATE TRIGGER history_source_revision_audit_delete AFTER DELETE ON audit_entries
BEGIN
  UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE OLD.entity_type='visit' AND visit_id=OLD.entity_id;
  UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE OLD.entity_type='attendance_event' AND visit_id=(SELECT visit_id FROM attendance_events WHERE id=OLD.entity_id);
  UPDATE history_source_revisions SET revision=revision+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE OLD.entity_type='review' AND visit_id=(SELECT visit_id FROM reviews WHERE id=OLD.entity_id);
END;
CREATE TRIGGER history_source_revisions_no_delete BEFORE DELETE ON history_source_revisions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_REVISION'); END;

CREATE TABLE history_source_eviction_policies (
  center_id TEXT PRIMARY KEY REFERENCES centers(id),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  verification_freshness_seconds INTEGER NOT NULL DEFAULT 300
    CHECK(verification_freshness_seconds BETWEEN 60 AND 900),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE history_source_eviction_policy_revisions (
  center_id TEXT NOT NULL REFERENCES centers(id),
  revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  verification_freshness_seconds INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY(center_id,revision)
) WITHOUT ROWID;

INSERT INTO history_source_eviction_policies(center_id,updated_at,updated_by)
SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'schema-36-disabled' FROM centers;

INSERT INTO history_source_eviction_policy_revisions(
  center_id,revision,enabled,verification_freshness_seconds,recorded_at,recorded_by
)
SELECT center_id,revision,enabled,verification_freshness_seconds,updated_at,updated_by
FROM history_source_eviction_policies;

CREATE TRIGGER history_source_eviction_center_default
AFTER INSERT ON centers
BEGIN
  INSERT INTO history_source_eviction_policies(center_id,updated_at,updated_by)
  VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'schema-36-disabled');
  INSERT INTO history_source_eviction_policy_revisions(
    center_id,revision,enabled,verification_freshness_seconds,recorded_at,recorded_by
  ) VALUES(NEW.id,1,0,300,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'schema-36-disabled');
END;

CREATE TRIGGER history_source_eviction_policy_update_guard
BEFORE UPDATE ON history_source_eviction_policies
WHEN NEW.center_id IS NOT OLD.center_id OR NEW.revision!=OLD.revision+1
  OR NEW.updated_at<=OLD.updated_at
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_POLICY_INVALID'); END;

CREATE TRIGGER history_source_eviction_policy_revision
AFTER UPDATE ON history_source_eviction_policies
BEGIN
  INSERT INTO history_source_eviction_policy_revisions(
    center_id,revision,enabled,verification_freshness_seconds,recorded_at,recorded_by
  ) VALUES(NEW.center_id,NEW.revision,NEW.enabled,NEW.verification_freshness_seconds,NEW.updated_at,NEW.updated_by);
END;

CREATE TRIGGER history_source_eviction_policy_no_delete
BEFORE DELETE ON history_source_eviction_policies
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_POLICY_REQUIRED'); END;

CREATE TRIGGER history_source_eviction_policy_revisions_no_update
BEFORE UPDATE ON history_source_eviction_policy_revisions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_EVICTION_POLICY'); END;

CREATE TRIGGER history_source_eviction_policy_revisions_no_delete
BEFORE DELETE ON history_source_eviction_policy_revisions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_EVICTION_POLICY'); END;

CREATE TABLE history_source_eviction_capabilities (
  capability_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES history_retention_jobs(job_id),
  sequence INTEGER NOT NULL,
  visit_id TEXT NOT NULL UNIQUE,
  center_id TEXT NOT NULL REFERENCES centers(id),
  generation TEXT NOT NULL,
  retention_policy_revision INTEGER NOT NULL,
  eviction_policy_revision INTEGER NOT NULL,
  source_closure_json TEXT NOT NULL CHECK(json_valid(source_closure_json)),
  source_closure_sha256 TEXT NOT NULL CHECK(length(source_closure_sha256)=44),
  evidence_closure_sha256 TEXT NOT NULL CHECK(length(evidence_closure_sha256)=44),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visit_count INTEGER NOT NULL CHECK(visit_count=1),
  event_count INTEGER NOT NULL CHECK(event_count>=0),
  correction_count INTEGER NOT NULL CHECK(correction_count>=0),
  review_count INTEGER NOT NULL CHECK(review_count>=0),
  audit_count INTEGER NOT NULL CHECK(audit_count>=0),
  legacy_hold_count INTEGER NOT NULL CHECK(legacy_hold_count>=0),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  FOREIGN KEY(job_id,sequence) REFERENCES history_retention_items(job_id,sequence)
) WITHOUT ROWID;

CREATE TABLE history_source_eviction_receipts (
  receipt_id TEXT PRIMARY KEY,
  capability_id TEXT NOT NULL UNIQUE,
  job_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  visit_id TEXT NOT NULL UNIQUE,
  center_id TEXT NOT NULL REFERENCES centers(id),
  generation TEXT NOT NULL,
  retention_policy_revision INTEGER NOT NULL,
  eviction_policy_revision INTEGER NOT NULL,
  source_closure_sha256 TEXT NOT NULL CHECK(length(source_closure_sha256)=44),
  evidence_closure_sha256 TEXT NOT NULL CHECK(length(evidence_closure_sha256)=44),
  source_revision INTEGER NOT NULL CHECK(source_revision>=0),
  visit_count INTEGER NOT NULL CHECK(visit_count=1),
  event_count INTEGER NOT NULL CHECK(event_count>=0),
  correction_count INTEGER NOT NULL CHECK(correction_count>=0),
  review_count INTEGER NOT NULL CHECK(review_count>=0),
  audit_count INTEGER NOT NULL CHECK(audit_count>=0),
  legacy_hold_count INTEGER NOT NULL CHECK(legacy_hold_count>=0),
  verified_at TEXT NOT NULL,
  evicted_at TEXT NOT NULL,
  evicted_by TEXT NOT NULL,
  FOREIGN KEY(job_id,sequence) REFERENCES history_retention_items(job_id,sequence)
) WITHOUT ROWID;

CREATE INDEX history_source_eviction_receipts_center_time
  ON history_source_eviction_receipts(center_id,evicted_at,visit_id);

CREATE TRIGGER history_source_eviction_capability_authority_guard
BEFORE INSERT ON history_source_eviction_capabilities
WHEN NOT EXISTS(
  SELECT 1
  FROM history_retention_jobs j
  JOIN history_retention_items i ON i.job_id=j.job_id AND i.sequence=NEW.sequence
  JOIN history_retention_permits rp ON rp.job_id=j.job_id
  JOIN history_source_eviction_policies ep ON ep.center_id=j.center_id
  JOIN history_runtime h ON h.id=1
  JOIN history_visit_heads vh ON vh.visit_id=i.visit_id
  JOIN history_source_revisions sr ON sr.visit_id=i.visit_id
  WHERE j.job_id=NEW.job_id AND j.status='complete'
    AND j.center_id=NEW.center_id AND j.generation=NEW.generation
    AND j.policy_revision=NEW.retention_policy_revision
    AND i.visit_id=NEW.visit_id AND i.source_closure_json=NEW.source_closure_json
    AND i.source_closure_sha256=NEW.source_closure_sha256
    AND i.evidence_closure_sha256=NEW.evidence_closure_sha256
    AND i.source_revision=NEW.source_revision AND sr.revision=NEW.source_revision
    AND rp.authority_digest=j.authority_digest AND rp.mode='dry_run' AND rp.delete_enabled=0
    AND ep.enabled=1 AND ep.revision=NEW.eviction_policy_revision
    AND h.generation=j.generation AND h.state='ready'
    AND vh.center_id=j.center_id AND vh.student_id=i.student_id
    AND vh.original_check_in_at=i.original_check_in_at
    AND vh.check_out_at=i.effective_check_out_at AND vh.version=i.head_version
)
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_AUTHORITY_INVALID'); END;

CREATE TRIGGER history_source_eviction_capability_freshness_guard
BEFORE INSERT ON history_source_eviction_capabilities
WHEN NEW.created_at!=NEW.verified_at OR NOT EXISTS(
  SELECT 1 FROM history_source_eviction_policies ep
  WHERE ep.center_id=NEW.center_id
    AND julianday(NEW.verified_at)>=julianday('now')-(ep.verification_freshness_seconds/86400.0)
)
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_AUTHORITY_INVALID'); END;

CREATE TRIGGER history_source_eviction_capability_source_guard
BEFORE INSERT ON history_source_eviction_capabilities
WHEN NEW.visit_count!=(SELECT count(*) FROM visits v WHERE v.id=NEW.visit_id)
  OR NEW.event_count!=(SELECT count(*) FROM attendance_events e WHERE e.visit_id=NEW.visit_id)
  OR NEW.correction_count!=(SELECT count(*) FROM attendance_corrections x WHERE x.visit_id=NEW.visit_id)
  OR NEW.review_count!=(SELECT count(*) FROM reviews r WHERE r.visit_id=NEW.visit_id)
  OR NEW.audit_count!=(
    SELECT count(*) FROM audit_entries a
    WHERE EXISTS(SELECT 1 FROM json_each(NEW.source_closure_json,'$.audits') x
      WHERE json_extract(x.value,'$.id')=a.id)
  )
  OR NEW.legacy_hold_count!=(SELECT count(*) FROM archive_holds a WHERE a.visit_id=NEW.visit_id)
  OR EXISTS(SELECT 1 FROM history_source_eviction_receipts er WHERE er.visit_id=NEW.visit_id)
  OR EXISTS(SELECT 1 FROM history_retention_invalidations x WHERE x.job_id=NEW.job_id)
  OR EXISTS(SELECT 1 FROM backup_runtime b WHERE b.id=1 AND b.write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  OR EXISTS(SELECT 1 FROM reviews r WHERE r.visit_id=NEW.visit_id AND r.status='pending')
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_AUTHORITY_INVALID'); END;

CREATE TRIGGER history_source_eviction_capability_hold_guard
BEFORE INSERT ON history_source_eviction_capabilities
WHEN EXISTS(
  SELECT 1 FROM history_retention_items i JOIN history_holds x
    ON x.center_id=NEW.center_id AND (x.visit_id=NEW.visit_id OR x.student_id=i.student_id)
  WHERE i.job_id=NEW.job_id AND i.sequence=NEW.sequence
    AND NOT EXISTS(SELECT 1 FROM history_hold_releases z WHERE z.hold_id=x.hold_id)
) OR EXISTS(
  SELECT 1 FROM archive_holds a
  WHERE a.visit_id=NEW.visit_id AND (
    NOT EXISTS(SELECT 1 FROM history_holds x WHERE x.hold_id=a.id)
    OR (a.released_at IS NOT NULL AND NOT EXISTS(
      SELECT 1 FROM history_hold_releases z
      WHERE z.hold_id=a.id AND z.released_at=a.released_at
        AND z.released_by=a.released_by AND z.release_reason=a.release_reason
    ))
  )
)
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_AUTHORITY_INVALID'); END;

CREATE TRIGGER history_source_eviction_capabilities_no_update
BEFORE UPDATE ON history_source_eviction_capabilities
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_EVICTION_CAPABILITY'); END;

CREATE TRIGGER history_source_eviction_capability_delete_guard
BEFORE DELETE ON history_source_eviction_capabilities
WHEN NOT EXISTS(SELECT 1 FROM history_source_eviction_receipts r WHERE r.capability_id=OLD.capability_id)
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_RECEIPT_REQUIRED'); END;

CREATE TRIGGER history_source_eviction_receipt_guard
BEFORE INSERT ON history_source_eviction_receipts
WHEN NOT EXISTS(
  SELECT 1 FROM history_source_eviction_capabilities c
  WHERE c.capability_id=NEW.capability_id AND c.job_id=NEW.job_id
    AND c.sequence=NEW.sequence AND c.visit_id=NEW.visit_id
    AND c.center_id=NEW.center_id AND c.generation=NEW.generation
    AND c.retention_policy_revision=NEW.retention_policy_revision
    AND c.eviction_policy_revision=NEW.eviction_policy_revision
    AND c.source_closure_sha256=NEW.source_closure_sha256
    AND c.evidence_closure_sha256=NEW.evidence_closure_sha256
    AND c.source_revision=NEW.source_revision
    AND c.visit_count=NEW.visit_count AND c.event_count=NEW.event_count
    AND c.correction_count=NEW.correction_count AND c.review_count=NEW.review_count
    AND c.audit_count=NEW.audit_count AND c.legacy_hold_count=NEW.legacy_hold_count
    AND c.verified_at=NEW.verified_at AND c.created_by=NEW.evicted_by
    AND NOT EXISTS(SELECT 1 FROM visits v WHERE v.id=c.visit_id)
    AND NOT EXISTS(SELECT 1 FROM attendance_events e WHERE e.visit_id=c.visit_id)
    AND NOT EXISTS(SELECT 1 FROM attendance_corrections x WHERE x.visit_id=c.visit_id)
    AND NOT EXISTS(SELECT 1 FROM reviews r WHERE r.visit_id=c.visit_id)
    AND NOT EXISTS(SELECT 1 FROM archive_holds a WHERE a.visit_id=c.visit_id)
    AND NOT EXISTS(
      SELECT 1 FROM audit_entries a
      WHERE EXISTS(SELECT 1 FROM json_each(c.source_closure_json,'$.audits') x
        WHERE json_extract(x.value,'$.id')=a.id)
    )
    AND EXISTS(SELECT 1 FROM history_visit_heads h WHERE h.visit_id=c.visit_id)
    AND NOT EXISTS(
      SELECT 1 FROM json_each(c.source_closure_json,'$.events') x
      LEFT JOIN history_request_keys k ON k.request_id=json_extract(x.value,'$.id')
      WHERE k.request_id IS NULL OR k.source_kind!='event'
    )
    AND NOT EXISTS(
      SELECT 1 FROM json_each(c.source_closure_json,'$.corrections') x
      LEFT JOIN history_request_keys k ON k.request_id=json_extract(x.value,'$.id')
      WHERE k.request_id IS NULL OR k.source_kind!='correction'
    )
  )
BEGIN SELECT RAISE(ABORT,'SOURCE_EVICTION_RECEIPT_INVALID'); END;

CREATE TRIGGER history_source_eviction_receipts_no_update
BEFORE UPDATE ON history_source_eviction_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_EVICTION_RECEIPT'); END;

CREATE TRIGGER history_source_eviction_receipts_no_delete
BEFORE DELETE ON history_source_eviction_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_SOURCE_EVICTION_RECEIPT'); END;

-- Replace blanket source-delete guards with capability-aware guards. A
-- capability can exist only inside the same successful D1 batch as its receipt.
DROP TRIGGER attendance_no_delete;
CREATE TRIGGER attendance_no_delete BEFORE DELETE ON attendance_events
WHEN NOT EXISTS(
  SELECT 1 FROM history_source_eviction_capabilities c
  WHERE c.visit_id=OLD.visit_id AND EXISTS(
    SELECT 1 FROM json_each(c.source_closure_json,'$.events') x
    WHERE json_extract(x.value,'$.id')=OLD.id
  )
)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ATTENDANCE'); END;

DROP TRIGGER correction_no_delete;
CREATE TRIGGER correction_no_delete BEFORE DELETE ON attendance_corrections
WHEN NOT EXISTS(
  SELECT 1 FROM history_source_eviction_capabilities c
  WHERE c.visit_id=OLD.visit_id AND EXISTS(
    SELECT 1 FROM json_each(c.source_closure_json,'$.corrections') x
    WHERE json_extract(x.value,'$.id')=OLD.id
  )
)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_CORRECTION'); END;

DROP TRIGGER audit_no_delete;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries
WHEN NOT EXISTS(
  SELECT 1 FROM history_source_eviction_capabilities c
  WHERE EXISTS(
    SELECT 1 FROM json_each(c.source_closure_json,'$.audits') x
    WHERE json_extract(x.value,'$.id')=OLD.id
  )
)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_AUDIT'); END;

CREATE TRIGGER history_review_no_delete BEFORE DELETE ON reviews
WHEN NOT EXISTS(
  SELECT 1 FROM history_source_eviction_capabilities c
  WHERE c.visit_id=OLD.visit_id AND EXISTS(
    SELECT 1 FROM json_each(c.source_closure_json,'$.reviews') x
    WHERE json_extract(x.value,'$.id')=OLD.id
  )
)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_REVIEW'); END;

CREATE TRIGGER history_archive_hold_no_delete BEFORE DELETE ON archive_holds
WHEN NOT EXISTS(
  SELECT 1 FROM history_source_eviction_capabilities c WHERE c.visit_id=OLD.visit_id
)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_HOLD'); END;

DROP TRIGGER history_visit_no_delete;
CREATE TRIGGER history_visit_no_delete BEFORE DELETE ON visits
WHEN NOT EXISTS(
  SELECT 1 FROM history_source_eviction_capabilities c
  WHERE c.visit_id=OLD.id AND json_extract(c.source_closure_json,'$.visit.id')=OLD.id
)
BEGIN SELECT RAISE(ABORT,'HISTORY_EVICTION_DISABLED'); END;

-- Backup write barriers cover every new durable or transaction-local table.
CREATE TRIGGER backup_lock_history_evidence_expiry_schedules_insert BEFORE INSERT ON history_evidence_expiry_schedules WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_evidence_expiry_schedules_update BEFORE UPDATE ON history_evidence_expiry_schedules WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_evidence_expiry_schedules_delete BEFORE DELETE ON history_evidence_expiry_schedules WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_revisions_insert BEFORE INSERT ON history_source_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_revisions_update BEFORE UPDATE ON history_source_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_revisions_delete BEFORE DELETE ON history_source_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_policies_insert BEFORE INSERT ON history_source_eviction_policies WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_policies_update BEFORE UPDATE ON history_source_eviction_policies WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_policies_delete BEFORE DELETE ON history_source_eviction_policies WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_policy_revisions_insert BEFORE INSERT ON history_source_eviction_policy_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_policy_revisions_update BEFORE UPDATE ON history_source_eviction_policy_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_policy_revisions_delete BEFORE DELETE ON history_source_eviction_policy_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_capabilities_insert BEFORE INSERT ON history_source_eviction_capabilities WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_capabilities_update BEFORE UPDATE ON history_source_eviction_capabilities WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_capabilities_delete BEFORE DELETE ON history_source_eviction_capabilities WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_receipts_insert BEFORE INSERT ON history_source_eviction_receipts WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_receipts_update BEFORE UPDATE ON history_source_eviction_receipts WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_source_eviction_receipts_delete BEFORE DELETE ON history_source_eviction_receipts WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(36);
