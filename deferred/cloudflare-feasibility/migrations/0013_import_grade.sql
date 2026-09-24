-- Add grade to the atomic roster application after schema 11 introduces it.
-- Saved mappings preserve omitted grade in old and new previews.
DROP TRIGGER import_apply;
CREATE TRIGGER import_apply BEFORE UPDATE OF status ON roster_import_rows
WHEN OLD.status='pending' AND NEW.status='applied' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM roster_imports WHERE id=OLD.import_id AND status IN ('preview','committing') AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN RAISE(ABORT,'IMPORT_EXPIRED') END;
 SELECT CASE WHEN EXISTS(SELECT 1 FROM students s WHERE s.id=OLD.student_id AND s.revision!=coalesce(OLD.expected_student_revision,-1) AND s.revision!=coalesce((SELECT max(applied_student_revision) FROM roster_import_rows WHERE import_id=OLD.import_id AND student_id=OLD.student_id AND status='applied'),-1)) THEN RAISE(ABORT,'IMPORT_STALE') END;
 SELECT CASE WHEN OLD.expected_student_revision IS NOT NULL AND NOT EXISTS(SELECT 1 FROM students WHERE id=OLD.student_id) THEN RAISE(ABORT,'IMPORT_STALE') END;

 INSERT INTO students(id,center_id,student_code,first_name,last_name,active,subjects,pickup_alert,grade,created_at,updated_at)
 SELECT OLD.student_id,i.center_id,json_extract(OLD.payload_json,'$.studentCode'),json_extract(OLD.payload_json,'$.firstName'),json_extract(OLD.payload_json,'$.lastName'),1,
   coalesce(json_extract(OLD.payload_json,'$.subjects'),'[]'),coalesce(json_extract(OLD.payload_json,'$.pickupAlert'),''),coalesce(json_extract(OLD.payload_json,'$.grade'),''),
   json_extract(OLD.payload_json,'$.appliedVersion'),json_extract(OLD.payload_json,'$.appliedVersion')
 FROM roster_imports i WHERE i.id=OLD.import_id
 ON CONFLICT(id) DO UPDATE SET first_name=excluded.first_name,last_name=excluded.last_name,
   subjects=iif((SELECT nullif(json_extract(mapping_json,'$.subjects'),'') FROM roster_imports WHERE id=OLD.import_id) IS NOT NULL,excluded.subjects,students.subjects),
   pickup_alert=iif((SELECT nullif(json_extract(mapping_json,'$.pickupAlert'),'') FROM roster_imports WHERE id=OLD.import_id) IS NOT NULL,excluded.pickup_alert,students.pickup_alert),
   grade=iif((SELECT nullif(json_extract(mapping_json,'$.grade'),'') FROM roster_imports WHERE id=OLD.import_id) IS NOT NULL,excluded.grade,students.grade),
   updated_at=excluded.updated_at;

 SELECT CASE WHEN OLD.guardian_id IS NOT NULL AND EXISTS(
   SELECT 1 FROM guardians g JOIN roster_imports i ON i.id=OLD.import_id WHERE g.id=OLD.guardian_id AND (
     (nullif(json_extract(i.mapping_json,'$.guardianName'),'') IS NOT NULL AND g.display_name!=json_extract(OLD.payload_json,'$.guardianName')) OR
     (nullif(json_extract(i.mapping_json,'$.guardianEmail'),'') IS NOT NULL AND g.email!=json_extract(OLD.payload_json,'$.guardianEmail')) OR
     (nullif(json_extract(i.mapping_json,'$.guardianPhone'),'') IS NOT NULL AND g.phone!=json_extract(OLD.payload_json,'$.guardianPhone'))
   )
 ) THEN RAISE(ABORT,'IMPORT_GUARDIAN_CHANGED') END;
 SELECT CASE WHEN OLD.guardian_id IS NOT NULL AND EXISTS(SELECT 1 FROM guardians g JOIN roster_imports i ON i.id=OLD.import_id WHERE g.center_id=i.center_id AND g.import_ref=nullif(json_extract(OLD.payload_json,'$.guardianReference'),'') AND g.id!=OLD.guardian_id) THEN RAISE(ABORT,'IMPORT_GUARDIAN_CHANGED') END;

 INSERT OR IGNORE INTO guardians(id,center_id,display_name,email,phone,created_at,import_ref)
 SELECT OLD.guardian_id,i.center_id,json_extract(OLD.payload_json,'$.guardianName'),coalesce(json_extract(OLD.payload_json,'$.guardianEmail'),''),coalesce(json_extract(OLD.payload_json,'$.guardianPhone'),''),json_extract(OLD.payload_json,'$.appliedVersion'),nullif(json_extract(OLD.payload_json,'$.guardianReference'),'')
 FROM roster_imports i WHERE i.id=OLD.import_id AND OLD.guardian_id IS NOT NULL;

 -- Validate the resulting authority and evidence, including preserved fields.
 SELECT CASE WHEN OLD.guardian_id IS NOT NULL AND EXISTS(
   SELECT 1 FROM roster_imports i
   LEFT JOIN student_guardians l ON l.student_id=OLD.student_id AND l.guardian_id=OLD.guardian_id
   WHERE i.id=OLD.import_id
   AND (iif(nullif(json_extract(i.mapping_json,'$.pickupAuthority'),'') IS NOT NULL,coalesce(json_extract(OLD.payload_json,'$.pickupAuthority'),'unverified'),coalesce(l.pickup_authority,'unverified')))='allowed'
   AND (iif(nullif(json_extract(i.mapping_json,'$.pickupAuthorityNote'),'') IS NOT NULL,coalesce(json_extract(OLD.payload_json,'$.pickupAuthorityNote'),''),coalesce(l.authority_note,'')))=''
 ) THEN RAISE(ABORT,'IMPORT_PICKUP_EVIDENCE_REQUIRED') END;

 INSERT INTO student_guardians(student_id,guardian_id,relationship,pickup_authority,authority_note)
 SELECT OLD.student_id,OLD.guardian_id,coalesce(json_extract(OLD.payload_json,'$.guardianRelationship'),''),coalesce(json_extract(OLD.payload_json,'$.pickupAuthority'),'unverified'),coalesce(json_extract(OLD.payload_json,'$.pickupAuthorityNote'),'')
 WHERE OLD.guardian_id IS NOT NULL
 ON CONFLICT(student_id,guardian_id) DO UPDATE SET
   relationship=iif((SELECT nullif(json_extract(mapping_json,'$.guardianRelationship'),'') FROM roster_imports WHERE id=OLD.import_id) IS NOT NULL,excluded.relationship,student_guardians.relationship),
   pickup_authority=iif((SELECT nullif(json_extract(mapping_json,'$.pickupAuthority'),'') FROM roster_imports WHERE id=OLD.import_id) IS NOT NULL,excluded.pickup_authority,student_guardians.pickup_authority),
   authority_note=iif((SELECT nullif(json_extract(mapping_json,'$.pickupAuthorityNote'),'') FROM roster_imports WHERE id=OLD.import_id) IS NOT NULL,excluded.authority_note,student_guardians.authority_note)
 WHERE student_guardians.student_id=OLD.student_id AND student_guardians.guardian_id=OLD.guardian_id;

 INSERT INTO audit_entries(id,center_id,actor_id,actor_name,action,entity_type,entity_id,detail,created_at)
 SELECT OLD.import_id||':'||OLD.row_number,i.center_id,s.id,s.display_name,'roster_import','student',OLD.student_id,json_object('importId',OLD.import_id,'row',OLD.row_number,'action',OLD.action),NEW.applied_at
 FROM roster_imports i JOIN staff s ON s.id=i.created_by WHERE i.id=OLD.import_id;
END;
INSERT INTO schema_versions(version) VALUES(13);
