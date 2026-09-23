export const importSchemaStatements = [
`CREATE TABLE IF NOT EXISTS roster_imports (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), source_hash TEXT NOT NULL,
 mapping_hash TEXT NOT NULL, mapping JSONB NOT NULL, preview_token TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES staff(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL, status TEXT NOT NULL CHECK(status IN ('preview','committing','completed','expired')),
 total_rows INTEGER NOT NULL CHECK(total_rows BETWEEN 1 AND 500), UNIQUE(center_id,source_hash,mapping_hash), UNIQUE(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS roster_import_rows (
 import_id TEXT NOT NULL, center_id TEXT NOT NULL, row_number INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('create','update','skip','reject','review')),
 status TEXT NOT NULL CHECK(status IN ('pending','applied','skipped','rejected','review')),
 student_id TEXT NOT NULL, existing_student_id TEXT, guardian_id TEXT, expected_hash TEXT, payload_json JSONB,
 problem TEXT, applied_at TIMESTAMPTZ, PRIMARY KEY(import_id,row_number),
 FOREIGN KEY(center_id,import_id) REFERENCES roster_imports(center_id,id) ON DELETE CASCADE
)`,
`CREATE INDEX IF NOT EXISTS roster_import_center_time ON roster_imports(center_id,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS roster_import_pending ON roster_import_rows(import_id,status,row_number)`,
];
