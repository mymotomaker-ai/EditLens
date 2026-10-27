'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4926';
// The Sessions list and Tasks at once (handoff 13): the setting (1 to 8, 4 when it is not a whole
// number in range), the names people give sessions (lib/sessionstore.js) and the command that
// continues one in Claude Code, and the task limit in server/tasks.js ("N of M running").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sessions-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const settings = require('../lib/settings');
const { SessionStore, cleanName, titleOf, resumeCommand, KEY_RE } = require('../lib/sessionstore');

const SID = '7f3c9a1e-1111-4222-8333-444455556666';
const SID2 = '0a1b2c3d-1111-4222-8333-444455556666';
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
};

test('Tasks at once: whole numbers 1 to 8 (clamped), 4 for anything else, never NaN', () => {
  const cases = [[4, 4], [1, 1], [8, 8], ['6', 6], ['  7 ', 7], [0, 1], [-3, 1], [99, 8], ['12', 8],
    [NaN, 4], [Infinity, 4], [2.5, 4], ['2.5', 4], ['1e3', 4], ['0x4', 4], ['x', 4], ['', 4], [null, 4], [undefined, 4], [true, 4], [{}, 4], [[3], 4]];
  for (const [raw, want] of cases) {
    const got = settings.taskLimit(raw);
    assert.strictEqual(got, want, `taskLimit(${JSON.stringify(raw)})`);
    assert.ok(Number.isInteger(got) && got >= 1 && got <= 8);
  }
  assert.deepStrictEqual([settings.TASKS_MIN, settings.TASKS_MAX, settings.TASKS_DEFAULT], [1, 8, 4]);
  // The setting itself: plugin.json's field, the default, a bad stored value uses it.
  assert.strictEqual(settings.SCHEMA.tasks_at_once.default, 4);
  assert.strictEqual(settings.SCHEMA.tasks_at_once.min, 1);
  assert.strictEqual(settings.SCHEMA.tasks_at_once.max, 8);
  assert.strictEqual(settings.normalize({}).tasks_at_once, 4);
  assert.strictEqual(settings.normalize({ tasks_at_once: 6 }).tasks_at_once, 6);
  for (const bad of ['12', 'lots', NaN, 0, 2.5]) assert.strictEqual(settings.normalize({ tasks_at_once: bad }).tasks_at_once, 4, JSON.stringify(bad));
  // The page may change it (Settings › Other computers), with its range for the stepper.
  assert.ok(settings.PAGE_EDITABLE.includes('tasks_at_once'));
  const field = settings.describe(settings.normalize({})).find((f) => f.key === 'tasks_at_once');
  assert.deepStrictEqual([field.min, field.max, field.pageEditable], [1, 8, true]);
  assert.match(field.description, /^Each running task adds about 0\.3–0\.5 GB of memory and uses your plan's limits in parallel\./);
});

test('names: one line, no control characters, at most 60 characters; empty gives the own name back', () => {
  assert.strictEqual(cleanName('  Blue\n header\u0007 '), 'Blue header');
  assert.strictEqual(cleanName(''), '');
  assert.strictEqual(cleanName(42), null);
  const long = cleanName('x'.repeat(100));
  assert.strictEqual([...long].length, 60);
  assert.ok(long.endsWith('…'));
  assert.strictEqual(titleOf('\n  Make the header blue\nand bold'), 'Make the header blue');
  assert.strictEqual([...titleOf('y'.repeat(200))].length, 80);
  for (const k of ['pc:' + SID, 'task:abcdefabcdef', 'r:vps-123456:abcdefabcdef']) assert.ok(KEY_RE.test(k), k);
  for (const k of ['main', 'pc:new', 'task:x', 'r::abcdefabcdef', 'r:a\nb:abcdefabcdef']) assert.ok(!KEY_RE.test(k), k);
});

test('Continue in terminal: cd "<folder>" && claude --resume <id>, as the task account when there is one', () => {
  assert.strictEqual(resumeCommand('/work/shop', SID), `cd "/work/shop" && claude --resume ${SID}`);
  assert.strictEqual(resumeCommand('C:\\Users\\me\\test_project', SID), `cd "C:\\Users\\me\\test_project" && claude --resume ${SID}`);
  assert.strictEqual(resumeCommand('/srv/x', SID, 'editlens'), `su - editlens -c 'cd "/srv/x" && claude --resume ${SID}'`);
  // Unknown or unquotable: no command (the row says it is ready after Claude's first reply).
  assert.strictEqual(resumeCommand('C:\\a"b', SID), null);
  assert.strictEqual(resumeCommand('C:\\100%', SID), null);
  assert.strictEqual(resumeCommand('/a\nb', SID), null);
  assert.strictEqual(resumeCommand('/work', 'not-an-id'), null);
  assert.strictEqual(resumeCommand(null, SID), null);
  assert.strictEqual(resumeCommand('/work', SID, 'bad name; rm'), `cd "/work" && claude --resume ${SID}`);
});

test('Continue in terminal: a Unix folder with quotes, $, ` or \\ is quoted so the shell reads it as it is', { skip: process.platform === 'win32' }, () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-quote-'));
  try {
    for (const name of ["it's", 'a"b', 'cost $HOME', 'tick `id`', 'back\\slash', 'wow!', 'plain name']) {
      const folder = path.join(base, name);
      fs.mkdirSync(folder);
      for (const account of [undefined, 'editlens']) {
        const cmd = resumeCommand(folder, SID, account);
        // The same line with pwd for claude, and the inner shell for su: it must end in that folder.
        const run = cmd.replace(`claude --resume ${SID}`, 'pwd').replace(/^su - editlens -c /, 'bash -c ');
        const out = require('child_process').execFileSync('bash', ['-c', run], { encoding: 'utf8' }).trim();
        assert.strictEqual(out, fs.realpathSync(folder), `${name} (${account || 'no account'}): ${cmd}`);
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the store: page control\'s sessions per project, the first message names one, renames are kept and survive a restart', () => {
  const file = path.join(base, 'a', 'sessions.json');
  const logs = [];
  const s = new SessionStore({ file, log: (t) => logs.push(t) });
  // The first message comes before Claude says the session id: kept for that run.
  s.pageMessage(null, 'Make the header blue\nplease', 'run1');
  s.pageStarted({ id: SID, cwd: '/work', runId: 'run1', model: 'claude-opus-5-5', effort: 'high', mode: 'auto', at: 1000 });
  assert.strictEqual(s.pageRuns('/work', (a, b) => a === b)[0].title, 'Make the header blue');
  s.pageMessage(SID, 'a later message');
  assert.strictEqual(s.runs[0].title, 'Make the header blue', 'only the first message names it');
  // Rename; an unknown key or a non-text name is refused; '' gives its own name back.
  assert.deepStrictEqual(s.rename('pc:' + SID, '  Blue header '), { ok: true, key: 'pc:' + SID, name: 'Blue header' });
  assert.strictEqual(s.name('pc:' + SID), 'Blue header');
  assert.ok(s.rename('pc:new', 'x').error);
  assert.ok(s.rename('main', 'x').error);
  assert.ok(s.rename('task:abcdefabcdef', 5).error);
  s.rename('task:abcdefabcdef', 'Footer');
  s.rename('r:vm:abcdefabcdef', 'There');
  s.rename('task:abcdefabcdef', '');
  assert.strictEqual(s.name('task:abcdefabcdef'), null);
  s.pageEnded(SID, 5000);
  // A restart reads them back; the file is only for this user.
  const again = new SessionStore({ file, log: () => {} });
  assert.strictEqual(again.name('pc:' + SID), 'Blue header');
  assert.strictEqual(again.name('r:vm:abcdefabcdef'), 'There');
  assert.deepStrictEqual(again.pageRuns('/work', (a, b) => a === b).map((r) => [r.id, r.title, r.endedAt, r.model, r.effort, r.mode]), [[SID, 'Make the header blue', 5000, 'claude-opus-5-5', 'high', 'auto']]);
  assert.deepStrictEqual(again.pageRuns('/other', (a, b) => a === b), []);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepStrictEqual(logs, []);
});

test('the store: a run that moved to a new conversation keeps its row and name; a broken file is an empty list', () => {
  const file = path.join(base, 'b', 'sessions.json');
  const s = new SessionStore({ file, log: () => {} });
  s.pageStarted({ id: SID, cwd: '/work', runId: 'run1' });
  s.rename('pc:' + SID, 'Kept name');
  // The old conversation was not found: the same run continues in a new one.
  s.pageStarted({ id: SID2, cwd: '/work', runId: 'run1' });
  assert.strictEqual(s.runs.length, 1);
  assert.strictEqual(s.runs[0].id, SID2);
  assert.strictEqual(s.name('pc:' + SID2), 'Kept name');
  assert.strictEqual(s.name('pc:' + SID), null);
  // At most 60 conversations kept, newest last.
  for (let i = 0; i < 70; i++) s.pageStarted({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cwd: '/work', runId: 'r' + i });
  assert.strictEqual(s.runs.length, 60);
  // Not JSON, or the wrong shapes: an empty list, said once in the log, never a crash.
  fs.writeFileSync(file, '{not json');
  const logs = [];
  const broken = new SessionStore({ file, log: (t) => logs.push(t) });
  assert.deepStrictEqual([broken.runs.length, broken.names.size], [0, 0]);
  assert.strictEqual(logs.length, 1);
  fs.writeFileSync(file, JSON.stringify({ names: { 'pc:x': { name: 'bad key' }, ['pc:' + SID]: { name: 7 } }, runs: [{ id: 'nope', cwd: '/w' }, { id: SID, cwd: 5 }, { id: SID, cwd: '/w', startedAt: 'NaN' }] }));
  const shaped = new SessionStore({ file, log: () => {} });
  assert.strictEqual(shaped.names.size, 0);
  assert.deepStrictEqual(shaped.runs.map((r) => [r.id, r.startedAt]), [[SID, null]]);
});

// Tasks need an SDK to be there (they never load it here: the Claude is a stand-in).
function withSdk() {
  const sdkDir = path.join(base, 'sdk-tasks');
  const { SDK_PACKAGE } = require('../server/driver');
  fs.mkdirSync(path.join(sdkDir, 'node_modules', SDK_PACKAGE), { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'node_modules', SDK_PACKAGE, 'sdk.mjs'), '');
  process.env.EDITLENS_SDK_DIR = sdkDir;
}

test('Tasks at once 1: the second task waits for a session ("1 task"), its card says 1 of 1; a higher limit starts it, running ones are never stopped', async () => {
  withSdk();
  const { Tasks } = require('../server/tasks');
  const project = path.join(base, 'limit');
  fs.mkdirSync(project, { recursive: true });
  const pair = { id: 'p1', name: 'laptop', cwd: project };
  let limit = 1;
  const slots = [];
  const drivers = [];
  const stops = [];
  const tasks = new Tasks({
    stateDir: fs.mkdtempSync(path.join(base, 'limit-state-')), host: 'vm', log: () => {}, emit: () => {},
    limit: () => limit, onSlots: (s) => slots.push(`${s.running}/${s.limit}`),
    makeDriver: (o) => {
      const d = { o, sent: [], start: async () => ({ ok: true }), started: async () => ({ ok: true }), send(text) { this.sent.push(text); return { ok: true }; }, stop(why) { stops.push(why); return { ok: true }; } };
      drivers.push(d);
      return d;
    },
  });
  const a = await tasks.start(pair, { prompt: 'first' });
  const b = await tasks.start(pair, { prompt: 'second' });
  assert.deepStrictEqual([a.state, b.state], ['working', 'waiting']);
  assert.strictEqual(b.note, 'Waiting · vm is running 1 task. It starts when one of them finishes.');
  assert.strictEqual(drivers.length, 1);
  assert.deepStrictEqual(tasks.slots(), { running: 1, limit: 1 });
  const card = tasks.card(tasks.items.get(b.task));
  assert.deepStrictEqual(card.slots, { running: 1, limit: 1 });
  assert.deepStrictEqual((await tasks.watchAll(pair, 0)).slots, { running: 1, limit: 1 });
  // The setting goes to 3: the waiting task starts now; the running one keeps running.
  limit = 3;
  tasks.limitChanged();
  assert.ok(await until(() => tasks.items.get(b.task).state === 'working'), tasks.items.get(b.task).state);
  assert.strictEqual(drivers.length, 2);
  assert.deepStrictEqual(stops, []);
  assert.ok(await until(() => slots.includes('2/3')), slots.join(' '));
  // Down to 1 again: nothing is stopped; the next task waits for both.
  limit = 1;
  tasks.limitChanged();
  const c = await tasks.start(pair, { prompt: 'third' });
  assert.strictEqual(c.state, 'waiting');
  assert.deepStrictEqual(stops, []);
  assert.deepStrictEqual(tasks.slots(), { running: 2, limit: 1 });
  // A stored value that isn't one: 4, never NaN.
  limit = 'lots';
  assert.strictEqual(tasks.maxLive(), 4);
  limit = NaN;
  assert.strictEqual(tasks.runningWords(), '4 tasks');
  tasks.stopAll();
});
