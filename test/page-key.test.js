'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5440';
// D21 (Sol H1): where EditLens can't tell which account connects (macOS, Windows), the live server
// answers only /health and /live.js without this user's key. A page gets the key once after # in
// an address /editlens opens or prints, then sends it in every address (/gk-<key>/...). Hooks and
// commands keep using the hook key. Linux, where the account is known, stays as it was.
// EDITLENS_TEST_PEER=unknown (or a uid) makes the server see every connection as that account.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');
const { PairRemotes } = require('../server/pair-remote');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pagekey-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><title>Site</title><p>hi</p>');
const children = new Set();
const remotesList = [];
test.after(async () => {
  for (const r of remotesList) await r.close();
  await Promise.all([...children].map((c) => new Promise((resolve) => {
    if (c.exitCode !== null) return resolve();
    c.once('exit', resolve);
    return c.kill();
  })));
  fs.rmSync(base, { recursive: true, force: true });
});

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => {
        text += c;
        if (/text\/event-stream/.test(String(res.headers['content-type']))) res.destroy();
      });
      res.on('close', () => resolve({ status: res.statusCode, text, headers: res.headers }));
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// A live server of its own (port, state folder), seeing connections as `peer` (unset: as they are).
async function server(port, peer, pairPort) {
  const dir = path.join(base, `state-${port}`);
  fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: dir, ...(pairPort ? { EDITLENS_PAIR_PORT: String(pairPort) } : {}) };
  delete env.EDITLENS_TEST_PEER;
  if (peer !== undefined) env.EDITLENS_TEST_PEER = String(peer);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env, stdio: 'ignore' });
  children.add(child);
  assert.ok(await waitFor(async () => (await request(port, 'GET', '/health')).status === 200), 'the server started');
  const token = fs.readFileSync(path.join(dir, `token-${port}`), 'utf8');
  return { port, dir, child, token, hook: { 'x-editlens-token': token } };
}

const NAV = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', accept: 'text/html' };
// Every route a page could use without the hook key before D21.
const OPEN_ROUTES = [
  ['GET', '/events?page=p1'], ['GET', '/snapshot?id=s1'], ['GET', '/file?ref=a.js'], ['GET', '/pages'], ['GET', '/summary'],
  ['GET', '/settings'], ['GET', '/sessions'], ['GET', '/answer', NAV], ['GET', '/answer/list'], ['GET', '/'], ['GET', '/shot?id=x'],
  ['GET', '/copy?id=x'], ['POST', '/sessions/rename'], ['POST', '/settings'], ['POST', '/answer'], ['POST', '/message'],
  ['POST', '/shot'], ['POST', '/message/cancel'], ['POST', '/restore'], ['POST', '/task/effort'], ['POST', '/task/answer'],
  ['POST', '/task/stop'], ['POST', '/remote/task-effort'], ['POST', '/remote/task/stop'], ['POST', '/remote/task/undo-apply'],
  ['POST', '/copy/merge'], ['POST', '/copy/remove'], ['POST', '/page'], ['POST', '/drive/message'], ['POST', '/drive/permission'],
  ['POST', '/drive/interrupt'], ['POST', '/drive/signin'], ['POST', '/drive/signin-code'], ['POST', '/drive/signin-cancel'],
  ['POST', '/drive/mode'], ['POST', '/drive/agent-mode'], ['POST', '/drive/effort'], ['POST', '/drive/stop-agent'],
  ['POST', '/drive/stop'], ['POST', '/board/clear'], ['POST', '/report'],
];
const ASK = 'Open this page once from Claude Code: /editlens';

let unknown = null;
test('D21: an account EditLens cannot tell gets only /health and /live.js without the key', async () => {
  unknown = await server(5440, 'unknown');
  const health = await request(unknown.port, 'GET', '/health');
  assert.strictEqual(health.status, 200);
  assert.strictEqual(JSON.parse(health.text).key, 'needed');
  assert.strictEqual((await request(unknown.port, 'GET', '/live.js')).status, 200);
  for (const [method, route, headers] of OPEN_ROUTES) {
    const r = await request(unknown.port, method, route, { body: method === 'POST' ? {} : undefined, headers });
    assert.strictEqual(r.status, 403, `${method} ${route}: ${r.status} ${r.text.slice(0, 80)}`);
    assert.ok(r.text.includes(route === '/answer' && method === 'GET' ? 'from your page\'s panel' : ASK), `${method} ${route}: ${r.text.slice(0, 120)}`);
  }
  // The answer window's key never leaves the server for this account.
  assert.doesNotMatch((await request(unknown.port, 'GET', '/answer', { headers: NAV })).text, /[0-9a-f]{64}/);
});

