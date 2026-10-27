'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5402';
// D16 (the user's choice B): under page control, Claude's multiple-choice question (AskUserQuestion)
// is refused with a message that tells Claude to ask in its reply text. No permission card is shown,
// in any mode, for Claude or a subagent. A plan approval and every other tool still ask as before.
// Uses the stand-in SDK and claude (test/fixtures).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Driver } = require('../server/driver');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-askq-'));
  const state = path.join(dir, 'state');
  fs.mkdirSync(state);
  fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
  const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
  const vars = { EDITLENS_SDK_DIR: path.join(dir, 'sdk'), FAKE_CLAUDE_STATE: state };
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
  return { dir, d, events, exe: path.join(bin, 'claude'), restore };
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 30));
  }
  return false;
};
const options = () => globalThis.__fakeSdkOptions;
const QUESTION = { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red', description: 'Bold' }] }] };

test('D16: Claude\'s multiple-choice question is refused with a message to ask in the reply; no card', async () => {
  const t = setup();
  try {
    await t.d.start({ cwd: t.dir, claudePaths: [t.exe] });
    assert.ok(await until(() => t.d.status().mode === 'default'));
    const signal = new AbortController().signal;
    // Answered immediately; before D16 it waited for a card nobody can answer.
    const ctl = new AbortController();
    const out = await Promise.race([options().canUseTool('AskUserQuestion', QUESTION, { signal: ctl.signal, suggestions: [], toolUseID: 'tq1' }),
      new Promise((r) => setTimeout(() => r({ behavior: 'still waiting' }), 1000))]);
    ctl.abort();
    assert.strictEqual(out.behavior, 'deny');
    assert.strictEqual(out.message, "The person can't answer multiple-choice questions from the page yet. Ask this in your reply text instead, with the options as a short list.");
    assert.strictEqual(t.events.filter((e) => e.type === 'permission').length, 0, 'no permission card');
    assert.strictEqual(t.d.status().permissions.length, 0, 'nothing waits for an answer');

    // The session's hook refuses it before Claude Code asks, in every mode and for a subagent too.
    const hook = options().hooks.PreToolUse[0].hooks[0];
    for (const mode of ['default', 'bypassPermissions']) {
      if (mode === 'bypassPermissions') assert.ok((await t.d.setMode(mode, { confirm: true })).ok);
      for (const agent of [{}, { agent_id: 'a1' }]) {
        const h = await hook({ tool_name: 'AskUserQuestion', tool_use_id: 'tq2', tool_input: QUESTION, ...agent });
        assert.strictEqual(h.hookSpecificOutput && h.hookSpecificOutput.permissionDecision, 'deny', `${mode} ${JSON.stringify(agent)}`);
        assert.strictEqual(h.hookSpecificOutput.permissionDecisionReason, out.message);
      }
    }
    assert.ok((await t.d.setMode('default')).ok);

    // A plan approval still shows its card and waits for the answer.
    const plan = options().canUseTool('ExitPlanMode', { plan: '1. Add a button' }, { signal, suggestions: [] });
    assert.ok(await until(() => t.events.some((e) => e.type === 'permission')));
    const card = t.events.find((e) => e.type === 'permission');
    assert.strictEqual(card.title, 'Approve Claude\'s plan');
    assert.deepStrictEqual(t.d.answer(card.id, 'allow'), { ok: true });
    assert.strictEqual((await plan).behavior, 'allow');
    assert.deepStrictEqual(await hook({ tool_name: 'ExitPlanMode', tool_use_id: 'tp1', tool_input: { plan: 'x' } }), {});
    // So does a command.
    const cmd = options().canUseTool('Bash', { command: 'ls' }, { signal, suggestions: [] });
    assert.ok(await until(() => t.events.filter((e) => e.type === 'permission').length === 2));
    t.d.answer(t.events.filter((e) => e.type === 'permission').pop().id, 'deny');
    assert.strictEqual((await cmd).behavior, 'deny');
  } finally {
    t.restore();
  }
});
