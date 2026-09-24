ALTER TABLE backup_runtime ADD COLUMN backup_monitor_started_at TEXT;
ALTER TABLE backup_runtime ADD COLUMN stale_alert_key TEXT;
ALTER TABLE backup_runtime ADD COLUMN stale_alert_attempted_at TEXT;
ALTER TABLE backup_runtime ADD COLUMN stale_alert_delivered_at TEXT;

INSERT INTO schema_versions(version) VALUES(38);
