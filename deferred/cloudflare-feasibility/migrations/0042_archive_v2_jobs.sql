-- Bind each archive job to its immutable format and semantic-proof profile.
-- Existing verified copies remain version 1; the opt-in version 2 path does
-- not grant permission to remove source attendance.
ALTER TABLE archive_jobs ADD COLUMN format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version IN (1,2));
ALTER TABLE archive_jobs ADD COLUMN semantic_proof_json TEXT;

INSERT INTO schema_versions(version) VALUES(42);
