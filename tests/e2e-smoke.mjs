import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3000';
const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;
if (!email || !password) throw new Error('Set ADMIN_EMAIL and ADMIN_PASSWORD in .env before running browser smoke.');

const outputDir = path.resolve('tmp/browser');
await mkdir(outputDir, { recursive: true });
const suffix = Date.now().toString(36);
const studentName = `Smoke${suffix} Student`;
const inquiryName = `Inquiry${suffix} Learner`;
const guardianName = `Smoke Guardian ${suffix}`;
const report = { baseURL, status: 'running', checks: [], screenshots: [], runtimeErrors: [], layoutWarnings: [] };
const redact = value => String(value).split(password).join('[redacted]').split(email).join('[redacted]');
const browser = await chromium.launch({ headless: process.env.HEADED !== 'true' });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  timezoneId: process.env.CENTER_TIMEZONE || 'America/Los_Angeles',
  acceptDownloads: true,
});
const page = await context.newPage();
page.setDefaultTimeout(15_000);
page.on('pageerror', error => report.runtimeErrors.push(redact(error.message)));

async function screenshot(name) {
  const target = path.join(outputDir, `${name}.png`);
  await page.screenshot({ path: target, fullPage: true, animations: 'disabled' });
  report.screenshots.push(target);
}

async function saved(route, action, method = 'POST') {
  const waiting = page.waitForResponse(response => new URL(response.url()).pathname === `/api${route}` && response.request().method() === method);
  // If an action fails first, closing the page will reject this pending waiter.
  // Attach a handler immediately so the original failure still reaches the report.
  waiting.catch(() => {});
  await action();
  const response = await waiting;
  assert(response.ok(), `${method} ${route} failed with HTTP ${response.status()}`);
  return response.json();
}

async function bootstrap() {
  const response = await context.request.get(`${baseURL}/api/bootstrap`);
  assert(response.ok(), 'Authenticated bootstrap request failed.');
  return response.json();
}

async function navigate(name) {
  // The inquiry navigation link includes its live count in the accessible name.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name }).click();
}

async function openStudent(name) {
  await navigate('Students & families');
  await page.getByRole('textbox', { name: 'Search students', exact: true }).fill(name);
  await page.locator('.student-name-button').filter({ hasText: name }).first().click();
  const profile = page.getByRole('dialog', { name: 'Student profile', exact: true });
  await expect(profile).toBeVisible();
  return profile;
}

