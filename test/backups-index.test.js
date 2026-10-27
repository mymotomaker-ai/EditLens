'use strict';
require('./isolate');
// The backups folder is listed once and kept in memory: an edit adds one file and reads no folder.
// The 200 copies / 60 MB limits still apply, and copies removed or added by something else are
// noticed (an unlink that finds nothing, or the periodic read of the folder).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BackupStore } = require('../server/backups');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-backups-'));
const copies = (dir) => fs.readdirSync(dir).filter((n) => /^b[0-9a-f]{16}\.json$/.test(n));

function counting(fn) {
  const counts = { readdir: 0, stat: 0 };
  const readdir = fs.readdirSync;
  const stat = fs.statSync;
  fs.readdirSync = (...a) => {
    counts.readdir++;
    return readdir.apply(fs, a);
  };
  fs.statSync = (...a) => {
    counts.stat++;
    return stat.apply(fs, a);
  };
  try {
    fn();
  } finally {
    fs.readdirSync = readdir;
    fs.statSync = stat;
  }
  return counts;
}

test('saving a copy reads the folder once, not on every edit', () => {
  const dir = tmp();
  try {
    const store = new BackupStore(path.join(dir, 'backups'));
    const file = path.join(dir, 'f.js');
    const counts = counting(() => {
      for (let i = 0; i < 60; i++) store.save({ file, text: 'v' + i });
    });
    assert.ok(counts.readdir <= 1 && counts.stat <= 1, JSON.stringify(counts));
    assert.strictEqual(store.list().length, 60);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the limits hold: 200 copies and 60 MB, oldest first', () => {
  const dir = tmp();
  try {
    const bdir = path.join(dir, 'backups');
    const store = new BackupStore(bdir);
    const file = path.join(dir, 'f.js');
    const ids = [];
    for (let i = 0; i < 230; i++) ids.push(store.save({ file, text: 'v' + i }));
    assert.strictEqual(copies(bdir).length, 200);
    assert.strictEqual(store.list().length, 200);
    assert.ok(!store.has(ids[29]) && store.has(ids[30]) && store.has(ids[229]), 'the oldest went first');
    // 1.9 MB each: about 31 fit in 60 MB.
    const big = 'x'.repeat(1.9 * 1024 * 1024);
    for (let i = 0; i < 40; i++) store.save({ file, text: big + i });
    const bytes = copies(bdir).reduce((n, name) => n + fs.statSync(path.join(bdir, name)).size, 0);
    assert.ok(bytes <= 60 * 1024 * 1024 && bytes > 55 * 1024 * 1024, String(bytes));
    assert.deepStrictEqual(store.list().map((f) => f.name).sort(), copies(bdir).sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copies removed or saved by something else are noticed', () => {
  const dir = tmp();
  try {
    const bdir = path.join(dir, 'backups');
    const store = new BackupStore(bdir);
    const file = path.join(dir, 'f.js');
    for (let i = 0; i < 150; i++) store.save({ file, text: 'v' + i });
    // Copies saved by another process (bin/connect.js): counted once the folder is read again.
    const other = new BackupStore(bdir);
    for (let i = 0; i < 20; i++) other.save({ file, text: 'other' + i });
    for (let i = 0; i < 100; i++) store.save({ file, text: 'more' + i });
    assert.strictEqual(copies(bdir).length, 200, 'copies saved by another process count toward the limit');
    assert.deepStrictEqual(store.list().map((f) => f.name).sort(), copies(bdir).sort());
    // Copies deleted manually: the next prune finds the oldest gone and reads the folder again.
    for (const f of store.list().slice(0, 5)) fs.unlinkSync(path.join(bdir, f.name));
    store.save({ file, text: 'next' });
    store.save({ file, text: 'next 2' });
    assert.deepStrictEqual(store.list().map((f) => f.name).sort(), copies(bdir).sort());
    // remove() removes it from the list too.
    const id = store.save({ file, text: 'gone soon' });
    store.remove(id);
    assert.ok(!store.list().some((f) => f.name === id + '.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
