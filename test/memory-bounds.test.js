'use strict';
require('./isolate');
// Buffers and memory (review B1–B11): big files are not read whole, the project bundle is built and
// read one file at a time, transcripts are read a megabyte at a time, and the stores that grow
// (uploads, history, diffs, boards, the task list) remove what they no longer need.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const net = require('net');
const { spawnSync } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-memory-'));
process.env.EDITLENS_STATE_DIR = path.join(base, 'state');
process.env.EDITLENS_PORT = '4371';
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const { readSmall } = require('../lib/readsmall');
const sendproject = require('../lib/sendproject');
const { Tail } = require('../server/transcript');
const wire = require('../lib/pairwire');
const middleware = require('../integrations/middleware');
const { Tasks } = require('../server/tasks');
const { Boards } = require('../server/board');
const worktree = require('../lib/worktree');

test('B1: a file over the limit is not read', () => {
  const file = path.join(base, 'b1.txt');
  fs.writeFileSync(file, 'x'.repeat(2000));
  assert.strictEqual(readSmall(file, 2000).length, 2000);
  assert.strictEqual(readSmall(file, 1999), undefined, 'too big: undefined, not the text');
  assert.strictEqual(readSmall(path.join(base, 'nope'), 10), null);
  assert.strictEqual(readSmall(base, 10), null, 'a folder');
});

test('B1: the edit hook sends a huge file\'s edit without its text', async (t) => {
  const { ensureServer, stopServer, getJson } = require('../lib/client');
  await ensureServer();
  t.after(() => stopServer());
  const file = path.join(base, 'huge.json');
  fs.writeFileSync(file, 'y'.repeat(3 * 1024 * 1024));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'pending'], {
    input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'y', new_string: 'z' }, cwd: base, session_id: 's' }),
    encoding: 'utf8',
    timeout: 10000,
  });
  assert.strictEqual(r.status, 0);
  const ev = (await getJson('/history')).filter((e) => e.type === 'pending' && e.file === file).pop();
  assert.ok(ev, 'the edit is shown');
  assert.strictEqual(ev.before, undefined);
  assert.strictEqual(ev.existed, true);
});

test('B2: the bundle is built and read one file at a time, in the same format as before', async () => {
  const dir = path.join(base, 'proj');
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'const a = "},{\\"p\\":";\n');
  fs.writeFileSync(path.join(dir, 'ü.txt'), 'é'.repeat(70000));
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
  const packed = await sendproject.pack(dir);
  assert.strictEqual(packed.count, 2);
  assert.deepStrictEqual(Object.keys(packed.manifest).sort(), ['src/a.js', 'ü.txt']);
  // An older EditLens reads it the old way.
  const old = JSON.parse(zlib.gunzipSync(packed.bundle).toString('utf8'));
  assert.strictEqual(old.v, 1);
  assert.strictEqual(old.files.length, 2);
  const out = path.join(base, 'proj-out');
  assert.deepStrictEqual(await sendproject.unpack(packed.bundle, out), { count: 2 });
  assert.strictEqual(fs.readFileSync(path.join(out, 'src', 'a.js'), 'utf8'), fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8'));
  assert.strictEqual(fs.readFileSync(path.join(out, 'ü.txt'), 'utf8'), 'é'.repeat(70000));
  // A bundle from an older EditLens, and names that look like the separator.
  const legacy = zlib.gzipSync(Buffer.from(JSON.stringify({ v: 1, files: [{ p: 'a"},{"p":"b', d: 'eA==' }, { p: 'c', x: 1, d: 'eQ==' }] })));
  assert.deepStrictEqual(await sendproject.unpack(legacy, path.join(base, 'legacy')), { count: 2 });
  assert.ok(fs.existsSync(path.join(base, 'legacy', 'a"},{"p":"b')));
  assert.deepStrictEqual(await sendproject.unpack(zlib.gzipSync(Buffer.from('{"v":1,"files":[]}')), path.join(base, 'empty')), { count: 0 });
  // Cut short, or not a bundle: an error and nothing is kept.
  for (const [i, bad] of [packed.bundle.subarray(0, packed.bundle.length - 9), zlib.gzipSync(Buffer.from('{"v":2}')), Buffer.from('nope')].entries()) {
    const dest = path.join(base, `bad${i}`);
    assert.match((await sendproject.unpack(bad, dest)).error, /could not be read/);
    assert.ok(!fs.existsSync(dest) && !fs.existsSync(`${dest}.part`));
  }
});

