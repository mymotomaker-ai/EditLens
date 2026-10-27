'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5304';
// "Paired computers can run Claude here" off on the host: the paired computer can still list its
// tasks and copy files from the host's project (no Claude runs for that), but it can't start a task.
// Two EditLens servers on one machine stand in for the host and the paired computer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killPid } = require('./kill');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-runs-off-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'index.html'), '<h1>host</h1>\n');
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 5305, pairPort: 5306, dir: path.join(base, 'host') };
const REMOTE = { port: 5307, pairPort: 5308, dir: path.join(base, 'remote') };
const children = new Set();
let site = null;

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message, json: null }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 150));
  }
}

function startServer(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir },
    stdio: 'ignore',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}

const api = (s, method, urlPath, body) => request(s.port, method, urlPath, body,
  { 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') }).then((r) => r.json);

test.before(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>t</title></head><body>host site</body></html>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  await startServer(HOST);
  await startServer(REMOTE);
});

test.after(async () => {
  for (const c of children) killPid(c.pid, 'SIGTERM');
  if (site) site.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

test('with the setting off, list and copy work and starting a task is refused', async () => {
  const connected = await api(HOST, 'POST', '/connect', { cwd: project, target: `http://127.0.0.1:${site.address().port}` });
  assert.ok(connected && connected.ok, JSON.stringify(connected));
  const pair = await api(HOST, 'POST', '/pair', { cwd: project });
  assert.ok(pair && pair.code, JSON.stringify(pair));
  const joined = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code: pair.code });
  assert.ok(joined && joined.ok, JSON.stringify(joined));
  // Off is the stricter value, so a report from the host's Claude Code counts immediately.
  const r = await api(HOST, 'POST', '/settings/report', { values: { remote_tasks: false } });
  assert.strictEqual(r.values.remote_tasks, false, JSON.stringify(r));

  const list = await api(REMOTE, 'POST', '/remote/task', { op: 'list' });
  assert.ok(list && !list.error && Array.isArray(list.tasks), JSON.stringify(list));
  const files = await api(REMOTE, 'POST', '/remote/task', { op: 'project-files', path: '.', offset: 0 });
  assert.ok(files && !files.error && files.files.some((f) => f.path === 'index.html'), JSON.stringify(files));
  const file = await api(REMOTE, 'POST', '/remote/task', { op: 'project-file', path: 'index.html', offset: 0 });
  assert.ok(file && !file.error, JSON.stringify(file));

  const start = await api(REMOTE, 'POST', '/remote/task', { op: 'start', prompt: 'say hi' });
  assert.match(String(start && start.error), /Running Claude from paired computers is turned off/);
});
