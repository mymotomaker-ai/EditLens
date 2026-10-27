'use strict';
require('./isolate');
// Page control's safety check and "Restore previous version": a write that replaces most of a
// file, or an edit that removes EditLens from the app, is asked about in every permission mode,
// and a file Claude changed can be put back as it was.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-guard-state-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4387';
const guard = require('../lib/guard');
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');
const config = require('../lib/config');
const { BackupStore } = require('../server/backups');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-guard-'));
const APP = Array.from({ length: 30 }, (_, i) => `export const item${i} = ${i};`).join('\n') + '\n';
const VITE = [
  "import { defineConfig } from 'vite';",
  "import react from '@vitejs/plugin-react';",
  "import liveEdits from 'editlens/vite';",
  '',
  'export default defineConfig({',
  '  plugins: [react(), liveEdits()],',
  "  server: { host: '127.0.0.1' },",
  '});',
].join('\n');

test('a write that keeps less than half of a file is asked about', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'App.jsx'), APP);
    const keep = APP + 'export const extra = 1;\n';
    assert.strictEqual(guard.check('Write', { file_path: 'App.jsx', content: keep }, dir), null, 'adding to a file is fine');
    const r = guard.check('Write', { file_path: path.join(dir, 'App.jsx'), content: 'export default function App() { return null; }\n' }, dir);
    assert.ok(r && r.kind === 'replace', JSON.stringify(r));
    assert.match(r.reason, /replaces most of App\.jsx: \d+% of its 30 lines/);
    assert.ok(!/NaN/.test(r.reason));
    assert.strictEqual(guard.check('Write', { file_path: 'new.jsx', content: 'x' }, dir), null, 'a new file is fine');
    fs.writeFileSync(path.join(dir, 'small.css'), 'a{}\nb{}\n');
    assert.strictEqual(guard.check('Write', { file_path: 'small.css', content: 'c{}' }, dir), null, 'small files are rewritten freely');
    assert.strictEqual(guard.check('Edit', { file_path: 'App.jsx', old_string: 'item1 ', new_string: 'one ' }, dir), null, 'a normal edit is fine');
    assert.strictEqual(guard.check('Read', { file_path: 'App.jsx' }, dir), null);
    assert.strictEqual(guard.check('Write', { file_path: 'App.jsx' }, dir), null, 'no content: nothing to judge');
    assert.strictEqual(guard.check('Write', null, dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('taking EditLens out of the build config is asked about, by Write, Edit or MultiEdit', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'vite.config.js'), VITE);
    const plain = VITE.replace("import liveEdits from 'editlens/vite';\n", '').replace(', liveEdits()', '');
    const w = guard.check('Write', { file_path: 'vite.config.js', content: plain }, dir);
    assert.strictEqual(w && w.kind, 'integration');
    assert.match(w.reason, /removes EditLens from vite\.config\.js/);
    const e = guard.check('MultiEdit', { file_path: 'vite.config.js', edits: [
      { old_string: "import liveEdits from 'editlens/vite';\n", new_string: '' },
      { old_string: ', liveEdits()', new_string: '' },
    ] }, dir);
    assert.strictEqual(e && e.kind, 'integration');
    assert.strictEqual(guard.check('Edit', { file_path: 'vite.config.js', old_string: "'127.0.0.1'", new_string: "'0.0.0.0'" }, dir), null, 'other config changes are fine');
    assert.strictEqual(guard.check('Edit', { file_path: 'vite.config.js', old_string: 'react(), ', new_string: '' }, dir), null);
    assert.strictEqual(guard.check('Edit', { file_path: 'vite.config.js', old_string: 'not there', new_string: '' }, dir), null, 'an edit that would fail anyway');
    fs.writeFileSync(path.join(dir, 'index.html'), '<body><script src="http://127.0.0.1:4317/live.js"></script></body>');
    assert.strictEqual((guard.check('Write', { file_path: 'index.html', content: '<body></body>' }, dir) || {}).kind, 'integration', 'the script tag counts too');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('EDITLENS_GUARD=off turns the check off', () => {
  const dir = tmp();
  const saved = process.env.EDITLENS_GUARD;
  try {
    fs.writeFileSync(path.join(dir, 'App.jsx'), APP);
    process.env.EDITLENS_GUARD = 'off';
    assert.strictEqual(guard.check('Write', { file_path: 'App.jsx', content: 'x' }, dir), null);
  } finally {
    if (saved === undefined) delete process.env.EDITLENS_GUARD;
    else process.env.EDITLENS_GUARD = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Safety check setting reads the same here as everywhere (false, 0, off, no)', () => {
  const dir = tmp();
  const saved = process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK;
  try {
    fs.writeFileSync(path.join(dir, 'App.jsx'), APP);
    for (const v of ['false', '0', 'off', 'no']) {
      process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK = v;
      assert.strictEqual(guard.check('Write', { file_path: 'App.jsx', content: 'x' }, dir), null, v);
    }
    process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK = 'true';
    assert.ok(guard.check('Write', { file_path: 'App.jsx', content: 'x' }, dir));
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK;
    else process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('keptShare and afterText', () => {
  assert.strictEqual(guard.keptShare('a\nb\nc\nd\n', 'a\nb\n'), 0.5);
  assert.strictEqual(guard.keptShare('', 'x'), 1, 'an empty file loses nothing');
  assert.strictEqual(guard.keptShare('}\n;\n', ''), 1, 'brackets alone do not count');
  assert.strictEqual(guard.afterText('Edit', { old_string: 'a', new_string: 'b', replace_all: true }, 'aXa'), 'bXb');
  assert.strictEqual(guard.afterText('Edit', { old_string: 'a', new_string: '$&$&' }, 'a'), '$&$&', 'replacement text is taken literally');
  assert.strictEqual(guard.afterText('NotebookEdit', {}, 'a'), null);
});

test('Manual: the plugin hook asks first, and Restore on the page puts the file back', async (t) => {
  const dir = tmp();
  await ensureServer();
  let events = null;
  t.after(async () => {
    if (events) events.abort();
    await stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'App.jsx');
  fs.writeFileSync(file, APP);
  const runHook = (content) => spawnSync(process.execPath, [path.join(__dirname, '..', 'hooks', 'live-hook.js'), 'pending'], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_use_id: 'tu1', session_id: 's1', cwd: dir, permission_mode: 'acceptEdits', tool_input: { file_path: file, content } }),
    encoding: 'utf8', timeout: 15000, env: process.env,
  });
  const out = runHook('export default 1;\n');
  const json = JSON.parse(out.stdout.trim());
  assert.strictEqual(json.hookSpecificOutput.permissionDecision, 'ask', out.stdout + out.stderr);
  assert.match(json.hookSpecificOutput.permissionDecisionReason, /replaces most of App\.jsx/);
  assert.strictEqual(runHook(APP + 'x\n').stdout.trim(), '', 'nothing to say for a normal write');

  // Claude's edit arrives at the server with the file's earlier text; the event names a backup.
  fs.writeFileSync(file, 'export default 1;\n');
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Write', file, relFile: 'App.jsx', before: APP, after: 'export default 1;\n', stats: { added: 1, removed: 30 } });
  const ev = (await getJson('/history')).filter((e) => e.type === 'change').pop();
  assert.match(ev.backup || '', /^b[0-9a-f]{16}$/, JSON.stringify(ev));
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Write', file: path.join(dir, 'new.js'), relFile: 'new.js', created: true, before: '', after: 'x' });
  assert.ok(!(await getJson('/history')).pop().backup, 'a created file has nothing to restore');

  const restore = (body) => fetch(`${config.baseUrl}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  assert.strictEqual((await restore({ page: 'nobody', id: ev.backup })).status, 403, 'only a page this server knows');
  events = new AbortController();
  const stream = await fetch(`${config.baseUrl}/events?page=p1&root=${encodeURIComponent(dir)}`, { signal: events.signal });
  assert.strictEqual(stream.status, 200);
  assert.strictEqual((await restore({ page: 'p1', id: 'b0000000000000000' })).status, 404);
  const r = await restore({ page: 'p1', id: ev.backup });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), APP, 'the file is back');
  assert.ok((await restore({ page: 'p1', id: r.body.undo })).status === 200, 'and the restore can be undone');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'export default 1;\n');
});

test('backups: restore puts the file back and keeps the current text for undo', () => {
  const dir = tmp();
  try {
    const store = new BackupStore(path.join(dir, 'backups'));
    const file = path.join(dir, 'App.jsx');
    fs.writeFileSync(file, 'new text');
    const id = store.save({ file, relFile: 'App.jsx', cwd: dir, text: 'old text' });
    assert.match(id, /^b[0-9a-f]{16}$/);
    assert.strictEqual(store.save({ file: 'relative.js', text: 'x' }), null, 'only absolute paths');
    assert.strictEqual(store.save({ file, text: 'a\u0000b' }), null, 'no binary files');
    const r = store.restore(id);
    assert.ok(r.ok && r.undo, JSON.stringify(r));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old text');
    assert.ok(store.restore(r.undo).ok);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new text', 'undo');
    assert.match(store.restore('../../etc/passwd').error, /^That earlier version is no longer kept/);
    assert.strictEqual(store.get('b0000000000000000'), null);
    fs.writeFileSync(path.join(dir, 'backups', 'b1111111111111111.json'), '{broken');
    assert.strictEqual(store.get('b1111111111111111'), null, 'a damaged copy is skipped');
    fs.unlinkSync(file);
    assert.ok(store.restore(id).ok, 'a deleted file is written again');
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old text');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('backups: the oldest copies are removed first', () => {
  const dir = tmp();
  try {
    const store = new BackupStore(path.join(dir, 'backups'));
    for (let i = 0; i < 205; i++) store.save({ file: path.join(dir, 'f.js'), text: 'v' + i });
    assert.ok(store.list().length <= 200);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a git commit that adds EditLens to the project is asked about', async () => {
  const dir = tmp();
  const g = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, 'vite.config.js'), "export default { plugins: [] };\n");
    g('add', '.');
    g('commit', '-qm', 'one');
    assert.strictEqual(guard.check('Bash', { command: 'git commit -m "x"' }, dir), null, 'nothing staged');
    fs.writeFileSync(path.join(dir, 'vite.config.js'), "import editlens from 'editlens/vite';\nexport default { plugins: [editlens()] };\n");
    assert.strictEqual(guard.check('Bash', { command: 'git commit -m "x"' }, dir), null, 'changed but not staged');
    const all = guard.check('Bash', { command: 'git commit -am "add pages"' }, dir);
    assert.strictEqual(all && all.kind, 'commit', 'commit -a takes the changes too');
    g('add', 'vite.config.js');
    const r = guard.check('Bash', { command: 'cd app && git commit -m "add pages"' }, dir);
    assert.strictEqual(r && r.kind, 'commit');
    // Page control runs the same check without blocking the live server.
    assert.deepStrictEqual(await guard.checkAsync('Bash', { command: 'cd app && git commit -m "add pages"' }, dir), r);
    assert.strictEqual(await guard.checkAsync('Bash', { command: 'git status' }, dir), null);
    assert.match(r.reason, /This commit adds EditLens to vite\.config\.js/);
    assert.strictEqual(guard.check('Bash', { command: 'git status' }, dir), null);
    assert.strictEqual(guard.check('Bash', { command: 'npm run build' }, dir), null);
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"editlens"}');
    assert.strictEqual(guard.check('Bash', { command: 'git commit -m x' }, dir), null, 'the EditLens repository itself');
    fs.rmSync(path.join(dir, 'package.json'));
    assert.strictEqual(guard.check('Bash', { command: 'git commit -m x' }, path.join(os.tmpdir())), null, 'not a repository');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
