'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5262';
// The command check of 0.24.39, pairing cases. M5: /editlens control <name> when the paired page is
// not open here: the address this computer opens is given, and with a browser here it opens it and
// waits. L7: join off after the other computer's pair off says what to do there, plainly.
// Two servers on this machine stand in for the laptop and the VPS; stand-in SDK, claude and browser.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pair-cmds-'));
const state = path.join(base, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(base, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
// Named claude, as findClaude accepts only that name; else it looks on PATH (no claude on CI).
const exe = path.join(base, 'bin', 'claude');
fs.mkdirSync(path.dirname(exe));
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
const ROOT = path.join(__dirname, '..');
const LAPTOP = { port: 5262, pairPort: 5263, dir: path.join(base, 'laptop') };
const VPS = { port: 5264, pairPort: 5265, dir: path.join(base, 'vps') };
const projL = path.join(base, 'laptop-folder');
const projV = path.join(base, 'vps-folder');
fs.mkdirSync(projL);
fs.mkdirSync(projV);
const children = new Set();

// A stand-in browser (xdg-open): it loads the page, then keeps its panel's event stream open.
const browserBin = path.join(base, 'browser');
fs.mkdirSync(browserBin);
fs.writeFileSync(path.join(browserBin, 'xdg-open'), `#!${process.execPath}
const http = require('http');
const cookies = {};
// As a browser: redirects followed, each name (127.0.0.1, localhost) with its own cookie. family 4:
// a browser tries 127.0.0.1 when ::1 refuses; Node 18 does not (CI lists ::1 for localhost first).
function open(url, left) {
  http.get(url, { family: 4, headers: cookies[url.hostname] ? { cookie: cookies[url.hostname] } : {} }, (res) => {
    if (res.statusCode === 302 && left > 0) {
      if (res.headers['set-cookie']) cookies[url.hostname] = String(res.headers['set-cookie']).split(';')[0];
      res.resume();
      return open(new URL(res.headers.location, url), left - 1);
    }
    let html = '';
    res.on('data', (c) => { html += c; });
    res.on('end', () => {
      const live = /127\\.0\\.0\\.1:(\\d+)((?:\\/gk-[0-9a-f]{32})?)\\/live\\.js/.exec(html);
      if (!live) process.exit(1);
      http.get({ host: '127.0.0.1', port: Number(live[1]), path: live[2] + '/events?page=browser-page&root=' + encodeURIComponent(${JSON.stringify(projV)}), headers: { origin: url.origin } }, (r) => r.resume());
      setTimeout(() => process.exit(0), 30000);
    });
    return undefined;
  }).on('error', () => process.exit(1));
}
open(new URL(process.argv[2]), 4);
`);
fs.chmodSync(path.join(browserBin, 'xdg-open'), 0o755);

function env(s) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SSH_|^DISPLAY$|^WAYLAND_DISPLAY$|^EDITLENS_NO_BROWSER$/.test(k)));
  return { ...clean, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_SDK_DIR: path.join(base, 'sdk'), FAKE_CLAUDE_STATE: state, EDITLENS_CLAUDE_PATH: exe };
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
    if (data) req.write(data);
    req.end();
  });
}
const api = (s, method, p, body) => request(s.port, method, p, body, { 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') }).then((r) => r.json);
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
// /editlens on the laptop, as Claude Code runs it.
function laptop(args, extra = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { cwd: projL, timeout: 180000, env: { ...env(LAPTOP), CLAUDE_PROJECT_DIR: projL, ...extra } },
      (err, stdout) => (err && err.killed ? reject(err) : resolve({ out: stdout, code: err ? err.code : 0 })));
  });
}
// /editlens on the VPS, as Claude Code runs it there.
function vps(args, extra = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { cwd: projV, timeout: 180000, env: { ...env(VPS), CLAUDE_PROJECT_DIR: projV, ...extra } },
      (err, stdout) => (err && err.killed ? reject(err) : resolve({ out: stdout, code: err ? err.code : 0 })));
  });
}
// The paired page as a browser opens it from the address with the key (D11): the site's cookie,
// and the page script's address through the link (its port, and the key at the start of its path).
// The port of an address, a whole number from 1 to 65535.
function portOf(url) {
  const port = Number(new URL(url).port);
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535, `no port in ${url}`);
  return port;
}
async function openPaired(keyUrl) {
  let at = new URL(keyUrl);
  let cookie = '';
  for (let i = 0; i < 4; i++) {
    const r = await request(portOf(at), 'GET', at.pathname + at.search, undefined, { host: at.host, ...(cookie && at.hostname === '127.0.0.1' ? { cookie } : {}) });
    if (r.status !== 302) break;
    if (r.headers['set-cookie'] && at.hostname === '127.0.0.1') cookie = String(r.headers['set-cookie']).split(';')[0];
    at = new URL(r.headers.location, at);
  }
  const sitePort = portOf(keyUrl);
  const html = (await request(sitePort, 'GET', '/', undefined, { cookie })).text;
  const m = /127\.0\.0\.1:(\d+)((?:\/gk-[0-9a-f]{32})?)\/live\.js/.exec(html);
  assert.ok(m, html.slice(0, 300));
  return { sitePort, cookie, html, port: portOf(`http://127.0.0.1:${m[1]}`), gk: m[2], origin: `http://127.0.0.1:${sitePort}` };
}

