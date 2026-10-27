'use strict';
require('./isolate');
// Claude Code's own permission questions on the page: the PermissionRequest hook lists them (and
// answers nothing), they are removed when the tool call, agent or session ends, only the project's
// pages get them, and sessions EditLens runs itself are left out.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-asks-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4384';
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const config = require('../lib/config');
const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');

function hook(phase, input, env = {}) {
  const r = spawnSync(process.execPath, [HOOK, phase], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ...env } });
  return r.stdout;
}

test('questions Claude Code asks are listed on the page, never answered', async (t) => {
  const root = path.join(stateDir, 'shop');
  const other = path.join(stateDir, 'other');
  fs.mkdirSync(root);
  fs.mkdirSync(other);
  await ensureServer();
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  const open = async (id, pageRoot) => {
    const got = [];
    const s = new AbortController();
    streams.push(s);
    const res = await fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(pageRoot)}`, { signal: s.signal });
    (async () => {
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body) {
        buf += dec.decode(chunk);
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
          buf = buf.slice(i + 2);
          if (data) {
            const ev = JSON.parse(data.slice(6));
            if (ev.type === 'ask' || ev.type === 'ask-done') got.push(ev);
          }
        }
      }
    })().catch((err) => {
      if (err.name !== 'AbortError') throw err;
    });
    return got;
  };
  const wait = async (fn) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
    return fn();
  };
  await postEvent({ type: 'session', sessionId: 's1', cwd: root, ts: Date.now(), canListen: false });
  const mine = await open('mine', root);
  const theirs = await open('theirs', other);

  const ask = (extra = {}, env) => hook('ask', { hook_event_name: 'PermissionRequest', session_id: 's1', cwd: root, tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' }, ...extra }, env);
  assert.strictEqual(ask(), '', 'the hook answers nothing: Claude Code asks as usual');
  const first = await wait(() => mine.find((e) => e.type === 'ask'));
  assert.ok(first, 'the page lists it');
  assert.strictEqual(first.title, 'Run a command');
  assert.strictEqual(first.detail, 'npm test');
  assert.strictEqual(first.agentId, null);
  ask(); // asked again: still one
  ask({ agent_id: 'a1', agent_type: 'general-purpose', tool_input: { command: 'rm -rf build' } });
  await wait(() => mine.filter((e) => e.type === 'ask').length >= 2);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(mine.filter((e) => e.type === 'ask').length, 2);
  ask({}, { EDITLENS_DRIVEN: '1' }); // page control: its own cards
  ask({ tool_input: { command: 'ls' }, session_id: 's1' }, { EDITLENS_DISABLE: '1' });
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(mine.filter((e) => e.type === 'ask').length, 2);
  assert.strictEqual(theirs.length, 0, 'another project\'s page gets nothing');

  // A page that opens now gets the open ones.
  const late = await open('late', root);
  assert.strictEqual((await wait(() => late.length === 2 && late)).length, 2);

  // The tool call ends (the mod says so): its question is removed.
  await postEvent({ type: 'ask-done', sessionId: 's1', agentId: null, tool: 'Bash', input: { command: 'npm test', description: 'Run the tests' } });
  const gone = await wait(() => mine.find((e) => e.type === 'ask-done'));
  assert.strictEqual(gone.id, first.id);
  // The subagent stops: its question is removed too.
  await postEvent({ type: 'subagent-stop', sessionId: 's1', agentId: 'a1', agentType: 'general-purpose', projectDir: root, summary: '' });
  assert.ok(await wait(() => mine.filter((e) => e.type === 'ask-done').length === 2));
  // Claude stops: the rest are removed.
  ask({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } });
  await wait(() => mine.filter((e) => e.type === 'ask').length === 3);
  await postEvent({ type: 'idle', sessionId: 's1', cwd: root, ts: Date.now() });
  assert.ok(await wait(() => mine.filter((e) => e.type === 'ask-done').length === 3));
  assert.deepStrictEqual(mine.filter((e) => e.type === 'ask').map((e) => e.title), ['Run a command', 'Run a command', 'Get a web page']);
});
