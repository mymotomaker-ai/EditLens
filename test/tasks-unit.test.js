'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4939';
// A task on a computer without the Claude Agent SDK: a plain answer, and no copy is kept.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-tasks-unit-'));
process.env.EDITLENS_SDK_DIR = path.join(base, 'no-sdk');
const { Tasks } = require('../server/tasks');

test('no SDK yet: says how to get it and makes no copy', async (t) => {
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  for (const args of [['init', '-q', '-b', 'main'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['commit', '-q', '--allow-empty', '-m', 'start']]) {
    assert.strictEqual(spawnSync('git', ['-C', project, ...args]).status, 0);
  }
  const tasks = new Tasks({ stateDir: base, host: 'vps', makeDriver: () => assert.fail('no driver without the SDK') });
  const out = await tasks.start({ name: 'laptop', id: 'p1', cwd: project }, { prompt: 'hi' });
  assert.match(out.error, /\/editlens control vps/);
  assert.strictEqual(fs.existsSync(path.join(project, '.claude', 'worktrees')), false);
  assert.strictEqual(tasks.items.size, 0, 'no task kept');
  // A task is text: a number or an object is not taken as the task "5".
  for (const prompt of [5, { a: 1 }, ['x']]) assert.match((await tasks.start({ name: 'laptop', id: 'p1', cwd: project }, { prompt })).error, /Give the task/);
});

test('a file\'s intent: Claude\'s own words win over a command scan, in either order', () => {
  const { intentsByFile } = require('../server/tasks');
  const claude = { relFile: 'src/App.jsx', intent: 'Link the admin page', auto: false };
  const scan = { relFile: 'src/App.jsx', intent: 'Changed by a command', auto: true };
  assert.strictEqual(intentsByFile([scan, claude]).get('src/App.jsx'), 'Link the admin page');
  assert.strictEqual(intentsByFile([claude, scan]).get('src/App.jsx'), 'Link the admin page');
  assert.strictEqual(intentsByFile([scan]).get('src/App.jsx'), 'Changed by a command');
  assert.strictEqual(intentsByFile([claude, { ...claude, intent: 'Later words' }]).get('src/App.jsx'), 'Later words');
  assert.strictEqual(intentsByFile(null).size, 0);
});
