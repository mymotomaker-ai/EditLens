'use strict';
require('./isolate');
// Sol advice (0.24.45): a command run as the task account (lib/taskuser.js runAs) has a deadline,
// so a command that never ends can't keep a task's start or removal waiting.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('runAs: a command past its deadline is stopped and said plainly', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-runas-'));
  const oldPath = process.env.PATH;
  try {
    // A stand-in runuser whose command never ends.
    fs.writeFileSync(path.join(dir, 'runuser'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    const taskuser = require('../lib/taskuser');
    const a = { name: 'editlens', home: dir, stateDir: dir };
    const started = Date.now();
    const r = await taskuser.runAs(a, ['true'], { timeoutMs: 300 });
    assert.ok(Date.now() - started < 5000, 'stopped at the deadline');
    assert.strictEqual(r.ok, false);
    assert.match(r.err, /did not end in 0\.3 s/);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
