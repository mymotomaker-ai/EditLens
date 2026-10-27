'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5382';
// Sol scan of 0.24.46, scope findings checked without a server: restore through the pairing link
// into a sibling project (H3), a task's merge outside the paired subfolder (H4), task search through
// a replaced folder (M2), pack reading a file swapped for a link (M5), restore with no undo copy
// (M6, refused unless noUndo is sent), git as the server user when the task account is gone, and a
// FIFO in a restore.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { BackupStore } = require('../server/backups');
const { createHostRestore } = require('../server/remote-restore');
const { Tasks } = require('../server/tasks');
const worktree = require('../lib/worktree');
const sendproject = require('../lib/sendproject');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function tmp() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol46-')));
  test.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}
const git = (dir, ...args) => assert.strictEqual(spawnSync('git', ['-C', dir, ...args]).status, 0, `git ${args.join(' ')}`);
function gitRepo(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'start');
}
const newTasks = (base) => new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps', log: () => {}, makeDriver: () => null });

// /repo is the session's folder, /repo/app-a the paired one, and app-a/link leads to /repo/app-b.
function linkedRepo() {
  const base = tmp();
  const repo = path.join(base, 'repo');
  const appA = path.join(repo, 'app-a');
  const appB = path.join(repo, 'app-b');
  write(path.join(appA, 'own.txt'), 'own');
  write(path.join(appB, 'target.txt'), 'sibling now');
  fs.symlinkSync(appB, path.join(appA, 'link'));
  const backups = new BackupStore(path.join(base, 'backups'));
  const events = [];
  const history = [];
  const host = createHostRestore({ history, backups, undo: {}, restoreEvent: (done) => events.push(done), log: () => {}, instance: 'i1' });
  return { base, repo, appA, appB, backups, history, host, events, pair: { id: 'p1', name: 'laptop', cwd: appA } };
}

test('H3: a restore through the pairing link never writes through a folder link into a sibling project', () => {
  const { repo, appA, appB, backups, history, host, pair } = linkedRepo();
  const file = path.join(appA, 'link', 'target.txt');
  const id = backups.save({ file, relFile: 'app-a/link/target.txt', cwd: repo, text: 'written from the laptop' });
  history.push({ type: 'change', seq: 1, file, relFile: 'app-a/link/target.txt', cwd: repo, backup: id });
  const out = host.handle(pair, { do: 'restore', backup: id });
  assert.strictEqual(fs.readFileSync(path.join(appB, 'target.txt'), 'utf8'), 'sibling now', JSON.stringify(out));
  assert.strictEqual(out.status, 403, JSON.stringify(out));
  // A file of the paired folder itself is still restored.
  const own = path.join(appA, 'own.txt');
  const id2 = backups.save({ file: own, relFile: 'app-a/own.txt', cwd: repo, text: 'own before' });
  history.push({ type: 'change', seq: 2, file: own, relFile: 'app-a/own.txt', cwd: repo, backup: id2 });
  assert.strictEqual(host.handle(pair, { do: 'restore', backup: id2 }).status, 200);
  assert.strictEqual(fs.readFileSync(own, 'utf8'), 'own before');
});

test('H3: Remove through the pairing link never deletes a file of a sibling project', () => {
  const { repo, appA, appB, history, host, pair } = linkedRepo();
  const file = path.join(appA, 'link', 'target.txt');
  history.push({ type: 'change', seq: 1, file, relFile: 'app-a/link/target.txt', cwd: repo, created: true, backup: null });
  const out = host.handle(pair, { do: 'remove', seq: 1, backup: null, rel: 'link/target.txt', inst: 'i1' });
  assert.ok(fs.existsSync(path.join(appB, 'target.txt')), JSON.stringify(out));
  assert.strictEqual(out.status, 403, JSON.stringify(out));
});

