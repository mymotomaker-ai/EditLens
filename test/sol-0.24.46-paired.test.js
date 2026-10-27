'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5384';
// Sol scan of 0.24.46, paired findings on running servers: the paired /events stream sends no text of
// an excluded file such as .git/config (H2), a task for a paired subfolder merges nothing outside it
// (H4), and with "Paired computers can run Claude here" turned off a paired page can no longer message
// page control (M3). Two servers stand in for a VPS (/repo, paired for /repo/app-a) and a laptop.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { killPid } = require('./kill');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol46-pair-')));
const state = path.join(base, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(base, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const exe = path.join(base, 'bin', 'claude');
fs.mkdirSync(path.dirname(exe));
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
const ROOT = path.join(__dirname, '..');
const VPS = { port: 5384, pairPort: 5385, dir: path.join(base, 'vps') };
const LAPTOP = { port: 5386, pairPort: 5387, dir: path.join(base, 'laptop') };
const repo = path.join(base, 'repo');
const appA = path.join(repo, 'app-a');
const appB = path.join(repo, 'app-b');
const projL = path.join(base, 'laptop-folder');
const children = new Set();

function env(s) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SSH_|^DISPLAY$|^WAYLAND_DISPLAY$|^EDITLENS_NO_BROWSER$/.test(k)));
  return { ...clean, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_SDK_DIR: path.join(base, 'sdk'), FAKE_CLAUDE_STATE: state, EDITLENS_CLAUDE_PATH: exe, EDITLENS_NO_BROWSER: '1' };
}
function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message, json: null }));
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
const token = (s) => fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
const api = (s, method, p, body) => request(s.port, method, p, body, { 'x-editlens-token': token(s) }).then((r) => r.json);
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function startServer(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const out = fs.openSync(path.join(s.dir, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: env(s), stdio: ['ignore', out, out] });
  fs.closeSync(out);
  children.add(child);
  child.on('exit', () => children.delete(child));
  assert.ok(await waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200));
}
// The paired page as a browser opens it from the address with the key.
async function openPaired(keyUrl) {
  let at = new URL(keyUrl);
  let cookie = '';
  for (let i = 0; i < 4; i++) {
    const r = await request(Number(at.port), 'GET', at.pathname + at.search, undefined, { host: at.host, ...(cookie && at.hostname === '127.0.0.1' ? { cookie } : {}) });
    if (r.status !== 302) break;
    if (r.headers['set-cookie'] && at.hostname === '127.0.0.1') cookie = String(r.headers['set-cookie']).split(';')[0];
    at = new URL(r.headers.location, at);
  }
  const sitePort = Number(new URL(keyUrl).port);
  const html = (await request(sitePort, 'GET', '/', undefined, { cookie })).text;
  const m = /127\.0\.0\.1:(\d+)((?:\/gk-[0-9a-f]{32})?)\/live\.js/.exec(html);
  assert.ok(m, html.slice(0, 300));
  return { port: Number(m[1]), gk: m[2], origin: `http://127.0.0.1:${sitePort}` };
}
function stream(port, urlPath, headers = {}) {
  const s = { text: '' };
  s.req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (r) => r.on('data', (c) => { s.text += c; }));
  s.req.on('error', () => {});
  return s;
}
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

