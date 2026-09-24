import type { Database } from './db.js';
import type { Actor } from './auth.js';
import { audit } from './records.js';
import { DEMO_CENTER_LOCATION, DEMO_OPERATING_HOURS } from './seed.js';

// This administrative helper is deliberately absent from the web API. It is
// limited to a center explicitly marked as a demo and requires that center's
// active owner for attribution. Staff credentials and sessions are retained.
const businessTables = [
  'roster_import_rows', 'roster_imports',
  'attendance_corrections', 'attendance_events', 'incidents', 'interactions',
  'schedules', 'tasks', 'inquiry_stage_history', 'inquiries', 'visits',
  'enrollments', 'student_guardians', 'students', 'guardians', 'households',
  'audit_entries',
] as const;

export interface DemoResetOptions { centerId: string; adminEmail: string }
export interface DemoResetResult {
  centerId: string;
  centerName: string;
  removed: Record<string, number>;
  preservedStaff: number;
  preservedSessions: number;
}

export async function resetDemoCenter(db: Database, options: DemoResetOptions): Promise<DemoResetResult> {
  const centerId = options.centerId.trim();
  const adminEmail = options.adminEmail.trim().toLowerCase();
  if (!centerId || !adminEmail) throw new Error('An explicit center ID and owner email are required.');

  return db.transaction(async tx => {
    // Serialize this short administrative operation with business writes.
    // Reads can continue; no request can insert records between deletion steps.
    await tx.query(`LOCK TABLE centers,staff,${businessTables.join(',')} IN SHARE ROW EXCLUSIVE MODE`);
    const center = (await tx.query('SELECT * FROM centers WHERE id=$1 FOR UPDATE', [centerId])).rows[0];
    if (!center) throw new Error('Center not found. Nothing was cleared.');
    if (center.demo !== true) throw new Error('Refusing to clear a non-demo center. Nothing was cleared.');
    const owner = (await tx.query("SELECT * FROM staff WHERE center_id=$1 AND email=$2 AND role='owner' AND active=TRUE", [centerId,adminEmail])).rows[0];
    if (!owner) throw new Error('The specified email must belong to an active owner of this demo center. Nothing was cleared.');
    const actor: Actor = { id:owner.id, centerId, name:owner.name, email:owner.email, role:owner.role };

    const removed: Record<string, number> = {};
    for (const table of businessTables) {
      const result = await tx.query(`DELETE FROM ${table} WHERE center_id=$1`, [centerId]);
      removed[table] = result.rowCount;
    }
    await tx.query(`UPDATE centers SET demo=FALSE,student_sequence=0,
      location=CASE WHEN location=$2 THEN '' ELSE location END,
      operating_hours=CASE WHEN operating_hours=$3 THEN '' ELSE operating_hours END
      WHERE id=$1`, [centerId,DEMO_CENTER_LOCATION,DEMO_OPERATING_HOURS]);
    await audit(tx, actor, 'Demo workspace cleared', centerId, 'Demo business records removed. Center settings, staff accounts, and login sessions retained.');

    const staffCount = (await tx.query('SELECT COUNT(*) AS count FROM staff WHERE center_id=$1', [centerId])).rows[0].count;
    const sessionCount = (await tx.query('SELECT COUNT(*) AS count FROM sessions s JOIN staff u ON u.id=s.staff_id WHERE u.center_id=$1', [centerId])).rows[0].count;
    return { centerId, centerName:center.name, removed, preservedStaff:Number(staffCount), preservedSessions:Number(sessionCount) };
  });
}
