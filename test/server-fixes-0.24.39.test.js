'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5258';
// Findings of the 0.24.38 scan in the server and library code: the SSH tunnel (M8, M9), the task idle
// timer (M10), paging from the other computer (M11), the live-page MCP server (L2, L4), and the
// temp file, edit feed sizes and project listing pages.
const test = require('node:test');
const assert = require('node:assert');
const { killPid } = require('./kill');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-fixes-03924-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const { SshTunnel } = require('../server/ssh-tunnel');
const { Tasks } = require('../server/tasks');
const remotework = require('../lib/remotework');
const { writeAtomic } = require('../lib/atomic');
const { EditFeed } = require('../server/editfeed');

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}
// The pids the stand-in ssh wrote to its log; each must be a whole number above 1 before it is signalled.
function sshPids(log) {
  const pids = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).pid) : [];
  for (const pid of pids) assert.ok(Number.isInteger(pid) && pid > 1, `not a pid: ${pid}`);
  return pids;
}

test('M8: closing a tunnel that was left running by an earlier EditLens does not throw', async () => {
  const left = net.createServer((s) => s.destroy());
  const port = await listen(left);
  process.env.EDITLENS_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
  const t = new SshTunnel({ user: 'me', host: '127.0.0.1', remotePort: 1, localPort: port }, () => {});
  try {
    assert.strictEqual(await t.ensure(), port);
    assert.strictEqual(t.adopted, true);
    assert.doesNotThrow(() => t.close());
    await assert.rejects(t.ensure(), /closed/);
  } finally {
    left.close();
    delete process.env.EDITLENS_SSH;
  }
});

test('M9: two ensure() calls at the same time start one ssh and get the same port', async () => {
  const target = net.createServer((s) => s.end('hi'));
  const remotePort = await listen(target);
  const log = path.join(base, 'm9-ssh.log');
  process.env.EDITLENS_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
  process.env.FAKE_SSH_LOG = log;
  const t = new SshTunnel({ user: 'me', host: '127.0.0.1', remotePort }, () => {});
  try {
    const [a, b] = await Promise.all([t.ensure(), t.ensure()]);
    assert.strictEqual(sshPids(log).length, 1, 'one ssh started');
    assert.strictEqual(a, b);
    assert.strictEqual(a, t.port);
  } finally {
    t.close();
    for (const pid of sshPids(log)) killPid(pid);
    target.close();
    delete process.env.EDITLENS_SSH;
    delete process.env.FAKE_SSH_LOG;
  }
});

test('M9: close() while ssh is starting stops it, and none is left running', async () => {
  const target = net.createServer((s) => s.end('hi'));
  const remotePort = await listen(target);
  const log = path.join(base, 'm9-close-ssh.log');
  process.env.EDITLENS_SSH = path.join(__dirname, 'fixtures', 'fake-ssh.js');
  process.env.FAKE_SSH_LOG = log;
  const t = new SshTunnel({ user: 'me', host: '127.0.0.1', remotePort }, () => {});
  try {
    const p = t.ensure();
    t.close();
    await assert.rejects(p);
    await new Promise((r) => setTimeout(r, 300));
    for (const pid of sshPids(log)) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, `ssh ${pid} still running`);
  } finally {
    for (const pid of sshPids(log)) killPid(pid);
    target.close();
    delete process.env.EDITLENS_SSH;
    delete process.env.FAKE_SSH_LOG;
  }
});

// A task with a stand-in Claude; emit sends its driver events.
async function idleTask(name, idleCloseMs) {
  const project = path.join(base, `${name}-project`);
  fs.mkdirSync(project, { recursive: true });
  const pair = { name: 'laptop', id: 'p1', cwd: project };
  const stops = [];
  let emit = null;
  const tasks = new Tasks({
    stateDir: path.join(base, `${name}-state`), host: 'vps', log: () => {}, idleCloseMs,
    makeDriver: (o) => {
      emit = o.emit;
      return { start: async () => ({}), started: async () => ({}), send: () => ({}), stop: (why) => stops.push(why) };
    },
  });
  const id = 'aaaaaaaaaaaa';
  const out = await tasks.startShared(pair, id, 'do it', { level: null });
  assert.ok(!out.error, JSON.stringify(out));
  return { tasks, pair, id, t: tasks.items.get(id), stops, emit: (phase) => emit({ type: 'drive', phase }) };
}

