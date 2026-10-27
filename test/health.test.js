'use strict';
require('./isolate');
// A live server that is busy (slow to answer /health) counts as running: hooks don't start a
// second server next to it, which would only fail and lose the hook's event.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-health-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4398';
const { health, ensureServer } = require('../lib/client');

test('a slow server is busy, not down', async (t) => {
  const slow = http.createServer(() => {}); // never answers
  await new Promise((r) => slow.listen(4398, '127.0.0.1', r));
  t.after(() => {
    slow.closeAllConnections();
    slow.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  assert.deepStrictEqual(await health(), { busy: true });
  assert.deepStrictEqual(await ensureServer(), { started: false, busy: true });
});
