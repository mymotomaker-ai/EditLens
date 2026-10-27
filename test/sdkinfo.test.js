'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4922';
// The download is named the same everywhere: package, maker, source.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const info = require('../lib/sdkinfo');

test('registryHost: the npm setting, else registry.npmjs.org', () => {
  assert.strictEqual(info.registryHost('https://registry.npmjs.org/\n'), 'registry.npmjs.org');
  assert.strictEqual(info.registryHost('https://npm.example.com:8443/repo/'), 'npm.example.com:8443');
  for (const bad of [undefined, null, '', '  ', 'not a url', 'file:///tmp/x', 'javascript:alert(1)', 42]) {
    assert.strictEqual(info.registryHost(bad), 'registry.npmjs.org', String(bad));
  }
});

test('every download line names the package, the maker and the source', async () => {
  assert.strictEqual(info.sdkSource(), '@anthropic-ai/claude-agent-sdk (made by Anthropic) from registry.npmjs.org');
  assert.strictEqual(require('../server/driver').SDK_PACKAGE, info.SDK_PACKAGE);
  const mod = await import(path.join(__dirname, '..', 'hooks', 'mod.mjs'));
  const [, full, mid] = mod.BUSY.control;
  assert.ok(full.includes(info.sdkSource()), full);
  assert.ok(mid.includes(info.SDK_PACKAGE), mid);
  const drive = fs.readFileSync(path.join(__dirname, '..', 'bin', 'drive.js'), 'utf8');
  assert.match(drive, /downloading \$\{sdkSource\(npmRegistry\(dir\)\)\}/);
  assert.doesNotMatch(drive, /'0\.3\.\d+'/, 'the version is in lib/sdkinfo.js only');
  const hook = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'utf8');
  assert.strictEqual((hook.match(/sdkinfo'\)\.sdkSource\(\)/g) || []).length, 2);
  assert.doesNotMatch(hook, /\(the Claude Agent SDK, about 30 MB\)/);
});
