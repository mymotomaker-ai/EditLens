'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4942';
// Controls check, terminal side: the port read the same way everywhere, the mod applying only
// page-editable settings, the Settings pane never moving to a less strict value in one press,
// the status line on odd input, the safety check on big files, help topics, stop words, and
// /editlens <address> while connected.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = require('../lib/config');
const settings = require('../lib/settings');
const { topicOf } = require('../lib/help');
const { Connector } = require('../server/connector');
const mod = () => import(path.join(ROOT, 'hooks', 'mod.mjs'));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-term-'));

test('the port: digits only, 1-65535, and the mod picks the same one as lib/config.js', async () => {
  const m = await mod();
  for (const [raw, want] of [['4705', 4705], [' 4705 ', 4705], ['4705x', null], ['4705.9', null], ['1e3', null], ['0x10', null], ['0', null], ['70000', null], ['-1', null], ['', null], [undefined, null], [4720.5, null], [4720, 4720]]) {
    assert.strictEqual(config.strictInt(raw, 1, 65535), want, `config ${raw}`);
    assert.strictEqual(m.strictInt(raw, 1, 65535), want, `mod ${raw}`);
  }
  // EDITLENS_PORT takes precedence when valid; else the Port setting; else 4317.
  assert.strictEqual(m.portFrom('70000', 4720), 4720);
  assert.strictEqual(m.portFrom('4705x', 4720), 4720);
  assert.strictEqual(m.portFrom('1e3', undefined), 4317);
  assert.strictEqual(m.portFrom('4941', 4720), 4941);
  assert.strictEqual(m.portFrom(undefined, 4720.5), 4317);
  assert.strictEqual(m.portFrom(undefined, 80), 4317, 'the Port setting starts at 1024');
  // The hooks' resolution, run with the same values.
  const portWith = (env) => spawnSync(process.execPath, ['-e', 'process.stdout.write(String(require("./lib/config").port))'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, EDITLENS_PORT: '', CLAUDE_PLUGIN_OPTION_PORT: '', ...env } }).stdout;
  assert.strictEqual(portWith({ EDITLENS_PORT: '70000', CLAUDE_PLUGIN_OPTION_PORT: '4720' }), '4720');
  assert.strictEqual(portWith({ EDITLENS_PORT: '4705x', CLAUDE_PLUGIN_OPTION_PORT: '4720' }), '4720');
  assert.strictEqual(portWith({ EDITLENS_PORT: '1e3' }), '4317');
  assert.strictEqual(portWith({ CLAUDE_PLUGIN_OPTION_PORT: '4720.5' }), '4317');
  assert.strictEqual(m.settingValue(settings.SCHEMA.port, '0x1100'), 4317, 'text is digits only');
});

test('the mod makes only the changes the page may make', async () => {
  const m = await mod();
  assert.deepStrictEqual(m.PAGE_EDITABLE, settings.PAGE_EDITABLE, 'the copy in the mod matches lib/settings.js');
  const list = [
    { id: 1, key: 'safety_check', value: false },
    { id: 2, key: 'permission_mode', value: "Don't ask" },
    { id: 3, key: 'task_account', value: 'Root (unsafe)' },
    { id: 4, key: 'port', value: 4999 },
    { id: 5, key: 'remote_tasks', value: true },
    { id: 6, key: 'theme', value: 'Dark' },
    { id: 7, key: 'wait', value: true },
    null, 'x', { key: 'theme', value: 'Light' }, { id: 8, key: { k: 1 }, value: 1 },
  ];
  assert.deepStrictEqual(m.pendingToApply(list, new Set()).map((p) => p.id), [6, 7]);
  assert.deepStrictEqual(m.pendingToApply(list, new Set([6])).map((p) => p.id), [7], 'each request once');
  assert.deepStrictEqual(m.pendingToApply({ length: 1 }, new Set()), []);
});

