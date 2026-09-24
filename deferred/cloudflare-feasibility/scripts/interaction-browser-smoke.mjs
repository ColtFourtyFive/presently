// Requires scripts/dev-local.ts: synthetic identity, disposable empty D1 only.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const base = process.env.INTERACTION_TEST_BASE_URL;
if (!base || !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Set INTERACTION_TEST_BASE_URL to an isolated local preview.');
const output = path.resolve('tmp/interaction-browser'); await mkdir(output, { recursive: true });
const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(); page.setDefaultTimeout(15000);
const report = { checks: [], runtimeErrors: [], screenshots: [], status: 'running' };
page.on('pageerror', error => report.runtimeErrors.push(error.message));
const json = async response => { const value = await response.json(); assert(response.ok(), JSON.stringify(value)); return value; };
const screenshot = async name => { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target, fullPage: true }); report.screenshots.push(target); };
try {
  await page.goto(`${base}/admin`, { waitUntil: 'networkidle' });
  assert.equal((await json(await context.request.get(`${base}/api/admin/students`))).total, 0, 'Requires an empty temporary database.');
  const { student } = await json(await context.request.post(`${base}/api/admin/students`, { data: { studentCode: 'COMMUNICATION-SMOKE', firstName: 'Communication', lastName: 'Learner', subjects: ['Math'], guardians: [] } }));
  const endpoint = `${base}/api/admin/students/${student.id}/interactions`;
  const nav = page.getByRole('navigation', { name: 'Workspace sections' });
  await nav.getByRole('button', { name: 'Students', exact: true }).click();
  await page.locator('.cf-student-button').filter({ hasText: 'Communication Learner' }).click();
  let dialog = page.getByRole('dialog', { name: 'Student details' });
  const history = () => dialog.locator('.cf-interactions');
  await expect(history().getByText('No communication has been logged.')).toBeVisible();
  await history().getByLabel('Contact channel', { exact: true }).selectOption('Email');
  await history().getByLabel('Communication summary', { exact: true }).fill('Guardian confirmed the revised lesson schedule.\nReview again next month.');
  await history().getByRole('button', { name: 'Log communication', exact: true }).click();
  await expect(history().getByRole('status')).toHaveText('Communication logged.');
  await expect(history().locator('article')).toHaveCount(1);
  await expect(history().locator('article')).toContainText('Email');
  await expect(history().locator('article')).toContainText('Logged by');
  await expect(history().getByLabel('Communication summary', { exact: true })).toHaveValue('');
  report.checks.push('Empty history, channel selection, multiline log, author/time, confirmed save, and reset form');

  const attempts = [];
  await page.route('**/api/admin/students/*/interactions', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push(route.request().postDataJSON());
    const response = await route.fetch();
    if (attempts.length === 1) { assert.equal(response.status(), 201); await response.dispose(); return route.abort('failed'); }
    assert.equal(response.status(), 200); return route.fulfill({ response });
  });
  await history().getByLabel('Communication summary', { exact: true }).fill('Phone call: family will bring the updated contact details.');
  await history().getByLabel('Contact channel', { exact: true }).selectOption('Phone');
  await history().getByRole('button', { name: 'Log communication', exact: true }).click();
  await expect(history().getByRole('button', { name: 'Retry same entry', exact: true })).toBeVisible();
  await expect(history().getByLabel('Communication summary', { exact: true })).toBeDisabled();
  await expect(nav.getByRole('button', { name: 'Students', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeVisible();
  await screenshot('pending-entry');

  // Authentication may expire while confirmation is pending. Preserve the same
  // in-memory request and original actor when the profile is unmounted/reopened.
  await page.route('**/api/admin/students/*/interactions', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Synthetic expired access.' } }) });
  }, { times: 1 });
  await history().getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your center.' })).toBeVisible();
  await expect(page.getByText('A request still needs confirmation.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Already signed in? Try again', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Student details' });
  await expect(history().getByRole('button', { name: 'Retry same entry', exact: true })).toBeVisible();
  await history().getByRole('button', { name: 'Retry same entry', exact: true }).click();
  await expect(history().getByRole('status')).toHaveText('Communication logged.');
  await expect(history().locator('article')).toHaveCount(2);
  assert.equal(attempts.length, 2); assert.deepEqual(attempts[1], attempts[0]);
  assert.equal((await json(await context.request.get(endpoint))).items.length, 2);
  await page.unroute('**/api/admin/students/*/interactions');
  report.checks.push('Lost response blocks dismissal/navigation, survives reauthentication, and retries exactly once without duplicate log');

  for (let index = 0; index < 26; index++) await json(await context.request.post(endpoint, { data: { interactionId: crypto.randomUUID(), channel: 'Other', summary: `Synthetic older communication ${index + 1}` } }));
  await history().getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(history().locator('article')).toHaveCount(25);
  await history().getByRole('button', { name: 'Load older entries', exact: true }).click();
  await expect(history().locator('article')).toHaveCount(28);
  await expect(history().getByRole('button', { name: 'Load older entries', exact: true })).toHaveCount(0);
  report.checks.push('Loads bounded history pages with no duplicate entries');
  await dialog.locator('.modal-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await screenshot('communication-history');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(dialog).toBeHidden();
  assert.deepEqual(report.runtimeErrors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error?.stack || error); await screenshot('failure'); process.exitCode = 1; }
finally { await writeFile(path.join(output, 'results.json'), JSON.stringify(report, null, 2)); await context.close(); await browser.close(); }
console.log(JSON.stringify(report, null, 2));
