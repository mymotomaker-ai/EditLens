'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4938';
// Task start, follow-up and stop racing each other (review H2), with a stand-in for Claude: no
// Claude is ever left running untracked, a follow-up waits for the start, and a running task is
// never removed from the list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-tasks-race-'));
process.env.EDITLENS_SDK_DIR = path.join(base, 'sdk');
const { SDK_PACKAGE } = require('../server/driver');
const sdk = path.join(base, 'sdk', 'node_modules', SDK_PACKAGE);
fs.mkdirSync(sdk, { recursive: true });
fs.writeFileSync(path.join(sdk, 'sdk.mjs'), '');
const { Tasks } = require('../server/tasks');

const project = path.join(base, 'project'); // not git: tasks work in the folder itself
fs.mkdirSync(project);
const pair = { name: 'laptop', id: 'p1', cwd: project };
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// A Claude whose start the test lets go when it wants.
function fakes() {
  const made = [];
  const makeDriver = () => {
    let go;
    const gate = new Promise((r) => { go = r; });
    const d = { stopped: 0, sent: [], go, start: () => gate, started: async () => ({ ok: true }), send(text) { this.sent.push(text); return { ok: true }; }, stop() { this.stopped++; return { ok: true }; } };
    made.push(d);
    return d;
  };
  return { made, makeDriver };
}

test('a follow-up while the task starts is refused, not a second Claude', async () => {
  const f = fakes();
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps', makeDriver: f.makeDriver });
  const starting = tasks.start(pair, { prompt: 'one' });
  await new Promise((r) => setImmediate(r));
  const t = [...tasks.items.values()][0];
  const follow = await tasks.send(pair, t.id, 'two');
  assert.match(follow.error, /still starting/);
  assert.strictEqual(f.made.length, 1);
  f.made[0].go({ ok: true });
  const out = await starting;
  assert.ok(!out.error, JSON.stringify(out));
  // The task, then where to see its result (EditLens's note).
  assert.strictEqual(f.made[0].sent.length, 1);
  assert.match(f.made[0].sent[0], /^\[From the Claude on .+, not typed by a person here\.\]\none\n\n\[EditLens: when you finish, end with the files you changed and where to see the result/);
});

test('stopped while it starts: that Claude stops too', async () => {
  const f = fakes();
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps', makeDriver: f.makeDriver });
  const starting = tasks.start(pair, { prompt: 'one' });
  await new Promise((r) => setImmediate(r));
  const t = [...tasks.items.values()][0];
  tasks.stop(pair, t.id);
  f.made[0].go({ ok: true });
  const out = await starting;
  assert.match(out.error, /stopped/);
  assert.ok(f.made[0].stopped >= 1, 'the Claude that was starting is stopped');
  assert.deepStrictEqual(f.made[0].sent, [], 'it never got the task');
  assert.strictEqual(t.state, 'stopped');
  assert.strictEqual(tasks.live().length, 0);
});

test('starts in flight count toward the limit; running tasks are never evicted', async () => {
  const f = fakes();
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps', makeDriver: f.makeDriver });
  const runs = [1, 2, 3, 4, 5].map((n) => tasks.start(pair, { prompt: `t${n}` }));
  // The fifth waits for a free session (it starts when one is free), never a fifth Claude now.
  const fifth = await runs[4];
  assert.strictEqual(fifth.state, 'waiting', JSON.stringify(fifth));
  assert.match(fifth.note, /^Waiting · vps is running 4 tasks\./);
  assert.strictEqual(f.made.length, 4);
  for (const d of f.made) d.go({ ok: true });
  await Promise.all(runs.slice(0, 4));
  const running = [...tasks.items.values()].filter((t) => t.driver).map((t) => t.id);
  assert.strictEqual(running.length, 4);
  // 60 finished tasks later, the running ones (the oldest entries) are still listed.
  for (let i = 0; i < 60; i++) tasks.items.set(`old${i}`, { id: `old${i}`, replies: [], permissions: new Map(), state: 'ended', driver: null });
  const next = fakes();
  tasks.makeDriver = next.makeDriver;
  // One stops: the waiting one starts in its place.
  tasks.stopTask(tasks.items.get(running[0]));
  for (let i = 0; i < 50 && !next.made.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(next.made.length, 1, 'the waiting task started');
  next.made[0].go({ ok: true });
  for (let i = 0; i < 50 && tasks.items.get(fifth.task).state !== 'working'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(tasks.items.get(fifth.task).state, 'working');
  const one = await tasks.start(pair, { prompt: 'again' });
  assert.ok(!one.error && one.state === 'waiting', JSON.stringify(one));
  assert.ok(tasks.items.size <= 50, String(tasks.items.size));
  for (const id of running.slice(1)) assert.ok(tasks.items.has(id), 'a running task stays listed');
  assert.ok(tasks.items.has(one.task), 'a waiting task stays listed');
  tasks.stopAll();
  assert.strictEqual(tasks.live().length, 0);
});
