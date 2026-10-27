'use strict';
require('./isolate');
// Sol scan of 0.24.46, part 1: M12 (a new tab that gets page control's key also gets the
// permission questions already waiting) and L6 (the Panel colors description says what Auto
// follows). Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol46-part1-'));
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
const PORT = 5391;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: String(PORT),
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
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
async function pagePost(route, body) {
  const res = await fetch(`${config.baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
// A page's event stream; frames collects every event.
function openPage(id) {
  const ctrl = new AbortController();
  const frames = [];
  fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(project)}`, { signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').find((l) => l.startsWith('data: '));
        if (!data) continue;
        try {
          frames.push(JSON.parse(data.slice(6)));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { frames, close: () => ctrl.abort() };
}

test('M12: a new tab that gets the key also gets the permission questions already waiting', async (t) => {
  await ensureServer();
  const pages = [];
  t.after(async () => {
    for (const p of pages) p.close();
    await postJson('/drive/end', {}).catch((err) => console.log('end:', err.message));
    await stopServer();
  });
  const a = openPage('q1');
  pages.push(a);
  await new Promise((r) => setTimeout(r, 200));
  const grant = await postJson('/drive/grant', { cwd: project, claudePath: exe }, { timeoutMs: 20000 });
  assert.ok(grant.ok, JSON.stringify(grant));
  const keyOf = (p) => (p.frames.find((f) => f.type === 'drive-grant') || {}).key || null;
  assert.ok(await until(() => keyOf(a)), 'the first tab got the key');
  // Claude asks before running a command; the question waits.
  const sent = await pagePost('/drive/message', { key: keyOf(a), pageId: 'q1', text: 'ask rm -rf build' });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent));
  assert.ok(await until(() => a.frames.some((f) => f.type === 'permission')), 'the first tab got the question');
  const id = a.frames.find((f) => f.type === 'permission').id;
  // The tab closes; a new tab of the project takes the key and must show the question.
  a.close();
  assert.ok(await until(async () => !(await fetch(`${config.baseUrl}/pages/live`, { headers: { 'x-editlens-token': fs.readFileSync(path.join(config.stateDir, `token-${PORT}`), 'utf8') } }).then((r) => r.json())).length));
  const b = openPage('q2');
  pages.push(b);
  assert.ok(await until(() => keyOf(b)), 'the new tab got the key');
  const status = b.frames.find((f) => f.type === 'drive-status' && f.active);
  const listed = status && Array.isArray(status.permissions) ? status.permissions.map((p) => p.id) : [];
  assert.ok(listed.includes(id), `the waiting question is in the new tab's status: ${JSON.stringify(status)}`);
  // The key arrives after the status, so the cards are drawn first and get their Deny then (L7).
  const order = b.frames.map((f) => f.type).filter((type) => type === 'drive-status' || type === 'drive-grant');
  assert.deepStrictEqual(order.slice(0, 2), ['drive-status', 'drive-grant']);
});

test('L6: the Panel colors description says Auto follows the page, then the computer', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  const d = plugin.userConfig.theme.description;
  assert.match(d, /page/i, d);
  assert.match(d, /computer/i, d);
  assert.ok(d.search(/page/i) < d.search(/computer/i), d);
});
