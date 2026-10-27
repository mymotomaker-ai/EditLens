'use strict';
require('./isolate');
// The list of edits kept across a restart (backups/edits.json) counts its size in bytes: an edit
// in a language with multi-byte letters stays within the 48 KB an entry may use.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-index-bytes-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '5250';
const { ensureServer, stopServer, postEvent } = require('../lib/client');

test('an edit entry of 30,000 three-byte letters is kept without its lines', async (t) => {
  t.after(async () => {
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const dir = path.join(stateDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.js');
  const line = '€'.repeat(30000);
  fs.writeFileSync(file, `a\n${line}\n`);
  await ensureServer();
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file, relFile: 'app.js', before: 'a\n', after: `a\n${line}\n`, kind: 'frontend', intent: 'x',
    hunks: [{ oldStart: 2, newStart: 2, lines: [`+${line}`] }], stats: { added: 1, removed: 0 } });
  const index = path.join(stateDir, 'backups', 'edits.json');
  const list = JSON.parse(fs.readFileSync(index, 'utf8'));
  assert.strictEqual(list.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(list[0])) <= 48 * 1024, `${Buffer.byteLength(JSON.stringify(list[0]))} bytes`);
  assert.strictEqual(list[0].truncated, true);
});
