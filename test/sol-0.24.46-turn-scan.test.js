'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5412';
// Sol L11 (findings-0.24.46-sol-part1.md): a task's turn starts only after the files changed until
// then are recorded, so a file the turn changes by a command immediately is shown as its edit. Git is
// slow here (a stand-in git that waits first), as on a busy computer.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-turn-scan-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const slow = path.join(dir, 'slow-bin');
fs.mkdirSync(slow);
fs.writeFileSync(path.join(slow, 'git'), `#!/bin/sh\nsleep "\${SLOW_GIT_S:-0}"\nexec ${realGit} "$@"\n`, { mode: 0o755 });
process.env.PATH = slow + path.delimiter + process.env.PATH;

const { Tasks } = require('../server/tasks');

// A sent task's workspace with two committed files, and a task record for it.
function workspace(name) {
  const ws = path.join(dir, name);
  fs.mkdirSync(ws);
  const git = (...a) => execFileSync(realGit, ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(ws, 'App.jsx'), 'old\n');
  fs.writeFileSync(path.join(ws, 'Nav.jsx'), 'nav\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { ws, base: git('rev-parse', 'HEAD') };
}

// Tasks whose Claude, sent "<file>:<text>" (last line), writes that file by a command immediately.
function setup(name) {
  const { ws, base } = workspace(name);
  const logs = [];
  let tasks = null;
  const tasksOpts = {
    stateDir: fs.mkdtempSync(path.join(dir, 'tstate-')), host: 'vps', log: (m) => logs.push(m),
    onTurnStart: (t) => tasks.scanTurnStart(t),
    makeDriver: ({ emit }) => ({
      start: async () => ({ ok: true }),
      started: async () => ({ ok: true }),
      send: (text) => {
        emit({ type: 'drive', phase: 'working' });
        const [file, words] = text.trim().split('\n').pop().split(':');
        fs.writeFileSync(path.join(ws, file), `${words}\n`);
        return { ok: true };
      },
      stop: () => {},
      status: () => ({}),
    }),
  };
  tasks = new Tasks(tasksOpts);
  const t = { id: name.padEnd(12, '0').slice(0, 12), kind: 'sent', dir: ws, cwd: ws, base, by: 'laptop', pairId: 'p1', prompt: 'x', state: 'idle',
    edits: [], editCount: 0, replies: [], replyCount: 0, activity: [], permissions: new Map() };
  tasks.items.set(t.id, t);
  return { tasks, t, logs };
}

test('L11: the turn-start scan ends before the message is sent to Claude (a task\'s start)', async () => {
  process.env.SLOW_GIT_S = '0.3';
  const { tasks, t } = setup('start');
  const out = await tasks.runOnce(t, null, 'App.jsx:new by cat');
  assert.deepStrictEqual(out, { ok: true });
  const found = await tasks.commandEdits(t);
  assert.deepStrictEqual(found.map((e) => [e.rel, e.before, e.after]), [['App.jsx', 'old\n', 'new by cat\n']]);
});

test('L11: the same for a follow-up to a running task', async () => {
  process.env.SLOW_GIT_S = '0.3';
  const { tasks, t } = setup('follow');
  assert.deepStrictEqual(await tasks.runOnce(t, null, 'App.jsx:first'), { ok: true });
  await tasks.commandEdits(t); // the first turn's change, shown
  t.state = 'idle';
  // Another file this time: one the turn-start scan has not recorded yet.
  const out = await tasks.sendFollowUp({ id: 'p1' }, t.id, 'Nav.jsx:nav by sed');
  assert.ok(!out.error, JSON.stringify(out));
  const found = await tasks.commandEdits(t);
  assert.deepStrictEqual(found.map((e) => [e.rel, e.before, e.after]), [['Nav.jsx', 'nav\n', 'nav by sed\n']]);
});

test('L11: a scan that takes over 2 s does not hold the turn longer; it is logged', async () => {
  process.env.SLOW_GIT_S = '2.5';
  const { tasks, t, logs } = setup('late');
  const started = Date.now();
  assert.deepStrictEqual(await tasks.runOnce(t, null, 'App.jsx:late'), { ok: true });
  const took = Date.now() - started;
  assert.ok(took >= 1900 && took < 2400, `took ${took} ms`);
  assert.ok(logs.some((m) => /before its files were recorded/.test(m)), JSON.stringify(logs));
  process.env.SLOW_GIT_S = '0';
});
