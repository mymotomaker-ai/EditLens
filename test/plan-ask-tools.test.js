'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5302';
// Plan and Ask (a subagent's own mode in the panel, or Claude in Plan under page control) may use
// only the live-page tools that change nothing: lists, code view, highlights, reads of a task, the
// team board. Tools that write files, start, stop, merge, apply or copy are refused with a reason.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const modes = require('../lib/modes');
const { Driver } = require('../server/driver');

const TOOL = (name) => `mcp__plugin_editlens_live-page__${name}`;
const CHANGES = ['start_task_on_computer', 'message_computer_task', 'stop_computer_task', 'merge_computer_task',
  'undo_computer_task_merge', 'apply_computer_task', 'undo_computer_task_apply', 'copy_from_computer'];

// The tool names the MCP server offers, read from its TOOLS list.
function serverTools() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'live-page.js'), 'utf8');
  const start = src.indexOf('const TOOLS = [');
  assert.ok(start >= 0, 'the TOOLS list is in mcp/live-page.js');
  return [...src.slice(start).matchAll(/^ {4}name: '([a-z_]+)',$/gm)].map((m) => m[1]);
}

test('every live-page tool is either read-only or refused in Plan and Ask', () => {
  const names = serverTools();
  assert.ok(names.length >= 20 && names.includes('apply_computer_task'), names.join(' '));
  for (const name of names) {
    const changes = CHANGES.includes(name);
    for (const mode of ['plan', 'default']) {
      for (const session of ['default', 'auto', 'bypassPermissions']) {
        const d = modes.agentDecision(mode, session, TOOL(name), {}, '/proj');
        if (!changes) assert.strictEqual(d && d.decision, 'allow', `${name} in ${mode} under ${session}`);
        else {
          assert.strictEqual(d && d.decision, 'deny', `${name} in ${mode} under ${session}`);
          assert.match(d.reason, mode === 'plan' ? /Plan/ : /Ask/);
          assert.match(d.reason, new RegExp(`only the live-page tools that change nothing.*${name} changes something`));
        }
      }
    }
  }
  for (const name of names) assert.strictEqual(modes.liveToolChanges(TOOL(name)), CHANGES.includes(name), name);
  // The other modes keep what they did: Claude Code decides, or Bypass allows.
  assert.strictEqual(modes.agentDecision('acceptEdits', 'auto', TOOL('apply_computer_task'), {}, '/proj'), null);
  assert.strictEqual(modes.agentDecision('bypassPermissions', 'default', TOOL('copy_from_computer'), {}, '/proj'), null);
  assert.strictEqual(modes.liveToolChanges('mcp__other__apply_computer_task'), false, 'only this plugin\'s tools');
});

test('Claude itself in Plan under page control: tools that change something are refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-planask-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const d = new Driver({ root: false, emit: () => {}, log: () => {}, stateDir: dir, platform: 'linux' });
  const run = { mode: 'plan', cwd: dir, agentModes: new Map(), taskTool: new Map(), guards: new Map() };
  const out = await d.agentRule(run, { tool_name: TOOL('copy_from_computer'), tool_input: { path: '.' } });
  assert.strictEqual(out.hookSpecificOutput && out.hookSpecificOutput.permissionDecision, 'deny', JSON.stringify(out));
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Plan/);
  const read = await d.agentRule(run, { tool_name: TOOL('list_live_pages'), tool_input: {} });
  assert.strictEqual(read.hookSpecificOutput && read.hookSpecificOutput.permissionDecision, 'allow', 'reads continue (G4)');
  run.mode = 'default';
  assert.deepStrictEqual(await d.agentRule(run, { tool_name: TOOL('copy_from_computer'), tool_input: { path: '.' } }), {},
    'in Ask, Claude Code asks about it as before');
});

// Settings check G4 (0.24.45, signed in): in Plan the read-only live-page tools still asked, because
// Claude Code's own Plan rule applied; the board tools asked in Accept edits. They are allowed in
// every mode, for Claude and for subagents with or without a mode of their own.
test('G4: the live-page tools that change nothing are allowed in every mode', () => {
  for (const name of serverTools().filter((n) => !CHANGES.includes(n))) {
    for (const session of ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']) {
      assert.strictEqual((modes.sessionDecision(session, TOOL(name)) || {}).decision, 'allow', `${name}: Claude in ${session}`);
      for (const mode of ['default', 'acceptEdits', 'plan', 'bypassPermissions']) {
        assert.strictEqual((modes.agentDecision(mode, session, TOOL(name), {}, '/proj') || {}).decision, 'allow', `${name}: subagent in ${mode}`);
      }
    }
  }
  // Other tools are left to Claude Code, as before.
  assert.strictEqual(modes.sessionDecision('plan', 'Read'), null);
  assert.strictEqual(modes.sessionDecision('default', 'mcp__other__list_live_pages'), null);
});