test('the Settings pane never moves to a less strict value in one press', async () => {
  const m = await mod();
  const S = settings.SCHEMA;
  // Option settings skip the values that allow more; those are picked in /config.
  let v = 'Ask';
  const seen = [];
  for (let i = 0; i < 10; i++) {
    v = m.nextValue(S.permission_mode, v, 'permission_mode');
    seen.push(v);
  }
  assert.ok(!seen.includes("Don't ask"), seen.join(', '));
  assert.strictEqual(m.nextValue(S.permission_mode, 'Auto', 'permission_mode'), 'Ask');
  assert.strictEqual(m.nextValue(S.permission_mode, "Don't ask", 'permission_mode'), 'Ask', 'from Don\'t ask, a press makes it stricter');
  assert.strictEqual(m.nextValue(S.task_account, 'Auto', 'task_account'), undefined, 'Root (unsafe) is never one press away');
  assert.strictEqual(m.nextValue(S.task_account, 'Root (unsafe)', 'task_account'), 'Auto');
  assert.strictEqual(m.nextValue(S.theme, 'Dark', 'theme'), 'Auto');
  assert.match(m.paneNote('permission_mode', 'Ask'), /Don't ask is chosen in \/config\./);
  assert.match(m.paneNote('task_account', undefined), /\/config/);
  // On/off values that allow more take a second press within CONFIRM_MS.
  assert.strictEqual(m.pressAction('safety_check', false, null, 1000), 'confirm');
  assert.strictEqual(m.pressAction('safety_check', false, { key: 'safety_check', value: false, at: 1000 }, 2000), 'change');
  assert.strictEqual(m.pressAction('safety_check', false, { key: 'safety_check', value: false, at: 1000 }, 1000 + m.CONFIRM_MS), 'confirm', 'too late: asks again');
  assert.strictEqual(m.pressAction('safety_check', false, { key: 'remote_tasks', value: false, at: 1000 }, 2000), 'confirm');
  assert.strictEqual(m.pressAction('safety_check', true, null, 1000), 'change', 'turning it on again needs one press');
  assert.strictEqual(m.pressAction('remote_tasks', true, null, 1000), 'confirm');
  assert.strictEqual(m.pressAction('remote_tasks', false, null, 1000), 'change');
  assert.strictEqual(m.pressAction('highlight', false, null, 1000), 'change');
});

function statusLine(input, args = [], env = {}) {
  const dir = tmp();
  try {
    return spawnSync(process.execPath, [path.join(ROOT, 'bin', 'statusline.js'), ...args], {
      input, encoding: 'utf8', env: { ...process.env, EDITLENS_STATE_DIR: dir, EDITLENS_PORT: '1', ...env },
    }).stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const plain = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

test('the status line on null input, out-of-range numbers and control characters', () => {
  for (const input of ['null', '123', '"str"', '[]']) {
    const out = statusLine(input);
    assert.doesNotMatch(out, /error/i, input);
    assert.match(plain(out), /✦ live/, input);
  }
  const out = plain(statusLine(JSON.stringify({ model: { display_name: 'Op\u001b[31mus\nX' }, rate_limits: { five_hour: { used_percentage: -3 } }, cost: { total_cost_usd: -1e21 } })));
  assert.strictEqual(out.split('\n').filter(Boolean).length, 1, 'one line');
  assert.match(out, /^Opus X /);
  assert.match(out, /5h 0%/);
  assert.doesNotMatch(out, /\$-|e\+21/);
  assert.match(plain(statusLine(JSON.stringify({ cost: { total_cost_usd: -1 } }))), /^✦ live/, 'a negative cost is not shown');
  assert.match(plain(statusLine(JSON.stringify({ rate_limits: { five_hour: { used_percentage: 250 } } }))), /5h 100%/);
  assert.match(plain(statusLine('{}', ['--then', 'editlens-missing-cmd-xyz'])), /✦ live \(status line after --then failed: exit \d+\)/);
  assert.strictEqual(statusLine('{}', ['--then', 'echo hi']), 'hi\n');
  // A status larger than a pipe buffer (64 KB): the command ends before reading it, and the write fails.
  const big = JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) });
  assert.match(plain(statusLine(big, ['--then', 'editlens-missing-cmd-xyz'])), /✦ live \(status line after --then failed: exit \d+\)/);
  assert.strictEqual(statusLine(big, ['--then', 'echo hi']), 'hi\n');
});

