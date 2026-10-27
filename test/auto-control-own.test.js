'use strict';
require('./isolate');
// Sessions EditLens started (page control, a task from a paired computer) never turn page control on
// by themselves: the hook does not ask, and the server refuses a task's folder or session.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-own-'));
const PORT = 4322;
// npm_config_offline: the Agent SDK install of auto page control's setup uses npm's cache only, so it
// ends immediately and never downloads into this folder while the test removes it.
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(dir, 'live'), EDITLENS_PORT: String(PORT), npm_config_offline: 'true' });
test.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }));

const { ensureServer, stopServer } = require('../lib/client');
const config = require('../lib/config');
const { Tasks } = require('../server/tasks');

const proj = path.join(dir, 'proj');
const copy = path.join(proj, '.claude', 'worktrees', 'editlens-task-abc123');
const space = path.join(dir, 'live', 'workspaces', 'abc123');
for (const d of [proj, copy, space]) fs.mkdirSync(d, { recursive: true });

function auto(body) {
  const token = fs.readFileSync(path.join(config.stateDir, `token-${PORT}`), 'utf8');
  return fetch(`${config.baseUrl}/drive/auto`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': token }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, json: await r.json() }));
}
// The SessionStart hook, as Claude Code runs it; its stdout is what Claude is told.
function sessionStart(env) {
  const input = { session_id: 's-own', transcript_path: path.join(dir, 'none.jsonl'), cwd: proj, hook_event_name: 'SessionStart', source: 'startup' };
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_PLUGIN_OPTION_|^EDITLENS_(DRIVEN|NO_START|SAY)$/.test(k)));
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'session'],
      { cwd: proj, env: { ...clean, CLAUDE_PROJECT_DIR: proj, ...env }, timeout: 20000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin.end(JSON.stringify(input));
  });
}

test('Tasks.owns: a task copy, a workspace, a running task\'s folder or session', () => {
  const tasks = new Tasks({ stateDir: path.join(dir, 'live'), host: 'vps', makeDriver: () => null });
  assert.strictEqual(tasks.owns(copy, null), true);
  assert.strictEqual(tasks.owns(path.join(copy, 'src'), null), true);
  assert.strictEqual(tasks.owns(space, null), true);
  assert.strictEqual(tasks.owns(proj, null), false);
  assert.strictEqual(tasks.owns(path.join(proj, '.claude', 'worktrees', 'my-own'), null), false, 'a copy the user made');
  tasks.items.set('t1', { id: 't1', cwd: proj, dir: path.join(dir, 'other'), sessionId: 'sess-task' });
  assert.strictEqual(tasks.owns(proj, 'sess-task'), true);
  assert.strictEqual(tasks.owns(path.join(dir, 'other'), null), true);
  assert.strictEqual(tasks.owns(proj, 'sess-user'), false);
  assert.strictEqual(tasks.owns(undefined, undefined), false);
});

test('the server refuses auto page control for a task\'s folder; the hook of an EditLens session does not ask', async (t) => {
  await stopServer();
  await ensureServer();
  t.after(() => stopServer());

  const own = await auto({ cwd: proj, sessionId: 's1' });
  assert.deepStrictEqual([own.status, own.json.ok], [200, true], 'the user\'s own project');
  for (const cwd of [copy, space]) {
    const r = await auto({ cwd, sessionId: 's2' });
    assert.strictEqual(r.status, 400, cwd);
    assert.match(r.json.error, /EditLens started this session/);
  }

  const asks = /page control turns on by itself/;
  const said = await sessionStart({});
  assert.match(said, asks, 'a session the user started asks');
  assert.match(said, /the user runs \/editlens \(or \/editlens <port or address> for a running dev server\)/);
  assert.doesNotMatch(await sessionStart({ EDITLENS_DRIVEN: '1' }), asks, 'page control or a task does not');

  // Sol M1: /editlens control run by a task's Claude in its copy, with the project's page open.
  const token = fs.readFileSync(path.join(config.stateDir, `token-${PORT}`), 'utf8');
  const stream = new AbortController();
  await fetch(`${config.baseUrl}/events?page=p-own&root=${encodeURIComponent(proj)}`, { signal: stream.signal });
  for (const cwd of [copy, space]) {
    const r = await fetch(`${config.baseUrl}/drive/grant`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': token }, body: JSON.stringify({ cwd }) });
    const json = await r.json();
    assert.strictEqual(r.status, 403, `${cwd}: ${JSON.stringify(json)}`);
    assert.match(json.error, /EditLens started this session/);
  }
  stream.abort();
  // /editlens run by page control's own Claude, with the start setting on: Manual, never page control.
  fs.writeFileSync(path.join(proj, 'index.html'), '<h1>x</h1>');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_PLUGIN_OPTION_|^EDITLENS_(DRIVEN|NO_START|SAY)$/.test(k)));
  const typed = await new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js')], { cwd: proj, timeout: 30000,
      env: { ...clean, CLAUDE_PROJECT_DIR: proj, EDITLENS_NO_BROWSER: '1', EDITLENS_DRIVEN: '1', CLAUDE_PLUGIN_OPTION_START: 'Connect and turn on page control' } },
    (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
  assert.match(typed, /Manual/, typed);
  assert.doesNotMatch(typed, /Set up page control|Type in the panel/, typed);
});

// The setup auto page control starts (bin/drive.js) ends with the server that started it: it never
// starts a server again after that server stopped (it had left one running after the test above).
test('auto page control\'s setup never starts a server after the server stopped', async () => {
  const { health } = require('../lib/client');
  await stopServer();
  await ensureServer();
  const stream = new AbortController();
  const page = fetch(`${config.baseUrl}/events?page=p-setup&root=${encodeURIComponent(proj)}`, { signal: stream.signal }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  const r = await auto({ cwd: proj, sessionId: 's-setup' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const log = path.join(config.stateDir, 'auto-control.log');
  for (let i = 0; i < 100 && !fs.existsSync(log); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(fs.existsSync(log), 'the setup started');
  stream.abort();
  await page;
  await stopServer();
  await new Promise((res) => setTimeout(res, 6000));
  const back = await health();
  if (back) await stopServer();
  assert.strictEqual(back, null, `a server is running again: ${JSON.stringify(back)}`);
});
