'use strict';
require('./isolate');
// Settings check 0.24.55 K1: a change of the Effort setting to the level page control already runs at
// is still the newest choice, so a level kept for page control goes. The save /editlens effort asks
// for itself keeps its level. Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-keep-setting-'));
const state = path.join(dir, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const exe = path.join(bin, 'claude');
const PORT = 5541;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: String(PORT),
  EDITLENS_PAIR_PORT: '5542',
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { ensureServer, stopServer, postJson } = require('../lib/client');
const config = require('../lib/config');
const project = path.join(dir, 'app');
fs.mkdirSync(project);

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};
function openPage(id) {
  const ctrl = new AbortController();
  fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(project)}`, { signal: ctrl.signal }).then(async (res) => {
    for await (const chunk of res.body) if (!chunk) break;
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return () => ctrl.abort();
}
const kept = () => {
  const f = path.join(config.stateDir, 'page-control-effort.json');
  return fs.existsSync(f) ? Object.values(JSON.parse(fs.readFileSync(f, 'utf8'))).map((r) => r.level) : [];
};

test('K1: the Effort setting changed to the running level replaces a kept level; /editlens effort keeps its own', async (t) => {
  await ensureServer();
  const close = openPage('k1');
  t.after(async () => {
    close();
    await postJson('/drive/end', {}).catch((err) => console.log('end:', err.message));
    await stopServer();
  });
  // A hook's report: the setting in effect, with no mod running (so /editlens effort saves nothing).
  const hookReport = (effort) => postJson('/settings/report', { from: 'hook', values: { effort } });
  const modReport = (effort) => postJson('/settings/report', { from: 'mod', pid: process.pid, values: { effort } });
  assert.ok((await hookReport('Low')).ok);
  const grant = await postJson('/drive/grant', { cwd: project, claudePath: exe }, { timeoutMs: 20000 });
  assert.ok(grant.ok, JSON.stringify(grant));
  assert.ok(await until(async () => (await postJson('/effort', { level: 'high', cwd: project })).page), 'page control runs');
  // High picked for page control (the setting is not saved): kept.
  assert.ok(await until(() => kept().includes('high')), JSON.stringify(kept()));
  // The setting changes to High, the level page control runs at: the newest choice, nothing kept.
  assert.ok((await hookReport('High')).ok);
  assert.ok(await until(() => kept().length === 0), `the kept level goes: ${JSON.stringify(kept())}`);

  // With the mod: /editlens effort medium saves Effort Medium too; that save keeps the level.
  assert.ok((await modReport('High')).ok);
  const medium = await postJson('/effort', { level: 'medium', cwd: project });
  assert.strictEqual(medium.saved, true, JSON.stringify(medium));
  assert.ok(await until(() => kept().includes('medium')), JSON.stringify(kept()));
  assert.ok((await modReport('Medium')).ok);
  await new Promise((r) => setTimeout(r, 500));
  assert.deepStrictEqual(kept(), ['medium']);
});
