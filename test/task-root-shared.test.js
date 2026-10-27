'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5293';
// Signed-in settings check of 0.24.45: G5, a task in the paired project itself runs as the account
// EditLens runs as, root on a server, and now says so (root tag and note) as a sent project's task
// does; G7, the asking computer's check and list answers name each task's model and mode.
// Uses the stand-in SDK (test/fixtures); root is a stand-in getuid, nothing runs as another account.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-root-shared-'));
const state = path.join(base, 'fake-state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(base, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(base, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const saved = { EDITLENS_SDK_DIR: process.env.EDITLENS_SDK_DIR, FAKE_CLAUDE_STATE: process.env.FAKE_CLAUDE_STATE, EDITLENS_CLAUDE_PATH: process.env.EDITLENS_CLAUDE_PATH };
process.env.EDITLENS_SDK_DIR = path.join(base, 'sdk');
process.env.FAKE_CLAUDE_STATE = state;
process.env.EDITLENS_CLAUDE_PATH = path.join(bin, 'claude');

const { Tasks } = require('../server/tasks');
const { Driver } = require('../server/driver');

const project = path.join(base, 'project');
fs.mkdirSync(project);
const pair = { name: 'laptop', id: 'p1', cwd: project };
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
};
let unsafe = false;
let tasks;
const getuid = process.getuid;

test.before(() => {
  fs.mkdirSync(path.join(base, 'host'), { recursive: true });
  process.getuid = () => 0;
  tasks = new Tasks({
    stateDir: path.join(base, 'host'), host: 'vps', log: () => {}, emit: () => {},
    makeDriver: (o) => new Driver({ ...o, root: false, log: () => {}, stateDir: path.join(base, 'host'), platform: 'linux', settings: () => ({}) }),
    claudePaths: () => [path.join(bin, 'claude')], defaultEffort: () => 'medium', rootTasks: () => unsafe,
  });
});
test.after(() => {
  tasks.stopAll();
  process.getuid = getuid;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('G5: a task in the paired project says it runs as root, and Root (unsafe) says so too', { skip: process.platform !== 'linux' }, async () => {
  const out = await tasks.start(pair, { prompt: 'shared task' });
  assert.ok(!out.error, JSON.stringify(out));
  const t = tasks.byId(out.task);
  assert.strictEqual(tasks.card(t).asRoot, 'root', 'the card has the root tag');
  assert.match(String(tasks.report(t).note), /runs as root on vps/, 'the asking agent is told');
  assert.doesNotMatch(String(tasks.report(t).note), /\/editlens task-user/, 'the task account is only for sent projects');
  unsafe = true;
  const again = await tasks.start(pair, { prompt: 'shared task, Root (unsafe) on' });
  assert.strictEqual(tasks.card(tasks.byId(again.task)).asRoot, 'unsafe');
  unsafe = false;
});

test('G7: check and list name each task\'s model and mode', async () => {
  const out = await tasks.start(pair, { prompt: 'model and mode' });
  const t = tasks.byId(out.task);
  assert.ok(await until(() => t.model && t.mode), 'its Claude reported them');
  const r = tasks.report(t);
  assert.strictEqual(r.model, 'fake-model');
  assert.strictEqual(r.mode, t.mode);
  const row = tasks.list(pair).find((x) => x.task === t.id);
  assert.strictEqual(row.model, 'fake-model');
  assert.strictEqual(row.mode, t.mode);
});