test('H3: a link made after the check still keeps the restore in the paired folder', () => {
  const { repo, appA, appB, backups } = linkedRepo();
  // The name was a plain folder of app-a when it was saved; it leads to app-b now.
  const file = path.join(appA, 'later', 'target.txt');
  const id = backups.save({ file, relFile: 'app-a/later/target.txt', cwd: repo, text: 'written from the laptop' });
  fs.symlinkSync(appB, path.join(appA, 'later'));
  const done = backups.restore(id, { root: appA });
  assert.ok(done.error, JSON.stringify(done));
  assert.strictEqual(fs.readFileSync(path.join(appB, 'target.txt'), 'utf8'), 'sibling now');
});

test('H4: a merge for a paired subfolder leaves out files outside it', async () => {
  const base = tmp();
  const repo = path.join(base, 'repo');
  write(path.join(repo, 'app-a', 'a.txt'), 'a\n');
  write(path.join(repo, 'app-b', 'b.txt'), 'b\n');
  write(path.join(repo, '.gitignore'), '.claude/\n');
  gitRepo(repo);
  const ws = worktree.create(path.join(repo, 'app-a'), 'editlens-task-h4aaaaaaaaaa');
  assert.ok(!ws.error, JSON.stringify(ws));
  write(path.join(ws.cwd, 'a.txt'), 'a changed\n');
  write(path.join(ws.cwd, '..', 'app-b', 'b.txt'), 'b changed by the task\n');
  write(path.join(ws.cwd, '..', 'root.txt'), 'new at the top\n');
  const done = await worktree.merge(repo, ws.name, { cleanOnly: true, only: 'app-a' });
  assert.deepStrictEqual(done.applied.map((a) => a.relFile), ['app-a/a.txt'], JSON.stringify(done));
  assert.strictEqual(fs.readFileSync(path.join(repo, 'app-b', 'b.txt'), 'utf8'), 'b\n');
  assert.ok(!fs.existsSync(path.join(repo, 'root.txt')));
  assert.deepStrictEqual([...done.outside].sort(), ['app-b/b.txt', 'root.txt']);
  // A whole-repository merge is as before.
  const all = await worktree.merge(repo, ws.name, { cleanOnly: true });
  assert.deepStrictEqual(all.applied.map((a) => a.relFile).sort(), ['app-b/b.txt', 'root.txt']);
  assert.strictEqual(all.outside, undefined);
});

test('H4: a folder link inside the paired subfolder does not lead the merge out of it', async () => {
  const base = tmp();
  const repo = path.join(base, 'repo');
  write(path.join(repo, 'app-a', 'a.txt'), 'a\n');
  write(path.join(repo, 'app-b', 'b.txt'), 'b\n');
  write(path.join(repo, '.gitignore'), '.claude/\n');
  gitRepo(repo);
  const ws = worktree.create(path.join(repo, 'app-a'), 'editlens-task-h4bbbbbbbbbb');
  // In the project, app-a/up leads to app-b; in the copy it is a plain folder with a new file.
  fs.symlinkSync(path.join(repo, 'app-b'), path.join(repo, 'app-a', 'up'));
  write(path.join(ws.cwd, 'up', 'new.txt'), 'through the link\n');
  const done = await worktree.merge(repo, ws.name, { cleanOnly: true, only: 'app-a' });
  assert.ok(!fs.existsSync(path.join(repo, 'app-b', 'new.txt')), JSON.stringify(done));
});

// M2: the workspace folder swapped for a link to another repository while git searches it.
test('M2: task search returns nothing found through a folder swapped in during the search', async (t) => {
  const base = tmp();
  const ws = path.join(base, 'ws');
  const other = path.join(base, 'other');
  write(path.join(ws, 'ok.txt'), 'ok zebra');
  write(path.join(other, 's.txt'), 'sibling secret zebra');
  gitRepo(ws);
  gitRepo(other);
  const tasks = newTasks(base);
  const task = { id: 'dddddddddddd', dir: ws, kind: 'sent', account: null };
  const real = worktree.gitAsync;
  t.after(() => { worktree.gitAsync = real; });
  worktree.gitAsync = async (cwd, args, opts) => {
    if (args[0] === 'grep' && !fs.lstatSync(ws).isSymbolicLink()) {
      fs.renameSync(ws, `${ws}-was`);
      fs.symlinkSync(other, ws);
    }
    return real(cwd, args, opts);
  };
  const r = await tasks.search(task, 'zebra');
  assert.ok(!/sibling secret/.test(JSON.stringify(r)), JSON.stringify(r));
});

