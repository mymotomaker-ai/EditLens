'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4335';
// Drive mode pieces that don't need Claude: the input queue the SDK reads, the permission card
// text, the environment the driven session gets, and refusing to start without the SDK.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Driver, InputQueue, describeTool, cleanEnv } = require('../server/driver');

test('the input queue delivers messages in order, waits, and ends', async () => {
  const q = new InputQueue();
  q.push('a');
  const it = q[Symbol.asyncIterator]();
  assert.deepStrictEqual(await it.next(), { value: 'a', done: false });
  const later = it.next();
  q.push('b');
  assert.deepStrictEqual(await later, { value: 'b', done: false });
  const end = it.next();
  q.close();
  assert.deepStrictEqual(await end, { value: undefined, done: true });
  q.push('c');
  assert.strictEqual((await it.next()).done, true, 'nothing after close');
});

test('permission cards say what the tool wants, clipped', () => {
  assert.deepStrictEqual(describeTool('Bash', { command: 'npm test', description: 'Run tests' }), { title: 'Run a command', detail: 'npm test', note: 'Run tests' });
  assert.strictEqual(describeTool('Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' }).diff.after, 'y');
  assert.strictEqual(describeTool('Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y' }).note, undefined);
  assert.strictEqual(describeTool('Edit', { file_path: 'a.js', old_string: 'x', new_string: 'y', replace_all: true }).note, 'Changes every match in the file, not only the first.');
  assert.strictEqual(describeTool('mcp__x__y', { a: 'b'.repeat(5000) }).detail.length, 1500);
  assert.strictEqual(describeTool('Bash', {}).detail, '');
});

test("the driven session doesn't inherit the parent session's identity", () => {
  const saved = { ...process.env };
  Object.assign(process.env, { CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_OAUTH_TOKEN: 'keep', CLAUDE_PROJECT_DIR: '/x', EDITLENS_PORT: '4335' });
  try {
    const env = cleanEnv();
    assert.strictEqual(env.CLAUDECODE, undefined);
    assert.strictEqual(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.strictEqual(env.CLAUDE_PROJECT_DIR, undefined);
    assert.strictEqual(env.CLAUDE_CODE_OAUTH_TOKEN, 'keep', 'the login stays');
    assert.strictEqual(env.EDITLENS_PORT, '4335');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('start refuses without the SDK, a bad folder or session id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-drive-'));
  const saved = process.env.EDITLENS_SDK_DIR;
  process.env.EDITLENS_SDK_DIR = path.join(dir, 'none');
  try {
    const events = [];
    const d = new Driver({ root: false, emit: (e) => events.push(e), log: () => {}, stateDir: dir });
    assert.match((await d.start({ cwd: path.join(dir, 'missing') })).error, /does not exist/);
    assert.match((await d.start({ cwd: dir, resume: 'abc' })).error, /Bad session id/);
    const r = await d.start({ cwd: dir });
    assert.ok(r.error, 'no SDK, no start');
    assert.deepStrictEqual(d.readiness(), { installed: false, signedIn: null });
    assert.deepStrictEqual(d.status(), { active: false });
    assert.match(d.send('hi').error, /not running/);
    assert.match(d.answer('x', 'allow').error, /already answered/);
    assert.strictEqual(events.length, 0);
  } finally {
    if (saved === undefined) delete process.env.EDITLENS_SDK_DIR;
    else process.env.EDITLENS_SDK_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('"Always" from the panel lasts for the session only, never in a settings file', () => {
  const { sessionOnly } = require('../server/driver');
  assert.deepStrictEqual(sessionOnly([{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm *' }], behavior: 'allow', destination: 'localSettings' }, null]),
    [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm *' }], behavior: 'allow', destination: 'session' }]);
  assert.strictEqual(sessionOnly(undefined), undefined);
});
