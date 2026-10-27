'use strict';
require('./isolate');
// /editlens always starts the server and connects the page; it also turns on page control when
// the start setting says so, never in a session EditLens started. /editlens restart restarts the
// server, then does the same; page control that ran starts again in its conversation in both cases.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-startrestart-'));
const PORT = 5260;
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(dir, 'live'), EDITLENS_PORT: String(PORT) });
const { ensureServer, stopServer, health } = require('../lib/client');
const settings = require('../lib/settings');

const proj = path.join(dir, 'proj');
fs.mkdirSync(proj, { recursive: true });
fs.writeFileSync(path.join(proj, 'index.html'), '<h1>Hi</h1>\n');
// A fake agent SDK and claude program, so trying page control downloads nothing.
const fake = path.join(dir, 'fake');
const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
fs.mkdirSync(path.join(fake, 'state'));
fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
// Named claude, as findClaude accepts only that name; else it looks on PATH (no claude on CI).
const exe = path.join(fake, 'bin', 'claude');
fs.mkdirSync(path.dirname(exe));
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
const KEEP = path.join(dir, 'live', 'page-control-on.json');

const ON = 'Connect and turn on page control';
const MANUAL = 'Connect the page';
// /editlens as Claude Code runs it, with no browser (so it never waits for a page to open).
function editlens(args, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_PLUGIN_OPTION_|^EDITLENS_(DRIVEN|NO_START|TYPED)$/.test(k)));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js'), ...args], {
      cwd: proj, timeout: 60000,
      env: { ...clean, CLAUDE_PROJECT_DIR: proj, EDITLENS_NO_BROWSER: '1', EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state'),
        CLAUDE_CODE_EXECPATH: exe, ...env },
    }, (err, stdout) => (err && err.killed ? reject(err) : resolve(stdout)));
  });
}
// Page control that was running when the server stopped for a restart (lib/pagekeep.js).
function keptControl() {
  fs.writeFileSync(KEEP, JSON.stringify({ cwd: proj, sessionId: null, version: '0.0.1', pid: 1, aliveAt: Date.now(), end: { reason: 'restart', at: Date.now() } }));
}
const TRIED = /page control starts when your page is open/;
const MANUAL_LINE = /Manual {2}you use Claude here/;

test.after(async () => {
  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('startsControlNow: asked, else the setting, never in a session EditLens started', () => {
  const on = { start: ON };
  const off = { start: MANUAL };
  assert.strictEqual(settings.startsControlNow({ values: on, env: {} }), true);
  assert.strictEqual(settings.startsControlNow({ values: off, env: {} }), false);
  assert.strictEqual(settings.startsControlNow({ asked: true, values: off, env: {} }), true, '/editlens control');
  assert.strictEqual(settings.startsControlNow({ values: on, env: { EDITLENS_DRIVEN: '1' } }), false, 'page control\'s own Claude');
  assert.strictEqual(settings.startsControlNow({ values: on, env: { EDITLENS_NO_START: '1' } }), false, 'a task');
  assert.strictEqual(settings.startsControlNow({ values: null, env: {} }), false);
});

test('/editlens: the server and the page always; page control only when the setting is on', async () => {
  await stopServer();
  const manual = await editlens([], { CLAUDE_PLUGIN_OPTION_START: MANUAL });
  assert.match(manual, /connected/);
  assert.match(manual, MANUAL_LINE);
  assert.doesNotMatch(manual, TRIED);
  assert.ok(await health(), 'the server runs');
  assert.match(await editlens([], { CLAUDE_PLUGIN_OPTION_START: ON }), TRIED);
  assert.match(await editlens([], { CLAUDE_PLUGIN_OPTION_START: ON, EDITLENS_NO_START: '1' }), MANUAL_LINE, 'a task: never');
  // A dev server's address follows the setting too (before 0.24.40 it never turned page control on).
  const site = http.createServer((req, res) => res.end('<h1>Dev</h1>'));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${site.address().port}`;
    assert.match(await editlens([url], { CLAUDE_PLUGIN_OPTION_START: ON }), TRIED);
    assert.match(await editlens([url], { CLAUDE_PLUGIN_OPTION_START: MANUAL }), MANUAL_LINE);
  } finally {
    site.close();
  }
});

test('/editlens restart: restarts, then does what /editlens does', async () => {
  await ensureServer();
  const before = (await health()).pid;
  // Setting off: connected in Manual; page control is not turned on.
  const off = await editlens(['restart'], { CLAUDE_PLUGIN_OPTION_START: MANUAL });
  assert.match(off, /restarted/);
  assert.match(off, /connected/);
  assert.match(off, MANUAL_LINE);
  assert.doesNotMatch(off, TRIED);
  const after = (await health()).pid;
  assert.ok(Number.isInteger(after) && after !== before, 'a new server');

  // Setting off, but the user had turned page control on (/editlens control): it starts again.
  keptControl();
  const back = await editlens(['restart'], { CLAUDE_PLUGIN_OPTION_START: MANUAL });
  assert.match(back, /Page control starts again/);
  // R1 (0.24.40): the Control field says so too, not Manual.
  assert.match(back, /Control ·+ ● Page control {2}starts again when the page reconnects/);
  assert.doesNotMatch(back, MANUAL_LINE);
  assert.doesNotMatch(back, /use Claude from the page/);

  // Setting on, nothing running before: it turns page control on, as /editlens does.
  fs.rmSync(KEEP, { force: true });
  const on = await editlens(['restart'], { CLAUDE_PLUGIN_OPTION_START: ON });
  assert.match(on, /restarted/);
  assert.match(on, TRIED);

  // Setting on, page control ran: it starts again in the same conversation when the page reconnects.
  keptControl();
  const kept = await editlens(['restart'], { CLAUDE_PLUGIN_OPTION_START: ON });
  assert.match(kept, new RegExp(`Page control starts again {2}in ${proj.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} when its page reconnects`));
  assert.doesNotMatch(kept, TRIED, 'not started a second time');

  // Claude running from the page can't restart EditLens.
  const driven = await editlens(['restart'], { CLAUDE_PLUGIN_OPTION_START: ON, EDITLENS_DRIVEN: '1' });
  assert.match(driven, /Claude running from the page can't restart EditLens/);
  assert.doesNotMatch(driven, /connected/);
});
