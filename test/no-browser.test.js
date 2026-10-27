'use strict';
require('./isolate');
// A computer with no browser (a VPS used through SSH): EditLens knows immediately, never waits two
// minutes for a page that can't open by itself, says how to open the page from the user's own
// computer (the paired computer's address, or an ssh -L line), shows one address, and never a
// raw system error such as "spawn xdg-open ENOENT".
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const { canOpenBrowser, openAdvice, sshLine, shownUrl, noBrowserText, answerAddress, shownKey, KEY_PLACEHOLDER } = require('../lib/browser');
const { keyPath, knownKey } = require('../lib/pairwire');
const { plainError } = require('../lib/plainerr');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-nobrowser-'));
const PORT = '4347';
const PAIR_PORT = '4348';
const stateDir = path.join(base, 'state');
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = PORT;
process.env.EDITLENS_PAIR_PORT = PAIR_PORT;
const { stopServer, getJson } = require('../lib/client');

let mod;
test.before(async () => { mod = await import('../hooks/mod.mjs'); });
test.after(async () => {
  await stopServer().catch((err) => process.stderr.write(`could not stop the test server: ${err.message}\n`));
  fs.rmSync(base, { recursive: true, force: true });
});

const has = (names) => (n) => (names.includes(n) ? '/usr/bin/' + n : null);

test('no-browser detection: display, SSH, opener, WSL, and Mac and Windows stay able', () => {
  const linux = { platform: 'linux', wsl: false };
  assert.deepStrictEqual(canOpenBrowser({ ...linux, env: {}, which: has(['xdg-open']) }).why, 'no-display');
  assert.strictEqual(canOpenBrowser({ ...linux, env: { DISPLAY: ':0' }, which: has(['xdg-open']) }).ok, true);
  assert.strictEqual(canOpenBrowser({ ...linux, env: { WAYLAND_DISPLAY: 'wayland-0' }, which: has(['xdg-open']) }).ok, true);
  assert.strictEqual(canOpenBrowser({ ...linux, env: { DISPLAY: ':0' }, which: has([]) }).why, 'no-opener');
  for (const k of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT']) {
    assert.strictEqual(canOpenBrowser({ ...linux, env: { [k]: '1.2.3.4 5 6.7.8.9 22' }, which: has(['xdg-open']) }).why, 'ssh', k);
    // A browser started through SSH never appears on the user's own screen.
    assert.strictEqual(canOpenBrowser({ ...linux, env: { [k]: 'x', DISPLAY: 'localhost:10.0' }, which: has(['xdg-open']) }).ok, false, k);
  }
  // WSL opens the page in Windows, with no DISPLAY.
  assert.deepStrictEqual(canOpenBrowser({ platform: 'linux', wsl: true, env: {}, which: has(['wslview']) }).cmd, ['wslview']);
  assert.deepStrictEqual(canOpenBrowser({ platform: 'linux', wsl: true, env: {}, which: has(['explorer.exe']) }).cmd, ['explorer.exe']);
  assert.strictEqual(canOpenBrowser({ platform: 'linux', wsl: true, env: {}, which: has([]) }).why, 'no-display');
  assert.strictEqual(canOpenBrowser({ platform: 'darwin', env: {}, which: has([]) }).ok, true);
  assert.strictEqual(canOpenBrowser({ platform: 'win32', env: {}, which: has([]) }).ok, true);
  assert.strictEqual(canOpenBrowser({ platform: 'darwin', env: {}, which: has([]) }).cmd[0], 'open');
  assert.strictEqual(canOpenBrowser({ platform: 'linux', wsl: false, env: { EDITLENS_NO_BROWSER: '1', DISPLAY: ':0' }, which: has(['xdg-open']) }).why, 'off');
  // The real PATH lookup: a program there that can run, and none when PATH is empty.
  const dir = fs.mkdtempSync(path.join(base, 'path-'));
  fs.writeFileSync(path.join(dir, 'xdg-open'), '#!/bin/sh\n', { mode: 0o755 });
  if (process.platform !== 'win32') {
    assert.strictEqual(canOpenBrowser({ platform: 'linux', wsl: false, env: { DISPLAY: ':0', PATH: dir } }).ok, true);
    assert.strictEqual(canOpenBrowser({ platform: 'linux', wsl: false, env: { DISPLAY: ':0', PATH: '' } }).why, 'no-opener');
  }
  for (const why of ['ssh', 'no-display', 'no-opener', 'off']) assert.match(noBrowserText(why), /^no browser here/);
});

