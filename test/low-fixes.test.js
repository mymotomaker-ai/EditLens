'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4343';
// A newer server is kept, the proxy stops reading when
// the browser leaves, the Express middleware never sends more than the length it declared, and
// /editlens fails when the command it ran failed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const { newer } = require('../lib/client');
const { startProxy } = require('../server/proxy');
const middleware = require('../integrations/middleware');

test('only a later version counts as newer', () => {
  assert.strictEqual(newer('0.18.10', '0.18.9'), true);
  assert.strictEqual(newer('1.0.0', '0.99.99'), true);
  assert.strictEqual(newer('0.18.9', '0.18.10'), false);
  assert.strictEqual(newer('0.18.9', '0.18.9'), false);
  for (const bad of [undefined, null, '', 'x.y.z', '1.2', '1.2.3.4', 'NaN.0.0', '1.2.NaN']) {
    assert.strictEqual(newer(bad, '0.1.0'), false, String(bad));
    assert.strictEqual(newer('9.9.9', bad), false, String(bad));
  }
});

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('the proxy stops reading the dev server when the browser leaves', async (t) => {
  let upstreamClosed = null;
  const closed = new Promise((r) => { upstreamClosed = r; });
  const dev = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<html><body>');
    const timer = setInterval(() => res.write('x'.repeat(1024)), 20);
    res.on('close', () => { clearInterval(timer); upstreamClosed(); });
  });
  const devPort = await listen(dev);
  const proxy = await startProxy({ target: `http://127.0.0.1:${devPort}`, livePort: 4317 });
  t.after(async () => { await proxy.close(); dev.close(); });
  const req = http.get(proxy.url);
  // destroy() below ends the request with ECONNRESET ("socket hang up"); any other error fails the test.
  const reqErrors = [];
  req.on('error', (err) => { if (err.code !== 'ECONNRESET') reqErrors.push(err); });
  await new Promise((r) => setTimeout(r, 200));
  req.destroy();
  const which = await Promise.race([closed.then(() => 'closed'), new Promise((r) => setTimeout(() => r('still reading'), 2000))]);
  assert.strictEqual(which, 'closed');
  assert.deepStrictEqual(reqErrors, []);
});

test('the middleware adds the script, but never past a length already sent', async (t) => {
  const mw = middleware({ port: 4317, root: '/proj' });
  const app = http.createServer((req, res) => mw(req, res, () => {
    const body = '<html><body>hi</body></html>';
    res.setHeader('content-type', 'text/html');
    if (req.url === '/flushed') {
      res.setHeader('content-length', Buffer.byteLength(body));
      res.flushHeaders();
    }
    res.end(body);
  }));
  const port = await listen(app);
  t.after(() => app.close());
  const get = (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { accept: 'text/html' } }).then((r) => r.text());
  const normal = await get('/');
  assert.match(normal, /127\.0\.0\.1:4317\/live\.js/);
  assert.match(normal, /<\/body><\/html>$/);
  assert.strictEqual(await get('/flushed'), '<html><body>hi</body></html>');
});

test('/editlens exits 1 when the command it ran failed', async (t) => {
  // Something else uses the live server's port, so connect.js can't start it and fails.
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-exit-'));
  const squatter = http.createServer((req, res) => { res.writeHead(500); res.end('not editlens'); });
  const port = await listen(squatter);
  t.after(() => { squatter.close(); fs.rmSync(stateDir, { recursive: true, force: true }); });
  const env = { ...process.env, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: stateDir };
  const code = (script) => new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', script), 'status'], { env }, (err) => resolve(err ? err.code : 0));
  });
  assert.strictEqual(await code('connect.js'), 1, 'connect.js fails here');
  assert.strictEqual(await code('start.js'), 1);
});

test('the Vite plugin and the middleware read the port as lib/config does: digits only', async () => {
  const vite = (await import('../integrations/vite.mjs')).default;
  const src = (port) => vite({ port, root: '/proj' }).transformIndexHtml()[0].attrs.src;
  const tag = async (port) => {
    let body = '';
    const res = { statusCode: 200, headers: {}, getHeader(k) { return this.headers[k.toLowerCase()]; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      removeHeader() {}, write(c) { body += c; return true; }, end(c) { if (c) body += c; } };
    res.setHeader('content-type', 'text/html');
    middleware({ port, root: '/proj' })({ method: 'GET', headers: { accept: 'text/html' } }, res, () => {});
    res.end('<html><head></head><body></body></html>');
    return (/127\.0\.0\.1:(\d+)\/live\.js/.exec(body) || [])[1];
  };
  for (const [port, want] of [[4705, '4705'], ['4705', '4705'], ['1e3', '4317'], ['0x10', '4317'], ['4705.5', '4317'], [70000, '4317'], [NaN, '4317'], [0, '4317']]) {
    assert.strictEqual(src(port), `http://127.0.0.1:${want}/live.js`, `vite ${port}`);
    assert.strictEqual(await tag(port), want, `middleware ${port}`);
  }
});

test('the page logs warnings with one prefix: [EditLens]', () => {
  const dir = path.join(__dirname, '..', 'client', 'src');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/console\.(?:warn|error|log|info)\(\s*(['"`])(.*?)\1/g)) if (!m[2].startsWith('[EditLens] ')) bad.push(`${f}:${i + 1} ${m[2]}`);
    });
  }
  assert.deepStrictEqual(bad, []);
});
