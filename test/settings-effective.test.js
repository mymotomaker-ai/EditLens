'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5400';
// Sol 0.24.46 settings rows: the safety check follows the setting in effect, not the environment the
// server started with (M4); a page's request is not in effect until Claude Code has it, and a refusal
// removes it (M10); arrays and objects are never setting values (L5); an answered permission question
// leaves no listener on its abort signal (B5).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { getEventListeners } = require('events');
const { killPid } = require('./kill');
const settings = require('../lib/settings');
const guard = require('../lib/guard');
const { Driver } = require('../server/driver');

const ROOT = path.join(__dirname, '..');
const PORT = 5400;
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-effective-'));
const state = path.join(dir, 'state');
const cfg = path.join(dir, 'claude');
fs.mkdirSync(cfg);
fs.writeFileSync(path.join(cfg, 'settings.json'), '{}');
const children = new Set();
const streams = new Set();

test.after(async () => {
  for (const s of streams) s.destroy();
  await Promise.all([...children].map((c) => new Promise((resolve) => {
    c.once('exit', () => resolve());
    killPid(c.pid, 'SIGTERM');
  })));
  fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch((err) => {
      if (err && (err.code === 'ECONNREFUSED' || (err.cause && err.cause.code === 'ECONNREFUSED') || err.code === 'ENOENT')) return null;
      throw err;
    });
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// A file of 20 lines, and a Write that replaces it: the safety check asks about it.
function bigWrite() {
  const file = path.join(dir, 'App.jsx');
  fs.writeFileSync(file, Array.from({ length: 20 }, (_, i) => `export const a${i} = ${i};`).join('\n'));
  return { file_path: file, content: 'export default 1;\n' };
}

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) saved[k] = process.env[k];
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  return Promise.resolve(out).finally(restore);
}

test('M4: the safety check follows the setting in effect, not the environment the server started with', async () => {
  const input = bigWrite();
  // The server started with "off" in its environment; the setting in effect is On (held, or changed since).
  await withEnv({ CLAUDE_PLUGIN_OPTION_SAFETY_CHECK: 'false', EDITLENS_GUARD: undefined }, async () => {
    assert.ok(guard.check('Write', input, dir, { off: false }), 'check: the setting in effect is On');
    assert.ok(await guard.checkAsync('Write', input, dir, { off: false }), 'checkAsync: the setting in effect is On');
    const d = new Driver({ root: false, emit: () => {}, log: () => {}, stateDir: state, platform: 'linux', settings: () => ({ ...settings.defaults(), safety_check: true }) });
    const run = { mode: 'auto', cwd: dir, agentModes: new Map(), taskTool: new Map(), guards: new Map() };
    const out = await d.agentRule(run, { tool_name: 'Write', tool_input: input, tool_use_id: 'tu1' });
    assert.strictEqual(out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision, 'ask', JSON.stringify(out));
    // No setting given (a hook): its environment is the setting.
    assert.strictEqual(guard.check('Write', input, dir), null);
  });
  await withEnv({ CLAUDE_PLUGIN_OPTION_SAFETY_CHECK: 'true', EDITLENS_GUARD: undefined }, async () => {
    assert.strictEqual(guard.check('Write', input, dir, { off: true }), null, 'the setting in effect is Off');
    assert.ok(guard.check('Write', input, dir));
  });
  // EDITLENS_GUARD=off still turns it off, as README and /editlens settings say.
  await withEnv({ CLAUDE_PLUGIN_OPTION_SAFETY_CHECK: undefined, EDITLENS_GUARD: 'off' }, async () => {
    assert.strictEqual(guard.check('Write', input, dir, { off: false }), null);
  });
});

test('L5: arrays and objects are not setting values', () => {
  for (const raw of [['off'], ['1'], ['Dark'], { toString: () => 'on' }, {}, []]) {
    for (const key of ['safety_check', 'wait', 'tasks_at_once', 'port', 'theme']) {
      assert.strictEqual(settings.check(key, raw), undefined, `${key} = ${JSON.stringify(raw)}`);
    }
  }
  assert.strictEqual(settings.normalize({ safety_check: ['off'] }).safety_check, true, 'the default');
  // The spellings that count are kept.
  assert.strictEqual(settings.check('safety_check', 'off'), false);
  assert.strictEqual(settings.check('wait', true), true);
  assert.strictEqual(settings.check('tasks_at_once', 3), 3);
  assert.strictEqual(settings.check('tasks_at_once', '3'), 3);
});