let joined = null;
let paired = null;
test.before(async () => {
  fs.mkdirSync(appA, { recursive: true });
  fs.mkdirSync(appB, { recursive: true });
  fs.mkdirSync(projL);
  fs.writeFileSync(path.join(appA, 'index.html'), '<html><body>app-a</body></html>\n');
  fs.writeFileSync(path.join(appB, 'b.txt'), 'b\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'start');
  await startServer(VPS);
  await startServer(LAPTOP);
  assert.ok((await api(VPS, 'POST', '/connect', { cwd: appA })).ok);
  await api(VPS, 'POST', '/event', { type: 'session', sessionId: 's-repo', cwd: repo, execPath: exe, ts: Date.now() });
  const pair = await api(VPS, 'POST', '/pair', { cwd: appA });
  joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined && joined.ok, JSON.stringify(joined));
  paired = await openPaired(joined.host.keyUrl);
});
test.after(async () => {
  for (const c of children) killPid(c.pid, 'SIGTERM');
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

test('H2: the paired /events stream sends an edit of .git/config without its text, live and replayed', async () => {
  const { port, gk, origin } = paired;
  const page = stream(port, gk + '/events?page=h2-page&root=' + encodeURIComponent(appA), { origin });
  const local = stream(VPS.port, '/events?page=h2-local&root=' + encodeURIComponent(appA));
  try {
    assert.ok(await waitFor(() => page.text.includes('"type":"hello"') && local.text.includes('"type":"hello"')), 'both pages are open');
    fs.mkdirSync(path.join(appA, '.git'), { recursive: true });
    const change = (file, word) => api(VPS, 'POST', '/event', {
      type: 'change', sessionId: 's-repo', cwd: repo, tool: 'Edit', file, relFile: path.relative(repo, file), kind: 'other', before: 'before\n', after: `${word}\n`,
      hunks: [{ oldStart: 1, newStart: 1, lines: ['-before', `+${word}`] }], hints: { selectors: [], ids: [], classes: [], texts: [word] }, stats: { added: 1, removed: 1 },
    });
    await change(path.join(appA, '.git', 'config'), 'url-with-tok-zebra');
    await change(path.join(appA, 'index.html'), 'plain-edit-words');
    assert.ok(await waitFor(() => page.text.includes('plain-edit-words') && local.text.includes('url-with-tok-zebra')), 'both edits are shown');
    assert.ok(page.text.includes('.git/config'), 'the paired page is told the file changed');
    assert.ok(!page.text.includes('url-with-tok-zebra'), 'no text of .git/config on the paired stream');
    // A page that opens later gets the edits again as its backlog: still without that text.
    const later = stream(port, gk + '/events?page=h2-later&root=' + encodeURIComponent(appA), { origin });
    try {
      assert.ok(await waitFor(() => later.text.includes('plain-edit-words')), 'the backlog is sent');
      assert.ok(!later.text.includes('url-with-tok-zebra'), 'no text of .git/config in the backlog');
    } finally {
      later.req.destroy();
    }
  } finally {
    page.req.destroy();
    local.req.destroy();
  }
});

test('H4: merging a task for the paired subfolder leaves files outside it in the copy', async () => {
  const name = joined.host.name;
  const task = (body) => api(LAPTOP, 'POST', '/remote/task', { computer: name, localDir: projL, ...body });
  const started = await task({ op: 'start', prompt: 'files own.html,../app-b/evil.html,../top.html' });
  assert.ok(started && started.task, JSON.stringify(started));
  assert.ok(await waitFor(async () => (await task({ op: 'check', task: started.task })).state === 'idle', 30000), 'the task finished its turn');
  const dry = await task({ op: 'merge', task: started.task, dryRun: true });
  assert.deepStrictEqual(dry.wouldMerge, ['app-a/own.html'], JSON.stringify(dry));
  const merged = await task({ op: 'merge', task: started.task });
  assert.deepStrictEqual(merged.applied, ['app-a/own.html'], JSON.stringify(merged));
  assert.ok(fs.existsSync(path.join(appA, 'own.html')), 'the file in the paired folder is merged');
  assert.ok(!fs.existsSync(path.join(appB, 'evil.html')), 'nothing is written in the sibling folder');
  assert.ok(!fs.existsSync(path.join(repo, 'top.html')), 'nothing is written above the paired folder');
  assert.deepStrictEqual([...merged.outside].sort(), ['app-b/evil.html', 'top.html']);
  assert.match(merged.note, /outside app-a/);
});

test('M3: with the setting turned off, a paired page can no longer message page control, only stop it', async () => {
  const { port, gk, origin } = paired;
  const page = stream(port, gk + '/events?page=m3-page&root=' + encodeURIComponent(appA), { origin });
  try {
    assert.ok(await waitFor(() => page.text.includes('"type":"hello"')), 'the paired page is open');
    const grant = await request(VPS.port, 'POST', '/drive/grant', { cwd: appA }, { 'x-editlens-token': token(VPS) });
    assert.strictEqual(grant.status, 200, grant.text);
    assert.ok(await waitFor(() => /"type":"drive-grant"/.test(page.text), 30000), 'the paired page gets page control');
    const key = /"type":"drive-grant","key":"([^"]+)"/.exec(page.text)[1];
    const send = (p, body) => request(port, 'POST', gk + p, { pageId: 'm3-page', key, ...body }, { origin });
    assert.strictEqual((await send('/drive/message', { text: 'first message' })).status, 200, 'allowed while the setting is on');
    const off = await api(VPS, 'POST', '/settings/report', { values: { remote_tasks: false } });
    assert.strictEqual(off.values.remote_tasks, false, JSON.stringify(off));
    const refused = await send('/drive/message', { text: 'after the setting is off' });
    assert.strictEqual(refused.status, 403, refused.text);
    assert.match(refused.json.error, /Running Claude from paired computers is turned off/);
    assert.strictEqual((await send('/drive/effort', { level: 'high' })).status, 403);
    assert.strictEqual((await send('/drive/stop', {})).status, 200, 'Manual still works');
  } finally {
    page.req.destroy();
    await api(VPS, 'POST', '/settings/report', { values: { remote_tasks: true } });
    await api(VPS, 'POST', '/drive/end', {});
  }
});
