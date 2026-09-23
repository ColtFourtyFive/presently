-- Keep student-detail reads scoped to one center and student. The previous
-- indexes let SQLite choose a center-wide scan as attendance history grew.
CREATE INDEX visits_center_student_recent
  ON visits(center_id, student_id, check_in_at DESC, id);

-- Archive-aware report pages resolve a bounded set of visit IDs. Pairing the
-- tenant key with the visit key prevents SQLite from scanning every visit in
-- the center for each 100-row page.
CREATE INDEX visits_center_id
  ON visits(center_id, id);

CREATE INDEX history_heads_center_student_recent
  ON history_visit_heads(center_id, student_id, check_in_at DESC, visit_id);

-- Retention walks the immutable original attendance timeline. Without this
-- cursor index each bounded candidate step sorts every retained visit.
CREATE INDEX history_heads_center_original_cursor
  ON history_visit_heads(center_id, original_check_in_at, visit_id);

INSERT INTO schema_versions(version) VALUES(40);
