'use strict';
require('./isolate');
// After the live server restarts it numbers events from 1 again. A page that reconnects with an
// old, larger number is treated as new (it gets the backlog), and `hello` has a new instance id so
// the page resets its own position.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-restart-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4913';
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const config = require('../lib/config');

async function frames(lastId, count) {
  const ctl = new AbortController();
  const res = await fetch(`${config.baseUrl}/events?page=p1`, { signal: ctl.signal, headers: lastId ? { 'Last-Event-ID': String(lastId) } : {} });
  const out = [];
  const dec = new TextDecoder();
  let buf = '';
  const started = Date.now();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      const data = p.split('\n').find((l) => l.startsWith('data: '));
      if (data) out.push(JSON.parse(data.slice(6)));
    }
    if (out.length >= count || Date.now() - started > 3000) break;
  }
  ctl.abort();
  return out;
}

test('a page reconnecting with a number from before a restart gets the events again', async (t) => {
  t.after(async () => {
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await ensureServer();
  const first = (await frames(null, 1))[0];
  assert.strictEqual(first.type, 'hello');
  assert.match(first.instance, /^[0-9a-f]{16}$/);
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'prompt', sessionId: 's1', cwd: stateDir, ts: Date.now(), prompt: 'hi' });
  const got = await frames(500, 2);
  assert.strictEqual(got[0].type, 'hello');
  assert.notStrictEqual(got[0].instance, first.instance, 'a new instance after the restart');
  assert.ok(got.some((e) => e.type === 'prompt' && e.seq === 1), JSON.stringify(got));

  // An id from before the restart that the new server has already passed (review L10): still new
  // here, so its events come as replay, never as live edits.
  const again = await postEvent({ type: 'prompt', sessionId: 's1', cwd: stateDir, ts: Date.now(), prompt: 'again' });
  const old = await frames(`${first.instance}.1`, 4);
  const oldPrompts = old.filter((e) => e.type === 'prompt');
  assert.ok(oldPrompts.length === 2 && oldPrompts.every((e) => e.replay === true), JSON.stringify(old));
  // The same server: it resumes after that number, live.
  const same = await frames(`${got[0].instance}.${again.seq - 1}`, 3);
  const prompts = same.filter((e) => e.type === 'prompt');
  assert.deepStrictEqual(prompts.map((e) => [e.seq, Boolean(e.replay)]), [[again.seq, false]], JSON.stringify(same));
});
