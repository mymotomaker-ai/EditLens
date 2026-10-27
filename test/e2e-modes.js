#!/usr/bin/env node
'use strict';
require('./isolate');
// Permission modes with real Claude (through the Agent SDK, like page control): Claude in Accept
// edits writes without asking; a subagent switched to Ask in the panel is asked about its write;
// Plan stops a subagent's write. Needs a signed-in claude and the SDK installed.
//
//   EDITLENS_E2E_REAL_CLAUDE=1 EDITLENS_SDK_DIR=<dir with the SDK installed> \
//     node test/e2e-modes.js [claude-path]
const { needRealClaude } = require('./isolate');
needRealClaude();
const fs = require('fs');
const os = require('os');
const path = require('path');
// Its own port and isolate's state folder: the EditLens server the user runs is never used or stopped.
process.env.EDITLENS_PORT = '5233';
const { Driver } = require('../server/driver');

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-e2e-modes-'));
const events = [];
let d;
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

async function turn(text, onAsk) {
  const from = events.length;
  d.send(text);
  const end = Date.now() + 240000;
  while (Date.now() < end) {
    for (const p of d.status().permissions || []) if (!p.seen) {
      p.seen = true;
      await onAsk(p);
    }
    if (events.slice(from).some((e) => e.type === 'drive' && e.phase === 'idle')) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  // Every Agent call Claude makes, from the SDK's messages.
  const agentCalls = [];
  const onMessage = (msg) => {
    const content = msg && msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
    for (const b of content) if (b && b.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task')) agentCalls.push(b.id);
  };
  d = new Driver({ emit: (e) => events.push(e), log: () => {}, stateDir: process.env.EDITLENS_STATE_DIR, platform: process.platform, onMessage });
  // Each subagent tool call and the rule's decision for it (driver.js agentRule, the PreToolUse hook).
  const decisions = [];
  const rule = d.agentRule.bind(d);
  d.agentRule = async (run, input) => {
    const out = await rule(run, input);
    const h = out && out.hookSpecificOutput;
    if (input && input.agent_id) decisions.push({ agent: input.agent_id, tool: input.tool_name, decision: h ? h.permissionDecision : null, reason: h ? h.permissionDecisionReason : null });
    return out;
  };
  const out = await d.start({ cwd, claudePaths: process.argv[2] ? [process.argv[2]] : [] });
  check('Claude starts', out.ok && !out.signIn, out);
  await until(() => d.status().phase === 'ready', 60000);
  check('Accept edits, picked before the first message', (await d.setMode('acceptEdits')).ok && d.status().mode === 'acceptEdits', d.status().mode);

  // 1. The subagent's first command asks (Claude asks about commands in Accept edits). We switch
  //    that subagent to Ask, then its write asks too, while Claude's own write does not.
  const asked = [];
  let switched = false;
  const ok1 = await turn('Use the Agent tool (general-purpose) and tell the subagent to: first run `node -e "1"` with Bash, then create ask.txt containing "a" with the Write tool. After it finishes, create main.txt containing "m" yourself with the Write tool. Reply "done".', async (p) => {
    asked.push({ tool: p.tool, agent: Boolean(p.agentId), agentMode: p.agentMode });
    if (p.agentKey && !switched) {
      switched = true;
      check('the question names the subagent\'s Agent call', /^toolu_/.test(p.agentKey), p.agentKey);
      d.setAgentMode(p.agentKey, 'default');
    }
    d.answer(p.id, 'allow');
  });
  check('turn 1 finished', ok1);
  check('Claude reports Accept edits', d.status().mode === 'acceptEdits', d.status().mode);
  check('the subagent in Ask was asked about its write', asked.some((a) => a.tool === 'Write' && a.agent && a.agentMode === 'default'), asked);
  check('Claude itself (Accept edits) was not asked about its write', !asked.some((a) => a.tool === 'Write' && !a.agent), asked);
  check('both files were written', fs.existsSync(path.join(cwd, 'ask.txt')) && fs.existsSync(path.join(cwd, 'main.txt')));

  // 2. Plan for the next subagent: set by its id as soon as it starts (before it writes).
  const run = d.run;
  const known = new Set(run.taskTool.keys());
  const callsBefore = agentCalls.length;
  const planned = []; // { id, ok }: each new subagent and whether Plan was set for it
  const watch = setInterval(() => {
    for (const id of run.taskTool.keys()) if (!known.has(id)) {
      known.add(id);
      planned.push({ id, ok: Boolean(d.setAgentMode(id, 'plan').ok) });
    }
  }, 20);
  const asked2 = [];
  const ok2 = await turn('Use the Agent tool (general-purpose) and tell the subagent to first list the files with the Glob tool, then create plan.txt containing "p" with the Write tool, and to report exactly what happened. Reply with what it reported.', async (p) => {
    asked2.push(p.tool);
    d.answer(p.id, 'allow');
  });
  clearInterval(watch);
  check('turn 2 finished', ok2);
  const calls = agentCalls.slice(callsBefore);
  check('Claude made an Agent call', calls.length > 0, agentCalls);
  const sub = planned.find((p) => calls.includes(run.taskTool.get(p.id)));
  check('its subagent started and was set to Plan', Boolean(sub && sub.ok && run.agentModes.get(sub.id) === 'plan'), { planned, modes: Object.fromEntries(run.agentModes) });
  const writes = decisions.filter((x) => sub && x.agent === sub.id && x.tool === 'Write');
  check('the subagent tried to write', writes.length > 0, decisions);
  check('its write was refused by Plan', writes.length > 0 && writes.every((x) => x.decision === 'deny' && /set to Plan/.test(x.reason || '')), writes);
  check('a subagent in Plan could not write', !fs.existsSync(path.join(cwd, 'plan.txt')), fs.readdirSync(cwd));
  d.stop('test over');
  fs.rmSync(cwd, { recursive: true, force: true });
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  if (d) d.stop('error');
  fs.rmSync(cwd, { recursive: true, force: true });
  process.exit(1);
});
