'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4909';
// Two EditLens servers on one machine stand in for a VPS ("host") and a laptop ("remote"):
// pairing with a one-time code, the site and live server through the link, the link working again
// after the host restarts, wrong and used codes, and unpairing.
const test = require('node:test');
const assert = require('node:assert');
const { killPid } = require('./kill');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const wire = require('../lib/pairwire');
const { openPaired, siteCookie } = require('./paired-page');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pair-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 4361, pairPort: 4908, dir: path.join(base, 'host') };
const REMOTE = { port: 4363, pairPort: 4364, dir: path.join(base, 'remote') };
const FREE_PORT = 5363; // nothing listens here: no other test file may use it (test/ports.test.js)
const children = new Set();
const FAKE_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
const SSH_LOG = path.join(base, 'ssh.log');
function sshRuns() {
  return fs.existsSync(SSH_LOG) ? fs.readFileSync(SSH_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}

function startServer(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_SSH: FAKE_SSH, FAKE_SSH_LOG: SSH_LOG },
    stdio: 'ignore',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  s.child = child;
  return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}

function stopServer(s) {
  return new Promise((resolve) => {
    if (!s.child || s.child.exitCode !== null) return resolve();
    s.child.once('exit', () => resolve());
    s.child.kill();
  });
}

function token(s) {
  return fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
}

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
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message, json: null }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

// bin/pair.js as the user types it on that computer (plain text, no records).
function pairScript(s, args) {
  const env = { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, CLAUDE_PROJECT_DIR: project, EDITLENS_NO_BROWSER: '1' };
  delete env.EDITLENS_SAY;
  return spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'pair.js'), ...args], { env, encoding: 'utf8', timeout: 60000 });
}

function api(s, method, urlPath, body) {
  return request(s.port, method, urlPath, body, { 'x-editlens-token': token(s) }).then((r) => r.json);
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 150));
  }
}

// The first SSE event of a page's stream (the hello). gk: the live key a paired page's paths start with.
function hello(port, gk = '') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: `${gk}/events?page=p1&url=x` }, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        const m = /data: (\{.*"type":"hello".*\})\n/.exec(buf);
        if (m) {
          req.destroy();
          resolve(JSON.parse(m[1]));
        }
      });
    });
    req.on('error', reject);
  });
}

let site;
test.before(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>t</title></head><body>hello from the host</body></html>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  await startServer(HOST);
  await startServer(REMOTE);
});

test.after(async () => {
  for (const c of children) c.kill();
  site.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

let code;
let joined;

test('a code pairs once; the site and live server work through the link', async () => {
  const connected = await api(HOST, 'POST', '/connect', { cwd: project, target: `http://127.0.0.1:${site.address().port}` });
  assert.ok(connected.ok, JSON.stringify(connected));
  const pair = await api(HOST, 'POST', '/pair', { cwd: project });
  assert.match(pair.code, /^([A-Z2-9]{4}-){6}[A-Z2-9]{4}$/);
  assert.strictEqual(pair.port, HOST.pairPort);
  code = pair.code;

  const wrong = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code: wire.newCode() });
  assert.match(wrong.error, /refused/);

  const res = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code: code.toLowerCase().replace(/-/g, ' ') });
  assert.ok(res.ok, JSON.stringify(res));
  joined = res.host;
  assert.match(joined.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const again = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code });
  assert.ok(again.error, 'a used code is refused');

  const sitePort = Number(new URL(joined.url).port);
  // D11: the site address answers only with this user's cookie, which the address with the key sets.
  assert.strictEqual((await request(sitePort, 'GET', '/')).status, 403, 'the site address without the cookie');
  const first = await request(sitePort, 'GET', `/${new URL(joined.keyUrl).search}`);
  assert.strictEqual(first.status, 302, first.text);
  const cookie = String(first.headers['set-cookie']).split(';')[0];
  assert.strictEqual(cookie, siteCookie(REMOTE.dir, sitePort));
  const page = await request(sitePort, 'GET', '/', undefined, { cookie });
  assert.strictEqual(page.status, 200);
  assert.match(page.text, /hello from the host/);
  const src = /src="http:\/\/127\.0\.0\.1:(\d+)(\/gk-[0-9a-f]{32})\/live\.js"/.exec(page.text);
  assert.ok(src, page.text);
  const livePort = Number(src[1]);
  const gk = src[2];
  assert.notStrictEqual(livePort, HOST.port, 'the script loads through this computer\'s end of the link');
  assert.ok(page.text.includes(`data-root="${project}"`));

  // The live address answers only paths that start with the live key.
  assert.strictEqual((await request(livePort, 'GET', '/health')).status, 403, 'the live address without the key');
  const health = await request(livePort, 'GET', `${gk}/health`);
  assert.strictEqual(health.status, 200);
  const h = await hello(livePort, gk);
  // Which version the other computer runs (the paired page names both when they differ).
  assert.deepStrictEqual(h.via, { name: wire.cleanName(os.hostname().split('.')[0]), peerVersion: require('../lib/config').version });
  // A local page on the host has no "via".
  assert.strictEqual((await hello(HOST.port)).via, null);
});

