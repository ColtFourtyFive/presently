/**
 * Local preview on http://127.0.0.1:8791 with a temporary, empty database.
 * A signed synthetic Access identity stands in for Cloudflare Access. Nothing
 * here is part of the deployed Worker.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { createRuntime, testAudience, testIssuer } from '../tests/runtime';

const app = await createRuntime({
  bindings: {
    APP_ENV: 'production', APP_VERSION: 'local-preview', ACCESS_ISSUER: testIssuer, ACCESS_AUD: testAudience,
    BOOTSTRAP_OWNER_EMAIL: 'owner@example.test', PIN_PEPPER: 'local-preview-pepper-not-for-production-use',
  },
});
const token = await app.signer.token();
const port = Number(process.env.PRESENTLY_LOCAL_PORT || 8791);
const origin = `http://127.0.0.1:${port}`;
const workerOrigin = 'https://app.example.test';
const assetRoot = resolve('dist/client');
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(421); res.end(); return; }
    const url = new URL(req.url || '/', origin);
    if (url.pathname.startsWith('/__isolated')) { res.writeHead(404); res.end(); return; }
    if (url.pathname.startsWith('/api/')) {
      if (req.headers.origin && req.headers.origin !== origin) { res.writeHead(403); res.end(); return; }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (value && !['host', 'origin', 'content-length', 'cf-access-jwt-assertion'].includes(key)) headers[key] = Array.isArray(value) ? value.join(',') : value;
      }
      if (url.pathname.startsWith('/api/admin/')) headers['cf-access-jwt-assertion'] = token;
      if (req.headers.origin) headers.origin = workerOrigin;
      const response = await app.runtime.dispatchFetch(`${workerOrigin}${url.pathname}${url.search}`, {
        method: req.method, headers, ...(['GET', 'HEAD'].includes(req.method || 'GET') ? {} : { body: Buffer.concat(chunks) }),
      });
      res.statusCode = response.status;
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies.map(cookie => cookie.replace(/;\s*Secure/gi, '')));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let path = resolve(assetRoot, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(`${assetRoot}/`)) path = resolve(assetRoot, 'index.html');
    try { if (!(await stat(path)).isFile()) path = resolve(assetRoot, 'index.html'); } catch { path = resolve(assetRoot, 'index.html'); }
    res.setHeader('Content-Type', mime[extname(path)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(await readFile(path));
  } catch {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'LOCAL_PREVIEW_ERROR', message: 'The local preview could not complete this request.' } }));
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Presently local preview\n  Back office: ${origin}/\n  Kiosk:       ${origin}/kiosk\nSigned in as owner@example.test. The database is temporary and empty.`);
});
async function stop() { server.close(); await app.close(); process.exit(0); }
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
