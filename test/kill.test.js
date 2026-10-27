'use strict';
require('./isolate');
// H11 (Sol scan of 0.24.40): test cleanup signals one process only. A pid from a server's answer
// could be -1 (every process the user owns), 0 (this process group) or 1.
const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const { killPid } = require('./kill');

test('killPid refuses -1, 0, 1, NaN, a string and this process', () => {
  for (const pid of [-1, 0, 1, NaN, Infinity, 1.5, '123', null, process.pid]) assert.throws(() => killPid(pid), /not a pid to signal/, String(pid));
});

test('killPid signals one child; a gone pid is not an error', async () => {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  const gone = new Promise((r) => child.on('exit', (code, signal) => r(signal)));
  assert.strictEqual(killPid(child.pid), true);
  assert.strictEqual(await gone, 'SIGTERM');
  assert.strictEqual(killPid(child.pid), false);
});

// H9 (Sol scan of 0.24.43): a pid from a server's /health answer could belong to any process.
test('killServer signals a pid only when it is the EditLens server of this state folder', async () => {
  const { killServer } = require('./kill');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-kill-'));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-kill-'));
  const server = path.join(mine, 'server.js');
  fs.writeFileSync(server, 'setTimeout(() => {}, 60000);\n');
  const child = spawn(process.execPath, [server], { env: { ...process.env, EDITLENS_STATE_DIR: other } });
  try {
    await new Promise((r) => setTimeout(r, 200));
    // An unrelated process: another state folder, or this test itself.
    assert.throws(() => killServer(child.pid, mine), /not the EditLens server of/);
    assert.throws(() => killServer(process.pid, other), /not a pid to signal/);
    const gone = new Promise((r) => child.on('exit', (code, signal) => r(signal)));
    assert.strictEqual(killServer(child.pid, other), true);
    assert.strictEqual(await gone, 'SIGTERM');
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(mine, { recursive: true, force: true });
    fs.rmSync(other, { recursive: true, force: true });
  }
});
