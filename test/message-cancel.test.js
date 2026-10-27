'use strict';
require('./isolate');
// Sol M5: a message waiting for Claude is cancelled only from a page of its own project (a paired
// page only in its paired project), never by a request without a page or from another project's page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-cancel-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '5246';
const { ensureServer, stopServer } = require('../lib/client');
const config = require('../lib/config');

test('cancel: only a page of the message\'s project', async (t) => {
  const a = path.join(stateDir, 'a');
  const b = path.join(stateDir, 'b');
  for (const d of [a, b]) fs.mkdirSync(d);
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await ensureServer();
  for (const [id, root] of [['pa', a], ['pb', b]]) {
    const s = new AbortController();
    streams.push(s);
    await fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(root)}`, { signal: s.signal });
  }
  const post = async (p, body) => {
    const r = await fetch(config.baseUrl + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const sent = await post('/message', { pageId: 'pa', text: 'hello' });
  assert.strictEqual(sent.status, 200, JSON.stringify(sent));
  assert.strictEqual((await post('/message/cancel', { id: sent.body.id })).status, 403, 'no page');
  assert.strictEqual((await post('/message/cancel', { id: sent.body.id, page: 'pb' })).status, 404, 'another project\'s page: as if unknown');
  const ok = await post('/message/cancel', { id: sent.body.id, page: 'pa' });
  assert.deepStrictEqual([ok.status, ok.body.ok], [200, true]);
});