test('B5: an answered permission question leaves no listener on its abort signal', async () => {
  const d = new Driver({ root: false, emit: () => {}, log: () => {}, stateDir: state, platform: 'linux' });
  const run = { cwd: dir, permissions: new Map(), guards: new Map(), taskTool: new Map(), agentModes: new Map() };
  d.run = run;
  const signal = new AbortController().signal;
  for (let i = 0; i < 3; i++) {
    const asked = d.ask(run, 'Bash', { command: 'ls' }, { signal });
    assert.strictEqual(getEventListeners(signal, 'abort').length, 1);
    const [id] = [...run.permissions.keys()];
    assert.deepStrictEqual(d.answer(id, 'deny'), { ok: true });
    assert.strictEqual((await asked).behavior, 'deny');
    assert.strictEqual(getEventListeners(signal, 'abort').length, 0, `after answer ${i + 1}`);
  }
  // Cancelled through the signal: the question ends as before.
  const ctl = new AbortController();
  const asked = d.ask(run, 'Bash', { command: 'ls' }, { signal: ctl.signal });
  ctl.abort();
  assert.deepStrictEqual(await asked, { behavior: 'deny', message: 'Cancelled.' });
  assert.strictEqual(run.permissions.size, 0);
});

// ---------- M10: the live server ----------
const token = () => fs.readFileSync(path.join(state, `token-${PORT}`), 'utf8').trim();
const auth = () => ({ 'content-type': 'application/json', 'x-editlens-token': token() });
const modPoll = async () => (await fetch(`${base}/summary?cwd=${encodeURIComponent(dir)}&mod=1`, { headers: auth() })).json();
const pending = async () => (await modPoll()).settingsPending;
const change = (body) => fetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const report = (body) => fetch(`${base}/settings/report`, { method: 'POST', headers: auth(), body: JSON.stringify({ from: 'mod', pid: process.pid, ...body }) });
// The level page control and new tasks start with: the setting in effect.
const effortInEffect = async () => (await (await fetch(`${base}/effort?cwd=${encodeURIComponent(dir)}`, { headers: auth() })).json()).setting;

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
          if (line && JSON.parse(line.slice(6)).type === 'settings') frames.push(JSON.parse(line.slice(6)));
        }
      });
      resolve({ frames, last: () => frames[frames.length - 1] });
    });
    streams.add(req);
    req.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
  });
}

test('M10: a page\'s request is not in effect until Claude Code has it; a refusal removes it', async () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE_PLUGIN_OPTION_')) env[k] = v;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...env, EDITLENS_PORT: String(PORT), EDITLENS_PAIR_PORT: '5401', EDITLENS_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg }, stdio: 'ignore',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  assert.ok(await waitFor(async () => (await fetch(`${base}/health`)).ok), 'server up');
  const page = await openPage('pg1');
  await waitFor(async () => page.frames.length);
  await modPoll();

  // The page asks for High: the page shows it, but nothing starts with it before Claude Code has it.
  assert.strictEqual((await change({ page: 'pg1', key: 'effort', value: 'High' })).status, 200);
  const asked = await pending();
  assert.deepStrictEqual(asked.map((p) => [p.key, p.value]), [['effort', 'High']]);
  assert.ok(await waitFor(async () => page.last().values.effort === 'High'), 'the page shows the request');
  assert.notStrictEqual(await effortInEffect(), 'high', 'a request is not in effect');

  // Claude Code refused it (a policy): the mod says so, the request is removed, and the page shows
  // the value in effect.
  assert.strictEqual((await report({ values: settings.defaults(), refused: [asked[0].id] })).status, 200);
  assert.deepStrictEqual(await pending(), [], 'the refused request is removed');
  assert.ok(await waitFor(async () => page.last().values.effort === 'Auto'), 'the page shows the value in effect');

  // Accepted: Claude Code reports it, and it is in effect.
  assert.strictEqual((await change({ page: 'pg1', key: 'effort', value: 'High' })).status, 200);
  assert.strictEqual((await report({ values: { ...settings.defaults(), effort: 'High' } })).status, 200);
  assert.deepStrictEqual(await pending(), []);
  assert.strictEqual(await effortInEffect(), 'high');
  // Only the mod's report removes a request; ids that are not numbers are ignored.
  assert.strictEqual((await change({ page: 'pg1', key: 'theme', value: 'Dark' })).status, 200);
  const theme = (await pending())[0];
  assert.strictEqual((await report({ from: 'hook', values: { ...settings.defaults(), effort: 'High' }, refused: [theme.id] })).status, 200);
  assert.strictEqual((await report({ values: { ...settings.defaults(), effort: 'High' }, refused: ['x', null, { id: theme.id }] })).status, 200);
  assert.deepStrictEqual((await pending()).map((p) => p.key), ['theme']);
});