test('system errors in plain words: ENOENT and the rest, never the raw code', () => {
  const spawnErr = Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT', syscall: 'spawn xdg-open', path: 'xdg-open', errno: -2 });
  assert.strictEqual(plainError(spawnErr), 'xdg-open is not installed here');
  assert.strictEqual(plainError(Object.assign(new Error('spawn /x/npm EACCES'), { code: 'EACCES', syscall: 'spawn /x/npm' })), 'npm is not allowed to run here');
  const codes = ['ENOENT', 'EACCES', 'EPERM', 'ETIMEDOUT', 'ECONNREFUSED', 'EADDRINUSE', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND', 'ENOSPC'];
  for (const code of codes) {
    const text = plainError(Object.assign(new Error(`${code}: something, open '/a/b'`), { code }));
    assert.doesNotMatch(text, /E[A-Z]{3,}|spawn|\/a\/b/, code + ': ' + text);
    assert.ok(text.length > 5, code);
  }
  assert.strictEqual(plainError(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4317'), { code: 'ECONNREFUSED', port: 4317 })), 'nothing is running there (port 4317)');
  assert.strictEqual(plainError('EADDRINUSE'), 'the port is already in use');
  // EditLens's own messages (no code) stay as written.
  assert.strictEqual(plainError(new Error('Run /editlens pair in your project\'s folder.')), 'Run /editlens pair in your project\'s folder.');
  assert.strictEqual(plainError(null), 'no reason was given');
  // An unknown system code: the words without the code or the path.
  assert.strictEqual(plainError(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })), 'i/o error');
});

test('the browser opener failing is never printed raw', { skip: process.platform === 'win32' && 'uses a POSIX script as the opener' }, () => {
  const dir = fs.mkdtempSync(path.join(base, 'opener-'));
  // On PATH and runnable-looking, but its interpreter is missing: spawn fails with ENOENT.
  fs.writeFileSync(path.join(dir, 'xdg-open'), '#!/nonexistent/interpreter\n', { mode: 0o755 });
  const script = `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'browser.js'))}).openBrowser('http://127.0.0.1:4347/')`;
  const env = { PATH: dir, DISPLAY: ':0', HOME: base };
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  if (process.platform === 'linux') assert.match(r.stderr, /couldn't open the browser: xdg-open is not installed here; open the address yourself/);
  assert.doesNotMatch(r.stderr, /ENOENT|spawn/);
  // With no browser at all nothing is started, so nothing can fail.
  const quiet = spawnSync(process.execPath, ['-e', script], { env: { PATH: dir, HOME: base, SSH_CONNECTION: '1 2 3 22' }, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(quiet.stderr, '');
});

test('one address: 127.0.0.1 shows as localhost, and the output link draws it once', () => {
  assert.strictEqual(shownUrl('http://127.0.0.1:4493/'), 'http://localhost:4493/');
  assert.strictEqual(shownUrl('http://[::1]:4493/x'), 'http://localhost:4493/x');
  assert.strictEqual(shownUrl('https://example.com/'), 'https://example.com/');
  const made = [];
  const el = (type) => (props) => { made.push({ type, props }); return { type, props }; };
  const ui = { Box: el('Box'), Text: el('Text'), Link: el('Link') };
  mod.drawRecord({ k: 'field', label: 'Page', value: 'http://localhost:4493/', note: 'EditLens serves this folder', link: true }, ui, 'r0', 80);
  const link = made.find((m) => m.type === 'Link');
  // No label: a terminal without clickable links prints the address alone, not "label address".
  assert.deepStrictEqual(link.props, { href: 'http://localhost:4493/' });
});

test('the SSH line: both ports, the address and SSH port the user connected to, no key', () => {
  const env = { SSH_CONNECTION: '203.0.113.9 50000 198.51.100.7 2222' };
  assert.strictEqual(sshLine({ ports: [4493, 4317], env, user: 'root' }), 'ssh -L 4493:127.0.0.1:4493 -L 4317:127.0.0.1:4317 -p 2222 root@198.51.100.7');
  assert.strictEqual(sshLine({ ports: [4493, 4493], env: { SSH_CONNECTION: '1.1.1.1 5 2.2.2.2 22' }, user: 'dev' }), 'ssh -L 4493:127.0.0.1:4493 dev@2.2.2.2');
  // Not through SSH (no screen): this computer's own address, else a word to replace.
  assert.strictEqual(sshLine({ ports: [80], env: {}, user: 'a', addresses: ['10.0.0.5'] }), 'ssh -L 80:127.0.0.1:80 a@10.0.0.5');
  assert.strictEqual(sshLine({ ports: [80], env: {}, user: null }), 'ssh -L 80:127.0.0.1:80 USER@THIS-COMPUTER');
  const browser = { ok: false, why: 'ssh' };
  const pairs = [{ name: 'laptop-1', cwd: '/root/my-project', url: 'http://localhost:51234/' }];
  assert.deepStrictEqual(openAdvice({ browser, cwd: '/root/my-project', pairs, pageUrl: 'http://127.0.0.1:4493/', livePort: 4317, env, user: 'root' }),
    { why: 'ssh', paired: { name: 'laptop-1', url: 'http://localhost:51234/', folder: 'my-project' } });
  const other = openAdvice({ browser, cwd: '/root/site', pairs, pageUrl: 'http://127.0.0.1:4493/', livePort: 4317, env, user: 'root' });
  assert.strictEqual(other.ssh, 'ssh -L 4493:127.0.0.1:4493 -L 4317:127.0.0.1:4317 -p 2222 root@198.51.100.7');
  assert.strictEqual(other.url, 'http://localhost:4493/');
  assert.deepStrictEqual(other.other, { name: 'laptop-1', folder: 'my-project' });
  assert.strictEqual(openAdvice({ browser: { ok: true }, cwd: '/x', pairs, pageUrl: 'http://127.0.0.1:1/', livePort: 2 }), null);
  // The app loads EditLens itself, so its address isn't known here: the user fills in the port.
  const own = openAdvice({ browser, cwd: '/root/site', pairs: [], pageUrl: null, livePort: 4317, env, user: 'root' });
  assert.strictEqual(own.ssh, 'ssh -L PORT:127.0.0.1:PORT -L 4317:127.0.0.1:4317 -p 2222 root@198.51.100.7');
  assert.strictEqual(own.url, 'http://localhost:PORT/');
});

test('the SSH line with a key file: the placeholder, or the key the paired computers joined with', () => {
  const env = { SSH_CONNECTION: '203.0.113.9 50000 203.0.113.10 22' };
  assert.strictEqual(KEY_PLACEHOLDER, '<path of your key file>');
  // No key known: the user's placeholder, in double quotes, after -i (plain ssh has no --key).
  assert.strictEqual(sshLine({ ports: [4825, 4317], env, user: 'root', key: null }),
    'ssh -i "<path of your key file>" -L 4825:127.0.0.1:4825 -L 4317:127.0.0.1:4317 root@203.0.113.10');
  // Left out: the plain line, as before.
  assert.strictEqual(sshLine({ ports: [4825, 4317], env, user: 'root' }), 'ssh -L 4825:127.0.0.1:4825 -L 4317:127.0.0.1:4317 root@203.0.113.10');
  // A known key: its path, quoted, so a Windows path with spaces stays one word.
  assert.strictEqual(sshLine({ ports: [4825], env: { SSH_CONNECTION: '1 2 198.51.100.7 2222' }, user: 'root', key: 'C:\\Users\\Jane Doe\\.ssh\\vps key' }),
    'ssh -i "C:\\Users\\Jane Doe\\.ssh\\vps key" -L 4825:127.0.0.1:4825 -p 2222 root@198.51.100.7');
  assert.strictEqual(sshLine({ ports: [80], env: {}, user: 'a', addresses: ['10.0.0.5'], key: '/home/a/.ssh/id_vps' }), 'ssh -i "/home/a/.ssh/id_vps" -L 80:127.0.0.1:80 a@10.0.0.5');
  // A path that can't go in quotes safely, or isn't a path: the placeholder instead.
  for (const bad of ['/a/"b', '/a/$HOME', '/a/`x`', '%USERPROFILE%\\k', '/a\nb', 'x'.repeat(261), '', 7, {}, undefined]) assert.strictEqual(shownKey(bad), KEY_PLACEHOLDER, String(bad));
  // What a computer sends when it joins: a string of at most 260 characters, no control characters.
  assert.strictEqual(keyPath('/k'), '/k');
  assert.strictEqual(keyPath('x'.repeat(260)).length, 260);
  for (const bad of ['x'.repeat(261), '/a\u0000b', '/a\rb', '/a\u009bb', '', null, 3, ['/k']]) assert.strictEqual(keyPath(bad), null, JSON.stringify(bad));
  // One key among the paired computers: that one. Two different ones, or none: none.
  assert.strictEqual(knownKey([{ keyPath: '/k' }, { keyPath: '/k' }, {}]), '/k');
  assert.strictEqual(knownKey([{ keyPath: '/k' }, { keyPath: '/j' }]), null);
  assert.strictEqual(knownKey([{}, null]), null);
  assert.strictEqual(knownKey('x'), null);
  // openAdvice: both lines; the key line has the paired computers' key, else the placeholder.
  const browser = { ok: false, why: 'ssh' };
  const pairs = [{ name: 'laptop-1', cwd: '/root/my-project', keyPath: 'C:\\Users\\Jane Doe\\.ssh\\vps key' }];
  const known = openAdvice({ browser, cwd: '/root/site', pairs, pageUrl: 'http://127.0.0.1:4825/', livePort: 4317, env, user: 'root' });
  assert.strictEqual(known.ssh, 'ssh -L 4825:127.0.0.1:4825 -L 4317:127.0.0.1:4317 root@203.0.113.10');
  assert.strictEqual(known.sshKey, 'ssh -i "C:\\Users\\Jane Doe\\.ssh\\vps key" -L 4825:127.0.0.1:4825 -L 4317:127.0.0.1:4317 root@203.0.113.10');
  const unknown = openAdvice({ browser, cwd: '/root/site', pairs: [], pageUrl: 'http://127.0.0.1:4825/', livePort: 4317, env, user: 'root' });
  assert.strictEqual(unknown.sshKey, 'ssh -i "<path of your key file>" -L 4825:127.0.0.1:4825 -L 4317:127.0.0.1:4317 root@203.0.113.10');
  // The EditLens window's address in a notice: both lines.
  assert.strictEqual(answerAddress({ port: 4317, browser, env, user: 'root' }),
    'http://localhost:4317/answer (on your computer, after: ssh -L 4317:127.0.0.1:4317 root@203.0.113.10, or with a key file: ssh -i "<path of your key file>" -L 4317:127.0.0.1:4317 root@203.0.113.10)');
  assert.strictEqual(answerAddress({ port: 4317, browser: { ok: true }, env, user: 'root' }), 'http://localhost:4317/answer');
});

// ---- the line above the prompt and Details on a computer with no browser ----
const VPS = {
  control: 'manual', state: 'idle', pages: [], connection: { kind: 'static', url: 'http://127.0.0.1:4493/' },
  tokens: { main: 0 }, permissions: 0, integrations: [],
  paired: { host: [{ name: 'office-laptop-1', connected: true, here: false, folder: 'my-project' }], joined: [] },
  openFrom: { why: 'ssh', ssh: 'ssh -L 4493:127.0.0.1:4493 -L 4317:127.0.0.1:4317 root@198.51.100.7', sshKey: 'ssh -i "<path of your key file>" -L 4493:127.0.0.1:4493 -L 4317:127.0.0.1:4317 root@198.51.100.7', url: 'http://localhost:4493/', other: { name: 'office-laptop-1', folder: 'my-project' } },
};
function line(items) {
  return '✦ ' + items.map((it, i) => (i ? (it.button && items[i - 1].button ? '  ' : '   ') : '') + (it.button ? it.button.label : it.parts.map((p) => p.text).join(''))).join('');
}

test('band at 96 columns: the pairing names its folder, and "How to open" replaces a dead localhost link', () => {
  const items = mod.bandItems({ s: VPS, cols: 96 });
  const text = line(items);
  assert.strictEqual(text, '✦ ○ Manual   ◆ office-laptop-1 paired for my-project   Idle   How to open  Page control  Details');
  assert.ok(mod.cells(text) <= 96);
  const open = items.find((it) => it.id === 'b-open').button;
  assert.deepStrictEqual(open, { key: 'open', label: 'How to open', open: 'details' });
  assert.ok(!items.some((it) => it.button && it.button.href), 'no localhost link');
  // Narrower: the pairing shortens before it is removed, never back to just "paired".
  const narrow = line(mod.bandItems({ s: VPS, cols: 72 }));
  assert.match(narrow, /◆ paired for my-project|How to open/);
  assert.doesNotMatch(narrow, /laptop-1 paired(?! for)/);
  // The paired folder: as before.
  const here = { ...VPS, paired: { host: [{ name: 'office-laptop-1', connected: true, here: true, folder: 'my-project' }], joined: [] }, openFrom: { why: 'ssh', paired: { name: 'office-laptop-1', url: 'http://localhost:51234/', folder: 'my-project' } } };
  const hereItems = mod.bandItems({ s: here, cols: 96 });
  assert.strictEqual(line(hereItems), '✦ ○ Manual   ◆ office-laptop-1 paired   Idle   Open on office-laptop-1  Page control  Details');
  assert.strictEqual(hereItems.find((it) => it.id === 'b-open').button.href, 'http://localhost:51234/');
  // An open page: its own address works, so the plain Open link stays.
  const opened = mod.bandItems({ s: { ...VPS, pages: [{ url: 'http://localhost:4493/' }] }, cols: 96 });
  assert.strictEqual(opened.find((it) => it.id === 'b-open').button.href, 'http://localhost:4493/');
  // An older server (no here, no openFrom): unchanged.
  const old = mod.bandItems({ s: { ...VPS, openFrom: undefined, paired: { host: [{ name: 'office-laptop-1', connected: true }], joined: [] } }, cols: 96 });
  assert.match(line(old), /◆ office-laptop-1 paired {3}.*Open {2}Page control/);
});

test('F2: where pages need the page key, Details shows and links the address with it (D21)', () => {
  const key = '0123456789abcdef0123456789abcdef';
  // The server's address has the key (0.24.48); an older server's has none, and the summary's key is added.
  for (const url of ['http://localhost:4493/#editlens-key=' + key, 'http://localhost:4493/']) {
    const s = { ...VPS, pageKey: key, openFrom: { ...VPS.openFrom, url } };
    const row = mod.detailsModel(s).rows.find((r) => r.key === 'open-url');
    assert.strictEqual(row.parts.map((p) => p.text).join(''), 'then open http://localhost:4493/#editlens-key=' + key, url);
    assert.strictEqual(row.href, 'http://localhost:4493/#editlens-key=' + key, url);
    assert.match(mod.detailsText(s), new RegExp('then open http://localhost:4493/#editlens-key=' + key));
  }
  // An open page's row links its address with the key too; the text stays short.
  const opened = mod.detailsModel({ ...VPS, pageKey: key, pages: [{ url: 'http://localhost:4493/' }] }).rows.find((r) => r.key === 'page-0');
  assert.strictEqual(opened.href, 'http://localhost:4493/#editlens-key=' + key);
  assert.strictEqual(opened.parts.map((p) => p.text).join(''), 'localhost:4493');
});

test('Details: the SSH line and the paired computer, with the same wording', () => {
  const text = mod.detailsText(VPS);
  assert.match(text, /Open {8}No browser here\. On your computer run:/);
  assert.match(text, /ssh -L 4493:127\.0\.0\.1:4493 -L 4317:127\.0\.0\.1:4317 root@198\.51\.100\.7/);
  // Then the same with a key file, under its own dim label.
  const rows = mod.detailsModel(VPS).rows.map((r) => [r.key, r.parts.map((p) => p.text).join('')]);
  const at = rows.findIndex(([k]) => k === 'open-ssh');
  assert.deepStrictEqual(rows.slice(at + 1, at + 3), [['open-key', 'With a key file:'], ['open-ssh-key', 'ssh -i "<path of your key file>" -L 4493:127.0.0.1:4493 -L 4317:127.0.0.1:4317 root@198.51.100.7']]);
  // An older server (no sshKey): the plain line only.
  const old = mod.detailsModel({ ...VPS, openFrom: { ...VPS.openFrom, sshKey: undefined } });
  assert.ok(!old.rows.some((r) => r.key === 'open-ssh-key'));
  assert.match(text, /then open localhost:4493/);
  assert.match(text, /◆ office-laptop-1 is paired for my-project\. For this folder: \/editlens pair here, then \/editlens join on it\./);
  const m = mod.detailsModel(VPS);
  assert.ok(!m.buttons.some((b) => b.open), 'no "How to open" inside Details itself');
  const here = mod.detailsModel({ ...VPS, openFrom: { why: 'ssh', paired: { name: 'laptop-1', url: 'http://localhost:51234/' } } });
  const row = here.rows.find((r) => r.key === 'open');
  assert.strictEqual(row.href, 'http://localhost:51234/');
  assert.strictEqual(row.parts.map((p) => p.text).join(''), 'on ◆ laptop-1 · localhost:51234');
});

// ---- /editlens control on a computer with no browser, end to end ----
const app = path.join(base, 'site');
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>Site</title><p>hi</p>');
const other = path.join(base, 'my-project');
fs.mkdirSync(other);
const bin = path.join(base, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
const sdk = path.join(base, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.writeFileSync(path.join(sdk, 'sdk.mjs'), 'export {}\n');

function run(args, project = app) {
  const env = { ...process.env };
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'EDITLENS_TYPED', 'EDITLENS_NO_BROWSER', 'EDITLENS_SAY', 'CLAUDE_CODE_EXECPATH']) delete env[k];
  Object.assign(env, {
    CLAUDE_PROJECT_DIR: project, SSH_CONNECTION: '203.0.113.9 50000 198.51.100.7 2222', EDITLENS_SDK_DIR: path.join(base, 'sdk'),
    EDITLENS_CLAUDE_PATH: path.join(bin, 'claude'), CLAUDE_PLUGIN_OPTION_START: 'Connect the page',
  });
  const started = Date.now();
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js'), ...args], { env, timeout: 90000 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, out: String(stdout), err: String(stderr), ms: Date.now() - started });
    });
  });
}

