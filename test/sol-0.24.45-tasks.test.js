'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5350';
// Sol scan of 0.24.45, task and edit feed findings: the paired edit feed through links and in .git
// (H2), task search through a replaced folder (H3), the command-edit reader's wait between its check
// and its read (H4), a replaced workspace folder (H5), and a token in a Git remote's query (M4).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { Tasks, publicRemote } = require('../server/tasks');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function place() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol45-')));
  test.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const sibling = path.join(base, 'sibling');
  write(path.join(project, 'a.txt'), 'a');
  write(path.join(sibling, 'example.txt'), 'sibling secret zebra');
  return { base, project, sibling };
}
const newTasks = (base) => new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps', log: () => {}, makeDriver: () => null });
const git = (dir, ...args) => assert.strictEqual(spawnSync('git', ['-C', dir, ...args]).status, 0, `git ${args.join(' ')}`);
const edit = (file, extra = {}) => ({ kind: 'session', file, dir: null, tool: 'Edit', intent: 'x', before: 'old text', after: 'new text', ts: Date.now(), ...extra });
const sent = (r) => JSON.stringify(r.edits);

test('H2: a session edit through a folder link to a sibling project is never sent', () => {
  const { base, project, sibling } = place();
  fs.symlinkSync(sibling, path.join(project, 'link'));
  const tasks = newTasks(base);
  tasks.pushEdit(edit(path.join(project, 'link', 'example.txt'), { before: 'sibling secret', after: 'sibling secret zebra' }));
  const r = tasks.editsFor({ id: 'p1', cwd: project }, 0);
  assert.ok(!/sibling secret|example\.txt/.test(sent(r)), sent(r));
});

test('H2: a folder made a link after the edit is checked again before the edit is sent', () => {
  const { base, project, sibling } = place();
  const tasks = newTasks(base);
  tasks.pushEdit(edit(path.join(project, 'later', 'example.txt'), { before: 'sibling secret', after: 'sibling secret zebra' }));
  fs.symlinkSync(sibling, path.join(project, 'later'));
  const r = tasks.editsFor({ id: 'p1', cwd: project }, 0);
  assert.ok(!/sibling secret/.test(sent(r)), sent(r));
});

test('H2: a session edit of .git/config is sent without its text', () => {
  const { base, project } = place();
  write(path.join(project, '.git', 'config'), '[remote "origin"]');
  const tasks = newTasks(base);
  tasks.pushEdit(edit(path.join(project, '.git', 'config'), { before: '[core]', after: '[remote "origin"] url = https://tok@host/x' }));
  tasks.pushEdit(edit(path.join(project, 'a.txt'), { before: 'a', after: 'b' }));
  const r = tasks.editsFor({ id: 'p1', cwd: project }, 0);
  assert.ok(!/remote "origin"|\[core\]/.test(sent(r)), sent(r));
  const plain = r.edits.find((e) => e.rel === 'a.txt');
  assert.ok(plain && plain.after === 'b', 'an ordinary edit is still sent with its text');
});

test('H2: a task edit through a folder link out of its workspace is never sent', () => {
  const { base, project, sibling } = place();
  const ws = path.join(base, 'ws');
  fs.mkdirSync(ws);
  fs.symlinkSync(sibling, path.join(ws, 'link'));
  const tasks = newTasks(base);
  tasks.pushEdit({ ...edit(path.join(ws, 'link', 'example.txt'), { before: 'sibling secret', after: 'sibling secret 2' }), kind: 'task', task: 'aaaaaaaaaaaa', pairId: 'p1', dir: ws });
  const r = tasks.editsFor({ id: 'p1', cwd: project }, 0);
  assert.ok(!/sibling secret/.test(sent(r)), sent(r));
});

test('H3: task search never returns text through a replaced folder, a link or into .git', async () => {
  const { base, sibling } = place();
  const ws = path.join(base, 'ws3');
  write(path.join(ws, 'sub', 'example.txt'), 'inside zebra');
  write(path.join(ws, 'cfg', 'config'), 'plain');
  write(path.join(ws, 'ok.txt'), 'ok zebra');
  git(ws, 'init', '-q');
  git(ws, 'add', '-A');
  git(ws, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'x');
  fs.rmSync(path.join(ws, 'sub'), { recursive: true });
  fs.symlinkSync(sibling, path.join(ws, 'sub'));
  fs.rmSync(path.join(ws, 'cfg'), { recursive: true });
  fs.symlinkSync(path.join(ws, '.git'), path.join(ws, 'cfg'));
  fs.symlinkSync(path.join(sibling, 'example.txt'), path.join(ws, 'leak.txt'));
  const tasks = newTasks(base);
  const t = { id: 'bbbbbbbbbbbb', dir: ws, kind: 'sent', account: null };
  const r = await tasks.search(t, 'zebra');
  assert.ok(!/sibling secret/.test(JSON.stringify(r)), JSON.stringify(r));
  assert.deepStrictEqual(r.matches, ['ok.txt:1: ok zebra']);
  const g = await tasks.search(t, 'repositoryformatversion');
  assert.deepStrictEqual(g.matches, [], JSON.stringify(g));
});

