'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4927';
// Page control without a login: Claude is asked whether it is signed in before it starts; a
// "Please run /login" answer is caught; "Sign in" runs Claude's own sign-in and then Claude
// starts by itself and sends the message that was waiting. Uses a stand-in claude and SDK
// (test/fixtures), so no real login is involved.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Driver, signedIn, signedOutMessage } = require('../server/driver');

function setup(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-signin-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  if (opts.signedIn) fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
  const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
  const saved = { sdk: process.env.EDITLENS_SDK_DIR, state: process.env.FAKE_CLAUDE_STATE, wait: process.env.FAKE_CLAUDE_LOGIN_MS };
  process.env.EDITLENS_SDK_DIR = path.join(dir, 'sdk');
  process.env.FAKE_CLAUDE_STATE = state;
  process.env.FAKE_CLAUDE_LOGIN_MS = opts.wait || '200';
  const events = [];
  const d = new Driver({ root: false, emit: (e) => events.push(e), log: () => {}, stateDir: dir, platform: 'linux' });
  const restore = () => {
    d.stop('test over');
    for (const [k, env] of [['sdk', 'EDITLENS_SDK_DIR'], ['state', 'FAKE_CLAUDE_STATE'], ['wait', 'FAKE_CLAUDE_LOGIN_MS']]) {
      if (saved[k] === undefined) delete process.env[env];
      else process.env[env] = saved[k];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, state, d, events, exe: path.join(bin, 'claude'), restore };
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
};

test('spots "please run /login" in what Claude says', () => {
  assert.ok(signedOutMessage({ type: 'assistant', error: 'authentication_failed', message: { content: [] } }));
  assert.ok(signedOutMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Invalid API key · Please run /login' }] } }));
  assert.ok(signedOutMessage({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }));
  assert.ok(!signedOutMessage({ type: 'result', is_error: false, result: 'I told you to run /login earlier' }));
  assert.ok(!signedOutMessage({ type: 'assistant', message: { content: 'All good.' } }));
  assert.ok(!signedOutMessage(null));
});

test('network, rate-limit and busy errors are not taken for a missing login', () => {
  const { notSignInError } = require('../server/driver');
  const res = (text) => ({ type: 'result', is_error: true, result: text });
  for (const text of ['OAuth token refresh failed: fetch failed · Please run /login', 'API Error: Connection error. Please run /login', 'API Error: 429 rate_limit_error authentication_error', 'API Error: 529 Overloaded · Please run /login']) {
    assert.ok(!signedOutMessage(res(text)), text);
    assert.ok(!signedOutMessage({ type: 'assistant', error: 'authentication_failed', message: { content: text } }), text);
  }
  assert.match(notSignInError('getaddrinfo ENOTFOUND api.anthropic.com'), /network/);
  assert.match(notSignInError('429 Too Many Requests'), /rate limit/);
  assert.match(notSignInError('503 Service Unavailable'), /busy or had an error/);
  assert.match(notSignInError('another Claude Code process is refreshing the token'), /No new sign-in is needed/);
  assert.strictEqual(notSignInError('OAuth token has expired · Please run /login'), null);
  assert.ok(signedOutMessage(res('OAuth token has expired · Please run /login')), 'a real expired login still asks for /login');
});

test('asks claude whether it is signed in, and copes when it cannot tell', async () => {
  const t = setup();
  try {
    assert.strictEqual(await signedIn(t.exe, process.env), false);
    fs.writeFileSync(path.join(t.state, 'signed-in'), 'yes');
    assert.strictEqual(await signedIn(t.exe, process.env), true);
    assert.strictEqual(await signedIn(null, process.env), null);
    assert.strictEqual(await signedIn(path.join(t.dir, 'missing', 'claude'), process.env), null);
  } finally {
    t.restore();
  }
});

test('not signed in: waits for Sign in, then starts and sends the waiting message', async () => {
  const t = setup();
  try {
    const r = await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    assert.deepStrictEqual(r, { ok: true, signIn: true });
    assert.strictEqual(t.d.status().phase, 'signin');
    assert.ok(!fs.existsSync(path.join(t.state, 'queries')), 'Claude was not started');
    assert.deepStrictEqual(t.d.send('make the title bold'), { ok: true, waiting: true });
    assert.deepStrictEqual(t.d.signIn({}), { ok: true });
    assert.ok(await until(() => t.events.some((e) => e.type === 'drive-signin' && e.state === 'waiting' && /^https:\/\/example\.test\//.test(e.url))));
    assert.ok(await until(() => t.events.some((e) => e.type === 'drive-signin' && e.state === 'done')));
    assert.strictEqual(fs.readFileSync(path.join(t.state, 'login-args'), 'utf8'), '--claudeai');
    assert.ok(await until(() => fs.existsSync(path.join(t.state, 'answered'))), 'the waiting message was sent');
    assert.strictEqual(fs.readFileSync(path.join(t.state, 'answered'), 'utf8'), 'make the title bold\n');
    assert.notStrictEqual(t.d.status().phase, 'signin');
  } finally {
    t.restore();
  }
});

test('"Please run /login" mid-session: back to Sign in, and the message is sent again after', async () => {
  const t = setup();
  try {
    // claude says it is signed in, but the session answers "Not logged in" (an expired login).
    fs.writeFileSync(path.join(t.state, 'signed-in'), 'yes');
    assert.deepStrictEqual(await t.d.start({ cwd: t.dir, claudePaths: [t.exe] }), { ok: true });
    fs.rmSync(path.join(t.state, 'signed-in'));
    t.d.send('hello');
    assert.ok(await until(() => t.d.status().phase === 'signin'));
    const ev = t.events.find((e) => e.type === 'drive' && e.phase === 'signin');
    assert.strictEqual(ev.retry, true);
    assert.strictEqual(t.d.status().active, true, 'the page keeps control');
    // Console sign-in, finished with a pasted code.
    process.env.FAKE_CLAUDE_LOGIN_MS = 'never';
    assert.deepStrictEqual(t.d.signIn({ console: true }), { ok: true });
    assert.ok(await until(() => t.events.some((e) => e.type === 'drive-signin' && e.state === 'waiting')));
    assert.match(t.d.signInCode('two\nlines').error, /is not valid/);
    assert.deepStrictEqual(t.d.signInCode('abc123'), { ok: true });
    assert.ok(await until(() => fs.existsSync(path.join(t.state, 'answered'))));
    assert.strictEqual(fs.readFileSync(path.join(t.state, 'login-args'), 'utf8'), '--console');
    assert.strictEqual(fs.readFileSync(path.join(t.state, 'answered'), 'utf8'), 'hello\n');
    assert.strictEqual(fs.readFileSync(path.join(t.state, 'queries'), 'utf8').trim().split('\n').length, 2, 'started again once');
  } finally {
    t.restore();
  }
});

test('a failed or cancelled sign-in says so and can be tried again', async () => {
  const t = setup({ wait: 'never' });
  try {
    await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    t.d.signIn({});
    assert.ok(await until(() => t.events.some((e) => e.type === 'drive-signin' && e.state === 'waiting')));
    t.d.signInCode('bad');
    assert.ok(await until(() => t.events.some((e) => e.type === 'drive-signin' && e.state === 'failed')));
    assert.match(t.events.find((e) => e.state === 'failed').error, /didn't finish: Invalid code/);
    assert.strictEqual(t.d.status().phase, 'signin');
    t.d.signIn({});
    assert.ok(await until(() => t.d.status().signin));
    assert.deepStrictEqual(t.d.cancelSignIn(), { ok: true });
    assert.ok(t.events.some((e) => e.type === 'drive-signin' && e.state === 'cancelled'));
    assert.strictEqual(t.d.status().signin, null);
    assert.match(t.d.signInCode('x').error, /No sign-in/);
  } finally {
    t.restore();
  }
});

test('a busy sign-in (another Claude Code renewing it) is tried again, never sent to /login', async () => {
  process.env.EDITLENS_BUSY_RETRY_MS = '20';
  const t = setup({ signedIn: true });
  const results = [];
  t.d.onMessage = (msg) => { if (msg.type === 'result') results.push(msg); };
  try {
    assert.ok(!signedOutMessage({ type: 'result', is_error: true, error: 'authentication_failed', result: 'Failed to refresh OAuth token: another Claude Code process is refreshing it' }));
    assert.deepStrictEqual(await t.d.start({ cwd: t.dir, claudePaths: [t.exe] }), { ok: true });
    await t.d.started();
    t.d.send('busy 2');
    assert.ok(await until(() => results.some((r) => r.result === 'Done after busy')), JSON.stringify(results));
    assert.strictEqual(results.length, 1, 'the busy answers are not passed on');
    // Still busy after 3 more tries: a plain message, and no sign-in.
    fs.writeFileSync(path.join(t.state, 'busy'), '0');
    t.d.send('busy 9');
    assert.ok(await until(() => results.length === 2));
    assert.match(results[1].result, /sign-in on this computer was busy .* No new sign-in is needed/);
    assert.notStrictEqual(t.d.status().phase, 'signin');
    assert.strictEqual(Number(fs.readFileSync(path.join(t.state, 'busy'), 'utf8')), 4);
  } finally {
    delete process.env.EDITLENS_BUSY_RETRY_MS;
    t.restore();
  }
});

test('two starts immediately: one Claude runs, the other is told; a stop while the SDK loads counts', async () => {
  const t = setup({ signedIn: true });
  const saved = process.env.FAKE_SDK_IMPORT_MS;
  process.env.FAKE_SDK_IMPORT_MS = '300';
  try {
    const [a, b] = await Promise.all([t.d.start({ cwd: t.dir, claudePaths: [t.exe] }), t.d.start({ cwd: t.dir, claudePaths: [t.exe] })]);
    assert.deepStrictEqual(a, { ok: true });
    assert.match(b.error, /already running/);
    assert.match(t.d.status().runId, /^[0-9a-f]{12}$/);
    t.d.stop('test');
    // A new copy of the SDK, so the import waits again.
    const sdk2 = path.join(t.dir, 'sdk2', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
    fs.mkdirSync(sdk2, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk2, 'sdk.mjs'));
    process.env.EDITLENS_SDK_DIR = path.join(t.dir, 'sdk2');
    const c = t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    t.d.stop('Manual while it loads');
    assert.match((await c).error, /stopped/);
    assert.strictEqual(t.d.status().active, false);
  } finally {
    if (saved === undefined) delete process.env.FAKE_SDK_IMPORT_MS;
    else process.env.FAKE_SDK_IMPORT_MS = saved;
    t.restore();
  }
});
