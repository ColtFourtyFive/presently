import { Hono } from 'hono';
import type { AppEnv } from './types';
import type { Business, Location, Role, Staff } from '../shared/types';
import { ApiProblem, audit, body, idValue, now, paramId, pinHash, requireRole, sha256, staffRoles, textValue, token, validTimezone, type Ctx, type Row } from './util';
import { deviceView, type DeviceRow } from './auth';

export function locationView(row: Row): Location {
  return {
    id: Number(row.id), name: String(row.name), timezone: String(row.timezone), address: String(row.address),
    operatingHours: String(row.operating_hours), active: !!row.active,
  };
}
export async function getBusiness(c: Ctx): Promise<Business> {
  const row = await c.env.CRM_DB.prepare('SELECT name, timezone, backup_hour FROM business WHERE id = 1').first<Row>();
  return { name: String(row?.name ?? 'My business'), timezone: String(row?.timezone ?? 'America/Los_Angeles'), backupHour: Number(row?.backup_hour ?? 2) };
}
export async function getLocation(c: Ctx, id = c.var.locationId): Promise<Location> {
  const row = await c.env.CRM_DB.prepare('SELECT * FROM locations WHERE id = ?').bind(id).first<Row>();
  if (!row) throw new ApiProblem(404, 'LOCATION_NOT_FOUND', 'Location was not found.');
  return locationView(row);
}

function staffView(row: Row, locationIds: number[]): Staff {
  return {
    id: Number(row.id), email: (row.email as string | null) ?? null, displayName: String(row.display_name), role: row.role as Role,
    active: !!row.active, kioskEnabled: !!row.kiosk_enabled, hasPin: !!row.pin_hash, locationIds,
  };
}

async function staffLocations(c: Ctx) {
  const rows = await c.env.CRM_DB.prepare('SELECT staff_id, location_id FROM staff_locations').all<{ staff_id: number; location_id: number }>();
  const map = new Map<number, number[]>();
  for (const row of rows.results) map.set(row.staff_id, [...(map.get(row.staff_id) || []), row.location_id]);
  return map;
}

function locationInput(input: Row, existing?: Location) {
  const name = input.name === undefined && existing ? existing.name : textValue(input.name, 'name', 150);
  const timezone = input.timezone === undefined && existing ? existing.timezone : textValue(input.timezone, 'timezone', 100);
  if (!validTimezone(timezone)) throw new ApiProblem(400, 'INVALID_TIMEZONE', 'Choose a valid IANA time zone.');
  const address = input.address === undefined ? existing?.address ?? '' : textValue(input.address, 'address', 300, false);
  const operatingHours = input.operatingHours === undefined ? existing?.operatingHours ?? '' : textValue(input.operatingHours, 'operatingHours', 500, false);
  if (input.active !== undefined && typeof input.active !== 'boolean') throw new ApiProblem(400, 'INVALID_INPUT', 'active must be true or false.');
  const active = input.active === undefined ? existing?.active ?? true : input.active as boolean;
  return { name, timezone, address, operatingHours, active };
}

