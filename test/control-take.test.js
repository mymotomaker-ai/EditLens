'use strict';
require('./isolate');
// "Claude is already running from the page in <another project>": page control nobody uses there
// (no page open, no turn) is switched to Manual by itself when /editlens control starts it here;
// one that is in use is moved only by /editlens control take, which the user types. Uses the
// stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-control-take-'));
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
const PORT = 4332;
const GRACE_MS = 1500;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: String(PORT),
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  EDITLENS_PAGE_GRACE_MS: String(GRACE_MS),
  FAKE_CLAUDE_STATE: state,
});

const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');
const config = require('../lib/config');
const projA = path.join(dir, 'my-project');
const projB = path.join(dir, 'other-project');
fs.mkdirSync(projA);
fs.mkdirSync(projB);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return false;
};
// POST without the hooks' key, as a page does. -> { status, body }
async function pagePost(route, body) {
  const res = await fetch(`${config.baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  return { status: res.status, body: parsed };
}
// /drive/grant as bin/drive.js sends it. -> the answer, or { status, ...error answer }
async function grant(body) {
  return postJson('/drive/grant', { claudePath: exe, ...body }, { timeoutMs: 20000 }).catch((err) => {
    const m = /^server answered (\d+): ([\s\S]*)$/.exec(err.message);
    if (!m) throw err;
    return { status: Number(m[1]), ...JSON.parse(m[2]) };
  });
}
// A page's event stream; frames collects every event.
function openPage(id, root) {
  const ctrl = new AbortController();
  const frames = [];
  fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(root)}`, { signal: ctrl.signal }).then(async (res) => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
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
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { id, frames, close: () => ctrl.abort(), key: () => (frames.filter((f) => f.type === 'drive-grant').pop() || {}).key };
}
async function pageCount() {
  return (await getJson('/pages/live')).length;
}
function starts() {
  const f = path.join(state, 'queries');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
}
// Page control on in project A, from page pa. -> the page
async function controlA() {
  const pa = openPage('pa' + Date.now(), projA);
  assert.ok(await until(async () => (await getJson('/pages/live')).some((p) => p.id === pa.id)));
  const g = await grant({ cwd: projA, fresh: true });
  assert.ok(g.ok, JSON.stringify(g));
  assert.ok(await until(() => Boolean(pa.key())), 'pa got the key');
  return pa;
}
async function manual() {
  await postJson('/drive/end', {});
  await sleep(200);
}

const open = [];
test.before(async () => {
  await ensureServer();
  open.push(openPage('pb', projB));
});
test.after(async () => {
  for (const p of open) p.close();
  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true }); // after the server stops: it reads its key from there
});
const pb = () => open[0];
// Each test starts with page control in project A, from its open page pa, and ends in Manual.
async function setup(t) {
  const pa = await controlA();
  open.push(pa);
  t.after(async () => {
    pa.close();
    await manual();
  });
  return pa;
}
async function closeAndWait(pa) {
  pa.close();
  assert.ok(await until(async () => !(await getJson('/pages/live')).some((p) => p.id === pa.id)), 'pa closed');
}

test('a page of the other project is open: refused, saying where, with no "Switch it to Manual"', async (t) => {
  await setup(t);
  const refused = await grant({ cwd: projB });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.busy, true);
  assert.strictEqual(refused.working, false);
  assert.strictEqual(refused.error, `Claude is already running from the page in ${projA}.`);
});

test('take is refused from auto control and from a page', async (t) => {
  await setup(t);
  const auto = await grant({ cwd: projB, auto: true, take: true });
  assert.strictEqual(auto.status, 409);
  assert.ok(auto.busy, JSON.stringify(auto));
  // A page has no hooks' key: /drive/grant is not open to it at all.
  const fromPage = await pagePost('/drive/grant', { cwd: projB, take: true, claudePath: exe });
  assert.strictEqual(fromPage.status, 401);
  assert.strictEqual(starts().pop().cwd, projA, 'still in project A');
});

test('the same folder spelled another way is not another project (trailing slash, symlink)', async (t) => {
  const pa = await setup(t);
  const link = path.join(dir, 'link-to-a');
  if (!fs.existsSync(link)) fs.symlinkSync(projA, link);
  const before = starts().length;
  const keyBefore = pa.key();
  const slash = await grant({ cwd: projA + '/' });
  assert.ok(slash.ok, JSON.stringify(slash));
  const viaLink = await grant({ cwd: link });
  assert.ok(viaLink.ok, JSON.stringify(viaLink));
  assert.strictEqual(pa.key(), keyBefore, 'the page keeps its key');
  assert.strictEqual(starts().length, before, 'Claude did not start again');
});

test('the page closed: kept for a moment (a reload), then released by /editlens control, never by auto control', async (t) => {
  const pa = await setup(t);
  await closeAndWait(pa);
  assert.strictEqual((await grant({ cwd: projB })).status, 409, 'a reload is not a closed page');
  await sleep(GRACE_MS + 200);
  assert.strictEqual((await grant({ cwd: projB, auto: true })).status, 409, 'auto control does not release it');
  const moved = await grant({ cwd: projB });
  assert.ok(moved.ok, JSON.stringify(moved));
  assert.strictEqual(moved.moved, projA);
  assert.strictEqual(moved.unused, true);
  assert.strictEqual(starts().pop().cwd, projB, 'Claude runs in project B now');
});

test('mid-turn with no page open: not released, and the message says Claude is working', async (t) => {
  const pa = await setup(t);
  assert.strictEqual((await pagePost('/drive/message', { key: pa.key(), pageId: pa.id, text: 'hold 4000' })).status, 200);
  await closeAndWait(pa);
  await sleep(GRACE_MS + 200);
  const refused = await grant({ cwd: projB });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.working, true);
  assert.match(refused.error, /already running from the page in .*my-project and is working on a reply there\.$/);
  assert.strictEqual(starts().pop().cwd, projA);
});

