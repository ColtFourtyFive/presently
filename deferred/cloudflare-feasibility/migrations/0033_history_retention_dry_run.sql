-- Retention planning is deliberately non-destructive.  This migration adds
-- durable holds, immutable dry-run receipts, and exact source snapshots.  No
-- trigger in this migration permits deletion of attendance evidence or R2 data.

CREATE TABLE history_holds (
  hold_id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers(id),
  target_kind TEXT NOT NULL CHECK(target_kind IN ('student','visit')),
  student_id TEXT NOT NULL,
  visit_id TEXT,
  target_head_version INTEGER,
  target_original_check_in_at TEXT,
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 5 AND 2000),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  source_schema INTEGER NOT NULL DEFAULT 2 CHECK(source_schema IN (1,2)),
  CHECK(
    (target_kind='student' AND visit_id IS NULL AND target_head_version IS NULL AND target_original_check_in_at IS NULL)
    OR
    (target_kind='visit' AND visit_id IS NOT NULL AND (source_schema=1 OR (target_head_version>=1 AND target_original_check_in_at IS NOT NULL)))
  )
) WITHOUT ROWID;

CREATE TABLE history_hold_releases (
  hold_id TEXT PRIMARY KEY REFERENCES history_holds(hold_id),
  released_at TEXT NOT NULL,
  released_by TEXT NOT NULL,
  release_reason TEXT NOT NULL CHECK(length(release_reason) BETWEEN 5 AND 2000)
) WITHOUT ROWID;

CREATE INDEX history_holds_center_student
  ON history_holds(center_id,student_id,created_at,hold_id);
CREATE INDEX history_holds_center_visit
  ON history_holds(center_id,visit_id,created_at,hold_id)
  WHERE visit_id IS NOT NULL;

-- Preserve every legacy hold and release as immutable v2 evidence.  The old
-- table remains in backups for compatibility, but new application writes use
-- history_holds/history_hold_releases.
INSERT INTO history_holds(
  hold_id,center_id,target_kind,student_id,visit_id,target_head_version,
  target_original_check_in_at,reason,created_at,created_by,source_schema
)
SELECT h.id,h.center_id,CASE WHEN h.visit_id IS NULL THEN 'student' ELSE 'visit' END,
       coalesce(h.student_id,vh.student_id,v.student_id),h.visit_id,
       CASE WHEN h.visit_id IS NULL THEN NULL ELSE coalesce(vh.version,v.version) END,
       CASE WHEN h.visit_id IS NULL THEN NULL ELSE coalesce(vh.original_check_in_at,v.original_check_in_at) END,
       h.reason,h.created_at,h.created_by,1
FROM archive_holds h
LEFT JOIN history_visit_heads vh ON vh.visit_id=h.visit_id AND vh.center_id=h.center_id
LEFT JOIN visits v ON v.id=h.visit_id AND v.center_id=h.center_id
WHERE coalesce(h.student_id,vh.student_id,v.student_id) IS NOT NULL;

INSERT INTO history_hold_releases(hold_id,released_at,released_by,release_reason)
SELECT id,released_at,released_by,release_reason
FROM archive_holds
WHERE released_at IS NOT NULL AND released_by IS NOT NULL
  AND release_reason IS NOT NULL
  AND EXISTS(SELECT 1 FROM history_holds h WHERE h.hold_id=archive_holds.id);

CREATE TRIGGER history_holds_target_guard
BEFORE INSERT ON history_holds
WHEN (NEW.target_kind='student' AND NOT EXISTS(
        SELECT 1 FROM students s WHERE s.id=NEW.student_id AND s.center_id=NEW.center_id
      ))
  OR (NEW.target_kind='visit' AND NOT EXISTS(
        SELECT 1 FROM history_visit_heads h
        WHERE h.visit_id=NEW.visit_id AND h.center_id=NEW.center_id
          AND h.student_id=NEW.student_id
          AND (NEW.source_schema=1 OR (
            h.version=NEW.target_head_version
            AND h.original_check_in_at=NEW.target_original_check_in_at
          ))
      ))
