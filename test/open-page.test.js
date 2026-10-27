'use strict';
require('./isolate');
// A plain /editlens in Manual opens the page in the browser only when the person typed it at
// this computer's prompt (the mod sets EDITLENS_TYPED=1), no page of the project is open, and
// there is a screen (not through SSH). A fake xdg-open records what would have been opened.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-open-'));
const stateDir = path.join(base, 'state');
const PORT = '4349';
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = PORT;
const http = require('http');
const { stopServer, getJson } = require('../lib/client');

const app = path.join(base, 'site');
fs.mkdirSync(app, { recursive: true });
fs.writeFileSync(path.join(app, 'index.html'), '<!doctype html><title>Site</title><p>hi</p>');
const bin = path.join(base, 'bin');
fs.mkdirSync(bin);
const opened = path.join(base, 'opened.txt');
fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });

test.after(async () => {
  await stopServer().catch((err) => process.stderr.write(`could not stop the test server: ${err.message}\n`));
  fs.rmSync(base, { recursive: true, force: true });
});

// The SSH and display variables of the computer running the test are replaced by the case's own.
function start(env) {
  const clean = { ...process.env };
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'DISPLAY', 'WAYLAND_DISPLAY', 'EDITLENS_TYPED', 'EDITLENS_NO_BROWSER', 'EDITLENS_SAY']) delete clean[k];
  return new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js')], {
      env: { ...clean, PATH: bin + path.delimiter + process.env.PATH, CLAUDE_PROJECT_DIR: app, CLAUDE_PLUGIN_OPTION_START: 'Connect the page', ...env },
      timeout: 60000,
    }, (err, stdout) => resolve({ code: err ? err.code : 0, out: String(stdout) }));
  });
}

const calls = () => (fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').split('\n').filter(Boolean) : []);
// xdg-open is started detached: give it a moment to write.
const settle = () => new Promise((r) => setTimeout(r, 400));

test('plain /editlens opens the page only when typed, with a screen, and with no page open', { skip: process.platform !== 'linux' && 'the fake opener is xdg-open (Linux)' }, async () => {
  const notTyped = await start({ DISPLAY: ':0' });
  await settle();
  assert.strictEqual(notTyped.code, 0, notTyped.out);
  assert.match(notTyped.out, /Page ·+ http:\/\/(localhost|127\.0\.0\.1):\d+\//);
  assert.deepStrictEqual(calls(), [], 'not typed: nothing opened');

  const ssh = await start({ DISPLAY: ':0', EDITLENS_TYPED: '1', SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' });
  await settle();
  assert.deepStrictEqual(calls(), [], 'through SSH: nothing opened');
  assert.doesNotMatch(ssh.out, /opened in your browser/);

  const noScreen = await start({ EDITLENS_TYPED: '1' });
  await settle();
  assert.deepStrictEqual(calls(), [], 'no display: nothing opened');

  const typed = await start({ DISPLAY: ':0', EDITLENS_TYPED: '1' });
  await settle();
  assert.strictEqual(typed.code, 0, typed.out);
  assert.strictEqual(calls().length, 1, typed.out);
  assert.match(calls()[0], /^http:\/\/(localhost|127\.0\.0\.1):\d+\/$/);
  assert.match(typed.out, /opened in your browser/);
});

test('a page of the project already open: /editlens does not open another one', { skip: process.platform !== 'linux' && 'the fake opener is xdg-open (Linux)' }, async () => {
  const before = calls().length;
  const url = (await start({})).out.match(/http:\/\/\S+\//)[0];
  // The page's script keeps an event stream open, saying its address and project folder.
  const q = new URLSearchParams({ page: 'p1', url, title: 'Site', root: app });
  const req = http.get(`http://127.0.0.1:${PORT}/events?${q}`);
  req.on('error', (err) => { if (err.code !== 'ECONNRESET') throw err; });
  try {
    await new Promise((resolve) => req.on('response', resolve));
    const s = await getJson(`/summary?cwd=${encodeURIComponent(app)}`);
    assert.strictEqual(s.pages.length, 1);
    const again = await start({ DISPLAY: ':0', EDITLENS_TYPED: '1' });
    await settle();
    assert.strictEqual(calls().length, before, again.out);
    assert.doesNotMatch(again.out, /opened in your browser/);
  } finally {
    req.destroy();
  }
});