async function staffInput(c: Ctx, input: Row, existing?: Row) {
  const rawEmail = input.email === undefined ? existing?.email ?? null : input.email;
  let email: string | null = null;
  if (rawEmail !== null && rawEmail !== '') {
    email = textValue(rawEmail, 'email', 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiProblem(400, 'INVALID_EMAIL', 'Provide a valid staff email.');
  }
  const displayName = textValue(input.displayName ?? existing?.display_name, 'displayName', 150);
  const role = (input.role ?? existing?.role) as Role;
  if (!staffRoles.includes(role)) throw new ApiProblem(400, 'INVALID_ROLE', 'Choose owner, manager, front_desk, or instructor.');
  for (const key of ['active', 'kioskEnabled']) if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new ApiProblem(400, 'INVALID_INPUT', `${key} must be true or false.`);
  const active = (input.active ?? (existing ? !!existing.active : true)) as boolean;
  const kioskEnabled = (input.kioskEnabled ?? (existing ? !!existing.kiosk_enabled : false)) as boolean;
  if (kioskEnabled && role === 'instructor') throw new ApiProblem(400, 'INVALID_ROLE', 'Instructors have roster access only; choose a front desk role for kiosk operation.');
  if (role !== 'owner' && !email && !kioskEnabled) throw new ApiProblem(400, 'SIGN_IN_REQUIRED', 'Give this person an email for the back office, kiosk access with a PIN, or both.');
  if (role === 'owner' && !email) throw new ApiProblem(400, 'SIGN_IN_REQUIRED', 'Owners need an email to sign in to the back office.');
  let pin: string | null = null;
  if (input.pin !== undefined && input.pin !== null && input.pin !== '') {
    if (typeof input.pin !== 'string' || !/^\d{8,12}$/.test(input.pin)) throw new ApiProblem(400, 'INVALID_PIN', 'Use a staff PIN of 8–12 digits.');
    pin = input.pin;
  }
  if (kioskEnabled && !pin && !existing?.pin_hash) throw new ApiProblem(400, 'PIN_REQUIRED', 'Set an individual staff PIN before enabling kiosk access.');
  let locationIds: number[] | null = null;
  if (input.locationIds !== undefined) {
    if (!Array.isArray(input.locationIds) || input.locationIds.length > 100) throw new ApiProblem(400, 'INVALID_INPUT', 'locationIds must be a list of locations.');
    locationIds = [...new Set(input.locationIds.map(value => idValue(value, 'locationIds')))];
    const known = await c.env.CRM_DB.prepare('SELECT count(*) AS n FROM locations WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(locationIds)).first<{ n: number }>();
    if (Number(known?.n) !== locationIds.length) throw new ApiProblem(400, 'INVALID_LOCATION', 'Choose existing locations.');
  }
  if (role !== 'owner' && !existing && !locationIds?.length) throw new ApiProblem(400, 'LOCATION_REQUIRED', 'Assign at least one location.');
  return { email, displayName, role, active: active ? 1 : 0, kioskEnabled: kioskEnabled ? 1 : 0, pin, locationIds };
}

export const adminRouter = new Hono<AppEnv>();

adminRouter.get('/session', async c => {
  const rows = c.var.locationIds.length
    ? await c.env.CRM_DB.prepare('SELECT * FROM locations WHERE id IN (SELECT value FROM json_each(?)) ORDER BY name, id').bind(JSON.stringify(c.var.locationIds)).all<Row>()
    : { results: [] as Row[] };
  return c.json({ business: await getBusiness(c), locations: rows.results.map(locationView), actor: c.var.actor });
});

adminRouter.patch('/business', async c => {
  requireRole(c, ['owner']);
  const input = await body(c);
  const existing = await getBusiness(c);
  const name = input.name === undefined ? existing.name : textValue(input.name, 'name', 150);
  const timezone = input.timezone === undefined ? existing.timezone : textValue(input.timezone, 'timezone', 100);
  if (!validTimezone(timezone)) throw new ApiProblem(400, 'INVALID_TIMEZONE', 'Choose a valid IANA time zone.');
  const backupHour = input.backupHour === undefined ? existing.backupHour : Number(input.backupHour);
  if (!Number.isInteger(backupHour) || backupHour < 0 || backupHour > 23) throw new ApiProblem(400, 'INVALID_INPUT', 'backupHour must be an hour from 0 to 23.');
  await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare('UPDATE business SET name = ?, timezone = ?, backup_hour = ? WHERE id = 1').bind(name, timezone, backupHour),
    audit(c, 'business_updated', 'business', 1, { name, timezone, backupHour }),
  ]);
  return c.json({ business: { name, timezone, backupHour } });
});

adminRouter.get('/locations', async c => {
  requireRole(c, ['owner']);
  const rows = await c.env.CRM_DB.prepare('SELECT * FROM locations ORDER BY active DESC, name, id LIMIT 200').all<Row>();
  return c.json({ items: rows.results.map(locationView) });
});

adminRouter.post('/locations', async c => {
  requireRole(c, ['owner']);
  const input = locationInput(await body(c));
  const [inserted] = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare('INSERT INTO locations (name, timezone, address, operating_hours, active, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING *')
      .bind(input.name, input.timezone, input.address, input.operatingHours, input.active ? 1 : 0, now()),
  ]);
  const location = locationView(inserted.results[0]);
  await audit(c, 'location_created', 'location', location.id, { name: location.name }, location.id).run();
  return c.json({ location }, 201);
});

adminRouter.patch('/locations/:id', async c => {
  requireRole(c, ['owner']);
  const existing = await getLocation(c, paramId(c));
  const input = locationInput(await body(c), existing);
  await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare('UPDATE locations SET name = ?, timezone = ?, address = ?, operating_hours = ?, active = ? WHERE id = ?')
      .bind(input.name, input.timezone, input.address, input.operatingHours, input.active ? 1 : 0, existing.id),
    audit(c, 'location_updated', 'location', existing.id, input, existing.id),
  ]);
  return c.json({ location: { id: existing.id, ...input } });
});

adminRouter.get('/staff', async c => {
  requireRole(c, ['owner']);
  const [rows, links] = await Promise.all([
    c.env.CRM_DB.prepare('SELECT * FROM staff ORDER BY active DESC, display_name, id LIMIT 500').all<Row>(),
    staffLocations(c),
  ]);
  return c.json({ items: rows.results.map(row => staffView(row, links.get(Number(row.id)) || [])) });
});

