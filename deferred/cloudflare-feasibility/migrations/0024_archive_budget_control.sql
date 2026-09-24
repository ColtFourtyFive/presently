-- Durable accounting for the native control prefix and a policy-prepaid closing tail.
-- This migration does not authorize a scheduler, recovery/reconciliation, or day reset.
CREATE TABLE archive_budget_controls (
  attempt_id TEXT PRIMARY KEY REFERENCES archive_budget_attempts(attempt_id),
  utc_day TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  execution_generation TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK(policy_version IN ('archive-control-terminal-v1','legacy23-unreconciled')),
  prepaid_reads INTEGER NOT NULL CHECK(typeof(prepaid_reads)='integer' AND prepaid_reads BETWEEN 0 AND 1000000000000),
  prepaid_writes INTEGER NOT NULL CHECK(typeof(prepaid_writes)='integer' AND prepaid_writes BETWEEN 0 AND 1000000000000),
  tail_reads INTEGER NOT NULL,
  tail_writes INTEGER NOT NULL,
  tail_statements INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','settled','unknown','overrun','legacy_unresolved')),
  observed_prefix_reads INTEGER NOT NULL DEFAULT 0 CHECK(typeof(observed_prefix_reads)='integer' AND observed_prefix_reads BETWEEN 0 AND 9007199254740991),
  observed_prefix_writes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(observed_prefix_writes)='integer' AND observed_prefix_writes BETWEEN 0 AND 9007199254740991),
  prefix_statements INTEGER NOT NULL DEFAULT 0 CHECK(typeof(prefix_statements)='integer' AND prefix_statements BETWEEN 0 AND 9007199254740991),
  prefix_batches INTEGER NOT NULL DEFAULT 0 CHECK(typeof(prefix_batches)='integer' AND prefix_batches BETWEEN 0 AND 9007199254740991),
  prefix_coverage_complete INTEGER NOT NULL DEFAULT 0 CHECK(prefix_coverage_complete IN (0,1)),
  charge_reads INTEGER NOT NULL CHECK(typeof(charge_reads)='integer' AND charge_reads BETWEEN 0 AND 9007199254740991),
  charge_writes INTEGER NOT NULL CHECK(typeof(charge_writes)='integer' AND charge_writes BETWEEN 0 AND 9007199254740991),
  deficit_reads INTEGER NOT NULL DEFAULT 0 CHECK(typeof(deficit_reads)='integer' AND deficit_reads BETWEEN 0 AND 9007199254740991),
  deficit_writes INTEGER NOT NULL DEFAULT 0 CHECK(typeof(deficit_writes)='integer' AND deficit_writes BETWEEN 0 AND 9007199254740991),
  accounting_saturated INTEGER NOT NULL DEFAULT 0 CHECK(accounting_saturated IN (0,1)),
  operation_id TEXT UNIQUE CHECK(operation_id IS NULL OR (length(operation_id) BETWEEN 1 AND 100 AND operation_id NOT GLOB '*[^A-Za-z0-9_-]*')),
  request_sha256 TEXT CHECK(request_sha256 IS NULL OR (length(request_sha256)=64 AND request_sha256 NOT GLOB '*[^a-f0-9]*')),
  result_json TEXT CHECK(result_json IS NULL OR (json_valid(result_json) AND json_type(result_json)='object' AND length(CAST(result_json AS BLOB))<=4096)),
  created_at TEXT NOT NULL,
  terminal_at TEXT,
  CHECK((policy_version='archive-control-terminal-v1' AND tail_reads=64 AND tail_writes=16 AND tail_statements=1 AND prepaid_reads>=64 AND prepaid_writes>=16 AND state!='legacy_unresolved') OR
    (policy_version='legacy23-unreconciled' AND tail_reads=0 AND tail_writes=0 AND tail_statements=0 AND state='legacy_unresolved')),
  CHECK(charge_reads>=prepaid_reads AND charge_writes>=prepaid_writes),
  CHECK((state IN ('pending','legacy_unresolved') AND operation_id IS NULL AND request_sha256 IS NULL AND result_json IS NULL AND terminal_at IS NULL) OR
    (state IN ('settled','unknown','overrun') AND operation_id IS NOT NULL AND request_sha256 IS NOT NULL AND result_json IS NOT NULL AND terminal_at IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX archive_budget_controls_state ON archive_budget_controls(state,attempt_id);

-- Schema23 never observed durable control settlement. Preserve all its charges and
-- receipts; do not infer that an old successful work settlement covered control.
INSERT INTO archive_budget_controls(attempt_id,utc_day,epoch_id,execution_generation,policy_version,prepaid_reads,prepaid_writes,tail_reads,tail_writes,tail_statements,state,charge_reads,charge_writes,created_at)
SELECT attempt_id,utc_day,epoch_id,execution_generation,'legacy23-unreconciled',overhead_reads,overhead_writes,0,0,0,'legacy_unresolved',overhead_reads,overhead_writes,reserved_at
FROM archive_budget_attempts;
UPDATE archive_budget_runtime SET state='closed',close_reason='unknown_usage',revision=revision+1
WHERE id=1 AND state='open' AND EXISTS(SELECT 1 FROM archive_budget_controls);

CREATE TRIGGER archive_budget_control_insert_guard BEFORE INSERT ON archive_budget_controls
WHEN EXISTS(SELECT 1 FROM archive_budget_controls WHERE attempt_id=NEW.attempt_id)
  OR NEW.policy_version!='archive-control-terminal-v1' OR NEW.state!='pending'
  OR NEW.observed_prefix_reads!=0 OR NEW.observed_prefix_writes!=0 OR NEW.prefix_statements!=0 OR NEW.prefix_batches!=0 OR NEW.prefix_coverage_complete!=0
  OR NEW.charge_reads!=NEW.prepaid_reads OR NEW.charge_writes!=NEW.prepaid_writes OR NEW.deficit_reads!=0 OR NEW.deficit_writes!=0 OR NEW.accounting_saturated!=0
  OR NEW.created_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NOT EXISTS(SELECT 1 FROM archive_budget_attempts a JOIN archive_budget_runtime b ON b.id=1 JOIN history_runtime h ON h.id=1
    WHERE a.attempt_id=NEW.attempt_id AND a.state='reserved' AND a.utc_day=NEW.utc_day AND a.epoch_id=NEW.epoch_id AND a.execution_generation=NEW.execution_generation
      AND a.overhead_reads=NEW.prepaid_reads AND a.overhead_writes=NEW.prepaid_writes
      AND b.state='open' AND b.epoch_id=NEW.epoch_id AND b.execution_generation=NEW.execution_generation AND b.current_day=NEW.utc_day
      AND h.state='ready' AND h.generation=NEW.execution_generation AND NEW.utc_day=strftime('%Y-%m-%d','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_INVALID'); END;

CREATE TRIGGER archive_budget_control_reserve_gate BEFORE INSERT ON archive_budget_attempts
WHEN NEW.overhead_reads<64 OR NEW.overhead_writes<16 OR EXISTS(SELECT 1 FROM archive_budget_controls WHERE state IN ('pending','unknown','overrun','legacy_unresolved'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_PENDING'); END;
CREATE TRIGGER archive_budget_control_reserve AFTER INSERT ON archive_budget_attempts
BEGIN
  INSERT INTO archive_budget_controls(attempt_id,utc_day,epoch_id,execution_generation,policy_version,prepaid_reads,prepaid_writes,tail_reads,tail_writes,tail_statements,state,charge_reads,charge_writes,created_at)
  VALUES(NEW.attempt_id,NEW.utc_day,NEW.epoch_id,NEW.execution_generation,'archive-control-terminal-v1',NEW.overhead_reads,NEW.overhead_writes,64,16,1,'pending',NEW.overhead_reads,NEW.overhead_writes,NEW.reserved_at);
END;
CREATE TRIGGER archive_budget_control_claim_gate BEFORE UPDATE OF state ON archive_budget_attempts
WHEN NEW.state='executing' AND (NOT EXISTS(SELECT 1 FROM archive_budget_controls c WHERE c.attempt_id=NEW.attempt_id AND c.state='pending'
    AND c.utc_day=NEW.utc_day AND c.epoch_id=NEW.epoch_id AND c.execution_generation=NEW.execution_generation)
  OR EXISTS(SELECT 1 FROM archive_budget_controls WHERE state IN ('pending','unknown','overrun','legacy_unresolved') AND attempt_id!=NEW.attempt_id))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_PENDING'); END;
CREATE TRIGGER archive_budget_control_day_gate BEFORE INSERT ON archive_budget_days
WHEN EXISTS(SELECT 1 FROM archive_budget_controls WHERE state IN ('pending','unknown','overrun','legacy_unresolved'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_PENDING'); END;
CREATE TRIGGER archive_budget_control_open_gate BEFORE UPDATE ON archive_budget_runtime
WHEN NEW.state='open' AND EXISTS(SELECT 1 FROM archive_budget_controls WHERE state IN ('pending','unknown','overrun','legacy_unresolved'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_PENDING'); END;

CREATE TRIGGER archive_budget_control_update_guard BEFORE UPDATE ON archive_budget_controls
WHEN OLD.state!='pending' OR NEW.state NOT IN ('settled','unknown','overrun')
  OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.utc_day IS NOT OLD.utc_day OR NEW.epoch_id IS NOT OLD.epoch_id OR NEW.execution_generation IS NOT OLD.execution_generation
  OR NEW.policy_version IS NOT OLD.policy_version OR NEW.prepaid_reads IS NOT OLD.prepaid_reads OR NEW.prepaid_writes IS NOT OLD.prepaid_writes
  OR NEW.tail_reads IS NOT OLD.tail_reads OR NEW.tail_writes IS NOT OLD.tail_writes OR NEW.tail_statements IS NOT OLD.tail_statements OR NEW.created_at IS NOT OLD.created_at
  OR NEW.terminal_at!=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  OR NEW.charge_reads!=max(NEW.prepaid_reads,min(9007199254740991,NEW.observed_prefix_reads+NEW.tail_reads))
  OR NEW.charge_writes!=max(NEW.prepaid_writes,min(9007199254740991,NEW.observed_prefix_writes+NEW.tail_writes))
  OR NEW.deficit_reads!=NEW.charge_reads-NEW.prepaid_reads OR NEW.deficit_writes!=NEW.charge_writes-NEW.prepaid_writes
  OR NOT EXISTS(SELECT 1 FROM archive_budget_pools p WHERE p.utc_day=NEW.utc_day AND p.pool='control'
    AND NEW.accounting_saturated=max(p.accounting_saturated,NEW.observed_prefix_reads>9007199254740991-NEW.tail_reads,NEW.observed_prefix_writes>9007199254740991-NEW.tail_writes,
      NEW.deficit_reads>9007199254740991-p.charged_reads,NEW.deficit_writes>9007199254740991-p.charged_writes))
  OR NEW.state!=CASE WHEN NEW.deficit_reads>0 OR NEW.deficit_writes>0 OR NEW.accounting_saturated=1 THEN 'overrun'
      WHEN NEW.prefix_coverage_complete=1 AND EXISTS(SELECT 1 FROM archive_budget_attempts WHERE attempt_id=NEW.attempt_id AND state='settled') THEN 'settled' ELSE 'unknown' END
  OR NEW.result_json!=json_object('attemptId',NEW.attempt_id,'state',NEW.state,
      'observedPrefix',json_object('rowsRead',NEW.observed_prefix_reads,'rowsWritten',NEW.observed_prefix_writes,'statements',NEW.prefix_statements,'batches',NEW.prefix_batches,
        'coverageComplete',json(CASE WHEN NEW.prefix_coverage_complete=1 THEN 'true' ELSE 'false' END)),
      'prepaid',json_object('reads',NEW.prepaid_reads,'writes',NEW.prepaid_writes),
      'prepaidTail',json_object('version',NEW.policy_version,'reads',NEW.tail_reads,'writes',NEW.tail_writes,'statements',NEW.tail_statements),
      'charged',json_object('reads',NEW.charge_reads,'writes',NEW.charge_writes),
      'deficit',json_object('reads',NEW.deficit_reads,'writes',NEW.deficit_writes),'accountingSaturated',json(CASE WHEN NEW.accounting_saturated=1 THEN 'true' ELSE 'false' END))
  OR EXISTS(SELECT 1 FROM archive_budget_receipts WHERE operation_id=NEW.operation_id)
  OR NOT EXISTS(SELECT 1 FROM archive_budget_runtime b JOIN history_runtime h ON h.id=1
    WHERE b.id=1 AND b.epoch_id=NEW.epoch_id AND b.execution_generation=NEW.execution_generation AND b.current_day=NEW.utc_day
      AND h.state='ready' AND h.generation=NEW.execution_generation AND NEW.utc_day=strftime('%Y-%m-%d','now'))
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_INVALID'); END;
CREATE TRIGGER archive_budget_control_terminal AFTER UPDATE ON archive_budget_controls
BEGIN
  UPDATE archive_budget_pools SET accounting_saturated=max(accounting_saturated,NEW.accounting_saturated),
    charged_reads=min(9007199254740991,charged_reads+NEW.deficit_reads),charged_writes=min(9007199254740991,charged_writes+NEW.deficit_writes)
  WHERE utc_day=NEW.utc_day AND pool='control';
  SELECT CASE WHEN changes()!=1 THEN RAISE(ABORT,'ARCHIVE_BUDGET_CONTROL_INVALID') END;
  UPDATE archive_budget_runtime SET state='closed',close_reason=CASE
    WHEN close_reason='accounting_saturated' OR NEW.accounting_saturated=1 THEN 'accounting_saturated'
    WHEN close_reason='overrun' OR NEW.state='overrun' THEN 'overrun' ELSE 'unknown_usage' END,revision=revision+1
  WHERE id=1 AND NEW.state IN ('pending','unknown','overrun','legacy_unresolved');
END;
CREATE TRIGGER archive_budget_control_no_delete BEFORE DELETE ON archive_budget_controls
BEGIN SELECT RAISE(ABORT,'IMMUTABLE_ARCHIVE_BUDGET_CONTROL'); END;
CREATE TRIGGER archive_budget_control_receipt_namespace BEFORE INSERT ON archive_budget_receipts
WHEN EXISTS(SELECT 1 FROM archive_budget_controls WHERE operation_id=NEW.operation_id)
BEGIN SELECT RAISE(ABORT,'ARCHIVE_BUDGET_OPERATION_CONFLICT'); END;
CREATE TRIGGER backup_lock_archive_budget_controls_insert BEFORE INSERT ON archive_budget_controls
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_budget_controls_update BEFORE UPDATE ON archive_budget_controls
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_lock_archive_budget_controls_delete BEFORE DELETE ON archive_budget_controls
WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;

INSERT INTO schema_versions(version) VALUES(24);
