'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4341';
// Features the user turned on that must not stop silently: the driven Claude's plugin (EditLens's
// hooks always come with it, and a start without them says so), a paired computer's edits kept by
// size and on disk (and a count of the ones no longer kept), and tasks that wait for a free session
// or don't start (shown on the pages and in the summary, not only to the agent that asked).
// test/gaps-preview.js checks the same in the browser, with two servers.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-gaps-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const PLUGIN = path.join(__dirname, '..');
const write = (f, v) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v));
};
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
};

// ---------- the driven Claude's plugin ----------
const { pluginState } = require('../lib/pluginstate');

test('the plugin check reads scope, enabledPlugins (user, project, local) and CLAUDE_CONFIG_DIR', () => {
  const home = path.join(base, 'home');
  const proj = path.join(base, 'proj');
  const other = path.join(base, 'other');
  const claude = path.join(home, '.claude');
  const installed = (entries) => write(path.join(claude, 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'editlens@editlens': entries } });
  const env = {};
  assert.strictEqual(pluginState(proj, { env, home }).active, false, 'nothing installed');
  assert.match(pluginState(proj, { env, home }).why, /not installed/);

  installed([{ scope: 'user', installPath: '/x' }]);
  assert.strictEqual(pluginState(proj, { env, home }).active, false, 'installed, but no settings file turns it on');
  write(path.join(claude, 'settings.json'), { enabledPlugins: { 'editlens@editlens': true } });
  assert.strictEqual(pluginState(proj, { env, home }).active, true, 'user scope, on in the user settings');
  write(path.join(proj, '.claude', 'settings.json'), { enabledPlugins: { 'editlens@editlens': false } });
  assert.strictEqual(pluginState(proj, { env, home }).active, false, 'the project turns it off');
  assert.match(pluginState(proj, { env, home }).why, /turned off/);
  write(path.join(proj, '.claude', 'settings.local.json'), { enabledPlugins: { 'editlens@editlens': true } });
  assert.strictEqual(pluginState(proj, { env, home }).active, true, 'the local settings win');

  // Installed for one project only: not for another one.
  installed([{ scope: 'project', projectPath: proj, installPath: '/x' }]);
  assert.strictEqual(pluginState(proj, { env, home }).active, true);
  assert.strictEqual(pluginState(path.join(proj, 'src'), { env, home }).installed.length, 1, 'a folder inside the project');
  assert.strictEqual(pluginState(other, { env, home }).installed.length, 0, 'another project');
  installed([{ scope: 'local', projectPath: other, installPath: '/x' }]);
  assert.strictEqual(pluginState(proj, { env, home }).installed.length, 0);

  // CLAUDE_CONFIG_DIR moves Claude Code's folder.
  const moved = path.join(base, 'moved');
  write(path.join(moved, 'plugins', 'installed_plugins.json'), { plugins: { 'editlens@m': { installPath: '/y' } } });
  write(path.join(moved, 'settings.json'), { enabledPlugins: { 'editlens@m': true } });
  fs.rmSync(path.join(proj, '.claude'), { recursive: true, force: true });
  assert.strictEqual(pluginState(proj, { env: { CLAUDE_CONFIG_DIR: moved }, home }).active, true, 'version 1 of the file, in CLAUDE_CONFIG_DIR');
  assert.strictEqual(pluginState(proj, { env: {}, home }).active, false, 'not in ~/.claude');
  // Unreadable files are "not installed", never a crash.
  write(path.join(moved, 'plugins', 'installed_plugins.json'), '{oops');
  assert.strictEqual(pluginState(proj, { env: { CLAUDE_CONFIG_DIR: moved }, home }).active, false);
});

