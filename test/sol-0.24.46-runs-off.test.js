'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5480';
// Sol scan of 0.24.46, part 2: "Paired computers can run Claude here" turned off stops work that
// was asked for earlier. Waiting tasks don't start (S2), a paired page can't message Claude (N1),
// and page control asked for before its page opened checks the settings in effect then (S5).
// Two servers stand in for a VPS (paired for /repo/app-a) and a laptop.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { killPid } = require('./kill');

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-runs-off46-')));
const state = path.join(base, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(base, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
process.env.EDITLENS_SDK_DIR = path.join(base, 'sdk');
const exe = path.join(base, 'bin', 'claude');
fs.mkdirSync(path.dirname(exe));
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
const ROOT = path.join(__dirname, '..');
const VPS = { port: 5480, pairPort: 5481, dir: path.join(base, 'vps') };
const LAPTOP = { port: 5482, pairPort: 5483, dir: path.join(base, 'laptop') };
const repo = path.join(base, 'repo');
const appA = path.join(repo, 'app-a');
const children = new Set();
const { Tasks } = require('../server/tasks');

function env(s) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SSH_|^DISPLAY$|^WAYLAND_DISPLAY$|^EDITLENS_NO_BROWSER$|^CLAUDE_PLUGIN_OPTION_/.test(k)));
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
  s.req.on('error', (err) => { if (err.code !== 'ECONNRESET') throw err; });
  return s;
}
const serverLog = () => fs.readFileSync(path.join(VPS.dir, 'server.log'), 'utf8');
const OFF = /Running Claude from paired computers is turned off/;
// Off is the stricter value, so a report counts immediately; every report gives all the values.
const report = (values) => api(VPS, 'POST', '/settings/report', { values: { remote_tasks: false, ...values } });

let paired = null;
let pairId = null;
test.before(async () => {
  fs.mkdirSync(appA, { recursive: true });
  fs.writeFileSync(path.join(appA, 'index.html'), '<html><body>app-a</body></html>\n');
  await startServer(VPS);
  await startServer(LAPTOP);
  assert.ok((await api(VPS, 'POST', '/connect', { cwd: appA })).ok);
  await api(VPS, 'POST', '/event', { type: 'session', sessionId: 's-repo', cwd: repo, execPath: exe, ts: Date.now() });
  const pair = await api(VPS, 'POST', '/pair', { cwd: appA });
  const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined && joined.ok, JSON.stringify(joined));
  paired = await openPaired(joined.host.keyUrl);
  pairId = JSON.parse(fs.readFileSync(path.join(VPS.dir, 'pair-host.json'), 'utf8')).pairs[0].id;
});
test.after(async () => {
  for (const c of children) killPid(c.pid, 'SIGTERM');
  await sleep(300);
  fs.rmSync(base, { recursive: true, force: true });
});

test('S2: a task waiting for a free session does not start once the setting is off; it ends saying why', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'tasks-'));
  let allowed = true;
  let started = 0;
  const tasks = new Tasks({ stateDir: dir, host: 'vps', limit: () => 1, runsAllowed: () => allowed,
    makeDriver: () => {
      started++;
      throw new Error('a Claude session was started');
    } });
  // One task already takes the only session, so the next one waits.
  tasks.items.set('busy', { id: 'busy', reserved: true, permissions: new Map(), replies: [] });
  const out = await tasks.start({ id: 'p1', name: 'laptop', cwd: appA }, { prompt: 'make the title bold' });
  assert.strictEqual(out.state, 'waiting', JSON.stringify(out));
  allowed = false;
  tasks.items.delete('busy');
  tasks.limitChanged();
  await sleep(200);
  const t = tasks.items.get(out.task);
  assert.strictEqual(started, 0, 'no Claude session started for the waiting task');
  assert.strictEqual(t.state, 'failed');
  assert.match(t.error, OFF);
  assert.strictEqual(tasks.queue.length, 0);
  // The start itself checks too (a follow-up, or a start that was already on its way).
  const done = { id: 'old1', by: 'laptop', pairId: 'p1', cwd: appA, dir: appA, prompt: 'x', state: 'ended', replies: [], replyCount: 1, permissions: new Map() };
  tasks.items.set(done.id, done);
  const again = await tasks.run(done, null, 'and the subtitle');
  assert.match(String(again.error), OFF);
  assert.strictEqual(started, 0);
  clearTimeout(tasks.saveTimer);
});

