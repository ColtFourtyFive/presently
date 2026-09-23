// Local UI-only smoke with explicit synthetic API responses. Real Worker/D1/R2
// authorization and integrity are covered in tests/archive-reader.test.ts.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';

const output = path.resolve('tmp/archive-reader-browser'); await mkdir(output, { recursive: true });
const temporary = await mkdtemp(path.resolve('tmp/archive-reader-page-'));
await writeFile(path.join(temporary, 'index.html'), '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import React from "react";import {createRoot} from "react-dom/client";import ArchiveReader from "/client/ArchiveReader.tsx";import "/client/shared/base.css";import "/client/styles.css";function Demo(){const[open,setOpen]=React.useState(true);return open?React.createElement(ArchiveReader,{onClose:()=>setOpen(false)}):React.createElement("p",null,"Reader closed")}createRoot(document.getElementById("root")).render(React.createElement(Demo));</script></body></html>');
const server = await createServer({ configFile: false, plugins: [react()], server: { host: '127.0.0.1', port: 0 }, root: process.cwd(), resolve: { dedupe: ['react', 'react-dom'] } });
await server.listen(); const port = server.httpServer.address().port;
const browser = await chromium.launch(), context = await browser.newContext({ viewport: { width: 1400, height: 1000 } }), page = await context.newPage(); page.setDefaultTimeout(15000);
const report = { status: 'running', scope: 'Synthetic local UI smoke; no remote resources.', checks: [], screenshots: [], runtimeErrors: [] };
page.on('pageerror', error => report.runtimeErrors.push(error.message));
const snapshot = { id: 'snapshot-1', month: '2025-01', timezone: 'America/Los_Angeles', capturedAt: '2025-05-01T15:00:00.000Z', verifiedAt: '2025-05-01T15:02:00.000Z', recordCounts: { students: 2, visits: 1 }, manifestSha256: 'a'.repeat(64) };
const student = { table: 'students', key: 'student-1', row: { id: 'student-1', center_id: 'test-center', student_code: 'ARCHIVE-SMOKE-1', first_name: 'Archive', last_name: 'Learner', active: 1, subjects: '["Math"]' } };
const another = { table: 'students', key: 'student-2', row: { ...student.row, id: 'student-2', student_code: 'ARCHIVE-SMOKE-2', first_name: 'Second' } };
const visit = { table: 'visits', key: 'visit-1', row: { id: 'visit-1', center_id: 'test-center', student_id: 'student-1', check_in_at: '2025-01-10T18:05:00.000Z', original_check_in_at: '2025-01-10T18:00:00.000Z', check_out_at: '2025-01-10T19:00:00.000Z', original_check_out_at: '2025-01-10T19:00:00.000Z', check_in_by: 'staff-1', version: 2 } };
let unavailable = false; const methods = [];
await page.route('**/api/admin/archive-history**', async route => {
  methods.push(route.request().method()); const url = new URL(route.request().url());
  if (!url.pathname.endsWith('/records/query')) return route.fulfill({ json: { items: [snapshot], nextCursor: null, mode: 'verified-copy' } });
  if (unavailable) return route.fulfill({ status: 503, json: { error: { code: 'ARCHIVE_UNAVAILABLE', message: 'This historical copy could not be verified. Its contents are unavailable; this is not an empty history result.' } } });
  assert.equal(url.search, '', 'Private record filters must not appear in logged URLs.');
  const filters = route.request().postDataJSON();
  const table = filters.table, cursor = filters.cursor; let items = table === 'visits' ? [visit] : cursor ? [another] : [student], nextCursor = table === 'students' && !cursor ? 'next-students' : null;
  if (filters.q === 'no-match') { items = []; nextCursor = cursor ? null : 'next-empty'; }
  await route.fulfill({ json: { snapshot, table, items, nextCursor, pageVerified: true, searchComplete: !nextCursor, mode: 'verified-copy' } });
});
try {
  await page.goto(`http://127.0.0.1:${port}/${path.relative(process.cwd(), temporary)}/index.html`, { waitUntil: 'networkidle' });
  const dialog = page.getByRole('dialog', { name: 'Review historical copies' });
  await expect(dialog.getByText(/copies captured at a point in time/)).toBeVisible();
  await dialog.locator('.cf-archive-copy').click();
  await expect(dialog.getByText(/Captured.*Copy verified/)).toBeVisible();
  await expect(dialog.locator('.cf-archive-record')).toContainText('Archive Learner');
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(dialog.locator('.cf-archive-record')).toContainText('Second Learner');
  await dialog.getByRole('button', { name: 'Previous page', exact: true }).click(); await expect(dialog.locator('.cf-archive-record')).toContainText('Archive Learner');
  report.checks.push('Catalog selection, capture timestamp, snapshot caveat, forward/back paging');
  await dialog.getByRole('button', { name: 'Review attendance', exact: true }).click();
  await expect(dialog.getByLabel('Student reference', { exact: false })).toHaveValue('student-1');
  await dialog.getByText('View recorded details', { exact: true }).click(); await expect(dialog.getByText('Effective arrival', { exact: true })).toBeVisible(); await expect(dialog.getByText('Original arrival', { exact: true })).toBeVisible();
  report.checks.push('Student-to-attendance lookup and original/effective evidence inspection');
  const screenshot = async name => { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target, fullPage: true }); report.screenshots.push(target); };
  await screenshot('desktop-record');
  unavailable = true; await dialog.getByLabel('Evidence', { exact: true }).selectOption('students'); await expect(dialog.getByRole('alert')).toContainText('not an empty history result'); await expect(dialog.locator('.cf-archive-record')).toHaveCount(0);
  unavailable = false; await dialog.getByRole('button', { name: 'Try again', exact: true }).click(); await expect(dialog.locator('.cf-archive-record')).toHaveCount(1);
  report.checks.push('Unavailable files display an explicit error, clear old evidence, and support retry');
  await dialog.getByLabel('Name, reference, or note', { exact: true }).fill('no-match'); await dialog.getByRole('button', { name: 'Review records', exact: true }).click(); await expect(dialog.getByText('No matches on this page. More archived records remain to check.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Next page', exact: true }).click(); await expect(dialog.getByText('No matches on this final page.')).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  report.checks.push('Empty bounded pages are distinguished from the end of a search');
  await page.setViewportSize({ width: 834, height: 1112 }); await screenshot('tablet-search'); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0); assert(methods.every(method => ['GET', 'POST'].includes(method))); assert(methods.includes('POST'));  assert.deepEqual(report.runtimeErrors, []);
  report.checks.push('Tablet width fits; no browser storage; private filters excluded from request URLs; no runtime errors');
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click(); await expect(dialog).toHaveCount(0); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; throw error; }
finally { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); await browser.close(); await server.close(); await rm(temporary, { recursive: true, force: true }); }
console.log(JSON.stringify(report, null, 2));
