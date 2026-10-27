'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5303';
// /editlens task-user marks the editlens account as made by EditLens only when it made it, so
// "off" removes only that account. An account made manually is turned off for EditLens and kept.
// Every account command here is a stand-in in a folder that is the whole PATH, and the account is
// looked up in a passwd file of this test (test/isolate.js): no real account is made or removed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const taskuser = require('../lib/taskuser');

const BIN = path.join(__dirname, '..', 'bin', 'taskuser.js');
const PASSWD = process.env.EDITLENS_TEST_PASSWD;
const STATE = process.env.EDITLENS_STATE_DIR;
const ROOT_LINE = 'root:x:0:0:root:/root:/bin/bash\n';

// Stand-ins for id, useradd, userdel, passwd and runuser: each logs its call; useradd and userdel
// change only the test's passwd file. runuser answers "signed in" for Claude's auth status.
const STUBS = {
  id: "process.exit(fs.readFileSync(P, 'utf8').includes('\\neditlens:') ? 0 : 1);",
  useradd: "fs.appendFileSync(P, `editlens:x:1500:1500::${process.env.STUB_HOME}:/bin/bash\\n`); fs.mkdirSync(process.env.STUB_HOME, { recursive: true });",
  userdel: "fs.writeFileSync(P, fs.readFileSync(P, 'utf8').split('\\n').filter((l) => !l.startsWith('editlens:')).join('\\n'));",
  passwd: '',
  runuser: "if (process.argv.includes('status')) process.stdout.write('{\"loggedIn\":true}');",
};

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-taskuser-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stubs = path.join(dir, 'stubs');
  fs.mkdirSync(stubs);
  const log = path.join(dir, 'calls.log');
  for (const [name, body] of Object.entries(STUBS)) {
    const src = `#!${process.execPath}\n'use strict';\nconst fs = require('fs');\nconst P = process.env.EDITLENS_TEST_PASSWD;\n`
      + `fs.appendFileSync(process.env.STUB_LOG, ${JSON.stringify(name)} + ' ' + process.argv.slice(2).join(' ') + '\\n');\n${body}\n`;
    fs.writeFileSync(path.join(stubs, name), src, { mode: 0o755 });
  }
  // Runs as if root on Linux, so the command does its work, with only the stand-ins to call.
  const preload = path.join(dir, 'as-root.js');
  fs.writeFileSync(preload, "process.getuid = () => 0;\nObject.defineProperty(process, 'platform', { value: 'linux' });\n");
  const home = path.join(dir, 'home', 'editlens');
  const run = (...args) => {
    const r = spawnSync(process.execPath, ['--require', preload, BIN, ...args], {
      encoding: 'utf8', timeout: 60000,
      env: { PATH: stubs, EDITLENS_TEST_PASSWD: PASSWD, EDITLENS_STATE_DIR: STATE, EDITLENS_PORT: '5303', EDITLENS_NO_START: '1',
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: dir, STUB_LOG: log, STUB_HOME: home },
    });
    assert.strictEqual(r.error, undefined);
    return r.stdout + r.stderr;
  };
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '');
  const byHand = () => {
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '');
    fs.writeFileSync(PASSWD, `${ROOT_LINE}editlens:x:1500:1500::${home}:/bin/bash\n`);
  };
  return { dir, home, run, calls, byHand };
}

const inUse = () => taskuser.account({ uid: 0, platform: 'linux', passwd: PASSWD, stateDir: STATE });

test('an account made manually: set up leaves no made-by mark, and off keeps the account', () => {
  const t = setup();
  t.byHand();
  try {
    t.run();
    assert.ok(!fs.existsSync(path.join(t.home, '.editlens-account')), 'no made-by mark on an account made manually');
    assert.doesNotMatch(t.calls(), /^useradd/m);
    assert.ok(inUse() && !inUse().error, 'tasks run as it');
    const out = t.run('off', '--force');
    assert.doesNotMatch(t.calls(), /^userdel/m, 'never removed');
    assert.ok(taskuser.lookup('editlens', PASSWD), 'the account is still there');
    assert.match(out, /made manually/);
    assert.match(out, /sudo userdel -r editlens/);
    assert.strictEqual(inUse(), null, 'off for EditLens: tasks no longer run as it');
    assert.match(t.run('status'), /off/i);
    t.run();
    assert.ok(inUse() && !inUse().error, 'running the setup again enables it');
  } finally {
    fs.writeFileSync(PASSWD, ROOT_LINE);
  }
});

