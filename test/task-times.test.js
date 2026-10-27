'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5249';
// Sol L3: a task list saved with times that are not numbers (an older or damaged file) gives
// cards and notices real times: never a string or NaN, and notices stay newest first.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tasks } = require('../server/tasks');

test('loaded tasks: times that are not numbers become the list file\'s time', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-task-times-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const now = Date.now();
  const task = (id, startedAt, updatedAt) => ({ id, cwd: '/p', dir: '/p', by: 'laptop', prompt: id, state: 'failed', error: 'x', startedAt, updatedAt });
  const probe = new Tasks({ stateDir, host: 'vps' });
  fs.writeFileSync(probe.file, JSON.stringify({ tasks: [
    task('aaaaaaaaaaa1', now - 5000, now - 4000),
    task('aaaaaaaaaaa2', 'yesterday', 'not a time'),
    task('aaaaaaaaaaa3', null, Infinity),
    task('aaaaaaaaaaa4', now - 3000, now - 2000),
  ] }));
  const tasks = new Tasks({ stateDir, host: 'vps' });
  for (const t of tasks.items.values()) {
    const card = tasks.card(t);
    assert.ok(Number.isFinite(card.startedAt) && Number.isFinite(card.ts), JSON.stringify([t.id, card.startedAt, card.ts]));
    assert.ok(card.ts <= Date.now() + 1000, 'not in the future');
  }
  const at = tasks.notices(null, () => true).map((n) => n.at);
  assert.ok(at.every(Number.isFinite), JSON.stringify(at));
  assert.deepStrictEqual(at, [...at].sort((a, b) => b - a));
});
