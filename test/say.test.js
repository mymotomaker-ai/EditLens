'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4916';
// /editlens output (lib/say.js): one shape everywhere, plain text for Claude and other surfaces,
// records the mod draws in colour. Also the status line and the SessionStart launcher.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { plain, parse, MARK } = require('../lib/say');

test('each record has one plain shape: narrow symbols, a dotted line to a 12-column value, two-part errors', () => {
  assert.deepStrictEqual(plain({ k: 'head', status: 'ok', word: 'connected' }), ['✦ EditLens  ✓ connected']);
  assert.deepStrictEqual(plain({ k: 'head', status: null, word: '', note: 'settings' }), ['✦ EditLens  · settings']);
  assert.deepStrictEqual(plain({ k: 'field', label: 'Page', value: 'http://localhost:4678/', note: 'opened' }), ['Page ······ http://localhost:4678/  opened']);
  assert.deepStrictEqual(plain({ k: 'field', label: 'Paired computers can run', value: 'On', width: 12 }), ['Paired computers can run ·· On']);
  assert.deepStrictEqual(plain({ k: 'field', label: '', value: 'second line' }), ['            second line']);
  assert.deepStrictEqual(plain({ k: 'head', title: '', status: 'ok', word: 'Paired with ◆ laptop-1' }), ['✦ ✓ Paired with ◆ laptop-1']);
  assert.deepStrictEqual(plain({ k: 'code', text: '/editlens join root@203.0.113.5 ABCD', copy: true }), ['', '/editlens join root@203.0.113.5 ABCD', '']);
  assert.deepStrictEqual(plain({ k: 'fail', what: 'Couldn\'t connect', detail: 'port 4733 is busy' }), ['✕ Couldn\'t connect: port 4733 is busy']);
  assert.deepStrictEqual(plain({ k: 'fix', cmd: '/editlens', before: 'close the other dev server, then' }), ['! Fix  close the other dev server, then › /editlens']);
  assert.deepStrictEqual(plain({ k: 'steps', heading: 'Start your dev server', items: [{ n: 1, cmd: 'npm run dev', text: 'in another terminal' }, { text: 'more' }], end: { text: 'Different port?', cmd: '/editlens 3000' } }),
    ['! Start your dev server', '│  1  › npm run dev  in another terminal', '│     more', '└  Different port? /editlens 3000']);
  assert.deepStrictEqual(plain({ k: 'hint', items: [['/editlens manual', 'back to this window'], ['/editlens stop', 'disconnect']] }), ['/editlens manual  back to this window  ·  /editlens stop  disconnect']);
  for (const k of ['head', 'field', 'act', 'hint', 'done', 'fail', 'fix', 'code', 'steps', 'title', 'cmd', 'cmds', 'row', 'meter', 'blank', 'text']) {
    assert.doesNotMatch(plain({ k }).join('\n'), /undefined|null|NaN|[⚡⚠▰▱]/, k);
  }
});

test('shared columns: help commands 22 cells, join rows with a dotted line to one value column, usage labels 10', () => {
  assert.deepStrictEqual(plain({ k: 'cmd', cmd: '/editlens task-user', what: 'tasks as a normal account' }), ['  /editlens task-user   tasks as a normal account']);
  assert.deepStrictEqual(plain({ k: 'cmd', cmd: '/editlens a-very-long-command', what: 'x' }), ['  /editlens a-very-long-command  x']);
  assert.deepStrictEqual(plain({ k: 'row', label: '◆ laptop-1', value: '● Connected', width: 12 }), ['◆ laptop-1 ···· ● Connected']);
  assert.deepStrictEqual(plain({ k: 'row', label: '◆ build-box-2', value: '! Re-pair', width: 12 }), ['◆ build-box-2 ·· ! Re-pair']);
  assert.deepStrictEqual(plain({ k: 'meter', label: 'Context', percent: 41, note: '410k of 1M' }), ['Context   ━━━━━━━─────────   41%   410k of 1M']);
  assert.deepStrictEqual(plain({ k: 'meter', label: 'Spend', percent: NaN }), ['Spend     ────────────────      ']);
  // The join list: each name, its state in one column, the page or the fix under the name.
  const { sayPaired } = require('../bin/pair.js');
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (t) => lines.push(String(t)) && true;
  const saved = process.env.EDITLENS_SAY;
  delete process.env.EDITLENS_SAY;
  try {
    sayPaired({ hosts: [{ name: 'vps-123456', state: 'connected', address: 'root@203.0.113.10', url: 'http://localhost:4732/', site: true }, { name: 'old-box', state: 'refused', error: 'refused there' }] },
      { pairs: [{ name: 'laptop-1', connected: false, cwd: '/root/my-project' }] });
  } finally {
    process.stdout.write = write;
    if (saved !== undefined) process.env.EDITLENS_SAY = saved;
  }
  assert.strictEqual(lines.join(''), [
    '✦ Paired computers', '', 'This computer joined',
    '◆ vps-123456 ·· ● Connected', '  http://localhost:4732/  root@203.0.113.10',
    '◆ old-box ····· ! Re-pair', '  Remove: /editlens join off old-box  refused there', '',
    'Joined this computer',
    '◆ laptop-1 ···· ○ Offline', '  /root/my-project', '',
  ].join('\n'));
});

