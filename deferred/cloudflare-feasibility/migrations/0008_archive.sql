-- Archive copies are published only after R2 readback verification. This migration
-- deliberately leaves the immutable attendance deletion guards in place.
ALTER TABLE backup_jobs ADD COLUMN archives_json TEXT NOT NULL DEFAULT '[]';
CREATE TABLE archive_jobs (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), month TEXT NOT NULL,
 timezone TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL, cutoff TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES staff(id),
 schema_json TEXT NOT NULL, application_version TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('parts','verify','complete','failed','cancelled')),
 source_expires_at TEXT NOT NULL, next_part INTEGER NOT NULL DEFAULT 0,
 cursor_table INTEGER NOT NULL DEFAULT 0, cursor_key TEXT NOT NULL DEFAULT '',
 verify_part INTEGER NOT NULL DEFAULT 0, manifest_key TEXT, manifest_sha256 TEXT,
 manifest_json TEXT, completed_at TEXT, error_code TEXT,
 lease_token TEXT, lease_until TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX archive_one_active_center ON archive_jobs(center_id) WHERE status IN ('parts','verify');
CREATE UNIQUE INDEX archive_one_completed_month ON archive_jobs(center_id,month) WHERE status='complete';
CREATE INDEX archive_jobs_month ON archive_jobs(center_id,month,created_at);
CREATE TABLE archive_members (
 job_id TEXT NOT NULL REFERENCES archive_jobs(id), table_name TEXT NOT NULL,
 record_key TEXT NOT NULL, row_json TEXT, content_sha256 TEXT, part_index INTEGER,
 PRIMARY KEY(job_id,table_name,record_key)
);
CREATE INDEX archive_members_source ON archive_members(table_name,record_key,job_id);
CREATE TABLE archive_parts (
 job_id TEXT NOT NULL REFERENCES archive_jobs(id), part_index INTEGER NOT NULL,
 descriptor_json TEXT NOT NULL, verified_at TEXT,
 PRIMARY KEY(job_id,part_index)
);
CREATE TABLE archive_holds (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id),
 student_id TEXT REFERENCES students(id), visit_id TEXT REFERENCES visits(id),
 reason TEXT NOT NULL, created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES staff(id),
 released_at TEXT, released_by TEXT REFERENCES staff(id), release_reason TEXT,
 CHECK(student_id IS NOT NULL OR visit_id IS NOT NULL)
);
CREATE INDEX archive_holds_active ON archive_holds(center_id,student_id,visit_id) WHERE released_at IS NULL;

-- A source snapshot freezes only its selected historical rows. New attendance
-- and current profiles remain usable. Expired/failed/cancelled jobs release it.
CREATE TRIGGER archive_visit_update BEFORE UPDATE ON visits WHEN EXISTS(
 SELECT 1 FROM archive_members m JOIN archive_jobs j ON j.id=m.job_id
 WHERE m.table_name='visits' AND m.record_key=OLD.id AND j.status IN ('parts','verify')
 AND j.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_BUSY'); END;
CREATE TRIGGER archive_visit_delete BEFORE DELETE ON visits WHEN EXISTS(
 SELECT 1 FROM archive_members m JOIN archive_jobs j ON j.id=m.job_id
 WHERE m.table_name='visits' AND m.record_key=OLD.id AND j.status IN ('parts','verify')
 AND j.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_BUSY'); END;
CREATE TRIGGER archive_review_update BEFORE UPDATE ON reviews WHEN EXISTS(
 SELECT 1 FROM archive_members m JOIN archive_jobs j ON j.id=m.job_id
 WHERE m.table_name='reviews' AND m.record_key=OLD.id AND j.status IN ('parts','verify')
 AND j.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_BUSY'); END;
CREATE TRIGGER archive_review_delete BEFORE DELETE ON reviews WHEN EXISTS(
 SELECT 1 FROM archive_members m JOIN archive_jobs j ON j.id=m.job_id
 WHERE m.table_name='reviews' AND m.record_key=OLD.id AND j.status IN ('parts','verify')
 AND j.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_BUSY'); END;
CREATE TRIGGER archive_event_insert BEFORE INSERT ON attendance_events WHEN NEW.visit_id IS NOT NULL AND EXISTS(
 SELECT 1 FROM archive_members m JOIN archive_jobs j ON j.id=m.job_id
 WHERE m.table_name='visits' AND m.record_key=NEW.visit_id AND j.status IN ('parts','verify')
 AND j.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_BUSY'); END;
-- A legacy event with an unset result_visit can still be sealed by the core
-- schema. Its archived snapshot must be stable during this copy, too.
CREATE TRIGGER archive_event_update BEFORE UPDATE ON attendance_events WHEN EXISTS(
 SELECT 1 FROM archive_members m JOIN archive_jobs j ON j.id=m.job_id
 WHERE m.table_name='attendance_events' AND m.record_key=OLD.id AND j.status IN ('parts','verify')
 AND j.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_BUSY'); END;
CREATE TRIGGER archive_review_insert BEFORE INSERT ON reviews WHEN EXISTS(
 SELECT 1 FROM archive_members m JOIN archive_jobs j ON j.id=m.job_id
 WHERE m.table_name='attendance_events' AND m.record_key=NEW.event_id AND j.status IN ('parts','verify')
 AND j.source_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
) BEGIN SELECT RAISE(ABORT,'ARCHIVE_SOURCE_BUSY'); END;

-- These references must not change while a native SQL backup is taking its
-- snapshot. The runner retries after the short backup lock expires.
CREATE TRIGGER backup_guard_archive_jobs_insert BEFORE INSERT ON archive_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_jobs_update BEFORE UPDATE ON archive_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_jobs_delete BEFORE DELETE ON archive_jobs WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_holds_insert BEFORE INSERT ON archive_holds WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_holds_update BEFORE UPDATE ON archive_holds WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_holds_delete BEFORE DELETE ON archive_holds WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_members_insert BEFORE INSERT ON archive_members WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_members_update BEFORE UPDATE ON archive_members WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_members_delete BEFORE DELETE ON archive_members WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_parts_insert BEFORE INSERT ON archive_parts WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_parts_update BEFORE UPDATE ON archive_parts WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
CREATE TRIGGER backup_guard_archive_parts_delete BEFORE DELETE ON archive_parts WHEN EXISTS(SELECT 1 FROM backup_runtime WHERE id=1 AND write_locked_until>strftime('%Y-%m-%dT%H:%M:%fZ','now')) BEGIN SELECT RAISE(ABORT,'backup_maintenance'); END;
INSERT INTO schema_versions(version) VALUES(8);
