-- Internal accounting primitives only. No archive work, scheduler or route is wired.
CREATE TABLE archive_budget_runtime (
  id INTEGER PRIMARY KEY CHECK(id=1),
  state TEXT NOT NULL CHECK(state IN ('closed','open')),
  epoch_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  scope_id TEXT,
  current_day TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0),
  close_reason TEXT
);
INSERT INTO archive_budget_runtime(id,state,epoch_id,execution_generation,close_reason)
SELECT 1,'closed',lower(hex(randomblob(16))),generation,'initial' FROM history_runtime WHERE id=1;

CREATE TABLE archive_budget_days (
  utc_day TEXT PRIMARY KEY CHECK(length(utc_day)=10),
  scope_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL UNIQUE,
  execution_generation TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  envelope_version TEXT NOT NULL,
  allocation_sha256 TEXT NOT NULL CHECK(length(allocation_sha256)=64 AND allocation_sha256 NOT GLOB '*[^a-f0-9]*'),
  actor_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE archive_budget_pools (
  utc_day TEXT NOT NULL REFERENCES archive_budget_days(utc_day),
  pool TEXT NOT NULL CHECK(pool IN ('work','cleanup','control')),
  allocated_reads INTEGER NOT NULL CHECK(typeof(allocated_reads)='integer' AND allocated_reads BETWEEN 0 AND 1000000000000),
  allocated_writes INTEGER NOT NULL CHECK(typeof(allocated_writes)='integer' AND allocated_writes BETWEEN 0 AND 1000000000000),
  held_reads INTEGER NOT NULL DEFAULT 0 CHECK(typeof(held_reads)='integer' AND held_reads BETWEEN 0 AND 9007199254740991),
  held_writes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(held_writes)='integer' AND held_writes BETWEEN 0 AND 9007199254740991),
  charged_reads INTEGER NOT NULL DEFAULT 0 CHECK(typeof(charged_reads)='integer' AND charged_reads BETWEEN 0 AND 9007199254740991),
  charged_writes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(charged_writes)='integer' AND charged_writes BETWEEN 0 AND 9007199254740991),
  accounting_saturated INTEGER NOT NULL DEFAULT 0 CHECK(accounting_saturated IN (0,1)),
  PRIMARY KEY(utc_day,pool)
) WITHOUT ROWID;

CREATE TABLE archive_budget_attempts (
  attempt_id TEXT PRIMARY KEY,
  utc_day TEXT NOT NULL REFERENCES archive_budget_days(utc_day),
  epoch_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  pool TEXT NOT NULL CHECK(pool IN ('work','cleanup','control')),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  work_key_sha256 TEXT NOT NULL CHECK(length(work_key_sha256)=64 AND work_key_sha256 NOT GLOB '*[^a-f0-9]*'),
  target_revision INTEGER NOT NULL CHECK(typeof(target_revision)='integer' AND target_revision>=0),
  reads_envelope INTEGER NOT NULL CHECK(typeof(reads_envelope)='integer' AND reads_envelope BETWEEN 0 AND 1000000000000),
  writes_envelope INTEGER NOT NULL CHECK(typeof(writes_envelope)='integer' AND writes_envelope BETWEEN 0 AND 1000000000000),
  overhead_reads INTEGER NOT NULL CHECK(typeof(overhead_reads)='integer' AND overhead_reads BETWEEN 0 AND 1000000000000),
  overhead_writes INTEGER NOT NULL CHECK(typeof(overhead_writes)='integer' AND overhead_writes BETWEEN 0 AND 1000000000000),
  maximum_statements INTEGER NOT NULL CHECK(typeof(maximum_statements)='integer' AND maximum_statements BETWEEN 2 AND 40),
  state TEXT NOT NULL CHECK(state IN ('reserved','executing','settled','unknown')),
  reserved_at TEXT NOT NULL,
  claimed_at TEXT,
  settled_at TEXT,
  execution_token_sha256 TEXT CHECK(execution_token_sha256 IS NULL OR (length(execution_token_sha256)=64 AND execution_token_sha256 NOT GLOB '*[^a-f0-9]*')),
  observed_reads INTEGER NOT NULL DEFAULT 0 CHECK(typeof(observed_reads)='integer' AND observed_reads BETWEEN 0 AND 9007199254740991),
  observed_writes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(observed_writes)='integer' AND observed_writes BETWEEN 0 AND 9007199254740991),
  charge_reads INTEGER NOT NULL DEFAULT 0 CHECK(typeof(charge_reads)='integer' AND charge_reads BETWEEN 0 AND 9007199254740991),
  charge_writes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(charge_writes)='integer' AND charge_writes BETWEEN 0 AND 9007199254740991),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision BETWEEN 0 AND 2),
  settle_operation_id TEXT,
  unknown_reason TEXT
) WITHOUT ROWID;
CREATE INDEX archive_budget_attempts_state_day ON archive_budget_attempts(state,utc_day,attempt_id);

