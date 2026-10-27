'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5356';
// Sol scan of 0.24.45, part B: M1 and M5, and the Lows L1, L2, L6, L7, L10, L12 and L14, each a
// check that failed on 0.24.45.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol45b-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function get(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(3000, () => req.destroy(new Error('no answer in 3 s')));
    req.on('error', reject);
  });
}

// Raw request text on one connection: -> the answer text ('' when the connection closes empty).
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let got = '';
    s.setEncoding('latin1');
    s.on('data', (c) => { got += c; });
    s.on('close', () => resolve(got));
    s.setTimeout(3000, () => s.destroy(new Error('no answer in 3 s')));
    s.on('error', reject);
  });
}

// M1: a key of the right length in characters but not in bytes threw a RangeError in
// timingSafeEqual: the site request never got an answer, and on the live address the error was an
// unhandled rejection.
test('M1: a gateway key with characters outside ASCII is refused with an answer', async () => {
  const { PairRemotes } = require('../server/pair-remote');
  const upstream = http.createServer((req, res) => res.end('other computer'));
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const remotes = new PairRemotes({ stateDir: fs.mkdtempSync(path.join(base, 'm1-')), port: 5358, log: () => {}, otherUser: () => false });
  remotes.dial = async () => net.connect(upstream.address().port, '127.0.0.1');
  remotes.ask = async () => ({ ok: true, version: '0.24.45', site: true });
  const h = { id: 'c'.repeat(32), key: 'd'.repeat(64), host: '203.0.113.5', port: 5360, name: 'vps', cwd: '/srv/app', livePort: 4999, version: '0.24.45', liveGateway: 0, siteGateway: 0 };
  remotes.hosts.push(h);
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  await remotes.open(h);
  try {
    const odd = encodeURIComponent('é'.repeat(32));
    const site = await get(h.siteGateway, `/?editlens-key=${odd}`);
    assert.strictEqual(site.status, 403);
    const cookie = await get(h.siteGateway, '/', { cookie: `editlens-gw-${h.siteGateway}=${'é'.repeat(32)}` });
    assert.strictEqual(cookie.status, 403);
    const live = await raw(h.liveGateway, `GET /answer HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: editlens-gw-${h.siteGateway}=${'é'.repeat(32)}\r\n\r\n`);
    assert.match(live, /^HTTP\/1\.1 403/);
    await new Promise((r) => setTimeout(r, 50));
    assert.deepStrictEqual(rejections.map(String), []);
  } finally {
    process.removeListener('unhandledRejection', onRejection);
    await remotes.close();
    upstream.close();
  }
});

// M1: the proxy answers a request whose gate throws, with a fixed message.
test('M1: the proxy answers 500 when its gate fails, and logs no stack', async () => {
  const { startProxy } = require('../server/proxy');
  const logged = [];
  const origError = console.error;
  console.error = (...a) => logged.push(a.join(' '));
  const p = await startProxy({ staticRoot: base, livePort: 5356, gate: () => { throw new RangeError('Input buffers must have the same byte length'); } });
  try {
    const r = await get(p.port, '/');
    assert.strictEqual(r.status, 500);
    assert.ok(!/at .*\.js:\d+/.test(logged.join('\n')), logged.join('\n'));
  } finally {
    console.error = origError;
    await p.close();
  }
});

// L1: a version part too long to be a whole number counted as Infinity, so "9999…9.0.0" passed.
test('L1: a version with a part too large to be a whole number is not 0.24.45 or later', () => {
  const { keepsKey } = require('../server/pair-remote');
  assert.strictEqual(keepsKey('0.24.45'), true);
  assert.strictEqual(keepsKey('1.0.0'), true);
  assert.strictEqual(keepsKey('0.24.44'), false);
  assert.strictEqual(keepsKey('9'.repeat(400) + '.0.0'), false);
  assert.strictEqual(keepsKey('0.' + '9'.repeat(400) + '.0'), false);
});