test('M2: a match whose folder is a link now (to a sibling, or to .git) is left out', async (t) => {
  const base = tmp();
  const ws = path.join(base, 'ws');
  const sibling = path.join(base, 'sibling');
  write(path.join(ws, 'ok.txt'), 'ok zebra');
  write(path.join(sibling, 'example.txt'), 'sibling secret zebra');
  gitRepo(ws);
  fs.symlinkSync(sibling, path.join(ws, 'sub'));
  fs.symlinkSync(path.join(ws, '.git'), path.join(ws, 'cfg'));
  const tasks = newTasks(base);
  const task = { id: 'eeeeeeeeeeee', dir: ws, kind: 'sent', account: null };
  // git as it would answer if it read each name while the folder was still plain.
  const real = worktree.gitAsync;
  t.after(() => { worktree.gitAsync = real; });
  worktree.gitAsync = async (cwd, args, opts) => (args[0] === 'grep'
    ? { ok: true, status: 0, out: 'ok.txt\x001\x00ok zebra\nsub/example.txt\x001\x00sibling secret zebra\ncfg/config\x001\x00[core] zebra\n', err: '' }
    : real(cwd, args, opts));
  const r = await tasks.search(task, 'zebra');
  assert.deepStrictEqual(r.matches, ['ok.txt:1: ok zebra'], JSON.stringify(r));
});

// M5: the file is a plain file of the project when it is checked, and a link to outside when read.
test('M5: pack never sends a file swapped for a link between its check and its read', async (t) => {
  const base = tmp();
  const dir = path.join(base, 'project');
  const outside = path.join(base, 'outside.txt');
  write(path.join(dir, 'a.txt'), 'plain');
  write(outside, 'outside secret');
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    fs.rmSync(path.join(dir, 'a.txt'));
    fs.symlinkSync(outside, path.join(dir, 'a.txt'));
  };
  // Swapped right before the read (as the code was), or right after the first open (the folder).
  const { readFile } = fs.promises;
  const { openSync } = fs;
  t.after(() => {
    fs.promises.readFile = readFile;
    fs.openSync = openSync;
  });
  fs.promises.readFile = async (...args) => {
    swap();
    return readFile(...args);
  };
  fs.openSync = (...args) => {
    const fd = openSync(...args);
    swap();
    return fd;
  };
  const r = await sendproject.pack(dir);
  fs.promises.readFile = readFile;
  fs.openSync = openSync;
  const text = require('zlib').gunzipSync(r.bundle).toString('utf8');
  assert.ok(!text.includes(Buffer.from('outside secret').toString('base64')), text);
  assert.strictEqual(r.manifest['a.txt'], undefined);
});

test('M5: pack still sends plain files and leaves out links', async () => {
  const base = tmp();
  const dir = path.join(base, 'project');
  write(path.join(dir, 'a.txt'), 'plain');
  write(path.join(dir, 'run.sh'), '#!/bin/sh\n');
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  write(path.join(base, 'outside.txt'), 'outside');
  fs.symlinkSync(path.join(base, 'outside.txt'), path.join(dir, 'l.txt'));
  const r = await sendproject.pack(dir);
  assert.deepStrictEqual(Object.keys(r.manifest).sort(), ['a.txt', 'run.sh']);
  const text = require('zlib').gunzipSync(r.bundle).toString('utf8');
  assert.match(text, /"p":"run\.sh","x":1/);
});