test('M10: the idle timer never closes a task that is working again', async () => {
  // Real timers with a short idle time (mock timers differ between Node 18 and 22).
  const IDLE = 300;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const { tasks, pair, id, t, stops, emit } = await idleTask('m10', IDLE);
  try {
    // A follow-up to the waiting session: it works longer than the idle time.
    emit('idle');
    const sent = await tasks.send(pair, id, 'more');
    assert.ok(!sent.error, JSON.stringify(sent));
    await wait(IDLE * 2);
    assert.strictEqual(t.state, 'working');
    assert.ok(t.driver, 'its Claude still runs');
    assert.deepStrictEqual(stops, []);
    // Its Claude says it works again (a turn the page started).
    emit('idle');
    emit('working');
    await wait(IDLE * 2);
    assert.strictEqual(t.state, 'working');
    assert.deepStrictEqual(stops, []);
    // Idle for the whole time: closed, as before.
    emit('idle');
    await wait(IDLE * 2);
    assert.strictEqual(t.state, 'ended');
    assert.deepStrictEqual(stops, ['idle']);
  } finally {
    tasks.stopAll();
  }
});

test('M11: a task file whose pages start again from 0 is refused, not read forever', async () => {
  let calls = 0;
  const call = async () => {
    calls++;
    if (calls > 300) return { error: 'too many requests' };
    return { data: Buffer.from('abc').toString('base64'), next: 0 };
  };
  const got = await remotework.fetchFile(call, 'aaaaaaaaaaaa', 'a.txt');
  assert.ok(got.error, 'an error');
  assert.notStrictEqual(got.error, 'too many requests');
  assert.ok(calls <= 2, `${calls} requests`);
  // A page that skips bytes would make a wrong file.
  const gap = async (op, { offset }) => (offset === 0 ? { data: Buffer.from('abc').toString('base64'), next: 10 } : { data: '', next: null });
  assert.ok((await remotework.fetchFile(gap, 'aaaaaaaaaaaa', 'a.txt')).error);
});

test('M11: copying from the other computer stops when its listing or file pages do not move forward', async () => {
  const dir = path.join(base, 'm11-here');
  fs.mkdirSync(dir, { recursive: true });
  let calls = 0;
  const listing = async (op, extra) => {
    calls++;
    if (calls > 300) return { error: 'too many requests' };
    if (op === 'project-files') return { root: '/there', kind: 'folder', files: [{ path: `f${calls}.txt`, size: 1 }], next: extra.offset };
    return { error: 'not asked' };
  };
  const a = await remotework.copyFrom(listing, { from: '.', dir, stateDir: path.join(base, 'm11-state'), dryRun: true });
  assert.ok(a.error, JSON.stringify(a).slice(0, 200));
  assert.notStrictEqual(a.error, 'too many requests');
  assert.ok(calls <= 2, `${calls} listing requests`);

  calls = 0;
  const file = async (op, extra) => {
    calls++;
    if (calls > 300) return { error: 'too many requests' };
    if (op === 'project-files' && Array.isArray(extra.hash)) return { shas: {} };
    if (op === 'project-files') return { root: '/there', kind: 'folder', files: [{ path: 'a.txt', size: 3 }], next: null };
    return { data: Buffer.from('abc').toString('base64'), next: 0 };
  };
  const b = await remotework.copyFrom(file, { from: '.', dir, stateDir: path.join(base, 'm11-state') });
  assert.strictEqual(b.copied.length, 0);
  assert.strictEqual(b.failed.length, 1);
  assert.notStrictEqual(b.failed[0].why, 'too many requests');
  assert.ok(calls <= 4, `${calls} requests`);
  assert.ok(!fs.existsSync(path.join(dir, 'a.txt')));
});

