'use strict';
require('./isolate');
// Every edit on a paired VPS appears on the laptop's page, in full and labelled by where it was
// made: a session's edit in the paired project, and a task's edit (in a copy of the laptop's
// project). Each has its code (snapshot for the code view), and secrets keep their lines. A session's
// edit has what its Restore there needs (undo-remote.test.js); a task's edit does not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const remotework = require('../lib/remotework');
const { stopChildren } = require('./launch');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-redits-'));
const vpsProject = path.join(base, 'vps-site');
const laptopProject = path.join(base, 'laptop-app');
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 4381, pairPort: 4382, dir: path.join(base, 'host') };
const REMOTE = { port: 4383, pairPort: 4910, dir: path.join(base, 'remote') };
const fake = path.join(base, 'fake');
const children = new Set();

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, json: null, error: err.code }));
    if (data) req.write(data);
    req.end();
  });
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}
function startServer(s, extra = {}) {
  fs.mkdirSync(s.dir, { recursive: true });
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, ...extra }, stdio: 'ignore' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}
const token = (s) => fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
const api = (s, method, urlPath, body) => request(s.port, method, urlPath, body, { 'x-editlens-token': token(s) }).then((r) => r.json);
const call = (op, extra) => api(REMOTE, 'POST', '/remote/task', { op, ...extra });
function stream(s, query) {
  const events = [];
  const ac = new AbortController();
  fetch(`http://127.0.0.1:${s.port}/events?${query}`, { signal: ac.signal }).then(async (res) => {
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        buf = buf.slice(i + 2);
        try {
          if (data) events.push(JSON.parse(data));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { events, close: () => ac.abort() };
}
function gitProject(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'start']]) {
    assert.strictEqual(spawnSync('git', ['-C', dir, ...args]).status, 0);
  }
}

test('the laptop page shows the VPS\'s edits, in full and labelled by source', async (t) => {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
  gitProject(vpsProject, { 'index.html': '<h1>VPS</h1>\n' });
  gitProject(laptopProject, { 'src/App.jsx': 'old\n' });

  await startServer(HOST, { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state') });
  await startServer(REMOTE);
  t.after(async () => {
    // The servers save their state as they exit, and git they started may still be writing: remove the
    // folder only after they have ended, trying again for a while (L10, ENOTEMPTY).
    await stopChildren([...children]);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
  const { code } = await api(HOST, 'POST', '/pair', { cwd: vpsProject });
  assert.ok((await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code })).ok);
  const page = stream(REMOTE, `page=lp&root=${encodeURIComponent(laptopProject)}`);
  t.after(() => page.close());
  await waitFor(() => page.events.some((e) => e.type === 'hello'));
  await api(REMOTE, 'GET', '/remote/tasks?follow=');

  // Claude in the VPS's own session edits its project.
  const file = path.join(vpsProject, 'index.html');
  await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'v1', cwd: vpsProject, file, relFile: 'index.html', tool: 'Edit', intent: 'Bigger heading',
    before: '<h1>VPS</h1>\n', after: '<h1>VPS site</h1>\n', hunks: [{ oldStart: 1, newStart: 1, lines: ['-<h1>VPS</h1>', '+<h1>VPS site</h1>'] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
  const sess = await waitFor(() => page.events.find((e) => e.type === 'change' && e.remote && e.remote.kind === 'session'));
  assert.ok(sess, JSON.stringify(page.events.map((e) => e.type)));
  assert.match(sess.relFile, /^◆ .+: index\.html$/);
  assert.strictEqual(sess.intent, 'Bigger heading');
  assert.ok(sess.remote.anywhere, 'its project is not this page\'s: shown on every page here');
  assert.ok(sess.backup && sess.remote.ref && sess.remote.ref.seq > 0, 'Restore is done there, through the link (undo-remote.test.js)');
  assert.match(sess.agentId, /^r:.+:sessions$/);
  assert.ok(sess.snapshot, 'its code is there for the code view');
  const snap = (await request(REMOTE.port, 'GET', `/snapshot?id=${sess.snapshot}&instance=${(await api(REMOTE, 'GET', '/summary')).instance}`)).json;
  assert.strictEqual(snap.before, '<h1>VPS</h1>\n');
  assert.strictEqual(snap.after, '<h1>VPS site</h1>\n');

  // A key file there: shown as edited, never its lines.
  await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'v1', cwd: vpsProject, file: path.join(vpsProject, '.env'), relFile: '.env', tool: 'Write',
    before: 'A=1\n', after: 'A=2\n', hunks: [{ oldStart: 1, newStart: 1, lines: ['-A=1', '+A=2'] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
  const secret = await waitFor(() => page.events.find((e) => e.type === 'change' && e.remote && /\.env$/.test(e.relFile)));
  assert.ok(secret.remote.secret);
  assert.deepStrictEqual(secret.hunks, []);
  assert.ok(!JSON.stringify(secret).includes('A=2'));

  // A session there working in another folder: not sent; the page is told where it works.
  const elsewhere = path.join(base, 'pulse');
  await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'v2', cwd: elsewhere, file: path.join(elsewhere, 'public', 'styles.css'), relFile: 'public/styles.css', tool: 'Write',
    before: '', after: 'body{color:red}\n', hunks: [{ oldStart: 0, newStart: 1, lines: ['+body{color:red}'] }], stats: { added: 1, removed: 0 }, ts: Date.now() });
  const out = await waitFor(() => page.events.find((e) => e.type === 'remote-outside'));
  assert.strictEqual(out.where, elsewhere);
  assert.strictEqual(out.paired, vpsProject);
  assert.ok(!page.events.some((e) => e.type === 'change' && /styles\.css/.test(String(e.relFile))), 'its edit is not sent');
  assert.ok(!JSON.stringify(out).includes('color:red'));

  // A task there on this project (sent): its edit shows on this project's page, as a copy.
  const started = await remotework.sendAndStart(call, { dir: laptopProject, prompt: 'say hi', stateDir: REMOTE.dir });
  assert.ok(started.task, JSON.stringify(started));
  await api(REMOTE, 'POST', '/remote/task', { op: 'send', task: started.task, text: 'say hi again', localDir: laptopProject });
  const ws = started.workspace.folder;
  await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'task-s', cwd: ws, file: path.join(ws, 'src', 'App.jsx'), relFile: 'src/App.jsx', tool: 'Edit', intent: 'New heading',
    before: 'old\n', after: 'new\n', hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+new'] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
  const tk = await waitFor(() => page.events.find((e) => e.type === 'change' && e.remote && e.remote.kind === 'task'));
  assert.ok(tk);
  assert.strictEqual(tk.remote.taskKind, 'mine');
  assert.strictEqual(tk.remote.task, started.task);
  assert.strictEqual(tk.taskCwd, laptopProject);
  assert.strictEqual(tk.file, path.join(ws, 'src', 'App.jsx'), 'its path there, apart from this project\'s own file');
  assert.ok(!tk.remote.anywhere);
  assert.ok(!tk.remote.ref && !tk.backup && !tk.remote.old, 'a task\'s edit: no Restore from here');
  assert.strictEqual(fs.readFileSync(path.join(laptopProject, 'src', 'App.jsx'), 'utf8'), 'old\n', 'nothing changes here until Claude applies it');
  // Each edit once, even with the follow loop started twice.
  await api(REMOTE, 'GET', '/remote/tasks?follow=');
  await new Promise((r) => setTimeout(r, 600));
  assert.strictEqual(page.events.filter((e) => e.type === 'change' && e.remote && e.remote.kind === 'session' && /index\.html$/.test(e.relFile)).length, 1);
});