adminRouter.post('/staff', async c => {
  requireRole(c, ['owner']);
  const input = await staffInput(c, await body(c));
  const timestamp = now();
  const db = c.env.CRM_DB;
  const [inserted] = await db.batch<Row>([
    db.prepare('INSERT INTO staff (email, display_name, role, active, kiosk_enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id')
      .bind(input.email, input.displayName, input.role, input.active, input.kioskEnabled, timestamp, timestamp),
  ]);
  const staffId = Number(inserted.results[0].id);
  // The PIN hash includes the staff id, so it is written once the id exists.
  const pinHashValue = input.pin ? await pinHash(c.env, staffId, input.pin) : null;
  const locationIds = input.role === 'owner' ? [] : input.locationIds || [];
  await db.batch([
    db.prepare('UPDATE staff SET pin_hash = ? WHERE id = ?').bind(pinHashValue, staffId),
    ...locationIds.map(locationId => db.prepare('INSERT INTO staff_locations (staff_id, location_id) VALUES (?, ?)').bind(staffId, locationId)),
    audit(c, 'staff_created', 'staff', staffId, { email: input.email, role: input.role, kioskEnabled: !!input.kioskEnabled, locationIds }),
  ]);
  const row = await db.prepare('SELECT * FROM staff WHERE id = ?').bind(staffId).first<Row>();
  return c.json({ staff: staffView(row!, locationIds) }, 201);
});

adminRouter.patch('/staff/:id', async c => {
  requireRole(c, ['owner']);
  const db = c.env.CRM_DB;
  const existing = await db.prepare('SELECT * FROM staff WHERE id = ?').bind(paramId(c)).first<Row>();
  if (!existing) throw new ApiProblem(404, 'STAFF_NOT_FOUND', 'Staff member was not found.');
  const staffId = Number(existing.id);
  const input = await staffInput(c, await body(c), existing);
  const pinHashValue = input.pin ? await pinHash(c.env, staffId, input.pin) : existing.pin_hash ?? null;
  const locationIds = input.role === 'owner' ? [] : input.locationIds;
  await db.batch([
    db.prepare('UPDATE staff SET email = ?, display_name = ?, role = ?, active = ?, kiosk_enabled = ?, pin_hash = ?, session_version = session_version + 1, updated_at = ? WHERE id = ?')
      .bind(input.email, input.displayName, input.role, input.active, input.kioskEnabled, pinHashValue, now(), staffId),
    ...(locationIds ? [
      db.prepare('DELETE FROM staff_locations WHERE staff_id = ?').bind(staffId),
      ...locationIds.map(locationId => db.prepare('INSERT INTO staff_locations (staff_id, location_id) VALUES (?, ?)').bind(staffId, locationId)),
    ] : []),
    db.prepare('DELETE FROM kiosk_sessions WHERE staff_id = ?').bind(staffId),
    audit(c, 'staff_updated', 'staff', staffId, { role: input.role, active: !!input.active, kioskEnabled: !!input.kioskEnabled, pinChanged: !!input.pin, locationIds, sessionsRevoked: true }),
  ]);
  const [row, links] = await Promise.all([db.prepare('SELECT * FROM staff WHERE id = ?').bind(staffId).first<Row>(), staffLocations(c)]);
  return c.json({ staff: staffView(row!, links.get(staffId) || []) });
});

adminRouter.get('/devices', async c => {
  requireRole(c, ['owner']);
  const rows = await c.env.CRM_DB.prepare('SELECT id, location_id, label, created_at, expires_at, revoked_at FROM kiosk_devices ORDER BY created_at DESC LIMIT 200').all<DeviceRow>();
  return c.json({ items: rows.results.map(deviceView) });
});

adminRouter.post('/devices/enrollment', async c => {
  requireRole(c, ['owner']);
  const input = await body(c);
  const location = await getLocation(c, idValue(input.locationId, 'locationId'));
  if (!location.active) throw new ApiProblem(409, 'LOCATION_INACTIVE', 'Reactivate this location before enrolling a kiosk.');
  const secret = token();
  const expiresAt = new Date(Date.now() + 10 * 60000).toISOString();
  const [inserted] = await c.env.CRM_DB.batch<Row>([
    c.env.CRM_DB.prepare('INSERT INTO device_enrollments (location_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(location.id, await sha256(secret), expiresAt, c.var.actor.id, now()),
  ]);
  await audit(c, 'kiosk_enrollment_created', 'device_enrollment', Number(inserted.results[0].id), {}, location.id).run();
  return c.json({ token: secret, expiresAt, locationId: location.id }, 201);
});

adminRouter.post('/devices/:id/revoke', async c => {
  requireRole(c, ['owner']);
  const device = await c.env.CRM_DB.prepare('SELECT id, location_id FROM kiosk_devices WHERE id = ?').bind(paramId(c)).first<{ id: number; location_id: number }>();
  if (!device) throw new ApiProblem(404, 'DEVICE_NOT_FOUND', 'Kiosk device was not found.');
  await c.env.CRM_DB.batch([
    c.env.CRM_DB.prepare('UPDATE kiosk_devices SET revoked_at = coalesce(revoked_at, ?) WHERE id = ?').bind(now(), device.id),
    c.env.CRM_DB.prepare('DELETE FROM kiosk_sessions WHERE device_id = ?').bind(device.id),
    audit(c, 'kiosk_revoked', 'kiosk_device', device.id, {}, device.location_id),
  ]);
  return c.json({ ok: true });
});
