'use strict';
require('./isolate');
// The server reports its version, stops on request, and is started outside the plugin folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-test-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4391';
const config = require('../lib/config');
const { ensureServer, stopServer, health } = require('../lib/client');

test('version comes from package.json', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.strictEqual(config.version, pkg.version);
});

test('ensureServer starts a server that reports this version, and stopServer stops it', async () => {
  const started = await ensureServer();
  try {
    assert.strictEqual(started.started, true);
    const h = await health();
    assert.strictEqual(h.version, config.version);
    // Already running with the same version: kept running.
    assert.strictEqual((await ensureServer()).started, false);
  } finally {
    assert.strictEqual(await stopServer(), true);
  }
  assert.strictEqual(await health(), null);
});

test('a server left over from another plugin version is replaced', async () => {
  // Copy the plugin and mark the copy as an older version.
  const old = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-old-'));
  for (const dir of ['lib', 'server', 'client']) fs.cpSync(path.join(__dirname, '..', dir), path.join(old, dir), { recursive: true });
  fs.writeFileSync(path.join(old, 'package.json'), JSON.stringify({ version: '0.0.1' }));
  const child = spawn(process.execPath, [path.join(old, 'server', 'server.js')], { env: process.env, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50 && !(await health()); i++) await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual((await health()).version, '0.0.1');
    const result = await ensureServer();
    assert.strictEqual(result.started, true);
    assert.strictEqual(result.replaced, '0.0.1');
    assert.strictEqual((await health()).version, config.version);
  } finally {
    await stopServer();
    child.kill();
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