test('D21: with the page key in the address, the page and the window work; a wrong key does not', async () => {
  const info = JSON.parse((await request(unknown.port, 'GET', '/page-key', { headers: unknown.hook })).text);
  assert.strictEqual(info.needed, true);
  assert.match(info.key, /^[0-9a-f]{32}$/);
  const gk = `/gk-${info.key}`;
  const health = JSON.parse((await request(unknown.port, 'GET', `${gk}/health`)).text);
  assert.strictEqual(health.key, undefined, 'the key is good: nothing to ask');
  const stream = await request(unknown.port, 'GET', `${gk}/events?page=p1&url=${encodeURIComponent('http://localhost:5173/')}`);
  assert.strictEqual(stream.status, 200);
  assert.match(stream.text, /event: claude/);
  const win = await request(unknown.port, 'GET', `${gk}/answer`, { headers: NAV });
  assert.strictEqual(win.status, 200);
  assert.match(win.text, /var KEY = "[0-9a-f]{64}"/);
  const wrong = await request(unknown.port, 'GET', `/gk-${'0'.repeat(32)}/events?page=p1`);
  assert.strictEqual(wrong.status, 403);
  assert.strictEqual(JSON.parse((await request(unknown.port, 'GET', `/gk-${'0'.repeat(32)}/health`)).text).key, 'needed');
  // The hook key still works everywhere, and the page key is given only with it.
  const summary = await request(unknown.port, 'GET', '/summary', { headers: unknown.hook });
  assert.strictEqual(summary.status, 200);
  assert.strictEqual(JSON.parse(summary.text).pageKey, info.key, 'the terminal\'s Open button gets it');
  assert.strictEqual(JSON.parse((await request(unknown.port, 'GET', `${gk}/summary`)).text).pageKey, undefined, 'a page never gets it from the server');
  assert.notStrictEqual((await request(unknown.port, 'GET', '/page-key')).status, 200);
  assert.notStrictEqual((await request(unknown.port, 'GET', `${gk}/page-key`)).status, 200, 'the page key does not give itself');
  // The same key after a restart (made from the key file in the state folder).
  const again = fs.readFileSync(path.join(unknown.dir, 'gateway-key'), 'utf8');
  assert.match(again.trim(), /^[0-9a-f]{64}$/);
});

test('D21: Linux, where the account is known: the same user needs no key, another user is still refused', async () => {
  const same = await server(5441, undefined);
  assert.strictEqual((await request(same.port, 'GET', '/events?page=p1')).status, 200);
  assert.strictEqual(JSON.parse((await request(same.port, 'GET', '/health')).text).key, undefined);
  assert.strictEqual((await request(same.port, 'GET', '/answer', { headers: NAV })).status, 200);
  assert.deepStrictEqual(JSON.parse((await request(same.port, 'GET', '/page-key', { headers: same.hook })).text), { needed: false, key: null });
  const other = await server(5442, process.getuid() + 4242);
  const r = await request(other.port, 'GET', '/events?page=p1');
  assert.strictEqual(r.status, 403);
  assert.match(r.text, /belongs to another user/);
  const info = JSON.parse((await request(other.port, 'GET', '/page-key', { headers: other.hook })).text);
  assert.strictEqual((await request(other.port, 'GET', `/gk-${info.key || '0'.repeat(32)}/events?page=p1`)).status, 403, 'a key does not let another account in');
});

test('D21: a paired page through the link needs no page key (the link has its own, D11)', async () => {
  const host = await server(5443, 'unknown', 5444);
  const pair = JSON.parse((await request(host.port, 'POST', '/pair', { body: { cwd: project }, headers: host.hook })).text);
  const remotes = new PairRemotes({ stateDir: path.join(base, 'remote'), port: 5445, log: () => {}, otherUser: () => false });
  remotesList.push(remotes);
  const joined = await remotes.join(`127.0.0.1:5444`, pair.code);
  assert.ok(joined.ok, JSON.stringify(joined));
  const h = remotes.hosts[0];
  const r = await request(h.liveGateway, 'GET', `/gk-${remotes.token('live', h.liveGateway)}/events?page=p9`);
  assert.strictEqual(r.status, 200);
  assert.match(r.text, /event: claude/);
});

test('D21: /editlens prints and opens the page address with the key when no page is connected', { skip: process.platform !== 'linux' && 'the fake opener is xdg-open (Linux)' }, async () => {
  const dir = path.join(base, 'state-5446');
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const opened = path.join(base, 'opened.txt');
  fs.writeFileSync(path.join(bin, 'xdg-open'), `#!/bin/sh\necho "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_OPTION_START: 'Connect the page',
    EDITLENS_PORT: '5446', EDITLENS_STATE_DIR: dir, EDITLENS_TEST_PEER: 'unknown', DISPLAY: ':0' };
  for (const k of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'WAYLAND_DISPLAY', 'EDITLENS_TYPED', 'EDITLENS_NO_BROWSER', 'EDITLENS_SAY']) delete env[k];
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js')], { env, timeout: 60000 }, (err, stdout) => resolve(String(stdout)));
  });
  try {
    await new Promise((r) => setTimeout(r, 400));
    const token = fs.readFileSync(path.join(dir, 'token-5446'), 'utf8');
    const key = JSON.parse((await request(5446, 'GET', '/page-key', { headers: { 'x-editlens-token': token } })).text).key;
    assert.match(out, new RegExp(`Page ·+ http://(localhost|127\\.0\\.0\\.1):\\d+/#editlens-key=${key}`), out);
    const calls = fs.existsSync(opened) ? fs.readFileSync(opened, 'utf8').split('\n').filter(Boolean) : [];
    assert.strictEqual(calls.length, 1, out);
    assert.match(calls[0], new RegExp(`^http://(localhost|127\\.0\\.0\\.1):\\d+/#editlens-key=${key}$`));
  } finally {
    // The server /editlens started: stopped with the hook key.
    const token = fs.readFileSync(path.join(dir, 'token-5446'), 'utf8');
    await request(5446, 'POST', '/shutdown', { body: { force: true }, headers: { 'x-editlens-token': token } });
  }
});
