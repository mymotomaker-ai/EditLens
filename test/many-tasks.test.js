'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4344';
// Several tasks sent to a paired computer at the same time: each one starts (and so streams its edits),
// instead of the second and third failing because finished tasks still keep their sessions open,
// or because that computer takes two projects at a time. test/stream-preview.js runs it end to end.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-many-tasks-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const { Tasks } = require('../server/tasks');
const remotework = require('../lib/remotework');

function withTasks(states) {
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps', log: () => {} });
  const stopped = [];
  states.forEach((state, i) => {
    const t = { id: `00000000000${i}`, by: 'laptop', pairId: 'p1', cwd: base, dir: base, prompt: 'x', state, replies: [], permissions: new Map(), startedAt: i, updatedAt: 1000 + i };
    t.driver = { stop: (why) => stopped.push([t.id, why]) };
    tasks.items.set(t.id, t);
  });
  return { tasks, stopped };
}

test('four finished tasks with their sessions still open: the oldest closes so a new task starts', () => {
  const { tasks, stopped } = withTasks(['idle', 'idle', 'idle', 'idle']);
  assert.strictEqual(tasks.roomForTask(), true);
  assert.deepStrictEqual(stopped.map((s) => s[0]), ['000000000000'], 'only the oldest finished one');
  const closed = tasks.items.get('000000000000');
  assert.strictEqual(closed.driver, null);
  assert.strictEqual(closed.state, 'ended');
  assert.match(closed.note, /follow-up continues it/);
});

test('four tasks at work (or asking) are never closed for a new one', () => {
  const { tasks, stopped } = withTasks(['working', 'starting', 'working', 'idle']);
  tasks.items.get('000000000003').permissions.set('q1', { id: 'q1' }); // a question waits there
  assert.strictEqual(tasks.roomForTask(), false);
  assert.deepStrictEqual(stopped, []);
});

test('projects still being received count, so three sent at the same time never pass together', () => {
  const { tasks } = withTasks(['working', 'working', 'working']);
  tasks.pendingSent = 1;
  assert.strictEqual(tasks.roomForTask(), false);
  tasks.pendingSent = 0;
  assert.strictEqual(tasks.roomForTask(), true);
});

test('a third project sent at the same time waits for a session instead of failing', async () => {
  const dir = path.join(base, 'app');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Hi</h1>\n');
  let busy = 2;
  const calls = [];
  const call = async (op, extra) => {
    calls.push(op);
    if (op === 'upload' && !extra.upload && busy > 0) {
      busy--;
      return { error: 'Two projects are already being sent from this computer. Wait for them.' };
    }
    if (op === 'upload') return { upload: 'u1', received: 1 };
    return { ok: true, task: 'abcdefabcdef', computer: 'vps' };
  };
  const out = await remotework.sendAndStart(call, { dir, prompt: 'hi', stateDir: path.join(base, 'lap') });
  assert.strictEqual(out.task, 'abcdefabcdef', JSON.stringify(out));
  assert.strictEqual(calls.filter((c) => c === 'upload').length >= 3, true, calls.join(' '));
});