test('M11: a listing with more entries than any real project is refused', async () => {
  let offset = 0;
  const call = async (op, extra) => {
    if (op !== 'project-files') return { error: 'not asked' };
    offset = extra.offset;
    if (offset > 100000) return { error: 'too many requests' };
    const files = Array.from({ length: 500 }, (_, i) => ({ path: `d/f${offset + i}.txt`, size: 1 }));
    return { root: '/there', kind: 'folder', files, next: offset + 500 };
  };
  const out = await remotework.copyFrom(call, { from: '.', dir: base, stateDir: path.join(base, 'm11b-state'), dryRun: true });
  assert.ok(out.error, 'an error');
  assert.notStrictEqual(out.error, 'too many requests');
  assert.ok(offset <= 10000, `asked up to ${offset}`);
});

// The live-page MCP server with a stand-in EditLens server; -> the text of one tool call.
async function mcpCall(handler, name, args, { cwd } = {}) {
  const server = http.createServer(handler);
  const port = await listen(server);
  const env = { ...process.env, EDITLENS_PORT: String(port), EDITLENS_NO_START: '1' };
  delete env.CLAUDE_PROJECT_DIR;
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
    return msg.result.content.map((c) => c.text).join('\n');
  } finally {
    clearTimeout(timer);
    child.kill();
    server.close();
  }
}

test('L2: list_live_pages marks the pages of the project Claude Code started it in', async () => {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(base, 'l2-')));
  const text = await mcpCall((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/pages/live') return res.end(JSON.stringify([{ title: 'Shop', url: 'http://localhost:5173/', root: project }]));
    res.statusCode = 404;
    return res.end('{}');
  }, 'list_live_pages', {}, { cwd: project });
  assert.match(text, /Shop — http:\/\/localhost:5173\/ \(this project\)/);
});

test('L4: a match count that is not a whole number reads as 0 matches, with the note', async () => {
  const text = await mcpCall((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/event') return res.end('{"ok":true,"pages":1}');
    if (req.url.startsWith('/report')) return res.end('[{"url":"http://x/","results":[{"target":"a","count":1e400},{"target":"b","count":-3},{"target":"c","count":2}]}]');
    res.statusCode = 404;
    return res.end('{}');
  }, 'highlight_on_page', { targets: [{ text: 'a' }, { text: 'b' }, { text: 'c' }] });
  assert.match(text, /a: 0 matches; b: 0 matches; c: 2 matches/);
  assert.match(text, /Targets with 0 matches were not shown/);
});

// Haiku sent { "target": "{ \"marker\": 1 }" } and was told "No usable targets".
test('highlight_on_page reads "target", JSON text and one target without the list', async () => {
  for (const args of [{ target: '{ "marker": 1 }' }, { targets: '[{"marker": 1}]' }, { targets: { marker: 1 } }, { target: { marker: 1 } }]) {
    let sent = null;
    const text = await mcpCall((req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/event') {
        let body = '';
        req.on('data', (d) => { body += d; });
        req.on('end', () => { sent = JSON.parse(body); res.end('{"ok":true,"pages":1}'); });
        return undefined;
      }
      if (req.url.startsWith('/report')) return res.end('[{"url":"http://x/","results":[{"target":"1","count":1}]}]');
      res.statusCode = 404;
      return res.end('{}');
    }, 'highlight_on_page', args);
    assert.deepStrictEqual(sent && sent.targets.map((t) => t.marker), [1], JSON.stringify(args));
    assert.match(text, /1 match/, JSON.stringify(args));
  }
});

test('highlight_on_page with no usable target shows the shape to send', async () => {
  const text = await mcpCall((req, res) => res.end('{}'), 'highlight_on_page', { target: 'nothing' });
  assert.match(text, /\{ "targets": \[\{ "marker": 2 \}\] \}/);
});

