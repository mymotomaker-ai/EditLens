'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5290';
// Mediums of the Sol scan of 0.24.43 on the server side (M2, M3, M5, M6), each a check that
// failed on 0.24.43.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol43-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// M2: the safety question for a write that replaces most of a file came before the subagent's
// mode, so allowing the question let a Plan subagent write.
test('M2: a Plan subagent is refused a write even when the safety check would ask about it', async () => {
  const { Driver } = require('../server/driver');
  const dir = fs.mkdtempSync(path.join(base, 'm2-'));
  const file = path.join(dir, 'big.js');
  fs.writeFileSync(file, Array.from({ length: 80 }, (_, i) => `const line${i} = ${i};`).join('\n') + '\n');
  const self = { stateDir: dir, setting: () => true, agentModeOf: Driver.prototype.agentModeOf };
  const run = (mode) => ({ cwd: dir, mode: 'default', agentModes: new Map([['ag1', mode]]), taskTool: new Map(), guards: new Map() });
  const input = { tool_name: 'Write', tool_use_id: 'tu1', agent_id: 'ag1', tool_input: { file_path: file, content: 'x\n' } };
  const plan = await Driver.prototype.agentRule.call(self, run('plan'), input);
  assert.strictEqual(plan.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(plan));
  // Other modes keep the safety question.
  const ask = await Driver.prototype.agentRule.call(self, run('acceptEdits'), input);
  assert.strictEqual(ask.hookSpecificOutput.permissionDecision, 'ask', JSON.stringify(ask));
});

// M3: a request with no server start id (an older EditLens on the other computer) was matched by
// number alone, so after a restart here it could act on another edit with that number.
test('M3: a restore request by edit number with no server start id is refused, with what to do', () => {
  const { createHostRestore } = require('../server/remote-restore');
  const project = fs.mkdtempSync(path.join(base, 'm3-'));
  fs.writeFileSync(path.join(project, 'a.txt'), 'a\n');
  const history = [{ type: 'change', seq: 5, file: path.join(project, 'a.txt'), relFile: 'a.txt', cwd: project, created: true, backup: null }];
  const host = createHostRestore({ history, backups: {}, undo: {}, restoreEvent: () => {}, log: () => {}, instance: 'b'.repeat(16) });
  const pair = { name: 'laptop', cwd: project };
  const r = host.handle(pair, { do: 'remove', seq: 5, backup: null, rel: 'a.txt', check: true });
  assert.strictEqual(r.status, 409, JSON.stringify(r));
  assert.match(r.body.error, /Update EditLens on/);
  const now = host.handle(pair, { do: 'remove', seq: 5, backup: null, rel: 'a.txt', inst: 'b'.repeat(16), check: true });
  assert.strictEqual(now.status, 200, JSON.stringify(now));
});

// M5: Stop on a waiting sent task while its project was unpacked said "stopped", and then the
// task started anyway.
test('M5: a sent task stopped while its project is unpacked does not start, and its workspace is removed', async () => {
  const { Tasks } = require('../server/tasks');
  const stateDir = fs.mkdtempSync(path.join(base, 'm5-'));
  const tasks = new Tasks({ stateDir, host: 'vps', makeDriver: () => null });
  const pair = { id: 'p1', name: 'laptop', cwd: path.join(stateDir, 'proj') };
  let room = false;
  tasks.roomForTask = () => room;
  tasks.account = () => null;
  let release;
  const gate = new Promise((r) => { release = r; });
  let unpacked = null;
  tasks.unpackSent = async (bundle, dir) => {
    await gate;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    unpacked = dir;
    return { count: 1 };
  };
  let ran = 0;
  tasks.run = async () => {
    ran++;
    return {};
  };
  tasks.uploads.set('u1', { pairId: 'p1', parts: [Buffer.from('x')], at: Date.now() });
  const ctx = { level: null };
  const r = tasks.startLater(pair, 'abcdef123456', 'make it blue', 'u1', ctx);
  assert.strictEqual(r.state, 'waiting', JSON.stringify(r));
  const t = ctx.task;
  room = true;
  tasks.drain();
  await new Promise((res) => setTimeout(res, 50));
  assert.strictEqual(tasks.stopTask(t).state, 'stopped');
  release();
  await new Promise((res) => setTimeout(res, 300));
  assert.strictEqual(ran, 0, 'the task did not start');
  assert.strictEqual(t.state, 'stopped');
  assert.ok(unpacked && !fs.existsSync(unpacked), 'its workspace is removed');
});