test('a paired page never counts as trusted, even with the host\'s token', async () => {
  const { port: livePort, gk } = await openPaired(REMOTE.dir, joined.url);
  const r = await request(livePort, 'GET', `${gk}/claude-paths`, undefined, { 'x-editlens-token': token(HOST) });
  assert.strictEqual(r.status, 401);
});

test('through the link: no EditLens window (approve or list questions) while "Paired computers can answer" is off, and /health without pid or uid', async () => {
  const { port: livePort, gk } = await openPaired(REMOTE.dir, joined.url);
  const open = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
  assert.strictEqual((await request(livePort, 'GET', `${gk}/answer`, undefined, open)).status, 403, 'the window page and its key');
  // The host's own window key, used through the link, is refused too.
  const page = await request(HOST.port, 'GET', '/answer', undefined, open);
  const key = (/var KEY = "([0-9a-f]{64})"/.exec(page.text) || [])[1];
  assert.ok(key, 'the host\'s own window has its key');
  const asWindow = { 'sec-fetch-site': 'same-origin', 'x-editlens-answer': key };
  assert.strictEqual((await request(HOST.port, 'GET', '/answer/list', undefined, asWindow)).status, 200, 'on the host itself');
  assert.strictEqual((await request(livePort, 'GET', `${gk}/answer/list`, undefined, asWindow)).status, 403);
  assert.strictEqual((await request(livePort, 'POST', `${gk}/answer`, { kind: 'drive', id: 'x', decision: 'allow' }, asWindow)).status, 403);
  const linked = await request(livePort, 'GET', `${gk}/health`);
  assert.strictEqual(linked.status, 200);
  assert.ok(!('pid' in linked.json) && !('uid' in linked.json), linked.text);
  assert.ok('pid' in (await request(HOST.port, 'GET', '/health')).json, 'this computer\'s own tools still get it');
});

// The host's setting "Paired computers can answer questions here", saved as Claude Code saves it
// (a less strict value counts only when saved) and reported by the host's Claude Code.
async function setPairedAnswers(on) {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ pluginConfigs: { 'editlens@editlens': { options: { paired_answers: on } } } }));
  const r = await api(HOST, 'POST', '/settings/report', { values: { paired_answers: on } });
  assert.strictEqual(r.values.paired_answers, on, JSON.stringify(r));
}

test('"Paired computers can answer questions here" on the host: the joined computer opens its window; off again closes it immediately', async (t) => {
  t.after(() => setPairedAnswers(false));
  const { port: livePort, gk, cookie } = await openPaired(REMOTE.dir, joined.url);
  const open = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' };
  // A report without Claude Code's saved setting waits for the host's own window; the link can't answer it.
  const held = await api(HOST, 'POST', '/settings/report', { values: { paired_answers: true } });
  assert.strictEqual(held.values.paired_answers, false, 'not in effect until allowed on the host');
  assert.strictEqual((await request(livePort, 'GET', `${gk}/answer`, undefined, open)).status, 403);
  await setPairedAnswers(true);
  // The window this computer opens has the site's cookie (D11): it is sent on to the address with the key.
  const opened = await request(livePort, 'GET', '/answer', undefined, { ...open, cookie });
  assert.strictEqual(opened.status, 302);
  assert.strictEqual(opened.headers.location, `${gk}/answer`);
  const page = await request(livePort, 'GET', `${gk}/answer`, undefined, open);
  assert.strictEqual(page.status, 200);
  const key = (/var KEY = "([0-9a-f]{64})"/.exec(page.text) || [])[1];
  const asWindow = { 'sec-fetch-site': 'same-origin', 'x-editlens-answer': key, origin: `http://127.0.0.1:${livePort}`, host: `127.0.0.1:${livePort}` };
  const list = await request(livePort, 'GET', `${gk}/answer/list`, undefined, asWindow);
  assert.strictEqual(list.status, 200, list.text);
  assert.strictEqual(list.json.via, true);
  // Settings, root and modes are answered on the host only; other questions only when it lists them.
  for (const kind of ['setting', 'root', 'mode', 'drive', 'task']) {
    const r = await request(livePort, 'POST', `${gk}/answer`, { kind, id: 'x', task: 'aaaaaaaaaaaa', decision: 'allow' }, asWindow);
    assert.strictEqual(r.status, 403, `${kind}: only a question it lists`);
  }
  // Off again: the open window is refused on its next request.
  await setPairedAnswers(false);
  assert.strictEqual((await request(livePort, 'GET', `${gk}/answer/list`, undefined, asWindow)).status, 403);
  assert.strictEqual((await request(livePort, 'GET', `${gk}/answer`, undefined, open)).status, 403);
});

