'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5313';
// A paired computer's page shows the host's settings but can't change them (settings check S1):
// POST /settings through the link is refused, Reset too, and the settings it gets are read-only
// and name the host. Two EditLens servers on one machine stand in for the host and the paired computer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killPid } = require('./kill');
const wire = require('../lib/pairwire');
const { openPaired } = require('./paired-page');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-paired-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 5313, pairPort: 5314, dir: path.join(base, 'host') };
const REMOTE = { port: 5315, pairPort: 5316, dir: path.join(base, 'remote') };
const children = new Set();
const streams = new Set();
let site = null;

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    // A new connection each time: the live address checks the first request of each connection.
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
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

const token = (s) => fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
const api = (s, method, urlPath, body) => request(s.port, method, urlPath, body, { 'x-editlens-token': token(s) }).then((r) => r.json);

// A page's event stream, kept open: every settings event it gets, newest last.
function openStream(port, urlPath, headers = {}) {
  const frames = [];
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (!line) continue;
          const ev = JSON.parse(line.slice(6));
          if (ev.type === 'settings') frames.push(ev);
        }
      });
      resolve({ status: res.statusCode, frames, last: () => frames[frames.length - 1] });
    });
    streams.add(req);
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
  });
}

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
  for (const s of streams) s.destroy();
  for (const c of children) killPid(c.pid, 'SIGTERM');
  if (site) site.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

test('a paired page can\'t change the host\'s settings, and sees them read-only with the host\'s name (S1)', async () => {
  const connected = await api(HOST, 'POST', '/connect', { cwd: project, target: `http://127.0.0.1:${site.address().port}` });
  assert.ok(connected && connected.ok, JSON.stringify(connected));
  const pair = await api(HOST, 'POST', '/pair', { cwd: project });
  assert.ok(pair && pair.code, JSON.stringify(pair));
  const joined = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code: pair.code });
  assert.ok(joined && joined.ok, JSON.stringify(joined));
  const hostName = wire.cleanName(os.hostname().split('.')[0]);

  // The host's mod runs, so a page on the host itself may change settings.
  const modPoll = () => request(HOST.port, 'GET', `/summary?cwd=${encodeURIComponent(project)}&mod=1`, undefined, { 'x-editlens-token': token(HOST) });
  await modPoll();
  const local = await openStream(HOST.port, `/events?page=lp1&root=${encodeURIComponent(project)}`);
  const { port: livePort, gk, origin } = await openPaired(REMOTE.dir, joined.host.url);
  const paired = await openStream(livePort, `${gk}/events?page=pp1&url=x`, { origin });
  assert.strictEqual(paired.status, 200);
  await waitFor(async () => local.frames.length && paired.frames.length);
  assert.strictEqual(local.last().canChange, true, 'a page on the host may change them');
  assert.ok(!local.last().via);

  // The paired page: the host's values, none of them editable, labelled with the host's name.
  const seen = paired.last();
  assert.strictEqual(seen.canChange, false);
  assert.deepStrictEqual(seen.editable, []);
  assert.strictEqual(seen.via, hostName);
  assert.ok(seen.fields.every((f) => f.pageEditable === false), 'no row is editable');
  assert.strictEqual(seen.values.tasks_at_once, 4);
  const got = await request(livePort, `GET`, `${gk}/settings`, undefined, { origin });
  assert.strictEqual(got.json.canChange, false);
  assert.strictEqual(got.json.via, hostName);

  // The finding's repro: + on Tasks at once through the link. Refused, and the host keeps 4.
  await modPoll();
  const r = await request(livePort, 'POST', `${gk}/settings`, { page: 'pp1', key: 'tasks_at_once', value: 5 }, { origin });
  assert.strictEqual(r.status, 403, r.text);
  assert.strictEqual(r.json.error, `Change it on ◆ ${hostName} itself.`);
  const reset = await request(livePort, 'POST', `${gk}/settings`, { page: 'pp1', reset: true }, { origin });
  assert.strictEqual(reset.status, 403, reset.text);
  const now = await request(HOST.port, 'GET', '/settings');
  assert.strictEqual(now.json.values.tasks_at_once, 4);
  const sum = await modPoll();
  assert.deepStrictEqual(sum.json.settingsPending, [], 'nothing waits for the host\'s mod');

  // A change on the host itself is still sent to the paired page, still read-only.
  const own = await request(HOST.port, 'POST', '/settings', { page: 'lp1', key: 'tasks_at_once', value: 6 });
  assert.strictEqual(own.status, 200, own.text);
  await waitFor(async () => paired.last().values.tasks_at_once === 6);
  assert.strictEqual(paired.last().canChange, false);
  assert.strictEqual(local.last().canChange, true);
});
