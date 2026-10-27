'use strict';
require('./isolate');
// The auto-compact window from Claude Code's settings (/autocompact): which file and key win, the
// env variable first, and the page and terminal show it instead of a guessed 200k.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-ccsettings-'));
const PORT = 4323;
const cfg = path.join(dir, 'claude-config');
fs.mkdirSync(cfg);
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(dir, 'live'), EDITLENS_PORT: String(PORT), CLAUDE_CONFIG_DIR: cfg });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { compactWindow, canonicalModel, windowOf } = require('../lib/ccsettings');
const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}
const wait = () => new Promise((r) => setTimeout(r, 2100)); // past the 2 s cache

test('values: 100000 to 1000000 whole tokens; "auto", NaN and others are none', () => {
  for (const [v, out] of [[400000, 400000], ['400000', 400000], [100000, 100000], [1000000, 1000000], ['auto', null], [99999, null], [1000001, null],
    [400000.5, null], [NaN, null], [Infinity, null], ['4e5', null], ['0x61a80', null], [null, null], [undefined, null], [{}, null]]) {
    assert.strictEqual(windowOf(v), out, String(v));
  }
  assert.strictEqual(canonicalModel('claude-opus-4-8[1m]'), 'claude-opus-4-8');
  assert.strictEqual(canonicalModel('claude-opus-4-8-20260101'), 'claude-opus-4-8');
  assert.strictEqual(canonicalModel('us.anthropic.claude-opus-4-8-v1:0'), 'claude-opus-4-8');
  assert.strictEqual(canonicalModel(null), '');
});

test('files: user, then the project\'s settings.json, then settings.local.json; per model replaces the top level', async () => {
  const proj = path.join(dir, 'p1');
  fs.mkdirSync(proj);
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8'), null, 'nothing set');
  writeJson(path.join(cfg, 'settings.json'), { autoCompactWindow: 400000 });
  await wait();
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8'), 400000, 'the user setting (the user\'s case)');
  writeJson(path.join(proj, '.claude', 'settings.json'), { autoCompactWindow: 300000 });
  await wait();
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8'), 300000);
  writeJson(path.join(proj, '.claude', 'settings.local.json'), { modelSettings: { 'claude-opus-4-8': { autoCompactWindow: 250000 } } });
  await wait();
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8[1m]'), 250000, 'per model, [1m] spelling');
  assert.strictEqual(compactWindow(proj, 'claude-sonnet-5-5'), 300000, 'another model: the top level');
  writeJson(path.join(proj, '.claude', 'settings.local.json'), '{ not json');
  await wait();
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8'), 300000, 'a broken file is skipped');
  writeJson(path.join(proj, '.claude', 'settings.json'), { autoCompactWindow: 'auto' });
  await wait();
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8'), null, '"auto" in a later file takes precedence');
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8', '500000'), 500000, 'the env variable takes precedence');
  assert.strictEqual(compactWindow(proj, 'claude-opus-4-8', 'lots'), null);
});

test('the page and /summary use it: 400k, never a guessed 200k', async (t) => {
  await stopServer();
  await ensureServer();
  t.after(() => stopServer());
  const proj = path.join(dir, 'p2');
  fs.mkdirSync(proj);
  writeJson(path.join(cfg, 'settings.json'), { autoCompactWindow: 400000 });
  const transcript = path.join(dir, 's1.jsonl');
  const reply = { type: 'assistant', message: { id: 'm1', model: 'claude-opus-4-8', role: 'assistant', content: [{ type: 'text', text: 'Hi.' }],
    usage: { input_tokens: 10, cache_read_input_tokens: 79990, cache_creation_input_tokens: 0, output_tokens: 5 } } };
  fs.writeFileSync(transcript, JSON.stringify(reply) + '\n');
  await postJson('/event', { type: 'session', sessionId: 's1', cwd: proj, transcriptPath: transcript, ts: Date.now() });
  let tokens = null;
  for (let i = 0; i < 60 && !(tokens && tokens.window); i++) {
    await new Promise((r) => setTimeout(r, 100));
    tokens = (await getJson(`/summary?cwd=${encodeURIComponent(proj)}&session=s1`)).tokens;
  }
  assert.deepStrictEqual([tokens.window, tokens.windowSource, tokens.context, tokens.percent], [400000, 'autocompact', 80000, 20]);
});

test('/effort on the server: Auto by default, the level from Claude Code\'s settings; "auto" and levels only', async (t) => {
  await stopServer();
  await ensureServer();
  t.after(() => stopServer());
  const proj = path.join(dir, 'p3');
  fs.mkdirSync(proj);
  writeJson(path.join(cfg, 'settings.json'), { effortLevel: 'medium' });
  await wait();
  const got = await getJson(`/effort?cwd=${encodeURIComponent(proj)}`);
  assert.deepStrictEqual([got.auto, got.setting], [true, 'medium']);
  const auto = await postJson('/effort', { level: 'auto', cwd: proj });
  assert.deepStrictEqual([auto.ok, auto.auto, auto.level, auto.page], [true, true, 'medium', null]);
  await assert.rejects(postJson('/effort', { level: 'automatic', cwd: proj }), /400/);
});
