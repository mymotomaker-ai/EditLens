'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5245';
// Links in a project (Sol H3, H4, M6, M7): a link can't lead a write, a read or a listing outside the
// project, or to a file that is never read or written (.env and keys). One check: lib/safepath.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const safepath = require('../lib/safepath');
const sendproject = require('../lib/sendproject');
const { Tasks } = require('../server/tasks');
const { copyFrom, undoApply } = require('../lib/remotework');
const { resolveFile } = require('../server/static');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function place() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-links-')));
  test.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  write(path.join(project, 'a.txt'), 'a');
  write(path.join(project, '.env'), 'KEY=secret');
  write(path.join(outside, 'sub', 'x.txt'), 'x');
  write(path.join(outside, 'index.html'), 'outside');
  return { base, project, outside };
}

test('safepath: links are resolved, a new file is placed under the real folder', () => {
  const { project, outside } = place();
  fs.symlinkSync(outside, path.join(project, 'link'));
  fs.symlinkSync(path.join(project, '.env'), path.join(project, 'alias.txt'));
  assert.deepStrictEqual(safepath.inside(project, 'a.txt'), { file: path.join(project, 'a.txt'), rel: 'a.txt', exists: true });
  assert.deepStrictEqual(safepath.inside(project, 'new/b.txt'), { file: path.join(project, 'new', 'b.txt'), rel: 'new/b.txt', exists: false });
  assert.deepStrictEqual(safepath.inside(project, 'link/new.txt'), { error: 'outside' });
  assert.deepStrictEqual(safepath.inside(project, 'link/sub/x.txt'), { error: 'outside' });
  assert.strictEqual(safepath.inside(project, 'alias.txt').rel, '.env');
  assert.deepStrictEqual(safepath.inside(path.join(project, 'nope'), 'a.txt'), { error: 'ENOENT' });
});

test('applying a task change: a folder link to outside and an alias of .env are refused', () => {
  const { project, outside } = place();
  fs.symlinkSync(outside, path.join(project, 'link'));
  fs.symlinkSync(path.join(project, '.env'), path.join(project, 'alias.txt'));
  const out = sendproject.applyChange(project, { path: 'link/new.txt', status: 'added' }, Buffer.from('n'), {});
  assert.match(out.error, /outside the project \(through a link\)/);
  assert.ok(!fs.existsSync(path.join(outside, 'new.txt')), 'nothing written outside');
  const alias = sendproject.applyChange(project, { path: 'alias.txt', status: 'changed' }, Buffer.from('KEY=other'), { 'alias.txt': sendproject.sha(Buffer.from('KEY=secret')) });
  assert.match(alias.error, /not a file this can write/);
  assert.strictEqual(fs.readFileSync(path.join(project, '.env'), 'utf8'), 'KEY=secret');
  // A plain new file still works.
  assert.ok(sendproject.applyChange(project, { path: 'new/b.txt', status: 'added' }, Buffer.from('b'), {}).ok);
});

test('copy from a paired computer: a folder link here is not followed; undo keeps a file a link moved outside', async () => {
  const { base, project: vps, outside } = place();
  write(path.join(vps, 'pulse', 'index.html'), 'theirs');
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps' });
  const pair = { cwd: vps };
  const call = async (op, body) => {
    const wire = JSON.parse(JSON.stringify(body));
    const res = op === 'project-files' ? await tasks.projectFiles(pair, wire.path, Number(wire.offset), wire.hash) : tasks.projectFile(pair, wire.path, Number(wire.offset));
    return JSON.parse(JSON.stringify(res));
  };
  const stateDir = path.join(base, 'laptop-state');
  // Copy: the laptop's pulse is a link to a folder outside the project.
  const laptop = path.join(base, 'laptop');
  fs.mkdirSync(laptop);
  fs.symlinkSync(outside, path.join(laptop, 'pulse'));
  const res = await copyFrom(call, { from: 'pulse', dir: laptop, stateDir, computer: 'vps', overwrite: true });
  assert.deepStrictEqual(res.copied, []);
  assert.deepStrictEqual(res.failed.map((f) => f.path), ['pulse/index.html']);
  assert.match(res.failed[0].why, /through a link/);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'index.html'), 'utf8'), 'outside');
  // Undo: copied into a real folder, then the folder became a link to outside.
  const laptop2 = path.join(base, 'laptop2');
  write(path.join(laptop2, 'pulse', 'index.html'), 'mine');
  const over = await copyFrom(call, { from: 'pulse', dir: laptop2, stateDir, computer: 'vps', overwrite: true });
  assert.deepStrictEqual(over.copied, ['pulse/index.html']);
  fs.renameSync(path.join(laptop2, 'pulse'), path.join(laptop2, 'pulse-old'));
  fs.symlinkSync(outside, path.join(laptop2, 'pulse'));
  const undone = await undoApply({ stateDir, apply: over.copy });
  assert.deepStrictEqual(undone.kept.map((k) => [k.path, /outside the project now/.test(k.why)]), [['pulse/index.html', true]]);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'index.html'), 'utf8'), 'outside');
});