// M5: `/editlens stop remove` followed a link in the project to a template outside it, and wrote
// there. A file outside the project is skipped; one inside is still changed.
test('M5: stop remove changes no file outside the project through a link', () => {
  const { removeBlocks } = require('../bin/connect');
  const outside = fs.mkdtempSync(path.join(base, 'm5-out-'));
  const proj = fs.mkdtempSync(path.join(base, 'm5-proj-'));
  const block = '<html><body>\n<!-- editlens:start -->\n<script data-editlens src="/live.js"></script>\n<!-- editlens:end -->\n</body></html>\n';
  fs.writeFileSync(path.join(outside, 'shared.html'), block);
  fs.symlinkSync(path.join(outside, 'shared.html'), path.join(proj, 'index.html'));
  fs.mkdirSync(path.join(proj, 'src'));
  fs.writeFileSync(path.join(proj, 'src', 'real.html'), block);
  fs.symlinkSync(path.join(proj, 'src', 'real.html'), path.join(proj, 'src', 'index.html'));
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"app","devDependencies":{"vite":"5.0.0"}}');
  const done = removeBlocks(proj);
  assert.strictEqual(fs.readFileSync(path.join(outside, 'shared.html'), 'utf8'), block, 'the file outside is not changed');
  assert.ok(fs.lstatSync(path.join(proj, 'index.html')).isSymbolicLink());
  assert.ok(!fs.readFileSync(path.join(proj, 'src', 'real.html'), 'utf8').includes('editlens'), 'a link inside the project still works');
  assert.deepStrictEqual(done.map((d) => d.rel), ['src/index.html']);
});

// L2: a project file that could not be read for a reason other than "deleted" (EACCES, EIO) was
// left out of a sent project with no word; now it is listed with its reason.
test('L2: a sent project lists a file it could not read, with the reason', async (t) => {
  const { pack } = require('../lib/sendproject');
  const dir = fs.mkdtempSync(path.join(base, 'l2-'));
  for (const n of ['a.txt', 'b.txt', 'c.txt', 'gone.txt']) fs.writeFileSync(path.join(dir, n), n + '\n');
  // Each file is opened once (lib/safepath.js openNoLinks, Sol 0.24.46 M5): the errors come from there.
  const { openSync } = fs;
  const fail = (code) => Object.assign(new Error(code), { code });
  t.after(() => { fs.openSync = openSync; });
  const errs = { 'b.txt': 'EIO', 'gone.txt': 'ENOENT', 'c.txt': 'EACCES' };
  fs.openSync = (f, ...a) => {
    const code = errs[path.basename(String(f))];
    if (code) throw fail(code);
    return openSync(f, ...a);
  };
  const out = await pack(dir);
  fs.openSync = openSync;
  assert.deepStrictEqual(Object.keys(out.manifest), ['a.txt']);
  const why = Object.fromEntries(out.skipped.map((s) => [s.path, s.why]));
  assert.match(why['b.txt'] || '', /EIO/, JSON.stringify(out.skipped));
  assert.match(why['c.txt'] || '', /EACCES/, JSON.stringify(out.skipped));
  assert.strictEqual(why['gone.txt'], undefined, 'a file deleted since the list is left out quietly');
});

// L2: a merge write that failed for a reason other than a locked or read-only file (a full disk)
// was reported as a conflict only; now it is also written to the log with its code.
test('L2: a merge write that fails with ENOSPC is written to the log', async (t) => {
  const { spawnSync } = require('child_process');
  const wt = require('../lib/worktree');
  const sh = (cwd, ...args) => assert.strictEqual(spawnSync('git', ['-C', cwd, ...args]).status, 0, args.join(' '));
  const root = fs.mkdtempSync(path.join(base, 'l2wt-'));
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.com');
  sh(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'start');
  const dir = path.join(root, '.claude', 'worktrees', 'agent-a1');
  sh(root, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1', dir, 'HEAD');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a (copy)\n');
  const { renameSync } = fs;
  const origError = console.error;
  const logged = [];
  t.after(() => { fs.renameSync = renameSync; console.error = origError; });
  fs.renameSync = (from, to) => {
    if (path.basename(String(to)) === 'a.txt') throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    return renameSync(from, to);
  };
  console.error = (...a) => logged.push(a.join(' '));
  const res = await wt.merge(root, 'agent-a1');
  fs.renameSync = renameSync;
  console.error = origError;
  assert.deepStrictEqual(res.conflicts, ['a.txt']);
  assert.match(logged.join('\n'), /a\.txt.*ENOSPC/);
});