test('an account an older version marked "Now used by": off keeps it too', () => {
  const t = setup();
  t.byHand();
  try {
    fs.writeFileSync(path.join(t.home, '.editlens-account'), 'Now used by /editlens task-user. /editlens task-user off removes this account and its home.\n');
    const out = t.run('off', '--force');
    assert.doesNotMatch(t.calls(), /^userdel/m, 'never removed');
    assert.match(out, /made manually/);
  } finally {
    fs.writeFileSync(PASSWD, ROOT_LINE);
  }
});

test('an account the command made: marked, and off removes it', () => {
  const t = setup();
  try {
    fs.writeFileSync(PASSWD, ROOT_LINE);
    fs.mkdirSync(path.join(t.home, '.local', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(t.home, '.local', 'bin', 'claude'), '');
    t.run();
    assert.match(t.calls(), /^useradd /m);
    assert.match(fs.readFileSync(path.join(t.home, '.editlens-account'), 'utf8'), /^Made by \/editlens task-user\./);
    const out = t.run('off', '--force');
    assert.match(t.calls(), /^userdel -r editlens$/m);
    assert.match(out, /Removed the editlens account/);
    assert.strictEqual(taskuser.lookup('editlens', PASSWD), null);
  } finally {
    fs.writeFileSync(PASSWD, ROOT_LINE);
  }
});

test('the server reads the same "off" when it picks the task account', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  const calls = [...src.matchAll(/taskuser\.account\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 1);
  for (const args of calls) assert.match(args, /stateDir: config\.stateDir/);
});

test('after off on an account made manually, /editlens pair says tasks run as root again', { skip: process.platform !== 'linux' }, () => {
  const t = setup();
  t.byHand();
  const { rootNote } = require('../bin/pair');
  const getuid = process.getuid;
  process.getuid = () => 0;
  try {
    t.run();
    assert.strictEqual(rootNote(), null, 'the account is in use');
    t.run('off', '--force');
    assert.ok(taskuser.lookup('editlens', PASSWD), 'the account is still there');
    assert.strictEqual(rootNote(), 'account', 'tasks run as root, so pair says so');
  } finally {
    process.getuid = getuid;
    fs.writeFileSync(PASSWD, ROOT_LINE);
  }
});

// Settings check S7 (0.24.45): with Root (unsafe) allowed, /editlens pair warns that tasks run as
// root even though the editlens account is there.
test('S7: /editlens pair warns when Root (unsafe) is on', { skip: process.platform !== 'linux' }, () => {
  const t = setup();
  t.byHand();
  const { rootNote } = require('../bin/pair');
  const getuid = process.getuid;
  const file = path.join(STATE, 'task-root.json');
  process.getuid = () => 0;
  process.env.CLAUDE_PLUGIN_OPTION_TASK_ACCOUNT = 'Root (unsafe)';
  try {
    t.run();
    assert.strictEqual(rootNote(), null, 'the account is in use, Root (unsafe) not allowed yet');
    fs.writeFileSync(file, JSON.stringify({ on: true, at: Date.now() }));
    assert.strictEqual(rootNote(), 'root', 'Root (unsafe) is on: tasks run as root');
    process.env.CLAUDE_PLUGIN_OPTION_TASK_ACCOUNT = 'Auto';
    assert.strictEqual(rootNote(), null, 'the setting is back to Auto, so the file no longer counts');
  } finally {
    process.getuid = getuid;
    delete process.env.CLAUDE_PLUGIN_OPTION_TASK_ACCOUNT;
    fs.rmSync(file, { force: true });
    fs.writeFileSync(PASSWD, ROOT_LINE);
  }
});
