'use strict';
require('./isolate');
// Subagents in their own copy: the Agent hook asks Claude Code for a worktree, edits in a copy are
// labelled with it, a finished copy becomes a card, and Merge / Remove work only for the project's page.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-copies-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4369';
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const config = require('../lib/config');

const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function gitProject(name) {
  const root = path.join(stateDir, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  sh(root, 'init', '-q', '-b', 'main');
  sh(root, 'config', 'user.email', 't@example.com');
  sh(root, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(root, 'src', 'App.jsx'), 'export const price = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '.claude/\n');
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'start');
  return root;
}

function hook(phase, input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, phase], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

async function req(method, urlPath, body) {
  const res = await fetch(`${config.baseUrl}${urlPath}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}

test('the Agent hook gives a subagent that can edit its own copy', () => {
  const root = gitProject('hooked');
  const plain = path.join(stateDir, 'plain');
  fs.mkdirSync(plain);
  const call = (ti, cwd = root, env) => hook('agent', { tool_name: 'Agent', tool_input: ti, cwd }, env);
  const out = call({ description: 'Bold prices', prompt: 'Make prices bold', subagent_type: 'general-purpose' });
  assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.strictEqual(out.hookSpecificOutput.permissionDecision, undefined, 'it never answers the permission question');
  assert.deepStrictEqual(out.hookSpecificOutput.updatedInput, { description: 'Bold prices', prompt: 'Make prices bold', subagent_type: 'general-purpose', isolation: 'worktree' });
  assert.match(out.hookSpecificOutput.additionalContext, /own copy/);
  assert.strictEqual(call({ prompt: 'look', subagent_type: 'Explore' }), null, 'a read-only subagent needs no copy');
  assert.strictEqual(call({ prompt: 'x', isolation: 'remote' }), null, 'the caller chose already');
  assert.strictEqual(call({ prompt: 'x' }, plain), null, 'not a git project');
  assert.strictEqual(call({ prompt: 'x' }, root, { CLAUDE_PLUGIN_OPTION_SUBAGENT_COPIES: 'false' }), null, 'setting off');
});

test('a copy: labelled edits, a card when the subagent finishes, Merge and Remove', async (t) => {
  const root = gitProject('shop');
  const dir = path.join(root, '.claude', 'worktrees', 'agent-a1');
  sh(root, 'worktree', 'add', '-q', '-b', 'worktree-agent-a1', dir, 'HEAD');
  await ensureServer();
  const streams = [];
  const events = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const open = async (id, pageRoot) => {
    const s = new AbortController();
    streams.push(s);
    const res = await fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(pageRoot)}`, { signal: s.signal });
    if (id !== 'good') return;
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').find((l) => l.startsWith('data: '));
          if (data) events.push(JSON.parse(data.slice(6)));
        }
      }
    })().catch((err) => {
      if (err.name !== 'AbortError') throw err;
    });
  };
  await postEvent({ type: 'session', sessionId: 's1', cwd: root, ts: Date.now(), canListen: false });
  await open('good', root);
  const other = path.join(stateDir, 'other');
  fs.mkdirSync(other);
  await open('other', other);

  // The subagent edits App.jsx in its copy (through the real PostToolUse hook).
  const file = path.join(dir, 'src', 'App.jsx');
  fs.writeFileSync(file, 'export const price = 2;\n');
  hook('step', {
    hook_event_name: 'PostToolUse', session_id: 's1', cwd: dir, tool_name: 'Edit', tool_use_id: 'tu1', agent_id: 'a1', agent_type: 'general-purpose',
    tool_input: { file_path: file, old_string: 'price = 1', new_string: 'price = 2' }, tool_response: { originalFile: 'export const price = 1;\n' },
  });
  const wait = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    return fn();
  };
  const change = await wait(() => events.find((e) => e.type === 'change' && e.copy));
  assert.ok(change, 'the edit is sent to the page');
  assert.strictEqual(change.copy, 'agent-a1');
  assert.strictEqual(change.relFile, path.join('src', 'App.jsx'));
  assert.strictEqual(change.realFile, path.join(root, 'src', 'App.jsx'));
  assert.strictEqual(change.cwd, root);

  // The subagent finishes: a card says what merging would do.
  hook('agent-stop', { hook_event_name: 'SubagentStop', session_id: 's1', cwd: dir, agent_id: 'a1', agent_type: 'general-purpose', last_assistant_message: 'Done.' });
  const card = await wait(() => events.find((e) => e.type === 'copy'));
  assert.ok(card, 'a copy card');
  assert.strictEqual(card.name, 'agent-a1');
  assert.strictEqual(card.agentId, 'a1');
  assert.strictEqual(card.ready, 1);
  assert.deepStrictEqual(card.files.map((f) => [f.relFile, f.state]), [['src/App.jsx', 'clean']]);

  // Only the project's own page can look at, merge or remove it.
  for (const id of ['other', 'unknown']) {
    assert.strictEqual((await req('GET', `/copy?page=${id}&root=${encodeURIComponent(root)}&name=agent-a1`)).status, 403, id);
    assert.strictEqual((await req('POST', '/copy/merge', { page: id, root, name: 'agent-a1' })).status, 403, id);
    assert.strictEqual((await req('POST', '/copy/remove', { page: id, root, name: 'agent-a1' })).status, 403, id);
  }
  assert.strictEqual((await req('GET', `/copy?page=good&root=${encodeURIComponent(root)}&name=..%2F..`)).status, 404);

  const merged = await req('POST', '/copy/merge', { page: 'good', root, name: 'agent-a1' });
  assert.strictEqual(merged.status, 200, JSON.stringify(merged.body));
  assert.deepStrictEqual(merged.body.applied, ['src/App.jsx']);
  assert.strictEqual(fs.readFileSync(path.join(root, 'src', 'App.jsx'), 'utf8'), 'export const price = 2;\n');
  const edit = await wait(() => events.find((e) => e.type === 'change' && e.tool === 'Merge'));
  assert.ok(edit && edit.backup, 'the merge shows as an edit with Restore');
  assert.strictEqual(edit.agentId, 'a1');
  const state = await wait(() => events.find((e) => e.type === 'copy-state'));
  assert.strictEqual(state.ready, 0);

  assert.strictEqual((await req('POST', '/copy/remove', { page: 'good', root, name: 'agent-a1' })).status, 200);
  assert.strictEqual(fs.existsSync(dir), false);

  // Outside a copy, two agents editing the same file within minutes get a warning on the second edit.
  const f = path.join(root, 'src', 'Nav.jsx');
  const ev = (agentId, toolUseId) => ({ type: 'change', sessionId: 's1', toolUseId, cwd: root, file: f, relFile: 'src/Nav.jsx', agentId, ts: Date.now(), hunks: [], stats: { added: 0, removed: 0 }, after: 'x', created: true });
  await postEvent(ev(null, 'm1'));
  await postEvent(ev(null, 'm2'));
  await postEvent(ev('b2', 'b1'));
  const edits = await wait(() => {
    const l = events.filter((e) => e.type === 'change' && e.relFile === 'src/Nav.jsx');
    return l.length === 3 && l;
  });
  assert.deepStrictEqual(edits.map((e) => Boolean(e.overlap)), [false, false, true]);
  assert.deepStrictEqual(edits[2].overlap, { agentId: null, agentType: null });
});