let site;
test.before(async () => {
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><head><title>vps</title></head><body>the VPS folder</body></html>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  await startServer(LAPTOP);
  await startServer(VPS);
});
test.after(async () => {
  for (const c of children) c.kill();
  site.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

test('M5, L7, D6: control <name> opens the paired page here and waits; pair off there ends it; join off after', async () => {
  assert.ok((await api(VPS, 'POST', '/connect', { cwd: projV, target: `http://127.0.0.1:${site.address().port}` })).ok);
  const vpsPage = (await api(VPS, 'GET', '/connections'))[0].url;
  const pair = await api(VPS, 'POST', '/pair', { cwd: projV });
  const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  const name = joined.host.name;
  const here = joined.host.url.replace('127.0.0.1', 'localhost');

  // No browser here: the address to open is this computer's, not the VPS's own. R4 (0.24.40): page
  // control starts there when that page is opened, as /editlens control does with no browser.
  const none = await laptop(['control', name], { EDITLENS_NO_BROWSER: '1' });
  assert.strictEqual(none.code, 0, none.out);
  assert.ok(none.out.includes(here), none.out);
  assert.ok(!none.out.includes(vpsPage.replace('127.0.0.1', 'localhost')), 'not the VPS\'s address: ' + none.out);
  assert.match(none.out, /page control starts when its page is open here/);
  assert.doesNotMatch(none.out, /Page control on ◆/);
  // The address it printed has this user's key (D11), which the first visit needs.
  assert.ok(none.out.includes(joined.host.keyUrl.replace('127.0.0.1', 'localhost')), none.out);
  const later = spawn(path.join(browserBin, 'xdg-open'), [joined.host.keyUrl], { stdio: 'ignore' });
  children.add(later);
  assert.ok(await waitFor(async () => (await api(VPS, 'GET', `/summary?cwd=${encodeURIComponent(projV)}`)).control === 'page'), 'on when the page opened');
  later.kill();
  assert.ok((await api(VPS, 'POST', '/drive/end', {})));

  // A browser here: it opens the paired page and waits for it.
  const opened = await laptop(['control', name], { DISPLAY: ':0', PATH: `${browserBin}${path.delimiter}${process.env.PATH}` });
  assert.strictEqual(opened.code, 0, opened.out);
  assert.match(opened.out, new RegExp(`Page control on ◆ ${name}`));
  const control = async () => (await api(VPS, 'GET', `/summary?cwd=${encodeURIComponent(projV)}`)).control;
  assert.strictEqual(await control(), 'page');

  // D6 (the user's choice, option A): pair off on the VPS ends the page control the laptop turned on.
  // L7: then join off here.
  const pairOff = await vps(['pair', 'off']);
  assert.match(pairOff.out, /unpaired/);
  assert.match(pairOff.out, /Page control ended/);
  assert.ok(await waitFor(async () => (await control()) !== 'page'), 'page control ended');
  const off = await laptop(['join', 'off', name]);
  assert.match(off.out, new RegExp(`Unpaired ◆ ${name}`));
  assert.doesNotMatch(off.out, /until \/editlens pair off there/);
  assert.match(off.out, /If it still lists this computer, \/editlens pair off there removes it/);

  // D6: page control turned on on the VPS itself keeps running after pair off.
  const again = await api(VPS, 'POST', '/pair', { cwd: projV });
  assert.ok((await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: again.code })).ok);
  const own = await vps(['control'], { DISPLAY: ':0', PATH: `${browserBin}${path.delimiter}${process.env.PATH}` });
  assert.strictEqual(own.code, 0, own.out);
  assert.ok(await waitFor(async () => (await control()) === 'page'), 'on from the VPS itself');
  const keep = await vps(['pair', 'off']);
  assert.doesNotMatch(keep.out, /Page control ended/);
  assert.strictEqual(await control(), 'page');
  assert.ok((await api(VPS, 'POST', '/drive/end', {})));
  await laptop(['join', 'off', name]);
});

