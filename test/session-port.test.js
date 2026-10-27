'use strict';
require('./isolate');
// The port a Claude Code session started with stays its port until Claude Code restarts: a Port
// setting changed meanwhile moves none of the hooks, the status line or the live-page MCP tools to
// another server (settings check S5, S6). Each child runs without EDITLENS_PORT, as Claude Code
// runs them; the ports here are this file's own.
process.env.EDITLENS_PORT = '5329';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killServer } = require('./kill');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'hooks', 'live-hook.js');
const MCP = path.join(ROOT, 'mcp', 'live-page.js');
const STATUS = path.join(ROOT, 'bin', 'statusline.js');

// A new state folder and Claude Code settings folder for one child.
function folders() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sport-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const state = path.join(dir, 'state');
  const claude = path.join(dir, 'claude');
  fs.mkdirSync(state);
  fs.mkdirSync(claude);
  return { dir, state, claude };
}

// The environment Claude Code gives a hook or an MCP server: no EDITLENS_PORT, no session of ours.
function childEnv(f, extra) {
  const env = { ...process.env, EDITLENS_STATE_DIR: f.state, CLAUDE_CONFIG_DIR: f.claude, EDITLENS_NO_START: '1', ...extra };
  for (const k of ['EDITLENS_PORT', 'EDITLENS_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PLUGIN_OPTION_PORT']) if (!(k in extra)) delete env[k];
  return env;
}

function keepPort(f, id, port) {
  fs.mkdirSync(path.join(f.state, 'session-ports'), { recursive: true });
  fs.writeFileSync(path.join(f.state, 'session-ports', id), String(port));
}

// A stand-in live server that records each request (method and path).
async function stub(port) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(`${req.method} ${req.url.split('?')[0]}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(req.url.startsWith('/pair') ? '{"pairs":[]}' : '{"ok":true,"messages":[],"pages":0}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  test.after(() => server.close());
  return seen;
}

function run(file, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(input);
  });
}

test('S5: a hook uses the port its session started with, not a Port setting changed since', async () => {
  const f = folders();
  const seen = await stub(5320);
  keepPort(f, 'sess-a', 5320);
  await run(HOOK, ['prompt'], childEnv(f, { CLAUDE_PLUGIN_OPTION_PORT: '5321' }), JSON.stringify({ session_id: 'sess-a', prompt: 'hi', cwd: f.dir }));
  assert.ok(seen.includes('POST /event'), `the session's server got the prompt: ${JSON.stringify(seen)}`);
});

test('S5: a start of Claude Code takes the Port setting; a compact keeps the session\'s port', async () => {
  const f = folders();
  // A session resumed after a restart: what was kept for it before is replaced.
  keepPort(f, 'sess-b', 5320);
  await run(HOOK, ['session'], childEnv(f, { CLAUDE_PLUGIN_OPTION_PORT: '5322' }), JSON.stringify({ session_id: 'sess-b', source: 'resume', cwd: f.dir }));
  assert.strictEqual(fs.readFileSync(path.join(f.state, 'session-ports', 'sess-b'), 'utf8'), '5322');
  assert.strictEqual(fs.readFileSync(path.join(f.state, 'port'), 'utf8'), '5322');
  // The same Claude Code process continues: its port stays, and the status line's file says it.
  await run(HOOK, ['session'], childEnv(f, { CLAUDE_PLUGIN_OPTION_PORT: '5321' }), JSON.stringify({ session_id: 'sess-b', source: 'compact', cwd: f.dir }));
  assert.strictEqual(fs.readFileSync(path.join(f.state, 'session-ports', 'sess-b'), 'utf8'), '5322');
  assert.strictEqual(fs.readFileSync(path.join(f.state, 'port'), 'utf8'), '5322');
});

test('S6: the live-page MCP tools use the Port setting\'s server, though Claude Code gives them no plugin options', async () => {
  const f = folders();
  const seen = await stub(5323);
  fs.writeFileSync(path.join(f.claude, 'settings.json'), JSON.stringify({ pluginConfigs: { 'editlens@market': { options: { port: 5323 } } } }));
  const calls = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_paired_computers', arguments: {} } },
  ];
  const child = spawn(process.execPath, [MCP], { env: childEnv(f, {}), stdio: ['pipe', 'pipe', 'pipe'] });
  test.after(() => child.kill());
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  for (const c of calls) child.stdin.write(JSON.stringify(c) + '\n');
  const started = Date.now();
  while (!/"id":2/.test(out) && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(seen.includes('GET /pair'), `the MCP server asked port 5323: ${JSON.stringify(seen)}`);
});

test('S6: with a session it knows, the MCP server uses the session\'s port over the setting', async () => {
  const f = folders();
  const seen = await stub(5324);
  keepPort(f, 'sess-d', 5324);
  fs.writeFileSync(path.join(f.claude, 'settings.json'), JSON.stringify({ pluginConfigs: { editlens: { options: { port: 5325 } } } }));
  const show = `process.stdout.write(String(require(${JSON.stringify(path.join(ROOT, 'lib', 'config.js'))}).port))`;
  const child = spawn(process.execPath, ['-e', show], { env: childEnv(f, { CLAUDE_CODE_SESSION_ID: 'sess-d' }), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => child.on('exit', resolve));
  assert.strictEqual(out, '5324');
  assert.deepStrictEqual(seen, []);
});

test('S5: the status line follows the port its session started with', async () => {
  const f = folders();
  const seen = await stub(5326);
  keepPort(f, 'sess-e', 5326);
  fs.writeFileSync(path.join(f.state, 'port'), '5327');
  await run(STATUS, [], childEnv(f, {}), JSON.stringify({ session_id: 'sess-e', model: { display_name: 'Opus' } }));
  assert.deepStrictEqual(seen, ['POST /status']);
});

test('S6: a server started from a process that read the Port setting listens on that port, though the setting changed since', async () => {
  const f = folders();
  const settingsFile = path.join(f.claude, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ pluginConfigs: { editlens: { options: { port: 5328 } } } }));
  // The process reads 5328, then the setting changes to 5321 before it starts the server.
  const script = `
    const fs = require('fs');
    const client = require(${JSON.stringify(path.join(ROOT, 'lib', 'client.js'))});
    fs.writeFileSync(${JSON.stringify(settingsFile)}, JSON.stringify({ pluginConfigs: { editlens: { options: { port: 5321 } } } }));
    client.ensureServer().then((r) => process.stdout.write(JSON.stringify(r)));`;
  const env = childEnv(f, {});
  delete env.EDITLENS_NO_START;
  const child = spawn(process.execPath, ['-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((resolve) => child.on('exit', resolve));
  const r = JSON.parse(out || '{}');
  // Only a server this test started, and only after /proc shows it is the server of this state folder.
  if (r.started === true && Number.isInteger(r.pid)) killServer(r.pid, f.state);
  // A server that listens elsewhere: stop it by its pid, from its own log in this test's state folder.
  const logs = fs.readdirSync(f.state).filter((n) => /^server-\d+\.log$/.test(n));
  for (const n of logs) {
    const m = /\(pid (\d+)\)/.exec(fs.readFileSync(path.join(f.state, n), 'utf8'));
    if (m && Number(m[1]) !== r.pid) killServer(Number(m[1]), f.state);
  }
  assert.strictEqual(r.started, true, out);
  assert.deepStrictEqual(logs, ['server-5328.log']);
});
