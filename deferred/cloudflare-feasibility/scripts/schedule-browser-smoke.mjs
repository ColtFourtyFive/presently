// Run only against scripts/dev-local.ts, which uses a temporary empty D1 database.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.SCHEDULE_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Set SCHEDULE_TEST_BASE_URL to an isolated local preview.');
const output = path.resolve('tmp/schedule-browser'); await mkdir(output, { recursive: true });
const browser = await chromium.launch(); const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const report = { checks: [], runtimeErrors: [], screenshots: [], status: 'running' };
page.on('pageerror', error => report.runtimeErrors.push(error.message));
const json = async response => { const value = await response.json(); assert(response.ok(), JSON.stringify(value)); return value; };
const screenshot = async name => { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target, fullPage: true }); report.screenshots.push(target); };
const nav = () => page.getByRole('navigation', { name: 'Workspace sections' });
const scheduleRow = () => page.locator('.cf-schedule-table tbody tr').filter({ hasText: 'Schedule Learner' });
async function addForm(day, start, duration = '30', subject = 'Math') {
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add weekly lesson' });
  await dialog.getByLabel('Find a student').fill('Schedule');
  await dialog.locator('.cf-schedule-search-results').getByRole('button').filter({ hasText: 'Schedule Learner' }).click();
  await dialog.getByLabel('Day of week').selectOption(String(day));
  await dialog.getByLabel('Subject', { exact: true }).selectOption(subject);
  await dialog.getByLabel('Start time').fill(start);
  await dialog.getByLabel('Duration in minutes').fill(duration);
  return dialog;
}
try {
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  await expect(nav().getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
  await expect(nav().getByRole('button', { name: 'Import roster', exact: true })).toBeVisible();
  const initial = await json(await context.request.get(`${base}/api/admin/students`));
  assert.equal(initial.total, 0, 'Schedule smoke requires a fresh temporary database.');
  const created = await json(await context.request.post(`${base}/api/admin/students`, { data: { studentCode: 'SCHEDULE-SMOKE-1', firstName: 'Schedule', lastName: 'Learner', subjects: ['Math', 'Reading'] } }));
  await nav().getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText('No lessons in this view')).toBeVisible();
  report.checks.push('Empty schedule and existing navigation');

  let dialog = await addForm(2, '15:00', '45', 'Reading');
  await dialog.getByRole('button', { name: 'Add weekly lesson', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(scheduleRow()).toHaveCount(1);
  await expect(scheduleRow()).toContainText('Tuesday');
  await expect(scheduleRow()).toContainText('3:00 PM to 3:45 PM');
  await expect(scheduleRow()).toContainText('Reading');
  await expect(page.getByText(/All times use America\/Los Angeles/)).toBeVisible();
  report.checks.push('Search, student selection, recurring lesson creation, and center-local time');

  dialog = await addForm(2, '15:15');
  await dialog.getByRole('button', { name: 'Add weekly lesson', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('overlapping active slot');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(scheduleRow()).toHaveCount(1);
  report.checks.push('Overlapping lessons rejected with the form retained');

  await scheduleRow().getByRole('button', { name: 'Cancel lesson' }).click();
  dialog = page.getByRole('dialog', { name: 'Cancel weekly lesson' });
  await dialog.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('No lessons in this view')).toBeVisible();
  await page.getByLabel('Status', { exact: true }).selectOption('false');
  await scheduleRow().getByRole('button', { name: 'Restore lesson' }).click();
  dialog = page.getByRole('dialog', { name: 'Restore weekly lesson' });
  await dialog.getByRole('button', { name: 'Confirm restoration' }).click();
  await expect(dialog).toBeHidden();
  await page.getByLabel('Status', { exact: true }).selectOption('true');
  await expect(scheduleRow()).toHaveCount(1);
  report.checks.push('Cancellation retains the record and restoration returns it to the active list');

  dialog = await addForm(4, '16:00');
  await page.route('**/api/admin/schedules', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 201); await response.dispose(); await route.abort('failed');
  });
  await dialog.getByRole('button', { name: 'Add weekly lesson', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Check saved schedule' })).toBeVisible();
  await page.unrouteAll({ behavior: 'wait' });
  await dialog.getByRole('button', { name: 'Check saved schedule' }).click();
  await expect(dialog).toBeHidden();
  await expect(scheduleRow()).toHaveCount(2);
  report.checks.push('An uncertain save is resolved by looking up the recorded lesson without another creation');

  for (let index = 0; index < 26; index++) await json(await context.request.post(`${base}/api/admin/schedules`, { data: {
    studentId: created.student.id, dayOfWeek: Math.floor(index / 4), startTime: `${String(9 + index % 4).padStart(2, '0')}:00`, durationMinutes: 30, subject: 'Math',
  } }));
  await page.getByRole('button', { name: 'Refresh schedule' }).click();
  await expect(scheduleRow()).toHaveCount(25);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(scheduleRow()).toHaveCount(3);
  await expect(page.getByText('28 lessons · Page 2 of 2')).toBeVisible();
  await page.getByLabel('Day', { exact: true }).selectOption('2');
  await page.getByLabel('Subject', { exact: true }).selectOption('Reading');
  await expect(scheduleRow()).toHaveCount(1);
  report.checks.push('Pagination and day/subject filters');
  await screenshot('schedule-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('schedule-mobile');
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(widths.page <= widths.viewport + 1, JSON.stringify(widths));
  report.checks.push('Mobile layout contains horizontal table scrolling');
  const history = await json(await context.request.get(`${base}/api/admin/history`));
  assert.equal(history.total, 0, 'Schedule management created attendance facts.');
  await nav().getByRole('button', { name: 'Front desk', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A clear view of the front desk.' })).toBeVisible();
  report.checks.push('Attendance remains empty and front desk navigation still works');
  assert.deepEqual(report.runtimeErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1;
  await screenshot('failure').catch(() => {});
} finally {
  await browser.close();
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
