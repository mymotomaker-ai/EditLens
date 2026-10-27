'use strict';
require('./isolate');
// Page control starting twice at the same time (auto control as the page opens, plus /editlens control):
// one Claude, one key, no 500, and the page that has the key can use it. A mode request from an
// earlier page-control run is never applied to a later one. Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-drive-race-'));
const state = path.join(dir, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const exe = path.join(bin, 'claude');
const PORT = 4362;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: String(PORT),
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
  // The real SDK takes a moment to load: the time in which two starts could overlap.
  FAKE_SDK_IMPORT_MS: '400',
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { ensureServer, stopServer, postJson } = require('../lib/client');
const config = require('../lib/config');
const project = path.join(dir, 'app');
fs.mkdirSync(project);

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
// POST without the hooks' key, as the page does; -> { status, body }
async function pagePost(route, body) {
  const res = await fetch(`${config.baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
function raw(method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const req = require('http').request(`${config.baseUrl}${route}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', (d) => { text += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
// The page's event stream; frames collects every 'claude' event.
function openPage(id) {
  const ctrl = new AbortController();
  const frames = [];
  const done = fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(project)}`, { signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (data) {
          try {
            frames.push(JSON.parse(data.slice(6)));
          } catch (err) {
            if (!(err instanceof SyntaxError)) throw err;
          }
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { frames, close: () => ctrl.abort(), done };
}

test('auto control and /editlens control at the same time: one grant, no 500, the page can use its key', async (t) => {
  await ensureServer();
  const pages = [];
  t.after(async () => {
    for (const p of pages) p.close();
    await stopServer();
  });
  // A session asked for page control when the page opens.
  assert.ok((await postJson('/drive/auto', { cwd: project, claudePath: exe, sessionId: 's1' })).ok);
  // The page opens (auto control starts) and /editlens control comes 30 ms later.
  const page = openPage('p1');
  pages.push(page);
  await new Promise((r) => setTimeout(r, 30));
  const grant = await postJson('/drive/grant', { cwd: project, claudePath: exe }, { timeoutMs: 20000 }).catch((err) => ({ error: err.message }));
  assert.ok(grant.ok, `no 500, no "stopped": ${JSON.stringify(grant)}`);
  assert.ok(await until(() => page.frames.some((f) => f.type === 'drive-grant')), 'the page got a key');
  // Let the auto start finish too.
  await new Promise((r) => setTimeout(r, 1500));
  const keys = new Set(page.frames.filter((f) => f.type === 'drive-grant').map((f) => f.key));
  assert.strictEqual(keys.size, 1, 'one grant');
  assert.strictEqual(fs.readFileSync(path.join(state, 'queries'), 'utf8').trim().split('\n').length, 1, 'Claude started once');
  assert.ok(!page.frames.some((f) => f.type === 'drive' && f.phase === 'ended'), 'page control never ended');
  // Claude runs and the page is in control of it.
  const [key] = keys;
  const sent = await pagePost('/drive/message', { key, pageId: 'p1', text: 'make the title bold' });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent));

  // A mode request from this run is not applied to the next run.
  const asked = await pagePost('/drive/mode', { key, pageId: 'p1', mode: 'acceptEdits' });
  assert.ok(asked.body.pending, JSON.stringify(asked));
  assert.strictEqual((await pagePost('/drive/stop', { key, pageId: 'p1' })).status, 200);
  assert.ok(await until(() => page.frames.some((f) => f.type === 'drive' && f.phase === 'ended')));
  const again = await postJson('/drive/grant', { cwd: project, claudePath: exe }, { timeoutMs: 20000 });
  assert.ok(again.ok, JSON.stringify(again));
  // The EditLens window, as a browser opens it (plain http: fetch sets its own sec-fetch headers).
  const win = await raw('GET', '/answer', { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' });
  const winKey = (/var KEY = "([0-9a-f]{64})"/.exec(win.body) || [])[1];
  assert.ok(winKey, `${win.status} ${win.body.slice(0, 200)}`);
  const answered = await raw('POST', '/answer', { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', origin: config.baseUrl, 'x-editlens-answer': winKey },
    JSON.stringify({ kind: 'mode', id: asked.body.id, decision: 'allow' }));
  const out = JSON.parse(answered.body);
  assert.strictEqual(answered.status, 409, JSON.stringify(out));
  assert.ok(!page.frames.some((f) => f.type === 'drive' && f.mode === 'acceptEdits'), 'the mode did not change');
});

test('a tab opened later gets the key only when no tab that has it is still open', async (t) => {
  await ensureServer();
  const pages = [];
  t.after(async () => {
    for (const p of pages) p.close();
    await stopServer();
  });
  const open = (id) => {
    const p = openPage(id);
    pages.push(p);
    return p;
  };
  const keyOf = (p) => (p.frames.find((f) => f.type === 'drive-grant') || {}).key || null;
  const a = open('k1');
  await new Promise((r) => setTimeout(r, 200));
  const grant = await postJson('/drive/grant', { cwd: project, claudePath: exe }, { timeoutMs: 20000 });
  assert.ok(grant.ok, JSON.stringify(grant));
  assert.ok(await until(() => keyOf(a)), 'the open tab got the key');
  // A second tab while the first is open: no key (page control runs from the other tab).
  const b = open('k2');
  assert.ok(await until(() => b.frames.some((f) => f.type === 'drive-status' && f.active)));
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(keyOf(b), null);
  assert.strictEqual((await pagePost('/drive/effort', { key: 'x'.repeat(48), pageId: 'k2', level: 'low' })).status >= 400, true);
  // Both closed, then a new tab: it gets the same key and can use it.
  a.close();
  b.close();
  assert.ok(await until(async () => !(await fetch(`${config.baseUrl}/pages/live`, { headers: { 'x-editlens-token': fs.readFileSync(path.join(config.stateDir, `token-${PORT}`), 'utf8') } }).then((r) => r.json())).length));
  const c = open('k3');
  assert.ok(await until(() => keyOf(c)), 'the new tab got the key');
  assert.strictEqual(keyOf(c), keyOf(a));
  const changed = await pagePost('/drive/effort', { key: keyOf(c), pageId: 'k3', level: 'low' });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed));
  // Another project's page never gets it.
  const other = path.join(dir, 'other');
  fs.mkdirSync(other, { recursive: true });
  c.close();
  const ctrl = new AbortController();
  const frames = [];
  fetch(`${config.baseUrl}/events?page=k4&root=${encodeURIComponent(other)}`, { signal: ctrl.signal }).then(async (res) => {
    for await (const chunk of res.body) frames.push(String(Buffer.from(chunk)));
  }).catch((err) => { if (err.name !== 'AbortError') throw err; });
  await new Promise((r) => setTimeout(r, 800));
  ctrl.abort();
  assert.ok(!frames.join('').includes('drive-grant'), 'another project\'s page gets no key');
  await postJson('/drive/end', {});
});
