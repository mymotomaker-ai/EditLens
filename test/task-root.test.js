'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4386';
// Root (unsafe) for paired computers' tasks: the setting alone changes nothing; the EditLens window
// asks, behind a red all-caps warning; only Allow there turns it on (kept across restarts), Keep
// the safe account declines it, and setting it back to Auto turns it off. Runs as root on Linux
// only (elsewhere the choice doesn't exist).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { windowKey, pageText } = require('./answer-helper');
const { stopChildren } = require('./launch');

const LIVE = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
const PORT = 4386;
const base = `http://127.0.0.1:${PORT}`;
const SERVER = path.join(__dirname, '..', 'server', 'server.js');

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

test('running tasks as root needs Allow in the EditLens window', { skip: !LIVE && 'root on Linux only' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-root-'));
  let child = null;
  const start = (setting) => {
    child = spawn(process.execPath, [SERVER], { env: { ...process.env, EDITLENS_PORT: String(PORT), EDITLENS_PAIR_PORT: String(PORT + 1), EDITLENS_STATE_DIR: dir, CLAUDE_PLUGIN_OPTION_TASK_ACCOUNT: setting }, stdio: 'ignore' });
    return waitFor(async () => (await fetch(`${base}/health`)).ok);
  };
  const stop = async () => {
    child.kill();
    await waitFor(async () => !(await fetch(`${base}/health`).then(() => true, () => false)));
  };
  t.after(async () => {
    // The server saves its state as it exits: remove its folder only after it has ended.
    await stopChildren([child]);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const list = async () => {
    const key = await windowKey(base);
    const headers = { 'content-type': 'application/json', 'x-editlens-answer': key, 'sec-fetch-site': 'same-origin' };
    return { headers, qs: (await (await fetch(`${base}/answer/list`, { headers })).json()).questions };
  };
  const rootFile = path.join(dir, 'task-root.json');

  await start('Root (unsafe)');
  const asked = await waitFor(async () => (await list()).qs.find((q) => q.kind === 'root'));
  assert.ok(asked, 'the EditLens window asks');
  assert.match(asked.title, /^RUN PAIRED COMPUTERS' TASKS AS ROOT$/);
  assert.ok(asked.danger);
  const words = asked.warning.replace('/editlens task-user', '');
  assert.strictEqual(words, words.toUpperCase(), 'the warning is in capitals (the command as typed)');
  assert.match(asked.warning, /ANYTHING ON THIS COMPUTER/);
  assert.ok(!fs.existsSync(rootFile), 'the setting alone turns nothing on');
  // The window's page shows it in red, safe choice first.
  const html = await pageText(base);
  assert.match(html, /\.q\.danger\{border:2px solid var\(--del\)\}/);
  assert.match(html, /'Keep the safe account'\], \['allow', 'deny', 'Run tasks as root'\]/);

  // A page (or anything without the window's key) can't allow it.
  assert.strictEqual((await fetch(`${base}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'root', id: asked.id, decision: 'allow' }) })).status, 403);

  // Keep the safe account: declined, not asked again while the setting stays.
  let w = await list();
  assert.strictEqual((await fetch(`${base}/answer`, { method: 'POST', headers: w.headers, body: JSON.stringify({ kind: 'root', id: asked.id, decision: 'deny' }) })).status, 200);
  await new Promise((r) => setTimeout(r, 3500));
  assert.ok(!(await list()).qs.some((q) => q.kind === 'root'));
  assert.ok(!fs.existsSync(rootFile));

  // After a restart it asks again; Allow turns it on, and it stays on across a restart.
  await stop();
  await start('Root (unsafe)');
  const again = await waitFor(async () => (await list()).qs.find((q) => q.kind === 'root'));
  w = await list();
  assert.strictEqual((await fetch(`${base}/answer`, { method: 'POST', headers: w.headers, body: JSON.stringify({ kind: 'root', id: again.id, decision: 'allow' }) })).status, 200);
  assert.ok(fs.existsSync(rootFile), 'on');
  await stop();
  await start('Root (unsafe)');
  await new Promise((r) => setTimeout(r, 500));
  assert.ok(!(await list()).qs.some((q) => q.kind === 'root'), 'still on: not asked again');

  // Back to Auto: off, and it is never turned on again by itself.
  await stop();
  await start('Auto');
  assert.ok(await waitFor(async () => !fs.existsSync(rootFile)), 'off again');
  await stop();
  await start('Root (unsafe)');
  assert.ok(await waitFor(async () => (await list()).qs.some((q) => q.kind === 'root')), 'asked again, never on by itself');
  assert.ok(!fs.existsSync(rootFile));
});
