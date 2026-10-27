'use strict';
require('./isolate');
// H2 (Sol scan of 0.24.40): restore, remove and undo check the saved file again before writing. A
// folder in its path that has become a link may not lead outside the project, or to a key file or
// the .claude folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BackupStore } = require('../server/backups');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-backups-links-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function setup(name) {
  const cwd = path.join(base, name, 'proj');
  const outside = path.join(base, name, 'outside');
  fs.mkdirSync(path.join(cwd, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'sub', 'a.txt'), 'new\n');
  fs.writeFileSync(path.join(outside, 'a.txt'), 'outside\n');
  fs.writeFileSync(path.join(cwd, '.claude', 'a.txt'), 'claude\n');
  const store = new BackupStore(path.join(base, name, 'backups'));
  const file = path.join(cwd, 'sub', 'a.txt');
  const id = store.save({ file, relFile: 'sub/a.txt', cwd, text: 'old\n', reason: 'edit' });
  return { cwd, outside, store, file, id };
}
// sub replaced with a link to `to`.
function relink(cwd, to) {
  fs.rmSync(path.join(cwd, 'sub'), { recursive: true });
  fs.symlinkSync(to, path.join(cwd, 'sub'));
}

test('restore and remove refuse a path that now leads outside the project', () => {
  const { cwd, outside, store, file, id } = setup('out');
  relink(cwd, outside);
  assert.match(String(store.check(id).error), /outside the project/);
  assert.match(String(store.restore(id).error), /outside the project/);
  assert.match(String(store.removeFile({ file, relFile: 'sub/a.txt', cwd }).error), /outside the project/);
  assert.match(String(store.replace({ file, relFile: 'sub/a.txt', cwd, text: 'x\n' }).error), /outside the project/);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'outside\n');
});

test('restore refuses a path that now leads into .claude', () => {
  const { cwd, store, id } = setup('claude');
  relink(cwd, path.join(cwd, '.claude'));
  assert.match(String(store.restore(id).error), /not changed/);
  assert.strictEqual(fs.readFileSync(path.join(cwd, '.claude', 'a.txt'), 'utf8'), 'claude\n');
});

test('with no link, restore and remove work as before', () => {
  const { cwd, store, file, id } = setup('plain');
  assert.ok(store.check(id).ok);
  assert.ok(store.restore(id).ok);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old\n');
  assert.ok(store.removeFile({ file, relFile: 'sub/a.txt', cwd }).ok);
  assert.ok(!fs.existsSync(file));
  // A folder link inside the project, there from the start, is fine.
  fs.mkdirSync(path.join(cwd, 'real'));
  fs.symlinkSync(path.join(cwd, 'real'), path.join(cwd, 'linked'));
  const f2 = path.join(cwd, 'linked', 'b.txt');
  const id2 = store.save({ file: f2, relFile: 'linked/b.txt', cwd, text: 'b old\n', reason: 'edit' });
  assert.ok(store.restore(id2).ok);
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'real', 'b.txt'), 'utf8'), 'b old\n');
});
