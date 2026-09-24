// Requires scripts/dev-local.ts: signed synthetic identity and disposable empty D1.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.MANAGEMENT_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Set MANAGEMENT_TEST_BASE_URL to an isolated local preview.');
const output = path.resolve('tmp/management-browser'); await mkdir(output, { recursive: true });
const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles' });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const report = { checks: [], runtimeErrors: [], screenshots: [], status: 'running' };
page.on('pageerror', error => report.runtimeErrors.push(error.message));
const json = async response => { const value = await response.json(); assert(response.ok(), JSON.stringify(value)); return value; };
const screenshot = async name => { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target, fullPage: true }); report.screenshots.push(target); };
const nav = () => page.getByRole('navigation', { name: 'Workspace sections' });
const profile = () => page.getByRole('dialog', { name: 'Student details', exact: true });
const management = () => profile().locator('.cf-management');
const correction = () => page.getByRole('dialog', { name: "Correct Manager Learner's visit", exact: true });
const localTime = iso => page.evaluate(value => {
  const date = new Date(value), pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}, iso);
const expiry = route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Synthetic expired access.' } }) });
async function signBackIn() {
  await expect(page.getByRole('heading', { name: 'Sign in to your center.' })).toBeVisible();
  await expect(page.getByText('A request still needs confirmation.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Already signed in? Try again', exact: true }).click();
}
try {
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  assert.equal((await json(await context.request.get(`${base}/api/admin/students`))).total, 0, 'Requires an empty temporary database.');
  const { student } = await json(await context.request.post(`${base}/api/admin/students`, { data: { studentCode: 'MANAGEMENT-SMOKE', firstName: 'Manager', lastName: 'Learner', grade: '2', subjects: ['Math'], guardians: [{ displayName: 'Manager Guardian', relationship: 'Parent', email: 'manager-guardian@example.test', phone: '555-0112', pickupAuthority: 'unverified' }] } }));
  const endpoint = `${base}/api/admin/students/${student.id}`, detail = () => context.request.get(endpoint).then(json);
  const originalArrival = new Date(Date.now()-1200000).toISOString();
  await json(await context.request.post(`${base}/api/admin/attendance`, { data: { eventId: crypto.randomUUID(), studentId: student.id, action: 'check_in', observedAt: originalArrival } }));
  await nav().getByRole('button', { name: 'Students', exact: true }).click();
  await page.locator('.cf-student-button').filter({ hasText: 'Manager Learner' }).click();
  await management().getByRole('button', { name: 'Edit student profile', exact: true }).click();
  await management().getByLabel('Grade', { exact: true }).fill('3');
  await management().getByLabel('Reading', { exact: true }).check();
  await management().getByRole('button', { name: 'Save student profile', exact: true }).click();
  await expect(management().getByRole('status')).toHaveText('Student record updated.');
  let current = await detail(); assert.equal(current.student.grade, '3'); assert.deepEqual(current.student.subjects, ['Math', 'Reading']);
  report.checks.push('Manager changes grade and subjects without changing student reference or attendance');

  await management().getByRole('button', { name: 'Edit student profile', exact: true }).click();
  await management().getByLabel('Enrollment status', { exact: true }).selectOption('inactive');
  await management().getByRole('button', { name: 'Save student profile', exact: true }).click();
  await expect(profile().getByText(/Inactive student/)).toBeVisible();
  current = await detail(); assert.equal(current.visits.length, 1); assert.equal(current.visits[0].checkOutAt, null);
  await management().getByRole('button', { name: 'Edit student profile', exact: true }).click();
  await management().getByLabel('Enrollment status', { exact: true }).selectOption('active');
  await management().getByRole('button', { name: 'Save student profile', exact: true }).click();
  await expect(profile().getByText(/Active student/)).toBeVisible();
  report.checks.push('Deactivate and reactivate preserves open visit and all history');

  await management().getByRole('button', { name: 'Edit student profile', exact: true }).click();
  current = await detail(); await json(await context.request.patch(endpoint, { data: { expectedRevision: current.student.revision, grade: '5' } }));
  await management().getByLabel('Grade', { exact: true }).fill('4');
  await management().getByRole('button', { name: 'Save student profile', exact: true }).click();
  await expect(management().getByRole('button', { name: 'Reload current record', exact: true })).toBeVisible();
  assert.equal((await detail()).student.grade, '5');
  await management().getByRole('button', { name: 'Reload current record', exact: true }).click();
  await expect(management().getByLabel('Grade', { exact: true })).toHaveValue('5');
  await management().getByRole('button', { name: 'Cancel', exact: true }).click();
  report.checks.push('Stale profile edits require reload and never overwrite a newer value');

  await management().getByRole('button', { name: 'Manage Manager Guardian', exact: true }).click();
  await management().getByLabel('Pickup authority for this student', { exact: true }).selectOption('allowed');
  await management().getByRole('button', { name: 'Save guardian details', exact: true }).click();
  assert.equal(await management().getByLabel('Verification evidence or restriction note').evaluate(input => input.validity.valueMissing), true);
  await management().getByLabel('Verification evidence or restriction note').fill('Signed pickup authorization verified today.');
  current = await detail(); const guardianId = current.guardians[0].id;
  await json(await context.request.patch(`${endpoint}/guardians/${guardianId}`, { data: { expectedRevision: current.student.revision, pickupAuthority: 'denied', authorityNote: 'Manager verified a new restriction.', phone: '555-0199' } }));
  await management().getByRole('button', { name: 'Save guardian details', exact: true }).click();
  await expect(management().getByRole('button', { name: 'Reload current record', exact: true })).toBeVisible();
  assert.equal((await detail()).guardians[0].pickupAuthority, 'denied');
  await management().getByRole('button', { name: 'Reload current record', exact: true }).click();
  await expect(management().getByLabel('Pickup authority for this student')).toHaveValue('denied');
  await expect(management().getByLabel('Phone', { exact: true })).toHaveValue('555-0199');
  await management().getByLabel('Pickup authority for this student').selectOption('allowed');
  await management().getByLabel('Verification evidence or restriction note').fill('Signed authorization re-verified; restriction removed by manager.');
  await management().getByLabel('Phone', { exact: true }).fill('555-0188');
  await management().getByLabel('Email', { exact: true }).fill('guardian-updated@example.test');
  await management().getByRole('button', { name: 'Save guardian details', exact: true }).click();
  await expect(profile().getByText('Authorized', { exact: true })).toBeVisible();
  assert.equal((await detail()).guardians[0].phone, '555-0188');
  report.checks.push('Pickup requires evidence; stale authority edits cannot overwrite a denial; reload permits an explicit reviewed update');

  const patches = [];
  await page.route(`**/api/admin/students/${student.id}`, async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    patches.push(route.request().postDataJSON()); const response = await route.fetch(); assert.equal(response.status(), 200); await response.dispose(); return route.abort('failed');
  });
  await management().getByRole('button', { name: 'Edit student profile', exact: true }).click();
  await management().getByLabel('Grade', { exact: true }).fill('6');
  await management().getByRole('button', { name: 'Save student profile', exact: true }).click();
  await expect(management().getByRole('button', { name: 'Check saved record', exact: true })).toBeVisible();
  await expect(nav().getByRole('button', { name: 'Students', exact: true })).toBeDisabled();
  await profile().getByRole('button', { name: 'Close dialog', exact: true }).click(); await expect(profile()).toBeVisible();
  await page.route(`**/api/admin/students/${student.id}`, expiry, { times: 1 });
  await management().getByRole('button', { name: 'Check saved record', exact: true }).click();
  await signBackIn();
  await expect(management().getByRole('button', { name: 'Check saved record', exact: true })).toBeVisible();
  await management().getByRole('button', { name: 'Check saved record', exact: true }).click();
  await expect(management().getByRole('status')).toHaveText('Student record updated.');
  assert.equal(patches.length, 1); assert.equal((await detail()).student.grade, '6');
  await page.unroute(`**/api/admin/students/${student.id}`);
  report.checks.push('Lost PATCH result survives reauthentication and resolves with GET without a second mutation');

  await profile().getByRole('button', { name: 'Correct times', exact: true }).click();
  await expect(correction().getByLabel('Actual departure time', { exact: true })).toHaveCount(0);
  await correction().getByLabel('Actual arrival time', { exact: true }).fill(await localTime(new Date(Date.parse(originalArrival)-60000).toISOString()));
  await correction().getByLabel('Reason for correction', { exact: true }).fill('Verified the arrival time against the front desk log.');
  const correctionAttempts = []; let committed = 0;
  await page.route('**/api/admin/visits/*/corrections', async route => {
    correctionAttempts.push(route.request().postDataJSON());
    if (correctionAttempts.length === 2) return expiry(route);
    const response = await route.fetch();
    if (correctionAttempts.length === 1) { assert.equal(response.status(), 201); committed++; await response.dispose(); return route.abort('failed'); }
    assert.equal(response.status(), 200); return route.fulfill({ response });
  });
  await correction().getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(correction().getByRole('button', { name: 'Retry same correction', exact: true })).toBeVisible();
  await expect(nav().getByRole('button', { name: 'Students', exact: true })).toBeDisabled();
  await correction().getByRole('button', { name: 'Close dialog', exact: true }).click(); await expect(correction()).toBeVisible();
  await correction().getByRole('button', { name: 'Retry same correction', exact: true }).click();
  await signBackIn();
  await correction().getByRole('button', { name: 'Retry same correction', exact: true }).click();
  let saved = page.getByRole('dialog', { name: 'Attendance correction saved', exact: true }); await expect(saved).toBeVisible();
  assert.equal(committed, 1); assert.equal(correctionAttempts.length, 3); assert.deepEqual(correctionAttempts[1], correctionAttempts[0]); assert.deepEqual(correctionAttempts[2], correctionAttempts[0]);
  current = await detail(); assert.equal(current.corrections.length, 1); assert.equal(current.visits[0].originalCheckInAt, originalArrival); assert.equal(current.visits[0].checkOutAt, null);
  await saved.getByRole('button', { name: 'Done', exact: true }).click(); await page.unroute('**/api/admin/visits/*/corrections');
  report.checks.push('Open-visit correction never invents departure; lost result and expired retry retain one idempotent request and original observations');

  await page.locator('.cf-student-button').filter({ hasText: 'Manager Learner' }).click();
  await profile().getByRole('button', { name: 'Correct times', exact: true }).click();
  current = await detail(); const visit = current.visits[0];
  const newerArrival = new Date(Date.parse(visit.checkInAt)-60000).toISOString();
  await json(await context.request.post(`${base}/api/admin/visits/${visit.id}/corrections`, { data: { correctionId: crypto.randomUUID(), expectedVersion: visit.version, checkInAt: newerArrival, checkOutAt: null, reason: 'Another manager reviewed the arrival.' } }));
  await correction().getByLabel('Actual arrival time', { exact: true }).fill(await localTime(new Date(Date.parse(visit.checkInAt)-30000).toISOString()));
  await correction().getByLabel('Reason for correction', { exact: true }).fill('Stale manager correction must not overwrite new review.');
  await correction().getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect(correction().getByRole('button', { name: 'Reload current visit', exact: true })).toBeVisible();
  await correction().getByRole('button', { name: 'Reload current visit', exact: true }).click();
  await expect(correction().getByLabel('Actual arrival time', { exact: true })).toHaveValue(await localTime(newerArrival));
  await expect(correction().getByLabel('Reason for correction', { exact: true })).toHaveValue('');
  await correction().getByRole('button', { name: 'Cancel', exact: true }).click();
  report.checks.push('A stale visit correction must reload the current visit and clear its old reason before re-review');

  await page.locator('.cf-student-button').filter({ hasText: 'Manager Learner' }).click();
  await profile().getByRole('button', { name: 'Record departure', exact: true }).click();
  let departure = page.getByRole('dialog', { name: 'Record a departure', exact: true });
  await departure.getByRole('combobox').selectOption(guardianId);
  await departure.getByRole('checkbox').check(); await departure.getByRole('button', { name: 'Record departure', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Departure recorded.', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Attendance confirmed', exact: true }).getByRole('button', { name: 'Done', exact: true }).click();
  report.checks.push('Verified guardian is available for normal observed checkout');

  await nav().getByRole('button', { name: 'History', exact: true }).click();
  const historyRow = page.locator('tbody tr').filter({ hasText: 'Manager Learner' });
  await historyRow.getByRole('button', { name: 'Correct times', exact: true }).click();
  current = await detail(); const originalDeparture = current.visits[0].originalCheckOutAt;
  await correction().getByLabel('Actual departure time', { exact: true }).fill(await localTime(new Date(Date.parse(originalDeparture)-30000).toISOString()));
  await correction().getByLabel('Reason for correction', { exact: true }).fill('Departure verified thirty seconds before recording.');
  await screenshot('correction-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('correction-mobile');
  let widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth })); assert(widths.page <= widths.viewport+1, JSON.stringify(widths));
  await correction().getByRole('button', { name: 'Save correction', exact: true }).click();
  saved = page.getByRole('dialog', { name: 'Attendance correction saved', exact: true }); await expect(saved).toBeVisible();
  current = await detail(); assert.equal(current.visits[0].originalCheckOutAt, originalDeparture); assert.equal(current.visits[0].originalCheckInAt, originalArrival); assert.equal(current.corrections.length, 3);
  await saved.getByRole('button', { name: 'Done', exact: true }).click();
  report.checks.push('History opens corrections for completed visits; effective times change while both original observations remain');

  await page.setViewportSize({ width: 1440, height: 1000 }); await nav().getByRole('button', { name: 'Students', exact: true }).click();
  await page.locator('.cf-student-button').filter({ hasText: 'Manager Learner' }).click();
  await management().getByRole('button', { name: 'Edit student profile', exact: true }).click(); await management().scrollIntoViewIfNeeded(); await screenshot('manager-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await management().scrollIntoViewIfNeeded(); await screenshot('manager-mobile');
  widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth })); assert(widths.page <= widths.viewport+1, JSON.stringify(widths));
  report.checks.push('Manager and correction forms remain contained at desktop and mobile sizes');
  assert.deepEqual(report.runtimeErrors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; await screenshot('failure').catch(() => {}); }
finally { await browser.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
