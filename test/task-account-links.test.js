'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5274';
// Sol H5, H6: root never writes in the task account's folders itself. The account owns them, so it
// could put a link there that leads to a file of root's. Folders, the hooks' key, the plugin copy and
// a sent project's workspace are written by commands run as the account (runuser).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const taskuser = require('../lib/taskuser');

function fakeAccount() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-acct-links-'));
  const home = path.join(base, 'home');
  const victim = path.join(base, 'root-only');
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'secret'), 'keep');
  const a = {
    name: 'editlens', uid: process.getuid ? process.getuid() : 1000, gid: process.getgid ? process.getgid() : 1000, home,
    workspaces: path.join(home, taskuser.WORKSPACES), stateDir: path.join(home, taskuser.TASK_STATE),
  };
  fs.mkdirSync(a.stateDir, { recursive: true });
  // What the account could leave there: its key file and its workspaces folder as links.
  fs.symlinkSync(path.join(victim, 'secret'), path.join(a.stateDir, 'token-5274'));
  fs.symlinkSync(victim, a.workspaces);
  return { a, base, victim };
}

test('H5: setting up the account runs every write as the account and follows none of its links', () => {
  const { a, base, victim } = fakeAccount();
  const calls = [];
  const run = (cmd, args, opts) => {
    calls.push({ cmd, args, input: opts && opts.input });
    return { status: 0, stdout: Buffer.from('tar'), stderr: Buffer.alloc(0) };
  };
  const plugin = path.join(base, 'plugin-src');
  fs.mkdirSync(path.join(plugin, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(plugin, 'bin', 'x.js'), '');
  const out = taskuser.prepare(a, { port: 5274, token: 'k'.repeat(48), pluginRoot: plugin, run });
  assert.strictEqual(fs.readFileSync(path.join(victim, 'secret'), 'utf8'), 'keep', 'the linked file is unchanged');
  assert.deepStrictEqual(fs.readdirSync(victim), ['secret'], 'nothing was made through the linked folder');
  const as = calls.filter((c) => c.cmd === 'runuser');
  for (const c of as) assert.deepStrictEqual(c.args.slice(0, 3), ['-u', 'editlens', '--']);
  const words = as.map((c) => c.args[3]);
  assert.ok(words.includes('mkdir') && words.includes('sh') && words.includes('rm') && words.includes('tar'), words.join(' '));
  assert.strictEqual(as.find((c) => c.args[3] === 'sh').input, 'k'.repeat(48), 'the key goes in through stdin');
  assert.ok(calls.some((c) => c.cmd === 'tar' && c.args[0] === '-c'), 'the plugin is packed as root and unpacked as the account');
  assert.deepStrictEqual(out, { token: 'k'.repeat(48), plugin: path.join(a.stateDir, 'plugin') });
  fs.rmSync(base, { recursive: true, force: true });
});

test('H5: a command that fails as the account is an error with a code (the caller reports it)', () => {
  const { a, base } = fakeAccount();
  const run = () => ({ status: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('mkdir: Permission denied') });
  assert.throws(() => taskuser.prepare(a, { port: 5274, run }), (err) => err.code === 'EACCOUNT' && /Permission denied/.test(err.message));
  fs.rmSync(base, { recursive: true, force: true });
});

test('H6: a sent project is unpacked in root\'s own folder and copied in as the account', async (t) => {
  process.env.EDITLENS_SDK_DIR = path.join(os.tmpdir(), 'editlens-no-sdk');
  const { Tasks } = require('../server/tasks');
  const sendproject = require('../lib/sendproject');
  const { a, base, victim } = fakeAccount();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const project = path.join(base, 'project');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>hi</h1>');
  const bundle = await sendproject.pack(project);
  const calls = [];
  const saved = taskuser.runAs;
  t.after(() => { taskuser.runAs = saved; });
  // The account's commands are recorded, not run (this test is not root).
  taskuser.runAs = async (acct, args, opts = {}) => {
    calls.push(args);
    if (opts.from) opts.from.resume();
    return { ok: true, out: '', err: '' };
  };
  const tasks = new Tasks({ stateDir: path.join(base, 'state'), host: 'vps', log: () => {}, account: () => ({ ...a, claude: '/bin/true', port: 5274 }), makeDriver: () => ({ start: async () => ({}), started: async () => ({}), send: () => ({ ok: true }), stop() {} }) });
  const pair = { id: 'p1', name: 'laptop', cwd: '/laptop/app' };
  await tasks.startSent(pair, 'abc123abc123', 'hi', null, () => {}, {}, { pairId: 'p1', parts: [bundle.bundle] });
  assert.deepStrictEqual(fs.readdirSync(victim), ['secret'], 'nothing was written through the linked workspaces folder');
  const words = calls.map((c) => c[0]);
  assert.ok(words.includes('mkdir') && words.includes('tar'), JSON.stringify(calls));
  assert.ok(!fs.existsSync(path.join(base, 'state', 'staging', 'abc123abc123')), 'root\'s own unpacked copy is removed');
});

test('the marker file in the account\'s home is written only when no name is there, a link included', () => {
  const { a, base, victim } = fakeAccount();
  fs.mkdirSync(a.home, { recursive: true });
  const marker = path.join(a.home, '.editlens-marker');
  fs.symlinkSync(path.join(victim, 'made-by-root'), marker);
  assert.strictEqual(taskuser.writeNew(marker, 'x'), false);
  assert.deepStrictEqual(fs.readdirSync(victim), ['secret']);
  fs.unlinkSync(marker);
  assert.strictEqual(taskuser.writeNew(marker, 'x'), true);
  assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'x');
  fs.rmSync(base, { recursive: true, force: true });
});