// Page control with the stand-in SDK (test/fixtures/fake-sdk.mjs).
function driverSetup(env = {}) {
  const dir = fs.mkdtempSync(path.join(base, 'drv-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
  const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
  // An installed copy of EditLens, on for every project: page control still passes its own.
  const home = path.join(dir, 'home');
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'editlens@editlens': [{ scope: 'user', installPath: path.join(home, 'copy') }] } });
  write(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'editlens@editlens': true } });
  const vars = { EDITLENS_SDK_DIR: path.join(dir, 'sdk'), FAKE_CLAUDE_STATE: state, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ...env };
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  const { Driver } = require('../server/driver');
  const events = [];
  const logs = [];
  const d = new Driver({ root: false, emit: (e) => events.push(e), log: (...a) => logs.push(a.join(' ')), stateDir: dir, platform: 'linux' });
  const restore = () => {
    d.stop('test over');
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
  return { dir, d, events, logs, exe: path.join(bin, 'claude'), restore };
}

test('page control always gives Claude this copy of EditLens, even with an installed copy on', async () => {
  const t = driverSetup({ FAKE_SDK_PLUGINS: 'list' });
  try {
    const out = await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    assert.ok(out.ok, JSON.stringify(out));
    assert.ok(await until(() => t.events.some((e) => e.type === 'drive' && e.phase === 'ready')), 'Claude started with EditLens');
    const o = globalThis.__fakeSdkOptions;
    assert.deepStrictEqual(o.plugins, [{ type: 'local', path: path.join(PLUGIN, 'server', '..') }]);
    assert.strictEqual(o.env.EDITLENS_PLUGIN_ROOT, path.join(PLUGIN, 'server', '..'), 'an older Claude Code that loads both runs only this copy\'s hooks');
    assert.strictEqual(o.env.EDITLENS_DRIVEN, '1');
    assert.ok(t.logs.some((l) => /installed copy is also on for this project/.test(l)), t.logs.join('\n'));
    assert.strictEqual(t.d.status().active, true);
  } finally {
    t.restore();
  }
});

test('Claude that starts without EditLens (a policy blocked it): page control stops and says why', async () => {
  const t = driverSetup({ FAKE_SDK_PLUGINS: 'blocked' });
  try {
    const out = await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    assert.ok(out.ok, JSON.stringify(out));
    const ended = await until(() => t.events.find((e) => e.type === 'drive' && e.phase === 'ended'));
    assert.ok(ended, 'it does not run blind');
    assert.match(ended.error, /^Claude started without the EditLens plugin \(Plugin "editlens" is blocked by managed settings\), so its edits and replies would not appear on this page\. Run \/plugin in Claude Code/);
    assert.strictEqual(ended.reason, 'no-plugin');
    assert.match(t.d.status().lastError.error, /without the EditLens plugin/, 'the page and the line in Claude Code show why');
    assert.strictEqual(t.events.filter((e) => e.type === 'drive').pop().phase, 'ended');
  } finally {
    t.restore();
  }
});

