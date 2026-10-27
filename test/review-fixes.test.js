'use strict';
require('./isolate');
// Log trimming, telling a new file from an appended one, the
// listen deadline, and the size of point reports.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-review-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4399';
const { trimLog } = require('../lib/logtrim');
const { SnapshotStore } = require('../server/snapshots');
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');
const config = require('../lib/config');

test.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));

test('a log past its limit keeps its newest half, from a whole line', () => {
  const file = path.join(stateDir, 'x.log');
  fs.writeFileSync(file, Array.from({ length: 4000 }, (_, i) => `line ${i}`).join('\n') + '\n');
  assert.strictEqual(trimLog(file, 10000), true);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.length <= 5100, text.length);
  assert.match(text, /^\[log trimmed/);
  assert.match(text.split('\n')[1], /^line \d+$/);
  assert.match(text, /line 3999\n$/);
  assert.strictEqual(trimLog(file, 10000), false, 'small enough now');
  assert.strictEqual(trimLog(path.join(stateDir, 'none.log')), false);
});

test('whether a file existed before an edit is remembered per tool call', () => {
  const s = new SnapshotStore();
  s.rememberBefore('t1', 'old text\n', true);
  s.rememberBefore('t2', '', false);
  assert.strictEqual(s.existedBefore('t1'), true);
  assert.strictEqual(s.existedBefore('t2'), false);
  assert.strictEqual(s.existedBefore('t3'), null);
  assert.strictEqual(s.takeBefore('t1'), 'old text\n');
});

test('the server: append-only Write, listen deadline, point reports', async (t) => {
  await ensureServer();
  t.after(() => stopServer());
  const project = path.join(stateDir, 'site');
  const file = path.join(project, 'a.txt');
  // A Write that only adds lines to an existing file, with no originalFile from Claude Code.
  await postEvent({ type: 'pending', tool: 'Write', toolUseId: 'w1', sessionId: 's1', cwd: project, file, before: 'one\n', existed: true, ts: Date.now() });
  await postEvent({ type: 'change', tool: 'Write', toolUseId: 'w1', sessionId: 's1', cwd: project, file, relFile: 'a.txt', created: true, before: '', after: 'one\ntwo\n', hunks: [], stats: { added: 1, removed: 0 }, ts: Date.now() });
  const change = (await getJson('/history')).filter((e) => e.type === 'change').pop();
  assert.strictEqual(change.created, false, 'not a new file');
  const snap = await getJson(`/snapshot?id=${change.snapshot}&instance=${(await getJson('/summary')).instance}`);
  assert.strictEqual(snap.before, 'one\n', 'replays from the real earlier text');

  // No deadline given: a deadline in the future, never 0 (1970).
  const stream = new AbortController();
  await fetch(`${config.baseUrl}/events?page=pg&root=${encodeURIComponent(project)}`, { signal: stream.signal });
  t.after(() => stream.abort());
  const waiting = fetch(`${config.baseUrl}/messages/wait?cwd=${encodeURIComponent(project)}&timeout=1000`, { headers: { 'x-editlens-token': fs.readFileSync(config.tokenFile, 'utf8') } });
  await new Promise((r) => setTimeout(r, 300));
  const listen = (await getJson('/history')).filter((e) => e.type === 'listen' && e.active).pop();
  assert.ok(listen && listen.until > Date.now() - 1000, JSON.stringify(listen));
  await waiting;

  // Point reports: the latest 20 per point.
  for (let i = 0; i < 30; i++) {
    await fetch(`${config.baseUrl}/report`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pointId: 'p1', url: 'http://127.0.0.1/', results: [{ i }] }) });
  }
  const list = await getJson('/report?id=p1');
  assert.strictEqual(list.length, 20);
  assert.deepStrictEqual(list[19].results, [{ i: 29 }]);
});
