'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5273';
// Medium findings of the Sol scan of 0.24.40 (findings-0.24.40-sol.md), one test each, written
// first and run on the code before its fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol-m-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// The live-page MCP server with a stand-in EditLens server; -> the text of one tool call.
async function mcpCall(handler, name, args, { cwd, env: extra } = {}) {
  const server = http.createServer(handler);
  const port = await listen(server);
  const env = { ...process.env, EDITLENS_PORT: String(port), EDITLENS_NO_START: '1' };
  delete env.CLAUDE_PROJECT_DIR;
  Object.assign(env, extra);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
  let buf = '';
  const answer = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      buf += d;
      const line = buf.split('\n').find((l) => l.trim());
      if (line && buf.includes('\n')) resolve(JSON.parse(line));
    });
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  let timer = null;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), 10000); });
    const msg = await Promise.race([answer, timeout]);
    return { text: msg.result.content.map((c) => c.text).join('\n'), isError: msg.result.isError === true };
  } finally {
    clearTimeout(timer);
    child.kill();
    server.close();
  }
}

test('M2: apply_computer_task with dry_run lists what it would apply, without an error', async () => {
  const project = fs.mkdtempSync(path.join(base, 'm2-'));
  fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  const state = fs.mkdtempSync(path.join(base, 'm2-state-'));
  const task = 'abcdef012345';
  fs.mkdirSync(path.join(state, 'sent'));
  fs.writeFileSync(path.join(state, 'sent', `${task}.json`), JSON.stringify({ dir: project, manifest: { 'a.txt': require('crypto').createHash('sha256').update('one\n').digest('hex') } }));
  const out = await mcpCall((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/remote/task' && JSON.parse(body).op === 'changes') return res.end(JSON.stringify({ kind: 'sent', state: 'idle', files: [{ path: 'a.txt', status: 'changed', hash: 'x'.repeat(64), size: 4 }] }));
      if (req.url === '/remote/task') return res.end(JSON.stringify({ task, computer: 'vps', prompt: 'x' }));
      res.statusCode = 404;
      return res.end('{}');
    });
  }, 'apply_computer_task', { computer: 'vps', task, dry_run: true }, { cwd: project, env: { EDITLENS_STATE_DIR: state, CLAUDE_PROJECT_DIR: project } });
  assert.strictEqual(out.isError, false, out.text);
  assert.match(out.text, /a\.txt \(changed\)/);
  assert.strictEqual(fs.readFileSync(path.join(project, 'a.txt'), 'utf8'), 'one\n', 'a dry run writes nothing');
});

test('M1: a remove asked for an edit from before the other computer restarted does not match a new edit', async () => {
  const { createHostRestore, createRemoteRestore } = require('../server/remote-restore');
  const project = fs.mkdtempSync(path.join(base, 'm1-'));
  fs.writeFileSync(path.join(project, 'a.txt'), 'new file after the restart\n');
  // After a restart here, edit 5 is a new file with the same name as the old edit 5's.
  const history = [{ type: 'change', seq: 5, file: path.join(project, 'a.txt'), relFile: 'a.txt', cwd: project, created: true, backup: null }];
  const host = createHostRestore({ history, backups: {}, undo: {}, restoreEvent: () => {}, log: () => {}, instance: 'b'.repeat(16) });
  const pair = { name: 'laptop', cwd: project };
  const old = host.handle(pair, { do: 'remove', seq: 5, backup: null, rel: 'a.txt', inst: 'a'.repeat(16), check: true });
  assert.strictEqual(old.status, 404, JSON.stringify(old));
  const now = host.handle(pair, { do: 'remove', seq: 5, backup: null, rel: 'a.txt', inst: 'b'.repeat(16), check: true });
  assert.deepStrictEqual([now.status, now.body.ok, now.body.exists], [200, true, true]);
  // The asking computer sends the instance the edit came with.
  const asked = [];
  const remote = createRemoteRestore({
    history: [{ type: 'change', seq: 9, relFile: '◆ vps: a.txt', remote: { computer: 'vps', link: 'k', ref: { seq: 5, backup: null, rel: 'a.txt', inst: 'b'.repeat(16) } } }],
    pairs: { editRestore: async (link, body) => { asked.push(body); return { answer: { status: 200, body: { ok: true, exists: true } } }; } },
    follow: () => {},
  });
  const t = remote.target({ remove: 9 });
  await remote.handle({ root: null }, { remove: 9, check: true }, t);
  assert.strictEqual(asked[0].inst, 'b'.repeat(16));
});

