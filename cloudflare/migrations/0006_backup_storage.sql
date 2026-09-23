-- Existing jobs belong to Google Drive. New jobs record their chosen provider
-- explicitly, so changing installation configuration cannot redirect a retry.
ALTER TABLE backup_jobs ADD COLUMN storage_provider TEXT NOT NULL DEFAULT 'google-drive' CHECK(storage_provider IN ('r2','google-drive'));
INSERT INTO schema_versions(version) VALUES(6);