test('the safety check asks about a Write that empties a file too big to compare', () => {
  const dir = tmp();
  const saved = { g: process.env.EDITLENS_GUARD, s: process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK };
  delete process.env.EDITLENS_GUARD;
  delete process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK;
  const guard = require('../lib/guard');
  try {
    fs.writeFileSync(path.join(dir, 'big.js'), 'const a = 1;\n'.repeat(120000)); // about 1.5 MB
    const v = guard.check('Write', { file_path: 'big.js', content: 'x = 1' }, dir);
    assert.ok(v && v.kind === 'replace', JSON.stringify(v));
    assert.match(v.reason, /big\.js \(1\.\d MB\) with 5 bytes/);
    assert.strictEqual(guard.check('Write', { file_path: 'big.js', content: 'y'.repeat(1200000) }, dir), null, 'most of the size stays');
    assert.strictEqual(guard.check('Edit', { file_path: 'big.js', old_string: 'a', new_string: 'b' }, dir), null);
    for (const off of ['off', 'OFF', '0', 'false', 'No']) {
      process.env.EDITLENS_GUARD = off;
      assert.strictEqual(guard.check('Write', { file_path: 'big.js', content: 'x' }, dir), null, off);
    }
    process.env.EDITLENS_GUARD = 'maybe';
    assert.ok(guard.check('Write', { file_path: 'big.js', content: 'x' }, dir), 'an unknown word keeps it on');
  } finally {
    if (saved.g === undefined) delete process.env.EDITLENS_GUARD;
    else process.env.EDITLENS_GUARD = saved.g;
    if (saved.s !== undefined) process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK = saved.s;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('help topics: ports and addresses, several words, and unknown ones', () => {
  assert.strictEqual(topicOf(''), '');
  assert.strictEqual(topicOf('5173'), '3000');
  assert.strictEqual(topicOf('http://localhost:5173'), '3000');
  assert.strictEqual(topicOf('join off'), 'join');
  assert.strictEqual(topicOf('Pair'), 'pair');
  assert.strictEqual(topicOf('/editlens stop'), 'stop');
  assert.strictEqual(topicOf('bogus'), null);
  const out = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), 'help', 'bogus'], { encoding: 'utf8', env: { ...process.env, EDITLENS_SAY: '' } }).stdout;
  assert.match(out, /no help for "bogus"/);
  assert.match(out, /Everyday/);
});