// H3 (Sol scan of 0.24.40): a paired page reads files only in the paired folder, even when a
// Claude Code session runs in a folder above it (/repo while /repo/app-a is paired).
test('H3: a paired page reads no file outside the paired folder', async () => {
  const repo = path.join(base, 'repo');
  const appA = path.join(repo, 'app-a');
  const appB = path.join(repo, 'app-b');
  fs.mkdirSync(appA, { recursive: true });
  fs.mkdirSync(appB, { recursive: true });
  fs.writeFileSync(path.join(appA, 'a.txt'), 'in app-a\n');
  fs.writeFileSync(path.join(appB, 'b.txt'), 'in app-b\n');
  fs.symlinkSync(appB, path.join(appA, 'b-link'));
  fs.writeFileSync(path.join(appA, 'index.html'), '<html><body>app-a</body></html>');
  assert.ok((await api(VPS, 'POST', '/connect', { cwd: appA })).ok);
  await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'h3-session', cwd: repo, ts: Date.now() });
  const pair = await api(VPS, 'POST', '/pair', { cwd: appA });
  const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  // The page's EditLens address through the link (its script tag), not the site's.
  const link = await openPaired(joined.host.keyUrl);
  // The paired page's event stream, through the link, as the page opens it.
  const stream = http.get({ host: '127.0.0.1', port: link.port, path: link.gk + '/events?page=h3-page&root=' + encodeURIComponent(appA), headers: { origin: link.origin }, agent: false }, (r) => r.resume());
  try {
    const file = (ref) => request(link.port, 'GET', `${link.gk}/file?page=h3-page&ref=${encodeURIComponent(ref)}`, undefined, { origin: link.origin });
    assert.ok(await waitFor(async () => (await file('a.txt')).status === 200), 'a file in the paired folder opens: ' + JSON.stringify(await file('a.txt')));
    for (const ref of [path.join(appB, 'b.txt'), '../app-b/b.txt', 'app-b/b.txt', 'b-link/b.txt']) {
      const r = await file(ref);
      // Not found, so neither its text (GET /snapshot checks that too) nor that it exists.
      assert.strictEqual(r.status, 404, `${ref}: ${r.text.slice(0, 200)}`);
      assert.ok(!r.json || !r.json.snapshot, ref);
    }
  } finally {
    stream.destroy();
    await api(VPS, 'POST', '/pair/off', {});
  }
});

// H1 (Sol scan of 0.24.43): with /repo/app-a paired and a session in /repo, an edit of
// /repo/app-b appeared in the paired stream, and its Restore and approvals were allowed.
test('H1: a paired page gets no event and no Restore for a file outside the paired folder', async () => {
  const repo = path.join(base, 'repo1');
  const appA = path.join(repo, 'app-a');
  const appB = path.join(repo, 'app-b');
  fs.mkdirSync(appA, { recursive: true });
  fs.mkdirSync(appB, { recursive: true });
  fs.writeFileSync(path.join(appA, 'index.html'), '<html><body>app-a</body></html>');
  assert.ok((await api(VPS, 'POST', '/connect', { cwd: appA })).ok);
  await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'h1-session', cwd: repo, ts: Date.now() });
  const pair = await api(VPS, 'POST', '/pair', { cwd: appA });
  const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  const { port, gk, origin } = await openPaired(joined.host.keyUrl);
  let seen = '';
  const stream = http.get({ host: '127.0.0.1', port, path: gk + '/events?page=h1-page&root=' + encodeURIComponent(appA), headers: { origin }, agent: false }, (r) => r.on('data', (c) => { seen += c; }));
  try {
    const edit = async (dir, name) => {
      const file = path.join(dir, name);
      fs.writeFileSync(file, 'new\n');
      await api(VPS, 'POST', '/event', { type: 'change', sessionId: 'h1-session', cwd: repo, tool: 'Edit', file, relFile: path.relative(repo, file), before: 'old\n', after: 'new\n', kind: 'other' });
      return (await api(VPS, 'GET', '/history')).filter((e) => e.type === 'change' && e.file === file).pop();
    };
    const inB = await edit(appB, 'b-secret-name.txt');
    const inA = await edit(appA, 'a-name.txt');
    assert.ok(inA && inB, 'both edits are in the history');
    assert.ok(await waitFor(() => seen.includes('a-name.txt')), 'the paired folder\'s edit is shown');
    assert.ok(!seen.includes('b-secret-name.txt'), 'the other folder\'s edit is not sent');
    const instance = (await api(VPS, 'GET', '/summary')).instance;
    const restore = (seq) => request(port, 'POST', gk + '/restore', { page: 'h1-page', undoEdit: seq, check: true, instance }, { origin });
    assert.strictEqual((await restore(inB.seq)).status, 403);
    assert.strictEqual((await restore(inA.seq)).status, 200);
  } finally {
    stream.destroy();
    await api(VPS, 'POST', '/pair/off', {});
  }
});

