'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5317';
// Settings check, part 1 and 2: the values a server starts with go through the same hold as a report,
// and a Deny in the EditLens window survives a restart (S2); a quick second change from the page is
// not lost (S3); pages hear immediately when the mod stops (S4); POST /settings takes only a key that
// is text and a value of the setting's own JSON type (S16), and names a setting that doesn't exist (S18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killPid } = require('./kill');
const { windowKey } = require('./answer-helper');

const ROOT = path.join(__dirname, '..');
const PORT = 5317;
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-hold-'));
const state = path.join(dir, 'state');
const cfg = path.join(dir, 'claude');
fs.mkdirSync(cfg);
const settingsFile = path.join(cfg, 'settings.json');
const children = new Set();
const streams = new Set();

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// The environment without this machine's own plugin settings, plus these.
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE_PLUGIN_OPTION_')) env[k] = v;
  return { ...env, EDITLENS_PORT: String(PORT), EDITLENS_PAIR_PORT: '5318', EDITLENS_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg, ...extra };
}

async function start(options = {}) {
  const env = {};
  for (const [k, v] of Object.entries(options)) env['CLAUDE_PLUGIN_OPTION_' + k.toUpperCase()] = v;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: cleanEnv(env), stdio: 'ignore' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  assert.ok(await waitFor(async () => (await fetch(`${base}/health`)).ok), 'server up');
}

// Every server this file started, also one a failed test left running.
function stop() {
  for (const s of streams) s.destroy();
  streams.clear();
  return Promise.all([...children].map((c) => new Promise((resolve) => {
    c.once('exit', () => resolve());
    killPid(c.pid, 'SIGTERM');
  })));
}

const token = () => fs.readFileSync(path.join(state, `token-${PORT}`), 'utf8').trim();
const now = async () => (await (await fetch(`${base}/settings`)).json()).values;
async function questions() {
  const key = await windowKey(base);
  const headers = { 'content-type': 'application/json', 'x-editlens-answer': key, 'sec-fetch-site': 'same-origin' };
  return { headers, qs: (await (await fetch(`${base}/answer/list`, { headers })).json()).questions.filter((q) => q.kind === 'setting') };
}
// The mod's poll: it makes the mod count as running for 8 seconds. -> the summary
const modPoll = async () => (await fetch(`${base}/summary?cwd=${encodeURIComponent(dir)}&mod=1`, { headers: { 'x-editlens-token': token() } })).json();
const pending = async () => (await modPoll()).settingsPending.map((p) => [p.key, p.value]);
const change = (body) => fetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const report = (values) => fetch(`${base}/settings/report`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': token() }, body: JSON.stringify({ values, from: 'mod', pid: process.pid }) });

// A page's event stream, kept open: its settings events, newest last.
function openPage(id) {
  const frames = [];
  return new Promise((resolve, reject) => {
    const req = http.get(`${base}/events?page=${id}&root=${encodeURIComponent(dir)}`, (res) => {
      let buf = '';
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (line && JSON.parse(line.slice(6)).type === 'settings') frames.push({ at: Date.now(), ev: JSON.parse(line.slice(6)) });
        }
      });
      resolve({ frames, last: () => frames[frames.length - 1].ev });
    });
    streams.add(req);
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
  });
}

test.afterEach(() => stop());
test.after(async () => {
  await stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the values a server starts with are held like a report; a Deny survives a restart (S2)', async () => {
  // Claude Code saved "off"; the hook that starts the server still has "on" (a session that began before).
  fs.writeFileSync(settingsFile, JSON.stringify({ pluginConfigs: { 'editlens@test': { options: { remote_tasks: false } } } }));
  await start({ remote_tasks: 'true' });
  assert.strictEqual((await now()).remote_tasks, false, 'not in effect at start');
  let w = await questions();
  assert.deepStrictEqual(w.qs.map((q) => q.title), ['Let paired computers run Claude here']);
  const res = await fetch(`${base}/answer`, { method: 'POST', headers: w.headers, body: JSON.stringify({ kind: 'setting', id: w.qs[0].id, decision: 'deny' }) });
  assert.strictEqual(res.status, 200);
  await stop();

  // The same hook starts it again: still off, and not asked again.
  await start({ remote_tasks: 'true' });
  assert.strictEqual((await now()).remote_tasks, false, 'still off after a restart');
  assert.deepStrictEqual((await questions()).qs, [], 'the Deny is kept');
  // The report changes (the stricter value): the Deny is forgotten, so "on" is asked about again.
  assert.strictEqual((await report({ remote_tasks: false })).status, 200);
  assert.strictEqual((await report({ remote_tasks: true })).status, 200);
  assert.deepStrictEqual((await questions()).qs.map((q) => q.title), ['Let paired computers run Claude here']);
  await stop();

  // No plugin options in the environment: Claude Code's saved value, not the default (on).
  await start({});
  assert.strictEqual((await now()).remote_tasks, false, 'the saved value at start');
  assert.deepStrictEqual((await questions()).qs, []);
  await stop();

  // Less strict than the default and saved nowhere: held and asked about.
  fs.writeFileSync(settingsFile, '{}');
  await start({ safety_check: 'false', paired_answers: 'true', permission_mode: "Don't ask" });
  const v = await now();
  assert.deepStrictEqual([v.safety_check, v.paired_answers, v.permission_mode], [true, false, 'Auto']);
  w = await questions();
  assert.deepStrictEqual(w.qs.map((q) => q.title).sort(), ['Let paired computers answer questions here', "Page control: use Don't ask", 'Turn off the safety check']);
  await stop();

  // Stricter than the default: in effect immediately, nothing asked.
  await start({ remote_tasks: 'false', permission_mode: 'Ask' });
  const s = await now();
  assert.deepStrictEqual([s.remote_tasks, s.permission_mode], [false, 'Ask']);
  assert.deepStrictEqual((await questions()).qs, []);
  await stop();
});

