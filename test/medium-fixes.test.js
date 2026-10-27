'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4345';
// The medium findings of the 0.21.0 review (M1-M12) that a unit test can check.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-medium-'));
process.env.EDITLENS_SDK_DIR = path.join(base, 'no-sdk');
const wt = require('../lib/worktree');
const { Tasks } = require('../server/tasks');
const { Connector } = require('../server/connector');
const { PairHost } = require('../server/pair-host');
const { SshTunnel } = require('../server/ssh-tunnel');
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}
function gitProject(name) {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.com');
  sh(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\nb\nc\nd\ne\nf\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'start');
  return root;
}

test('M1: a merge for another computer takes only files nobody changed here', async () => {
  const root = gitProject('m1');
  const ws = wt.create(root, 'editlens-task-m1');
  fs.writeFileSync(path.join(ws.dir, 'a.txt'), 'a (task)\nb\nc\nd\ne\nf\n');
  fs.writeFileSync(path.join(ws.dir, 'b.txt'), 'b (task)\n');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\nb\nc\nd\ne\nf (mine)\n'); // the user's own edit
  const res = await wt.merge(root, 'editlens-task-m1', { cleanOnly: true });
  assert.deepStrictEqual(res.applied.map((a) => a.relFile), ['b.txt']);
  assert.deepStrictEqual(res.conflicts, ['a.txt']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'a\nb\nc\nd\ne\nf (mine)\n', 'the user\'s file is untouched');
});

test('M2: page control from a paired computer follows "Paired computers can run Claude here"', async () => {
  const host = new PairHost({ stateDir: path.join(base, 'm2'), port: 0, httpServer: null, siteOf: () => null, version: 'x', livePort: 1, log: () => {}, runsAllowed: () => false });
  const lines = [];
  const socket = { write: (t) => lines.push(String(t)), end: () => {} };
  host.control(socket, { cwd: base, name: 'laptop' }, { args: [] });
  const out = JSON.parse(lines.join('').trim());
  assert.strictEqual(out.ok, false);
  assert.match(out.text, /turned off/);
});

test('M3: after a restart a task still knows how many replies it had', () => {
  const dir = path.join(base, 'm3');
  fs.mkdirSync(dir);
  const t = { id: 'aaaaaaaaaaaa', by: 'laptop', pairId: 'p', cwd: base, dir: base, prompt: 'x', state: 'idle', startedAt: 1, updatedAt: 1 };
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tasks: [{ ...t, replies: ['r6', 'r7', 'r8', 'r9', 'r10'], replyCount: 10 }] }));
  let tasks = new Tasks({ stateDir: dir, host: 'vps' });
  let one = tasks.items.get(t.id);
  assert.strictEqual(one.replyCount, 10);
  assert.deepStrictEqual(tasks.report(one, 8).replies, ['r9', 'r10']);
  tasks.save();
  assert.strictEqual(new Tasks({ stateDir: dir, host: 'vps' }).items.get(t.id).replyCount, 10, 'saved');
  // A file from before 0.22.3 (no count): the kept replies, never a negative skip.
  fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tasks: [{ ...t, replies: ['r1', 'r2'] }] }));
  tasks = new Tasks({ stateDir: dir, host: 'vps' });
  one = tasks.items.get(t.id);
  assert.strictEqual(one.replyCount, 2);
  assert.deepStrictEqual(tasks.report(one, 0).replies, ['r1', 'r2']);
  assert.deepStrictEqual(tasks.report(one, Number.NaN).replies, ['r1', 'r2']);
});

test('M4: a task card on a page includes no file text', () => {
  const tasks = new Tasks({ stateDir: path.join(base, 'm4'), host: 'vps' });
  const t = { id: 'bbbbbbbbbbbb', replies: [], permissions: new Map([['q1', { id: 'q1', tool: 'Write', title: 'Write a.txt', detail: 'a.txt', diff: 'SECRET', preview: 'SECRET', canAlways: true, ts: 1 }]]) };
  const card = tasks.card(t);
  assert.doesNotMatch(JSON.stringify(card), /SECRET/);
  assert.deepStrictEqual([card.permissions[0].id, card.permissions[0].title, card.permissions[0].canAlways], ['q1', 'Write a.txt', true]);
});

test('M5: no copy of a repository as big as the home folder; an unchanged copy goes with its task', async () => {
  const home = gitProject('m5home');
  const sub = path.join(home, 'project');
  fs.mkdirSync(sub);
  const was = process.env.HOME;
  process.env.HOME = home;
  try {
    assert.match(wt.create(sub, 'editlens-task-m5').error, /too big to copy/);
  } finally {
    process.env.HOME = was;
  }
  const root = gitProject('m5');
  const ws = wt.create(root, 'editlens-task-m5');
  const tasks = new Tasks({ stateDir: path.join(base, 'm5state'), host: 'vps', log: () => {} });
  assert.strictEqual(await tasks.dropCopy({ id: 'c', copy: ws.name, root: ws.root }), true);
  assert.strictEqual(fs.existsSync(ws.dir), false);
  const kept = wt.create(root, 'editlens-task-m5b');
  fs.writeFileSync(path.join(kept.dir, 'b.txt'), 'changed\n');
  assert.strictEqual(await tasks.dropCopy({ id: 'd', copy: kept.name, root: kept.root }), false, 'unmerged changes stay');
  assert.ok(fs.existsSync(kept.dir));
});

test('M6: two connects at the same time start one proxy', async () => {
  const dir = path.join(base, 'm6');
  fs.mkdirSync(dir);
  const dev = http.createServer((req, res) => res.end('<title>x</title>'));
  await new Promise((r) => dev.listen(0, '127.0.0.1', r));
  const c = new Connector({ stateDir: path.join(base, 'm6state'), livePort: 4317 });
  try {
    const target = `http://127.0.0.1:${dev.address().port}`;
    const [a, b] = await Promise.all([c.connect({ cwd: dir, target }), c.connect({ cwd: dir, target })]);
    assert.ok(a.ok && b.ok, JSON.stringify([a, b]));
    assert.strictEqual(a.url, b.url);
    assert.strictEqual(b.already, true);
    assert.strictEqual(c.items.size, 1);
  } finally {
    await c.stopAll();
    dev.close();
  }
});

test('M7: the copy check says when git is too slow', () => {
  assert.deepStrictEqual(wt.copyCheck(path.join(base, 'nowhere')), { ok: false, why: 'not git' });
  assert.strictEqual(wt.copyCheck(gitProject('m7'), { timeoutMs: 2000 }).ok, true);
  assert.strictEqual(wt.copyCheck(path.join(base, 'm7', '.claude', 'worktrees', 'x')).why, 'inside a copy');
});

test('M12: a tunnel left running on the saved port is used again, and not used if it fails', async () => {
  const left = net.createServer((s) => s.destroy());
  await new Promise((r) => left.listen(0, '127.0.0.1', r));
  const port = left.address().port;
  process.env.EDITLENS_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
  const t = new SshTunnel({ user: 'me', host: '127.0.0.1', remotePort: 1, localPort: port }, () => {});
  try {
    assert.strictEqual(await t.ensure(), port);
    assert.strictEqual(t.child, null, 'no second ssh');
    t.distrust();
    const fresh = await t.ensure();
    assert.notStrictEqual(fresh, port, 'a new tunnel on a free port');
    assert.ok(t.child, 'its own ssh');
  } finally {
    t.close();
    left.close();
    delete process.env.EDITLENS_SSH;
  }
});