test('M5: a copy counts the bytes it received, not the sizes the other computer listed', async () => {
  const remotework = require('../lib/remotework');
  const dir = fs.mkdtempSync(path.join(base, 'm5-'));
  const big = Buffer.alloc(80, 'x').toString('base64');
  const call = async (op, args) => {
    if (op === 'project-files' && !Array.isArray(args.hash)) return { root: '/there', kind: 'folder', files: [{ path: 'a.txt', size: 10 }, { path: 'b.txt', size: 10 }], next: null };
    if (op === 'project-files') return { shas: {} };
    if (op === 'project-file') return { data: big, next: null };
    return { error: 'unknown' };
  };
  const out = await remotework.copyFrom(call, { from: '.', dir, stateDir: path.join(base, 'm5-state'), totalMax: 100 });
  assert.ok(!fs.existsSync(path.join(dir, 'b.txt')), 'the second file, past the limit, is not written');
  assert.match(JSON.stringify(out), /over the 0\.0001 MB|over the limit|MB a copy may receive/);
});

test('M7: a static file stream is closed when the browser leaves before the end', { skip: process.platform !== 'linux' && 'reads /proc/self/fd' }, async () => {
  const { staticHandler } = require('../server/static');
  const root = fs.mkdtempSync(path.join(base, 'm7-'));
  fs.writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(32 * 1024 * 1024, 1));
  const handler = staticHandler(root, (html) => html);
  const server = http.createServer((req, res) => { handler(req, res); });
  const port = await listen(server);
  const openFds = () => fs.readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return fs.readlinkSync(path.join('/proc/self/fd', fd)).endsWith('big.bin');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'EINVAL') return false;
      throw err;
    }
  }).length;
  try {
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/big.bin' }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => resolve());
    });
    await new Promise((r) => setTimeout(r, 500));
    assert.strictEqual(openFds(), 0, 'the file is not left open');
  } finally {
    server.close();
  }
});