test('a quick change back, or Reset, right after a change is still made in Claude Code (S3)', async () => {
  fs.writeFileSync(settingsFile, '{}');
  await start({});
  const page = await openPage('pg1');
  await waitFor(async () => page.frames.length);
  await modPoll();
  // Theme Light, then Auto: the mod made Light already but has not reported it yet.
  assert.strictEqual((await change({ page: 'pg1', key: 'theme', value: 'Light' })).status, 200);
  assert.deepStrictEqual(await pending(), [['theme', 'Light']]);
  assert.strictEqual((await change({ page: 'pg1', key: 'theme', value: 'Auto' })).status, 200);
  assert.deepStrictEqual(await pending(), [['theme', 'Auto']], 'the change back waits for the mod too');
  // The mod reports Light (its first change), then makes Auto and reports it.
  await report({ theme: 'Light' });
  assert.deepStrictEqual(await pending(), [['theme', 'Auto']]);
  await report({ theme: 'Auto' });
  assert.deepStrictEqual(await pending(), []);
  assert.strictEqual((await now()).theme, 'Auto');

  // Editor Cursor, then Reset: every default the page may change waits for the mod, start and editor too.
  assert.strictEqual((await change({ page: 'pg1', key: 'start', value: 'Connect the page' })).status, 200);
  assert.strictEqual((await change({ page: 'pg1', key: 'editor', value: 'Cursor' })).status, 200);
  assert.strictEqual((await change({ page: 'pg1', reset: true })).status, 200);
  const after = new Map(await pending());
  assert.strictEqual(after.get('start'), 'Connect and turn on page control');
  assert.strictEqual(after.get('editor'), 'VS Code');
  assert.ok(!after.has('theme'), 'a value nobody changed is not asked for again');
  await report({});
  assert.deepStrictEqual(await pending(), []);

  // /editlens effort: High, then Auto immediately.
  const effort = (level) => fetch(`${base}/effort`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': token() }, body: JSON.stringify({ level }) });
  assert.strictEqual((await effort('high')).status, 200);
  assert.strictEqual((await effort('auto')).status, 200);
  assert.deepStrictEqual(await pending(), [['effort', 'Auto']]);
  await stop();
});

test('pages hear when the mod stops, without waiting for another change (S4)', async () => {
  await start({});
  const page = await openPage('pg2');
  await waitFor(async () => page.frames.length);
  await modPoll();
  assert.ok(await waitFor(async () => page.last().canChange === true), 'the mod runs: pages may change settings');
  const since = Date.now();
  // The mod polls no more (Claude Code closed): within a few seconds of the 8 the server waits for it.
  assert.ok(await waitFor(async () => page.last().canChange === false, 14000), 'pages hear that changes stay on the page');
  assert.ok(Date.now() - since < 13000);
  await stop();
});

test('POST /settings takes a key that is text and a value of the setting\'s own type (S16, S18)', async () => {
  await start({});
  const page = await openPage('pg3');
  await waitFor(async () => page.frames.length);
  await modPoll();
  const tryIt = async (body) => {
    const r = await change({ page: 'pg3', ...body });
    return [r.status, (await r.json()).error];
  };
  const NO_SETTING = 'There is no setting with that name.';
  assert.deepStrictEqual(await tryIt({ key: ['theme'], value: 'Light' }), [400, NO_SETTING]);
  assert.deepStrictEqual(await tryIt({ key: 'nope', value: 'Light' }), [400, NO_SETTING]);
  assert.deepStrictEqual(await tryIt({ key: '__proto__', value: 'Light' }), [400, NO_SETTING]);
  // A setting that exists but only Claude Code changes.
  assert.strictEqual((await tryIt({ key: 'safety_check', value: false }))[0], 403);
  // Text for a switch or a number: refused.
  const BAD = 'That value does not fit this setting.';
  assert.deepStrictEqual(await tryIt({ key: 'highlight', value: 'no' }), [400, BAD]);
  assert.deepStrictEqual(await tryIt({ key: 'highlight', value: 0 }), [400, BAD]);
  assert.deepStrictEqual(await tryIt({ key: 'tasks_at_once', value: '5' }), [400, BAD]);
  assert.deepStrictEqual(await tryIt({ key: 'theme', value: true }), [400, BAD]);
  assert.deepStrictEqual(await pending(), [], 'nothing was asked for');
  // The JSON types themselves still work.
  assert.strictEqual((await tryIt({ key: 'highlight', value: false }))[0], 200);
  assert.strictEqual((await tryIt({ key: 'tasks_at_once', value: 5 }))[0], 200);
  assert.deepStrictEqual(await pending(), [['highlight', false], ['tasks_at_once', 5]]);
  await stop();
});