// A page's event stream, read for a moment (during() runs while it is open).
function streamText(port, urlPath, headers = {}, during = async () => {}, ms = 700) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
      res.on('data', (c) => { buf += c; });
      Promise.resolve(during()).then(() => setTimeout(() => {
        req.destroy();
        resolve({ status: res.statusCode, text: buf });
      }, ms), reject);
    });
    req.on('error', (err) => (err.code === 'ECONNRESET' ? resolve({ status: 0, text: buf }) : reject(err)));
  });
}

test('a paired page sees only the project it was paired for, and only from the link\'s own addresses', async () => {
  const other = path.join(base, 'other');
  fs.mkdirSync(other, { recursive: true });
  const { sitePort, port: livePort, gk } = await openPaired(REMOTE.dir, joined.url);
  const origin = `http://127.0.0.1:${sitePort}`;
  await api(HOST, 'POST', '/event', { type: 'note', sessionId: 's-other', cwd: other, marker: 'OTHER-PROJECT' });
  const code = await api(HOST, 'POST', '/event', { type: 'code', sessionId: 's-other', cwd: other, file: path.join(other, 'other.js'), content: 'OTHER-TEXT' });
  await api(HOST, 'POST', '/event', { type: 'note', sessionId: 's-mine', cwd: project, marker: 'THIS-PROJECT' });

  // It asks for the other project's root: it still gets only its own, now and later.
  const later = () => api(HOST, 'POST', '/event', { type: 'note', sessionId: 's-other', cwd: other, marker: 'OTHER-LIVE' }).then(() => api(HOST, 'POST', '/event', { type: 'note', cwd: project, marker: 'THIS-LIVE' }));
  const paired = await streamText(livePort, `${gk}/events?page=p3&root=${encodeURIComponent(other)}`, { origin }, later);
  assert.strictEqual(paired.status, 200);
  assert.match(paired.text, /THIS-PROJECT/);
  assert.match(paired.text, /THIS-LIVE/);
  assert.doesNotMatch(paired.text, /OTHER-PROJECT|OTHER-LIVE|s-other/);
  // A page on the host itself sees every project, as before.
  const local = await streamText(HOST.port, '/events?page=p3');
  assert.match(local.text, /OTHER-PROJECT/);

  // The other project's file text: not through the link.
  const inst = (await api(HOST, 'GET', '/summary')).instance;
  assert.strictEqual((await request(livePort, 'GET', `${gk}/snapshot?id=s${code.seq}&instance=${inst}`, undefined, { origin })).status, 404);
  assert.strictEqual((await request(HOST.port, 'GET', `/snapshot?id=s${code.seq}&instance=${inst}`)).status, 200);
  assert.strictEqual((await request(livePort, 'GET', `${gk}/summary?cwd=${encodeURIComponent(other)}`)).status, 404);

  // Another page on the paired computer (another port) is refused; the site and the link are not.
  assert.strictEqual((await request(livePort, 'GET', `${gk}/health`, undefined, { origin: 'http://127.0.0.1:5999' })).status, 403);
  assert.strictEqual((await request(livePort, 'GET', `${gk}/health`, undefined, { origin: 'http://localhost:5999' })).status, 403);
  assert.strictEqual((await request(livePort, 'GET', `${gk}/health`, undefined, { origin })).status, 200);
  assert.strictEqual((await request(livePort, 'GET', `${gk}/health`, undefined, { origin: `http://127.0.0.1:${livePort}` })).status, 200);
});

