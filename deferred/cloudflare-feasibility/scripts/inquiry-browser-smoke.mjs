// Only scripts/dev-local.ts: synthetic Access identity, disposable empty D1.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.INQUIRY_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Set INQUIRY_TEST_BASE_URL to an isolated local preview.');
const output = path.resolve('tmp/inquiry-browser'); await mkdir(output, { recursive: true });
const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const report = { checks: [], runtimeErrors: [], screenshots: [], status: 'running' };
page.on('pageerror', error => report.runtimeErrors.push(error.message));
const json = async response => { const value = await response.json(); assert(response.ok(), JSON.stringify(value)); return value; };
const screenshot = async name => { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target, fullPage: true }); report.screenshots.push(target); };
const nav = () => page.getByRole('navigation', { name: 'Workspace sections' });
const row = name => page.locator('.cf-inquiries-table tbody tr').filter({ hasText: name });
async function fill(name = 'Inquiry Learner') {
  await page.getByRole('button', { name: 'New inquiry', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'New family inquiry' });
  await dialog.getByLabel('Contact name', { exact: true }).fill('Inquiry Guardian');
  await dialog.getByLabel('Student name', { exact: true }).fill(name);
  await dialog.getByLabel('Email', { exact: true }).fill('inquiry@example.test');
  await dialog.getByLabel('Phone', { exact: true }).fill('555-0179');
  await dialog.getByLabel('Reading', { exact: true }).check();
  await dialog.getByLabel('Next step', { exact: true }).fill('Arrange assessment');
  await dialog.getByLabel('Due date', { exact: true }).fill('2027-02-18');
  await dialog.getByLabel('Notes', { exact: true }).fill('Interested in afternoon lessons.');
  return dialog;
}
try {
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  assert.equal((await json(await context.request.get(`${base}/api/admin/students`))).total, 0, 'Requires an empty temporary database.');
  assert.equal((await json(await context.request.get(`${base}/api/admin/inquiries?view=all`))).total, 0, 'Requires an empty temporary database.');
  await nav().getByRole('button', { name: 'Inquiries', exact: true }).click();
  await expect(page.getByText('No inquiries in this view')).toBeVisible();
  let dialog = await fill();
  await dialog.getByRole('button', { name: 'Add inquiry', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(row('Inquiry Learner')).toHaveCount(1);
  await expect(row('Inquiry Learner')).toContainText('Math · Reading');
  await expect(row('Inquiry Learner')).toContainText('Feb 18, 2027');
  const created = (await json(await context.request.get(`${base}/api/admin/inquiries`))).items[0];
  assert.equal(created.dueAt, '2027-02-18T20:00:00.000Z');
  report.checks.push('Creates a family inquiry with contacts, subjects, notes, and a center-local due date');

  await page.getByRole('button', { name: 'Follow-ups', exact: true }).click();
  await expect(page.locator('.cf-followup-item')).toContainText('Arrange assessment');
  await page.getByRole('button', { name: 'Complete Arrange assessment' }).click();
  await expect(page.getByText('No follow-ups in this view')).toBeVisible();
  await page.getByLabel('Task status', { exact: true }).selectOption('completed');
  await expect(page.locator('.cf-followup-item')).toContainText('Completed');
  report.checks.push('Lists and completes follow-ups, with completed work retained');

  await page.getByRole('button', { name: 'Active pipeline', exact: true }).click();
  await row('Inquiry Learner').getByRole('button').click();
  dialog = page.getByRole('dialog', { name: 'Inquiry Learner', exact: true });
  await dialog.getByLabel('Inquiry stage', { exact: true }).selectOption('Closed lost');
  await dialog.getByLabel('Notes', { exact: true }).fill('');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('reason in notes');
  await dialog.getByLabel('Inquiry stage', { exact: true }).selectOption('Assessment scheduled');
  await dialog.getByLabel('Notes', { exact: true }).fill('Assessment arranged with the family.');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog).toBeHidden(); await expect(row('Inquiry Learner')).toContainText('Assessment scheduled');
  report.checks.push('Requires a loss reason and saves stage and notes changes');

  await row('Inquiry Learner').getByRole('button').click(); dialog = page.getByRole('dialog', { name: 'Inquiry Learner', exact: true });
  await json(await context.request.patch(`${base}/api/admin/inquiries/${created.id}`, { data: { expectedVersion: 2, notes: 'Another staff update.' } }));
  await dialog.getByLabel('Notes', { exact: true }).fill('Stale browser edit');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Reload saved inquiry' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Reload saved inquiry' }).click();
  await expect(dialog.getByLabel('Notes', { exact: true })).toHaveValue('Another staff update.');
  report.checks.push('A stale edit requires reloading the saved inquiry');

  await dialog.getByRole('button', { name: 'Enroll student', exact: true }).click();
  await dialog.getByLabel('Grade · optional', { exact: true }).fill('4');
  let conversions = 0;
  await page.route('**/api/admin/inquiries/*/convert', async route => {
    const response = await route.fetch(); assert.equal(response.status(), 200); conversions++; await response.dispose(); await route.abort('failed');
  });
  await dialog.getByRole('button', { name: 'Confirm enrollment' }).click();
  await expect(dialog.getByRole('alert')).toContainText('retry enrollment safely');
  await page.unrouteAll({ behavior: 'wait' });
  await dialog.getByRole('button', { name: 'Confirm enrollment' }).click();
  await expect(dialog.getByText('Enrolled. The student record retains', { exact: false })).toBeVisible();
  const directory = await json(await context.request.get(`${base}/api/admin/students`)); assert.equal(directory.total, 1); assert.equal(conversions, 1);
  await dialog.getByRole('button', { name: 'View student' }).click();
  const profile = page.getByRole('dialog', { name: 'Student details' });
  await expect(profile.getByText(/Grade 4/)).toBeVisible(); await expect(profile.getByText('Unverified', { exact: true })).toBeVisible();
  await expect(profile.getByText('Inquiry Guardian', { exact: true })).toBeVisible(); await expect(profile.getByText('No attendance has been recorded.')).toBeVisible();
  await profile.getByRole('button', { name: 'Close dialog' }).click();
  report.checks.push('Lost conversion response retries safely with one student, saved grade, unverified pickup, and no attendance');

  dialog = await fill('Retry Learner'); let creates = 0;
  await page.route('**/api/admin/inquiries', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch(); assert.equal(response.status(), 201); creates++; await response.dispose(); await route.abort('failed');
  });
  await dialog.getByRole('button', { name: 'Add inquiry', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Retry same inquiry' })).toBeVisible();
  await expect(nav().getByRole('button', { name: 'Front desk', exact: true })).toBeDisabled();
  await page.unrouteAll({ behavior: 'wait' });
  await dialog.getByRole('button', { name: 'Retry same inquiry' }).click();
  await expect(dialog).toBeHidden(); await expect(row('Retry Learner')).toHaveCount(1);
  assert.equal(creates, 1); assert.equal((await json(await context.request.get(`${base}/api/admin/inquiries?view=all`))).total, 2);
  report.checks.push('Lost creation response retains the same request and blocks navigation until safely retried');

  for (let index = 0; index < 25; index++) await json(await context.request.post(`${base}/api/admin/inquiries`, { data: { contactName: `Sample Guardian ${index}`, studentName: `Sample Learner ${index}`, email: `sample-${index}@example.test`, subjects: ['Reading'], source: 'Referral', nextAction: 'Call family' } }));
  await page.getByRole('button', { name: 'Refresh inquiries' }).click();
  await expect(page.locator('.cf-inquiries-table tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Next', exact: true }).click(); await expect(page.locator('.cf-inquiries-table tbody tr')).toHaveCount(1);
  await page.getByLabel('Search inquiries').fill('Retry Learner'); await expect(row('Retry Learner')).toHaveCount(1);
  await page.getByLabel('Stage filter').selectOption('Contacted'); await expect(page.getByText('No inquiries in this view')).toBeVisible();
  await page.getByLabel('Stage filter').selectOption('all'); await page.getByLabel('Search inquiries').fill('');
  await expect(page.locator('.cf-inquiries-table tbody tr')).toHaveCount(25);
  await screenshot('inquiries-desktop');
  await page.setViewportSize({ width: 390, height: 844 }); await screenshot('inquiries-mobile');
  const widths = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth })); assert(widths.page <= widths.viewport + 1, JSON.stringify(widths));
  report.checks.push('Inquiry pagination, family search, stage filters, and mobile containment');
  await nav().getByRole('button', { name: 'Front desk', exact: true }).click(); await expect(page.getByRole('heading', { name: 'A clear view of the front desk.' })).toBeVisible();
  assert.deepEqual(report.runtimeErrors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack || error); process.exitCode = 1; await screenshot('failure').catch(() => {}); }
finally { await browser.close(); await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
