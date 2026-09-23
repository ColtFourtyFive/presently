-- Keep failed-delivery attempts durable so a transient alert endpoint outage
-- does not silently end notification after the first request.
ALTER TABLE backup_jobs ADD COLUMN alert_attempted_at TEXT;

INSERT INTO schema_versions(version) VALUES(41);
