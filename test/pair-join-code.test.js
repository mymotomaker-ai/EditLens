'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5272';
// Sol H7: a join is for the code its connection was opened with. A computer that opened the
// connection with code A and sends its join after a newer /editlens pair (code B, another folder)
// does not join B's folder; nor after code A has expired.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tls = require('tls');
const wire = require('../lib/pairwire');
const { PairHost } = require('../server/pair-host');

function host() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-join-code-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new PairHost({ stateDir: dir, port: 5271, version: 'test', livePort: 5272, log: () => {}, siteOf: () => null });
}

// Opens a join connection with `code`; before() runs once it is open, then the join is sent.
// -> the other computer's answer, or null when it closed the connection without one.
function joinWith(code, before) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host: '127.0.0.1', port: 5271, ...wire.TLS, pskCallback: () => ({ identity: wire.JOIN_ID, psk: wire.codeKey(code) }), checkServerIdentity: () => undefined }, async () => {
      await before();
      wire.writeLine(s, { t: 'join', protocol: wire.PROTOCOL, name: 'laptop' });
    });
    let text = '';
    s.on('data', (c) => { text += c; });
    s.on('error', (err) => (err.code === 'ECONNRESET' ? undefined : reject(err)));
    s.on('close', () => {
      const line = text.split('\n')[0];
      resolve(line ? JSON.parse(line) : null);
    });
  });
}

test('H7: a join sent after a newer code does not join the newer code\'s folder', async () => {
  const h = host();
  try {
    const a = await h.newCode('/projects/a');
    const answer = await joinWith(a.code, () => h.newCode('/projects/b'));
    assert.ok(!answer || !answer.ok, JSON.stringify(answer));
    assert.strictEqual(h.pairs.length, 0, 'nothing was paired');
    // Code B still works for the computer it was given to.
    const b = h.pending;
    assert.ok(b && b.cwd === '/projects/b');
  } finally {
    h.off();
  }
});

test('H7: a join sent after its code expired is refused; a join in time is paired', async () => {
  const h = host();
  try {
    const a = await h.newCode('/projects/a');
    const late = await joinWith(a.code, () => { h.pending.expires = Date.now() - 1; });
    assert.ok(!late || !late.ok, JSON.stringify(late));
    assert.strictEqual(h.pairs.length, 0);
    const c = await h.newCode('/projects/c');
    const ok = await joinWith(c.code, async () => {});
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.cwd, '/projects/c');
  } finally {
    h.off();
  }
});