BEGIN SELECT RAISE(ABORT,'HOLD_TARGET_NOT_FOUND'); END;

CREATE TRIGGER history_holds_duplicate_guard
BEFORE INSERT ON history_holds
WHEN EXISTS(
  SELECT 1 FROM history_holds h
  WHERE h.center_id=NEW.center_id
    AND h.target_kind=NEW.target_kind
    AND h.student_id=NEW.student_id
    AND h.visit_id IS NEW.visit_id
    AND NOT EXISTS(SELECT 1 FROM history_hold_releases r WHERE r.hold_id=h.hold_id)
)
BEGIN SELECT RAISE(ABORT,'HOLD_ALREADY_ACTIVE'); END;

CREATE TRIGGER history_holds_no_update
BEFORE UPDATE ON history_holds
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_HOLD'); END;
CREATE TRIGGER history_holds_no_delete
BEFORE DELETE ON history_holds
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_HOLD'); END;
CREATE TRIGGER history_hold_releases_no_update
BEFORE UPDATE ON history_hold_releases
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_HOLD_RELEASE'); END;
CREATE TRIGGER history_hold_releases_no_delete
BEFORE DELETE ON history_hold_releases
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_HISTORY_HOLD_RELEASE'); END;
CREATE TRIGGER history_hold_release_single_guard
BEFORE INSERT ON history_hold_releases
WHEN EXISTS(SELECT 1 FROM history_hold_releases WHERE hold_id=NEW.hold_id)
BEGIN SELECT RAISE(ABORT,'HOLD_ALREADY_RELEASED'); END;

-- Mirror old-worker writes during a rolling code deployment.  New workers no
-- longer write archive_holds.
CREATE TRIGGER archive_holds_history_mirror_visit
AFTER INSERT ON archive_holds
WHEN NEW.visit_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO history_holds(
    hold_id,center_id,target_kind,student_id,visit_id,target_head_version,
    target_original_check_in_at,reason,created_at,created_by,source_schema
  )
  SELECT NEW.id,NEW.center_id,'visit',coalesce(NEW.student_id,h.student_id),NEW.visit_id,
         h.version,h.original_check_in_at,NEW.reason,NEW.created_at,NEW.created_by,1
  FROM history_visit_heads h
  WHERE h.visit_id=NEW.visit_id AND h.center_id=NEW.center_id
    AND NOT EXISTS(SELECT 1 FROM history_holds x WHERE x.hold_id=NEW.id);
END;

CREATE TRIGGER archive_holds_history_mirror_student
AFTER INSERT ON archive_holds
WHEN NEW.visit_id IS NULL AND NEW.student_id IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO history_holds(
    hold_id,center_id,target_kind,student_id,visit_id,target_head_version,
    target_original_check_in_at,reason,created_at,created_by,source_schema
  )
  SELECT NEW.id,NEW.center_id,'student',NEW.student_id,NULL,NULL,NULL,
         NEW.reason,NEW.created_at,NEW.created_by,1
  WHERE NOT EXISTS(SELECT 1 FROM history_holds x WHERE x.hold_id=NEW.id);
END;

CREATE TRIGGER archive_holds_history_mirror_release
AFTER UPDATE OF released_at ON archive_holds
WHEN OLD.released_at IS NULL AND NEW.released_at IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO history_hold_releases(hold_id,released_at,released_by,release_reason)
  SELECT NEW.id,NEW.released_at,NEW.released_by,NEW.release_reason
  WHERE NEW.released_by IS NOT NULL AND NEW.release_reason IS NOT NULL
    AND EXISTS(SELECT 1 FROM history_holds h WHERE h.hold_id=NEW.id)
    AND NOT EXISTS(SELECT 1 FROM history_hold_releases r WHERE r.hold_id=NEW.id);
END;

