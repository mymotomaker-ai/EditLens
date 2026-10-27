'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4325';
// When the server doesn't start, the error says why: the log's last line, short and plain.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lastLogLine } = require('../lib/client');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-startlog-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the last line, without its time stamp or control characters', () => {
  const f = path.join(dir, 'a.log');
  fs.writeFileSync(f, '[2026-10-11T16:22:00.668Z] EditLens listening\n[2026-10-11T16:22:01.000Z] port 4457 already in use;\u0007 another EditLens server is probably running\n\n');
  assert.strictEqual(lastLogLine(f), 'port 4457 already in use; another EditLens server is probably running');
});

test('at most 160 characters, read from the end of a big log', () => {
  const f = path.join(dir, 'b.log');
  fs.writeFileSync(f, 'x'.repeat(100000) + '\n' + 'y'.repeat(500) + '\n');
  assert.strictEqual(lastLogLine(f), 'y'.repeat(160));
});

test('no log, or an empty one: nothing', () => {
  assert.strictEqual(lastLogLine(path.join(dir, 'none.log')), '');
  const f = path.join(dir, 'c.log');
  fs.writeFileSync(f, '');
  assert.strictEqual(lastLogLine(f), '');
});
