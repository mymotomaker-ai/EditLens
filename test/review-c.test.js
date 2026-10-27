'use strict';
require('./isolate');
// Review C1–C4 (and C6–C10 helpers): an update waits for page control, one project can't take
// another's page control, waiters are replaced without pid files, other users of the computer are
// refused, safe writes, list locking, encoding, version checks. Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-review-c-'));
const state = path.join(dir, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const exe = path.join(bin, 'claude');
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: '4356',
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
  FAKE_SDK_IMPORT_MS: '400',
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');
const config = require('../lib/config');

const projA = path.join(dir, 'a');
const projB = path.join(dir, 'b');
fs.mkdirSync(projA);
fs.mkdirSync(projB);

const streams = [];
function openPage(id, root) {
  const s = new AbortController();
  streams.push(s);
  return fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(root)}`, { signal: s.signal }).then((res) => {
    res.body.cancel = res.body.cancel || (() => {});
    return res;
  });
}
const err = (p) => p.then((r) => r, (e) => {
  const m = /server answered (\d+): (.*)$/s.exec(String(e.message));
  return m ? { status: Number(m[1]), ...JSON.parse(m[2]) } : { error: e.message };
});
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('C1–C3 on a live server', async (t) => {
  await ensureServer();
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
  });

  // C3: the newest waiter counts; an older one is told to stop; a choice stops them all.
  const w1 = 'a'.repeat(16);
  const w2 = 'b'.repeat(16);
  assert.match((await err(postJson('/drive/grant', { cwd: projA, auto: true, waiter: w1 }))).error, /No page/);
  assert.match((await err(postJson('/drive/grant', { cwd: projA, auto: true, waiter: w2 }))).error, /No page/);
  assert.match((await err(postJson('/drive/grant', { cwd: projA, auto: true, waiter: w1 }))).error, /newer session/);
  await postJson('/drive/stop-waiting', {});
  assert.match((await err(postJson('/drive/grant', { cwd: projA, auto: true, waiter: w2 }))).error, /newer session/);

  // A file, a missing folder or / is not a project folder: a clear 400, never a 500.
  fs.writeFileSync(path.join(projA, 'a.css'), 'a{}');
  for (const [route, cwd] of [['/connect', path.join(projA, 'a.css')], ['/connect', '/' + 'x'.repeat(5000)], ['/connect', '/'], ['/pair', path.join(dir, 'nope')], ['/drive/auto', path.join(projA, 'nope')]]) {
    const out = await err(postJson(route, { cwd }));
    assert.strictEqual(out.status, 400, `${route} ${cwd.slice(0, 60)}: ${JSON.stringify(out)}`);
  }

  // Page control in project A.
  await openPage('pa', projA);
  await openPage('pb', projB);
  await until(async () => (await getJson('/pages/live')).length === 2);
  // Two starts at the same time (auto control as the page opens, plus /editlens control): one Claude, one
  // key, and both answer ok.
  const [grant, again] = await Promise.all([1, 2].map(() => err(postJson('/drive/grant', { cwd: projA, claudePath: exe, fresh: true }, { timeoutMs: 20000 }))));
  assert.ok(grant.ok, JSON.stringify(grant));
  assert.ok(again.ok, JSON.stringify(again));
  assert.strictEqual(fs.readFileSync(path.join(state, 'queries'), 'utf8').trim().split('\n').length, 1, 'Claude started once');

  // C2: project B's page can't take it over.
  const other = await err(postJson('/drive/grant', { cwd: projB, claudePath: exe, fresh: true }));
  assert.match(other.error, /already running from the page in/);

  // C1: an update waits while page control runs; /editlens stop still stops it.
  assert.deepStrictEqual(await stopServer({ force: false }), { busy: 'page control' });
  assert.ok((await getJson('/health')).ok, 'still running');
  await postJson('/drive/end', {});
  // Ended: the summary says so (an error answer fails the test instead of counting as ended).
  assert.ok(await until(async () => {
    const st = await getJson('/summary');
    return Boolean(st) && st.live === true && st.control !== 'page';
  }), 'page control ended');
  assert.strictEqual(await stopServer({ force: false }), true, 'nothing running: the update goes ahead');
});

test('C1: a busy old server is reported, not replaced', async (t) => {
  const port = 4357;
  const server = http.createServer((req, res) => {
    if (req.url === '/health') return res.end(JSON.stringify({ ok: true, version: '0.0.1', uid: typeof process.getuid === 'function' ? process.getuid() : null }));
    if (req.url === '/shutdown') {
      res.statusCode = 409;
      return res.end(JSON.stringify({ busy: 'tasks' }));
    }
    res.statusCode = 404;
    return res.end('{}');
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  t.after(() => server.close());
  // Not spawnSync: the stand-in server above must keep answering.
  const out = await new Promise((resolve, reject) => require('child_process').execFile(process.execPath, ['-e', "require('./lib/client').ensureServer().then((r) => console.log(JSON.stringify(r)))"], {
    cwd: path.join(__dirname, '..'), env: { ...process.env, EDITLENS_PORT: String(port) },
  }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
  assert.deepStrictEqual(JSON.parse(out), { started: false, waiting: 'tasks', running: '0.0.1', installed: require('../lib/config').version });
});

const asNobody = process.platform === 'linux' && process.getuid() === 0 && spawnSync('runuser', ['-u', 'nobody', '--', process.execPath, '-e', '0']).status === 0;
test('C4: another user of this computer is refused', { skip: asNobody ? false : 'needs root on Linux, and a node another user can run' }, async (t) => {
  await ensureServer();
  t.after(() => stopServer());
  const script = `const h=require('http');const get=(p)=>new Promise((r)=>h.get({host:'127.0.0.1',port:${config.port},path:p,agent:false},(res)=>{res.resume();r(res.statusCode)}));(async()=>{console.log(await get('/health'),await get('/live.js'),await get('/pages'))})()`;
  const r = spawnSync('runuser', ['-u', 'nobody', '--', process.execPath, '-e', script], { encoding: 'utf8', cwd: '/' });
  assert.strictEqual(r.stdout.trim(), '200 403 403', r.stderr);
  // This user is still served.
  assert.ok((await getJson('/health')).ok);
});

test('C7: safe writes keep the mode and leave no temporary file', () => {
  const { writeAtomic, withLock } = require('../lib/atomic');
  const file = path.join(dir, 'run.sh');
  fs.writeFileSync(file, 'old', { mode: 0o755 });
  writeAtomic(file, 'new');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o755);
  assert.deepStrictEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp')), []);
  writeAtomic(path.join(dir, 'deep', 'x.txt'), 'x', { mkdir: true });
  // C6: an old lock (from a process that died) is reused; the lock is removed after.
  const list = path.join(dir, 'list.json');
  fs.writeFileSync(`${list}.lock`, '');
  const old = (Date.now() - 60000) / 1000;
  fs.utimesSync(`${list}.lock`, old, old);
  assert.strictEqual(withLock(list, () => 7), 7);
  assert.ok(!fs.existsSync(`${list}.lock`));
});

test('C6: two processes remembering targets at the same time both keep theirs', () => {
  const stateDir = path.join(dir, 'targets');
  const run = (name) => require('child_process').spawn(process.execPath, ['-e', `const c=require('./lib/connect');for(let i=0;i<20;i++)c.rememberTarget(${JSON.stringify(stateDir)}, ${JSON.stringify(path.join(dir, name))}+i, 'http://127.0.0.1:3000')`], { cwd: path.join(__dirname, '..') });
  return Promise.all([run('x'), run('y')].map((c) => new Promise((r) => c.on('exit', r)))).then(() => {
    const kept = Object.keys(JSON.parse(fs.readFileSync(path.join(stateDir, 'targets.json'), 'utf8')).targets);
    assert.strictEqual(kept.length, 40, 'none lost');
  });
});

test('C8: cuts never split an emoji; a byte order mark is not text', () => {
  const { sliceSafe, stripBom } = require('../lib/textcut');
  assert.strictEqual(sliceSafe('ab😀c', 3), 'ab');
  assert.strictEqual(sliceSafe('ab😀c', 4), 'ab😀');
  assert.strictEqual(stripBom('﻿hi'), 'hi');
  assert.strictEqual(stripBom('hi'), 'hi');
});

test('C10: old Node or Claude Code is named', () => {
  const v = require('../lib/versions');
  assert.match(v.versionWarning({ nodeVersion: '16.20.0' }), /Node 18/);
  assert.strictEqual(v.versionWarning({ nodeVersion: '22.1.0' }), '');
  const fake = path.join(dir, 'oldbin', 'claude');
  fs.mkdirSync(path.dirname(fake));
  fs.writeFileSync(fake, '#!/bin/sh\necho "2.1.100 (Claude Code)"\n', { mode: 0o755 });
  const stateDir = path.join(dir, 'vcheck');
  assert.match(v.versionWarning({ nodeVersion: '22.1.0', exe: fake, stateDir }), /Claude Code 2\.1\.287/);
  fs.writeFileSync(fake, '#!/bin/sh\necho "2.1.300 (Claude Code)"\n', { mode: 0o755 });
  assert.match(v.versionWarning({ nodeVersion: '22.1.0', exe: fake, stateDir }), /2\.1\.100/, 'kept for a day');
  assert.strictEqual(v.older('2.1.300', '2.1.287'), false);
  assert.strictEqual(v.older('nonsense', '2.1.287'), false);
});