-- Keep the schema-8 live-source selector compatible during rollout.  A visit
-- hold is mirrored only while its live visit still exists; the durable v2 hold
-- remains valid after that source is eventually evicted.
CREATE TRIGGER history_holds_legacy_mirror_insert
AFTER INSERT ON history_holds
WHEN NEW.source_schema=2
BEGIN
  INSERT OR IGNORE INTO archive_holds(
    id,center_id,student_id,visit_id,reason,created_at,created_by
  )
  SELECT NEW.hold_id,NEW.center_id,NEW.student_id,NEW.visit_id,NEW.reason,NEW.created_at,NEW.created_by
  WHERE NEW.target_kind='student'
     OR EXISTS(SELECT 1 FROM visits v WHERE v.id=NEW.visit_id AND v.center_id=NEW.center_id);
END;

CREATE TRIGGER history_hold_releases_legacy_mirror_insert
AFTER INSERT ON history_hold_releases
BEGIN
  UPDATE archive_holds
  SET released_at=NEW.released_at,released_by=NEW.released_by,release_reason=NEW.release_reason
  WHERE id=NEW.hold_id AND released_at IS NULL;
END;

CREATE TABLE history_retention_policies (
  center_id TEXT PRIMARY KEY REFERENCES centers(id),
  live_tier_days INTEGER NOT NULL DEFAULT 90 CHECK(live_tier_days BETWEEN 90 AND 3650),
  evidence_retention_days INTEGER NOT NULL DEFAULT 730 CHECK(evidence_retention_days>=730),
  evidence_expiry_enabled INTEGER NOT NULL DEFAULT 0 CHECK(evidence_expiry_enabled IN (0,1)),
  max_candidates INTEGER NOT NULL DEFAULT 25 CHECK(max_candidates BETWEEN 1 AND 100),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>=1),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE history_retention_policy_revisions (
  center_id TEXT NOT NULL REFERENCES centers(id),
  revision INTEGER NOT NULL,
  live_tier_days INTEGER NOT NULL,
  evidence_retention_days INTEGER NOT NULL,
  evidence_expiry_enabled INTEGER NOT NULL,
  max_candidates INTEGER NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY(center_id,revision)
) WITHOUT ROWID;

INSERT INTO history_retention_policies(center_id,updated_at,updated_by)
SELECT id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'schema-33-default' FROM centers;
INSERT INTO history_retention_policy_revisions
SELECT center_id,revision,live_tier_days,evidence_retention_days,evidence_expiry_enabled,
       max_candidates,updated_at,updated_by
FROM history_retention_policies;

CREATE TRIGGER history_retention_policy_seed
AFTER INSERT ON centers
BEGIN
  INSERT INTO history_retention_policies(center_id,updated_at,updated_by)
  VALUES(NEW.id,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'schema-33-default');
  INSERT INTO history_retention_policy_revisions
  VALUES(NEW.id,1,90,730,0,25,strftime('%Y-%m-%dT%H:%M:%fZ','now'),'schema-33-default');
END;

CREATE TRIGGER history_retention_policy_update_guard
BEFORE UPDATE ON history_retention_policies
WHEN NEW.center_id IS NOT OLD.center_id
  OR NEW.revision!=OLD.revision+1
  OR NEW.evidence_retention_days<730
  OR NEW.live_tier_days<90
  OR NEW.updated_at<=OLD.updated_at
BEGIN SELECT RAISE(ABORT,'RETENTION_POLICY_INVALID'); END;
CREATE TRIGGER history_retention_policy_capture
AFTER UPDATE ON history_retention_policies
BEGIN
  INSERT INTO history_retention_policy_revisions
  VALUES(NEW.center_id,NEW.revision,NEW.live_tier_days,NEW.evidence_retention_days,
         NEW.evidence_expiry_enabled,NEW.max_candidates,NEW.updated_at,NEW.updated_by);