// keyPath: the key file the laptop joined with (it says so when it joins).
function writePairing(cwd, keyPath) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'pair-host.json'), JSON.stringify({ direct: false, pairs: [
    { id: 'a'.repeat(32), key: 'b'.repeat(64), name: 'laptop-1', cwd, created: Date.now(), siteUrl: 'http://localhost:51234/', ...(keyPath ? { keyPath } : {}) },
  ] }));
}

const skipPosix = process.platform === 'win32' && 'the fake claude is a POSIX script';

test('/editlens control with no browser says how to open the page immediately, never a silent 2-minute wait', { skip: skipPosix }, async () => {
  const r = await run(['control']);
  assert.ok(r.ms < 30000, `took ${r.ms} ms:\n${r.out}`);
  const port = (r.out.match(/Page ·+ http:\/\/localhost:(\d+)\//) || [])[1];
  assert.ok(port, r.out);
  assert.doesNotMatch(r.out, /127\.0\.0\.1:\d+\/ /, 'one address');
  assert.doesNotMatch(r.out + r.err, /ENOENT|spawn|wasn't opened in time/);
  assert.match(r.out, /Control ·+ ○ Manual {2}page control starts when your page is open/);
  assert.match(r.out, /! Open your page from your computer {2}no browser here: you use this computer through SSH/);
  // Both lines alone on their own lines (nothing at the start, so they copy as they are): the plain
  // one, then the one with a key file under "With a key file:".
  const login = `-L ${port}:127.0.0.1:${port} -L ${PORT}:127.0.0.1:${PORT} -p 2222 ${os.userInfo().username}@198.51.100.7`;
  assert.ok(r.out.includes(`\n\nssh ${login}\n\nWith a key file:\n\nssh -i "<path of your key file>" ${login}\n`), r.out);
  assert.ok(r.out.includes('│  1  In a terminal on your computer, run one of the lines below and leave it open'), r.out);
  assert.ok(r.out.includes(`│  2  Open http://localhost:${port}/ there`), r.out);
  // Page control starts by itself when the page opens: no "Then /editlens control" step (0.24.41).
  assert.doesNotMatch(r.out, /Then \/editlens control/);
  // The line above the prompt gets the same advice from the server.
  const s = await getJson(`/summary?cwd=${encodeURIComponent(app)}`);
  assert.ok(s.openFrom && s.openFrom.ssh.includes(`-L ${port}:127.0.0.1:${port}`), JSON.stringify(s.openFrom));
  // Plain /editlens (Manual) says it too, with no page open.
  const plain = await run([]);
  assert.match(plain.out, /! Open your page from your computer/);
  assert.doesNotMatch(plain.out, /opened in your browser/);
});

test('paired for this folder: open it on the paired computer; paired for another: the SSH line and a note', { skip: skipPosix }, async () => {
  await stopServer();
  writePairing(app);
  const here = await run(['control']);
  assert.ok(here.ms < 30000, `took ${here.ms} ms`);
  assert.match(here.out, /! Open your page on ◆ laptop-1 {2}no browser here/);
  assert.match(here.out, /│ {5}http:\/\/localhost:51234\/ {2}it is paired with this folder/);
  assert.doesNotMatch(here.out, /ssh -L/);
  const s1 = await getJson(`/summary?cwd=${encodeURIComponent(app)}`);
  assert.deepStrictEqual(s1.paired.host.map((h) => [h.name, h.here, h.folder]), [['laptop-1', true, 'site']]);
  assert.deepStrictEqual(s1.openFrom.paired, { name: 'laptop-1', url: 'http://localhost:51234/', folder: 'site' });

  await stopServer();
  // The laptop joined with C:\Users\Jane Doe\.ssh\vps key: the key line has it, in quotes.
  writePairing(other, 'C:\\Users\\Jane Doe\\.ssh\\vps key');
  const elsewhere = await run(['control']);
  assert.match(elsewhere.out, /! Open your page from your computer/);
  assert.match(elsewhere.out, /\nssh -L \d+:127\.0\.0\.1:\d+ -L 4347:127\.0\.0\.1:4347 -p 2222 \S+@198\.51\.100\.7\n/);
  assert.match(elsewhere.out, /With a key file:\n\nssh -i "C:\\Users\\Jane Doe\\\.ssh\\vps key" -L \d+:127\.0\.0\.1:\d+ -L 4347:127\.0\.0\.1:4347 -p 2222 \S+@198\.51\.100\.7\n/);
  assert.doesNotMatch(elsewhere.out, /<path of your key file>/);
  assert.match(elsewhere.out, /◆ laptop-1 is paired for my-project, not this folder\. To open this folder there: \/editlens pair here, then the \/editlens join line it prints, on ◆ laptop-1\. That moves the pairing to this folder\./);
  const s2 = await getJson(`/summary?cwd=${encodeURIComponent(app)}`);
  assert.deepStrictEqual(s2.paired.host.map((h) => [h.here, h.folder]), [[false, 'my-project']]);
  assert.deepStrictEqual(s2.openFrom.other, { name: 'laptop-1', folder: 'my-project' });
  assert.match(s2.openFrom.sshKey, /^ssh -i "C:\\Users\\Jane Doe\\\.ssh\\vps key" -L /);
});

test('/editlens new with no browser: the starter page, then the SSH line and the same with a key file', { skip: skipPosix }, async () => {
  await stopServer();
  fs.rmSync(path.join(stateDir, 'pair-host.json'), { force: true });
  const empty = path.join(base, 'empty');
  fs.mkdirSync(empty);
  const r = await run(['new'], empty);
  assert.strictEqual(r.code, 0, r.out + r.err);
  assert.ok(fs.existsSync(path.join(empty, 'index.html')), r.out);
  assert.match(r.out, /made index\.html, a starter page/);
  const port = (r.out.match(/Page ·+ http:\/\/localhost:(\d+)\//) || [])[1];
  assert.ok(port, r.out);
  const login = `-L ${port}:127.0.0.1:${port} -L ${PORT}:127.0.0.1:${PORT} -p 2222 ${os.userInfo().username}@198.51.100.7`;
  const lines = r.out.split('\n');
  const plain = lines.indexOf(`ssh ${login}`);
  assert.ok(plain > 0, r.out);
  // Plain line, a blank, the dim label, a blank, the key line: each alone on its line.
  assert.deepStrictEqual(lines.slice(plain, plain + 5), [`ssh ${login}`, '', 'With a key file:', '', `ssh -i "<path of your key file>" ${login}`]);
  // The steps are shown first and point at them.
  assert.ok(lines.indexOf('│  1  In a terminal on your computer, run one of the lines below and leave it open') < plain, r.out);
  assert.ok(lines.indexOf(`│  2  Open http://localhost:${port}/ there`) < plain, r.out);
});