test('the hooks of an installed copy step aside when page control passed its own', () => {
  const { otherCopy } = require('../hooks/live-hook');
  const saved = { d: process.env.EDITLENS_DRIVEN, r: process.env.EDITLENS_PLUGIN_ROOT };
  try {
    delete process.env.EDITLENS_DRIVEN;
    process.env.EDITLENS_PLUGIN_ROOT = path.join(base, 'elsewhere');
    assert.strictEqual(otherCopy(), false, 'not page control: every copy reports');
    process.env.EDITLENS_DRIVEN = '1';
    assert.strictEqual(otherCopy(), true, 'another copy than the one passed');
    process.env.EDITLENS_PLUGIN_ROOT = PLUGIN;
    assert.strictEqual(otherCopy(), false, 'the copy passed reports');
  } finally {
    for (const [k, v] of [['EDITLENS_DRIVEN', saved.d], ['EDITLENS_PLUGIN_ROOT', saved.r]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

// ---------- a paired computer's edits: kept by size, on disk, and what was not kept ----------
const { EditFeed } = require('../server/editfeed');

test('edits for paired computers are kept by size, survive a restart, and removed ones are counted', () => {
  const dir = path.join(base, 'feed');
  const feed = new EditFeed({ dir, budget: 20000 });
  const big = 'x'.repeat(400);
  for (let i = 1; i <= 40; i++) feed.push({ fseq: i, kind: 'task', pairId: i % 2 ? 'p1' : 'p2', file: `/w/f${i}`, before: big, after: big, ts: Date.now() });
  const kept = feed.items();
  assert.ok(kept.length < 40 && kept.length >= 10, `kept by size: ${kept.length}`);
  assert.strictEqual(kept[kept.length - 1].fseq, 40);
  const first = kept[0].fseq;
  // Many small edits fit where few large ones did: not a fixed count.
  const small = new EditFeed({ dir: path.join(base, 'feed-small'), budget: 6000 });
  for (let i = 1; i <= 40; i++) small.push({ fseq: i, kind: 'task', pairId: 'p1', file: `/w/f${i}`, ts: Date.now() });
  assert.strictEqual(small.items().length, 40);
  // On disk: a restart has them all.
  const again = new EditFeed({ dir, budget: 20000 });
  assert.deepStrictEqual(again.items().map((x) => x.fseq), kept.map((x) => x.fseq));
  assert.strictEqual(again.last(), 40);
  // A computer that read up to edit 3: the removed edits after 3 that it may see are counted.
  const p1 = (d) => d.pairId === 'p1';
  const lost = again.lost(3, p1);
  const expected = [];
  for (let i = 4; i < first; i++) if (i % 2) expected.push(i);
  assert.deepStrictEqual(lost, { count: expected.length, more: false });
  assert.strictEqual(again.lost(first, p1), null, 'nothing missed');
  assert.strictEqual(again.lost(0, p1), null, 'a computer that just started following missed nothing');
});

test('a laptop away longer than the VPS keeps edits gets them after a restart, and the count of the rest', async () => {
  process.env.EDITLENS_SDK_DIR = path.join(base, 'no-sdk');
  const { Tasks } = require('../server/tasks');
  const stateDir = path.join(base, 'vps-state');
  const project = path.join(base, 'shop');
  fs.mkdirSync(project, { recursive: true });
  const pair = { id: 'p1', name: 'laptop', cwd: project };
  const tasks = new Tasks({ stateDir, host: 'vm', log: () => {} });
  tasks.pushEdit({ kind: 'session', file: path.join(project, 'a.html'), dir: null, tool: 'Edit', intent: 'first', before: 'a', after: 'b', ts: Date.now() });
  const read = tasks.editsFor(pair, 0);
  assert.strictEqual(read.edits.length, 1);
  const pos = read.editSeq; // what the laptop saves (pair-follow.json)
  tasks.pushEdit({ kind: 'session', file: path.join(project, 'b.html'), dir: null, tool: 'Edit', intent: 'while away', before: 'a', after: 'c', ts: Date.now() });
  // EditLens on the VPS restarts: the edit made while the laptop was away is still there.
  const after = new Tasks({ stateDir, host: 'vm', log: () => {} });
  const got = after.editsFor(pair, pos);
  assert.deepStrictEqual(got.edits.map((e) => e.intent), ['while away']);
  assert.strictEqual(got.lost, undefined);
  // Far more than the budget while away: what was removed is counted for that laptop.
  after.feed.half = 3000;
  for (let i = 0; i < 30; i++) after.pushEdit({ kind: 'session', file: path.join(project, `p${i}.html`), dir: null, tool: 'Write', intent: `edit ${i}`, before: '', after: 'y'.repeat(300), ts: Date.now() });
  const late = after.editsFor(pair, got.editSeq);
  assert.ok(late.lost && late.lost.count > 0, JSON.stringify(late.lost));
  assert.strictEqual(late.edits.length + late.lost.count, 30, 'every edit is either sent or counted');
  assert.strictEqual(after.editsFor(pair, late.editSeq).lost, undefined, 'said once');
});

// ---------- tasks that wait for a free session, or don't start ----------
// Tasks need an SDK to be there (they never load it here: the Claude is a stand-in).
function withSdk() {
  const sdkDir = path.join(base, 'sdk-tasks');
  const { SDK_PACKAGE } = require('../server/driver');
  fs.mkdirSync(path.join(sdkDir, 'node_modules', SDK_PACKAGE), { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'node_modules', SDK_PACKAGE, 'sdk.mjs'), '');
  process.env.EDITLENS_SDK_DIR = sdkDir;
}

test('six tasks at the same time: four start, two wait (said on their cards) and start as sessions free up', async () => {
  withSdk();
  const { Tasks } = require('../server/tasks');
  const project = path.join(base, 'six');
  fs.mkdirSync(project, { recursive: true });
  const pair = { id: 'p1', name: 'laptop', cwd: project };
  const cards = [];
  const drivers = [];
  const tasks = new Tasks({
    stateDir: fs.mkdtempSync(path.join(base, 'six-state-')), host: 'vm', log: () => {}, emit: (c) => cards.push(c),
    makeDriver: (o) => {
      const d = { o, sent: [], start: async () => ({ ok: true }), started: async () => ({ ok: true }), send(text) { this.sent.push(text); return { ok: true }; }, stop() { return { ok: true }; } };
      drivers.push(d);
      return d;
    },
  });
  const out = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => tasks.start(pair, { prompt: `task ${n}` })));
  assert.deepStrictEqual(out.map((o) => o.state), ['working', 'working', 'working', 'working', 'waiting', 'waiting'], JSON.stringify(out.map((o) => o.error || o.state)));
  assert.strictEqual(drivers.length, 4, 'no fifth Claude');
  assert.strictEqual(out[4].note, 'Waiting · vm is running 4 tasks. It starts when one of them finishes.');
  const waitingCards = cards.filter((c) => c.state === 'waiting');
  assert.deepStrictEqual([...new Set(waitingCards.map((c) => c.taskId))].sort(), [out[4].task, out[5].task].sort(), 'the pages here get a Waiting card for each');
  const notes = tasks.notices(project, (a, b) => a === b);
  assert.deepStrictEqual(notes.filter((n) => n.state === 'waiting').length, 2);
  assert.match(notes[0].short, /^Task from ◆ laptop waiting$/);
  // Two tasks finish: their sessions close for the waiting ones, which start.
  for (const d of drivers.slice(0, 2)) d.o.emit({ type: 'drive', phase: 'idle' });
  assert.ok(await until(() => drivers.length === 6), `started: ${drivers.length}`);
  assert.ok(await until(() => tasks.items.get(out[5].task).state === 'working'));
  assert.strictEqual(tasks.items.get(out[4].task).state, 'working');
  assert.match(drivers[4].sent[0], /task 5/);
  assert.strictEqual(tasks.notices(project, (a, b) => a === b).filter((n) => n.state === 'waiting').length, 0);
  tasks.stopAll();
});

test('a start or follow-up that is refused shows on the pages here and in the summary', async () => {
  withSdk();
  const { Tasks } = require('../server/tasks');
  const project = path.join(base, 'refused');
  fs.mkdirSync(project, { recursive: true });
  const pair = { id: 'p1', name: 'laptop', cwd: project };
  const cards = [];
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'ref-state-')), host: 'vm', log: () => {}, emit: (c) => cards.push(c),
    makeDriver: () => ({ start: async () => ({ ok: true }), started: async () => ({ ok: true }), send: () => ({ ok: true }), stop: () => ({ ok: true }) }) });
  const empty = await tasks.start(pair, { prompt: '  ' });
  assert.strictEqual(empty.error, 'Give the task: what Claude should do.');
  const card = cards.find((c) => c.state === 'refused');
  assert.ok(card, 'a "Didn\'t start" card on the pages here');
  assert.strictEqual(card.error, 'Give the task: what Claude should do.');
  assert.strictEqual(card.by, 'laptop');
  const follow = await tasks.send(pair, 'abcdefabcdef', 'more');
  assert.match(follow.error, /No such task/);
  assert.ok(cards.some((c) => c.state === 'refused' && c.followUp === true && c.prompt === 'more'));
  const notes = tasks.notices(project, (a, b) => a === b);
  assert.deepStrictEqual(notes.map((n) => [n.state, n.text, n.short]).sort(), [
    ['refused', 'Didn\'t start · Give the task: what Claude should do.', 'Task from ◆ laptop didn\'t start'],
    ['refused', 'Didn\'t start · No such task from this computer.', 'Follow-up from ◆ laptop didn\'t start'],
  ]);
  // A waiting task that is stopped leaves the line and never starts.
  for (let i = 0; i < 4; i++) await tasks.start(pair, { prompt: `busy ${i}` });
  const w = await tasks.start(pair, { prompt: 'later' });
  assert.strictEqual(w.state, 'waiting', JSON.stringify(w));
  const stopped = tasks.stop(pair, w.task);
  assert.strictEqual(stopped.state, 'stopped');
  assert.strictEqual(tasks.queue.length, 0);
  tasks.stopAll();
});