// M6 (D23 B): a restore that can keep no undo copy is refused, and done only with noUndo: true
// ("Restore without Undo" on the card). test/no-undo.test.js checks the rest.
test('M6: a restore over a file too large for an undo copy is refused unless noUndo is sent', () => {
  const base = tmp();
  const file = path.join(base, 'big.txt');
  const backups = new BackupStore(path.join(base, 'backups'));
  const id = backups.save({ file, relFile: 'big.txt', cwd: base, text: 'small earlier version' });
  write(file, 'x'.repeat(3 * 1024 * 1024));
  assert.strictEqual(backups.restore(id).noUndo, 'large');
  assert.strictEqual(fs.statSync(file).size, 3 * 1024 * 1024, 'nothing written');
  const done = backups.restore(id, { noUndo: true });
  assert.strictEqual(done.ok, true);
  assert.strictEqual(done.undo, null, 'no copy of the 3 MB file was kept');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'small earlier version');
});

// B2: a task account removed while its task is listed: git never runs as the server's own user there.
test('B2: git does not run as the server user when the task account is gone', async () => {
  const base = tmp();
  const ws = path.join(base, 'ws');
  write(path.join(ws, 'ok.txt'), 'ok zebra');
  gitRepo(ws);
  const tasks = newTasks(base);
  const task = { id: 'ffffffffffff', dir: ws, kind: 'sent', account: 'editlens-gone-account' };
  const r = await tasks.search(task, 'zebra');
  assert.ok(r.error && !r.matches, JSON.stringify(r));
});

