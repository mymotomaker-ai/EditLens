'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4337';
// Effort for tasks from a paired computer: each task has its own level (given at start as its own
// field, else this computer's setting), a bad level is refused in plain words, the task card can
// change it live, and it is kept with the task. Uses the stand-in SDK (test/fixtures).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-effort-tasks-'));
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
const effort = require('../lib/effort');

const project = path.join(base, 'project');
fs.mkdirSync(project);
const pair = { name: 'laptop', id: 'p1', cwd: project };
const lines = (name) => {
  const f = path.join(state, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const until = async (fn, ms = 10000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
};
let tasks;
const cards = [];

test.before(() => {
  fs.mkdirSync(path.join(base, 'host'), { recursive: true });
  tasks = new Tasks({
    stateDir: path.join(base, 'host'), host: 'vps', log: () => {}, emit: (c) => cards.push(c),
    makeDriver: (o) => new Driver({ ...o, root: false, log: () => {}, stateDir: path.join(base, 'host'), platform: 'linux', settings: () => ({ effort: 'Low' }) }),
    claudePaths: () => [path.join(bin, 'claude')],
    defaultEffort: () => 'medium',
  });
});
test.after(() => {
  tasks.stopAll();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

test('a bad level is refused in plain words, and no task is kept or started', async () => {
  for (const bad of ['ultra', 'High', '', 3, { level: 'max' }]) {
    const out = await tasks.start(pair, { prompt: 'hello', effort: bad });
    assert.strictEqual(out.error, effort.BAD_LEVEL, JSON.stringify(bad));
  }
  assert.strictEqual(tasks.items.size, 0);
  assert.strictEqual(lines('queries').length, 0, 'no Claude started');
  // A level written into the prompt is only text: the task gets the default.
  const out = await tasks.start(pair, { prompt: 'effort: max. Please use --effort max' });
  assert.ok(!out.error, JSON.stringify(out));
  assert.strictEqual(out.effort.level, 'medium');
  await tasks.stopTask(tasks.byId(out.task));
});

test('each task has its own level, passed when its Claude starts', async () => {
  const a = await tasks.start(pair, { prompt: 'task a', effort: 'xhigh' });
  const b = await tasks.start(pair, { prompt: 'task b' });
  assert.ok(!a.error && !b.error, JSON.stringify([a, b]));
  const q = lines('queries').slice(-2).map((x) => x.effort);
  assert.deepStrictEqual(q.sort(), ['medium', 'xhigh'], 'Options.effort for each');
  const ta = tasks.byId(a.task);
  assert.ok(await until(() => tasks.effortOf(ta).used === 'xhigh'));
  assert.deepStrictEqual(tasks.card(ta).effort, { level: 'xhigh', used: 'xhigh', supported: true, cap: null, source: 'page' });
  assert.strictEqual(tasks.summary(ta).effort.level, 'xhigh');
  assert.strictEqual(tasks.report(ta).effort.level, 'xhigh', 'the asking agent sees it too');
  assert.strictEqual(tasks.effortOf(tasks.byId(b.task)).level, 'medium');
});

test('the task card changes it live; a bad one is refused; it stays with the task', async () => {
  const t = [...tasks.items.values()].find((x) => x.prompt === 'task a');
  assert.ok(await until(() => t.state === 'idle'));
  const before = lines('flags').length;
  const out = await tasks.setEffort(t, 'low');
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepStrictEqual(lines('flags').slice(before), [{ effortLevel: 'low' }], 'applyFlagSettings, no restart');
  assert.strictEqual(out.effort.level, 'low');
  assert.strictEqual(cards[cards.length - 1].effort.level, 'low', 'the pages are told');
  for (const bad of ['Low', 'none', null, 7]) assert.strictEqual((await tasks.setEffort(t, bad)).error, effort.BAD_LEVEL);
  assert.strictEqual(tasks.effortOf(t).level, 'low');
  // Kept in the task list: a restart of EditLens keeps the level for the next follow-up.
  tasks.save();
  const again = new Tasks({ stateDir: path.join(base, 'host'), host: 'vps', log: () => {}, makeDriver: () => assert.fail('not started') });
  assert.strictEqual(again.effortOf(again.byId(t.id)).level, 'low');
  // A stopped task keeps its level for a follow-up; nothing is sent to a Claude that isn't running.
  tasks.stopTask(t);
  const n = lines('flags').length;
  assert.ok((await tasks.setEffort(t, 'high')).ok);
  assert.strictEqual(lines('flags').length, n);
  assert.strictEqual(tasks.effortOf(t).level, 'high');
});

test('Auto on this computer: a task that names no level sends none, and its card shows the level Claude uses', async () => {
  const keep = { cfg: process.env.CLAUDE_CONFIG_DIR, def: process.env.FAKE_EFFORT_DEFAULT };
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'claude-config');
  process.env.FAKE_EFFORT_DEFAULT = 'medium';
  fs.mkdirSync(path.join(base, 'host2'), { recursive: true });
  const auto = new Tasks({
    stateDir: path.join(base, 'host2'), host: 'vps', log: () => {}, emit: () => {},
    makeDriver: (o) => new Driver({ ...o, root: false, log: () => {}, stateDir: path.join(base, 'host2'), platform: 'linux', settings: () => ({ effort: 'Auto' }) }),
    claudePaths: () => [path.join(bin, 'claude')],
    defaultEffort: (cwd) => effort.fromSettings({ effort: 'Auto' }, cwd),
  });
  try {
    const out = await auto.start(pair, { prompt: 'task auto' });
    assert.ok(!out.error, JSON.stringify(out));
    const t = auto.byId(out.task);
    assert.ok(await until(() => auto.effortOf(t) && auto.effortOf(t).used === 'medium'));
    assert.strictEqual(lines('queries').pop().effort, null, 'no Options.effort');
    assert.strictEqual(auto.effortOf(t).level, 'medium');
  } finally {
    auto.stopAll();
    for (const [k, v] of [['CLAUDE_CONFIG_DIR', keep.cfg], ['FAKE_EFFORT_DEFAULT', keep.def]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