END;
CREATE TRIGGER history_retention_policy_no_delete
BEFORE DELETE ON history_retention_policies
BEGIN SELECT RAISE(ABORT,'RETENTION_POLICY_REQUIRED'); END;
CREATE TRIGGER history_retention_policy_revisions_no_update
BEFORE UPDATE ON history_retention_policy_revisions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_POLICY'); END;
CREATE TRIGGER history_retention_policy_revisions_no_delete
BEFORE DELETE ON history_retention_policy_revisions
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_POLICY'); END;

CREATE TABLE history_retention_jobs (
  job_id TEXT PRIMARY KEY,
  center_id TEXT NOT NULL REFERENCES centers(id),
  generation TEXT NOT NULL,
  policy_revision INTEGER NOT NULL,
  live_tier_days INTEGER NOT NULL,
  evidence_retention_days INTEGER NOT NULL,
  evidence_expiry_enabled INTEGER NOT NULL CHECK(evidence_expiry_enabled IN (0,1)),
  live_cutoff TEXT NOT NULL,
  evidence_cutoff TEXT NOT NULL,
  candidate_limit INTEGER NOT NULL CHECK(candidate_limit BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK(status IN ('planning','complete','blocked','invalid')),
  cursor_time TEXT NOT NULL DEFAULT '',
  cursor_visit_id TEXT NOT NULL DEFAULT '',
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count>=0),
  blocked_count INTEGER NOT NULL DEFAULT 0 CHECK(blocked_count>=0),
  authority_digest TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  lease_token TEXT,
  lease_expires_at TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  error_code TEXT,
  CHECK((status='planning' AND completed_at IS NULL) OR status!='planning'),
  CHECK(candidate_count<=candidate_limit)
) WITHOUT ROWID;
CREATE UNIQUE INDEX history_retention_one_planning_center
  ON history_retention_jobs(center_id) WHERE status='planning';
CREATE INDEX history_retention_jobs_center_created
  ON history_retention_jobs(center_id,created_at DESC,job_id);

CREATE TABLE history_retention_items (
  job_id TEXT NOT NULL REFERENCES history_retention_jobs(job_id),
  sequence INTEGER NOT NULL CHECK(sequence>=1),
  visit_id TEXT NOT NULL,
  student_id TEXT NOT NULL,
  original_check_in_at TEXT NOT NULL,
  effective_check_out_at TEXT NOT NULL,
  head_version INTEGER NOT NULL CHECK(head_version>=1),
  head_residency TEXT NOT NULL,
  source_closure_json TEXT NOT NULL CHECK(json_valid(source_closure_json)),
  source_closure_sha256 TEXT NOT NULL CHECK(length(source_closure_sha256)=44),
  base_publication_id TEXT NOT NULL,
  base_manifest_sha256 TEXT NOT NULL CHECK(length(base_manifest_sha256)=64),
  addendum_authority_json TEXT NOT NULL CHECK(json_valid(addendum_authority_json)),
  addendum_authority_sha256 TEXT NOT NULL CHECK(length(addendum_authority_sha256)=44),
  evidence_closure_sha256 TEXT NOT NULL CHECK(length(evidence_closure_sha256)=44),
  verified_at TEXT NOT NULL,
  PRIMARY KEY(job_id,sequence),
  UNIQUE(job_id,visit_id)
) WITHOUT ROWID;
CREATE INDEX history_retention_items_visit ON history_retention_items(visit_id,job_id);

CREATE TABLE history_retention_invalidations (
  job_id TEXT NOT NULL REFERENCES history_retention_jobs(job_id),
  visit_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY(job_id,visit_id,reason)
) WITHOUT ROWID;