CREATE TABLE archive_budget_receipts (
  operation_id TEXT PRIMARY KEY,
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*'),
  kind TEXT NOT NULL CHECK(kind IN ('open','reserve','claim','settle','abandon','close')),
  attempt_id TEXT,
  utc_day TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=4096),
  created_at TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX archive_budget_receipts_attempt ON archive_budget_receipts(attempt_id,operation_id);

CREATE TRIGGER archive_budget_day_insert_guard BEFORE INSERT ON archive_budget_days
WHEN NEW.utc_day!=strftime('%Y-%m-%d','now') OR NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM archive_budget_runtime b JOIN history_runtime h ON h.id=1 AND h.generation=b.execution_generation
   WHERE b.id=1 AND h.state='ready' AND b.execution_generation=NEW.execution_generation
   AND (b.scope_id IS NULL OR b.scope_id=NEW.scope_id) AND (b.current_day IS NULL OR b.current_day<NEW.utc_day)
   AND (b.close_reason IS NULL OR b.close_reason IN ('initial','operator_closed')))
 OR EXISTS(SELECT 1 FROM archive_budget_attempts WHERE state IN ('reserved','executing','unknown'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_DAY_CLOSED'); END;

CREATE TRIGGER archive_budget_runtime_update_guard BEFORE UPDATE ON archive_budget_runtime
WHEN NEW.id!=OLD.id OR NEW.revision!=OLD.revision+1 OR (OLD.scope_id IS NOT NULL AND NEW.scope_id IS NOT OLD.scope_id)
 OR NOT coalesce((
   (NEW.state='closed' AND NEW.current_day IS OLD.current_day AND NEW.scope_id IS OLD.scope_id
    AND ((NEW.epoch_id=OLD.epoch_id AND NEW.execution_generation=OLD.execution_generation
       AND ((OLD.state='open' AND NEW.close_reason IN ('operator_closed','unknown_usage','overrun','accounting_saturated'))
         OR (OLD.state='closed' AND OLD.close_reason IN ('operator_closed','unknown_usage','overrun','accounting_saturated') AND NEW.close_reason IN ('unknown_usage','overrun','accounting_saturated')
           AND (OLD.close_reason!='overrun' OR NEW.close_reason IN ('overrun','accounting_saturated'))
           AND (OLD.close_reason!='accounting_saturated' OR NEW.close_reason='accounting_saturated'))))
      OR (NEW.epoch_id!=OLD.epoch_id AND NEW.execution_generation!=OLD.execution_generation AND NEW.close_reason='restore_unreconciled'
        AND EXISTS(SELECT 1 FROM history_runtime WHERE id=1 AND generation=NEW.execution_generation))))
   OR (NEW.state='open' AND NEW.close_reason IS NULL AND NEW.epoch_id!=OLD.epoch_id AND NEW.execution_generation=OLD.execution_generation
     AND EXISTS(SELECT 1 FROM archive_budget_days d WHERE d.utc_day=NEW.current_day AND d.epoch_id=NEW.epoch_id
       AND d.execution_generation=NEW.execution_generation AND d.scope_id=NEW.scope_id AND d.utc_day=strftime('%Y-%m-%d','now'))
     AND (SELECT count(*) FROM archive_budget_pools WHERE utc_day=NEW.current_day)=3
     AND (OLD.close_reason IS NULL OR OLD.close_reason IN ('initial','operator_closed'))
     AND (OLD.current_day IS NULL OR OLD.current_day<NEW.current_day)
     AND NOT EXISTS(SELECT 1 FROM archive_budget_attempts WHERE state IN ('reserved','executing','unknown')))
 ),0)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_RUNTIME_INVALID'); END;

CREATE TRIGGER archive_budget_attempt_insert_guard BEFORE INSERT ON archive_budget_attempts
WHEN NEW.state!='reserved' OR NEW.revision!=0 OR NEW.claimed_at IS NOT NULL OR NEW.settled_at IS NOT NULL OR NEW.execution_token_sha256 IS NOT NULL
 OR NEW.observed_reads!=0 OR NEW.observed_writes!=0 OR NEW.charge_reads!=0 OR NEW.charge_writes!=0 OR NEW.settle_operation_id IS NOT NULL OR NEW.unknown_reason IS NOT NULL
 OR NEW.reserved_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
 OR NOT EXISTS(SELECT 1 FROM archive_budget_runtime b JOIN history_runtime h ON h.id=1 AND h.generation=b.execution_generation
   WHERE b.id=1 AND b.state='open' AND h.state='ready' AND b.epoch_id=NEW.epoch_id AND b.execution_generation=NEW.execution_generation
   AND b.current_day=NEW.utc_day AND NEW.utc_day=strftime('%Y-%m-%d','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_RESERVATION_STALE'); END;

CREATE TRIGGER archive_budget_attempt_reserve AFTER INSERT ON archive_budget_attempts
BEGIN
  UPDATE archive_budget_pools SET charged_reads=charged_reads+NEW.overhead_reads,charged_writes=charged_writes+NEW.overhead_writes
  WHERE utc_day=NEW.utc_day AND pool='control'
    AND NEW.overhead_reads<=allocated_reads-held_reads-charged_reads AND NEW.overhead_writes<=allocated_writes-held_writes-charged_writes;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_EXHAUSTED') END;
  UPDATE archive_budget_pools SET held_reads=held_reads+NEW.reads_envelope,held_writes=held_writes+NEW.writes_envelope
  WHERE utc_day=NEW.utc_day AND pool=NEW.pool
    AND NEW.reads_envelope<=allocated_reads-held_reads-charged_reads AND NEW.writes_envelope<=allocated_writes-held_writes-charged_writes;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_BUDGET_EXHAUSTED') END;
END;

CREATE TRIGGER archive_budget_attempt_update_guard BEFORE UPDATE ON archive_budget_attempts
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.utc_day IS NOT OLD.utc_day OR NEW.epoch_id IS NOT OLD.epoch_id
 OR NEW.execution_generation IS NOT OLD.execution_generation OR NEW.pool IS NOT OLD.pool OR NEW.request_sha256 IS NOT OLD.request_sha256
 OR NEW.work_key_sha256 IS NOT OLD.work_key_sha256 OR NEW.target_revision IS NOT OLD.target_revision
 OR NEW.reads_envelope IS NOT OLD.reads_envelope OR NEW.writes_envelope IS NOT OLD.writes_envelope
 OR NEW.overhead_reads IS NOT OLD.overhead_reads OR NEW.overhead_writes IS NOT OLD.overhead_writes
 OR NEW.maximum_statements IS NOT OLD.maximum_statements OR NEW.reserved_at IS NOT OLD.reserved_at OR NEW.revision!=OLD.revision+1
 OR NOT EXISTS(SELECT 1 FROM archive_budget_runtime b JOIN history_runtime h ON h.id=1 AND h.generation=b.execution_generation
   WHERE b.id=1 AND h.state='ready' AND b.epoch_id=NEW.epoch_id AND b.execution_generation=NEW.execution_generation
     AND b.current_day=NEW.utc_day AND NEW.utc_day=strftime('%Y-%m-%d','now'))
 OR NOT coalesce((
   (OLD.state='reserved' AND NEW.state='executing' AND EXISTS(SELECT 1 FROM archive_budget_runtime WHERE id=1 AND state='open')
     AND NEW.execution_token_sha256 IS NOT NULL AND NEW.claimed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     AND NEW.settled_at IS NULL AND NEW.observed_reads=0 AND NEW.observed_writes=0 AND NEW.charge_reads=0 AND NEW.charge_writes=0
     AND NEW.settle_operation_id IS NULL AND NEW.unknown_reason IS NULL)
   OR (OLD.state IN ('reserved','executing') AND NEW.state IN ('settled','unknown') AND NEW.execution_token_sha256 IS NULL
     AND NEW.claimed_at IS OLD.claimed_at AND NEW.settled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND NEW.settle_operation_id IS NOT NULL
     AND ((NEW.state='settled' AND OLD.state='executing' AND NEW.unknown_reason IS NULL AND NEW.charge_reads=NEW.observed_reads AND NEW.charge_writes=NEW.observed_writes)
       OR (NEW.state='unknown' AND NEW.unknown_reason IS NOT NULL AND NEW.charge_reads=max(NEW.reads_envelope,NEW.observed_reads)
         AND NEW.charge_writes=max(NEW.writes_envelope,NEW.observed_writes))))
 ),0)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_ATTEMPT_INVALID'); END;

CREATE TRIGGER archive_budget_attempt_settle AFTER UPDATE ON archive_budget_attempts
WHEN NEW.state IN ('settled','unknown') AND OLD.state IN ('reserved','executing')
BEGIN
  UPDATE archive_budget_pools SET held_reads=held_reads-NEW.reads_envelope,held_writes=held_writes-NEW.writes_envelope,
    accounting_saturated=max(accounting_saturated,NEW.charge_reads>9007199254740991-charged_reads,NEW.charge_writes>9007199254740991-charged_writes),
    charged_reads=min(9007199254740991,charged_reads+NEW.charge_reads),charged_writes=min(9007199254740991,charged_writes+NEW.charge_writes)
  WHERE utc_day=NEW.utc_day AND pool=NEW.pool AND held_reads>=NEW.reads_envelope AND held_writes>=NEW.writes_envelope;
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_BUDGET_ACCOUNTING_INVALID') END;
  UPDATE archive_budget_runtime SET state='closed',close_reason=CASE
    WHEN close_reason='accounting_saturated' OR EXISTS(SELECT 1 FROM archive_budget_pools WHERE utc_day=NEW.utc_day AND pool=NEW.pool AND accounting_saturated=1) THEN 'accounting_saturated'
    WHEN close_reason='overrun' OR NEW.observed_reads>NEW.reads_envelope OR NEW.observed_writes>NEW.writes_envelope THEN 'overrun' ELSE 'unknown_usage' END,revision=revision+1
  WHERE id=1 AND (NEW.state='unknown' OR NEW.observed_reads>NEW.reads_envelope OR NEW.observed_writes>NEW.writes_envelope
    OR EXISTS(SELECT 1 FROM archive_budget_pools WHERE utc_day=NEW.utc_day AND pool=NEW.pool AND accounting_saturated=1));
END;

CREATE TRIGGER archive_budget_pool_identity_guard BEFORE UPDATE ON archive_budget_pools
WHEN NEW.utc_day IS NOT OLD.utc_day OR NEW.pool IS NOT OLD.pool OR NEW.allocated_reads IS NOT OLD.allocated_reads OR NEW.allocated_writes IS NOT OLD.allocated_writes OR NEW.accounting_saturated<OLD.accounting_saturated
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ALLOCATION'); END;

CREATE TRIGGER archive_budget_generation_changed AFTER UPDATE OF generation ON history_runtime
WHEN NEW.generation!=OLD.generation
BEGIN
  UPDATE archive_budget_runtime SET state='closed',epoch_id=lower(hex(randomblob(16))),execution_generation=NEW.generation,
    close_reason='restore_unreconciled',revision=revision+1 WHERE id=1;
END;

CREATE TRIGGER archive_budget_runtime_no_replace BEFORE INSERT ON archive_budget_runtime WHEN EXISTS(SELECT 1 FROM archive_budget_runtime WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_RUNTIME'); END;
CREATE TRIGGER archive_budget_runtime_no_delete BEFORE DELETE ON archive_budget_runtime
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_RUNTIME'); END;
CREATE TRIGGER archive_budget_days_no_replace BEFORE INSERT ON archive_budget_days WHEN EXISTS(SELECT 1 FROM archive_budget_days WHERE utc_day=NEW.utc_day)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;
CREATE TRIGGER archive_budget_days_no_delete BEFORE DELETE ON archive_budget_days
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;
CREATE TRIGGER archive_budget_days_no_update BEFORE UPDATE ON archive_budget_days
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;

CREATE TRIGGER archive_budget_pools_no_replace BEFORE INSERT ON archive_budget_pools WHEN EXISTS(SELECT 1 FROM archive_budget_pools WHERE utc_day=NEW.utc_day AND pool=NEW.pool)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;
CREATE TRIGGER archive_budget_pools_no_delete BEFORE DELETE ON archive_budget_pools
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;

CREATE TRIGGER archive_budget_attempts_no_replace BEFORE INSERT ON archive_budget_attempts WHEN EXISTS(SELECT 1 FROM archive_budget_attempts WHERE attempt_id=NEW.attempt_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;
CREATE TRIGGER archive_budget_attempts_no_delete BEFORE DELETE ON archive_budget_attempts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;

CREATE TRIGGER archive_budget_receipts_no_replace BEFORE INSERT ON archive_budget_receipts WHEN EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;
CREATE TRIGGER archive_budget_receipts_no_delete BEFORE DELETE ON archive_budget_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;
CREATE TRIGGER archive_budget_receipts_no_update BEFORE UPDATE ON archive_budget_receipts
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_ROW'); END;

CREATE TRIGGER backup_lock_archive_budget_runtime_insert BEFORE INSERT ON archive_budget_runtime
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_runtime_update BEFORE UPDATE ON archive_budget_runtime
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_runtime_delete BEFORE DELETE ON archive_budget_runtime
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_days_insert BEFORE INSERT ON archive_budget_days
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_days_update BEFORE UPDATE ON archive_budget_days
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_days_delete BEFORE DELETE ON archive_budget_days
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_pools_insert BEFORE INSERT ON archive_budget_pools
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_pools_update BEFORE UPDATE ON archive_budget_pools
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_pools_delete BEFORE DELETE ON archive_budget_pools
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_attempts_insert BEFORE INSERT ON archive_budget_attempts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_attempts_update BEFORE UPDATE ON archive_budget_attempts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_attempts_delete BEFORE DELETE ON archive_budget_attempts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_receipts_insert BEFORE INSERT ON archive_budget_receipts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_receipts_update BEFORE UPDATE ON archive_budget_receipts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

CREATE TRIGGER backup_lock_archive_budget_receipts_delete BEFORE DELETE ON archive_budget_receipts
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES (23);