test('reading a project file: an alias of .env and a file through a link outside are refused', () => {
  const { base, project, outside } = place();
  fs.symlinkSync(path.join(project, '.env'), path.join(project, 'notes.txt'));
  fs.symlinkSync(outside, path.join(project, 'link'));
  fs.symlinkSync(path.join(project, 'a.txt'), path.join(project, 'same.txt'));
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps' });
  const pair = { cwd: project };
  assert.match(tasks.projectFile(pair, 'notes.txt', 0).error, /Not a file in the project/);
  assert.match(tasks.projectFile(pair, 'link/sub/x.txt', 0).error, /Not a file in the project/);
  assert.ok(tasks.projectFile(pair, 'same.txt', 0).missing !== true && !tasks.projectFile(pair, 'same.txt', 0).error, 'a link inside the project is read');
  assert.strictEqual(tasks.projectFile(pair, 'gone.txt', 0).missing, true);
});

test('listing a project folder: a path under a folder link is refused', async () => {
  const { base, project, outside } = place();
  fs.symlinkSync(outside, path.join(project, 'link'));
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps' });
  const pair = { cwd: project };
  assert.match((await tasks.projectFiles(pair, 'link/sub', 0)).error, /behind a link/);
  assert.match((await tasks.projectFiles(pair, 'link', 0)).error, /is a link/);
  assert.deepStrictEqual((await tasks.projectFiles(pair, '.', 0)).files.map((f) => f.path), ['a.txt']);
});

test('static site: index.html and public names that link outside or to a hidden file are refused', async () => {
  const { project: site, outside } = place();
  write(path.join(site, 'page', 'index.html'), 'page');
  fs.mkdirSync(path.join(site, 'out'));
  fs.symlinkSync(path.join(outside, 'index.html'), path.join(site, 'out', 'index.html'));
  fs.mkdirSync(path.join(site, 'hidden'));
  fs.symlinkSync(path.join(site, '.env'), path.join(site, 'hidden', 'index.html'));
  fs.symlinkSync(path.join(site, '.env'), path.join(site, 'public.txt'));
  assert.ok((await resolveFile(site, '/page/')).file || (await resolveFile(site, '/page/')).index, 'a plain folder page is served');
  assert.strictEqual(await resolveFile(site, '/out/'), null);
  assert.strictEqual(await resolveFile(site, '/hidden/'), null);
  assert.strictEqual(await resolveFile(site, '/public.txt'), null);
  assert.deepStrictEqual(await resolveFile(site, '/nope.txt'), { missing: true });
});