test('B3: a transcript is tailed from its last 128 KB, a megabyte per read, and a huge line is skipped', () => {
  const file = path.join(base, 'agent.jsonl');
  const line = (n) => JSON.stringify({ n, pad: 'p'.repeat(1000) }) + '\n';
  let text = '';
  for (let n = 0; n < 2000; n += 1) text += line(n);
  fs.writeFileSync(file, text); // about 2 MB
  const got = [];
  const tail = new Tail(file, (entries) => got.push(...entries), { backlog: true });
  tail.start();
  tail.stop();
  assert.ok(got.length > 0 && got.length < 140, `only the backlog (${got.length})`);
  assert.strictEqual(got[got.length - 1].n, 1999);
  // A big write arrives in parts of at most 1 MB.
  got.length = 0;
  let more = '';
  for (let n = 2000; n < 4500; n += 1) more += line(n);
  fs.appendFileSync(file, more); // about 2.5 MB
  const before = tail.offset;
  tail.read(false);
  assert.ok(tail.offset - before <= 1024 * 1024, 'one megabyte');
  while (tail.more) tail.read(false);
  assert.strictEqual(got.length, 2500);
  assert.deepStrictEqual([got[0].n, got[got.length - 1].n], [2000, 4499]);
  // A line longer than 8 MB is skipped as it streams in; the next line is read.
  got.length = 0;
  fs.appendFileSync(file, '{"big":"' + 'b'.repeat(9 * 1024 * 1024) + '"}\n' + line(5000));
  do tail.read(false); while (tail.more);
  assert.ok(tail.partial.length <= 1024 * 1024 + 8 * 1024 * 1024);
  assert.deepStrictEqual(got.map((e) => e.n), [5000]);
});

test('B4: a send that stops before every part is received is removed', () => {
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(base, 'b4-')), host: 'vps', makeDriver: () => null });
  const pair = { id: 'p1', name: 'laptop' };
  const r = tasks.receive(pair, { data: Buffer.from('part').toString('base64') });
  assert.ok(r.upload && tasks.uploads.get(r.upload).timer, 'a timer per upload');
  tasks.uploads.get(r.upload).at -= 11 * 60000;
  tasks.sweepUploads();
  assert.strictEqual(tasks.uploads.size, 0);
});

test('B5: the middleware passes a page over 20 MB through as it is', async (t) => {
  const mw = middleware({ port: 4371, root: base });
  const server = http.createServer((req, res) => mw(req, res, () => {
    res.setHeader('content-type', 'text/html');
    const n = req.url === '/big' ? Math.ceil((middleware.MAX_HTML + 1) / (1024 * 1024)) : 1;
    for (let i = 0; i < n; i += 1) res.write('a'.repeat(1024 * 1024));
    res.end('</body>');
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: p, headers: { accept: 'text/html' } }, (res) => {
      let size = 0;
      let tail = '';
      res.on('data', (c) => {
        size += c.length;
        tail = (tail + c.toString('latin1')).slice(-200);
      });
      res.on('end', () => resolve({ size, tail }));
    }).on('error', reject);
  });
  assert.match((await get('/small')).tail, /live\.js[^]*<\/body>$/, 'a normal page gets the script');
  const big = await get('/big');
  assert.ok(!/live\.js/.test(big.tail), 'a page that big is sent unchanged');
  assert.strictEqual(big.size, Math.ceil((middleware.MAX_HTML + 1) / (1024 * 1024)) * 1024 * 1024 + 7);
});

test('B6: a header sent in many small pieces is read once', async () => {
  const [a, b] = await new Promise((resolve) => {
    const server = net.createServer((s) => {
      server.close();
      resolve([s, client]);
    });
    let client;
    server.listen(0, '127.0.0.1', () => {
      client = net.connect(server.address().port, '127.0.0.1');
    });
  });
  const header = wire.readHeader(a, 5000, 1024 * 1024);
  const text = JSON.stringify({ x: 'q'.repeat(200000) }) + '\nafter';
  for (let i = 0; i < text.length; i += 4096) b.write(text.slice(i, i + 4096));
  assert.strictEqual((await header).x.length, 200000);
  const rest = await new Promise((resolve) => {
    a.once('data', (c) => resolve(String(c)));
    a.resume();
  });
  assert.strictEqual(rest, 'after');
  // Too long: refused.
  const long = wire.readHeader(a, 5000, 10);
  b.write('{"y":"' + 'z'.repeat(50) + '"}\n');
  await assert.rejects(long, /too long/);
  a.destroy();
  b.destroy();
});