try {
  await page.goto(baseURL, { waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Sign in to workspace' })).toBeVisible();
  await screenshot('01-login');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in to workspace' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  report.checks.push('Named staff login');
  const initial = await bootstrap();
  assert(initial.demo, 'Browser smoke requires a fictional demo database.');
  await page.waitForRequest(request => new URL(request.url()).pathname === '/api/bootstrap' && request.headers()['x-background-request'] === '1');
  report.checks.push('Background roster polling identifies itself without extending staff activity');
  await screenshot('02-overview-desktop');

  await page.setViewportSize({ width: 390, height: 844 });
  await screenshot('03-overview-mobile');
  const mobileWidth = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
  if (mobileWidth.page > mobileWidth.viewport + 1) report.layoutWarnings.push(`Overview horizontal overflow at 390px: page width ${mobileWidth.page}px.`);
  await page.setViewportSize({ width: 1440, height: 1000 });

  await navigate('Students & families');
  await page.getByRole('button', { name: 'Add student', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: 'Add a student', exact: true });
  await dialog.getByLabel('First name', { exact: true }).fill(`Smoke${suffix}`);
  await dialog.getByLabel('Last name', { exact: true }).fill('Student');
  await dialog.getByLabel('Grade', { exact: true }).fill('Grade 3');
  await dialog.getByLabel('Guardian name', { exact: true }).fill(guardianName);
  await dialog.getByLabel('Email address', { exact: true }).fill(`smoke-${suffix}@example.invalid`);
  await dialog.getByLabel('Phone number', { exact: true }).fill('2025550110');
  const createdStudent = await saved('/students', () => dialog.getByRole('button', { name: 'Add student', exact: true }).click());
  await expect(dialog).toBeHidden();
  assert(createdStudent.id, 'Student creation did not return an ID.');
  report.checks.push('Student and guardian creation');

  let profile = await openStudent(studentName);
  await screenshot('04-student-profile');
  await profile.getByRole('button', { name: 'Check in', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Check in student', exact: true });
  await dialog.getByRole('checkbox').check();
  const arrival = await saved('/attendance', () => dialog.getByRole('button', { name: 'Confirm check-in', exact: true }).click());
  await expect(dialog).toBeHidden();
  let data = await bootstrap();
  assert.equal(data.visits.filter(visit => visit.studentId === createdStudent.id && visit.status === 'open').length, 1);
  report.checks.push('Observed student arrival');

  profile = await openStudent(studentName);
  await profile.getByRole('button', { name: 'Check out', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Check out student', exact: true });
  await dialog.getByLabel('Who is picking up?', { exact: true }).selectOption(createdStudent.guardians[0].id);
  await dialog.getByRole('checkbox').check();
  await screenshot('05-checkout-confirmation');
  await saved('/attendance', () => dialog.getByRole('button', { name: 'Confirm check-out', exact: true }).click());
  await expect(dialog).toBeHidden();
  data = await bootstrap();
  assert.equal(data.visits.filter(visit => visit.studentId === createdStudent.id && visit.status === 'open').length, 0);
  assert.equal(data.visits.filter(visit => visit.studentId === createdStudent.id && visit.status === 'closed').length, 1);
  report.checks.push('Authorized guardian checkout');

  profile = await openStudent(studentName);
  await profile.getByRole('button', { name: 'Attendance history', exact: true }).click();
  await profile.getByRole('button', { name: 'Correct check_in time', exact: true }).click();
  const correctedTime = await page.evaluate(value => {
    const date = new Date(Date.parse(value) - 60_000);
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, arrival.event.occurredAt);
  await profile.getByLabel('Actual event time', { exact: true }).fill(correctedTime);
  await profile.getByLabel('Reason', { exact: true }).fill('Synthetic browser smoke correction of observed time.');
  await saved(`/attendance/${arrival.event.id}/corrections`, () => profile.getByRole('button', { name: 'Save correction', exact: true }).click());
  await expect(profile.getByText(/Corrected by/)).toBeVisible();
  data = await bootstrap();
  assert.equal(data.events.find(event => event.id === arrival.event.id)?.occurredAt, arrival.event.occurredAt);
  await screenshot('05b-correction-history');
  await profile.getByRole('button', { name: 'Close dialog', exact: true }).click();
  report.checks.push('Manager correction shows attribution and preserves the original event');

  await navigate('Inquiries');
  await page.getByRole('button', { name: 'New inquiry', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Welcome a new family', exact: true });
  await dialog.getByLabel('Parent or guardian name', { exact: true }).fill(guardianName);
  await dialog.getByLabel('Student name', { exact: true }).fill(inquiryName);
  await dialog.getByLabel('Email address', { exact: true }).fill(`inquiry-${suffix}@example.invalid`);
  await dialog.getByLabel('Phone number', { exact: true }).fill('2025550111');
  await dialog.getByLabel('How they found us').selectOption('Other');
  await dialog.getByLabel('Next step', { exact: true }).fill('Synthetic browser smoke follow-up');
  await dialog.getByLabel('Notes', { exact: true }).fill('Fictional record created by the browser smoke test.');
  const inquiry = await saved('/inquiries', () => dialog.getByRole('button', { name: 'Add inquiry', exact: true }).click());
  await expect(dialog).toBeHidden();
  await page.getByRole('textbox', { name: 'Search inquiries' }).fill(inquiryName);
  await page.locator('.inquiry-card').filter({ hasText: inquiryName }).click();
  dialog = page.getByRole('dialog', { name: inquiryName, exact: true });
  const conversion = await saved(`/inquiries/${inquiry.id}/convert`, () => dialog.getByRole('button', { name: 'Enroll student', exact: true }).click());
  await expect(dialog).toBeHidden();
  data = await bootstrap();
  assert(data.students.some(student => student.id === conversion.studentId));
  assert.equal(data.inquiries.find(item => item.id === inquiry.id)?.stage, 'Enrolled');
  await page.getByRole('button', { name: 'Enrolled & closed', exact: true }).click();
  await expect(page.locator('.student-name-button').filter({ hasText: inquiryName })).toBeVisible();
  await screenshot('06-inquiry-conversion');
  report.checks.push('Inquiry creation and enrollment conversion');

  await navigate('Schedule');
  await page.getByRole('button', { name: 'Add lesson', exact: true }).click();
  dialog = page.getByRole('dialog', { name: 'Add a weekly lesson', exact: true });
  await dialog.getByLabel('Student').selectOption(createdStudent.id);
  await dialog.getByLabel('Subject').selectOption('Math');
  await dialog.getByLabel('Day of the week').selectOption('1');
  await dialog.getByLabel('Start time', { exact: true }).fill('17:00');
  await dialog.getByLabel('Duration').selectOption('30');
  const schedule = await saved('/schedules', () => dialog.getByRole('button', { name: 'Add weekly lesson', exact: true }).click());
  await expect(dialog).toBeHidden();
  await page.locator('.calendar-lesson').filter({ hasText: studentName }).click();
  dialog = page.getByRole('dialog', { name: studentName, exact: true });
  await saved(`/schedules/${schedule.id}`, () => dialog.getByRole('button', { name: 'Remove weekly lesson', exact: true }).click(), 'PATCH');
  await expect(dialog).toBeHidden();
  data = await bootstrap();
  assert.equal(data.schedules.find(item => item.id === schedule.id)?.active, false);
  assert.equal(data.visits.filter(visit => visit.studentId === createdStudent.id).length, 1);
  await screenshot('07-schedule');
  report.checks.push('Recurring lesson creation and cancellation preserve attendance');

  await navigate('Reports');
  await screenshot('08-reports');
  const waitingDownload = page.waitForEvent('download');
  waitingDownload.catch(() => {});
  await page.getByRole('link', { name: 'Export attendance' }).click();
  const download = await waitingDownload;
  const csvPath = path.join(outputDir, 'attendance-smoke.csv');
  await download.saveAs(csvPath);
  const csv = await readFile(csvPath, 'utf8');
  assert(csv.includes('Original occurred UTC'));
  assert(csv.includes(createdStudent.id));
  assert(csv.includes('check_in') && csv.includes('check_out'));
  report.checks.push('Attendance CSV download');

  await page.reload({ waitUntil: 'networkidle' });
  data = await bootstrap();
  assert(data.students.some(student => student.id === createdStudent.id));
  assert(data.students.some(student => student.id === conversion.studentId));
  report.checks.push('Created records survive page reload');

  await page.locator('.user-button').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in to workspace', exact: true })).toBeVisible();
  const afterLogout = await context.request.get(`${baseURL}/api/bootstrap`);
  assert.equal(afterLogout.status(), 401);
  report.checks.push('Logout invalidates the session');
  assert.deepEqual(report.runtimeErrors, [], 'Browser runtime errors were reported.');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = redact(error.stack || error);
  await screenshot('failure').catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
  await writeFile(path.join(outputDir, 'smoke-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