// B3: a file replaced by a named pipe is not read (a read would wait for a writer, and the server
// with it). Run in a child, so a wait ends that child only.
test('B3: a restore check of a file that is now a named pipe does not wait', { skip: process.platform === 'win32' }, () => {
  const base = tmp();
  const file = path.join(base, 'pipe.txt');
  const script = `const { BackupStore } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'backups'))});
const b = new BackupStore(${JSON.stringify(path.join(base, 'backups'))});
const id = b.save({ file: ${JSON.stringify(file)}, relFile: 'pipe.txt', cwd: ${JSON.stringify(base)}, text: 'earlier' });
require('child_process').execFileSync('mkfifo', [${JSON.stringify(file)}]);
console.log(JSON.stringify(b.check(id)));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.strictEqual(r.signal, null, 'the check waited on the pipe');
  assert.match(r.stdout, /"error"/, r.stdout + r.stderr);
});

// B3: copy_from_computer keeps the file it replaces (for undo). A file swapped for a link to a file
// outside the project between its check and its read is never kept.
test('B3: copyFrom never keeps the text of a file outside the project as its undo copy', async (t) => {
  const { copyFrom } = require('../lib/remotework');
  const base = tmp();
  const dir = path.join(base, 'project');
  const stateDir = path.join(base, 'state');
  const outside = path.join(base, 'outside.txt');
  write(path.join(dir, 'a.txt'), 'old');
  write(outside, 'outside secret');
  const here = path.join(dir, 'a.txt');
  const call = async (op, extra) => {
    if (op === 'project-files') return Array.isArray(extra.hash) ? { shas: {} } : { root: '/there', kind: 'dir', files: [{ path: 'a.txt', size: 3 }], next: null };
    if (op === 'project-file') return { data: Buffer.from('new').toString('base64'), next: null };
    return { error: 'unknown' };
  };
  // The second look at a.txt (the copy kept for undo) finds a link put there just after its check.
  // Every file written is recorded: the kept copy is removed again when nothing is copied.
  const { lstatSync, writeFileSync } = fs;
  let looks = 0;
  const kept = [];
  t.after(() => Object.assign(fs, { lstatSync, writeFileSync }));
  fs.lstatSync = (p, ...rest) => {
    const st = lstatSync(p, ...rest);
    if (p === here && ++looks === 2) {
      fs.rmSync(here);
      fs.symlinkSync(outside, here);
    }
    return st;
  };
  fs.writeFileSync = (f, data, ...rest) => {
    kept.push(String(data));
    return writeFileSync(f, data, ...rest);
  };
  await copyFrom(call, { from: '.', dir, stateDir, computer: 'vps', overwrite: true });
  Object.assign(fs, { lstatSync, writeFileSync });
  assert.ok(!kept.some((x) => x.includes('outside secret')), JSON.stringify(kept));
  assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'outside secret');
});

// The same for the task's diff: a clone with the same start, swapped in while git compares.
test('M2: the task diff returns nothing read through a folder swapped in during the diff', async (t) => {
  const base = tmp();
  const ws = path.join(base, 'ws');
  const other = path.join(base, 'other');
  write(path.join(ws, 'a.txt'), 'start\n');
  gitRepo(ws);
  assert.strictEqual(spawnSync('git', ['clone', '-q', ws, other]).status, 0);
  write(path.join(ws, 'a.txt'), 'task change\n');
  write(path.join(other, 'a.txt'), 'sibling secret\n');
  const head = spawnSync('git', ['-C', ws, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const tasks = newTasks(base);
  const task = { id: 'abababababab', dir: ws, kind: 'sent', account: null, base: head };
  const real = worktree.gitAsync;
  t.after(() => { worktree.gitAsync = real; });
  worktree.gitAsync = async (cwd, args, opts) => {
    if (args[0] === 'add' && !fs.lstatSync(ws).isSymbolicLink()) {
      fs.renameSync(ws, `${ws}-was`);
      fs.symlinkSync(other, ws);
    }
    return real(cwd, args, opts);
  };
  const r = await tasks.diff(task, [], 0);
  assert.ok(!/sibling secret/.test(JSON.stringify(r)), JSON.stringify(r));
});

// The same check-then-read in copy_from_computer's file pages and hashes (server/tasks.js).
test('M5: a project file page is never read from a link swapped in after its check', (t) => {
  const base = tmp();
  const dir = path.join(base, 'project');
  const outside = path.join(base, 'outside.txt');
  write(path.join(dir, 'a.txt'), 'plain');
  write(outside, 'outside secret');
  const tasks = newTasks(base);
  const { openSync } = fs;
  t.after(() => { fs.openSync = openSync; });
  fs.openSync = (...args) => {
    if (!fs.lstatSync(path.join(dir, 'a.txt')).isSymbolicLink()) {
      fs.rmSync(path.join(dir, 'a.txt'));
      fs.symlinkSync(outside, path.join(dir, 'a.txt'));
    }
    return openSync(...args);
  };
  const page = tasks.projectFile({ cwd: dir }, 'a.txt', 0);
  fs.openSync = openSync;
  assert.ok(!page.data || Buffer.from(page.data, 'base64').toString() !== 'outside secret', JSON.stringify(page));
});

test('M5: a project file hash is never read through a folder swapped for a link after its check', async (t) => {
  const base = tmp();
  const dir = path.join(base, 'project');
  const away = path.join(base, 'away');
  write(path.join(dir, 'sub', 'a.txt'), 'plain');
  write(path.join(away, 'a.txt'), 'outside secret');
  const tasks = newTasks(base);
  const swap = () => {
    if (fs.lstatSync(path.join(dir, 'sub')).isSymbolicLink()) return;
    fs.renameSync(path.join(dir, 'sub'), path.join(dir, 'sub-was'));
    fs.symlinkSync(away, path.join(dir, 'sub'));
  };
  const { open, openSync } = fs;
  t.after(() => Object.assign(fs, { open, openSync }));
  fs.open = (...args) => {
    swap();
    return open(...args);
  };
  fs.openSync = (...args) => {
    const fd = openSync(...args);
    swap();
    return fd;
  };
  const r = await tasks.projectFiles({ cwd: dir }, '', 0, ['sub/a.txt']);
  Object.assign(fs, { open, openSync });
  assert.notStrictEqual(r.shas['sub/a.txt'], sendproject.sha(Buffer.from('outside secret')), JSON.stringify(r));
});

// H3, Undo and "put back" through the pairing link (server/undo.js): a folder of app-a is plain when
// the request is checked and a link to app-b when the file is written. The write is refused.
function swapAtWrite(backups, dir, to) {
  const swap = () => {
    if (fs.lstatSync(dir).isSymbolicLink()) return;
    fs.renameSync(dir, `${dir}-was`);
    fs.symlinkSync(to, dir);
  };
  for (const k of ['replace', 'restore']) {
    const real = backups[k].bind(backups);
    backups[k] = (...args) => {
      swap();
      return real(...args);
    };
  }
}
function undoSetup() {
  const { createUndo } = require('../server/undo');
  const base = tmp();
  const repo = path.join(base, 'repo');
  const appA = path.join(repo, 'app-a');
  const appB = path.join(repo, 'app-b');
  const file = path.join(appA, 'later', 'target.txt');
  write(file, 'one\nnew\n');
  write(path.join(appB, 'target.txt'), 'one\nnew\n');
  const backups = new BackupStore(path.join(base, 'backups'));
  const id = backups.save({ file, relFile: 'app-a/later/target.txt', cwd: repo, text: 'one\nold\n', after: 'one\nnew\n' });
  const history = [{ type: 'change', seq: 1, file, relFile: 'app-a/later/target.txt', cwd: repo, backup: id, snapshot: 's1' }];
  const snapshots = { items: new Map([['s1', { before: 'one\nold\n', after: 'one\nnew\n' }]]) };
  let seq = 1;
  const restoreEvent = (done, via, from, extra) => {
    const ev = { type: 'change', kind: 'restore', seq: ++seq, file: done.file, cwd: done.cwd, via, restoredFrom: from, backup: done.undo, ...extra };
    history.push(ev);
    return ev;
  };
  const undo = createUndo({ history, snapshots, backups, restoreEvent, log: () => {} });
  const host = createHostRestore({ history, backups, undo, restoreEvent, log: () => {}, instance: 'i1' });
  return { appA, appB, backups, history, host, id, pair: { id: 'p1', name: 'laptop', cwd: appA } };
}

test('H3: Undo only this edit through the pairing link never writes through a link made after the check', () => {
  const { appA, appB, backups, host, id, pair } = undoSetup();
  swapAtWrite(backups, path.join(appA, 'later'), appB);
  const out = host.handle(pair, { do: 'undo', seq: 1, backup: id, rel: 'later/target.txt', inst: 'i1' });
  assert.strictEqual(fs.readFileSync(path.join(appB, 'target.txt'), 'utf8'), 'one\nnew\n', JSON.stringify(out));
  assert.notStrictEqual(out.status, 200, JSON.stringify(out));
});

test('H3: put back through the pairing link never writes through a link made after the check', () => {
  const { appA, appB, backups, history, host, id, pair } = undoSetup();
  // The edit was undone earlier (its file is as before the edit), and that undo kept a copy.
  const file = path.join(appA, 'later', 'target.txt');
  fs.writeFileSync(file, 'one\nold\n');
  fs.writeFileSync(path.join(appB, 'target.txt'), 'one\nold\n');
  const kept = backups.save({ file, relFile: 'app-a/later/target.txt', cwd: history[0].cwd, text: 'one\nnew\n', reason: 'undo-edit' });
  history.push({ type: 'change', kind: 'restore', seq: 2, file, cwd: history[0].cwd, via: 'undo-edit', undidBackup: id, backup: kept });
  swapAtWrite(backups, path.join(appA, 'later'), appB);
  const out = host.handle(pair, { do: 'back', seq: 1, backup: id, rel: 'later/target.txt', inst: 'i1' });
  assert.strictEqual(fs.readFileSync(path.join(appB, 'target.txt'), 'utf8'), 'one\nold\n', JSON.stringify(out));
  assert.notStrictEqual(out.status, 200, JSON.stringify(out));
});

test('H3: Undo only this edit through the pairing link still works for a file of the paired folder', () => {
  const { appA, host, id, pair } = undoSetup();
  const out = host.handle(pair, { do: 'undo', seq: 1, backup: id, rel: 'later/target.txt', inst: 'i1' });
  assert.strictEqual(out.status, 200, JSON.stringify(out));
  assert.strictEqual(fs.readFileSync(path.join(appA, 'later', 'target.txt'), 'utf8'), 'one\nold\n');
});