// L6: a page whose headers were given to writeHead kept its ETag and Last-Modified after the
// script was added, so a browser could keep the page without it ("not modified").
test('L6: the middleware removes ETag and Last-Modified from a page it changes after writeHead', async () => {
  const middleware = require('../integrations/middleware');
  const use = middleware({ port: 5356, root: '/proj' });
  const pages = {
    '/object': (res) => res.writeHead(200, { 'Content-Type': 'text/html', ETag: '"abc"', 'Last-Modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }),
    '/flat': (res) => res.writeHead(200, 'OK', ['Content-Type', 'text/html', 'etag', '"abc"', 'last-modified', 'Mon, 01 Jan 2024 00:00:00 GMT']),
    '/set': (res) => {
      res.setHeader('ETag', '"abc"');
      res.setHeader('Last-Modified', 'Mon, 01 Jan 2024 00:00:00 GMT');
      res.writeHead(200, { 'Content-Type': 'text/html' });
    },
    '/sized': (res) => res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '28', ETag: '"abc"' }),
  };
  const server = http.createServer((req, res) => use(req, res, () => {
    pages[req.url](res);
    res.end('<html><body>hi</body></html>');
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    for (const p of ['/object', '/flat', '/set']) {
      const r = await get(server.address().port, p, { accept: 'text/html' });
      assert.match(r.body, /live\.js/, p);
      assert.strictEqual(r.headers.etag, undefined, p);
      assert.strictEqual(r.headers['last-modified'], undefined, p);
    }
    // A page sent with its own length is not changed, so it keeps them.
    const sized = await get(server.address().port, '/sized', { accept: 'text/html' });
    assert.ok(!sized.body.includes('live.js'));
    assert.strictEqual(sized.headers.etag, '"abc"');
  } finally {
    server.close();
  }
});

// L14: the safety check read a key file (.env, or a link to one) to compare its lines, before the
// hook's exclusion check. Key files are now never read there; a normal file still is.
test('L14: the safety check never reads a key file', (t) => {
  const guard = require('../lib/guard');
  const dir = fs.mkdtempSync(path.join(base, 'l14-'));
  const lines = Array.from({ length: 30 }, (_, i) => `KEY_${i}=value${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '.env'), lines);
  fs.writeFileSync(path.join(dir, 'config.txt'), lines);
  fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'settings.txt'));
  const { readFileSync } = fs;
  const read = [];
  t.after(() => { fs.readFileSync = readFileSync; });
  fs.readFileSync = (f, ...a) => {
    read.push(path.basename(String(f)));
    return readFileSync(f, ...a);
  };
  const env = guard.check('Write', { file_path: '.env', content: 'A=1\n' }, dir);
  const linked = guard.check('Write', { file_path: 'settings.txt', content: 'A=1\n' }, dir);
  const plain = guard.check('Write', { file_path: 'config.txt', content: 'A=1\n' }, dir);
  fs.readFileSync = readFileSync;
  assert.strictEqual(env, null);
  assert.strictEqual(linked, null);
  assert.strictEqual(plain && plain.kind, 'replace', 'a normal file is still checked');
  assert.deepStrictEqual(read.filter((n) => n !== 'config.txt' && n !== 'settings.json'), [], read.join());
});

// L7: hook input that is not JSON put part of the input into the hook log (Node's parse error
// quotes it), with debug off. The log now has a fixed line with the input's length only.
test('L7: invalid hook input is logged by its length, never its text', async () => {
  const { spawn } = require('child_process');
  const state = fs.mkdtempSync(path.join(base, 'l7-'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDE_PLUGIN_OPTION_|EDITLENS_(DEBUG|DISABLE|PLUGIN_ROOT)$)/.test(k)));
  Object.assign(env, { EDITLENS_STATE_DIR: state, EDITLENS_PORT: '5359' });
  const input = 'my-private-word ' + 'x'.repeat(40);
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'idle'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('exit', (c) => { clearTimeout(kill); resolve(c); });
    child.stdin.end(input);
  });
  assert.strictEqual(code, 0);
  const log = fs.readFileSync(path.join(state, 'hooks.log'), 'utf8');
  assert.match(log, /not JSON/);
  assert.match(log, new RegExp(`\\b${input.length} characters`), log);
  assert.ok(!log.includes('private') && !log.includes('xxxx'), log);
});

// L10: the /editlens skill told Claude to keep the user's words as typed, with their own quotes;
// inside double quotes, $(...) and backticks still run. Every argument is now quoted again with
// single quotes.
test('L10: the /editlens skill quotes every argument with single quotes', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'skills', 'editlens', 'SKILL.md'), 'utf8');
  const step = text.slice(text.indexOf('1. Run this once'), text.indexOf('\n2. '));
  assert.ok(!/Keep the user's words as they typed them\./.test(step), step);
  assert.match(step, /every argument in single quotes/i);
  assert.ok(step.includes("'\\''"), 'says how to write a single quote inside one');
  assert.match(step, /Never keep or use double quotes/);
});

// G1 (signed-in settings check): the own Claude of a task or of page control (EDITLENS_DRIVEN=1)
// sent its default settings with its prompt and session events, which replaced the user's
// tasks_at_once and effort. It sends none now; a Claude the user started still does.
test('G1: a Claude EditLens started sends no settings with its hook events', async () => {
  const { spawn } = require('child_process');
  const bodies = [];
  const stub = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/event') bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url.startsWith('/messages') ? '{"messages":[]}' : '{"ok":true}');
    });
  });
  await new Promise((r) => stub.listen(5361, '127.0.0.1', r));
  try {
    const run = async (driven) => {
      const state = fs.mkdtempSync(path.join(base, 'g1-'));
      fs.writeFileSync(path.join(state, 'token-5361'), 'tok\n');
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDE_PLUGIN_OPTION_|EDITLENS_(DEBUG|DISABLE|PLUGIN_ROOT|DRIVEN)$)/.test(k)));
      Object.assign(env, { EDITLENS_STATE_DIR: state, EDITLENS_PORT: '5361', EDITLENS_NO_START: '1', CLAUDE_PLUGIN_OPTION_TASKS_AT_ONCE: '1', CLAUDE_PLUGIN_OPTION_EFFORT: 'low' });
      if (driven) env.EDITLENS_DRIVEN = '1';
      bodies.length = 0;
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'prompt'], { env, stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', reject);
        const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
        child.on('exit', () => { clearTimeout(kill); resolve(); });
        child.stdin.end(JSON.stringify({ session_id: 's1', cwd: base, prompt: 'hello', hook_event_name: 'UserPromptSubmit' }));
      });
      return bodies.filter((b) => b.type === 'prompt');
    };
    const user = await run(false);
    assert.strictEqual(user.length, 1);
    assert.strictEqual(user[0].settings && user[0].settings.tasks_at_once, 1, 'the user\'s own Claude reports its settings');
    const driven = await run(true);
    assert.strictEqual(driven.length, 1);
    assert.strictEqual(driven[0].settings, undefined, JSON.stringify(driven[0].settings));
  } finally {
    stub.close();
  }
});
