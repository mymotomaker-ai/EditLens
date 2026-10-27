'use strict';
require('./isolate');
// /editlens in a folder that contains the app (or several), and page control finding the claude
// program when /editlens runs without CLAUDE_CODE_EXECPATH.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-apps-'));
const stateDir = path.join(base, 'state');
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4393';
const { appsIn, appsByRecent, rememberApp, recentApps, findIntegrations } = require('../lib/connect');
const { findClaude, versionDirs } = require('../server/driver');
const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function make(rel, files) {
  const dir = path.join(base, rel);
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
}

function start(cwd, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js'), ...args], { env: { ...process.env, CLAUDE_PROJECT_DIR: cwd } }, (err, stdout) => resolve({ code: err ? err.code : 0, out: String(stdout) }));
  });
}

test('appsIn: the folder itself, else the apps one level down (not node_modules or dot folders)', () => {
  const one = make('one', { 'web/package.json': '{"devDependencies":{"vite":"5"}}', 'notes/a.txt': 'x', 'node_modules/x/package.json': '{}', '.cache/package.json': '{}' });
  assert.deepStrictEqual(appsIn(one), [path.join(one, 'web')]);
  assert.deepStrictEqual(appsIn(path.join(one, 'web')), [path.join(one, 'web')]);
  assert.deepStrictEqual(appsIn(path.join(base, 'missing')), []);
  assert.deepStrictEqual(appsIn(os.homedir()).length <= 1, true);
});

test('several apps: the one connected last is shown first', () => {
  const many = make('many', { 'admin/index.html': '<p>', 'shop/package.json': '{}' });
  assert.deepStrictEqual(appsByRecent(many, stateDir).map((d) => path.basename(d)), ['admin', 'shop']);
  rememberApp(stateDir, path.join(many, 'shop'));
  assert.strictEqual(recentApps(stateDir)[0], path.join(many, 'shop'));
  assert.deepStrictEqual(appsByRecent(many, stateDir).map((d) => path.basename(d)), ['shop', 'admin']);
});

test('EditLens lines are found in apps inside the folder too', () => {
  const dir = make('lines', { 'site/index.html': '<script src="http://127.0.0.1:4317/live.js"></script>' });
  const found = findIntegrations(dir);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].rel, path.join('site', 'index.html'));
});

test('/editlens in a folder with several apps lists them; a folder name picks one; nothing found says so', async () => {
  const many = path.join(base, 'many');
  const listed = await start(many, []);
  assert.strictEqual(listed.code, 0);
  assert.match(listed.out, /more than one app/);
  assert.ok(listed.out.indexOf('/editlens shop') < listed.out.indexOf('/editlens admin'), listed.out);
  assert.match(listed.out, /shop {2}\(used last\)/);
  const unknown = await start(many, ['nope']);
  assert.strictEqual(unknown.code, 1);
  assert.match(unknown.out, /isn't something \/editlens knows/);
});

test('versionDirs sorts numerically, newest first', () => {
  const dir = make('desk/Claude/claude-code', { '2.1.9/x': '', '2.1.293/x': '', '2.10.0/x': '', 'junk/x': '' });
  assert.deepStrictEqual(versionDirs(dir), ['2.10.0', '2.1.293', '2.1.9']);
  assert.deepStrictEqual(versionDirs(path.join(base, 'nothing')), []);
});

test('findClaude finds the desktop app\'s copy of claude', () => {
  const appData = path.join(base, 'desk');
  const exe = path.join(appData, 'Claude', 'claude-code', '2.10.0', 'claude.exe');
  fs.writeFileSync(exe, '');
  // A Windows layout read through posix paths: only the lookup order matters here.
  const found = findClaude([], { platform: 'win32', env: { APPDATA: appData, PATH: '' }, home: path.join(base, 'home') });
  if (process.platform === 'win32') assert.strictEqual(found, exe);
  const mac = path.join(base, 'home', 'Library', 'Application Support', 'Claude', 'claude-code', '1.0.0');
  fs.mkdirSync(mac, { recursive: true });
  fs.writeFileSync(path.join(mac, 'claude'), '');
  if (process.platform !== 'win32') assert.strictEqual(findClaude([], { platform: 'darwin', env: { PATH: '' }, home: path.join(base, 'home') }), path.join(mac, 'claude'));
});

test('the server gives bin/drive.js the Claude program paths hooks reported, and keeps them across restarts', async () => {
  const exe = path.join(base, 'bin', 'claude');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  await ensureServer();
  try {
    await postJson('/event', { type: 'session', execPath: exe });
    await postJson('/event', { type: 'session', execPath: 'relative/claude' });
    assert.deepStrictEqual((await getJson('/claude-paths')).paths, [exe]);
    await stopServer();
    await ensureServer();
    assert.deepStrictEqual((await getJson('/claude-paths')).paths, [exe]);
  } finally {
    await stopServer();
  }
});

test('/claude-paths needs the token', async () => {
  await ensureServer();
  try {
    const status = await new Promise((resolve, reject) => {
      http.get('http://127.0.0.1:4393/claude-paths', (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.notStrictEqual(status, 200);
  } finally {
    await stopServer();
  }
});

test('/editlens in a folder with one app inside connects that app', async () => {
  try {
    const res = await start(path.join(base, 'one'), []);
    assert.match(res.out, /your app is in web/);
    // Vite isn't installed in the test app: the message is about that app, not "no app here".
    assert.match(res.out, /Vite is not installed/);
  } finally {
    await stopServer();
  }
});
