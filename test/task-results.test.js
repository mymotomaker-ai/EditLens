'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4937';
// A task's result belongs to its turn: a follow-up clears the last one (so it is not
// read as the new answer), and a final reply isn't sent twice (as the last reply and as the result).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tasks } = require('../server/tasks');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-results-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function fakeDriver() {
  return { sent: [], start: async () => ({}), started: async () => ({}), send(text) { this.sent.push(text); return { ok: true }; }, stop() {} };
}
const say = (tasks, t, text, result = text) => {
  tasks.onMessage(t, { type: 'assistant', message: { content: [{ type: 'text', text }] } });
  tasks.onMessage(t, { type: 'result', result, is_error: false, num_turns: 2 });
  tasks.onDriverEvent(t, t.driver, { type: 'drive', phase: 'idle' });
};

function setup() {
  const drivers = [];
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 's-')), host: 'vps', makeDriver: () => { const d = fakeDriver(); drivers.push(d); return d; } });
  const pair = { id: 'p1', name: 'laptop', cwd: base };
  const t = { id: 'aaaaaaaaaaaa', by: 'laptop', pairId: 'p1', cwd: base, dir: base, copy: null, root: null, prompt: 'x', state: 'working', replies: [], replyCount: 0, permissions: new Map(), startedAt: 1, updatedAt: 1 };
  tasks.items.set(t.id, t);
  t.driver = fakeDriver();
  return { tasks, pair, t, drivers };
}

test('a follow-up clears the last turn\'s result (session still open)', async () => {
  const { tasks, pair, t } = setup();
  say(tasks, t, 'chunk 1');
  assert.strictEqual(tasks.report(t).result.isError, false);
  const sent = await tasks.send(pair, t.id, 'next');
  assert.strictEqual(sent.state, 'working');
  assert.strictEqual(sent.result, null, 'no old answer while it works');
  assert.strictEqual(tasks.report(t, 1).result, null);
  say(tasks, t, 'chunk 2');
  const done = tasks.report(t, 1);
  assert.deepStrictEqual(done.replies, ['chunk 2']);
  assert.strictEqual(done.result.turns, 2);
});

test('a follow-up clears the last turn\'s result (resumed session)', async () => {
  const { tasks, pair, t } = setup();
  say(tasks, t, 'chunk 1');
  tasks.close(t, 'idle');
  assert.strictEqual(t.state, 'ended');
  const sent = await tasks.send(pair, t.id, 'next');
  assert.ok(!sent.error, JSON.stringify(sent));
  assert.strictEqual(sent.result, null);
  assert.strictEqual(tasks.report(t).result, null);
});

test('the final reply is sent once, not again as the result text', () => {
  const { tasks, t } = setup();
  const file = 'x'.repeat(15000);
  say(tasks, t, file);
  const r = tasks.report(t);
  assert.strictEqual(r.replies[0], file);
  assert.deepStrictEqual(r.result, { isError: false, turns: 2, sameAsLastReply: true });
  assert.ok(JSON.stringify(r).length < 16000, 'one copy');
  // A result that differs from the last reply (an error, or text Claude didn't say) is kept.
  say(tasks, t, 'partial', 'Error: out of turns');
  assert.strictEqual(tasks.report(t).result.text, 'Error: out of turns');
});

test('a task that stops or fails no longer says it waits for a permission answer', () => {
  for (const end of ['stop', 'fail', 'ended']) {
    const { tasks, t } = setup();
    const d = t.driver;
    // Like the real driver: stopping denies its open questions (permission-done) as it goes.
    d.stop = () => tasks.onDriverEvent(t, d, { type: 'permission-done', id: 'q1' });
    tasks.onDriverEvent(t, d, { type: 'permission', id: 'q1', tool: 'Bash', title: 'Run', detail: 'npm test' });
    assert.strictEqual(tasks.report(t).waitingForPermission.length, 1);
    if (end === 'stop') tasks.stopTask(t);
    else if (end === 'fail') tasks.fail(t, 'boom');
    else tasks.onDriverEvent(t, d, { type: 'drive', phase: 'ended', error: null });
    assert.deepStrictEqual(tasks.report(t).waitingForPermission, [], end);
    assert.deepStrictEqual(tasks.card(t).permissions, [], end);
  }
});
