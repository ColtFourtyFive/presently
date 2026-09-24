-- Presently baseline schema.
--
-- One installation serves one franchise business, which may run several
-- locations. Attendance tables use integer keys and epoch-millisecond times to
-- keep each visit small. Attendance observations, corrections and audit entries
-- are append-only; triggers enforce the rules atomically because D1 has no
-- interactive transactions.
--
-- Keep every statement compatible with `wrangler d1 migrations apply`: no
-- PRAGMA statements, and trigger bodies that use only simple statements.

CREATE TABLE business (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  backup_hour INTEGER NOT NULL DEFAULT 2 CHECK (backup_hour BETWEEN 0 AND 23),
  backup_alerted_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  address TEXT NOT NULL DEFAULT '',
  operating_hours TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  roster_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

-- Staff with an email sign in to the back office through Cloudflare Access.
-- Staff without an email use only their kiosk PIN.
CREATE TABLE staff (
  id INTEGER PRIMARY KEY,
  email TEXT UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'front_desk', 'instructor')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  kiosk_enabled INTEGER NOT NULL DEFAULT 0 CHECK (kiosk_enabled IN (0, 1)),
  pin_hash TEXT,
  session_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER staff_keep_last_owner BEFORE UPDATE ON staff
WHEN OLD.role = 'owner' AND OLD.active = 1 AND (NEW.role != 'owner' OR NEW.active = 0)
  AND NOT EXISTS (SELECT 1 FROM staff WHERE id != OLD.id AND role = 'owner' AND active = 1)
BEGIN
  SELECT RAISE(ABORT, 'LAST_OWNER');
END;

CREATE TRIGGER staff_no_delete BEFORE DELETE ON staff
BEGIN
  SELECT RAISE(ABORT, 'STAFF_DELETE_FORBIDDEN');
END;

-- Owners reach every location. Other roles reach only assigned locations.
CREATE TABLE staff_locations (
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  PRIMARY KEY (staff_id, location_id)
) WITHOUT ROWID;

CREATE TABLE device_enrollments (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_by INTEGER NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE kiosk_devices (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  enrollment_id INTEGER NOT NULL UNIQUE REFERENCES device_enrollments(id),
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE kiosk_sessions (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL UNIQUE REFERENCES kiosk_devices(id),
  staff_id INTEGER NOT NULL REFERENCES staff(id),
  token_hash TEXT NOT NULL UNIQUE,
  staff_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE pin_throttles (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_start TEXT NOT NULL,
  locked_until TEXT
) WITHOUT ROWID;

CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  student_code TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  grade TEXT NOT NULL DEFAULT '',
  subjects TEXT NOT NULL DEFAULT '[]',
  pickup_alert TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (location_id, student_code)
);
CREATE INDEX students_name ON students (location_id, last_name, first_name);

-- Guardians belong to the business so siblings at different locations can
-- share a contact. Access to a guardian always goes through a student link.
CREATE TABLE guardians (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  import_ref TEXT UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE student_guardians (
  student_id INTEGER NOT NULL REFERENCES students(id),
  guardian_id INTEGER NOT NULL REFERENCES guardians(id),
  relationship TEXT NOT NULL DEFAULT '',
  pickup_authority TEXT NOT NULL DEFAULT 'unverified' CHECK (pickup_authority IN ('unverified', 'allowed', 'denied')),
  authority_note TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (student_id, guardian_id)
) WITHOUT ROWID;
CREATE INDEX student_guardians_guardian ON student_guardians (guardian_id);

-- A visit's id equals the id of the check-in event that opened it. Original
-- arrival and departure times, staff and guardian live on the events; the
-- visit holds the current (possibly corrected) times.
CREATE TABLE visits (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  check_in_at INTEGER NOT NULL,
  check_out_at INTEGER,
  out_event_id INTEGER,
  departure TEXT CHECK (departure IN ('check_out', 'exceptional_departure')),
  review TEXT NOT NULL DEFAULT 'none' CHECK (review IN ('none', 'pending', 'resolved')),
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (check_out_at IS NULL OR check_out_at >= check_in_at)
);
CREATE UNIQUE INDEX visits_one_open ON visits (student_id) WHERE check_out_at IS NULL;
CREATE INDEX visits_open_location ON visits (location_id, check_in_at) WHERE check_out_at IS NULL;
CREATE INDEX visits_location_time ON visits (location_id, check_in_at);
CREATE INDEX visits_student_time ON visits (student_id, check_in_at);

-- Immutable staff observations. request_id is the client-generated UUID that
-- makes retries safe. visit_id is NULL for a check-in (the visit shares this
-- event's id) and for a departure observed with no open visit.
CREATE TABLE attendance_events (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  visit_id INTEGER REFERENCES visits(id),
  action TEXT NOT NULL CHECK (action IN ('check_in', 'check_out', 'exceptional_departure')),
  observed_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES staff(id),
  device_id INTEGER REFERENCES kiosk_devices(id),
  guardian_id INTEGER REFERENCES guardians(id),
  reason TEXT
);
CREATE INDEX attendance_events_location_time ON attendance_events (location_id, observed_at);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL UNIQUE REFERENCES attendance_events(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  student_id INTEGER NOT NULL REFERENCES students(id),
  visit_id INTEGER REFERENCES visits(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by INTEGER REFERENCES staff(id),
  resolution TEXT
);
CREATE INDEX reviews_pending ON reviews (location_id, created_at) WHERE status = 'pending';

CREATE TRIGGER attendance_validate BEFORE INSERT ON attendance_events
WHEN NOT EXISTS (SELECT 1 FROM attendance_events WHERE request_id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, 'STUDENT_NOT_FOUND')
    WHERE NOT EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND location_id = NEW.location_id);
  SELECT RAISE(ABORT, 'STUDENT_INACTIVE')
    WHERE NEW.action = 'check_in' AND EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND active = 0);
  SELECT RAISE(ABORT, 'ALREADY_PRESENT')
    WHERE NEW.action = 'check_in' AND EXISTS (SELECT 1 FROM visits WHERE student_id = NEW.student_id AND check_out_at IS NULL);
  SELECT RAISE(ABORT, 'NOT_PRESENT')
    WHERE NEW.action = 'check_out' AND NEW.visit_id IS NULL;
  SELECT RAISE(ABORT, 'VISIT_MISMATCH')
    WHERE NEW.visit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM visits WHERE id = NEW.visit_id AND student_id = NEW.student_id AND check_out_at IS NULL);
  SELECT RAISE(ABORT, 'PICKUP_UNVERIFIED')
    WHERE NEW.action = 'check_out' AND NOT EXISTS (
      SELECT 1 FROM student_guardians
      WHERE student_id = NEW.student_id AND guardian_id = NEW.guardian_id AND pickup_authority = 'allowed');
  SELECT RAISE(ABORT, 'PICKUP_ALERT')
    WHERE NEW.action = 'check_out' AND EXISTS (SELECT 1 FROM students WHERE id = NEW.student_id AND pickup_alert != '');
  SELECT RAISE(ABORT, 'REASON_REQUIRED')
    WHERE NEW.action = 'exceptional_departure' AND length(trim(coalesce(NEW.reason, ''))) < 5;
  SELECT RAISE(ABORT, 'DEPARTURE_BEFORE_ARRIVAL')
    WHERE NEW.visit_id IS NOT NULL AND EXISTS (SELECT 1 FROM visits WHERE id = NEW.visit_id AND check_in_at > NEW.observed_at);
  SELECT RAISE(ABORT, 'OVERLAPPING_VISIT')
    WHERE NEW.action = 'check_in' AND EXISTS (
      SELECT 1 FROM visits WHERE student_id = NEW.student_id AND check_out_at > NEW.observed_at);
END;

CREATE TRIGGER attendance_open_visit AFTER INSERT ON attendance_events
WHEN NEW.action = 'check_in'
BEGIN
  INSERT INTO visits (id, location_id, student_id, check_in_at)
  VALUES (NEW.id, NEW.location_id, NEW.student_id, NEW.observed_at);
END;

CREATE TRIGGER attendance_close_visit AFTER INSERT ON attendance_events
WHEN NEW.action != 'check_in' AND NEW.visit_id IS NOT NULL
BEGIN
  UPDATE visits
  SET check_out_at = NEW.observed_at, out_event_id = NEW.id, departure = NEW.action,
      review = iif(NEW.action = 'exceptional_departure', 'pending', 'none'), version = version + 1
  WHERE id = NEW.visit_id;
END;

CREATE TRIGGER attendance_open_review AFTER INSERT ON attendance_events
WHEN NEW.action = 'exceptional_departure'
BEGIN
  INSERT INTO reviews (event_id, location_id, student_id, visit_id, created_at)
  VALUES (NEW.id, NEW.location_id, NEW.student_id, NEW.visit_id, NEW.received_at);
END;

CREATE TRIGGER attendance_roster_version AFTER INSERT ON attendance_events
BEGIN
  UPDATE locations SET roster_version = roster_version + 1 WHERE id = NEW.location_id;
END;

CREATE TRIGGER attendance_no_update BEFORE UPDATE ON attendance_events
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_ATTENDANCE');
END;

CREATE TRIGGER attendance_no_delete BEFORE DELETE ON attendance_events
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_ATTENDANCE');
END;

CREATE TRIGGER visits_no_delete BEFORE DELETE ON visits
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_ATTENDANCE');
END;

-- Immutable manager corrections. The visit keeps the corrected times; the
-- original observations stay on attendance_events.
CREATE TABLE attendance_corrections (
  id INTEGER PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  expected_version INTEGER NOT NULL,
  prior_check_in_at INTEGER NOT NULL,
  prior_check_out_at INTEGER,
  check_in_at INTEGER NOT NULL,
  check_out_at INTEGER,
  reason TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES staff(id),
  recorded_at INTEGER NOT NULL
);
CREATE INDEX attendance_corrections_visit ON attendance_corrections (visit_id);
CREATE INDEX attendance_corrections_time ON attendance_corrections (recorded_at);

CREATE TRIGGER correction_validate BEFORE INSERT ON attendance_corrections
WHEN NOT EXISTS (SELECT 1 FROM attendance_corrections WHERE request_id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, 'STALE_VISIT')
    WHERE NOT EXISTS (SELECT 1 FROM visits WHERE id = NEW.visit_id AND version = NEW.expected_version);
  SELECT RAISE(ABORT, 'DEPARTURE_BEFORE_ARRIVAL')
    WHERE NEW.check_out_at IS NOT NULL AND NEW.check_out_at < NEW.check_in_at;
  SELECT RAISE(ABORT, 'FUTURE_CORRECTION')
    WHERE NEW.check_in_at > NEW.recorded_at OR coalesce(NEW.check_out_at, 0) > NEW.recorded_at;
  SELECT RAISE(ABORT, 'OVERLAPPING_VISIT')
    WHERE EXISTS (
      SELECT 1 FROM visits other JOIN visits current ON current.id = NEW.visit_id
      WHERE other.student_id = current.student_id AND other.id != NEW.visit_id
        AND other.check_in_at < coalesce(NEW.check_out_at, 9007199254740991)
        AND coalesce(other.check_out_at, 9007199254740991) > NEW.check_in_at);
END;

CREATE TRIGGER correction_apply AFTER INSERT ON attendance_corrections
BEGIN
  UPDATE visits
  SET check_in_at = NEW.check_in_at, check_out_at = NEW.check_out_at, version = version + 1
  WHERE id = NEW.visit_id;
  UPDATE locations SET roster_version = roster_version + 1
  WHERE id = (SELECT location_id FROM visits WHERE id = NEW.visit_id);
END;

CREATE TRIGGER correction_no_update BEFORE UPDATE ON attendance_corrections
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_CORRECTION');
END;

CREATE TRIGGER correction_no_delete BEFORE DELETE ON attendance_corrections
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_CORRECTION');
END;

-- Administrative actions. Attendance events and corrections are their own
-- audit trail and are not copied here.
CREATE TABLE audit_entries (
  id INTEGER PRIMARY KEY,
  location_id INTEGER REFERENCES locations(id),
  actor_id INTEGER REFERENCES staff(id),
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX audit_entries_time ON audit_entries (created_at);

CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_entries
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT');
END;

CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_entries
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT');
END;

-- Center attestations for the annual certification. Append-only; the latest
-- entry per location, requirement and year is the current statement.
CREATE TABLE attestations (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  requirement INTEGER NOT NULL CHECK (requirement BETWEEN 1 AND 8),
  year INTEGER NOT NULL,
  confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
  note TEXT NOT NULL DEFAULT '',
  attested_by INTEGER NOT NULL REFERENCES staff(id),
  attested_at TEXT NOT NULL
);
CREATE INDEX attestations_lookup ON attestations (location_id, year, requirement);

CREATE TRIGGER attestations_no_update BEFORE UPDATE ON attestations
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_ATTESTATION');
END;

CREATE TRIGGER attestations_no_delete BEFORE DELETE ON attestations
BEGIN
  SELECT RAISE(ABORT, 'IMMUTABLE_ATTESTATION');
END;

CREATE TABLE imports (
  id INTEGER PRIMARY KEY,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  status TEXT NOT NULL CHECK (status IN ('preview', 'completed', 'expired')),
  source_name TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL,
  total_rows INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES staff(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX imports_location ON imports (location_id, created_at);

CREATE TABLE import_rows (
  import_id INTEGER NOT NULL REFERENCES imports(id),
  row_number INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'skip', 'reject')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'skipped', 'rejected')),
  student_code TEXT NOT NULL DEFAULT '',
  student_name TEXT NOT NULL DEFAULT '',
  problem TEXT,
  payload TEXT,
  PRIMARY KEY (import_id, row_number)
) WITHOUT ROWID;

CREATE TABLE backup_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('export', 'parts', 'manifest', 'complete', 'failed')),
  reason TEXT NOT NULL CHECK (reason IN ('scheduled', 'manual')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  bookmark TEXT,
  signed_url TEXT,
  sql_bytes INTEGER,
  offset_bytes INTEGER NOT NULL DEFAULT 0,
  next_part INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  lease_token TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  alert_sent_at TEXT
);
CREATE INDEX backup_jobs_created ON backup_jobs (created_at);

CREATE TABLE backup_parts (
  job_id TEXT NOT NULL REFERENCES backup_jobs(id),
  part INTEGER NOT NULL,
  object_key TEXT NOT NULL,
  header_json TEXT NOT NULL,
  plaintext_bytes INTEGER NOT NULL,
  plaintext_sha256 TEXT NOT NULL,
  encrypted_bytes INTEGER NOT NULL,
  encrypted_sha256 TEXT NOT NULL,
  verified_at TEXT,
  PRIMARY KEY (job_id, part)
) WITHOUT ROWID;