test('atomic: a link put at the temporary name does not get the data', () => {
  const dir = fs.mkdtempSync(path.join(base, 'atomic-'));
  const file = path.join(dir, 'data.json');
  const other = path.join(dir, 'other.txt');
  fs.writeFileSync(file, 'old');
  fs.writeFileSync(other, 'keep');
  fs.symlinkSync(other, path.join(dir, `.data.json.editlens-${process.pid}.tmp`));
  writeAtomic(file, 'new');
  assert.strictEqual(fs.readFileSync(other, 'utf8'), 'keep');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new');
  assert.ok(!fs.lstatSync(file).isSymbolicLink());
});

test('editfeed: sizes are counted in bytes, so text that is not ASCII keeps the file within the budget', () => {
  const dir = fs.mkdtempSync(path.join(base, 'feed-'));
  const budget = 20000;
  const feed = new EditFeed({ dir, budget });
  for (let i = 1; i <= 40; i++) feed.push({ fseq: i, kind: 'edit', file: 'a.txt', text: '€'.repeat(400) });
  const onDisk = (n) => fs.statSync(path.join(dir, n)).size;
  assert.ok(onDisk('edits.jsonl') <= budget / 2, `${onDisk('edits.jsonl')} bytes`);
  assert.ok(onDisk('edits.jsonl') + onDisk('edits-old.jsonl') <= budget, 'both files within the budget');
  const again = new EditFeed({ dir, budget });
  assert.strictEqual(again.curSize, onDisk('edits.jsonl'));
});

test('project listing: later pages come from the same list as the first page', async () => {
  const project = fs.mkdtempSync(path.join(base, 'listing-'));
  for (let i = 100; i < 700; i++) fs.writeFileSync(path.join(project, `f${i}.txt`), 'x');
  const tasks = new Tasks({ stateDir: path.join(base, 'listing-state'), host: 'vps', log: () => {} });
  const pair = { name: 'laptop', id: 'p1', cwd: project };
  const first = await tasks.projectFiles(pair, '.', 0, false);
  assert.strictEqual(first.files.length, 500);
  // A file added between the pages: no file is listed twice or left out.
  fs.writeFileSync(path.join(project, 'a000.txt'), 'x');
  const second = await tasks.projectFiles(pair, '.', first.next, false);
  const names = first.files.concat(second.files).map((f) => f.path);
  assert.strictEqual(new Set(names).size, names.length, 'no file twice');
  assert.strictEqual(names.length, 600);
  // A new listing (from the first page) has the new file.
  const fresh = await tasks.projectFiles(pair, '.', 0, false);
  assert.strictEqual(fresh.files[0].path, 'a000.txt');
  assert.strictEqual(fresh.total, 601);
});

test('editfeed: edits and replies sent through the link are counted in bytes, so a response stays under 1 MB', async () => {
  const { tasks, pair, t } = await idleTask('bytes');
  try {
    const text = '€'.repeat(20000);
    t.replies = Array.from({ length: 30 }, () => text);
    t.replyCount = 30;
    const report = tasks.report(t);
    assert.ok(report.replies.length >= 1);
    assert.ok(Buffer.byteLength(JSON.stringify(report)) < 1024 * 1024, `${Buffer.byteLength(JSON.stringify(report))} bytes`);
    for (let i = 0; i < 20; i++) tasks.pushEdit({ kind: 'session', file: path.join(pair.cwd, `e${i}.txt`), before: text, after: text, hunks: [], ts: Date.now() });
    const out = tasks.editsFor(pair, 0);
    assert.ok(out.edits.length >= 1);
    assert.ok(Buffer.byteLength(JSON.stringify(out)) < 1024 * 1024, `${Buffer.byteLength(JSON.stringify(out))} bytes`);
  } finally {
    tasks.stopAll();
  }
});
