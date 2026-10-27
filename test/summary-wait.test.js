'use strict';
require('./isolate');
// GET /summary?since=<seq>&wait=<s> (server/summary-wait.js): the mod's request is answered immediately
// when the summary changed, else held until it changes or for wait seconds; held requests are
// limited per session and in total, answered on shutdown, and held only for the hook key.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-summary-wait-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4931';
const { ensureServer, stopServer, postEvent, request, readToken } = require('../lib/client');
const { SummaryWatch, sinceParam, waitParam, WAIT_MAX_S, PER_SESSION, MAX_HELD } = require('../server/summary-wait');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A promise's state without waiting for it.
const settled = async (p) => {
  let done = false;
  p.then(() => { done = true; }, () => { done = true; });
  await sleep(0);
  return done;
};

test('since and wait from the query: digits only, in range, never NaN', () => {
  for (const bad of [null, undefined, '', 'abc', '-1', '1.5', '1e3', ' 2', '0x10', 'NaN', 'Infinity', '99999999999999999', '12345678901234567']) {
    assert.strictEqual(sinceParam(bad), null, String(bad));
  }
  assert.strictEqual(sinceParam('0'), 0);
  assert.strictEqual(sinceParam('1760000000000'), 1760000000000);
  for (const bad of [null, '', 'x', '-5', '2.5', '1e2', 'NaN', '12345']) assert.strictEqual(waitParam(bad), 0, String(bad));
  assert.strictEqual(waitParam('10'), 10);
  assert.strictEqual(waitParam('999'), WAIT_MAX_S);
  assert.strictEqual(WAIT_MAX_S, 25);
});

test('the watch: answers immediately on a change, else waits for the next one or the time limit; limits, shutdown', async () => {
  let state = 'idle';
  const w = new SummaryWatch((sessionId) => ({ sessionId, state, display: { at: Date.now() } }), { now: () => 1000 });
  const first = await w.answer({ sessionId: 's1', cwd: '/p', since: null, wait: 0 });
  assert.strictEqual(first.seq, 1001);
  assert.strictEqual(first.changed, true);
  // Nothing changed: the same number; what the mod reported itself (display) is no change.
  const same = await w.answer({ sessionId: 's1', cwd: '/p', since: 1001, wait: 0 });
  assert.deepStrictEqual([same.seq, same.changed], [1001, false]);
  // Held until the summary changes and nudge() is called.
  const held = w.answer({ sessionId: 's1', cwd: '/p', since: 1001, wait: 25, mod: true });
  assert.strictEqual(await settled(held), false);
  assert.strictEqual(w.modHeld(), true);
  w.nudge();
  await sleep(250);
  assert.strictEqual(await settled(held), false, 'a nudge with no change keeps it held');
  state = 'working';
  w.nudge();
  const out = await held;
  assert.strictEqual(out.changed, true);
  assert.strictEqual(out.body.state, 'working');
  assert.ok(out.seq > 1001);
  assert.strictEqual(w.modHeld(), false);
  // A number this watch never gave (a restarted server): immediately.
  const ahead = await w.answer({ sessionId: 's1', cwd: '/p', since: out.seq + 1e6, wait: 25 });
  assert.strictEqual(ahead.changed, true);
  assert.strictEqual(ahead.seq, out.seq);
  // The wait runs out: the same number, no change.
  const t0 = Date.now();
  const timedOut = await w.answer({ sessionId: 's1', cwd: '/p', since: out.seq, wait: 1 });
  assert.ok(Date.now() - t0 >= 900);
  assert.deepStrictEqual([timedOut.seq, timedOut.changed], [out.seq, false]);
  // One session keeps PER_SESSION waiting at most: one more answers its oldest.
  const mine = [];
  for (let i = 0; i <= PER_SESSION; i++) mine.push(w.answer({ sessionId: 's1', cwd: '/p', since: out.seq, wait: 25 }));
  await sleep(10);
  assert.deepStrictEqual(await Promise.all(mine.map(settled)), [true, ...Array(PER_SESSION).fill(false)]);
  assert.strictEqual((await mine[0]).changed, false);
  // MAX_HELD in total: past it, answered immediately.
  const others = [];
  for (let i = 0; w.held.size < MAX_HELD; i++) {
    const s = await w.answer({ sessionId: `x${i}`, cwd: '/p', since: null, wait: 0 });
    others.push(w.answer({ sessionId: `x${i}`, cwd: '/p', since: s.seq, wait: 25 }));
  }
  const extra = await w.answer({ sessionId: 'y', cwd: '/p', since: null, wait: 0 });
  const t1 = Date.now();
  await w.answer({ sessionId: 'y', cwd: '/p', since: extra.seq, wait: 25 });
  assert.ok(Date.now() - t1 < 200, 'not held past the limit');
  // Shutting down answers every held request.
  w.releaseAll();
  assert.strictEqual(w.held.size, 0);
  await Promise.all([...mine, ...others]);
  assert.strictEqual(w.recheck, null);
});

