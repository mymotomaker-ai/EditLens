'use strict';
require('./isolate');
// Page control the user didn't turn off never ends silently: the page and summary say why, and after
// a restart or update it is turned on again in the same project and conversation once that project's
// page is open (30 minutes at most). Manual is never undone; another project's page never gets it.
// Also checked against an older version of this server. Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const { killServer: killOwnServer } = require('./kill');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-control-restore-'));
const state = path.join(dir, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
// Two Claude programs (Claude Code's folder before and after an update), and a PATH and home with
// no other claude, so "none found" can be tested.
const bin1 = path.join(dir, 'claude-code', '2.1.1');
const bin2 = path.join(dir, 'claude-code', '2.1.2');
for (const b of [bin1, bin2]) {
  fs.mkdirSync(b, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(b, 'claude'));
  fs.chmodSync(path.join(b, 'claude'), 0o755);
}
const exe1 = path.join(bin1, 'claude');
const exe2 = path.join(bin2, 'claude');
const nodeBin = path.join(dir, 'nodebin');
fs.mkdirSync(nodeBin);
fs.symlinkSync(process.execPath, path.join(nodeBin, 'node'));
fs.mkdirSync(path.join(dir, 'home'));
const PORT = 4331;
// No stand-in from test/isolate.js: this file gives the server its own two programs.
delete process.env.EDITLENS_CLAUDE_PATH;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: String(PORT),
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  EDITLENS_PLUGINS_DIR: path.join(dir, 'plugins'),
  FAKE_CLAUDE_STATE: state,
  PATH: nodeBin,
  HOME: path.join(dir, 'home'),
});

