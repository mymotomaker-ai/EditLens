'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5244';
// Sol H5: a task's diff and search read file names from git exactly (-z), so a name with " b/", a tab
// or ":1:" can't make a secret file's lines appear.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Tasks } = require('../server/tasks');

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

const bases = [];
test.after(() => { for (const b of bases) fs.rmSync(b, { recursive: true, force: true }); });
function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-git-names-'));
  bases.push(base);
  const dir = path.join(base, 'ws');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'start');
  const t = { id: 'abcdef012345', kind: 'sent', dir, base: git(dir, 'rev-parse', 'HEAD'), edits: [] };
  // A task wrote these: secrets under names that confuse a "name:line:" or "a/... b/..." split.
  const put = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  put('a b/.env', 'SECRET_ONE=1\n');
  put('x\ty.pem', 'SECRET_TWO=2\n');
  put('c:1:d/.env', 'SECRET_THREE=3\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\nSECRET_NOT plain\n');
  return { t, tasks: new Tasks({ stateDir: path.join(base, 'state'), host: 'vps' }) };
}

test('diff: a secret file never appears, whatever its name; plain files do', async () => {
  const { t, tasks } = workspace();
  const out = await tasks.diff(t, [], 0);
  assert.ok(!out.error, out.error);
  assert.doesNotMatch(out.diff, /SECRET_(ONE|TWO|THREE)/);
  assert.match(out.diff, /^\+SECRET_NOT plain$/m);
  const one = await tasks.diff(t, ['a b/.env'], 0);
  assert.doesNotMatch(one.diff, /SECRET_ONE/);
});

test('search: a match in a secret file never appears, whatever its name', async () => {
  const { t, tasks } = workspace();
  const out = await tasks.search(t, 'SECRET_', null, 50);
  assert.ok(!out.error, out.error);
  assert.deepStrictEqual(out.matches, ['a.txt:2: SECRET_NOT plain']);
});

test('changes and files: names with control characters or that a laptop would read differently are left out', async () => {
  const { t, tasks } = workspace();
  fs.writeFileSync(path.join(t.dir, 'back\\slash.txt'), 'b');
  const files = await tasks.files(t, null, 0);
  assert.deepStrictEqual(files.files, ['a.txt']);
  const changes = await tasks.changes(t);
  assert.deepStrictEqual(changes.files.map((f) => f.path), ['a.txt']);
});