test('GET /summary on the live server: held for the mod, answered on a change, refused holding without the key', async (t) => {
  const proj = path.join(stateDir, 'proj');
  fs.mkdirSync(proj, { recursive: true });
  t.after(async () => {
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await ensureServer();
  const key = { 'x-editlens-token': readToken() };
  const q = (extra) => `/summary?session=s1&cwd=${encodeURIComponent(proj)}&mod=1${extra || ''}`;
  const get = async (p, headers = key, timeoutMs = 30000) => {
    const r = await request('GET', p, undefined, timeoutMs, headers);
    assert.strictEqual(r.status, 200, r.body);
    assert.ok(!/NaN/.test(r.body), r.body);
    return JSON.parse(r.body);
  };
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now() });
  const first = await get(q());
  assert.ok(Number.isSafeInteger(first.seq) && first.seq > 0, String(first.seq));
  assert.strictEqual(first.state, 'idle');

  // Held while nothing changes; answered immediately when the session's state changes.
  const held = get(q(`&since=${first.seq}&wait=25`));
  await sleep(500);
  assert.strictEqual(await settled(held), false, 'held while nothing changes');
  const t0 = Date.now();
  await postEvent({ type: 'prompt', sessionId: 's1', cwd: proj, ts: Date.now(), prompt: 'hi' });
  const changed = await held;
  assert.ok(Date.now() - t0 < 1500, `answered ${Date.now() - t0} ms after the change`);
  assert.deepStrictEqual([changed.state, changed.changed], ['working', true]);
  assert.ok(changed.seq > first.seq);

  // A change made while no request waited: the next request is answered immediately.
  await postEvent({ type: 'idle', sessionId: 's1', cwd: proj, ts: Date.now() });
  const t1 = Date.now();
  const missed = await get(q(`&since=${changed.seq}&wait=25`));
  assert.ok(Date.now() - t1 < 500);
  assert.deepStrictEqual([missed.state, missed.changed], ['idle', true]);

  // The wait runs out: the same number, no change.
  const t2 = Date.now();
  const quiet = await get(q(`&since=${missed.seq}&wait=1`));
  assert.ok(Date.now() - t2 >= 900);
  assert.deepStrictEqual([quiet.seq, quiet.changed], [missed.seq, false]);

  // Bad since or wait, a number from another start of the server: immediately, a good number back.
  for (const extra of ['&since=abc&wait=25', '&since=-1&wait=25', '&since=1.5&wait=25', '&since=1e3&wait=25', `&since=${missed.seq}&wait=NaN`, `&since=${missed.seq}&wait=-5`, `&since=${missed.seq + 1e6}&wait=25`]) {
    const t3 = Date.now();
    const r = await get(q(extra));
    assert.ok(Date.now() - t3 < 500, extra);
    assert.strictEqual(r.seq, missed.seq, extra);
    assert.strictEqual(r.changed, !/wait=(NaN|-5)/.test(extra), extra);
  }

  // Only the hook key is held: no key, another key (the task account's is one) or a page.
  for (const headers of [{}, { 'x-editlens-token': 'not-the-key' }, { ...key, Origin: 'http://localhost:5173' }]) {
    const t4 = Date.now();
    const r = await get(q(`&since=${missed.seq}&wait=25`), headers);
    assert.ok(Date.now() - t4 < 500, JSON.stringify(headers));
    assert.strictEqual(r.changed, false);
  }

  // One session keeps two at most: a third answers the oldest (a reloaded mod's old request).
  const a = get(q(`&since=${missed.seq}&wait=25`));
  await sleep(100);
  const b = get(q(`&since=${missed.seq}&wait=25`));
  await sleep(100);
  const c = get(q(`&since=${missed.seq}&wait=25`));
  await sleep(300);
  assert.deepStrictEqual(await Promise.all([a, b, c].map(settled)), [true, false, false]);
  assert.strictEqual((await a).changed, false);

  // While the mod's request is held, the mod counts as running: the page may change settings.
  await sleep(8500);
  assert.strictEqual(await settled(b), false);
  assert.strictEqual((await get('/settings', {})).canChange, true);

  // Shutting down answers the held ones immediately, not after 25 s.
  const t5 = Date.now();
  await stopServer();
  await Promise.allSettled([b, c]);
  assert.ok(Date.now() - t5 < 3000, `released ${Date.now() - t5} ms after shutdown`);

  // Started again: the mod's number from before is answered immediately.
  await ensureServer();
  const again = await get(q(`&since=${missed.seq}&wait=25`), { 'x-editlens-token': readToken() });
  assert.strictEqual(again.changed, true);
  assert.notStrictEqual(again.seq, missed.seq);
});
