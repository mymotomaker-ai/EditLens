'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4342';
// 0.22.4: the built-in static server reads without blocking and answers Range requests, a task
// check waits for the task to change, an unreadable pairing file is never written over, and a
// folder's remembered dev server is found however its path is spelled.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { staticHandler, parseRange } = require('../server/static');
const { Tasks } = require('../server/tasks');
const { PairHost } = require('../server/pair-host');
const { rememberTarget, lastTargetInfo } = require('../lib/connect');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-low-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('Range headers: one range, a suffix, and ranges that cannot be met', () => {
  assert.deepStrictEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
  assert.deepStrictEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.deepStrictEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
  assert.strictEqual(parseRange(undefined, 100), null);
  assert.strictEqual(parseRange('bytes=0-1,5-6', 100), null); // several ranges: the whole file
  assert.strictEqual(parseRange('bytes=-', 100), null);
  assert.strictEqual(parseRange('bytes=200-', 100), 'bad');
  assert.strictEqual(parseRange('bytes=9-3', 100), 'bad');
  assert.strictEqual(parseRange('bytes=-0', 100), 'bad');
  assert.strictEqual(parseRange('bytes=0-', 0), 'bad');
});

function get(port, p, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the static server: pages, parts of files, and files that are not there', async (t) => {
  const site = fs.mkdtempSync(path.join(base, 'site-'));
  fs.writeFileSync(path.join(site, 'index.html'), '<html><body>hi</body></html>');
  fs.writeFileSync(path.join(site, 'clip.mp4'), '0123456789');
  fs.mkdirSync(path.join(site, 'about'));
  fs.writeFileSync(path.join(site, 'about', 'index.html'), '<p>about</p>');
  const server = http.createServer(staticHandler(site, (html) => html.replace('<body>', '<body><!--el-->')));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { port } = server.address();

  const page = await get(port, '/');
  assert.strictEqual(page.status, 200);
  assert.match(page.body, /<!--el-->hi/);

  const part = await get(port, '/clip.mp4', { range: 'bytes=2-5' });
  assert.strictEqual(part.status, 206);
  assert.strictEqual(part.body, '2345');
  assert.strictEqual(part.headers['content-range'], 'bytes 2-5/10');
  assert.strictEqual(part.headers['accept-ranges'], 'bytes');

  const whole = await get(port, '/clip.mp4');
  assert.strictEqual(whole.status, 200);
  assert.strictEqual(whole.body, '0123456789');
  assert.strictEqual(whole.headers['content-length'], '10');

  assert.strictEqual((await get(port, '/clip.mp4', { range: 'bytes=50-' })).status, 416);
  const head = await get(port, '/clip.mp4', {}, 'HEAD');
  assert.strictEqual(head.status, 200);
  assert.strictEqual(head.body, '');
  assert.strictEqual((await get(port, '/about')).status, 301);
  assert.match((await get(port, '/about/')).body, /about/);
  assert.strictEqual((await get(port, '/nope.css')).status, 404);
  assert.strictEqual((await get(port, '/.env')).status, 404);
  assert.strictEqual((await get(port, '/%E0%A4%A')).status, 404);
  assert.strictEqual((await get(port, '/', { host: 'evil.example' })).status, 403);
});

function fakeTask(tasks, state) {
  const t = {
    id: 't' + Math.random().toString(16).slice(2, 10), by: 'laptop', pairId: 'p', cwd: base, dir: base, copy: null, root: base, prompt: 'x',
    state, replies: [], replyCount: 0, permissions: new Map(), startedAt: Date.now(), updatedAt: Date.now(), driver: null, timer: null,
  };
  tasks.items.set(t.id, t);
  return t;
}

test('a task check waits for the task to change, and answers immediately when it is done', async () => {
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps', makeDriver: () => null });
  const t = fakeTask(tasks, 'working');
  const started = Date.now();
  const pending = tasks.check(t, 0, 30);
  setTimeout(() => {
    t.state = 'idle';
    t.replies.push('done');
    t.replyCount = 1;
    tasks.changed(t);
  }, 100);
  const res = await pending;
  assert.strictEqual(res.state, 'idle');
  assert.deepStrictEqual(res.replies, ['done']);
  assert.ok(Date.now() - started < 5000);
  assert.strictEqual(tasks.waiters.size, 0);

  // Done already: no wait.
  const quick = Date.now();
  await tasks.check(t, 0, 30);
  assert.ok(Date.now() - quick < 200);

  // Nothing changes: it answers when the wait runs out; a bad wait is no wait.
  const w = fakeTask(tasks, 'working');
  const at = Date.now();
  assert.strictEqual((await tasks.check(w, 0, 0.2)).state, 'working');
  assert.ok(Date.now() - at >= 150);
  assert.strictEqual(tasks.waiters.size, 0);
  const n = Date.now();
  await tasks.check(w, 0, NaN);
  await tasks.check(w, 0, -5);
  assert.ok(Date.now() - n < 200);
});

test('a pairing file that cannot be read is left as it is', () => {
  const stateDir = fs.mkdtempSync(path.join(base, 'pair-'));
  fs.mkdirSync(path.join(stateDir, 'pair-host.json')); // EISDIR on read
  const logs = [];
  const host = new PairHost({ stateDir, port: 0, log: (l) => logs.push(l) });
  assert.strictEqual(host.readOnly, true);
  assert.deepStrictEqual(host.pairs, []);
  host.save();
  assert.ok(fs.statSync(path.join(stateDir, 'pair-host.json')).isDirectory());
  assert.ok(logs.some((l) => /can't be read/.test(l)));
});

test('a remembered dev server is found however the folder is spelled', () => {
  const stateDir = fs.mkdtempSync(path.join(base, 'targets-'));
  const app = fs.mkdtempSync(path.join(base, 'app-'));
  rememberTarget(stateDir, app + path.sep + '.', 'http://127.0.0.1:5173');
  assert.strictEqual(lastTargetInfo(stateDir, app).url, 'http://127.0.0.1:5173');
  assert.strictEqual(lastTargetInfo(stateDir, path.join(app, 'x', '..')).url, 'http://127.0.0.1:5173');
  // An entry saved before 0.22.4 (a bare address under the path as spelled) still counts, as old.
  const old = fs.mkdtempSync(path.join(base, 'old-'));
  fs.writeFileSync(path.join(stateDir, 'targets.json'), JSON.stringify({ targets: { [path.resolve(old)]: 'http://localhost:3000', bad: { url: 'http://evil.example:80' } } }));
  assert.deepStrictEqual(lastTargetInfo(stateDir, old), { url: 'http://localhost:3000', at: 0, title: '' });
  assert.strictEqual(lastTargetInfo(stateDir, 'bad'), null);
  // A non-number time counts as not recent.
  fs.writeFileSync(path.join(stateDir, 'targets.json'), JSON.stringify({ targets: { [path.resolve(old)]: { url: 'http://localhost:3000', at: 'soon' } } }));
  assert.strictEqual(lastTargetInfo(stateDir, old).at, 0);
});
