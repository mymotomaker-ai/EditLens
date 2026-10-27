'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4324';
// Agent labels and the Changes row (handoff 12 and 14), server side: a file a subagent edits in its
// own copy inside a task's folder is named as the project names it (never ".claude/worktrees/..."),
// is not mistaken for the never-sent .claude folder, and counts that did not come with an edit stay
// unknown (null), so no page or card says "0 lines". The task card has the model and mode its Claude
// runs with, for the agent details card.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'el-chips-'));
process.env.EDITLENS_SDK_DIR = path.join(base, 'no-sdk');
const wt = require('../lib/worktree');
const { Tasks } = require('../server/tasks');

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('withoutCopy and projectRel remove a subagent copy\'s folder, and only that', () => {
  assert.strictEqual(wt.withoutCopy('.claude/worktrees/agent-ac43565b/essays/design/03.md'), 'essays/design/03.md');
  assert.strictEqual(wt.withoutCopy('/root/shop/.claude/worktrees/editlens-task-1/faq.html'), 'faq.html');
  assert.strictEqual(wt.withoutCopy('src\\.claude\\worktrees\\a1\\x.js'), 'x.js');
  assert.strictEqual(wt.withoutCopy('src/app.js'), 'src/app.js');
  assert.strictEqual(wt.withoutCopy('.claude/settings.json'), '.claude/settings.json', 'other .claude files keep their name');
  assert.strictEqual(wt.withoutCopy(''), '');
  const dir = path.join(base, 'ws');
  assert.strictEqual(wt.projectRel(dir, path.join(dir, '.claude', 'worktrees', 'agent-1', 'essays', 'a.md')), 'essays/a.md');
  assert.strictEqual(wt.projectRel(dir, path.join(dir, 'b.html')), 'b.html');
  assert.strictEqual(wt.projectRel(dir, path.join(base, 'elsewhere.html')), null, 'outside the folder');
  assert.strictEqual(wt.projectRel(dir, dir), null);
});

function fakeTask(tasks, dir) {
  const t = { id: 'aaaaaaaaaaaa', by: 'laptop', pairId: 'p1', cwd: dir, dir, copy: null, kind: 'sent', prompt: 'Write the essays', state: 'working',
    replies: [], permissions: new Map(), edits: [], editCount: 0, startedAt: Date.now(), updatedAt: Date.now() };
  tasks.items.set(t.id, t);
  return t;
}

test('a task\'s card names a subagent\'s file as the project does, and unknown counts stay unknown', () => {
  const dir = path.join(base, 'task-dir');
  fs.mkdirSync(dir, { recursive: true });
  const cards = [];
  const tasks = new Tasks({ stateDir: path.join(base, 'state-a'), host: 'vm', log: () => {}, emit: (c) => cards.push(c) });
  const t = fakeTask(tasks, dir);
  tasks.noteEdit(t, path.join(dir, '.claude', 'worktrees', 'agent-ac43565b', 'essays', 'design', '03.md'), { intent: 'New essay', created: true });
  tasks.noteEdit(t, path.join(dir, 'index.html'), { intent: 'Link it', stats: { added: 2, removed: 1 } });
  tasks.noteEdit(t, path.join(dir, 'same.html'), { intent: 'Touch', stats: { added: 0, removed: 0 } });
  const card = cards[cards.length - 1];
  assert.deepStrictEqual(card.edits.map((e) => e.relFile), ['essays/design/03.md', 'index.html', 'same.html']);
  assert.ok(!JSON.stringify(card).includes('worktrees'), JSON.stringify(card.edits));
  assert.deepStrictEqual(card.edits.map((e) => [e.added, e.removed]), [[null, null], [2, 1], [0, 0]], 'null = not known; a real 0 stays 0');
  tasks.stopAll();
});

test('the edits sent to the asking computer: a subagent copy\'s file is the project\'s file, with its text', () => {
  const dir = path.join(base, 'feed-dir');
  fs.mkdirSync(dir, { recursive: true });
  const tasks = new Tasks({ stateDir: path.join(base, 'state-b'), host: 'vm', log: () => {} });
  const file = path.join(dir, '.claude', 'worktrees', 'agent-1', 'essays', 'a.md');
  tasks.pushEdit({ kind: 'task', task: 'aaaaaaaaaaaa', pairId: 'p1', taskKind: 'mine', inCopy: true, dir, file, tool: 'Write', intent: 'An essay',
    stats: { added: 1, removed: 0 }, created: true, hunks: [{ oldStart: 0, newStart: 1, lines: ['+# Essay'] }], before: '', after: '# Essay\n', ts: Date.now() });
  // A key file inside the copy is still never sent.
  tasks.pushEdit({ kind: 'task', task: 'aaaaaaaaaaaa', pairId: 'p1', taskKind: 'mine', inCopy: true, dir, file: path.join(dir, '.claude', 'worktrees', 'agent-1', '.env'), tool: 'Write',
    intent: 'Keys', stats: { added: 1, removed: 0 }, hunks: [{ oldStart: 0, newStart: 1, lines: ['+A=1'] }], before: '', after: 'A=1\n', ts: Date.now() });
  const got = tasks.editsFor({ id: 'p1', name: 'laptop', cwd: path.join(base, 'laptop') }, 0);
  assert.deepStrictEqual(got.edits.map((e) => e.rel), ['essays/a.md', '.env']);
  assert.strictEqual(got.edits[0].secret, undefined, 'not taken for the .claude folder');
  assert.strictEqual(got.edits[0].after, '# Essay\n');
  assert.strictEqual(got.edits[1].secret, true);
  assert.strictEqual(got.edits[1].after, null);
  tasks.stopAll();
});

test('a task\'s card and summary include the model and mode its Claude runs with', () => {
  const dir = path.join(base, 'model-dir');
  fs.mkdirSync(dir, { recursive: true });
  const cards = [];
  const tasks = new Tasks({ stateDir: path.join(base, 'state-c'), host: 'vm', log: () => {}, emit: (c) => cards.push(c) });
  const t = fakeTask(tasks, dir);
  tasks.onMessage(t, { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5[1m]', permissionMode: 'acceptEdits' });
  tasks.onMessage(t, { type: 'system', subtype: 'status', permissionMode: 'plan; rm -rf' });
  assert.strictEqual(t.model, 'claude-opus-5-5[1m]');
  assert.strictEqual(t.mode, 'acceptEdits', 'a mode that is not a plain word is not taken');
  const card = tasks.card(t);
  assert.strictEqual(card.model, 'claude-opus-5-5[1m]');
  assert.strictEqual(card.mode, 'acceptEdits');
  const sum = tasks.summary(t);
  assert.strictEqual(sum.kind, 'sent');
  assert.ok(Number.isFinite(sum.startedAt));
  tasks.stopAll();
});
