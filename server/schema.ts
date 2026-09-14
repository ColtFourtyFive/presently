export const schemaStatements = [
`CREATE TABLE IF NOT EXISTS centers (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, timezone TEXT NOT NULL,
 location TEXT NOT NULL DEFAULT '', operating_hours TEXT NOT NULL DEFAULT '',
 demo BOOLEAN NOT NULL DEFAULT TRUE, student_sequence INTEGER NOT NULL DEFAULT 0
)`,
`CREATE TABLE IF NOT EXISTS staff (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), name TEXT NOT NULL,
 email TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK (role IN ('owner','manager','front_desk','instructor')),
 password_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE
)`,
`CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, staff_id TEXT NOT NULL REFERENCES staff(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS households (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), name TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS students (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), household_id TEXT REFERENCES households(id),
 student_number TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, grade TEXT NOT NULL DEFAULT '',
 subjects JSONB NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
 pickup_alert TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE (center_id,student_number), UNIQUE (center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS guardians (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), household_id TEXT REFERENCES households(id),
 name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', UNIQUE(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS student_guardians (
 center_id TEXT NOT NULL, student_id TEXT NOT NULL, guardian_id TEXT NOT NULL,
 relationship TEXT NOT NULL DEFAULT 'Parent', can_pickup BOOLEAN NOT NULL DEFAULT TRUE,
 PRIMARY KEY (student_id,guardian_id),
 FOREIGN KEY(center_id,student_id) REFERENCES students(center_id,id),
 FOREIGN KEY(center_id,guardian_id) REFERENCES guardians(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS enrollments (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL, student_id TEXT NOT NULL,
 subject TEXT NOT NULL CHECK(subject IN ('Math','Reading')), status TEXT NOT NULL DEFAULT 'active',
 start_date DATE NOT NULL DEFAULT CURRENT_DATE, end_date DATE,
 FOREIGN KEY(center_id,student_id) REFERENCES students(center_id,id)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS enrollment_one_active_subject ON enrollments(center_id,student_id,subject) WHERE status='active'`,
`CREATE TABLE IF NOT EXISTS schedules (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL, student_id TEXT NOT NULL,
 day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6), start_time TEXT NOT NULL,
 duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 15 AND 180), subject TEXT NOT NULL,
 active BOOLEAN NOT NULL DEFAULT TRUE, FOREIGN KEY(center_id,student_id) REFERENCES students(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS visits (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL, student_id TEXT NOT NULL,
 checked_in_at TIMESTAMPTZ NOT NULL, checked_out_at TIMESTAMPTZ,
 status TEXT NOT NULL CHECK(status IN ('open','closed')), release_basis TEXT,
 reconciliation_status TEXT NOT NULL DEFAULT 'clear',
 FOREIGN KEY(center_id,student_id) REFERENCES students(center_id,id), UNIQUE(center_id,id),
 CHECK(checked_out_at IS NULL OR checked_out_at >= checked_in_at)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS attendance_one_open_visit ON visits(center_id,student_id) WHERE status='open'`,
`CREATE TABLE IF NOT EXISTS attendance_events (
 id TEXT NOT NULL, center_id TEXT NOT NULL, student_id TEXT NOT NULL, visit_id TEXT,
 action TEXT NOT NULL CHECK(action IN ('check_in','check_out','exceptional_departure')),
 occurred_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 actor_id TEXT REFERENCES staff(id), actor_name TEXT NOT NULL, reason TEXT,
 capture_mode TEXT NOT NULL DEFAULT 'staff_online', request_hash TEXT NOT NULL, result_payload JSONB,
 PRIMARY KEY(center_id,id), FOREIGN KEY(center_id,student_id) REFERENCES students(center_id,id),
 FOREIGN KEY(center_id,visit_id) REFERENCES visits(center_id,id)
)`,
`ALTER TABLE attendance_events ADD COLUMN IF NOT EXISTS result_payload JSONB`,
`CREATE TABLE IF NOT EXISTS attendance_corrections (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL, event_id TEXT NOT NULL,
 original_occurred_at TIMESTAMPTZ NOT NULL, corrected_occurred_at TIMESTAMPTZ NOT NULL,
 reason TEXT NOT NULL, actor_id TEXT REFERENCES staff(id), actor_name TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(center_id,event_id) REFERENCES attendance_events(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS inquiries (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), contact_name TEXT NOT NULL,
 student_name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
 subjects JSONB NOT NULL DEFAULT '[]', stage TEXT NOT NULL DEFAULT 'New', source TEXT NOT NULL,
 owner_name TEXT NOT NULL, next_action TEXT NOT NULL DEFAULT '', due_at TIMESTAMPTZ,
 notes TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), converted_student_id TEXT,
 FOREIGN KEY(center_id,converted_student_id) REFERENCES students(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS inquiry_stage_history (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), inquiry_id TEXT NOT NULL REFERENCES inquiries(id),
 from_stage TEXT, to_stage TEXT NOT NULL, actor_id TEXT REFERENCES staff(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
`CREATE TABLE IF NOT EXISTS tasks (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
 due_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ, type TEXT NOT NULL DEFAULT 'follow_up', inquiry_id TEXT REFERENCES inquiries(id)
)`,
`CREATE TABLE IF NOT EXISTS incidents (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL, student_id TEXT NOT NULL, visit_id TEXT,
 type TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), resolved_at TIMESTAMPTZ, resolution_reason TEXT,
 FOREIGN KEY(center_id,student_id) REFERENCES students(center_id,id),
 FOREIGN KEY(center_id,visit_id) REFERENCES visits(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS interactions (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL, student_id TEXT NOT NULL, channel TEXT NOT NULL,
 summary TEXT NOT NULL, actor_id TEXT REFERENCES staff(id), actor_name TEXT NOT NULL,
 occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), FOREIGN KEY(center_id,student_id) REFERENCES students(center_id,id)
)`,
`CREATE TABLE IF NOT EXISTS audit_entries (
 id TEXT PRIMARY KEY, center_id TEXT NOT NULL REFERENCES centers(id), actor_id TEXT REFERENCES staff(id),
 actor_name TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`,
`CREATE INDEX IF NOT EXISTS events_center_time ON attendance_events(center_id,occurred_at DESC)`,
`CREATE INDEX IF NOT EXISTS visits_center_time ON visits(center_id,checked_in_at DESC)`,
`CREATE INDEX IF NOT EXISTS sessions_last_seen ON sessions(last_seen_at)`,
];
