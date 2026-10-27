'use strict';
require('./isolate');
// Sol scan of 0.24.46, part 2: S6 (an Effort change Claude Code accepts is sent to page control
// running now; Auto with no level in Claude Code's settings switches to Claude's own level) and
// N2 (tasks as the normal task account follow this user's Subagent copies and Safety check when
// they are Off). Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol46-part2-'));
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
const PORT = 5490;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: String(PORT),
  EDITLENS_PAIR_PORT: '5491',
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
  // Claude's own level when none is sent: different from every level the test picks.
  FAKE_EFFORT_DEFAULT: 'xhigh',
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { ensureServer, stopServer, postJson } = require('../lib/client');
const config = require('../lib/config');
const taskuser = require('../lib/taskuser');
const { Driver } = require('../server/driver');
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
// A page of the project, so page control can be turned on for it.
function openPage(id) {
  const ctrl = new AbortController();
  fetch(`${config.baseUrl}/events?page=${id}&root=${encodeURIComponent(project)}`, { signal: ctrl.signal }).then(async (res) => {
    for await (const chunk of res.body) if (!chunk) break;
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return () => ctrl.abort();
}
const flags = () => {
  const f = path.join(state, 'flags');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test('S6: an Effort change Claude Code accepts is sent to page control; Auto clears the level EditLens set', async (t) => {
  await ensureServer();
  const close = openPage('e1');
  t.after(async () => {
    close();
    await postJson('/drive/end', {}).catch((err) => console.log('end:', err.message));
    await stopServer();
  });
  const report = (effort) => postJson('/settings/report', { from: 'mod', pid: process.pid, values: { effort } });
  const page = async () => (await (await fetch(`${config.baseUrl}/effort?cwd=${encodeURIComponent(project)}`, {
    headers: { 'x-editlens-token': fs.readFileSync(path.join(config.stateDir, `token-${PORT}`), 'utf8').trim() },
  })).json()).page;
  const at = (level) => until(async () => {
    const p = await page();
    return Boolean(p && p.level === level && p.used === level);
  });
  assert.ok((await report('Medium')).ok);
  await new Promise((r) => setTimeout(r, 200));
  const grant = await postJson('/drive/grant', { cwd: project, claudePath: exe }, { timeoutMs: 20000 });
  assert.ok(grant.ok, JSON.stringify(grant));
  assert.ok(await at('medium'), `page control starts at the setting: ${JSON.stringify(await page())}`);

  // The user picks Low in Settings; Claude Code accepts it and reports it.
  assert.ok((await report('Low')).ok);
  assert.ok(await at('low'), `the accepted setting is sent to page control: ${JSON.stringify(await page())}`);
  // A report with the same value changes nothing (a chip choice stays).
  const sent = flags().length;
  assert.ok((await report('Low')).ok);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(flags().length, sent, 'no change sent again');

  // A session Max from /editlens effort max, then the user changes the setting: the setting applies.
  assert.strictEqual((await postJson('/effort', { level: 'max', cwd: project })).page.level, 'max');
  assert.ok((await report('High')).ok);
  assert.ok(await at('high'), `the setting changed after the session Max: ${JSON.stringify(await page())}`);

  // Auto, and Claude Code's settings name no level: the level EditLens set is cleared (null), and
  // Claude's own level is the one shown.
  assert.ok((await report('Auto')).ok);
  assert.ok(await at('xhigh'), `Auto switches to Claude's own level: ${JSON.stringify(await page())}`);
  assert.deepStrictEqual(flags().pop(), { effortLevel: null });

  // /editlens effort auto with page control at a session Max: also back to Claude's own level.
  assert.strictEqual((await postJson('/effort', { level: 'max', cwd: project })).page.level, 'max');
  const auto = await postJson('/effort', { level: 'auto', cwd: project });
  assert.ok(auto.ok, JSON.stringify(auto));
  assert.ok(await at('xhigh'), `/editlens effort auto: ${JSON.stringify(await page())}`);
  assert.deepStrictEqual(flags().pop(), { effortLevel: null });
});

// The account's Claude Code has none of this user's plugin settings, so its hooks would use the
// defaults (both On). The task's Claude gets the checked values that are Off; never a key.
const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}
async function accountRun(values) {
  const acct = { name: 'editlens-none-5492', uid: 59999, gid: 59999, home: path.join(dir, 'acct'), shell: '/bin/sh',
    stateDir: path.join(dir, 'acct', 'state'), workspaces: path.join(dir, 'acct', 'ws'), claude: exe, plugin: path.join(__dirname, '..'), port: 5492 };
  fs.mkdirSync(acct.stateDir, { recursive: true });
  const d = new Driver({ root: true, emit: () => {}, log: () => {}, stateDir: path.join(dir, 'drv'), platform: 'linux', account: acct, settings: () => values });
  try {
    assert.ok((await d.start({ cwd: project, claudePaths: [exe] })).ok);
    assert.ok(await d.started(), 'the stand-in started');
    const options = globalThis.__fakeSdkOptions;
    // What the account's processes get (lib/taskuser.js spawner).
    return { env: taskuser.envFor(acct, options.env, acct.port), own: options.env };
  } finally {
    d.stop('test over');
  }
}
function hook(phase, input, env) {
  const r = spawnSync(process.execPath, [HOOK, phase], { input: JSON.stringify(input), encoding: 'utf8', env, timeout: 15000 });
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

test('N2: a task as the task account follows Subagent copies Off and Safety check Off', async () => {
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  const big = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  fs.writeFileSync(path.join(repo, 'big.txt'), big);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'start');
  const agent = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { prompt: 'Make prices bold', subagent_type: 'general-purpose' }, cwd: repo };
  const replace = { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(repo, 'big.txt'), content: 'new\n' }, cwd: repo, session_id: 's' };
  const asks = (out) => Boolean(out && out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision === 'ask');

  const on = await accountRun({ subagent_copies: true, safety_check: true });
  assert.strictEqual(hook('agent', agent, on.env).hookSpecificOutput.updatedInput.isolation, 'worktree', 'On: a copy');
  assert.ok(asks(hook('pending', replace, on.env)), 'On: the safety check asks');

  const off = await accountRun({ subagent_copies: false, safety_check: false });
  assert.strictEqual(hook('agent', agent, off.env), null, 'Subagent copies Off: no copy');
  assert.ok(!asks(hook('pending', replace, off.env)), 'Safety check Off: no question');
  // Only setting values: nothing else of this user's settings or keys is added.
  const added = Object.keys(off.own).filter((k) => on.own[k] === undefined);
  assert.deepStrictEqual(added.sort(), ['EDITLENS_GUARD', 'EDITLENS_SUBAGENT_COPIES']);
});
