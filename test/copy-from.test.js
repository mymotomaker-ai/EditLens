'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4333';
// copy_from_computer: plain files from a paired computer's own project, with no Claude run there.
// The host lists and reads (server/tasks.js); the laptop copies through an applies journal
// (lib/remotework.js), so undo_computer_task_apply puts the files back.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Tasks } = require('../server/tasks');
const { copyFrom, undoApply } = require('../lib/remotework');

// Every test's folders are in one, removed at the end.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-copy-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function setup() {
  const base = fs.mkdtempSync(path.join(root, 'set-'));
  const vps = path.join(base, 'vps');
  const laptop = path.join(base, 'laptop');
  for (const [rel, text] of [['pulse/index.html', '<h1>Pulse</h1>'], ['pulse/app.js', 'console.log(1)\n'], ['pulse/.env', 'KEY=secret'], ['pulse/node_modules/x/i.js', 'x'], ['README.md', 'hi']]) {
    fs.mkdirSync(path.dirname(path.join(vps, rel)), { recursive: true });
    fs.writeFileSync(path.join(vps, rel), text);
  }
  fs.mkdirSync(laptop, { recursive: true });
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'state-')), host: 'vps' });
  const pair = { cwd: vps };
  const calls = [];
  const call = async (op, body) => {
    calls.push(op);
    // As sent between the computers: JSON both ways (server/server.js taskRequest).
    const wire = JSON.parse(JSON.stringify(body));
    const res = op === 'project-files' ? await tasks.projectFiles(pair, wire.path, Number(wire.offset), wire.hash) : tasks.projectFile(pair, wire.path, Number(wire.offset));
    return JSON.parse(JSON.stringify(res));
  };
  return { base, vps, laptop, tasks, pair, call, calls, stateDir: path.join(base, 'laptop-state') };
}

test('a folder copies as plain files: keys and dependencies stay there, matching files are skipped', async () => {
  const { vps, laptop, call, calls, stateDir } = setup();
  const dry = await copyFrom(call, { from: 'pulse', dir: laptop, stateDir, computer: 'vps', dryRun: true });
  assert.deepStrictEqual(dry.wouldCopy.sort(), ['pulse/app.js', 'pulse/index.html']);
  assert.ok(!fs.existsSync(path.join(laptop, 'pulse')), 'a dry run writes nothing');
  const res = await copyFrom(call, { from: 'pulse', dir: laptop, stateDir, computer: 'vps' });
  assert.deepStrictEqual(res.copied.sort(), ['pulse/app.js', 'pulse/index.html']);
  assert.match(res.copy, /^[0-9a-f]{12}$/);
  assert.strictEqual(fs.readFileSync(path.join(laptop, 'pulse/index.html'), 'utf8'), '<h1>Pulse</h1>');
  assert.ok(!fs.existsSync(path.join(laptop, 'pulse/.env')) && !fs.existsSync(path.join(laptop, 'pulse/node_modules')));
  assert.ok(calls.every((op) => op === 'project-files' || op === 'project-file'), 'no task, no Claude run');
  // Again: everything matches, nothing is fetched.
  calls.length = 0;
  const again = await copyFrom(call, { from: 'pulse', dir: laptop, stateDir, computer: 'vps' });
  assert.deepStrictEqual([again.copied, again.same.sort(), calls.filter((op) => op === 'project-file')], [[], ['pulse/app.js', 'pulse/index.html'], []]);
  // A file changed here is a conflict unless overwrite; overwrite can be undone.
  fs.writeFileSync(path.join(laptop, 'pulse/app.js'), 'mine');
  fs.writeFileSync(path.join(vps, 'pulse/app.js'), 'theirs');
  const conflict = await copyFrom(call, { from: 'pulse/app.js', dir: laptop, stateDir, computer: 'vps' });
  assert.deepStrictEqual(conflict.conflicts.map((c) => c.path), ['pulse/app.js']);
  const over = await copyFrom(call, { from: 'pulse/app.js', dir: laptop, stateDir, computer: 'vps', overwrite: true });
  assert.strictEqual(fs.readFileSync(path.join(laptop, 'pulse/app.js'), 'utf8'), 'theirs');
  const undone = await undoApply({ stateDir, apply: over.copy });
  assert.ok(!undone.error, JSON.stringify(undone));
  assert.strictEqual(fs.readFileSync(path.join(laptop, 'pulse/app.js'), 'utf8'), 'mine');
  const twice = await undoApply({ stateDir, apply: over.copy });
  assert.ok(twice.already && /Already undone/.test(twice.note), JSON.stringify(twice));
});

test('no path is an error, not the whole project; "." is the whole project', async () => {
  const { laptop, call, stateDir } = setup();
  for (const from of [undefined, '', '  ', 5]) assert.match((await copyFrom(call, { from, dir: laptop, stateDir, dryRun: true })).error, /Give "path"/);
  const all = await copyFrom(call, { from: '.', dir: laptop, stateDir, dryRun: true });
  assert.deepStrictEqual(all.wouldCopy.sort(), ['README.md', 'pulse/app.js', 'pulse/index.html']);
});

