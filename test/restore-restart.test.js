'use strict';
require('./isolate');
// Sol H7: event numbers start again when the server restarts (earlier edits are listed again with
// new numbers). A card from before the restart that asks to undo or remove its number must not
// change the edit that has that number now: it names its server start and others are refused.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-restore-restart-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '5241';
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const config = require('../lib/config');

const L = (...xs) => xs.join('\n') + '\n';

test('undo and remove by edit number after a restart: refused, the new edit stays', async (t) => {
  const dir = path.join(stateDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.js');
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  // Opens the page's event stream and returns the server start's id from its hello.
  const open = async () => {
    const s = new AbortController();
    streams.push(s);
    const res = await fetch(`${config.baseUrl}/events?page=p1&root=${encodeURIComponent(dir)}`, { signal: s.signal });
    // A reader, not for-await: leaving that loop would close the stream (and the page with it).
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += dec.decode(value, { stream: true });
      const m = /data: (\{.*"type":"hello".*\})\n/.exec(buf);
      if (m) return JSON.parse(m[1]).instance;
    }
  };
  const restore = async (body) => {
    const r = await fetch(`${config.baseUrl}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ page: 'p1', ...body }) });
    return { status: r.status, body: await r.json() };
  };
  let text = L('1', '2', '3', '4', '5', '6', '7', '8');
  fs.writeFileSync(file, text);
  const edit = async (next, extra) => {
    const before = text;
    text = next;
    fs.writeFileSync(path.join(dir, extra && extra.created ? 'new.js' : 'app.js'), text);
    return postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file: extra && extra.created ? path.join(dir, 'new.js') : file, relFile: extra && extra.created ? 'new.js' : 'app.js', before: extra && extra.created ? null : before, after: text, kind: 'frontend', intent: 'x', stats: { added: 1, removed: 1 }, ...extra });
  };

  const prompt = () => postEvent({ type: 'prompt', sessionId: 's1', cwd: dir, ts: Date.now(), prompt: 'hi' });
  await ensureServer();
  const old = await open();
  assert.match(old, /^[0-9a-f]{16}$/);
  for (let i = 0; i < 3; i++) await prompt();
  const before = await edit(L('1', 'TWO', '3', '4', '5', '6', '7', '8'));
  await stopServer();
  await ensureServer();
  const now = await open();
  assert.notStrictEqual(now, old);
  // The earlier edit is listed again with a new number; new events follow it.
  while ((await prompt()).seq < before.seq - 1);
  const e1 = await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'));
  assert.strictEqual(e1.seq, before.seq, 'the old card\'s number is a different edit now');

  // The old card's edit (line 2) is not the edit that has its number now (line 7).
  const n = before.seq;
  for (const body of [{ undoEdit: n, instance: old }, { undoEdit: n, instance: old, check: true }, { undoEdit: n, instance: old, back: true }, { undoEdit: n }, { remove: n, instance: old }]) {
    const r = await restore(body);
    assert.strictEqual(r.status, 409, JSON.stringify([body, r]));
    assert.deepStrictEqual([r.body.restarted, r.body.ok], [true, false]);
    assert.match(r.body.error, /from before EditLens restarted\. Reload the page/);
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'the new edit is still there');
  // This server start's own number works.
  const r = await restore({ undoEdit: n, instance: now });
  assert.strictEqual(r.status, 200, JSON.stringify(r));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), L('1', 'TWO', '3', '4', '5', '6', '7', '8'));
  // Remove: a file edit 2 created here; the old start's number is refused, the file stays.
  const e2 = await edit('new\n', { created: true });
  const gone = await restore({ remove: e2.seq, instance: old });
  assert.strictEqual(gone.status, 409);
  assert.ok(fs.existsSync(path.join(dir, 'new.js')));
});
