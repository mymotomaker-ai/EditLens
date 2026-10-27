'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4336';
// Effort in page control: the level is passed when Claude starts (Options.effort), changed live
// with applyFlagSettings, and the panel is told what Claude really uses: clamped by a cap, Max as
// High on a model without Max, nothing on a model without effort. Uses the stand-in SDK.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Driver } = require('../server/driver');
const effort = require('../lib/effort');

function setup(env = {}, values = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-effort-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
  const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
  const cfg = path.join(dir, 'claude-config');
  fs.mkdirSync(cfg);
  const vars = { EDITLENS_SDK_DIR: path.join(dir, 'sdk'), FAKE_CLAUDE_STATE: state, FAKE_EFFORT_CAP: '', FAKE_EFFORT_SETTINGS_CAP: '', FAKE_MODEL_EFFORT: '', FAKE_EFFORT_DEFAULT: '',
    CLAUDE_CONFIG_DIR: cfg, ...env };
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  const events = [];
  const d = new Driver({ root: false, emit: (e) => events.push(e), log: () => {}, stateDir: dir, platform: 'linux', settings: () => ({ effort: 'Medium', ...values }) });
  const restore = () => {
    d.stop('test over');
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const lines = (name) => {
    const f = path.join(state, name);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { dir, cfg, d, events, exe: path.join(bin, 'claude'), restore, lines };
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};
const latest = (events) => events.filter((e) => e.type === 'drive-effort').pop();

test('levels: only the five, by id or label; the setting maps to a level', () => {
  assert.deepStrictEqual(effort.LEVELS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.strictEqual(effort.parse('Extra high'), 'xhigh');
  assert.strictEqual(effort.parse(' MAX '), 'max');
  for (const bad of ['', 'ultra', 'hi', '3', null, undefined, {}, 'high; rm -rf /']) assert.strictEqual(effort.parse(bad), null, String(bad));
  assert.ok(!effort.isLevel('High'), 'the API takes ids only');
  assert.strictEqual(effort.fromSettings({ effort: 'Extra high' }), 'xhigh');
  assert.deepStrictEqual(effort.shape({ level: 'max', used: 'nope', supported: 'yes', cap: 7, source: 'x' }), { level: 'max', used: null, supported: null, cap: null, source: 'page' });
});

test('the level from the setting is passed when Claude starts, and what Claude uses is reported', async () => {
  const t = setup();
  try {
    assert.ok((await t.d.start({ cwd: t.dir, claudePaths: [t.exe] })).ok);
    assert.ok(await until(() => latest(t.events) && latest(t.events).effort.used));
    assert.strictEqual(t.lines('queries')[0].effort, 'medium', 'Options.effort at start');
    assert.deepStrictEqual(t.d.status().effort, { level: 'medium', used: 'medium', supported: true, cap: null, source: 'page' });
    // The setting's level is not kept for the conversation: a later Effort change applies when it
    // continues (settings check 0.24.54 note). The server keeps only levels set for it.
    const ready = t.events.find((e) => e.type === 'drive' && e.phase === 'ready' && e.sessionId);
    assert.strictEqual(ready && ready.fromSetting, true, JSON.stringify(ready));
  } finally {
    t.restore();
  }
});

test('a level given at start takes precedence over the setting; a change applies live through applyFlagSettings', async () => {
  const t = setup();
  try {
    assert.ok((await t.d.start({ cwd: t.dir, claudePaths: [t.exe], effort: 'xhigh' })).ok);
    assert.ok(await t.d.started());
    assert.strictEqual(t.lines('queries')[0].effort, 'xhigh');
    assert.ok(await until(() => t.events.some((e) => e.type === 'drive' && e.phase === 'ready' && e.sessionId)));
    assert.strictEqual(t.events.find((e) => e.type === 'drive' && e.phase === 'ready' && e.sessionId).fromSetting, false);
    // A change of the Effort setting is said to be one (the server then keeps no level for the
    // conversation); one picked for page control is not.
    assert.ok((await t.d.setEffort('low', { fromSetting: true })).ok);
    assert.strictEqual(latest(t.events).fromSetting, true);
    assert.ok((await t.d.setEffort('xhigh')).ok);
    assert.strictEqual(latest(t.events).fromSetting, false);
    t.events.length = 0;
    const out = await t.d.setEffort('max');
    assert.ok(out.ok, JSON.stringify(out));
    assert.deepStrictEqual(t.lines('flags').slice(2), [{ effortLevel: 'max' }], 'one live change, no restart');
    assert.strictEqual(t.lines('queries').length, 1, 'Claude was not started again');
    assert.deepStrictEqual(out.effort, { level: 'max', used: 'max', supported: true, cap: null, source: 'page' });
    assert.strictEqual(latest(t.events).effort.level, 'max', 'the pages are told');
    // Anything that isn't one of the five levels is refused, and nothing is sent.
    for (const bad of ['Max', 'ultra', '', null, 5]) assert.strictEqual((await t.d.setEffort(bad)).error, effort.BAD_LEVEL);
    assert.strictEqual(t.lines('flags').length, 3);
  } finally {
    t.restore();
  }
});

test('a cap clamps the level: the level used and the cap are reported', async () => {
  const t = setup({ FAKE_EFFORT_CAP: 'high' });
  try {
    assert.ok((await t.d.start({ cwd: t.dir, claudePaths: [t.exe] })).ok);
    assert.ok(await t.d.started());
    const out = await t.d.setEffort('max');
    assert.deepStrictEqual(out.effort, { level: 'max', used: 'high', supported: true, cap: 'high', source: 'page' });
  } finally {
    t.restore();
  }
  const s = setup({ FAKE_EFFORT_SETTINGS_CAP: 'medium' }, { effort: 'Low' });
  try {
    assert.ok((await s.d.start({ cwd: s.dir, claudePaths: [s.exe] })).ok);
    assert.ok(await until(() => latest(s.events) && latest(s.events).effort.used));
    assert.strictEqual(s.d.status().effort.cap, 'medium', 'maxEffortLevel in the settings is a cap even when the level is lower');
    assert.strictEqual(s.d.status().effort.used, 'low');
  } finally {
    s.restore();
  }
});

test('a model without effort: not used; a model without Max runs High, which is not a cap', async () => {
  const t = setup({ FAKE_MODEL_EFFORT: 'none' });
  try {
    assert.ok((await t.d.start({ cwd: t.dir, claudePaths: [t.exe] })).ok);
    assert.ok(await until(() => latest(t.events) && latest(t.events).effort.supported === false));
    assert.deepStrictEqual(t.d.status().effort, { level: 'medium', used: null, supported: false, cap: null, source: 'page' });
  } finally {
    t.restore();
  }
  const n = setup({ FAKE_MODEL_EFFORT: 'nomax' });
  try {
    assert.ok((await n.d.start({ cwd: n.dir, claudePaths: [n.exe] })).ok);
    assert.ok(await n.d.started());
    const out = await n.d.setEffort('max');
    assert.deepStrictEqual(out.effort, { level: 'max', used: 'high', supported: true, cap: null, source: 'page' });
  } finally {
    n.restore();
  }
});

test('no page control: a change is refused in plain words', async () => {
  const t = setup();
  try {
    assert.match((await t.d.setEffort('low')).error, /not running/);
  } finally {
    t.restore();
  }
});

test('the level is kept per page conversation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-effort-keep-'));
  try {
    const file = path.join(dir, 'kept.json');
    const id = '11111111-2222-3333-4444-555555555555';
    assert.strictEqual(effort.kept(file, id), null);
    effort.remember(file, id, 'xhigh');
    effort.remember(file, 'not-a-session', 'low');
    effort.remember(file, id.replace('1', '9'), 'nonsense');
    assert.strictEqual(effort.kept(file, id), 'xhigh');
    assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8'))), [id]);
    // Back to Auto (Claude Code's own level): the kept level is forgotten, so it is not sent again.
    effort.remember(file, id, null);
    assert.strictEqual(effort.kept(file, id), null);
    // W1, X1: levels from 0.24.51 or earlier have no mark, and 0.24.50 also kept Claude Code's own
    // level under Auto. Such a level is never used, with any Effort setting; a level kept since 0.24.52 is.
    fs.writeFileSync(file, JSON.stringify({ [id]: { level: 'medium', at: Date.now() } }));
    assert.strictEqual(effort.kept(file, id), null);
    assert.strictEqual(effort.kept(file, id, { restored: true }), null);
    effort.remember(file, id, 'low');
    assert.strictEqual(effort.kept(file, id), 'low');
    // K2: 0.24.52 to 0.24.54 also kept the Effort setting's level with the v 2 mark, so a v 2 level
    // is not used either. One kept again from 0.24.56 on gets the new mark.
    fs.writeFileSync(file, JSON.stringify({ [id]: { level: 'high', at: Date.now(), v: 2 } }));
    assert.strictEqual(effort.kept(file, id), null);
    effort.remember(file, id, 'high');
    assert.strictEqual(effort.kept(file, id), 'high');
    assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8'))[id].v, 3);
    fs.writeFileSync(file, '{not json');
    assert.strictEqual(effort.kept(file, id), null, 'a broken file is read as empty');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto (the default): Claude Code\'s effortLevel from its settings, else none', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-effort-auto-'));
  try {
    const env = { CLAUDE_CONFIG_DIR: path.join(dir, 'cfg') };
    const proj = (name) => {
      fs.mkdirSync(path.join(dir, name, '.claude'), { recursive: true });
      return path.join(dir, name);
    };
    const write = (file, v) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof v === 'string' ? v : JSON.stringify(v));
    };
    assert.strictEqual(effort.fromSettings({ effort: 'Auto' }, proj('a'), env), null, 'nothing set: none is sent');
    assert.strictEqual(effort.fromSettings(null, proj('a'), env), null, 'no settings reported counts as Auto');
    assert.ok(effort.isAuto(null) && effort.isAuto({ effort: 'nonsense' }) && !effort.isAuto({ effort: 'Low' }));
    write(path.join(dir, 'cfg', 'settings.json'), { effortLevel: 'medium' });
    assert.strictEqual(effort.fromSettings({ effort: 'Auto' }, proj('b'), env), 'medium', 'the user\'s /effort');
    write(path.join(dir, 'c', '.claude', 'settings.local.json'), { effortLevel: 'Low' });
    assert.strictEqual(effort.fromSettings({ effort: 'Auto' }, proj('c'), env), 'low', 'the project\'s local file takes precedence');
    write(path.join(dir, 'd', '.claude', 'settings.json'), { effortLevel: 'ultra' });
    assert.strictEqual(effort.fromSettings({ effort: 'Auto' }, proj('d'), env), null, 'not a level: none');
    write(path.join(dir, 'e', '.claude', 'settings.json'), '{ broken');
    assert.strictEqual(effort.fromSettings({ effort: 'Auto' }, proj('e'), env), 'medium', 'a broken file is skipped');
    assert.strictEqual(effort.fromSettings({ effort: 'High' }, proj('b'), env), 'high', 'a level in the EditLens setting takes precedence');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Auto with no level in Claude Code\'s settings: none is sent, and Claude\'s own level is shown', async () => {
  const t = setup({ FAKE_EFFORT_DEFAULT: 'medium' }, { effort: 'Auto' });
  try {
    assert.ok((await t.d.start({ cwd: t.dir, claudePaths: [t.exe] })).ok);
    assert.ok(await until(() => latest(t.events) && latest(t.events).effort && latest(t.events).effort.used));
    assert.strictEqual(t.lines('queries')[0].effort, null, 'no Options.effort');
    // fromClaude: no one set this level (F3), so /editlens effort says it is Claude Code's.
    assert.deepStrictEqual(t.d.status().effort, { level: 'medium', used: 'medium', supported: true, cap: null, source: 'page', fromClaude: true });
    const out = await t.d.setEffort('high');
    assert.strictEqual(out.effort.used, 'high', 'the page can still change it');
    assert.strictEqual(out.effort.fromClaude, undefined, 'a level set for this session is not Claude Code\'s');
  } finally {
    t.restore();
  }
});

test('Auto with effortLevel in Claude Code\'s settings: that level is sent at start', async () => {
  const t = setup({}, { effort: 'Auto' });
  try {
    fs.writeFileSync(path.join(t.cfg, 'settings.json'), JSON.stringify({ effortLevel: 'low' }));
    assert.ok((await t.d.start({ cwd: t.dir, claudePaths: [t.exe] })).ok);
    assert.ok(await until(() => latest(t.events) && latest(t.events).effort && latest(t.events).effort.used));
    assert.strictEqual(t.lines('queries')[0].effort, 'low');
    assert.strictEqual(t.d.status().effort.used, 'low');
  } finally {
    t.restore();
  }
});

test('Auto on a model without effort: the chip still says "Effort not used"', async () => {
  const t = setup({ FAKE_MODEL_EFFORT: 'none' }, { effort: 'Auto' });
  try {
    assert.ok((await t.d.start({ cwd: t.dir, claudePaths: [t.exe] })).ok);
    assert.ok(await until(() => latest(t.events) && latest(t.events).effort && latest(t.events).effort.supported === false));
    assert.strictEqual(t.d.status().effort.supported, false);
  } finally {
    t.restore();
  }
});