test('stop and status with no server: no server starts, and unknown words are said', () => {
  const dir = tmp();
  const env = { ...process.env, EDITLENS_SAY: '', EDITLENS_STATE_DIR: path.join(dir, 'state'), EDITLENS_PORT: '1', CLAUDE_PROJECT_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { encoding: 'utf8', env, timeout: 20000 });
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<p>\n<!-- editlens:start -->\n<script src="http://127.0.0.1:4317/live.js"></script>\n');
    const stop = run('stop');
    assert.strictEqual(stop.status, 0, stop.stdout + stop.stderr);
    assert.match(stop.stdout, /EditLens isn't running/);
    assert.doesNotMatch(stop.stdout, /stop remove/, 'stop remove skips a block with no end line, so it is not offered');
    assert.match(stop.stdout, /Add the editlens:end line to index\.html/);
    assert.match(run('STOP').stdout, /EditLens isn't running/);
    // stop <name> stops a session by its name (/editlens sessions): with no server, none runs.
    const foo = run('stop', 'foo');
    assert.strictEqual(foo.status, 1);
    assert.match(foo.stdout, /EditLens isn't running, so no session is running here/);
    assert.match(foo.stdout, /! Fix {2}Run \/editlens to start it/);
    assert.match(run('status').stdout, /EditLens isn't running/);
    assert.ok(!fs.existsSync(path.join(dir, 'state', 'server-1.log')), 'no server was started');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/editlens settings says what is in effect', () => {
  const out = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), 'settings'], {
    encoding: 'utf8', env: { ...process.env, EDITLENS_SAY: '', EDITLENS_PORT: '4941', EDITLENS_GUARD: 'OFF', CLAUDE_PLUGIN_OPTION_THEME: 'Purple', CLAUDE_PLUGIN_OPTION_PORT: '' },
  }).stdout;
  assert.match(out, /port 4941: EDITLENS_PORT overrides the Port setting \(4317\)/);
  assert.match(out, /safety check is off: EDITLENS_GUARD=OFF/);
  assert.match(out, /"Purple" is not a valid value/);
});

test('server errors are shown as words, not JSON', () => {
  const { errorText } = require('../bin/connect');
  assert.strictEqual(errorText(new Error('server answered 400: {"error":"missing name"}')), 'missing name');
  assert.strictEqual(errorText(new Error('plain words')), 'plain words');
});

test('/editlens <address> while connected: another address replaces the connection; EditLens\'s own ports are refused', async () => {
  const dir = tmp();
  const devs = [];
  for (let i = 0; i < 2; i++) {
    const dev = http.createServer((req, res) => res.end('<title>x</title>'));
    await new Promise((r) => dev.listen(0, '127.0.0.1', r));
    devs.push(dev);
  }
  const c = new Connector({ stateDir: path.join(dir, 'state'), livePort: 4317, pairPort: 4318 });
  try {
    const [a, b] = devs.map((d) => `http://localhost:${d.address().port}`);
    const first = await c.connect({ cwd: dir, target: a });
    assert.ok(first.ok, JSON.stringify(first));
    const same = await c.connect({ cwd: dir, target: a });
    assert.strictEqual(same.already, true);
    assert.strictEqual((await c.connect({ cwd: dir })).already, true, 'no address: the connection stays');
    const other = await c.connect({ cwd: dir, target: b });
    assert.ok(other.ok && !other.already, JSON.stringify(other));
    assert.strictEqual(other.target, b.replace('localhost', '127.0.0.1'));
    assert.strictEqual(c.items.size, 1);
    const bad = await c.connect({ cwd: dir, target: 'http://localhost:99999' });
    assert.match(bad.error, /is not an address/);
    assert.strictEqual(c.list()[0].target, other.target, 'a bad address leaves the connection as it was');
    assert.match((await c.connect({ cwd: dir, target: 'http://localhost:4317' })).error, /EditLens's own port/);
    assert.match((await c.connect({ cwd: dir, target: '127.0.0.1:4318' })).error, /EditLens's own port/);
    const proxyPort = new URL(other.url).port;
    assert.match((await c.connect({ cwd: dir, target: `http://localhost:${proxyPort}` })).error, /address EditLens gives your page/);
  } finally {
    await c.stopAll();
    for (const d of devs) d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pairing words in any case', () => {
  const { pairWords } = require('../bin/pair');
  assert.deepStrictEqual(pairWords(['Pair', 'off']), { first: 'Pair', word: 'pair', rest: ['off'] });
  assert.strictEqual(pairWords(['JOIN']).word, 'join');
  assert.strictEqual(pairWords([' Control ', 'nobody']).word, 'control');
  assert.deepStrictEqual(pairWords([]), { first: '', word: '', rest: [] });
});

test('join: a flag with no value is an error, not part of the code', () => {
  const { joinArgs } = require('../bin/pair');
  assert.throws(() => joinArgs(['127.0.0.1', 'ABC', '--ssh-port']), /--ssh-port needs a port number/);
  assert.throws(() => joinArgs(['127.0.0.1', 'ABC', '-p']), /-p needs a port number/);
  assert.throws(() => joinArgs(['127.0.0.1', 'ABC', '--key']), /--key needs a key file/);
  assert.throws(() => joinArgs(['127.0.0.1', 'ABC', '--ssh-port', '22x']), /takes a port number/);
  assert.throws(() => joinArgs(['127.0.0.1', 'ABC', '--ssh-port', '70000']), /takes a port number/);
  const ok = joinArgs(['u@host', 'ABC', 'DEF', '--ssh-port', '2222', '--key', '/k']);
  assert.deepStrictEqual(ok, { opts: { key: path.resolve('/k'), sshPort: 2222 }, words: ['u@host', 'ABC', 'DEF'] });
  // The key line /editlens pair prints has the path in double quotes; the mod splits the typed
  // words at spaces, so a path with spaces comes in pieces: one path again, without the quotes.
  const spaced = joinArgs(['u@host', 'ABC', '--key', '"/home/Jane', 'Doe/.ssh/vps', 'key"', '--ssh-port', '2222']);
  assert.deepStrictEqual(spaced, { opts: { key: path.resolve('/home/Jane Doe/.ssh/vps key'), sshPort: 2222 }, words: ['u@host', 'ABC'] });
  assert.strictEqual(joinArgs(['u@host', 'ABC', '--key', '"/k"']).opts.key, path.resolve('/k'));
  assert.strictEqual(joinArgs(['u@host', 'ABC', '-i', "'~/.ssh/id_vps'"]).opts.key, path.join(os.homedir(), '.ssh', 'id_vps'));
  // Through a shell the quotes are gone already: the path is one word.
  assert.strictEqual(joinArgs(['u@host', 'ABC', '--key', '/home/Jane Doe/k']).opts.key, path.resolve('/home/Jane Doe/k'));
  // The line typed as printed, with the user's placeholder still in it: said plainly.
  assert.throws(() => joinArgs(['u@host', 'ABC', '--key', '"<path', 'of', 'your', 'key', 'file>"']), /<path of your key file> is a placeholder: type where your key file is/);
  assert.throws(() => joinArgs(['u@host', 'ABC', '--key', '<path of your key file>']), /is a placeholder/);
  assert.throws(() => joinArgs(['u@host', 'ABC', '--key', '"/home/Jane', 'Doe/k']), /no closing "/);
  assert.throws(() => joinArgs(['u@host', 'ABC', '--key', '""']), /--key needs a key file/);
});

test('control NEW and an upper-case session id work', () => {
  const { controlWord } = require('../bin/drive');
  assert.strictEqual(controlWord('NEW'), 'new');
  assert.strictEqual(controlWord('New'), 'new');
  assert.strictEqual(controlWord('0A1B2C3D-0000-4000-8000-ABCDEF012345'), '0a1b2c3d-0000-4000-8000-abcdef012345');
  assert.strictEqual(controlWord('MANUAL'), 'manual');
  assert.strictEqual(controlWord('Stop'), 'manual');
  assert.strictEqual(controlWord('bogus'), '');
  assert.strictEqual(controlWord(undefined), '');
});

test('the update note names both versions and offers /editlens restart, which keeps page control', () => {
  const { updateText, staleText } = require('../hooks/live-hook');
  const control = updateText('9.9.9', '0.24.14', 'page control');
  assert.match(control, /9\.9\.9 is installed, but an older one \(0\.24\.14\) is still running/);
  assert.match(control, /when page control stops, and starts again/);
  assert.match(control, /To update now: \/editlens restart \(page control starts again\)/);
  assert.doesNotMatch(control, /\/editlens (stop|manual)/);
  const task = updateText('9.9.9', '0.24.14', 'tasks');
  assert.match(task, /when the running task finishes/);
  assert.match(task, /\/editlens restart \(the running task stops\)/);
  assert.match(staleText('9.9.9', '0.24.14', 'no answer'), /older one \(0\.24\.14\) is still running: it didn't respond to the request to stop\n {2}To update now: \/editlens restart/);
});
