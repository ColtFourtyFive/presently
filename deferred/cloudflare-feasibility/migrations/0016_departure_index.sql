-- Daily departure reads must seek by checkout time, not scan arrival history.
CREATE INDEX visits_center_departures
ON visits(center_id,check_out_at)
WHERE check_out_at IS NOT NULL;

INSERT INTO schema_versions(version) VALUES(16);
