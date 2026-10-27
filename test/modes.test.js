'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4346';
// Permission modes in page control: Claude's mode switches from the panel (Bypass permissions only
// with a confirmation, never at start-up), and a subagent's own mode is applied by the session's
// PreToolUse hook. Uses the stand-in SDK and claude (test/fixtures).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Driver } = require('../server/driver');
const modes = require('../lib/modes');

function setup(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlenss-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
  const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
  const vars = { EDITLENS_SDK_DIR: path.join(dir, 'sdk'), FAKE_CLAUDE_STATE: state, ...env };
  const saved = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    process.env[k] = vars[k];
  }
  const events = [];
  const d = new Driver({ root: false, emit: (e) => events.push(e), log: () => {}, stateDir: dir, platform: 'linux' });
  const restore = () => {
    d.stop('test over');
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
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
const hook = (input) => globalThis.__fakeSdkOptions.hooks.PreToolUse[0].hooks[0](input);

test('a subagent of its own mode: what the hook answers', () => {
  const cwd = path.resolve('/proj');
  const d = (mode, session, tool, input) => {
    const r = modes.agentDecision(mode, session, tool, input || {}, cwd);
    return r ? r.decision : null;
  };
  assert.strictEqual(d(null, 'auto', 'Bash'), null, 'no own mode: Claude Code decides');
  assert.strictEqual(d('plan', 'default', 'Read'), null, 'reading is never stopped');
  assert.strictEqual(d('plan', 'bypassPermissions', 'mcp__plugin_editlens_live-page__post_note'), 'allow', 'the board is never stopped');
  assert.strictEqual(d('plan', 'acceptEdits', 'Edit', { file_path: 'a.js' }), 'deny');
  assert.strictEqual(d('plan', 'default', 'Bash'), 'deny');
  assert.strictEqual(d('acceptEdits', 'default', 'Write', { file_path: 'src/a.js' }), 'allow');
  assert.strictEqual(d('acceptEdits', 'default', 'Write', { file_path: '/etc/hosts' }), null, 'outside the project: Claude Code asks as usual');
  assert.strictEqual(d('acceptEdits', 'default', 'Write', { file_path: '../other/a.js' }), null);
  assert.strictEqual(d('acceptEdits', 'default', 'Bash'), null);
  assert.strictEqual(d('acceptEdits', 'auto', 'Bash'), 'ask', 'commands still ask when Claude runs in Auto');
  assert.strictEqual(d('default', 'acceptEdits', 'Edit', { file_path: 'a.js' }), 'ask', 'Ask still applies when Claude accepts edits');
  assert.strictEqual(d('default', 'bypassPermissions', 'Bash'), 'ask');
  assert.strictEqual(d('default', 'default', 'Bash'), null, 'Claude asks anyway');
  assert.strictEqual(d('bypassPermissions', 'default', 'Bash'), 'allow');
  assert.ok(modes.isMode('auto') && !modes.isMode('yolo') && !modes.isMode(undefined));
  assert.ok(!modes.CYCLE.includes('bypassPermissions'), 'Shift+Tab never selects Bypass');
});

test('a subagent set to Plan or Ask can still hand back its report and message Claude', () => {
  const d = (mode, session, tool, input) => {
    const r = modes.agentDecision(mode, session, tool, input || {}, path.resolve('/proj'));
    return r ? r.decision : null;
  };
  const report = { report: 'The plan.' };
  assert.strictEqual(d('plan', 'auto', 'SubagentHandback', report), null);
  assert.strictEqual(d('default', 'auto', 'SubagentHandback', report), null);
  assert.strictEqual(d('acceptEdits', 'auto', 'SubagentHandback', report), null);
  assert.strictEqual(d('plan', 'default', 'SendMessage', { to: 'main', message: 'The plan.' }), null);
  assert.strictEqual(d('default', 'auto', 'SendMessage', { to: 'main', message: 'Done.' }), null);
  // A message to another session can make that one change things, so Plan still refuses it.
  assert.strictEqual(d('plan', 'auto', 'SendMessage', { to: 'build', message: 'Edit a.js.' }), 'deny');
  assert.strictEqual(d('default', 'auto', 'SendMessage', { to: 'build', message: 'Edit a.js.' }), 'ask');
  assert.strictEqual(d('plan', 'auto', 'ListAgents'), null, 'listing agents changes nothing');
});

test('switches Claude\'s mode; Bypass only with a confirmation', async () => {
  const t = setup();
  try {
    const out = await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    assert.ok(out.ok, JSON.stringify(out));
    assert.ok(await until(() => t.d.status().mode === 'default'), 'the start-up mode is reported');
    assert.strictEqual(globalThis.__fakeSdkOptions.allowDangerouslySkipPermissions, true, 'Bypass can be switched on later');
    assert.deepStrictEqual(await t.d.setMode('acceptEdits'), { ok: true, mode: 'acceptEdits' });
    assert.strictEqual(t.d.status().mode, 'acceptEdits');
    assert.ok(t.events.some((e) => e.type === 'drive-mode' && e.mode === 'acceptEdits'));
    assert.ok((await t.d.setMode('yolo')).error);
    assert.ok((await t.d.setMode('bypassPermissions')).error, 'refused without a confirmation');
    assert.strictEqual(t.d.status().mode, 'acceptEdits');
    assert.ok((await t.d.setMode('bypassPermissions', { confirm: true })).ok);
    assert.strictEqual(t.d.status().mode, 'bypassPermissions');
    assert.deepStrictEqual(fs.readFileSync(path.join(t.state, 'modes'), 'utf8').trim().split('\n'), ['acceptEdits', 'bypassPermissions']);
  } finally {
    t.restore();
  }
});

test('never starts in Bypass permissions, even when the settings say so', async () => {
  const t = setup({ FAKE_START_MODE: 'bypassPermissions' });
  try {
    await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    // Back to the plugin's default mode, Auto.
    assert.ok(await until(() => t.d.status().mode === 'auto'), JSON.stringify(t.d.status()));
    assert.ok(await until(() => fs.existsSync(path.join(t.state, 'modes')) && fs.readFileSync(path.join(t.state, 'modes'), 'utf8').includes('auto')), 'Claude was switched to Auto');
    assert.ok(t.events.some((e) => e.type === 'drive-mode' && e.note && /Bypass/.test(e.note)), 'the panel says why');
  } finally {
    t.restore();
  }
});

test('a subagent gets its own mode, matched by its Agent call or its id', async () => {
  const t = setup();
  try {
    await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    assert.ok(await until(() => t.d.status().mode === 'default'));
    t.d.send('spawn a1234 toolu_ABC');
    assert.ok(await until(() => !t.d.status().working));
    await new Promise((r) => setTimeout(r, 50));
    const edit = { tool_name: 'Write', tool_input: { file_path: path.join(t.dir, 'x.txt') }, agent_id: 'a1234' };
    assert.deepStrictEqual(await hook(edit), {}, 'no own mode yet');
    assert.deepStrictEqual(await hook({ ...edit, agent_id: undefined }), {}, 'the main agent is left to Claude Code');
    assert.ok(t.d.setAgentMode('toolu_ABC', 'acceptEdits').ok, 'set from the panel card (the Agent call id)');
    assert.strictEqual((await hook(edit)).hookSpecificOutput.permissionDecision, 'allow');
    assert.ok(t.d.setAgentMode('a1234', 'plan').ok, 'or by the subagent id');
    assert.strictEqual((await hook(edit)).hookSpecificOutput.permissionDecision, 'deny');
    assert.ok(t.d.setAgentMode('a1234', 'bypassPermissions').error, 'Bypass needs a confirmation');
    assert.ok(t.d.setAgentMode('../x', 'plan').error);
    assert.ok(t.d.setAgentMode('a1234', 'auto').error, 'Auto is for Claude only');
    t.d.setAgentMode('a1234', null);
    t.d.setAgentMode('toolu_ABC', null);
    assert.deepStrictEqual(await hook(edit), {}, 'back to the same mode as Claude');
    assert.deepStrictEqual(t.d.status().agentModes, {});
    assert.deepStrictEqual(await t.d.stopAgent('toolu_ABC'), { ok: true }, 'Stop by the Agent call');
    assert.ok((await t.d.stopAgent('nope')).error, 'only subagents of this run');
    assert.strictEqual(fs.readFileSync(path.join(t.state, 'stopped'), 'utf8'), 'a1234\n');
  } finally {
    t.restore();
  }
});

test('the safety check asks in every mode, for Claude and subagents, and the card says why', async () => {
  const t = setup();
  try {
    await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    assert.ok(await until(() => t.d.status().mode === 'default'));
    const sp = globalThis.__fakeSdkOptions.systemPrompt;
    assert.strictEqual(sp && sp.preset, 'claude_code', 'keeps Claude Code\'s own system prompt');
    assert.match(sp.append, /already running/);
    assert.match(sp.append, /Never remove the EditLens integration/);
    const file = path.join(t.dir, 'App.jsx');
    fs.writeFileSync(file, Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
    const write = { tool_name: 'Write', tool_use_id: 'tu9', tool_input: { file_path: file, content: 'all new' } };
    await t.d.setMode('bypassPermissions', { confirm: true });
    let out = await hook(write);
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'ask', 'even in Bypass permissions');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /replaces most of App\.jsx/);
    t.d.send('spawn a77 toolu_S');
    assert.ok(await until(() => !t.d.status().working));
    assert.ok(t.d.setAgentMode('a77', 'bypassPermissions', { confirm: true }).ok);
    out = await hook({ ...write, agent_id: 'a77', tool_use_id: 'tu10' });
    assert.strictEqual(out.hookSpecificOutput.permissionDecision, 'ask', 'a subagent in Bypass is asked too');
    // The permission card for that call has the reason and has no "Always allow".
    const pending = t.d.ask(t.d.run, 'Write', write.tool_input, { toolUseID: 'tu9', suggestions: [{ type: 'addRules' }] });
    const card = t.events.filter((e) => e.type === 'permission').pop();
    assert.strictEqual(card.title, 'Replace most of a file');
    assert.match(card.warning, /replaces most of App\.jsx/);
    assert.strictEqual(card.canAlways, false);
    t.d.answer(card.id, 'deny');
    assert.strictEqual((await pending).behavior, 'deny');
    assert.deepStrictEqual(await hook({ ...write, tool_input: { file_path: file, content: fs.readFileSync(file, 'utf8') + '\nmore' } }), {}, 'a normal write is not changed (Bypass allows it)');
  } finally {
    t.restore();
  }
});

test('as root, Claude starts without the Bypass option and Bypass is refused with plain words', async () => {
  const { Driver } = require('../server/driver');
  const d = new Driver({ root: true, emit: () => {}, log: () => {}, stateDir: os.tmpdir(), platform: 'linux' });
  d.run = { query: { setPermissionMode: async () => {} }, agentModes: new Map(), mode: 'default' };
  const r = await d.setMode('bypassPermissions', { confirm: true });
  assert.match(r.error, /root/);
  assert.match(d.setAgentMode('agent-1', 'bypassPermissions', { confirm: true }).error, /root/);
});
