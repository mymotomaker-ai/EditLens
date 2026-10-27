'use strict';
require('./isolate');
// hooks/live-hook.js limits: hook input has a size limit and a read deadline, SessionStart's steps
// share one deadline, a shared file copy that failed is checked, and the "no dev server" advice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { PassThrough } = require('stream');
const { spawn } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-live-hook-'));
process.env.EDITLENS_PORT = '5248';
process.env.EDITLENS_STATE_DIR = path.join(base, 'state');
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');
const hookLib = require('../hooks/live-hook');

// The hook's environment without this session's Claude Code and plugin settings.
function cleanEnv(extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDE_PLUGIN_OPTION_|CLAUDE_PROJECT_DIR$|EDITLENS_(NO_START|DRIVEN|DISABLE|PORT)$)/.test(k)));
  return { ...env, ...extra };
}

function run(phase, env, input) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [HOOK, phase], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (code, signal) => {
      clearTimeout(kill);
      resolve({ code, signal, out, ms: Date.now() - started });
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

test('M17: hook input over the size limit or not complete in time is refused', { timeout: 30000 }, async () => {
  const ok = new PassThrough();
  const got = hookLib.readStdin(ok, { maxBytes: 10, timeoutMs: 1000 });
  ok.end('{"a":1}');
  assert.strictEqual(await got, '{"a":1}');

  const big = new PassThrough();
  const tooBig = hookLib.readStdin(big, { maxBytes: 10, timeoutMs: 1000 });
  big.write('x'.repeat(11));
  await assert.rejects(tooBig, { code: 'E2BIG' });

  const slow = new PassThrough();
  const started = Date.now();
  const late = hookLib.readStdin(slow, { maxBytes: 10, timeoutMs: 200 });
  slow.write('{');
  await assert.rejects(late, { code: 'ETIMEDOUT' });
  assert.ok(Date.now() - started < 1000);
});

test('M17: a hook whose input never ends exits by itself', { timeout: 30000 }, async () => {
  const port = await freePort();
  const r = await run('end', cleanEnv({ EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: path.join(base, 'state-m17') }));
  assert.strictEqual(r.signal, null, 'not killed by the test');
  assert.strictEqual(r.code, 0);
  assert.ok(r.ms < 9000, `${r.ms} ms`);
  assert.match(fs.readFileSync(path.join(base, 'state-m17', 'hooks.log'), 'utf8'), /hook input not complete/);
});

test('M18: the steps of a phase share one deadline', { timeout: 30000 }, async () => {
  const clock = hookLib.phaseClock(300);
  const started = Date.now();
  const never = () => new Promise(() => {});
  assert.strictEqual(await hookLib.inTime(clock, 'first', never, 'late'), 'late');
  assert.ok(Date.now() - started >= 250 && Date.now() - started < 1000);
  let ran = false;
  assert.strictEqual(await hookLib.inTime(clock, 'second', () => { ran = true; return 'done'; }, 'late'), 'late');
  assert.strictEqual(ran, false, 'no time left: the step does not run');
  const fresh = hookLib.phaseClock(1000);
  assert.strictEqual(await hookLib.inTime(fresh, 'fails', () => { throw new Error('no'); }, 'late'), 'late');
  assert.strictEqual(await hookLib.inTime(fresh, 'works', async () => 'done', 'late'), 'done');
});

test('M18: SessionStart answers within its 10 s when the server does not answer', { timeout: 30000 }, async (t) => {
  // /health answers (the same version, so no new server is started); every other request waits.
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: require('../package.json').version, uid: typeof process.getuid === 'function' ? process.getuid() : null }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const project = path.join(base, 'site');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'index.html'), '<h1>Hi</h1>\n');
  const env = cleanEnv({ EDITLENS_PORT: String(server.address().port), EDITLENS_STATE_DIR: path.join(base, 'state-m18'), CLAUDE_PROJECT_DIR: project });
  const r = await run('session', env, JSON.stringify({ session_id: 's1', cwd: project, source: 'startup', hook_event_name: 'SessionStart' }));
  assert.strictEqual(r.code, 0);
  assert.ok(r.ms < 9800, `${r.ms} ms`);
  assert.match(r.out, /EditLens is on/, 'the context is still written');
});

test('L9: a failed write of a shared copy is fine only when the file has the same text', { timeout: 30000 }, () => {
  const file = path.join(base, 'shared.txt');
  const busy = () => { throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
  fs.writeFileSync(file, 'same');
  assert.doesNotThrow(() => hookLib.writeShared(file, 'same', busy));
  fs.writeFileSync(file, 'other');
  assert.throws(() => hookLib.writeShared(file, 'same', busy), { code: 'EPERM' });
  hookLib.writeShared(file, 'new');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
});

test('L10: a project whose dev server is not running gets the advice to start it', { timeout: 30000 }, async () => {
  const port = await freePort();
  const project = path.join(base, 'app');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ scripts: { dev: `node server.js --port ${port}` } }));
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = project;
  try {
    const text = await hookLib.autoConnect({ cwd: project, session_id: 's1' });
    assert.match(text, /dev server isn't running, so its page isn't connected\. If the user wants the page, tell them to start it \(npm run dev\)/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = saved;
  }
});
