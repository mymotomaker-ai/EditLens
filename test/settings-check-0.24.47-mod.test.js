'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5500';
// Settings check of 0.24.47, SN1: the mod of a Claude EditLens started (page control or a task,
// EDITLENS_DRIVEN) is not the user's Claude Code. The server never counts it as the mod that makes
// the page's changes, and a refused request is reported by its id alone, so the values in effect
// (the user's saved settings) are never replaced by another Claude's defaults.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killPid } = require('./kill');
const settings = require('../lib/settings');

const ROOT = path.join(__dirname, '..');
const PORT = 5500;
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-check-47-'));
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

const token = () => fs.readFileSync(path.join(state, `token-${PORT}`), 'utf8').trim();
const auth = () => ({ 'content-type': 'application/json', 'x-editlens-token': token() });
const modPoll = async (extra = '') => (await fetch(`${base}/summary?cwd=${encodeURIComponent(dir)}&mod=1${extra}`, { headers: auth() })).json();
const change = (body) => fetch(`${base}/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const report = (body) => fetch(`${base}/settings/report`, { method: 'POST', headers: auth(), body: JSON.stringify({ from: 'mod', pid: process.pid, ...body }) });
const values = async () => (await (await fetch(`${base}/settings/report`, { method: 'POST', headers: auth(), body: JSON.stringify({ from: 'mod', pid: process.pid, refused: [] }) })).json()).values;

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

test('SN1: a driven Claude\'s mod is not the live mod, and a refusal never replaces the values in effect', async () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE_PLUGIN_OPTION_')) env[k] = v;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...env, EDITLENS_PORT: String(PORT), EDITLENS_PAIR_PORT: '5501', EDITLENS_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg }, stdio: 'ignore',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  assert.ok(await waitFor(async () => (await fetch(`${base}/health`)).ok), 'server up');
  const page = await openPage('pg1');
  await waitFor(async () => page.frames.length);

  // Only a driven Claude's mod asks: the page can't change settings through it, and a host's
  // /editlens effort is not saved through it.
  await modPoll('&driven=1');
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(page.last().canChange, false, 'a driven mod is not the live mod');
  assert.strictEqual((await change({ page: 'pg1', key: 'theme', value: 'Dark' })).status, 409);
  const effort = await (await fetch(`${base}/effort`, { method: 'POST', headers: auth(), body: JSON.stringify({ level: 'high', cwd: dir }) })).json();
  assert.strictEqual(effort.saved, false, 'not queued for a driven mod');
  assert.deepStrictEqual((await modPoll('&driven=1')).settingsPending, []);

  // The user's Claude Code reports its settings; then a page request is refused by its id alone.
  const mine = { ...settings.defaults(), tasks_at_once: 1, effort: 'Low' };
  assert.strictEqual((await report({ values: mine })).status, 200);
  await modPoll();
  assert.strictEqual((await change({ page: 'pg1', key: 'theme', value: 'Dark' })).status, 200);
  const asked = (await modPoll()).settingsPending;
  assert.deepStrictEqual(asked.map((p) => [p.key, p.value]), [['theme', 'Dark']]);
  assert.strictEqual((await report({ refused: [asked[0].id] })).status, 200, 'a refusal needs no values');
  assert.deepStrictEqual((await modPoll()).settingsPending, [], 'the refused request is removed');
  const now = await values();
  assert.strictEqual(now.tasks_at_once, 1);
  assert.strictEqual(now.effort, 'Low');
  assert.strictEqual(now.theme, 'Auto');
});