test('B9: a base version too large to merge is never read into memory', async () => {
  const root = path.join(base, 'b9');
  fs.mkdirSync(root);
  const sh = (...args) => assert.strictEqual(spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' }).status, 0);
  sh('init', '-q', '-b', 'main');
  sh('config', 'user.email', 't@example.com');
  sh('config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'big.txt'), 'b'.repeat(9 * 1024 * 1024));
  fs.writeFileSync(path.join(root, 'small.txt'), 'one\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n');
  sh('add', '-A');
  sh('commit', '-q', '-m', 'start');
  const made = worktree.create(root, 'agent-b9');
  assert.ok(!made.error, made.error);
  fs.writeFileSync(path.join(made.cwd, 'big.txt'), 'now small\n');
  fs.writeFileSync(path.join(made.cwd, 'small.txt'), 'two\n');
  const st = await worktree.status(root, 'agent-b9');
  const byFile = Object.fromEntries(st.files.map((f) => [f.relFile, f]));
  assert.strictEqual(byFile['big.txt'].state, 'conflict');
  assert.strictEqual(byFile['big.txt'].why, 'too large to merge');
  assert.strictEqual(byFile['small.txt'].state, 'clean');
  worktree.remove(root, 'agent-b9');
});

test('B10: boards untouched for 90 days are deleted', () => {
  const dir = path.join(base, 'boards');
  fs.mkdirSync(dir);
  const old = path.join(dir, 'old.jsonl');
  const recent = path.join(dir, 'recent.jsonl');
  fs.writeFileSync(old, JSON.stringify({ header: true, cwd: '/old' }) + '\n');
  fs.writeFileSync(recent, JSON.stringify({ header: true, cwd: path.join(base, 'recent') }) + '\n');
  const longAgo = (Date.now() - 91 * 86400000) / 1000;
  fs.utimesSync(old, longAgo, longAgo);
  const boards = new Boards({ dir });
  boards.loadRecent();
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent));
  assert.strictEqual(boards.boards.size, 1);
});

test('B11: task saves are gathered, and an unchanged list is not written again', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'b11-'));
  const tasks = new Tasks({ stateDir: dir, host: 'vps', makeDriver: () => null });
  const t = { id: 'bbbbbbbbbbbb', by: 'laptop', pairId: 'p', cwd: base, dir: base, prompt: 'x', state: 'idle', replies: [], permissions: new Map(), startedAt: 1, updatedAt: 1 };
  tasks.items.set(t.id, t);
  const file = path.join(dir, 'tasks.json');
  for (let i = 0; i < 20; i += 1) tasks.changed(t);
  assert.ok(!fs.existsSync(file), 'not written immediately');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(fs.existsSync(file), 'written once, a moment later');
  const at = fs.statSync(file).mtimeMs;
  fs.utimesSync(file, 1, 1);
  tasks.save();
  assert.strictEqual(fs.statSync(file).mtimeMs, 1000, 'same text: not written again');
  assert.ok(at > 0);
  t.state = 'done';
  tasks.changed(t);
  tasks.stopAll(); // a waiting save happens before the server exits
  assert.match(fs.readFileSync(file, 'utf8'), /"state":"done"/);
});

test('B8: the event history and a new page\'s replay are kept within a byte budget', async (t) => {
  const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');
  await ensureServer();
  t.after(() => stopServer());
  const big = 'h'.repeat(1024 * 1024);
  for (let i = 0; i < 20; i += 1) await postEvent({ type: 'note', text: big, cwd: base, ts: Date.now() });
  const all = await getJson('/history');
  const bytes = all.reduce((n, e) => n + JSON.stringify(e).length, 0);
  assert.ok(bytes <= 16 * 1024 * 1024 + 4096, `history ${bytes} bytes`);
  assert.ok(all.length >= 10, 'the newest are kept');
});
