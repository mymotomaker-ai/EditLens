'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4902';
// The user's sequence: page control runs on the laptop in its own project; the laptop pairs with a
// VPS folder (/editlens pair there, /editlens join here), opens the VPS page through the pairing
// link, and turns page control on there (/editlens control <name>). Both run at the same time, each from its
// own page, and neither ends the other. The paired page says which version each side runs.
// Two EditLens servers on this machine stand in for the laptop and the VPS. Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { openPaired } = require('./paired-page');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pair-both-'));
const state = path.join(base, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(base, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(base, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const exe = path.join(bin, 'claude');
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const LAPTOP = { port: 4350, pairPort: 4351, dir: path.join(base, 'laptop') };
const VPS = { port: 4900, pairPort: 4901, dir: path.join(base, 'vps') };
const projL = path.join(base, 'test_project');
const projV = path.join(base, 'vps-test-folder');
fs.mkdirSync(projL);
fs.mkdirSync(projV);
const children = new Set();
const streams = new Set();

function env(s) {
  return { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_SDK_DIR: path.join(base, 'sdk'), FAKE_CLAUDE_STATE: state, EDITLENS_CLAUDE_PATH: exe };
}
function startServer(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const out = fs.openSync(path.join(s.dir, 'server.log'), 'a');
  const child = spawn(process.execPath, [SERVER], { env: env(s), stdio: ['ignore', out, out] });
  fs.closeSync(out);
  children.add(child);
  child.on('exit', () => children.delete(child));
  s.child = child;
  return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}
function token(s) {
  return fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
}
function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message, json: null }));
    req.setTimeout(60000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}
function api(s, method, urlPath, body) {
  return request(s.port, method, urlPath, body, { 'x-editlens-token': token(s) }).then((r) => r.json);
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}
// A page's event stream on `port` (headers: the paired page's origin; gk: the live key at the start of
// a paired page's paths); frames collects every event.
function openPage(port, id, root, headers = {}, gk = '') {
  const frames = [];
  const req = http.get({ host: '127.0.0.1', port, agent: false, path: `${gk}/events?page=${id}&root=${encodeURIComponent(root)}`, headers }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!data) continue;
        try {
          frames.push(JSON.parse(data.slice(6)));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    });
  });
  req.on('error', (err) => {
    if (err.code !== 'ECONNRESET') throw err;
  });
  const page = { id, frames, close: () => req.destroy(), key: () => (frames.filter((f) => f.type === 'drive-grant').pop() || {}).key };
  streams.add(page);
  return page;
}
const ended = (p) => p.frames.some((f) => f.type === 'drive' && f.phase === 'ended');

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
  for (const p of streams) p.close();
  for (const c of children) c.kill();
  site.close();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

test('page control on the laptop and on the paired VPS folder run at the same time; neither ends the other', async () => {
  // 1. The laptop's own page control, in test_project.
  const pl = openPage(LAPTOP.port, 'laptop-page', projL);
  assert.ok(await waitFor(async () => (await api(LAPTOP, 'GET', '/pages/live')).some((p) => p.id === 'laptop-page')));
  const g = await api(LAPTOP, 'POST', '/drive/grant', { cwd: projL, fresh: true, claudePath: exe });
  assert.ok(g.ok, JSON.stringify(g));
  assert.ok(await waitFor(() => Boolean(pl.key())));

  // 2. /editlens pair on the VPS folder, /editlens join on the laptop.
  assert.ok((await api(VPS, 'POST', '/connect', { cwd: projV, target: `http://127.0.0.1:${site.address().port}` })).ok);
  const pair = await api(VPS, 'POST', '/pair', { cwd: projV });
  const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  const name = joined.host.name;
  assert.strictEqual((await api(LAPTOP, 'GET', '/summary')).control, 'page', 'joining leaves the laptop\'s page control on');

  // 3. The VPS folder's page, opened on the laptop through the pairing link.
  // With this user's key (D11): the site's cookie, and the live key at the start of each path.
  const { sitePort, port: livePort, gk } = await openPaired(LAPTOP.dir, joined.host.url);
  assert.notStrictEqual(livePort, LAPTOP.port, 'its panel talks to the VPS, not the laptop\'s server');
  const pv = openPage(livePort, 'vps-page', projV, { origin: `http://127.0.0.1:${sitePort}` }, gk);
  assert.ok(await waitFor(async () => (await api(VPS, 'GET', '/pages/live')).some((p) => /vps-page$/.test(p.id))));
  // It says which version each side runs (the same here).
  const hello = pv.frames.find((f) => f.type === 'hello');
  assert.deepStrictEqual(hello.via, { name: hello.via.name, peerVersion: require('../lib/config').version });

  // 4. /editlens control <name> on the laptop: page control on the VPS, from the paired page.
  const c = await api(LAPTOP, 'POST', '/join/control', { name, args: [] });
  assert.ok(c.ok, JSON.stringify(c));
  assert.ok(await waitFor(() => Boolean(pv.key())), 'the paired page got page control on the VPS');

  // 5. Both run; neither page was told page control ended.
  assert.strictEqual((await api(LAPTOP, 'GET', `/summary?cwd=${encodeURIComponent(projL)}`)).control, 'page');
  assert.strictEqual((await api(VPS, 'GET', `/summary?cwd=${encodeURIComponent(projV)}`)).control, 'page');
  assert.ok(!ended(pl), 'the laptop page was never switched to Manual');
  assert.ok(!ended(pv));

  // 6. Each page runs its own Claude, in its own folder.
  const sendL = await request(LAPTOP.port, 'POST', '/drive/message', { key: pl.key(), pageId: 'laptop-page', text: 'from the laptop' });
  assert.strictEqual(sendL.status, 200, sendL.text);
  const sendV = await request(livePort, 'POST', `${gk}/drive/message`, { key: pv.key(), pageId: 'vps-page', text: 'from the vps page' }, { origin: `http://127.0.0.1:${sitePort}` });
  assert.strictEqual(sendV.status, 200, sendV.text);
  const answered = () => (fs.existsSync(path.join(state, 'answered')) ? fs.readFileSync(path.join(state, 'answered'), 'utf8') : '');
  assert.ok(await waitFor(() => /from the laptop/.test(answered()) && /from the vps page/.test(answered())));
  const qs = fs.readFileSync(path.join(state, 'queries'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepStrictEqual(qs.map((q) => q.cwd).sort(), [projL, projV].sort());

  // 7. Pairing again (/editlens join with a new code removes the old pairing) and Manual on the VPS
  // leave the laptop's page control alone.
  const again = await api(VPS, 'POST', '/pair', { cwd: projV });
  assert.ok((await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: again.code })).ok);
  assert.ok((await api(LAPTOP, 'POST', '/join/control', { name: (await api(LAPTOP, 'GET', '/pair')).remotes.hosts[0].name, args: ['manual'] })).ok);
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual((await api(LAPTOP, 'GET', `/summary?cwd=${encodeURIComponent(projL)}`)).control, 'page');
  assert.ok(!ended(pl), 'the laptop page is still in page control');
});