test('both sides list the pairing', async () => {
  const remote = await api(REMOTE, 'GET', '/pair');
  await waitFor(async () => (await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].state === 'connected');
  assert.strictEqual(remote.remotes.hosts.length, 1);
  const host = await api(HOST, 'GET', '/pair');
  assert.strictEqual(host.host.pairs.length, 1);
  assert.strictEqual(host.host.pairs[0].cwd, project);
  assert.strictEqual(host.host.waiting, null, 'the code is used up');
});

test('the computers connect again after the host restarts; the address stays the same', async () => {
  await stopServer(HOST);
  await waitFor(async () => (await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].state === 'reconnecting');
  await startServer(HOST);
  await api(HOST, 'POST', '/connect', { cwd: project, target: `http://127.0.0.1:${site.address().port}` });
  await waitFor(async () => (await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].state === 'connected', 40000);
  const status = await api(REMOTE, 'GET', '/pair');
  assert.strictEqual(status.remotes.hosts[0].url, joined.url);
  const sitePort = Number(new URL(joined.url).port);
  const page = await request(sitePort, 'GET', '/', undefined, { cookie: siteCookie(REMOTE.dir, sitePort) });
  assert.match(page.text, /hello from the host/);
});

test('the remote restarts and keeps its pairing on the same address', async () => {
  await stopServer(REMOTE);
  await startServer(REMOTE);
  await waitFor(async () => (await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].state === 'connected');
  assert.strictEqual((await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].url, joined.url);
});

test('control words run on the paired computer and its answer is returned', async () => {
  const name = (await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].name;
  const res = await api(REMOTE, 'POST', '/join/control', { name, args: ['manual'] });
  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.match(res.text, /back to Manual/);
  assert.match((await api(REMOTE, 'POST', '/join/control', { name: 'nobody', args: [] })).error, /No paired computer/);
});

test('unpairing from the remote removes it on the host too and closes the host\'s port', async () => {
  const name = (await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].name;
  const off = await api(REMOTE, 'POST', '/join/off', { name });
  assert.deepStrictEqual(off.removed, [{ name, told: true }]);
  assert.strictEqual((await api(REMOTE, 'GET', '/pair')).remotes.hosts.length, 0);
  const host = await api(HOST, 'GET', '/pair');
  assert.strictEqual(host.host.pairs.length, 0);
  assert.strictEqual(host.host.port, null);
  assert.strictEqual((await request(Number(new URL(joined.url).port), 'GET', '/')).status, 0, 'the local address is closed');
});