test('N1 and S5: with the setting off, a paired page cannot message Claude and its waiting page control does not start', async () => {
  const { port, gk, origin } = paired;
  // A message sent while the setting is on waits for Claude.
  const first = stream(port, gk + '/events?page=n1-first&root=' + encodeURIComponent(appA), { origin });
  assert.ok(await waitFor(() => first.text.includes('"type":"hello"')), 'the paired page is open');
  const sent = await request(port, 'POST', gk + '/message', { pageId: 'n1-first', text: 'sent while on' }, { origin });
  assert.strictEqual(sent.status, 200, sent.text);
  // The message names the paired computer it came from, for the label on this computer's pages.
  const name = JSON.parse(fs.readFileSync(path.join(VPS.dir, 'pair-host.json'), 'utf8')).pairs[0].name;
  assert.ok(await waitFor(() => first.text.includes(sent.json.id)), 'the page got the message');
  const shown = first.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
    .find((e) => e.type === 'page-message' && e.id === sent.json.id);
  assert.strictEqual(shown.computer, name);
  first.req.destroy();
  assert.ok(await waitFor(async () => !(await api(VPS, 'GET', '/pages/live')).length), 'the page closed');
  // /editlens control <name> from the laptop with no page open: it starts when one opens.
  const armed = await api(VPS, 'POST', '/drive/auto', { cwd: appA, paired: true, pairedBy: pairId });
  assert.ok(armed && armed.ok, JSON.stringify(armed));
  assert.strictEqual((await report({})).values.remote_tasks, false);

  const page = stream(port, gk + '/events?page=n1-page&root=' + encodeURIComponent(appA), { origin });
  try {
    assert.ok(await waitFor(() => page.text.includes('"type":"hello"')), 'the paired page is open');
    // S5: the page control asked for earlier is not started now.
    await sleep(3000);
    assert.doesNotMatch(page.text, /"type":"drive-grant"/, 'no page control for the paired page');
    assert.match(serverLog(), /auto page control: not waiting any more \(Running Claude from paired computers is turned off/);
    // N1: a new message is refused with the same words as page control's refusal.
    const refused = await request(port, 'POST', gk + '/message', { pageId: 'n1-page', text: 'sent while off' }, { origin });
    assert.strictEqual(refused.status, 403, refused.text);
    assert.match(refused.json.error, OFF);
    // The message that was waiting is not given to Claude while the setting is off.
    const taken = await api(VPS, 'GET', '/messages/take?cwd=' + encodeURIComponent(appA));
    assert.deepStrictEqual(taken.messages, [], JSON.stringify(taken));
    // D27 B: it ended when the setting went off, and the page is told why (not "You canceled it").
    const ended = page.text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => JSON.parse(l.slice(6)))
      .find((e) => e.type === 'cancelled' && e.ids.includes(sent.json.id));
    assert.ok(ended, 'the page got the end of the waiting message');
    assert.match(String(ended.reason), OFF);
    const cancel = await request(port, 'POST', gk + '/message/cancel', { page: 'n1-page', id: sent.json.id }, { origin });
    assert.strictEqual(cancel.status, 200, cancel.text);
    assert.strictEqual(cancel.json.already, true, cancel.text);
  } finally {
    page.req.destroy();
    await api(VPS, 'POST', '/drive/end', {});
  }
});

test('S5: page control asked for by a session start checks "What /editlens does" when the page opens; /editlens control does not', async () => {
  assert.ok(await waitFor(async () => !(await api(VPS, 'GET', '/pages/live')).length), 'the paired page closed');
  await report({ start: 'Connect and turn on page control', auto_connect: true });
  // The session start asks (the hook, as hooks/live-hook.js does), then the user picks Connect the page.
  const armed = await api(VPS, 'POST', '/drive/auto', { cwd: appA, sessionId: 's-repo' });
  assert.ok(armed && armed.ok, JSON.stringify(armed));
  await report({ start: 'Connect the page', auto_connect: true });
  const page = stream(VPS.port, '/events?page=s5-local&root=' + encodeURIComponent(appA));
  try {
    assert.ok(await waitFor(() => page.text.includes('"type":"hello"')), 'the page is open');
    await sleep(3000);
    assert.doesNotMatch(page.text, /"type":"drive-grant"/, 'page control did not start by itself');
    assert.match(serverLog(), /auto page control: not waiting any more \("What \/editlens does" is now "Connect the page"/);
    // "Connect when Claude Code starts" off: the same.
    await report({ start: 'Connect and turn on page control', auto_connect: false });
    assert.ok((await api(VPS, 'POST', '/drive/auto', { cwd: appA, sessionId: 's-repo' })).ok);
    await sleep(1500);
    assert.doesNotMatch(page.text, /"type":"drive-grant"/);
    assert.match(serverLog(), /auto page control: not waiting any more \("Connect when Claude Code starts" is now off/);
    // /editlens control typed here (bin/drive.js, no browser to open) is not refused by these settings.
    await report({ start: 'Connect the page', auto_connect: false });
    assert.ok((await api(VPS, 'POST', '/drive/auto', { cwd: appA, sessionId: 's-repo', origin: 'asked' })).ok);
    assert.ok(await waitFor(() => /"type":"drive-grant"/.test(page.text), 30000), 'page control started for the page');
    // The same for a grant /editlens control asks for directly.
    await api(VPS, 'POST', '/drive/end', {});
    const direct = await request(VPS.port, 'POST', '/drive/grant', { cwd: appA }, { 'x-editlens-token': token(VPS) });
    assert.strictEqual(direct.status, 200, direct.text);
    // ...while a grant from a session start's own run (auto) is refused.
    await api(VPS, 'POST', '/drive/end', {});
    const auto = await request(VPS.port, 'POST', '/drive/grant', { cwd: appA, auto: true }, { 'x-editlens-token': token(VPS) });
    assert.strictEqual(auto.status, 409, auto.text);
    assert.match(auto.json.error, /"What \/editlens does" is now "Connect the page"/);
  } finally {
    page.req.destroy();
    await api(VPS, 'POST', '/drive/end', {});
  }
});
