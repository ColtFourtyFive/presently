-- Run ONLY in a freshly restored, isolated database after applying current migrations.
-- Keep the Worker and dispatch disabled while current revocations/holds/deletions
-- and account spending are reconciled. The copied backup lock must be cleared
-- before the maintenance-guarded reset writes; it is not permission to reopen.
-- Schema 38 freshness alert attempts and delivery acknowledgements belong to
-- the source installation. They must not suppress monitoring in the restore.
UPDATE backup_runtime
SET write_locked_until=NULL,
    lock_job_id=NULL,
    backup_monitor_started_at=NULL,
    stale_alert_key=NULL,
    stale_alert_attempted_at=NULL,
    stale_alert_delivered_at=NULL
WHERE id=1;
UPDATE report_runtime SET generation=lower(hex(randomblob(16))) WHERE id=1;
-- Preserve accepted identities, visit heads, and evidence locations. Restart
-- reconciliation under a new generation so pre-restore pages cannot advance it.
-- The budget hook closes archive dispatch and rotates its separate budget epoch.
-- Original days, pool balances, attempts, control liabilities and terminal
-- receipts remain unchanged. Schema 24 pending, unknown and legacy-unresolved
-- control evidence requires reconciliation even when its work already settled.
-- Restored counters cannot establish current account capacity or authorize a refund.
-- Schema 25 also invalidates unfinished publication builds and clears their
-- leases. Committed descriptors, indexes, request claims and original proof
-- generations remain intact; restored publication availability is unavailable
-- until independent object and history reconciliation authorizes it again.
-- Schema 26 invalidates unfinished reconciliation jobs and their leases. Keep
-- completed immutable receipts and availability's previous receipt reference;
-- unavailable status prevents those old receipts from authorizing this restore.
-- Schema 27 pauses unfinished abandonment cleanup, clearing copied leases and
-- selections. Retain its pinned invalid build, original inventory, removed-row
-- accounting and diagnostics. Only explicit resume with fresh inventory can
-- authorize more deletion; resetting access never resumes cleanup itself.
UPDATE history_runtime SET generation=lower(hex(randomblob(16))),state='backfilling',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=1;
-- Schema 36 source-eviction authority never transfers across a restore. A valid
-- backup cannot contain an unreceipted capability because creation and cleanup
-- share one atomic D1 batch. This statement therefore either proves the table is
-- empty (or removes an already receipted remnant) or fails the restore closed.
DELETE FROM history_source_eviction_capabilities;
-- Require a fresh, explicit post-recovery decision before any new live source
-- can be evicted. Preserve the prior policy and append an immutable disabled
-- revision. The timestamp advances monotonically even if the copied value is
-- slightly ahead of the recovery host's clock.
UPDATE history_source_eviction_policies
SET enabled=0,
    revision=revision+1,
    updated_at=CASE
      WHEN updated_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        THEN strftime('%Y-%m-%dT%H:%M:%fZ',updated_at,'+0.001 seconds')
      ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now')
    END,
    updated_by='recovery-access-reset'
WHERE enabled!=0;
-- Schema28's generation hook invalidates unfinished direct compact builds and
-- their copied leases, and revokes compact availability. Immutable descriptors,
-- original proof generations and request mappings remain preserved. This reset
-- grants no compact reconciliation or restored ready authority.
-- Schema29 extends that hook to invalidate unfinished compact reconciliation,
-- clear its copied availability projection, and retain completed receipts only
-- as immutable evidence. Every restored generation still needs a fresh proof
-- and complete two-way compact census before readiness can return.
-- Private staged evidence keeps its original generation. It carries no restored
-- verification success and cannot become published output through this reset.
-- The lifecycle hook clears pause/grace and cleanup leases, including previously
-- invalid sessions. It preserves progress/renewal history and records one retained
-- restore diagnostic per original session identity. Repeated resets add no duplicate.
UPDATE archive_semantic_sessions SET status='invalid',commit_token=NULL,graph_sha256=NULL,cleanup_generation=NULL,cleanup_token=NULL;
-- Completed private runs also lose authority. Preserve immutable snapshot
-- provenance and derived evidence; a restored lease must never resume work.
UPDATE archive_semantic_runs SET status='invalid',lease_token=NULL,lease_expires_at=NULL;
UPDATE history_backfill_jobs SET generation=(SELECT generation FROM history_runtime WHERE id=1),cursor=NULL,processed=0,status='pending',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
-- Disable restored identities before touching optional integration state. Preserve
-- the owner rows for last-owner protection; reapply the current allowlist manually.
UPDATE staff SET email='restored-disabled-'||id||'@invalid.local',kiosk_enabled=0,pin_hash=NULL,pin_salt=NULL,pin_iterations=NULL,session_version=session_version+1;
DELETE FROM kiosk_sessions;
UPDATE kiosk_devices SET revoked_at=coalesce(revoked_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
UPDATE device_enrollments SET consumed_at=coalesce(consumed_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
DELETE FROM pin_throttles;
DELETE FROM backup_google;
DELETE FROM backup_oauth;
UPDATE backup_jobs SET status='failed',signed_url=NULL,lease_until=NULL,lease_token=NULL,error_code='RESTORED_JOB_REQUIRES_REVIEW' WHERE status NOT IN ('complete','failed');
UPDATE backup_jobs SET signed_url=NULL,lease_until=NULL,lease_token=NULL;
UPDATE archive_jobs SET status='cancelled',source_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),lease_until=NULL,lease_token=NULL,error_code='RESTORED_JOB_REQUIRES_REVIEW' WHERE status IN ('parts','verify');
UPDATE archive_jobs SET lease_until=NULL,lease_token=NULL;
UPDATE roster_imports SET status='expired' WHERE status IN ('preview','committing');
UPDATE roster_import_rows SET payload_json=NULL;
INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
SELECT lower(hex(randomblob(16))),id,NULL,'Recovery script','recovery_access_reset','center',id,
 '{"staffAllowlistDisabled":true,"kioskCredentialsRevoked":true,"integrationsDisconnected":true}',
 strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM centers;