-- A completed dry run emits a durable receipt whose schema makes deletion
-- authority impossible.  Future guarded eviction must use a separate migration
-- and a transaction-local capability; no current delete trigger reads this.
CREATE TABLE history_retention_permits (
  permit_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES history_retention_jobs(job_id),
  mode TEXT NOT NULL CHECK(mode='dry_run'),
  delete_enabled INTEGER NOT NULL CHECK(delete_enabled=0),
  candidate_count INTEGER NOT NULL,
  authority_digest TEXT NOT NULL CHECK(length(authority_digest)=44),
  issued_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER history_retention_items_no_update
BEFORE UPDATE ON history_retention_items
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_ITEM'); END;
CREATE TRIGGER history_retention_items_no_delete
BEFORE DELETE ON history_retention_items
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_ITEM'); END;
CREATE TRIGGER history_retention_invalidations_no_update
BEFORE UPDATE ON history_retention_invalidations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_INVALIDATION'); END;
CREATE TRIGGER history_retention_invalidations_no_delete
BEFORE DELETE ON history_retention_invalidations
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_INVALIDATION'); END;
CREATE TRIGGER history_retention_permits_no_update
BEFORE UPDATE ON history_retention_permits
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_RECEIPT'); END;
CREATE TRIGGER history_retention_permits_no_delete
BEFORE DELETE ON history_retention_permits
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RETENTION_RECEIPT'); END;
CREATE TRIGGER history_retention_permit_guard
BEFORE INSERT ON history_retention_permits
WHEN NEW.mode!='dry_run' OR NEW.delete_enabled!=0
  OR NOT EXISTS(
    SELECT 1 FROM history_retention_jobs j
    WHERE j.job_id=NEW.job_id AND j.status='planning'
      AND j.candidate_count=NEW.candidate_count
      AND NOT EXISTS(SELECT 1 FROM history_retention_invalidations i WHERE i.job_id=j.job_id)
      AND NOT EXISTS(
        SELECT 1 FROM history_retention_items x
        JOIN history_holds h ON h.center_id=j.center_id
          AND (h.visit_id=x.visit_id OR h.student_id=x.student_id)
        WHERE x.job_id=j.job_id
          AND NOT EXISTS(SELECT 1 FROM history_hold_releases r WHERE r.hold_id=h.hold_id)
      )
  )
BEGIN SELECT RAISE(ABORT,'RETENTION_DRY_RUN_STALE'); END;

-- Deterministic current live closure.  Worker hashing covers this exact JSON;
-- the candidate INSERT compares it again after all R2 reads.
CREATE VIEW history_retention_source_closures AS
SELECT v.id AS visit_id,v.center_id,v.student_id,
  json_object(
    'visit',json_object(
      'id',v.id,'center_id',v.center_id,'student_id',v.student_id,
      'check_in_at',v.check_in_at,'check_out_at',v.check_out_at,
      'original_check_in_at',v.original_check_in_at,'original_check_out_at',v.original_check_out_at,
      'check_in_by',v.check_in_by,'check_out_by',v.check_out_by,
      'guardian_id',v.guardian_id,'departure_type',v.departure_type,
      'review_status',v.review_status,'version',v.version
    ),
    'events',json(coalesce((
      SELECT json_group_array(json(row_json)) FROM (
        SELECT json_object(
          'id',e.id,'center_id',e.center_id,'student_id',e.student_id,'visit_id',e.visit_id,
          'action',e.action,'observed_at',e.observed_at,'received_at',e.received_at,
          'actor_id',e.actor_id,'actor_name',e.actor_name,'channel',e.channel,'device_id',e.device_id,
          'guardian_id',e.guardian_id,'reason',e.reason,'payload_hash',e.payload_hash,
          'insertion_nonce',e.insertion_nonce,'result_visit',json(e.result_visit)
        ) AS row_json FROM attendance_events e WHERE e.visit_id=v.id ORDER BY e.id
      )
    ),'[]')),
    'corrections',json(coalesce((
      SELECT json_group_array(json(row_json)) FROM (
        SELECT json_object(
          'id',c.id,'center_id',c.center_id,'visit_id',c.visit_id,
          'expected_version',c.expected_version,'prior_check_in_at',c.prior_check_in_at,
          'prior_check_out_at',c.prior_check_out_at,'check_in_at',c.check_in_at,
          'check_out_at',c.check_out_at,'reason',c.reason,'actor_id',c.actor_id,
          'actor_name',c.actor_name,'recorded_at',c.recorded_at,'payload_hash',c.payload_hash
        ) AS row_json FROM attendance_corrections c WHERE c.visit_id=v.id ORDER BY c.id
      )
    ),'[]')),
    'reviews',json(coalesce((
      SELECT json_group_array(json(row_json)) FROM (
        SELECT json_object(
          'id',r.id,'center_id',r.center_id,'event_id',r.event_id,'visit_id',r.visit_id,
          'student_id',r.student_id,'reason',r.reason,'status',r.status,'created_at',r.created_at,
          'resolved_at',r.resolved_at,'resolved_by',r.resolved_by,'resolution',r.resolution
        ) AS row_json FROM reviews r WHERE r.visit_id=v.id ORDER BY r.id
      )
    ),'[]')),
    'audits',json(coalesce((
      SELECT json_group_array(json(row_json)) FROM (
        SELECT json_object(
          'id',a.id,'center_id',a.center_id,'actor_id',a.actor_id,'actor_name',a.actor_name,
          'action',a.action,'entity_type',a.entity_type,'entity_id',a.entity_id,
          'detail',json(a.detail),'created_at',a.created_at
        ) AS row_json
        FROM audit_timeline a
        WHERE a.center_id=v.center_id AND (
          (a.entity_type='visit' AND a.entity_id=v.id)
          OR (a.entity_type='attendance_event' AND EXISTS(
            SELECT 1 FROM attendance_events e WHERE e.visit_id=v.id AND e.id=a.entity_id
          ))
          OR (a.entity_type='review' AND EXISTS(
            SELECT 1 FROM reviews r WHERE r.visit_id=v.id AND r.id=a.entity_id
          ))
        )
        ORDER BY a.id
      )
    ),'[]')),
    'outbox',json(coalesce((
      SELECT json_group_array(json(row_json)) FROM (
        SELECT json_object(
          'id',o.id,'center_id',o.center_id,'visit_id',o.visit_id,'student_id',o.student_id,
          'expected_version',o.expected_version,'prior_check_in_at',o.prior_check_in_at,
          'prior_check_out_at',o.prior_check_out_at,'check_in_at',o.check_in_at,
          'check_out_at',o.check_out_at,'reason',o.reason,'actor_id',o.actor_id,
          'actor_name',o.actor_name,'recorded_at',o.recorded_at,'payload_hash',o.payload_hash,
          'original_check_in_at',o.original_check_in_at,'original_check_out_at',o.original_check_out_at,
          'check_in_by',o.check_in_by,'check_out_by',o.check_out_by,'guardian_id',o.guardian_id,
          'departure_type',o.departure_type,'review_status',o.review_status,
          'resulting_version',o.resulting_version,'publication_state',o.publication_state
        ) AS row_json FROM history_correction_outbox o WHERE o.visit_id=v.id ORDER BY o.id
      )
    ),'[]'))
  ) AS closure_json
FROM visits v;

-- Backup write barriers for all new durable authority.
CREATE TRIGGER backup_lock_history_holds_insert BEFORE INSERT ON history_holds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_holds_update BEFORE UPDATE ON history_holds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_holds_delete BEFORE DELETE ON history_holds
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_hold_releases_insert BEFORE INSERT ON history_hold_releases
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_hold_releases_update BEFORE UPDATE ON history_hold_releases
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_hold_releases_delete BEFORE DELETE ON history_hold_releases
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

-- The remaining tables use the same lock contract.  Operational job updates
-- also stop during the short backup write barrier.
CREATE TRIGGER backup_lock_history_retention_policies_insert BEFORE INSERT ON history_retention_policies WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_policies_update BEFORE UPDATE ON history_retention_policies WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_policies_delete BEFORE DELETE ON history_retention_policies WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_policy_revisions_insert BEFORE INSERT ON history_retention_policy_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_policy_revisions_update BEFORE UPDATE ON history_retention_policy_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_policy_revisions_delete BEFORE DELETE ON history_retention_policy_revisions WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_jobs_insert BEFORE INSERT ON history_retention_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_jobs_update BEFORE UPDATE ON history_retention_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_jobs_delete BEFORE DELETE ON history_retention_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_items_insert BEFORE INSERT ON history_retention_items WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_items_update BEFORE UPDATE ON history_retention_items WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_items_delete BEFORE DELETE ON history_retention_items WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_invalidations_insert BEFORE INSERT ON history_retention_invalidations WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_invalidations_update BEFORE UPDATE ON history_retention_invalidations WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_invalidations_delete BEFORE DELETE ON history_retention_invalidations WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_permits_insert BEFORE INSERT ON history_retention_permits WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_permits_update BEFORE UPDATE ON history_retention_permits WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_history_retention_permits_delete BEFORE DELETE ON history_retention_permits WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

-- Hold creation is an atomic invalidation event.  A release never schedules or
-- authorizes removal; a future dry run must select the row again.
CREATE TRIGGER history_holds_cancel_work
AFTER INSERT ON history_holds
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations(job_id,visit_id,reason,observed_at)
  SELECT j.job_id,coalesce(NEW.visit_id,'*'),'hold-added',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_jobs j
  WHERE j.center_id=NEW.center_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_HOLD_ADDED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE center_id=NEW.center_id AND status='planning';
  UPDATE archive_jobs
  SET status='cancelled',error_code='ARCHIVE_HOLD_ADDED',lease_token=NULL,lease_until=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE center_id=NEW.center_id AND status IN ('parts','verify');
END;

CREATE TRIGGER history_retention_policy_invalidate
AFTER UPDATE ON history_retention_policies
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations(job_id,visit_id,reason,observed_at)
  SELECT job_id,'*','policy-changed',NEW.updated_at FROM history_retention_jobs
  WHERE center_id=NEW.center_id AND status IN ('planning','complete');
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_POLICY_CHANGED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=NEW.updated_at,revision=revision+1
  WHERE center_id=NEW.center_id AND status='planning';
END;

-- Restore generation changes invalidate unfinished work and every completed
-- receipt remains visibly stale through append-only invalidation evidence.
CREATE TRIGGER history_retention_restore_invalidate
AFTER UPDATE OF generation ON history_runtime
WHEN NEW.generation!=OLD.generation
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations(job_id,visit_id,reason,observed_at)
  SELECT job_id,'*','restore-generation-changed',NEW.updated_at
  FROM history_retention_jobs WHERE status IN ('planning','complete');
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_RESTORE_INVALIDATED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=NEW.updated_at,revision=revision+1
  WHERE status='planning';
END;

-- Direct source or authority changes invalidate a job that already selected the
-- affected visit.  These triggers never remove the selected evidence.
CREATE TRIGGER history_retention_visit_drift AFTER UPDATE ON visits BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,NEW.id,'visit-changed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE i.visit_id=NEW.id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.id);
END;
CREATE TRIGGER history_retention_visit_insert_scan_drift AFTER INSERT ON visits BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT j.job_id,NEW.id,'visit-added-during-scan',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_jobs j WHERE j.center_id=NEW.center_id AND j.status='planning';
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE center_id=NEW.center_id AND status='planning';
END;
CREATE TRIGGER history_retention_visit_update_scan_drift AFTER UPDATE ON visits BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT j.job_id,NEW.id,'visit-changed-during-scan',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_jobs j WHERE j.center_id=NEW.center_id AND j.status='planning';
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE center_id=NEW.center_id AND status='planning';
END;
CREATE TRIGGER history_retention_head_drift AFTER UPDATE ON history_visit_heads BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,NEW.visit_id,'head-changed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_HEAD_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;
CREATE TRIGGER history_retention_event_drift AFTER INSERT ON attendance_events WHEN NEW.visit_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations SELECT i.job_id,NEW.visit_id,'event-added',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;
CREATE TRIGGER history_retention_correction_drift AFTER INSERT ON attendance_corrections BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations SELECT i.job_id,NEW.visit_id,'correction-added',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;
CREATE TRIGGER history_retention_review_insert_drift AFTER INSERT ON reviews WHEN NEW.visit_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations SELECT i.job_id,NEW.visit_id,'review-added',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;
CREATE TRIGGER history_retention_review_update_drift AFTER UPDATE ON reviews WHEN NEW.visit_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations SELECT i.job_id,NEW.visit_id,'review-changed',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;
CREATE TRIGGER history_retention_review_insert_scan_drift AFTER INSERT ON reviews BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT j.job_id,coalesce(NEW.visit_id,'*'),'review-added-during-scan',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_jobs j WHERE j.center_id=NEW.center_id AND j.status='planning';
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE center_id=NEW.center_id AND status='planning';
END;
CREATE TRIGGER history_retention_review_update_scan_drift AFTER UPDATE ON reviews BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT j.job_id,coalesce(NEW.visit_id,'*'),'review-changed-during-scan',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_jobs j WHERE j.center_id=NEW.center_id AND j.status='planning';
  UPDATE history_retention_jobs
  SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE center_id=NEW.center_id AND status='planning';
END;
CREATE TRIGGER history_retention_audit_drift AFTER INSERT ON audit_entries BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,i.visit_id,'audit-added',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE j.status IN ('planning','complete') AND NEW.center_id=j.center_id AND (
    (NEW.entity_type='visit' AND NEW.entity_id=i.visit_id)
    OR (NEW.entity_type='attendance_event' AND EXISTS(SELECT 1 FROM attendance_events e WHERE e.id=NEW.entity_id AND e.visit_id=i.visit_id))
    OR (NEW.entity_type='review' AND EXISTS(SELECT 1 FROM reviews r WHERE r.id=NEW.entity_id AND r.visit_id=i.visit_id))
  );
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_invalidations WHERE reason='audit-added' AND observed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER history_retention_outbox_insert_drift AFTER INSERT ON history_correction_outbox BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations SELECT i.job_id,NEW.visit_id,'outbox-added',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;
CREATE TRIGGER history_retention_outbox_update_drift AFTER UPDATE ON history_correction_outbox BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations SELECT i.job_id,NEW.visit_id,'outbox-changed',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_SOURCE_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1 WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;

CREATE TRIGGER history_retention_publication_availability_drift
AFTER UPDATE ON archive_publication_availability
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,i.visit_id,'base-publication-changed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE i.base_publication_id=NEW.publication_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_PUBLICATION_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE base_publication_id=NEW.publication_id);
END;
CREATE TRIGGER history_retention_addendum_insert_drift
AFTER INSERT ON archive_correction_addendum_publications
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,NEW.visit_id,'addendum-added',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM history_retention_items i JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE i.visit_id=NEW.visit_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_ADDENDUM_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (SELECT job_id FROM history_retention_items WHERE visit_id=NEW.visit_id);
END;
CREATE TRIGGER history_retention_addendum_availability_drift
AFTER UPDATE ON archive_correction_addendum_availability
BEGIN
  INSERT OR IGNORE INTO history_retention_invalidations
  SELECT i.job_id,p.visit_id,'addendum-availability-changed',strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM archive_correction_addendum_publications p
  JOIN history_retention_items i ON i.visit_id=p.visit_id
  JOIN history_retention_jobs j ON j.job_id=i.job_id
  WHERE p.publication_id=NEW.publication_id AND j.status IN ('planning','complete');
  UPDATE history_retention_jobs SET status='invalid',error_code='RETENTION_ADDENDUM_CHANGED',lease_token=NULL,lease_expires_at=NULL,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),revision=revision+1
  WHERE status='planning' AND job_id IN (
    SELECT i.job_id FROM archive_correction_addendum_publications p
    JOIN history_retention_items i ON i.visit_id=p.visit_id
    WHERE p.publication_id=NEW.publication_id
  );
END;

INSERT INTO schema_versions(version) VALUES(33);