// D11 (the user's choice, option A; Sol H6): through the pairing, the page and its requests work
// only with this user's key; another user on this computer (no key file, no cookie) gets nothing.
test('D11: the paired page works with the key, and its addresses refuse requests without it', async () => {
  const pair = await api(VPS, 'POST', '/pair', { cwd: projV });
  const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  try {
    assert.ok(!JSON.stringify(await api(LAPTOP, 'GET', `/summary?cwd=${encodeURIComponent(projL)}`)).includes('editlens-key'), 'no key in the summary');
    const link = await openPaired(joined.host.keyUrl);
    assert.match(link.gk, /^\/gk-[0-9a-f]{32}$/);
    assert.strictEqual((await request(link.sitePort, 'GET', '/')).status, 403);
    // The other computer's live server answers through the link with the key in the path.
    const script = await request(link.port, 'GET', `${link.gk}/live.js`);
    assert.strictEqual(script.status, 200);
    assert.match(script.text, /EditLens/);
    const health = await request(link.port, 'GET', `${link.gk}/health`);
    assert.strictEqual(health.status, 200, health.text);
    assert.strictEqual(health.json.version, require('../lib/config').version);
    assert.strictEqual((await request(link.port, 'GET', '/health')).status, 403);
    assert.strictEqual((await request(link.port, 'GET', '/live.js')).status, 403);
  } finally {
    await api(VPS, 'POST', '/pair/off', {});
    await api(LAPTOP, 'POST', '/join/off', {});
  }
});

// Command check L1 (0.24.45): with "Paired computers can run Claude here" off on the other computer,
// the fix line says to turn it on there first, not to type the same command again.
test('L1: control <name> with the setting off there says to turn it on there', async () => {
  const pair = await api(VPS, 'POST', '/pair', { cwd: projV });
  const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  const name = joined.host.name;
  assert.strictEqual((await api(VPS, 'POST', '/settings/report', { values: { remote_tasks: false } })).values.remote_tasks, false);
  try {
    const r = await laptop(['control', name], { EDITLENS_NO_BROWSER: '1' });
    assert.notStrictEqual(r.code, 0, r.out);
    assert.match(r.out, /Running Claude from paired computers is turned off/);
    assert.doesNotMatch(r.out, /try again/, r.out);
    assert.match(r.out, new RegExp(`on ◆ ${name}, turn on "Paired computers can run Claude here" in /config, then[\\s\\S]*/editlens control ${name}`), r.out);
  } finally {
    await api(VPS, 'POST', '/settings/report', { values: { remote_tasks: true } });
    await laptop(['join', 'off', name]);
  }
});

// G1 (signed-in settings check, 0.24.45): a Claude that EditLens runs (a task's or page control's)
// has its own default settings; /editlens pair run from it doesn't report them as the user's.
test('G1: /editlens pair from a Claude EditLens runs reports no settings', async () => {
  const tasksAtOnce = async () => (await api(LAPTOP, 'GET', '/settings')).values.tasks_at_once;
  const before = await tasksAtOnce();
  const other = before === 7 ? 6 : 7;
  await laptop(['pair', 'off'], { CLAUDE_PLUGIN_OPTION_TASKS_AT_ONCE: String(other), EDITLENS_DRIVEN: '1' });
  assert.strictEqual(await tasksAtOnce(), before, 'the driven Claude\'s value is not taken');
  await laptop(['pair', 'off'], { CLAUDE_PLUGIN_OPTION_TASKS_AT_ONCE: String(before) });
  assert.strictEqual(await tasksAtOnce(), before);
});