test('records mode: every line is a record; other lines are returned as text', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { encoding: 'utf8', env: { ...process.env, EDITLENS_SAY: 'records' } });
  const out = run('help').stdout;
  assert.ok(out.split('\n').filter(Boolean).every((l) => l.startsWith(MARK)), out);
  const list = parse(out + 'a stray line\n');
  assert.strictEqual(list[0].k, 'head');
  assert.deepStrictEqual(list[list.length - 1], { k: 'text', text: 'a stray line', plain: ['a stray line'] });
  const text = list.slice(0, -1).flatMap((r) => r.plain).join('\n');
  assert.match(text, /Everyday\n {2}\/editlens {13}connect your page/);
  assert.match(text, /\n {2}\/editlens control {5}run Claude from the page/);
  assert.match(text, /Other computers\n {2}\/editlens pair {2}join {2}task-user/);
  // Without the mode: the same lines, as text.
  assert.strictEqual(run('help').stdout.trim().length > 0, true);
  const plainOut = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), 'help'], { encoding: 'utf8', env: { ...process.env, EDITLENS_SAY: '' } }).stdout;
  assert.strictEqual(plainOut.trimEnd(), text.trimEnd());
});

test('the mod reads the records back and draws them; the text is what Claude reads', async () => {
  const mod = await import('../hooks/mod.mjs');
  const out = `${MARK}${JSON.stringify({ k: 'head', status: 'ok', word: 'connected', plain: ['✦ EditLens  ✓ connected'] })}\n${MARK}${JSON.stringify({ k: 'blank', plain: [''] })}\nplain line\n${MARK}{broken\n`;
  const list = mod.readRecords(out);
  assert.deepStrictEqual(list.map((r) => r.k), ['head', 'blank', 'text', 'text']);
  assert.strictEqual(mod.plainOf(list), `✦ EditLens  ✓ connected\n\nplain line\n${MARK}{broken`);
});

test('the status line: model, a ━/─ meter, 5-hour use, ✦ live; plain 16-colour ANSI only', (t) => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'el-sl-'));
  t.after(() => fs.rmSync(state, { recursive: true, force: true }));
  const run = (input) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'statusline.js')], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, EDITLENS_PORT: '4915', EDITLENS_STATE_DIR: state } }).stdout;
  const out = run({ session_id: 's', model: { display_name: 'Opus 5.5' }, context_window: { used_percentage: 41 }, rate_limits: { five_hour: { used_percentage: 23 } } });
  const bare = out.replace(/\u001b\[\d+m/g, '');
  assert.strictEqual(bare, 'Opus 5.5  context ━━━━────── 41%  ·  5h 23%  ·  ✦ live\n');
  assert.ok((out.match(/\u001b\[(\d+)m/g) || []).every((c) => /\[(0|2|3[0-7])m/.test(c)), 'only basic colours');
  assert.strictEqual(run({ context_window: { used_percentage: NaN } }).replace(/\u001b\[\d+m/g, ''), '✦ live\n');
});

test('SessionStart writes the /editlens launcher; the skill runs it, with the plugin path when the launcher is missing', (t) => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'editlens', 'SKILL.md'), 'utf8');
  assert.match(skill, /Describe the call as "EditLens"/);
  const hook = fs.readFileSync(path.join(ROOT, 'hooks', 'live-hook.js'), 'utf8');
  assert.match(hook, /installLauncher\(\);/);
  // The launcher runs /editlens from the plugin that wrote it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-launch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const launcher = path.join(dir, 'start.js');
  fs.writeFileSync(launcher, `require(${JSON.stringify(path.join(ROOT, 'bin', 'start.js'))});\n`);
  const out = spawnSync(process.execPath, [launcher, 'help'], { encoding: 'utf8', env: { ...process.env, EDITLENS_SAY: '' } });
  assert.match(out.stdout, /^✦ EditLens\n/);
});

test('the skill runs the launcher in the state folder EditLens uses (EDITLENS_STATE_DIR)', { skip: process.platform === 'win32' ? 'needs a POSIX shell' : false }, () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'editlens', 'SKILL.md'), 'utf8');
  const command = /```\n\s*(node "[^\n]*editlens\}?\/start\.js" \$ARGUMENTS)\n/.exec(skill)[1];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'el-home-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'el-state-'));
  const launcher = (dir, word) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'start.js'), `console.log(${JSON.stringify(word)}, process.argv[2]);\n`);
  };
  launcher(path.join(home, '.claude', 'editlens'), 'home');
  launcher(state, 'state');
  try {
    const run = (env) => spawnSync('bash', ['-c', command.replace('$ARGUMENTS', 'help')], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, ...env } }).stdout;
    assert.strictEqual(run({ EDITLENS_STATE_DIR: state }), 'state help\n');
    assert.strictEqual(run({}), 'home help\n', 'the usual folder when it is not set');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(state, { recursive: true, force: true });
  }
});

test('SessionStart messages: plain text, the symbols, what went wrong then the fix', () => {
  const v = require('../lib/versions');
  const node = v.versionWarning({ nodeVersion: '16.20.0' });
  assert.match(node, /^✕ EditLens needs Node 18 or newer: this computer has Node 16\.20\.0\n! Fix /);
  assert.doesNotMatch(node, /\u001b/);
});
