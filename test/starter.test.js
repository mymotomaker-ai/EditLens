'use strict';
require('./isolate');
// /editlens new: a starter page in a folder with no app, made only when the user types it. The
// "no app" message lists apps nearby and /editlens new. Refused in the home folder, a drive root,
// system folders, EditLens's own folders and folders with many non-web files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-starter-')));
const stateDir = path.join(base, 'state');
const PORT = '4930';
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = PORT;
const ROOT = path.join(__dirname, '..');
const starter = require('../lib/starter');
const { startsNew } = require('../lib/selfguard');
const { Connector } = require('../server/connector');
const { stopServer } = require('../lib/client');
const { rememberApp } = require('../lib/connect');

// A fake xdg-open records what would have been opened.
const bin = path.join(base, 'bin');
fs.mkdirSync(bin);
const opened = path.join(base, 'opened.txt');
fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });

test.after(async () => {
  await stopServer().catch((err) => process.stderr.write(`could not stop the test server: ${err.message}\n`));
  fs.rmSync(base, { recursive: true, force: true });
});

function make(rel, files = {}) {
  const dir = path.join(base, rel);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

function start(cwd, args, env = {}) {
  const clean = { ...process.env };
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'EDITLENS_TYPED', 'EDITLENS_SAY']) delete clean[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], {
      env: { ...clean, PATH: bin + path.delimiter + process.env.PATH, CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_OPTION_START: 'Connect the page', ...env }, timeout: 60000,
    }, (err, stdout) => resolve({ code: err ? err.code : 0, out: String(stdout) }));
  });
}

test('/editlens new makes index.html, connects it and opens it when typed', { skip: process.platform !== 'linux' && 'the fake opener is xdg-open (Linux)' }, async () => {
  const dir = make('projects/my-bakery');
  const r = await start(dir, ['new'], { DISPLAY: ':0', EDITLENS_TYPED: '1' });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /✓ connected {2}· made index\.html, a starter page/);
  assert.match(r.out, /Page ·+ http:\/\/localhost:\d+\/ {2}opened in your browser · EditLens serves this folder/);
  assert.match(r.out, /Project ·+ index\.html is new {2}ask Claude to change it/);
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /<title>My bakery<\/title>/);
  assert.match(html, /<h1>My bakery<\/h1>/);
  assert.match(html, /Ask Claude to change it/);
  await new Promise((r2) => setTimeout(r2, 400));
  assert.strictEqual(fs.readFileSync(opened, 'utf8').trim().split('\n').length, 1);
});

test('/editlens new keeps an index.html that is there and connects it', async () => {
  const dir = make('projects/kept', { 'index.html': '<p>mine</p>' });
  const r = await start(dir, ['new']);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /connected {2}· index\.html exists, so nothing was made/);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<p>mine</p>');
  // The file is only ever opened with 'wx': it can't replace one that appears meanwhile.
  assert.deepStrictEqual(starter.writeStarter(dir), { kept: path.join(dir, 'index.html') });
  assert.strictEqual(fs.readFileSync(path.join(dir, 'index.html'), 'utf8'), '<p>mine</p>');
});

