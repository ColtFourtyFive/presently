import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime, projectRoot, testAudience, testIssuer, type QueryResult } from '../tests/runtime.js';
import { fixtureId, seedGrowthFixture } from './fixtures.js';
import type { Actor } from '../shared/types.js';
import { REPORT_PHASES, type ReportPage } from '../shared/attendance-report.js';

type Metrics = { rowsRead: number; rowsWritten: number; statements: number; unmeasuredCalls: number };
type Sample = Metrics & { action: string; status: number; localWallMs: number; responseBytes: number };
type RosterPayload = { revision?: unknown; unchanged?: unknown };
const argument = process.argv.find(value => value.startsWith('--days='));
const days = argument ? Number(argument.split('=')[1]) : 400;
if (!Number.isInteger(days) || days < 2 || days > 420) throw new Error('Use --days=2..420. Default is the complete 400-day workload.');
const app = await createRuntime({ metrics: true, bindings: {
  APP_ENV: 'production', CENTER_ID: 'test-center', APP_VERSION: 'isolated-benchmark',
  ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience, BOOTSTRAP_OWNER_EMAIL: 'owner@example.test',
} });
try {
  const token = await app.signer.token({ exp: Math.floor(Date.now() / 1000) + 7200 });
  const sessionResponse = await app.request('/api/admin/session', { token });
  if (sessionResponse.status !== 200) throw new Error(`Synthetic owner setup failed: ${await sessionResponse.text()}`);
  const { actor } = await sessionResponse.json() as { actor: Actor };
  const fixture = await seedGrowthFixture(app.db, actor, days, console.log);
  const samples: Sample[] = [];
  const exportPages: Record<string, number> = {};
  async function measure(action: string, path: string, body?: unknown, headers?: Record<string, string>, method?: string) {
    const start = performance.now();
    const response = await app.request(path, { token, headers, method, ...(body === undefined ? {} : { body }) });
    const text = await response.text();
    const localWallMs = performance.now() - start;
    if (!response.ok) throw new Error(`${action} failed: ${response.status} ${text}`);
    const counters = response.headers.get('x-isolated-d1-metrics');
    if (!counters) throw new Error(`Missing D1 counters for ${action}`);
    samples.push({ action, status: response.status, localWallMs, responseBytes: Buffer.byteLength(text), ...JSON.parse(counters) as Metrics });
    return { text, headers: response.headers };
  }
  function rosterRevision(action: string, text: string, unchanged: boolean) {
    const value = JSON.parse(text) as RosterPayload;
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || (unchanged && value.unchanged !== true) || (!unchanged && value.unchanged === true)) {
      throw new Error(`${action} returned an invalid roster payload.`);
    }
    return Number(value.revision);
  }
  // Populate a realistic current roster without changing historical fixtures.
  for (let index = 0; index < 20; index++) {
    const response = await app.request('/api/admin/attendance', { token, body: {
      eventId: crypto.randomUUID(), studentId: fixtureId(1, index), action: 'check_in', observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    } });
    if (response.status !== 201) throw new Error(`Current-roster fixture failed: ${await response.text()}`);
    await response.body?.cancel();
  }
  const adminRoster20 = await measure('roster changed snapshot 20 present', '/api/admin/roster');
  const adminRevision20 = rosterRevision('roster changed snapshot 20 present', adminRoster20.text, false);
  for (let index = 0; index < 10; index++) {
    const unchanged = await measure('roster unchanged poll 20 present', `/api/admin/roster?revision=${adminRevision20}`);
    rosterRevision('roster unchanged poll 20 present', unchanged.text, true);
  }
  for (let index = 0; index < 5; index++) await measure('student search', '/api/admin/students?q=Family&pageSize=25');
  for (let index = 0; index < 5; index++) await measure('student detail', `/api/admin/students/${fixtureId(1, index)}`);
  const reportFrom = new Date(Date.parse(`${fixture.to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  await measure('history page', `/api/admin/history?from=${reportFrom}&to=${fixture.to}&pageSize=50`);
  let exportEpoch: number | undefined, exportGeneration: string | undefined;
  for (const phase of REPORT_PHASES) {
    let after: string | null = null;
    do {
      const params = new URLSearchParams({ from: reportFrom, to: fixture.to, phase });
      if (exportEpoch !== undefined && exportGeneration !== undefined) {
        params.set('epoch', String(exportEpoch)); params.set('generation', exportGeneration);
      }
      if (after) params.set('after', after);
      const action = `30-day attendance export ${phase} page`;
      const result = await measure(action, `/api/admin/reports/attendance/pages?${params}`);
      const page = JSON.parse(result.text) as ReportPage;
      if (page.phase !== phase || !Number.isSafeInteger(page.epoch) || !/^[a-f0-9]{32}$/.test(page.generation) || (page.next !== null && typeof page.next !== 'string')) {
        throw new Error(`${action} returned an invalid export page.`);
      }
      if (exportEpoch === undefined) { exportEpoch = page.epoch; exportGeneration = page.generation; }
      if (page.epoch !== exportEpoch || page.generation !== exportGeneration) throw new Error(`${action} changed export identity.`);
      exportPages[action] = (exportPages[action] || 0) + 1;
      after = page.next;
    } while (after);
  }
  await measure('arrival', '/api/admin/attendance', { eventId: crypto.randomUUID(), studentId: fixtureId(1, 20), action: 'check_in', observedAt: new Date(Date.now() - 120_000).toISOString() });
  await measure('departure', '/api/admin/attendance', { eventId: crypto.randomUUID(), studentId: fixtureId(1, 20), action: 'check_out', observedAt: new Date(Date.now() - 60_000).toISOString(), guardianId: fixtureId(2, Math.floor(20 * 230 / 340) * 2) });
  await measure('staff PIN provisioning', `/api/admin/staff/${actor.id}`, { kioskEnabled: true, pin: '48271639' }, undefined, 'PATCH');
  const grant = JSON.parse((await measure('device enrollment grant', '/api/admin/devices/enrollment', {})).text) as { token: string };
  const enrolled = await measure('device enrollment', '/api/kiosk/enroll', { token: grant.token, label: 'Synthetic benchmark kiosk' });
  const cookies = new Map<string, string>();
  const remember = (headers: typeof enrolled.headers) => { for (const cookie of headers.getSetCookie()) { const pair = cookie.split(';')[0], split = pair.indexOf('='); cookies.set(pair.slice(0, split), pair.slice(split + 1)); } };
  const cookieHeader = () => ({ cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') });
  remember(enrolled.headers);
  for (let index = 0; index < 3; index++) remember((await measure('kiosk PIN unlock', '/api/kiosk/unlock', { staffId: actor.id, pin: '48271639' }, cookieHeader())).headers);
  const kioskRoster20 = await measure('kiosk roster changed snapshot 20 present', '/api/kiosk/roster', undefined, cookieHeader());
  const kioskRevision20 = rosterRevision('kiosk roster changed snapshot 20 present', kioskRoster20.text, false);
  for (let index = 0; index < 10; index++) {
    const unchanged = await measure('kiosk roster unchanged poll 20 present', `/api/kiosk/roster?revision=${kioskRevision20}`, undefined, cookieHeader());
    rosterRevision('kiosk roster unchanged poll 20 present', unchanged.text, true);
  }
  await measure('kiosk activity touch', '/api/kiosk/touch', {}, cookieHeader());
  await measure('kiosk arrival', '/api/kiosk/attendance', { eventId: crypto.randomUUID(), studentId: fixtureId(1, 100), action: 'check_in', observedAt: new Date(Date.now() - 120_000).toISOString() }, cookieHeader());
  await measure('kiosk departure', '/api/kiosk/attendance', { eventId: crypto.randomUUID(), studentId: fixtureId(1, 100), action: 'check_out', observedAt: new Date(Date.now() - 60_000).toISOString(), guardianId: fixtureId(2, Math.floor(100 * 230 / 340) * 2) }, cookieHeader());
  for (let index = 20; index < 100; index++) {
    const response = await app.request('/api/admin/attendance', { token, body: { eventId: crypto.randomUUID(), studentId: fixtureId(1, index), action: 'check_in', observedAt: new Date(Date.now() - 60_000).toISOString() } });
    if (response.status !== 201) throw new Error(`Peak roster fixture failed: ${await response.text()}`);
    await response.body?.cancel();
  }
  const adminRoster100 = await measure('peak roster changed snapshot 100 present', '/api/admin/roster');
  const adminRevision100 = rosterRevision('peak roster changed snapshot 100 present', adminRoster100.text, false);
  for (let index = 0; index < 5; index++) {
    const unchanged = await measure('peak roster unchanged poll 100 present', `/api/admin/roster?revision=${adminRevision100}`);
    rosterRevision('peak roster unchanged poll 100 present', unchanged.text, true);
  }
  const kioskRoster100 = await measure('peak kiosk roster changed snapshot 100 present', '/api/kiosk/roster', undefined, cookieHeader());
  const kioskRevision100 = rosterRevision('peak kiosk roster changed snapshot 100 present', kioskRoster100.text, false);
  for (let index = 0; index < 5; index++) {
    const unchanged = await measure('peak kiosk roster unchanged poll 100 present', `/api/kiosk/roster?revision=${kioskRevision100}`, undefined, cookieHeader());
    rosterRevision('peak kiosk roster unchanged poll 100 present', unchanged.text, true);
  }

  const tableNames = (await app.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all<{ name: string }>()).results.map(row => row.name);
  const tableKinds = new Map((await app.db.prepare('PRAGMA table_list').all<{ name: string; wr: number }>()).results.map(row => [row.name, row.wr]));
  const tableCounts: Record<string, number> = {};
  let exportRowsRead = 0, exportStatements = 0, exportJsonBytes = 0;
  // A stable isolated database permits measuring a bounded full-table scan.
  // This is a scan lower bound, not proof of the production backup protocol.
  for (const name of tableNames) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('Unexpected fixture table name');
    let count = 0;
    if (tableKinds.get(name) === 1) {
      const keys = (await app.db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string; pk: number }>()).results.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
      if (!keys.length || keys.some(key => !/^[a-z_][a-z0-9_]*$/.test(key))) throw new Error(`Missing safe primary key for ${name}`);
      const columns = keys.map(key => `"${key}"`).join(',');
      let cursor: unknown[] | null = null;
      for (;;) {
        const where = cursor ? keys.length === 1 ? `WHERE "${keys[0]}">?` : `WHERE (${columns})>(${keys.map(() => '?').join(',')})` : '';
        const statement = app.db.prepare(`SELECT * FROM "${name}" ${where} ORDER BY ${columns} LIMIT 500`);
        const page: QueryResult = await (cursor ? statement.bind(...cursor) : statement).all();
        exportRowsRead += page.meta.rows_read; exportStatements++;
        exportJsonBytes += Buffer.byteLength(JSON.stringify(page.results));
        count += page.results.length;
        if (!page.results.length) break;
        cursor = keys.map(key => page.results.at(-1)![key]);
      }
    } else {
      let cursor = 0;
      for (;;) {
        const page: QueryResult = await app.db.prepare(`SELECT rowid AS __rowid,* FROM "${name}" WHERE rowid>? ORDER BY rowid LIMIT 500`).bind(cursor).all();
        exportRowsRead += page.meta.rows_read; exportStatements++;
        exportJsonBytes += Buffer.byteLength(JSON.stringify(page.results));
        count += page.results.length;
        if (!page.results.length) break;
        cursor = Number(page.results.at(-1)!.__rowid);
      }
    }
    tableCounts[name] = count;
  }
  const sizeProbe = await app.db.prepare('SELECT 1 AS probe').all();
  const databaseBytes = Number(sizeProbe.meta.size_after);
  if (!Number.isFinite(databaseBytes)) throw new Error('D1 did not return measured database size.');
  const actions = Object.fromEntries([...new Set(samples.map(s => s.action))].map(action => {
    const values = samples.filter(s => s.action === action);
    const mean = (field: keyof Metrics | 'localWallMs' | 'responseBytes') => values.reduce((n, s) => n + s[field], 0) / values.length;
    return [action, { samples: values.length, rowsRead: mean('rowsRead'), rowsWritten: mean('rowsWritten'), statements: mean('statements'), unmeasuredCalls: mean('unmeasuredCalls'), localWallMs: mean('localWallMs'), responseBytes: mean('responseBytes') }];
  }));
  function project(pollSeconds: number, peak = false) {
    const attendanceChanges = 300, adminDevices = 3, kioskDevices = 1, operatingHours = 6;
    const adminPolls = adminDevices * operatingHours * 3600 / pollSeconds;
    const kioskPolls = kioskDevices * operatingHours * 3600 / pollSeconds;
    const adminChanged = Math.min(adminPolls, adminDevices * attendanceChanges);
    const labels = peak ? {
      adminChanged: 'peak roster changed snapshot 100 present', adminUnchanged: 'peak roster unchanged poll 100 present',
      kioskChanged: 'peak kiosk roster changed snapshot 100 present', kioskUnchanged: 'peak kiosk roster unchanged poll 100 present',
    } : {
      adminChanged: 'roster changed snapshot 20 present', adminUnchanged: 'roster unchanged poll 20 present',
      kioskChanged: 'kiosk roster changed snapshot 20 present', kioskUnchanged: 'kiosk roster unchanged poll 20 present',
    };
    const counts = {
      [labels.adminChanged]: adminChanged + adminDevices,
      [labels.adminUnchanged]: adminPolls - adminChanged,
      [labels.kioskChanged]: attendanceChanges + kioskDevices,
      [labels.kioskUnchanged]: kioskPolls,
      'student search': 120, 'student detail': 240, 'history page': 12,
      ...Object.fromEntries(Object.entries(exportPages).map(([action, pages]) => [action, pages * 2])),
      'kiosk arrival': 150, 'kiosk departure': 150, 'kiosk PIN unlock': 8, 'kiosk activity touch': 100,
    };
    let requests = 0, rowsRead = exportRowsRead, rowsWritten = 0;
    for (const [action, count] of Object.entries(counts)) {
      const measured = actions[action];
      if (!measured) throw new Error(`Missing benchmark action: ${action}`);
      requests += count; rowsRead += count * measured.rowsRead; rowsWritten += count * measured.rowsWritten;
    }
    return {
      pollSeconds, concurrentPresence: peak ? 100 : 20, apiRequests: requests, rowsRead, rowsWritten, counts,
      rosterModel: { operatingHours, adminDevices, kioskDevices, attendanceChanges, initialSnapshots: adminDevices + kioskDevices, explicitPostAttendanceKioskRefreshes: attendanceChanges },
      exclusions: ['scheduled Worker invocations and backup bookkeeping', 'device provisioning and credential rotation', 'imports', 'broader CRM edits', 'other customer-account workloads'],
    };
  }
  const report = {
    generatedAt: new Date().toISOString(), runtime: 'local Miniflare workerd/D1', fixture,
    status: 'Partial local feasibility evidence; cloud capacity gate unresolved',
    tableCounts, databaseBytes,
    actions, samples, reportRange: { from: reportFrom, to: fixture.to }, exportScanLowerBound: { rowsRead: exportRowsRead, statements: exportStatements, jsonBytes: exportJsonBytes },
    attendanceExportPageCounts: exportPages,
    dailyProjection: project(30), moreFrequentPolling: project(10), peakAllDayProjection: project(10, true),
    unresolved: ['deployed Worker CPU and request limits', 'deployed D1 concurrency and quota behavior', 'actual scheduled backup consistency/encryption/R2 execution', 'independent-account restore and Time Travel', 'schedules/interactions/inquiries/tasks and their notes', 'shared account consumption'],
  };
  await writeFile(join(projectRoot, 'tests/benchmark-results.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ fixture, tableCounts, databaseBytes: report.databaseBytes, exportScanLowerBound: report.exportScanLowerBound, actions, dailyProjection: report.dailyProjection, moreFrequentPolling: report.moreFrequentPolling, peakAllDayProjection: report.peakAllDayProjection, unresolved: report.unresolved }, null, 2));
} finally { await app.close(); }