test('waiting for a permission answer with no page open: not released', async (t) => {
  const pa = await setup(t);
  assert.strictEqual((await pagePost('/drive/message', { key: pa.key(), pageId: pa.id, text: 'ask ls' })).status, 200);
  assert.ok(await until(() => pa.frames.some((f) => f.type === 'permission')), 'the question is asked');
  await closeAndWait(pa);
  await sleep(GRACE_MS + 200);
  const refused = await grant({ cwd: projB });
  assert.strictEqual(refused.status, 409);
  assert.match(refused.error, /needs your answer to a permission question there\.$/);
  assert.strictEqual(starts().pop().cwd, projA);
});

test('take moves it from a page in use, mid-turn; that page switches to Manual and says why', async (t) => {
  const pa = await setup(t);
  assert.strictEqual((await pagePost('/drive/message', { key: pa.key(), pageId: pa.id, text: 'ask ls' })).status, 200);
  assert.ok(await until(() => pa.frames.some((f) => f.type === 'permission')));
  const oldKey = pa.key();
  const taken = await grant({ cwd: projB, take: true });
  assert.ok(taken.ok, JSON.stringify(taken));
  assert.strictEqual(taken.moved, projA);
  assert.strictEqual(taken.unused, false);
  assert.ok(await until(() => pa.frames.some((f) => f.type === 'drive' && f.phase === 'ended')));
  const ended = pa.frames.find((f) => f.type === 'drive' && f.phase === 'ended');
  assert.strictEqual(ended.note, `Page control moved to ${projB}. This page is in Manual again.`);
  assert.ok(pa.frames.some((f) => f.type === 'permission-done' && f.decision === 'deny'), 'the question is answered no, as Manual does');
  assert.strictEqual(starts().pop().cwd, projB);
  assert.ok(await until(() => Boolean(pb().key())), 'project B\'s page has page control');
  assert.strictEqual((await pagePost('/drive/message', { key: oldKey, pageId: pa.id, text: 'hi' })).status, 403, 'the old key no longer works');
});

test('Claude running from a page (EDITLENS_DRIVEN) cannot take it with bin/drive.js', async (t) => {
  await setup(t);
  const { control } = require('../bin/drive');
  process.env.EDITLENS_DRIVEN = '1';
  try {
    const r = await control({ cwd: projB, take: true });
    assert.match(String(r.error), /Claude running from a page can't move page control/);
  } finally {
    delete process.env.EDITLENS_DRIVEN;
  }
  assert.strictEqual(starts().pop().cwd, projA, 'still in project A');
});

test('paired computer: control <name> take moves page control to the paired project', async (t) => {
  const pa = await setup(t);
  const { PairHost } = require('../server/pair-host');
  const { controlArgs } = require('../lib/pairwire');
  const { remoteSummary } = require('../bin/pair');
  assert.deepStrictEqual(controlArgs(['TAKE']), ['take']);
  assert.deepStrictEqual(controlArgs(['take', 'new']), ['new', 'take']);
  assert.deepStrictEqual(controlArgs(['manual', 'take']), ['manual']);
  assert.deepStrictEqual(controlArgs(['rm', '-rf']), []);
  assert.deepStrictEqual(controlArgs('take'), []);
  const host = new PairHost({ stateDir: path.join(dir, 'pair'), port: 0, httpServer: null, siteOf: () => null, version: 'x', livePort: PORT, log: () => {}, runsAllowed: () => true, env: { CLAUDE_CODE_EXECPATH: exe } });
  const ask = (args) => new Promise((resolve) => {
    let text = '';
    host.control({ write: (s) => { text += s; }, end: () => resolve(JSON.parse(text.trim())) }, { cwd: projB, name: 'laptop' }, { args });
  });
  // Without take: refused there, and the laptop is offered the same step for that computer.
  const no = await ask([]);
  assert.strictEqual(no.ok, false, no.text);
  assert.match(no.text, /already running from the page in .*my-project\./);
  assert.strictEqual(remoteSummary(no.text).take, 'idle');
  // With take: page control moves to the paired project.
  const yes = await ask(['take']);
  assert.strictEqual(yes.ok, true, yes.text);
  assert.match(yes.text, /Moved from .*my-project/);
  assert.strictEqual(starts().pop().cwd, projB);
  assert.ok(await until(() => pa.frames.some((f) => f.type === 'drive' && f.phase === 'ended' && /Page control moved to/.test(f.note || ''))));
});

test('the terminal text: where Claude runs, and the one step that moves it', () => {
  const { sayControl } = require('../bin/drive');
  const lines = [];
  const write = process.stdout.write;
  process.stdout.write = (s) => {
    lines.push(String(s));
    return true;
  };
  const saved = process.exitCode;
  try {
    sayControl({ error: `Claude is already running from the page in ${projA}.`, busy: true, working: false });
    sayControl({ error: `Claude is already running from the page in ${projA} and is working on a reply there.`, busy: true, working: true });
  } finally {
    process.stdout.write = write;
    process.exitCode = saved;
  }
  const out = lines.join('');
  // What went wrong, then the fix (the one step), as every error says it.
  assert.ok(out.includes(`✕ Page control didn't start: Claude is already running from the page in ${projA}.\n! Fix  › /editlens control take to move it here (that page switches to Manual)\n`), out);
  assert.ok(out.includes('! Fix  › /editlens control take to stop Claude there and move it here (that page switches to Manual)\n'), out);
  assert.doesNotMatch(out, /Switch it to Manual there first/);
});