// H5 (Sol scan of 0.24.43): key files whose names don't start with a dot, also through a link.
test('the static server never serves key files: id_ed25519, *.pem, credentials, or a link to one', async () => {
  const { project } = place();
  const site = path.join(project, 'keysite');
  write(path.join(site, 'index.html'), '<p>hi</p>');
  write(path.join(site, 'id_ed25519'), 'k');
  write(path.join(site, 'certs', 'private.pem'), 'k');
  write(path.join(site, 'credentials.json'), 'k');
  write(path.join(site, 'app.js'), 'ok');
  fs.symlinkSync(path.join(site, 'id_ed25519'), path.join(site, 'readme.txt'));
  for (const p of ['/id_ed25519', '/certs/private.pem', '/credentials.json', '/readme.txt']) assert.strictEqual(await resolveFile(site, p), null, p);
  assert.ok((await resolveFile(site, '/app.js')).file, 'an ordinary file is served');
});

// H4 (Sol scan of 0.24.43): a folder link inside the workspace can lead to an excluded file, and the
// command-edit scan checked only the name it was given.
test('the task scan never reads an excluded file through a folder link in the workspace', async () => {
  const { project } = place();
  const ws = path.join(project, 'ws');
  write(path.join(ws, '.aws', 'config'), 'key');
  write(path.join(ws, '.claude', 'settings.json'), '{}');
  write(path.join(ws, 'plain', 'a.txt'), 'a');
  fs.symlinkSync(path.join(ws, '.aws'), path.join(ws, 'public'));
  fs.symlinkSync(path.join(ws, '.claude'), path.join(ws, 'conf'));
  fs.symlinkSync(path.join(ws, 'plain'), path.join(ws, 'docs'));
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(project, 'tstate-')), host: 'vps', makeDriver: () => null });
  const t = { dir: ws };
  assert.strictEqual(await tasks.readRel(t, 'public/config'), null);
  assert.strictEqual(await tasks.readRel(t, 'conf/settings.json'), null);
  // Sol 0.24.45 H4: no link on any part of the path, even one to an ordinary folder in the workspace.
  assert.strictEqual(await tasks.readRel(t, 'docs/a.txt'), null);
  assert.strictEqual(String((await tasks.readRel(t, 'plain/a.txt')).buf), 'a', 'an ordinary file is read');
});

test('sending a project: a file git still lists under a folder that is now a link stays here', async () => {
  const { project, outside } = place();
  const { spawnSync } = require('child_process');
  write(path.join(project, 'cfg', 'x.txt'), 'in');
  assert.strictEqual(spawnSync('git', ['-C', project, 'init', '-q']).status, 0);
  assert.strictEqual(spawnSync('git', ['-C', project, 'add', 'a.txt', 'cfg/x.txt']).status, 0);
  fs.rmSync(path.join(project, 'cfg'), { recursive: true });
  fs.symlinkSync(path.join(outside, 'sub'), path.join(project, 'cfg'));
  const packed = await sendproject.pack(project);
  assert.deepStrictEqual(Object.keys(packed.manifest), ['a.txt']);
});

test('applying a task (dry run) and size hashes: a path through a folder link is not used', async () => {
  const { base, project, outside } = place();
  fs.symlinkSync(outside, path.join(project, 'link'));
  fs.mkdirSync(path.join(project, '.ssh'));
  write(path.join(project, '.ssh', 'id_x'), 'key');
  fs.symlinkSync(path.join(project, '.ssh'), path.join(project, 'keys'));
  const stateDir = path.join(base, 'state');
  write(path.join(stateDir, 'sent', 'abcdef012345.json'), JSON.stringify({ dir: project, manifest: {} }));
  const list = async () => ({ kind: 'sent', state: 'idle', files: [{ path: 'link/new.txt', status: 'added' }, { path: 'b.txt', status: 'added' }] });
  const dry = await require('../lib/remotework').applyTask(list, { task: 'abcdef012345', stateDir, dryRun: true });
  assert.deepStrictEqual(dry.wouldApply, ['b.txt (added)']);
  assert.deepStrictEqual(dry.failed, [{ path: 'link/new.txt', why: 'outside the project (through a link)' }]);
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps' });
  const { shas } = await tasks.projectFiles({ cwd: project }, '', 0, ['a.txt', 'keys/id_x', 'link/sub/x.txt']);
  assert.deepStrictEqual([typeof shas['a.txt'], shas['keys/id_x'], shas['link/sub/x.txt']], ['string', null, null]);
});
