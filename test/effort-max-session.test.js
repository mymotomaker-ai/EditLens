'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5403';
// D24 (the user's choice A): Max effort lasts for one session and is never saved. The Effort
// setting has no Max; /editlens effort max changes only the page control session running now; a
// page conversation keeps Max only when EditLens starts it again under the same conversation (a
// restart), never in a new session. The other levels are saved as before.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { killPid } = require('./kill');
const settings = require('../lib/settings');
const effort = require('../lib/effort');

const ROOT = path.join(__dirname, '..');
const PORT = 5403;
const base = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-effort-max-'));
const state = path.join(dir, 'state');
const cfg = path.join(dir, 'claude');
fs.mkdirSync(cfg);
fs.writeFileSync(path.join(cfg, 'settings.json'), '{}');
const children = new Set();

test.after(async () => {
  await Promise.all([...children].map((c) => new Promise((resolve) => {
    c.once('exit', () => resolve());
    killPid(c.pid, 'SIGTERM');
  })));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the Effort setting has no Max: it is picked for one session only', () => {
  const field = settings.SCHEMA.effort;
  assert.deepStrictEqual(field.options, ['Auto', 'Low', 'Medium', 'High', 'Extra high']);
  assert.match(field.description, /Max is never saved/);
  // A Max saved by an earlier EditLens is not a value: the default is used.
  assert.strictEqual(settings.check('effort', 'Max'), undefined);
  assert.strictEqual(settings.normalize({ effort: 'Max' }).effort, 'Auto');
  assert.strictEqual(settings.check('effort', 'Extra high'), 'Extra high');
});

test('a page conversation keeps Max only when EditLens starts it again under it (a restart)', () => {
  const file = path.join(dir, 'kept.json');
  const sid = '11111111-2222-3333-4444-555555555555';
  effort.remember(file, sid, 'max');
  assert.strictEqual(effort.kept(file, sid, { restored: true }), 'max', 'a restart under the same conversation');
  assert.strictEqual(effort.kept(file, sid), null, 'a new session starts at the saved level');
  effort.remember(file, sid, 'xhigh');
  assert.strictEqual(effort.kept(file, sid), 'xhigh', 'the other levels stay with the conversation');
  assert.strictEqual(effort.kept(file, sid, { restored: true }), 'xhigh');
});

test('/editlens effort max is never saved; the other levels are', async () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE_PLUGIN_OPTION_')) env[k] = v;
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: { ...env, EDITLENS_PORT: String(PORT), EDITLENS_PAIR_PORT: '5404', EDITLENS_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg }, stdio: 'ignore',
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`${base}/health`).then((r) => r.ok, (err) => {
      if (err && err.cause && err.cause.code === 'ECONNREFUSED') return false;
      throw err;
    });
    if (!up) await new Promise((r) => setTimeout(r, 150));
  }
  assert.ok(up, 'server up');
  const token = fs.readFileSync(path.join(state, `token-${PORT}`), 'utf8').trim();
  const headers = { 'content-type': 'application/json', 'x-editlens-token': token };
  const poll = async () => (await (await fetch(`${base}/summary?cwd=${encodeURIComponent(dir)}&mod=1`, { headers })).json()).settingsPending;
  const set = async (level) => (await fetch(`${base}/effort`, { method: 'POST', headers, body: JSON.stringify({ level, cwd: dir }) })).json();
  await poll(); // the mod runs: a level can be saved

  const max = await set('max');
  assert.strictEqual(max.saved, false, JSON.stringify(max));
  assert.strictEqual(max.page, null, 'page control is not running here');
  assert.deepStrictEqual(await poll(), [], 'Max is not asked to be saved');

  const high = await set('high');
  assert.strictEqual(high.saved, true);
  // X2: /editlens effort right after shows the level asked for, before the mod saves it. The level in
  // effect stays as it is until Claude Code has the change (M10).
  const shown = await (await fetch(`${base}/effort?cwd=${encodeURIComponent(dir)}`, { headers })).json();
  assert.notStrictEqual(shown.setting, 'high', JSON.stringify(shown));
  assert.deepStrictEqual(shown.asked, { setting: 'high', auto: false }, JSON.stringify(shown));
  assert.deepStrictEqual((await poll()).map((p) => [p.key, p.value]), [['effort', 'High']]);
});