test('H4: a folder swapped for a link while the command-edit reader waits is not read', async (t) => {
  const { base, sibling } = place();
  const ws = path.join(base, 'ws4');
  write(path.join(ws, 'sub', 'example.txt'), 'inside');
  const tasks = newTasks(base);
  const task = { id: 'cccccccccccc', dir: ws };
  let swapped = false;
  const swap = () => {
    if (swapped) return;
    swapped = true;
    fs.renameSync(path.join(ws, 'sub'), path.join(ws, 'sub-was'));
    fs.symlinkSync(sibling, path.join(ws, 'sub'));
  };
  // The swap happens right after the reader's first step: its wait for the workspace's real path,
  // or its first open (the workspace folder).
  const { realpath, open } = fs.promises;
  const { openSync } = fs;
  fs.promises.realpath = async (p, ...rest) => {
    if (p === ws) swap();
    return realpath(p, ...rest);
  };
  fs.promises.open = async (...args) => {
    const fh = await open(...args);
    swap();
    return fh;
  };
  fs.openSync = (...args) => {
    const fd = openSync(...args);
    swap();
    return fd;
  };
  t.after(() => {
    Object.assign(fs.promises, { realpath, open });
    fs.openSync = openSync;
  });
  const r = await tasks.readRel(task, 'sub/example.txt');
  assert.ok(swapped, 'the folder was swapped during the read');
  assert.ok(!(r && r.buf && /sibling/.test(String(r.buf))), String(r && r.buf));
});

test('H4: a link on any part of the path is refused, also one that stays in the workspace', async () => {
  const { base } = place();
  const ws = path.join(base, 'ws4b');
  write(path.join(ws, 'plain', 'a.txt'), 'a');
  fs.symlinkSync(path.join(ws, 'plain'), path.join(ws, 'docs'));
  fs.symlinkSync(path.join(ws, 'plain', 'a.txt'), path.join(ws, 'b.txt'));
  const tasks = newTasks(base);
  const t = { id: 'dddddddddddd', dir: ws };
  assert.strictEqual(await tasks.readRel(t, 'docs/a.txt'), null);
  assert.strictEqual(await tasks.readRel(t, 'b.txt'), null);
  assert.strictEqual(String((await tasks.readRel(t, 'plain/a.txt')).buf), 'a');
  assert.deepStrictEqual(await tasks.readRel(t, 'plain/gone.txt'), { missing: true });
});

test('H5: a workspace replaced by a link to another folder is refused', async () => {
  const { base } = place();
  const stateDir = path.join(base, 'state5');
  const ws = path.join(base, 'ws5');
  const priv = path.join(base, 'private');
  write(path.join(ws, 'a.txt'), 'mine');
  write(path.join(priv, 'a.txt'), 'private text');
  fs.mkdirSync(stateDir);
  const saved = { id: 'eeeeeeeeeeee', by: 'laptop', pairId: 'p1', cwd: base, dir: ws, kind: 'sent', state: 'idle', prompt: 'x', replies: [] };
  fs.writeFileSync(path.join(stateDir, 'tasks.json'), JSON.stringify({ tasks: [saved] }));
  const tasks = new Tasks({ stateDir, host: 'vps', log: () => {}, makeDriver: () => null });
  const t = tasks.items.get('eeeeeeeeeeee');
  const before = await tasks.workspaceFile(t, 'a.txt', 0);
  assert.strictEqual(Buffer.from(before.data, 'base64').toString(), 'mine');
  fs.renameSync(ws, ws + '-was');
  fs.symlinkSync(priv, ws);
  const r = await tasks.workspaceFile(t, 'a.txt', 0);
  assert.ok(!r.data, `read the other folder: ${r.data && Buffer.from(r.data, 'base64')}`);
  assert.strictEqual(await tasks.readRel(t, 'a.txt'), null);
  assert.ok(!/private/.test(JSON.stringify(await tasks.search(t, 'private'))));
});

test('H5: a task account\'s workspace file that the account does not own is not read', async () => {
  const { base } = place();
  const ws = path.join(base, 'ws5b');
  write(path.join(ws, 'a.txt'), 'root file');
  write(path.join(ws, 'b.txt'), 'account file');
  // A stand-in account in this test's passwd file (test/isolate.js); nothing runs as it.
  fs.appendFileSync(process.env.EDITLENS_TEST_PASSWD, `editlens:x:1777:1777::${base}:/bin/bash\n`);
  const tasks = newTasks(base);
  const t = { id: 'ffffffffffff', dir: ws, kind: 'sent', account: 'editlens' };
  const r = await tasks.workspaceFile(t, 'a.txt', 0);
  assert.ok(!r.data, 'a file of another account is not read');
  assert.strictEqual(await tasks.readRel(t, 'a.txt'), null);
  if (process.getuid && process.getuid() === 0) {
    fs.chownSync(path.join(ws, 'b.txt'), 1777, 1777);
    const ok = await tasks.workspaceFile(t, 'b.txt', 0);
    assert.strictEqual(Buffer.from(ok.data, 'base64').toString(), 'account file');
  }
});

test('M4: a git remote goes to the other computer as its scheme, host and path only', () => {
  assert.strictEqual(publicRemote('https://github.com/me/app.git?access_token=abc#frag'), 'https://github.com/me/app.git');
  assert.strictEqual(publicRemote('https://me:pw@host:8443/x/app.git?x=1'), 'https://host:8443/x/app.git');
  assert.strictEqual(publicRemote('ssh://git:pw@host/x.git#k'), 'ssh://host/x.git');
  assert.strictEqual(publicRemote('git@github.com:me/app.git'), 'github.com:me/app.git');
  assert.strictEqual(publicRemote('me:pw@host:me/app.git?token=1'), 'host:me/app.git');
});