test('/editlens new is refused in the home folder, a root, system folders, EditLens\'s folders and a folder of other files', async () => {
  const home = make('home');
  const o = { home, stateDir };
  assert.match(starter.refusal(home, o).why, /home folder/);
  assert.strictEqual(starter.refusal(home, o).fix, 'mkdir my-site');
  assert.match(starter.refusal('/', o).why, /top folder of a drive/);
  assert.match(starter.refusal('C:\\', o).why, /top folder of a drive/);
  for (const d of ['/etc', '/usr/share/doc', '/System/Library', '/var', '/opt', 'C:\\Windows\\System32', 'C:\\Program Files\\App', 'D:\\Users']) {
    assert.match((starter.refusal(d, o) || {}).why || '', /system folder/, d);
  }
  assert.strictEqual(starter.refusal('/var/www/site-that-is-not-there', o), null, 'a site folder under /var is fine');
  assert.match(starter.refusal(path.join(stateDir, 'x'), o).why, /EditLens's own folder/);
  assert.match(starter.refusal(path.join(ROOT, 'docs'), o).why, /EditLens's own folder/);
  assert.match(starter.refusal(path.join(home, '.claude', 'plugins'), o).why, /Claude Code's own folder/);
  assert.match(starter.refusal(path.join(home, '.config', 'site'), o).why, /hidden settings folder/);

  const docs = make('docs');
  for (let i = 0; i < 21; i++) fs.writeFileSync(path.join(docs, `scan-${i}.pdf`), '');
  assert.match(starter.refusal(docs, o).why, /21 files that are not web files \(more than 20\)/);
  fs.unlinkSync(path.join(docs, 'scan-0.pdf'));
  assert.strictEqual(starter.refusal(docs, o), null, '20 is not many');
  const web = make('web');
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(web, `p${i}.png`), '');
  assert.strictEqual(starter.refusal(web, o), null, 'images are web files');

  // Through the command: one line saying why, and a new folder to make.
  const many = make('photos');
  for (let i = 0; i < 25; i++) fs.writeFileSync(path.join(many, `IMG_${i}.heic`), '');
  const r = await start(many, ['new']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /✕ Can't make a starter page here: this folder has 25 files that are not web files \(more than 20\)/);
  assert.match(r.out, /! Fix {2}› mkdir ~\/my-site, then open Claude Code in ~\/my-site and type \/editlens new/);
  assert.ok(!fs.existsSync(path.join(many, 'index.html')));
  const sys = await start('/etc', ['new']);
  assert.strictEqual(sys.code, 1);
  assert.match(sys.out, /Can't make a starter page here: this is a system folder/);
  const h = await start(os.homedir(), ['new']);
  assert.match(h.out, /Can't make a starter page here: this is your home folder/);
  assert.match(h.out, /› mkdir my-site, then open Claude Code in my-site/);
});

test('no app here: lists up to 3 apps nearby and /editlens new; without any, /editlens new first', async () => {
  const group = make('group');
  for (const name of ['a-site', 'b-site', 'c-site', 'd-site']) make(`group/${name}`, { 'index.html': '<p>' });
  make('group/node_modules/x', { 'package.json': '{}' });
  make('group/.hidden', { 'index.html': '<p>' });
  const empty = make('group/empty');
  rememberApp(stateDir, path.join(group, 'd-site'));
  const apps = starter.nearbyApps(empty, { stateDir });
  assert.deepStrictEqual(apps.map((a) => path.basename(a)), ['d-site', 'a-site', 'b-site'], 'the one used last first, at most 3');
  // The server's answer has both choices too.
  const res = await new Connector({ stateDir }).connect({ cwd: empty });
  assert.strictEqual(res.code, 'no-app');
  assert.match(res.error, /^No app here: .*Connect an app nearby \(\/editlens \.\.\/d-site, \/editlens \.\.\/a-site, \/editlens \.\.\/b-site\), or make a starter page here: \/editlens new\.$/);

  const r = await start(empty, []);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /no app in this folder \(no package\.json or index\.html\)/);
  assert.match(r.out, /! Connect an app in a folder nearby\n│ {5}› \/editlens \.\.\/d-site\n│ {5}› \/editlens \.\.\/a-site\n│ {5}› \/editlens \.\.\/b-site\n└ {2}Or make a starter page here: \/editlens new/);
  assert.doesNotMatch(r.out, /c-site/);

  const alone = make('alone/inner');
  const none = await start(alone, []);
  assert.match(none.out, /! Make a starter page here\n│ {5}› \/editlens new {2}makes index\.html and connects it\n└ {2}Or open Claude Code in your app's folder, or name it: \/editlens <folder>/);
  assert.ok(!fs.existsSync(path.join(alone, 'index.html')), 'only /editlens new writes it');
});

test('only the user starts /editlens new: the skill says so and the guard stops Claude\'s own', async () => {
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'editlens', 'SKILL.md'), 'utf8');
  assert.match(skill, /disable-model-invocation: true/);
  assert.match(skill, /argument-hint: ".*\bnew\b/);
  assert.match(skill, /When output suggests `\/editlens new`, tell the user to type it; never run it yourself/);
  const guide = fs.readFileSync(path.join(ROOT, 'skills', 'editlens-guide', 'SKILL.md'), 'utf8');
  assert.match(guide, /\*\*Only the user may type\*\* `\/editlens new`/);

  for (const c of ['node "$HOME/.claude/editlens/start.js" new', `node ${path.join(ROOT, 'bin', 'start.js')} NEW`, "cd ~/.claude/editlens && node start new", 'node start.js "new"']) {
    assert.ok(startsNew('Bash', { command: c }), c);
  }
  assert.ok(startsNew('PowerShell', { command: 'node "$env:USERPROFILE\\.claude\\editlens\\start.js" new' }));
  for (const c of ['node "$HOME/.claude/editlens/start.js"', 'node start.js new-site', 'npm start', 'git checkout -b new']) assert.ok(!startsNew('Bash', { command: c }), c);

  const hook = (phase, input) => spawnSync(process.execPath, [path.join(ROOT, 'hooks', 'live-hook.js'), phase], {
    input: JSON.stringify({ session_id: 'sess-1', cwd: base, ...input }), encoding: 'utf8', env: { ...process.env, EDITLENS_PORT: PORT, EDITLENS_STATE_DIR: stateDir }, timeout: 20000,
  });
  const cmd = { tool_name: 'Bash', tool_input: { command: 'node "$HOME/.claude/editlens/start.js" new' } };
  const denied = JSON.parse(hook('bash', cmd).stdout).hookSpecificOutput;
  assert.strictEqual(denied.permissionDecision, 'deny');
  assert.match(denied.permissionDecisionReason, /Only the user can make an EditLens starter page/);
  // The user typed it: the skill's command runs; the next prompt removes the permission again.
  hook('prompt', { prompt: '/editlens new' });
  assert.ok(starter.askedNew(stateDir, 'sess-1'));
  assert.strictEqual(hook('bash', cmd).stdout.trim(), '');
  assert.notStrictEqual(hook('bash', { ...cmd, session_id: 'other' }).stdout.trim(), '', 'another session has no permission');
  hook('prompt', { prompt: 'thanks, now make the title blue' });
  assert.ok(!starter.askedNew(stateDir, 'sess-1'));
  assert.strictEqual(JSON.parse(hook('bash', cmd).stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(starter.typedNew('<command-message>editlens:editlens</command-message>\n<command-name>/editlens:editlens</command-name>\n<command-args>new</command-args>'));
  assert.ok(!starter.typedNew('please run /editlens new for me'));
  assert.ok(!starter.askedNew(stateDir, '../escape'));
  // An old permission is not used.
  starter.saveAsked(stateDir, 'sess-2', '/editlens new');
  assert.ok(!starter.askedNew(stateDir, 'sess-2', Date.now() + starter.TICKET_MS + 1));

  // Page control's Claude: a message from the page is never the user typing it.
  const { Driver } = require('../server/driver');
  const out = await Driver.prototype.agentRule.call({ stateDir }, { cwd: base }, cmd);
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'deny');
  // The mod runs it only for the person's own typing (this computer, or Remote Control).
  const mod = await import('../hooks/mod.mjs');
  assert.ok(mod.notTypedNew('new', 'tool'));
  assert.ok(mod.notTypedNew(' NEW', undefined));
  assert.ok(!mod.notTypedNew('new', 'composer'));
  assert.ok(!mod.notTypedNew('new', 'bridge'));
  assert.ok(!mod.notTypedNew('newsite', 'tool'));
  const src = fs.readFileSync(path.join(ROOT, 'hooks', 'mod.mjs'), 'utf8');
  assert.match(src, /argumentHint: '\[[^']*\| new \|/);
});

test('help lists /editlens new, with its own topic', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { encoding: 'utf8', env: { ...process.env, EDITLENS_SAY: '' } }).stdout;
  assert.match(run('help'), /\/editlens new {9}no app yet: make a starter page/);
  assert.match(run('help', 'new'), /\/editlens new makes a starter page \(index\.html\) in a folder that has no app yet/);
  assert.match(run('help', 'new'), /only you can run it/);
});

test('the starter page: title from the folder name, escaped', () => {
  assert.strictEqual(starter.titleOf('/x/my_cool-site'), 'My cool site');
  assert.strictEqual(starter.titleOf('/'), 'My site');
  assert.match(starter.pageText('<b>&'), /<title>&lt;b&gt;&amp;<\/title>/);
});