test('a mistyped code or address is explained before anything is sent', async () => {
  assert.match((await api(REMOTE, 'POST', '/join', { address: '127.0.0.1:4908', code: 'ABCD' })).error, /not complete/);
  assert.match((await api(REMOTE, 'POST', '/join', { address: 'not an address!', code })).error, /isn't an address/);
  assert.match((await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${FREE_PORT}`, code: wire.newCode() })).error, /no server is running/);
});

test('codes expire, wrong keys get an address blocked, and saved pairings survive bad files', () => {
  const { PairHost } = require('../server/pair-host');
  const dir = path.join(base, 'unit');
  fs.mkdirSync(dir, { recursive: true });
  const host = new PairHost({ stateDir: dir, port: 0, httpServer: null, siteOf: () => null, version: 'x', livePort: 1, log: () => {} });
  host.pending = { code: 'X', key: Buffer.alloc(32), cwd: project, expires: Date.now() - 1 };
  assert.strictEqual(host.keyFor(wire.JOIN_ID), null, 'an expired code is no key');
  assert.strictEqual(host.active(), false);
  assert.strictEqual(host.keyFor('0'.repeat(32)), null, 'an unknown pairing is no key');
  host.direct = true;
  for (let i = 0; i < 9; i++) host.failed('203.0.113.9', wire.JOIN_ID);
  assert.strictEqual(host.isBlocked('203.0.113.9', wire.JOIN_ID), false);
  host.failed('203.0.113.9', wire.JOIN_ID);
  assert.strictEqual(host.isBlocked('203.0.113.9', wire.JOIN_ID), true);
  assert.strictEqual(host.isBlocked('203.0.113.9', 'a'.repeat(32)), false, 'a paired computer at that address still gets in');
  // Through an SSH tunnel (port on 127.0.0.1 only): never blocked.
  host.direct = false;
  for (let i = 0; i < 20; i++) host.failed('127.0.0.1', wire.JOIN_ID);
  assert.strictEqual(host.isBlocked('127.0.0.1', wire.JOIN_ID), false);
  // Blocks end, and are cleared then.
  host.blocked.set(host.blockKey('203.0.113.9', wire.JOIN_ID), Date.now() - 1);
  assert.strictEqual(host.isBlocked('203.0.113.9', wire.JOIN_ID), false);
  assert.strictEqual(host.blocked.size, 0);
  fs.writeFileSync(path.join(dir, 'pair-host.json'), '{not json');
  assert.deepStrictEqual(host.load(), []);
  fs.writeFileSync(path.join(dir, 'pair-host.json'), JSON.stringify({ pairs: [{ id: 'short', key: 'x', cwd: 1 }, null] }));
  assert.deepStrictEqual(host.load(), []);
});

test('addresses and codes are read leniently but strictly checked', () => {
  assert.deepStrictEqual(wire.parseAddress('203.0.113.5', 4318), { host: '203.0.113.5', port: 4318 });
  assert.deepStrictEqual(wire.parseAddress('https://vps.example.com:9000/x', 4318), { host: 'vps.example.com', port: 9000 });
  assert.deepStrictEqual(wire.parseAddress('[::1]:4318', 1), { host: '::1', port: 4318 });
  for (const bad of ['', 'a b', 'host:0', 'host:70000', 'host:NaN', null, undefined]) assert.strictEqual(wire.parseAddress(bad, 4318), null, String(bad));
  const c = wire.newCode();
  assert.strictEqual(wire.normalizeCode(c.toLowerCase().replace(/-/g, ' ')), c.replace(/-/g, ''));
  for (const bad of ['', 'O'.repeat(28), c.slice(0, -1), null]) assert.strictEqual(wire.normalizeCode(bad), null, String(bad));
});

test('/editlens pair gives the SSH line with this computer\'s own login, ready to run', async () => {
  const pair = await api(HOST, 'POST', '/pair', { cwd: project });
  assert.strictEqual(pair.user, os.userInfo().username);
  assert.ok(Array.isArray(pair.addresses));
  await api(HOST, 'POST', '/pair/off', {});
});

test('pairing through SSH: one join opens the tunnel, pairs, and reopens it when it closes', async () => {
  const key = path.join(base, 'id_test');
  fs.writeFileSync(key, 'not a real key');
  const { code: sshCode } = await api(HOST, 'POST', '/pair', { cwd: project });
  const denied = await api(REMOTE, 'POST', '/join', { address: `denied@127.0.0.1:${HOST.pairPort}`, code: sshCode });
  assert.match(denied.error, /could not log in with a key/);
  assert.match((await api(REMOTE, 'POST', '/join', { address: '-oProxyCommand=x@h', code: sshCode })).error, /isn't an SSH login/);
  assert.match((await api(REMOTE, 'POST', '/join', { address: 'me@127.0.0.1', code: sshCode, key: path.join(base, 'missing') })).error, /doesn't exist/);

  const res = await api(REMOTE, 'POST', '/join', { address: `tester@127.0.0.1:${HOST.pairPort}`, code: sshCode, key, sshPort: 2222 });
  assert.ok(res.ok, JSON.stringify(res));
  assert.match(res.host.address, /^tester@127\.0\.0\.1 \(through SSH\)$/);
  const run = sshRuns().pop();
  assert.deepStrictEqual(run.args.slice(-5), ['-p', '2222', '-i', key, 'tester@127.0.0.1']);
  assert.ok(run.args.includes('BatchMode=yes'));
  assert.ok(run.args.includes(`127.0.0.1:${/127\.0\.0\.1:(\d+):/.exec(run.args[run.args.indexOf('-L') + 1])[1]}:127.0.0.1:${HOST.pairPort}`));
  const sshSite = Number(new URL(res.host.url).port);
  const withCookie = { cookie: siteCookie(REMOTE.dir, sshSite) };
  const page = await request(sshSite, 'GET', '/', undefined, withCookie);
  assert.match(page.text, /hello from the host/);

  // ssh exits (the connection closed): the next check starts it again.
  killPid(run.pid);
  await waitFor(() => sshRuns().length > 0 && sshRuns().pop().pid !== run.pid, 40000);
  await waitFor(async () => (await api(REMOTE, 'GET', '/pair')).remotes.hosts[0].state === 'connected', 40000);
  assert.match((await request(sshSite, 'GET', '/', undefined, withCookie)).text, /hello from the host/);

  // The tunnel's ssh, before the refused join below adds a run of its own.
  const tunnel = sshRuns().pop();

  // The laptop told the host the path of its key file (never the key), so the host fills it in
  // the ssh lines it prints: the join line of the next /editlens pair, with --key.
  assert.deepStrictEqual((await api(HOST, 'GET', '/pair')).host.pairs.map((p) => p.keyPath), [key]);
  const printed = pairScript(HOST, ['pair']);
  const lines = printed.stdout.split('\n');
  const plain = lines.findIndex((l) => /^\/editlens join \S+@\S+ ([A-Z2-9]{4}-){6}[A-Z2-9]{4}$/.test(l));
  assert.ok(plain > 0, printed.stdout + printed.stderr);
  assert.deepStrictEqual(lines.slice(plain + 1, plain + 5), ['', 'With a key file:', '', `${lines[plain]} --key "${key}"`]);
  assert.doesNotMatch(printed.stdout, /<path of your key file>|not a real key/);

  // A refused key on the laptop: what went wrong, then the line again with the key placeholder
  // (and the SSH port it was given), alone on its line.
  const { code: again } = await api(HOST, 'POST', '/pair', { cwd: project });
  const refused = pairScript(REMOTE, ['join', `denied@127.0.0.1:${HOST.pairPort}`, again, '--ssh-port', '2222']);
  assert.strictEqual(refused.status, 1, refused.stdout + refused.stderr);
  const out = refused.stdout.split('\n');
  assert.strictEqual(out[0], "✕ Couldn't pair: the other computer refused your SSH key");
  assert.ok(out.includes('! Fix'), refused.stdout);
  assert.ok(out.includes('│     Type the line again with the key file you use for this server:'), refused.stdout);
  assert.ok(out.includes(`/editlens join denied@127.0.0.1:${HOST.pairPort} ${again} --ssh-port 2222 --key "<path of your key file>"`), refused.stdout);

  const off = await api(REMOTE, 'POST', '/join/off', {});
  assert.strictEqual(off.removed[0].told, true);
  const last = tunnel;
  assert.ok(Number.isInteger(last.pid) && last.pid > 1, `not a pid: ${last.pid}`); // read from the ssh log
  await waitFor(() => {
    try {
      process.kill(last.pid, 0);
      return false;
    } catch (err) {
      return err.code === 'ESRCH';
    }
  });
});

test('the pairing port is on 127.0.0.1 unless asked open; pairing again replaces the old pairing and both sides hear of it', async () => {
  const { PairHost } = require('../server/pair-host');
  const dir = path.join(base, 'unit-port');
  fs.mkdirSync(dir, { recursive: true });
  const notices = [];
  const host = new PairHost({ stateDir: dir, port: 0, httpServer: null, siteOf: () => null, version: 'x', livePort: 1, log: () => {}, onNotice: (t) => notices.push(t) });
  await host.newCode(project);
  assert.strictEqual(host.server.address().address, '127.0.0.1');
  await host.newCode(project, { direct: true });
  assert.notStrictEqual(host.server.address().address, '127.0.0.1');
  host.off();

  // Through the real servers: two joins from the same computer leave one pairing.
  for (let i = 0; i < 2; i++) {
    const { code: c } = await api(HOST, 'POST', '/pair', { cwd: project });
    const r = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code: c });
    assert.ok(r.ok, JSON.stringify(r));
  }
  const status = await api(HOST, 'GET', '/pair');
  assert.strictEqual(status.host.pairs.length, 1);
  const summary = await api(HOST, 'GET', `/summary?cwd=${encodeURIComponent(project)}`);
  assert.ok(summary.pairing.some((n) => /^Paired with /.test(n.text)), JSON.stringify(summary.pairing));
  assert.strictEqual(summary.paired.host.length, 1);
  const remote = await api(REMOTE, 'GET', `/summary?cwd=${encodeURIComponent(project)}`);
  assert.strictEqual(remote.paired.joined.length, 1);
  // The same computer pairs another project: the host removes the first project's pairing too.
  const project2 = path.join(base, 'project2');
  fs.mkdirSync(project2, { recursive: true });
  const { code: c2 } = await api(HOST, 'POST', '/pair', { cwd: project2 });
  assert.ok((await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code: c2 })).ok);
  assert.deepStrictEqual((await api(HOST, 'GET', '/pair')).host.pairs.map((p) => p.cwd), [project2]);
  await api(REMOTE, 'POST', '/join/off', {});
  assert.ok((await api(HOST, 'GET', `/summary?cwd=${encodeURIComponent(project)}`)).pairing.some((n) => /unpaired/.test(n.text)));
});