test('the paired computer stops partway: the copy stops immediately and says how far it got', async () => {
  const { laptop, call, stateDir } = setup();
  let reads = 0;
  const flaky = async (op, body) => {
    if (op === 'project-file' && ++reads > 1) return { error: "Can't connect to vps: 1.2.3.4:4318 is not answering." };
    return call(op, body);
  };
  const out = await copyFrom(flaky, { from: '.', dir: laptop, stateDir, computer: 'vps' });
  assert.match(out.error, /^Copied 1 of 3 files, then the link stopped: Can't connect to vps.*Run it again.*copy id [0-9a-f]{12}/);
  assert.strictEqual(reads, 2, 'no more tries after the link stopped');
});

test('a copy goes where "to" says; paths outside the project and secret files are refused', async () => {
  const { laptop, call, stateDir } = setup();
  const one = await copyFrom(call, { from: 'pulse/index.html', to: 'public/pulse.html', dir: laptop, stateDir });
  assert.deepStrictEqual(one.copied, ['public/pulse.html']);
  const folder = await copyFrom(call, { from: 'pulse', to: 'apps', dir: laptop, stateDir });
  assert.deepStrictEqual(folder.copied.sort(), ['apps/pulse/app.js', 'apps/pulse/index.html']);
  assert.match((await copyFrom(call, { from: '../etc/passwd', dir: laptop, stateDir })).error, /relative/);
  assert.match((await copyFrom(call, { from: 'pulse/.env', dir: laptop, stateDir })).error, /never copied/);
  assert.match((await copyFrom(call, { from: 'nope', dir: laptop, stateDir })).error, /does not exist/);
});

test('listing reads no file for hashes unless asked: only same-size files are hashed, without blocking the server', async () => {
  const { vps, laptop, tasks, pair, call, stateDir } = setup();
  const big = Buffer.alloc(12 * 1024 * 1024, 7);
  for (const n of ['a.bin', 'b.bin', 'c.bin']) fs.writeFileSync(path.join(vps, 'pulse', n), big);
  // The event loop keeps running while the server hashes (it never reads 64 MB in one read).
  let ticks = 0;
  let spin = true;
  const turn = () => {
    ticks++;
    if (spin) setImmediate(turn);
  };
  setImmediate(turn);
  const all = await tasks.projectFiles(pair, 'pulse', 0);
  spin = false;
  assert.ok(all.files.filter((f) => f.sha).length >= 3, 'older computers still get hashes when they leave "hash" out');
  assert.ok(ticks > 3, `the server kept serving while it hashed (${ticks} turns)`);
  // hash: false lists sizes and reads nothing.
  const reads = [];
  const orig = fs.createReadStream;
  fs.createReadStream = (...a) => {
    reads.push(path.basename(a[0]));
    return orig.apply(fs, a);
  };
  try {
    const bare = await tasks.projectFiles(pair, 'pulse', 0, false);
    assert.ok(bare.files.every((f) => f.sha === null) && reads.length === 0, JSON.stringify(reads));
    // A copy asks only for the files whose size matches one here.
    fs.mkdirSync(path.join(laptop, 'pulse'), { recursive: true });
    fs.writeFileSync(path.join(laptop, 'pulse/a.bin'), big); // same file
    fs.writeFileSync(path.join(laptop, 'pulse/b.bin'), Buffer.alloc(big.length, 8)); // same size, other bytes
    fs.writeFileSync(path.join(laptop, 'pulse/c.bin'), 'short'); // other size
    const copied = await copyFrom(call, { from: 'pulse', dir: laptop, stateDir, dryRun: true });
    assert.deepStrictEqual(reads.sort(), ['a.bin', 'b.bin']);
    assert.deepStrictEqual(copied.same, ['pulse/a.bin']);
    assert.deepStrictEqual(copied.conflicts.map((c) => c.path).sort(), ['pulse/b.bin', 'pulse/c.bin']);
  } finally {
    fs.createReadStream = orig;
  }
  // Hash requests stay inside the project.
  const shas = (await tasks.projectFiles(pair, '', 0, ['pulse/a.bin', '../x', 'pulse/.env', 'nope'])).shas;
  assert.deepStrictEqual(Object.keys(shas).sort(), ['nope', 'pulse/a.bin']);
  assert.strictEqual(shas.nope, null);
  assert.match(shas['pulse/a.bin'], /^[0-9a-f]{64}$/);
});

test('a file that is deleted or can not be read during a listing is skipped, not the whole listing', async () => {
  const { tasks, pair } = setup();
  const lstat = fs.lstatSync;
  const stream = fs.createReadStream;
  fs.lstatSync = (p, ...rest) => {
    if (path.basename(String(p)) === 'app.js') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    return lstat(p, ...rest);
  };
  fs.createReadStream = (p, ...rest) => {
    if (path.basename(String(p)) === 'index.html') throw Object.assign(new Error('no'), { code: 'EACCES' });
    return stream(p, ...rest);
  };
  try {
    const res = await tasks.projectFiles(pair, '.', 0);
    assert.ok(!res.error, JSON.stringify(res));
    assert.deepStrictEqual(res.files.map((f) => f.path), ['README.md']);
    assert.deepStrictEqual(res.skipped.map((s) => `${s.path} ${s.why}`).sort(), ['pulse/app.js ENOENT', 'pulse/index.html EACCES']);
  } finally {
    fs.lstatSync = lstat;
    fs.createReadStream = stream;
  }
});

test('a file removed or locked just before its page is read: said plainly, not an exception', () => {
  const { tasks, pair } = setup();
  const open = fs.openSync;
  fs.openSync = (p, ...rest) => {
    if (path.basename(String(p)) === 'app.js') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    if (path.basename(String(p)) === 'index.html') throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    return open(p, ...rest);
  };
  try {
    assert.deepStrictEqual(tasks.projectFile(pair, 'pulse/app.js', 0), { path: 'pulse/app.js', missing: true });
    assert.deepStrictEqual(tasks.projectFile(pair, 'pulse/index.html', 0), { error: 'EBUSY' });
  } finally {
    fs.openSync = open;
  }
  const page = tasks.projectFile(pair, 'README.md', 0);
  assert.strictEqual(Buffer.from(page.data, 'base64').toString(), 'hi');
});