// A server that sends its headers, a little of the body, then (cut) closes or (trickle) sends a
// byte sometimes without ending.
async function badServer(how) {
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"ok":');
    if (how === 'cut') setTimeout(() => res.socket.destroy(), 50);
    else {
      const t = setInterval(() => res.write(' '), 150);
      res.on('close', () => clearInterval(t));
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  const port = await listen(server);
  return { port, close: () => { for (const s of sockets) s.destroy(); server.close(); } };
}

test('M8: a request whose response ends early, or never ends, fails instead of waiting forever', async () => {
  for (const how of ['cut', 'trickle']) {
    const bad = await badServer(how);
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'client'))}).request('GET', '/health', undefined, 500).then(() => console.log('answered'), (e) => console.log('failed ' + e.code))`],
      { env: { ...process.env, EDITLENS_PORT: String(bad.port) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const code = await new Promise((resolve) => {
      const kill = setTimeout(() => child.kill(), 9000);
      child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
    });
    bad.close();
    assert.match(out, /^failed E[A-Z]+/m, `${how}: ${out} (exit ${code})`);
  }
});

test('M8: the status line prints even when the response ends early or never ends', async () => {
  for (const how of ['cut', 'trickle']) {
    const bad = await badServer(how);
    const state = fs.mkdtempSync(path.join(base, 'm8-'));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'statusline.js')],
      { env: { ...process.env, EDITLENS_PORT: String(bad.port), EDITLENS_STATE_DIR: state }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.stdin.end(JSON.stringify({ session_id: 's1', cwd: state, model: { display_name: 'Model' } }));
    const code = await new Promise((resolve) => {
      const kill = setTimeout(() => child.kill(), 6000);
      child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
    });
    bad.close();
    assert.strictEqual(code, 0, `${how}: ${out}`);
  }
});

test('M12: the SessionStart hook ends within its 9 s, counted from its start, even when its input is slow', async (t) => {
  // A stand-in server that takes every request and never answers: each step waits as long as it may.
  const server = http.createServer(() => {});
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const project = path.join(base, 'm12');
  fs.mkdirSync(project, { recursive: true });
  const started = Date.now();
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'session'], {
    env: { ...process.env, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: path.join(base, 'm12-state'), EDITLENS_NO_START: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  setTimeout(() => child.stdin.end(JSON.stringify({ session_id: 'm12', cwd: project, source: 'startup' })), 4500);
  await new Promise((resolve) => child.on('exit', resolve));
  const took = Date.now() - started;
  assert.ok(took < 9700, `took ${took} ms; Claude Code stops the hook at 10 s`);
});

// What test/isolate.js gives a test started with this computer's real paths in its environment.
function isolated(env) {
  const r = require('child_process').spawnSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'isolate'))});
    const { findClaude } = require(${JSON.stringify(path.join(__dirname, '..', 'server', 'driver'))});
    const keys = ['EDITLENS_TEST_PASSWD', 'CLAUDE_CONFIG_DIR', 'EDITLENS_STATE_DIR', 'EDITLENS_CLAUDE_PATH', 'CLAUDE_CODE_EXECPATH', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'];
    const out = Object.fromEntries(keys.map((k) => [k, process.env[k] || null]));
    out.found = findClaude([]);
    const fs = require('fs');
    out.foundReal = out.found && fs.realpathSync(out.found);
    out.execReal = fs.realpathSync(process.env.CLAUDE_CODE_EXECPATH);
    out.hookFiles = null;
    out.hooks = require('child_process').execFileSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim();
    out.hookFiles = fs.readdirSync(out.hooks).length;
    console.log(JSON.stringify(out));`], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('M15, M16, M20: isolate always uses its own temporary paths, the stand-in claude, and an empty git setup', () => {
  const real = path.join(base, 'real-home');
  fs.mkdirSync(path.join(real, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(real, 'bin', 'claude'), '#!/bin/sh\necho real\n', { mode: 0o755 });
  const out = isolated({
    // The real folders are only named here: the child prints what isolate chose and writes nothing.
    EDITLENS_TEST_PASSWD: '/etc/passwd', CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude'), EDITLENS_STATE_DIR: path.join(os.homedir(), '.claude', 'editlens'),
    CLAUDE_CODE_EXECPATH: path.join(real, 'bin', 'claude'), EDITLENS_CLAUDE_PATH: '', PATH: path.join(real, 'bin') + path.delimiter + process.env.PATH,
  });
  for (const k of ['EDITLENS_TEST_PASSWD', 'CLAUDE_CONFIG_DIR', 'EDITLENS_STATE_DIR', 'GIT_CONFIG_GLOBAL']) {
    assert.ok(out[k] && out[k].startsWith(os.tmpdir() + path.sep) && out[k].includes('editlens-isolate-'), `${k}: ${out[k]}`);
  }
  const fake = fs.realpathSync(path.join(__dirname, 'fixtures', 'fake-claude.js'));
  assert.strictEqual(path.basename(out.found || ''), 'claude', `found ${out.found}`);
  assert.strictEqual(out.foundReal, fake);
  assert.strictEqual(out.execReal, fake);
  assert.strictEqual(out.GIT_CONFIG_NOSYSTEM, '1');
  assert.strictEqual(out.hookFiles, 0, `hooks: ${out.hooks}`);
  // A home folder inside the temporary folder (an account made for tests): its real folders are replaced too.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-home-'));
  try {
    fs.mkdirSync(path.join(home, '.claude', 'editlens'), { recursive: true });
    const inHome = isolated({ HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), EDITLENS_STATE_DIR: path.join(home, '.claude', 'editlens') });
    for (const k of ['CLAUDE_CONFIG_DIR', 'EDITLENS_STATE_DIR']) assert.ok(inHome[k].includes('editlens-isolate-'), `${k}: ${inHome[k]}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
  // A test's own temporary folder in the run's private folder, set before isolate, is kept (a test
  // that starts another).
  const own = require('./isolate').tempInRun('editlens-own-');
  try {
    assert.strictEqual(isolated({ EDITLENS_STATE_DIR: own }).EDITLENS_STATE_DIR, own);
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});

// Sol M18: a preview whose browser can't start stops its EditLens server before it ends.
const PLAYWRIGHT = (() => {
  try {
    return require.resolve('playwright');
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') return null;
    throw err;
  }
})();
test('M18: a preview whose browser does not start leaves no EditLens server running', { skip: !PLAYWRIGHT && 'playwright is not installed' }, async () => {
  const script = path.join(__dirname, 'codeview-preview.js');
  const previewPort = Number(/EDITLENS_PORT: '(\d+)'/.exec(fs.readFileSync(script, 'utf8'))[1]);
  const r = require('child_process').spawnSync(process.execPath, [script, path.join(base, 'm18-out')], {
    encoding: 'utf8', timeout: 60000, env: { ...process.env, PW_CHROMIUM: path.join(base, 'no-browser-here') },
  });
  assert.notStrictEqual(r.status, 0, 'the preview fails');
  const open = await new Promise((resolve) => {
    const s = require('net').connect(previewPort, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
  });
  assert.strictEqual(open, false, `port ${previewPort} still answers: ${r.stderr.slice(0, 300)}`);
});

// Sol advice (lib/client.js): an answer is read up to a limit, then the request fails.
test('advice: an answer over 64 MB is not read into memory', async (t) => {
  const chunk = Buffer.alloc(1024 * 1024, 120);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    let n = 0;
    const more = () => {
      while (n < 70) {
        n++;
        if (!res.write(chunk)) return res.once('drain', more);
      }
      return res.end();
    };
    more();
  });
  const port = await listen(server);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'client'))}).request('GET', '/x', undefined, 5000)
    .then((a) => console.log('answered ' + a.body.length), (e) => console.log('failed ' + e.code))`], { env: { ...process.env, EDITLENS_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  await new Promise((resolve) => child.on('exit', resolve));
  assert.match(out, /^failed E2BIG/m, out);
});

// Found while fixing 0.24.41: a dev server started manually on localhost listens on ::1 on many
// computers. /editlens <port> and /editlens http://localhost:<port> connect to it there too.
test('a dev server on ::1 only is found and connected through the proxy', async (t) => {
  const v6 = await new Promise((resolve) => {
    const s = require('net').createServer().on('error', () => resolve(false)).listen(0, '::1', () => s.close(() => resolve(true)));
  });
  if (!v6) return t.skip('no IPv6 loopback here');
  const dev = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Six</title><h1>on ::1</h1>');
  });
  await new Promise((resolve) => dev.listen(0, '::1', resolve));
  t.after(() => dev.close());
  const port = dev.address().port;
  const { probe } = require('../lib/connect');
  const seen = await probe(port, 1500);
  assert.strictEqual(seen.ok, true, JSON.stringify(seen));
  assert.strictEqual(seen.title, 'Six');
  const { Connector } = require('../server/connector');
  const project = path.join(base, 'v6-project');
  fs.mkdirSync(project, { recursive: true });
  const c = new Connector({ stateDir: path.join(base, 'v6-state'), livePort: 5273, pairPort: 5275 });
  t.after(() => c.stopAll());
  for (const target of [String(port), `http://localhost:${port}`]) {
    const out = await c.connect({ cwd: project, target: /^\d+$/.test(target) ? `http://localhost:${target}` : target });
    assert.ok(out.ok, JSON.stringify(out));
    const page = await new Promise((resolve, reject) => http.get(out.url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve(body));
    }).on('error', reject));
    assert.match(page, /on ::1/);
    await c.disconnect(project);
  }
  return undefined;
});