// M6: a task request waiting for its second line stayed open when its pairing was removed, so the
// task could still start once the line arrived.
test('M6: removing a pairing closes its task requests, and a request that arrives after it starts nothing', async () => {
  const { Duplex } = require('stream');
  const { PairHost } = require('../server/pair-host');
  const dir = fs.mkdtempSync(path.join(base, 'm6-'));
  const started = [];
  const host = new PairHost({ stateDir: dir, port: 0, httpServer: null, siteOf: () => null, version: 'x', livePort: 1, log: () => {},
    tasks: async (pair, body) => { started.push(body); return { ok: true }; } });
  const pairing = () => ({ id: 'a'.repeat(32), key: 'b'.repeat(64), name: 'laptop', cwd: dir });
  const socket = () => {
    const s = new Duplex({ read() {}, write(chunk, enc, cb) { s.out.push(String(chunk)); cb(); } });
    s.out = [];
    s.editlensIdentity = 'a'.repeat(32);
    return s;
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

  // Unpaired by the paired computer while its task request waits.
  host.pairs = [pairing()];
  const waiting = socket();
  const served = host.serve(waiting);
  waiting.push('{"t":"task"}\n');
  await tick();
  const unpair = socket();
  unpair.push('{"t":"unpair"}\n');
  await host.serve(unpair);
  assert.ok(waiting.destroyed, 'the waiting task request is closed');
  await served;
  assert.deepStrictEqual(started, []);

  // Removed here (/editlens join off) while the request waits.
  host.pairs = [pairing()];
  const second = socket();
  const served2 = host.serve(second);
  second.push('{"t":"task"}\n');
  await tick();
  host.remove('laptop');
  assert.ok(second.destroyed, 'the waiting task request is closed');
  await served2;
  assert.deepStrictEqual(started, []);

  // A pairing gone by the time the second line arrives (any other way): nothing starts.
  host.pairs = [pairing()];
  const third = socket();
  const served3 = host.serve(third);
  third.push('{"t":"task"}\n');
  await tick();
  host.pairs = [];
  third.push('{"do":"start"}\n');
  await served3;
  assert.deepStrictEqual(started, []);
  assert.match(third.out.join(''), /no longer paired/);
  host.off();
});

// Advice (middleware, and the proxy as well): the app's ETag and Last-Modified describe the page
// without the EditLens script, so a browser could get "not modified" after the script tag changed.
test('the middleware and the proxy remove ETag and Last-Modified from a page they change, and keep them on others', async () => {
  const http = require('http');
  const middleware = require('../integrations/middleware');
  const mw = middleware({ port: 5291, root: '/proj' });
  const app = http.createServer((req, res) => mw(req, res, () => {
    res.setHeader('etag', '"abc"');
    res.setHeader('last-modified', 'Mon, 12 Oct 2026 08:00:00 GMT');
    res.setHeader('content-type', req.url === '/data' ? 'application/json' : 'text/html');
    res.end(req.url === '/data' ? '{}' : '<html><body>hi</body></html>');
  }));
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: app.address().port, path: p, headers: { accept: 'text/html' } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ headers: res.headers, body }));
    }).on('error', reject);
  });
  try {
    const page = await get('/');
    assert.match(page.body, /live\.js/);
    assert.strictEqual(page.headers.etag, undefined);
    assert.strictEqual(page.headers['last-modified'], undefined);
    const data = await get('/data');
    assert.strictEqual(data.headers.etag, '"abc"');
    // The proxy (/editlens on a dev server) changes the page the same way.
    const { startProxy } = require('../server/proxy');
    const proxy = await startProxy({ target: `http://127.0.0.1:${app.address().port}`, livePort: 5291 });
    try {
      const html = await new Promise((resolve, reject) => {
        http.get(proxy.url, (res) => { res.resume(); res.on('end', () => resolve(res.headers)); }).on('error', reject);
      });
      assert.strictEqual(html.etag, undefined);
      assert.strictEqual(html['last-modified'], undefined);
    } finally {
      await proxy.close();
    }
  } finally {
    app.close();
  }
});