// ---------- the asking computer: its page and summary show a start that didn't happen ----------
function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('a task start the paired computer refused: a card on this project\'s page and a notice in the summary', async (t) => {
  const port = 4339;
  const stateDir = path.join(base, 'lap');
  const proj = path.join(base, 'lap-app');
  fs.mkdirSync(proj, { recursive: true });
  const child = spawn(process.execPath, [path.join(PLUGIN, 'server', 'server.js')], { env: { ...process.env, EDITLENS_PORT: String(port), EDITLENS_PAIR_PORT: '4340', EDITLENS_STATE_DIR: stateDir }, stdio: 'ignore' });
  t.after(() => child.kill());
  assert.ok(await until(() => request(port, 'GET', '/health').then((r) => r && r.ok, () => false), 15000), 'server up');
  const token = fs.readFileSync(path.join(stateDir, `token-${port}`), 'utf8');
  const api = (p, body) => request(port, 'POST', p, body, { 'x-editlens-token': token });
  // The page's event stream.
  const frames = [];
  const stream = http.get({ host: '127.0.0.1', port, path: `/events?page=p1&root=${encodeURIComponent(proj)}` }, (res) => res.on('data', (c) => frames.push(String(c))));
  t.after(() => stream.destroy());
  await until(() => frames.join('').includes('"hello"'));
  // Not paired: the start can't happen. The agent gets the error, and so do the page and the line.
  const out = await api('/remote/task', { computer: 'vm', op: 'start', prompt: 'Add a page', localDir: proj, startId: 'aaaabbbbccccdddd', startPrompt: 'Add a page' });
  assert.match(out.error, /not paired/);
  const notice = await until(() => frames.join('').split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6))).find((e) => e.type === 'task-notice'));
  assert.ok(notice, 'the page gets a card');
  assert.strictEqual(notice.state, 'refused');
  assert.strictEqual(notice.prompt, 'Add a page');
  assert.match(notice.text, /^Didn't start · This computer is not paired with another one\./);
  const s = await request(port, 'GET', `/summary?cwd=${encodeURIComponent(proj)}`);
  assert.strictEqual(s.tasksWaiting, 0);
  assert.strictEqual(s.taskNotices.length, 1);
  assert.deepStrictEqual([s.taskNotices[0].state, s.taskNotices[0].short], ['refused', 'Task on ◆ vm didn\'t start']);
  // Another project's line does not show it.
  const other = await request(port, 'GET', `/summary?cwd=${encodeURIComponent(path.join(base, 'elsewhere'))}`);
  assert.strictEqual(other.taskNotices.length, 0);
  // The agent gave up on a start for its own reason (lib/remotework.js): the same card says why.
  await api('/remote/task', { computer: 'vm', op: 'start-failed', error: 'Sending the project failed: too large', localDir: proj, startId: 'aaaabbbbccccdddd', startPrompt: 'Add a page' });
  const s2 = await request(port, 'GET', `/summary?cwd=${encodeURIComponent(proj)}`);
  assert.strictEqual(s2.taskNotices.length, 1, 'one card per start');
  assert.strictEqual(s2.taskNotices[0].text, 'Didn\'t start · Sending the project failed: too large');
});
