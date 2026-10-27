'use strict';
require('./isolate');
// Every edit a task makes shows, also files changed by commands (not Edit or Write); page control
// turns on by itself when the page opens, however late, and stops waiting when the user chooses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-vis-'));
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
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: '4359',
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
  CLAUDE_CONFIG_DIR: path.join(dir, 'claude-config'),
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');
const config = require('../lib/config');
const { Tasks } = require('../server/tasks');

const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

test('files a task changed by commands show as its edits, each change once', async () => {
  const ws = path.join(dir, 'ws');
  fs.mkdirSync(ws);
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: ws, encoding: 'utf8' }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'one\n');
  fs.writeFileSync(path.join(ws, 'c.txt'), 'see\n');
  fs.writeFileSync(path.join(ws, 'gone.txt'), 'bye\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const tasks = new Tasks({ stateDir: fs.mkdtempSync(path.join(dir, 'tstate-')), host: 'vps', makeDriver: () => null });
  const t = { id: 'a'.repeat(12), kind: 'sent', dir: ws, base: git('rev-parse', 'HEAD'), state: 'working', edits: [], editCount: 0 };

  await tasks.scanTurnStart(t);
  // During the turn: a heredoc, sed -i, rm, and one Edit the hook reported.
  fs.writeFileSync(path.join(ws, 'a.txt'), 'made by cat\n');
  fs.writeFileSync(path.join(ws, 'b.txt'), 'two\n');
  fs.rmSync(path.join(ws, 'gone.txt'));
  fs.writeFileSync(path.join(ws, 'c.txt'), 'edited\n');
  await tasks.rememberEdit(t, path.join(ws, 'c.txt'), 'edited\n');
  fs.mkdirSync(path.join(ws, '.claude'));
  fs.writeFileSync(path.join(ws, '.claude', 'settings.local.json'), '{}');
  fs.writeFileSync(path.join(ws, '.env'), 'KEY=1');

  let found = await tasks.commandEdits(t);
  const by = Object.fromEntries(found.map((e) => [e.rel, e]));
  assert.deepStrictEqual(Object.keys(by).sort(), ['a.txt', 'b.txt', 'gone.txt'], 'not the Edit, not .claude or keys');
  assert.deepStrictEqual([by['a.txt'].before, by['a.txt'].after, by['a.txt'].created], ['', 'made by cat\n', true]);
  assert.deepStrictEqual([by['b.txt'].before, by['b.txt'].after, by['b.txt'].created], ['one\n', 'two\n', false]);
  assert.deepStrictEqual([by['gone.txt'].before, by['gone.txt'].deleted], ['bye\n', true]);

  // Nothing new: nothing shown again. A second command: from what was shown last.
  assert.deepStrictEqual(await tasks.commandEdits(t), []);
  fs.writeFileSync(path.join(ws, 'a.txt'), 'made by cat\nand more\n');
  found = await tasks.commandEdits(t);
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual([found[0].rel, found[0].before, found[0].after], ['a.txt', 'made by cat\n', 'made by cat\nand more\n']);
  // Put back as it started: shown too.
  fs.writeFileSync(path.join(ws, 'b.txt'), 'one\n');
  found = await tasks.commandEdits(t);
  assert.deepStrictEqual(found.map((e) => [e.rel, e.before, e.after]), [['b.txt', 'two\n', 'one\n']]);
  // The task's own record is not saved with them (memory only).
  assert.ok(!Object.keys(t).includes('known'));
});

test('page control turns on when the page opens, however late; a choice stops the wait', async (t) => {
  await ensureServer();
  const proj = path.join(dir, 'proj');
  fs.mkdirSync(proj);
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
  });
  const control = async () => (await getJson(`/summary?cwd=${encodeURIComponent(proj)}`)).control;
  const open = (id) => {
    const s = new AbortController();
    streams.push(s);
    return fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(proj)}`, { signal: s.signal });
  };

  // Asked for at the session's start; the page opens later.
  const asked = await postJson('/drive/auto', { cwd: proj, claudePath: exe, sessionId: 's1' });
  assert.deepStrictEqual(asked, { ok: true, installed: true });
  await new Promise((r) => setTimeout(r, 300));
  assert.notStrictEqual(await control(), 'page', 'nothing starts without the page');
  await open('p1');
  assert.ok(await until(async () => (await control()) === 'page'), 'on once the page is open');
  await postJson('/drive/end', {});
  assert.ok(await until(async () => (await control()) !== 'page'));

  // Asked for, then the user chose Manual (/editlens manual): the page opening changes nothing.
  for (const s of streams) s.abort();
  assert.ok(await until(async () => (await getJson('/pages/live')).length === 0), 'page closed');
  await postJson('/drive/auto', { cwd: proj, claudePath: exe, sessionId: 's2' });
  await postJson('/drive/stop-waiting', {});
  await open('p2');
  await new Promise((r) => setTimeout(r, 800));
  assert.notStrictEqual(await control(), 'page');

  // Its session ended: no longer waiting either.
  for (const s of streams) s.abort();
  assert.ok(await until(async () => (await getJson('/pages/live')).length === 0), 'page closed');
  await postJson('/drive/auto', { cwd: proj, claudePath: exe, sessionId: 's3' });
  await postJson('/event', { type: 'end', sessionId: 's3', cwd: proj, reason: 'prompt_input_exit' });
  await open('p3');
  await new Promise((r) => setTimeout(r, 800));
  assert.notStrictEqual(await control(), 'page');
});
