ALTER TABLE centers ADD COLUMN location TEXT NOT NULL DEFAULT '' CHECK(length(location)<=300);
ALTER TABLE centers ADD COLUMN operating_hours TEXT NOT NULL DEFAULT '' CHECK(length(operating_hours)<=500);
INSERT INTO schema_versions(version) VALUES(14);