const { ensureServer, stopServer, postJson, getJson, health } = require('../lib/client');
const config = require('../lib/config');
const KEEP = path.join(config.stateDir, 'page-control-on.json');
const projA = path.join(dir, 'test_project');
const projB = path.join(dir, 'my-project');
fs.mkdirSync(projA);
fs.mkdirSync(projB);
const SESSION = '11111111-2222-3333-4444-555555555555';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
async function pagePost(route, body) {
  const res = await fetch(`${config.baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch((err) => ({ parseError: err.message })) };
}
async function grant(body) {
  return postJson('/drive/grant', { claudePath: exe1, ...body }, { timeoutMs: 20000 }).catch((err) => {
    const m = /^server answered (\d+): ([\s\S]*)$/.exec(err.message);
    if (!m) throw err;
    return { status: Number(m[1]), ...JSON.parse(m[2]) };
  });
}
// A page's event stream; frames collects every event. It reconnects like the panel when the server restarts.
function openPage(id, root) {
  const ctrl = new AbortController();
  const frames = [];
  const connect = () => fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(root)}`, { signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!data) continue;
        try {
          frames.push(JSON.parse(data.slice(6)));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  });
  let closed = false;
  const loop = () => connect().catch((err) => {
    if (err.name === 'AbortError') return;
    if (!['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(err.cause && err.cause.code) && !/terminated|fetch failed/.test(err.message)) throw err;
  }).then(() => {
    if (!closed) setTimeout(loop, 300);
  });
  loop();
  return {
    id, frames,
    close: () => { closed = true; ctrl.abort(); },
    key: () => (frames.filter((f) => f.type === 'drive-grant').pop() || {}).key,
    since: (n) => frames.slice(n),
  };
}
function starts() {
  const f = path.join(state, 'queries');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
async function pageListed(id) {
  return until(async () => (await getJson('/pages/live')).some((p) => p.id === id));
}
async function controlA() {
  const pa = openPage('pa' + Date.now(), projA);
  assert.ok(await pageListed(pa.id));
  const g = await grant({ cwd: projA, fresh: true });
  assert.ok(g.ok, JSON.stringify(g));
  assert.ok(await until(() => Boolean(pa.key())), 'pa got the key');
  assert.ok(await until(() => fs.existsSync(KEEP)), 'page control is kept in a file');
  return pa;
}
async function send(pa, text) {
  const r = await pagePost('/drive/message', { key: pa.key(), pageId: pa.id, text });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
}
async function summaryError(cwd) {
  return (await getJson(`/summary?cwd=${encodeURIComponent(cwd)}`)).pageControlError;
}
// Kills the server by its pid, as Windows or a crash would, with no shutdown of its own.
async function killServer() {
  const h = await health();
  assert.ok(h && Number.isInteger(h.pid));
  assert.ok(killOwnServer(h.pid, config.stateDir, 'SIGKILL'), 'the server was signalled');
  assert.ok(await until(async () => !(await health())), 'the server is gone');
}
async function fresh() {
  await stopServer();
  for (const f of [KEEP, path.join(state, 'queries')]) fs.rmSync(f, { force: true });
  await ensureServer();
}

const open = [];
test.after(async () => {
  for (const p of open) p.close();
  await stopServer();
  await sleep(200);
  if (process.env.EDITLENS_KEEP_TEST_DIR) process.stderr.write(`kept ${dir}\n`);
  else fs.rmSync(dir, { recursive: true, force: true });
});

test('Claude ending by itself (no error, or an exit code) is said on the page and in the summary', async () => {
  await fresh();
  let pa = await controlA();
  open.push(pa);
  let n = pa.frames.length;
  await send(pa, 'exit');
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive' && f.phase === 'ended')), 'ended');
  const ended = pa.since(n).find((f) => f.type === 'drive' && f.phase === 'ended');
  assert.strictEqual(ended.error, 'Claude stopped unexpectedly.');
  assert.strictEqual(ended.reason, 'claude-exit');
  assert.strictEqual(await summaryError(projA), 'Claude stopped unexpectedly.');
  pa.close();

  pa = await controlA();
  open.push(pa);
  n = pa.frames.length;
  await send(pa, 'crash');
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive' && f.phase === 'ended')));
  assert.strictEqual(pa.since(n).find((f) => f.type === 'drive' && f.phase === 'ended').error, 'Claude stopped unexpectedly (exit code 1).');
  assert.strictEqual(await summaryError(projA), 'Claude stopped unexpectedly (exit code 1).');
  // Not restored: Claude stopped by itself, EditLens didn't restart.
  assert.strictEqual(JSON.parse(fs.readFileSync(KEEP, 'utf8')).end.restore, false);
  pa.close();
});

test('EditLens restarts: the open page says why, then page control starts again in the same conversation', async () => {
  await fresh();
  const pa = await controlA();
  open.push(pa);
  const n = pa.frames.length;
  const before = starts().length;
  await stopServer(); // like /editlens stop's server stop, or the computer shutting it down
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive' && f.phase === 'ended')));
  assert.strictEqual(pa.since(n).find((f) => f.type === 'drive' && f.phase === 'ended').error, 'EditLens restarted.');
  await ensureServer();
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive-grant' && /^Page control starts again/.test(f.note || '')), 10000), 'starts again');
  const g = pa.since(n).find((f) => f.type === 'drive-grant' && /^Page control starts again/.test(f.note || ''));
  assert.strictEqual(g.note, 'Page control starts again: EditLens restarted. It continues your page conversation.');
  assert.strictEqual(g.cwd, projA);
  const s = starts().slice(before);
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual([s[0].cwd, s[0].resume, s[0].fork], [projA, SESSION, false], 'the same page conversation, continued');
  // The reconnecting page was told why before it reconnected.
  assert.ok(pa.since(n).some((f) => f.type === 'drive-status' && f.active === false && f.error === 'EditLens restarted.'));
  pa.close();
});

test('killed and updated: another project\'s page never gets it, its own page does, with the reason', async () => {
  await fresh();
  const pa = await controlA();
  pa.close();
  const before = starts().length;
  await killServer();
  // The server that was killed ran an older version: this is an update.
  const rec = JSON.parse(fs.readFileSync(KEEP, 'utf8'));
  fs.writeFileSync(KEEP, JSON.stringify({ ...rec, version: '0.24.14' }));
  await ensureServer();
  const pb = openPage('pb', projB);
  open.push(pb);
  assert.ok(await pageListed('pb'));
  await sleep(1500);
  assert.strictEqual(starts().length, before, 'my-project\'s page does not start it');
  assert.ok(!pb.frames.some((f) => f.type === 'drive-grant'));
  assert.strictEqual(await summaryError(projA), 'EditLens was updated and restarted.');
  const pa2 = openPage('pa2', projA);
  open.push(pa2);
  assert.ok(await until(() => pa2.frames.some((f) => f.type === 'drive-grant'), 10000));
  assert.ok(pa2.frames.some((f) => f.type === 'drive-error' && f.error === 'EditLens was updated and restarted.'));
  assert.strictEqual(pa2.frames.find((f) => f.type === 'drive-grant').note, 'Page control starts again: EditLens was updated and restarted. It continues your page conversation.');
  assert.deepStrictEqual(starts().slice(before).map((s) => [s.cwd, s.resume]), [[projA, SESSION]]);
  pb.close();
  pa2.close();
});

test('Manual chosen by the user is never started again', async () => {
  await fresh();
  const pa = await controlA();
  pa.close();
  await postJson('/drive/end', {}); // /editlens manual
  assert.ok(!fs.existsSync(KEEP));
  const before = starts().length;
  await stopServer();
  await ensureServer();
  const pa2 = openPage('pa3', projA);
  open.push(pa2);
  assert.ok(await pageListed('pa3'));
  await sleep(1500);
  assert.strictEqual(starts().length, before);
  assert.ok(!pa2.frames.some((f) => f.type === 'drive-grant' || f.type === 'drive-error'));
  pa2.close();
});

test('more than 30 minutes later it is not started again', async () => {
  await fresh();
  const pa = await controlA();
  pa.close();
  await killServer();
  const rec = JSON.parse(fs.readFileSync(KEEP, 'utf8'));
  fs.writeFileSync(KEEP, JSON.stringify({ ...rec, aliveAt: Date.now() - 31 * 60000 }));
  const before = starts().length;
  await ensureServer();
  const pa2 = openPage('pa4', projA);
  open.push(pa2);
  assert.ok(await pageListed('pa4'));
  await sleep(1500);
  assert.strictEqual(starts().length, before);
  assert.ok(!pa2.frames.some((f) => f.type === 'drive-grant' || f.type === 'drive-error'));
  pa2.close();
});

test('the Claude program is removed (Claude Code updated): the current one continues; none left: it says why', async () => {
  await fresh();
  const pa = await controlA();
  open.push(pa);
  assert.strictEqual(starts().pop().exe, exe1);
  // A session of the updated Claude Code reports its program.
  await postJson('/event', { type: 'note', sessionId: 's-new', cwd: projA, execPath: exe2 });
  fs.rmSync(exe1);
  let n = pa.frames.length;
  await send(pa, 'exit'); // the old process is gone
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive-note')), 'a note on the page');
  assert.strictEqual(pa.since(n).find((f) => f.type === 'drive-note').text,
    `Page control starts again: the Claude program it used was removed (Claude Code updated). It now uses ${exe2}. It continues your page conversation.`);
  assert.ok(!pa.since(n).some((f) => f.type === 'drive' && f.phase === 'ended'), 'page control did not end');
  const last = starts().pop();
  assert.deepStrictEqual([last.exe, last.resume, last.fork], [exe2, SESSION, false]);
  // Still the same key: the page keeps working.
  assert.ok(await until(async () => (await getJson('/summary')).control === 'page'));
  await send(pa, 'hello');

  fs.rmSync(exe2);
  n = pa.frames.length;
  await send(pa, 'exit');
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive' && f.phase === 'ended')));
  const why = 'The Claude program it used was removed (Claude Code updated). No other Claude program was found on this computer. Run /editlens control in Claude Code.';
  assert.strictEqual(pa.since(n).find((f) => f.type === 'drive' && f.phase === 'ended').error, why);
  assert.strictEqual(await summaryError(projA), why);
  pa.close();
  for (const [b, e] of [[bin1, exe1], [bin2, exe2]]) {
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), e);
    fs.chmodSync(path.join(b, 'claude'), 0o755);
  }
});

test('a waiting update never ends page control, even while it starts; once it ended, the new server starts it again', async () => {
  await fresh();
  const pa = await controlA();
  open.push(pa);
  // An update asks; page control runs: it waits.
  const r = await fetch(`${config.baseUrl}/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': fs.readFileSync(config.tokenFile, 'utf8') }, body: JSON.stringify({ force: false, version: '9.9.9' }) });
  assert.strictEqual(r.status, 409);
  // Pages and the summary say a newer EditLens is installed.
  assert.ok(await until(() => pa.frames.some((f) => f.type === 'update-waiting' && f.installed === '9.9.9' && f.running === config.version && f.busy === 'page control')));
  assert.strictEqual((await getJson('/summary')).installed, '9.9.9');
  const n = pa.frames.length;
  await send(pa, 'exit'); // ends without the user choosing it
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive' && f.phase === 'ended')));
  // The heartbeat lets the waiting update continue (15 s at most).
  assert.ok(await until(async () => !(await health()), 20000), 'the old server stopped for the update');
  const before = starts().length;
  await ensureServer();
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive-grant' && /^Page control starts again/.test(f.note || '')), 10000));
  assert.ok(pa.since(n).some((f) => f.type === 'drive-status' && f.active === false && f.error === 'Claude stopped unexpectedly. Then EditLens was updated and restarted.'));
  assert.deepStrictEqual(starts().slice(before).map((s) => [s.cwd, s.resume]), [[projA, SESSION]]);
  pa.close();
});

test('a start in progress counts as page control for an update', async () => {
  await fresh();
  const pa = openPage('pa5', projA);
  open.push(pa);
  assert.ok(await pageListed('pa5'));
  // Slow to start, like the real SDK the first time.
  await stopServer();
  process.env.FAKE_SDK_IMPORT_MS = '2500';
  await ensureServer();
  try {
    assert.ok(await pageListed('pa5'));
    const g = grant({ cwd: projA, fresh: true });
    await sleep(600);
    const r = await fetch(`${config.baseUrl}/shutdown`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': fs.readFileSync(config.tokenFile, 'utf8') }, body: JSON.stringify({ force: false }) });
    assert.strictEqual(r.status, 409);
    assert.deepStrictEqual(await r.json(), { busy: 'page control' });
    assert.ok((await g).ok);
  } finally {
    delete process.env.FAKE_SDK_IMPORT_MS;
    pa.close();
    await stopServer();
  }
});

// ---------- the newest installed copy ----------
test('a server is started from the newest installed copy of the plugin, never an older one', async () => {
  const { newestCopy } = require('../lib/client');
  const plugins = process.env.EDITLENS_PLUGINS_DIR;
  const copy = (root, version) => {
    for (const d of ['lib', 'server', 'client']) fs.cpSync(path.join(__dirname, '..', d), path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'editlens', version }));
  };
  copy(path.join(plugins, 'cache', 'editlens', 'editlens', '0.1.0'), '0.1.0');
  assert.strictEqual(newestCopy().version, config.version, 'an older copy is never used');
  const newest = path.join(plugins, 'cache', 'editlens', 'editlens', '99.0.0');
  copy(newest, '99.0.0');
  fs.writeFileSync(path.join(plugins, 'installed_plugins.json'), JSON.stringify({ plugins: { 'editlens@editlens': [{ installPath: path.join(plugins, 'cache', 'editlens', 'editlens', '0.1.0') }] } }));
  // Not a plugin copy: ignored.
  fs.mkdirSync(path.join(plugins, 'cache', 'editlens', 'editlens', 'junk'), { recursive: true });
  fs.writeFileSync(path.join(plugins, 'cache', 'editlens', 'editlens', 'junk', 'package.json'), '{ not json');
  assert.deepStrictEqual([newestCopy().version, newestCopy().root], ['99.0.0', newest]);
  await stopServer();
  try {
    const r = await ensureServer();
    assert.strictEqual(r.started, true);
    assert.strictEqual((await health()).version, '99.0.0');
    // A hook of this (older) copy keeps the newer server.
    assert.strictEqual((await ensureServer()).started, false);
    assert.strictEqual((await health()).version, '99.0.0');
  } finally {
    await stopServer();
    fs.rmSync(plugins, { recursive: true, force: true });
  }
});

// ---------- against an older EditLens ----------
// A copy of this code that reports an older version, so the test needs no git history.
const OLD_VERSION = '0.24.14';
const OLD_PARTS = ['server', 'lib', 'client', 'bin', 'hooks', 'integrations', 'mcp', '.claude-plugin', 'package.json'];
let oldRoot = null;
function oldServer() {
  if (!oldRoot) {
    oldRoot = path.join(dir, 'old-' + OLD_VERSION);
    const repo = path.join(__dirname, '..');
    for (const part of OLD_PARTS) fs.cpSync(path.join(repo, part), path.join(oldRoot, part), { recursive: true });
    for (const file of ['package.json', path.join('.claude-plugin', 'plugin.json')]) {
      const f = path.join(oldRoot, file);
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), version: OLD_VERSION }, null, 2) + '\n');
    }
  }
  fs.mkdirSync(config.stateDir, { recursive: true });
  const out = fs.openSync(config.logFile, 'a');
  const child = spawn(process.execPath, [path.join(oldRoot, 'server', 'server.js')], { env: process.env, stdio: ['ignore', out, out], detached: false });
  fs.closeSync(out);
  return child;
}
async function oldControlA() {
  const pa = openPage('old' + Date.now(), projA);
  open.push(pa);
  assert.ok(await pageListed(pa.id));
  const g = await grant({ cwd: projA, fresh: true });
  assert.ok(g.ok, JSON.stringify(g));
  assert.ok(await until(() => Boolean(pa.key())));
  assert.ok(await until(async () => (await getJson('/summary')).control === 'page'));
  return pa;
}

test('0.24.14 running page control: the update waits, then page control starts again in the new server with the reason', async () => {
  await stopServer();
  for (const f of [KEEP, path.join(state, 'queries')]) fs.rmSync(f, { force: true });
  const child = oldServer();
  try {
    assert.ok(await until(async () => ((await health()) || {}).version === '0.24.14'));
    const pa = await oldControlA();
    // A session of the new plugin starts (or the next prompt): the old server keeps page control.
    const r = await ensureServer();
    assert.deepStrictEqual([r.waiting, r.running, r.installed], ['page control', '0.24.14', config.version]);
    assert.strictEqual(JSON.parse(fs.readFileSync(KEEP, 'utf8')).cwd, projA, 'where page control runs is saved for the new server');
    // Page control ends there without the user choosing it; 0.24.14 then exits for the update.
    await send(pa, 'exit');
    assert.ok(await until(async () => !(await health()), 20000), '0.24.14 exited for the waiting update');
    const before = starts().length;
    await ensureServer();
    assert.strictEqual((await health()).version, config.version);
    assert.ok(await until(() => pa.frames.some((f) => f.type === 'drive-grant' && /^Page control starts again/.test(f.note || '')), 10000), 'page control starts again');
    assert.strictEqual(pa.frames.filter((f) => f.type === 'drive-grant').pop().note, 'Page control starts again: EditLens was updated and restarted. It continues your page conversation.');
    assert.deepStrictEqual(starts().slice(before).map((s) => [s.cwd, s.resume, s.fork]), [[projA, SESSION, false]]);
    pa.close();
  } finally {
    child.kill();
    await stopServer();
  }
});

test('0.24.14: Manual chosen there before the update is not undone; /editlens restart starts page control again now', async () => {
  for (const f of [KEEP, path.join(state, 'queries')]) fs.rmSync(f, { force: true });
  let child = oldServer();
  try {
    assert.ok(await until(async () => ((await health()) || {}).version === '0.24.14'));
    let pa = await oldControlA();
    assert.ok((await ensureServer()).waiting);
    await postJson('/drive/end', {}); // /editlens manual, typed in an old session
    assert.ok(await until(async () => !(await health()), 20000));
    let before = starts().length;
    await ensureServer();
    await sleep(1500);
    assert.strictEqual(starts().length, before, 'Manual stays Manual');
    assert.ok(!fs.existsSync(KEEP));
    pa.close();
    await stopServer();

    // /editlens restart while 0.24.14 runs page control.
    child = oldServer();
    assert.ok(await until(async () => ((await health()) || {}).version === '0.24.14'));
    pa = await oldControlA();
    before = starts().length;
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'restart.js')], { env: process.env, encoding: 'utf8', timeout: 60000 });
    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    assert.match(out.stdout, /restarted/);
    assert.match(out.stdout, /0\.24\.14 → /);
    assert.match(out.stdout, /Page control starts again/);
    assert.strictEqual((await health()).version, config.version);
    assert.ok(await until(() => pa.frames.some((f) => f.type === 'drive-grant' && /^Page control starts again/.test(f.note || '')), 10000));
    assert.deepStrictEqual(starts().slice(before).map((s) => [s.cwd, s.resume]), [[projA, SESSION]]);
    pa.close();
  } finally {
    child.kill();
    await stopServer();
  }
});

test('a prompt in a new-plugin session replaces an older server as soon as nothing runs in it', async () => {
  for (const f of [KEEP]) fs.rmSync(f, { force: true });
  const child = oldServer();
  try {
    assert.ok(await until(async () => ((await health()) || {}).version === '0.24.14'));
    const hook = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'prompt'], {
      input: JSON.stringify({ session_id: 's-prompt', cwd: projA, prompt: 'hi' }), env: process.env, encoding: 'utf8', timeout: 30000,
    });
    assert.strictEqual(hook.status, 0, hook.stderr);
    assert.strictEqual((await health()).version, config.version);
  } finally {
    child.kill();
    await stopServer();
  }
});

// Claude Code can't continue a conversation it doesn't have: the first /editlens in a new session
// (nothing written yet), or an id from another folder or account. A new chat starts in the same
// command, and the user never sees Claude Code's raw error or an id.
const GHOST = 'f5aaa32e-616a-4598-b1bf-82fc6ed132e7';
const NEW_CHAT = "Started a new chat: the earlier one wasn't found.";
test('a conversation that isn\'t found: a new chat starts immediately, in plain words, with no id shown', async () => {
  await fresh();
  const known = path.join(state, 'known-sessions');
  fs.writeFileSync(known, SESSION + '\n');
  try {
    const pa = openPage('pnf', projA);
    open.push(pa);
    assert.ok(await pageListed('pnf'));
    // A session that just started in this project: its transcript isn't written yet.
    const transcript = path.join(dir, 'home', '.claude', 'projects', 'p', `${GHOST}.jsonl`);
    await postJson('/event', { type: 'session', sessionId: GHOST, cwd: projA, transcriptPath: transcript });
    let before = starts().length;
    let g = await grant({ cwd: projA });
    assert.ok(g.ok, JSON.stringify(g));
    assert.deepStrictEqual(starts().slice(before).map((s) => s.resume), [null], 'a session with nothing written is not continued');
    await postJson('/drive/end', {});
    assert.ok(await until(() => pa.frames.some((f) => f.type === 'drive' && f.phase === 'ended')));

    // The id named in /editlens control <id> (or one Claude Code doesn't have): Claude Code says
    // "No conversation found"; a new chat starts in the same command.
    const n = pa.frames.length;
    before = starts().length;
    const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'drive.js'), GHOST], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projA, CLAUDE_CODE_EXECPATH: exe1 }, encoding: 'utf8', timeout: 60000,
    });
    assert.strictEqual(out.status, 0, out.stdout + out.stderr);
    assert.ok(out.stdout.includes(NEW_CHAT), out.stdout);
    assert.ok(!out.stdout.includes(GHOST) && !/No conversation|error result/i.test(out.stdout), out.stdout);
    assert.deepStrictEqual(starts().slice(before).map((s) => s.resume), [GHOST, null], 'tried it, then a new chat');
    assert.strictEqual((await getJson(`/summary?cwd=${encodeURIComponent(projA)}`)).control, 'page');
    assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive-note')));
    assert.strictEqual(pa.since(n).find((f) => f.type === 'drive-note').text, NEW_CHAT);
    // Nothing the page shows has Claude Code's words or the id: no end, no error, no note with it.
    const shown = pa.since(n).filter((f) => ['drive-note', 'drive-error', 'drive-grant'].includes(f.type) || (f.type === 'drive' && f.phase === 'ended'));
    assert.ok(!shown.some((f) => f.type === 'drive-error' || f.type === 'drive'), JSON.stringify(shown));
    assert.ok(!JSON.stringify(shown.map((f) => [f.text, f.note, f.error])).includes(GHOST));
    assert.strictEqual(await summaryError(projA), null);
    // The raw text stays in the server log.
    assert.match(fs.readFileSync(config.logFile, 'utf8'), new RegExp(`No conversation found with session ID: ${GHOST}`));
    await send(pa, 'hello again');
    assert.ok(await until(() => /hello again/.test(fs.existsSync(path.join(state, 'answered')) ? fs.readFileSync(path.join(state, 'answered'), 'utf8') : '')));
    await postJson('/drive/end', {});
    pa.close();
  } finally {
    fs.rmSync(known, { force: true });
  }
});

test('an error result EditLens has no words for: plain words on the page, the raw text only in the log', async () => {
  await fresh();
  const pa = await controlA();
  open.push(pa);
  const n = pa.frames.length;
  await send(pa, 'odd');
  assert.ok(await until(() => pa.since(n).some((f) => f.type === 'drive' && f.phase === 'ended')));
  const ended = pa.since(n).find((f) => f.type === 'drive' && f.phase === 'ended');
  assert.strictEqual(ended.error, `Claude stopped with an error. The details are in the EditLens log: ${config.logFile}`);
  assert.strictEqual(ended.reason, 'error');
  assert.strictEqual(await summaryError(projA), ended.error);
  assert.match(fs.readFileSync(config.logFile, 'utf8'), /Unexpected state in session 99999999-8888-7777-6666-555555555555/);
  pa.close();
});
