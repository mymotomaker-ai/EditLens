'use strict';
require('./isolate');
// A subagent Claude starts in the background (Agent with run_in_background, or Claude Code making
// it a background task): the Agent call's result only says it started. Its card stays working until
// the subagent really ends (its transcript ends, SubagentStop, or the task notification), then shows
// its real final text. Claude Code's start text (ids, output file) is never shown or summarized.
// The lines below have the shape Claude Code 2.1 writes; no real Claude runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-bg-agent-'));
process.env.EDITLENS_STATE_DIR = path.join(dir, 'state');
process.env.EDITLENS_PORT = '5470';
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');

const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');
const SESSION = 'bg-session';
const project = path.join(dir, 'site');
fs.mkdirSync(project);
const transcript = path.join(dir, `${SESSION}.jsonl`);
const subDir = path.join(dir, SESSION, 'subagents');
fs.mkdirSync(subDir, { recursive: true });
fs.writeFileSync(transcript, '');

const line = (file, o) => fs.appendFileSync(file, JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}
const chats = async () => (await getJson('/history')).filter((e) => e.type === 'chat' && e.sessionId === SESSION);
const summary = () => getJson(`/summary?session=${SESSION}&cwd=${encodeURIComponent(project)}`);
// Words only Claude Code's start result has.
const INTERNAL = /Async agent launched|internal metadata|internal ID|output_file|outputFile|\.output\b|do not mention/i;

function launch(toolUseId, agentId, description) {
  line(transcript, { type: 'assistant', message: { role: 'assistant', content: [
    { type: 'tool_use', id: toolUseId, name: 'Agent', input: { description, subagent_type: 'general-purpose', prompt: 'Read public/styles.css and suggest one change.' } },
  ] } });
  fs.writeFileSync(path.join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', description, toolUseId, requestShape: 'background' }));
  line(path.join(subDir, `agent-${agentId}.jsonl`), { type: 'assistant', message: { id: `msg-${agentId}-1`, model: 'claude-haiku-5-5', stop_reason: null,
    content: [{ type: 'tool_use', id: `read-${agentId}`, name: 'Read', input: { file_path: path.join(project, 'public', 'styles.css') } }], usage: { input_tokens: 10, output_tokens: 5 } } });
  const out = path.join(dir, 'tasks', `${agentId}.output`);
  line(transcript, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text:
    'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\n' +
    `agentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent.)\n` +
    'The agent is working in the background. You will be notified automatically when it completes.\n' +
    `output_file: ${out}\nDo NOT Read or tail this file via the shell tool.` }] }] },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: 'claude-haiku-5-5', prompt: 'Read public/styles.css', outputFile: out, canReadOutputFile: true } });
}

function notification(toolUseId, agentId, description, result) {
  line(transcript, { type: 'user', origin: { kind: 'task-notification' }, message: { role: 'user', content:
    `<task-notification>\n<task-id>${agentId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>${path.join(dir, 'tasks', agentId + '.output')}</output-file>\n` +
    `<status>completed</status>\n<summary>Agent "${description}" finished</summary>\n<note>A task-notification fires each time this agent stops.</note>\n` +
    `<result>${result}</result>\n<usage><subagent_tokens>26132</subagent_tokens><tool_uses>1</tool_uses><duration_ms>5175</duration_ms></usage>\n</task-notification>` } });
}

// The hook as Claude Code runs it, without this session's Claude Code settings.
function hook(phase, input, extra) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_CODE_|CLAUDE_PLUGIN_OPTION_|CLAUDE_PROJECT_DIR$|EDITLENS_(NO_START|DRIVEN|DISABLE|TEAM)$)/.test(k)));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, phase], { env: { ...env, CLAUDE_PROJECT_DIR: project, ...extra }, stdio: ['pipe', 'ignore', 'ignore'] });
    const kill = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(kill);
      resolve(code);
    });
    child.stdin.end(JSON.stringify(input));
  });
}

test.before(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: project, transcriptPath: transcript, ts: Date.now() });
});
test.after(async () => {
  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a background subagent stays working after it starts, then shows its real result', async () => {
  launch('toolu_bg1', 'abg1', 'Suggest CSS improvement');
  // The watcher has read the call and its start result, and looked for the subagent's file.
  assert.ok(await waitFor(async () => (await chats()).some((e) => e.role === 'agent-start' && e.toolUseId === 'toolu_bg1')), 'its card is shown');
  await sleep(1500);
  let list = await chats();
  assert.deepStrictEqual(list.filter((e) => e.role === 'agent-done'), [], 'not done at its launch');
  assert.doesNotMatch(JSON.stringify(list), INTERNAL);
  // Its steps are followed after the start result.
  assert.ok(await waitFor(async () => (await chats()).some((e) => e.role === 'agent-step' && e.agentId === 'abg1')), 'its step is shown');
  let s = await summary();
  assert.deepStrictEqual(s.agents.map((a) => [a.key, a.status]), [['toolu_bg1', 'working']]);
  assert.strictEqual(s.agentsRunning, 1);

  // Its transcript ends with its final reply: done, with that text.
  const final = 'Add hover and focus states to the nav links. This gives clear feedback.';
  line(path.join(subDir, 'agent-abg1.jsonl'), { type: 'assistant', message: { id: 'msg-abg1-2', model: 'claude-haiku-5-5', stop_reason: 'end_turn',
    content: [{ type: 'text', text: final }], usage: { input_tokens: 20, output_tokens: 40 } } });
  const done = await waitFor(async () => (await chats()).find((e) => e.role === 'agent-done' && e.toolUseId === 'toolu_bg1'));
  assert.ok(done, 'done when its transcript ends');
  assert.strictEqual(done.text, final);
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.agentId, 'abg1');
  s = await summary();
  assert.deepStrictEqual(s.agents.map((a) => [a.key, a.status]), [['toolu_bg1', 'done']]);

  // The task notification adds Claude Code's own counts.
  notification('toolu_bg1', 'abg1', 'Suggest CSS improvement', final);
  const counted = await waitFor(async () => (await chats()).find((e) => e.role === 'agent-done' && e.toolUseId === 'toolu_bg1' && e.tokens === 26132));
  assert.ok(counted, 'the notification gives its counts');
  assert.strictEqual(counted.toolCount, 1);
  assert.strictEqual(counted.durationMs, 5175);
  assert.strictEqual(counted.text, final);
  s = await summary();
  assert.strictEqual(s.agents[0].tokens, 26132);
  list = await chats();
  assert.doesNotMatch(JSON.stringify(list), INTERNAL);
  assert.doesNotMatch(JSON.stringify(s), INTERNAL);
  // Nothing else was shown as typed by the user.
  assert.deepStrictEqual(list.filter((e) => e.role === 'user'), []);
});

test('SubagentStop ends a background subagent, also with the team board off', async () => {
  launch('toolu_bg2', 'abg2', 'Find unused imports');
  assert.ok(await waitFor(async () => (await chats()).some((e) => e.role === 'agent-start' && e.toolUseId === 'toolu_bg2')), 'its card is shown');
  await sleep(1500);
  assert.ok(!(await chats()).some((e) => e.role === 'agent-done' && e.toolUseId === 'toolu_bg2'), 'not done at its launch');
  assert.ok(await waitFor(async () => (await chats()).some((e) => e.role === 'agent-step' && e.agentId === 'abg2')), 'its step is shown');
  const code = await hook('agent-stop', { session_id: SESSION, transcript_path: transcript, cwd: project, hook_event_name: 'SubagentStop',
    agent_id: 'abg2', agent_type: 'general-purpose', last_assistant_message: 'Found two unused imports.\n\nsrc/a.js line 3 and src/b.js line 9.' }, { EDITLENS_TEAM: 'off' });
  assert.strictEqual(code, 0);
  const done = await waitFor(async () => (await chats()).find((e) => e.role === 'agent-done' && e.toolUseId === 'toolu_bg2'));
  assert.ok(done, 'done at SubagentStop');
  assert.strictEqual(done.text, 'Found two unused imports.\n\nsrc/a.js line 3 and src/b.js line 9.');
  assert.strictEqual(done.status, 'completed');
  const s = await summary();
  assert.deepStrictEqual(s.agents.filter((a) => a.key === 'toolu_bg2').map((a) => a.status), ['done']);
  assert.doesNotMatch(JSON.stringify(await chats()), INTERNAL);
});

test('a subagent that is not in the background still ends with its tool result', async () => {
  line(transcript, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fg', name: 'Agent', input: { description: 'Check links', prompt: 'p' } }] } });
  line(transcript, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fg', content: [{ type: 'text', text: 'All links work.' }] }] },
    toolUseResult: { status: 'completed', agentId: 'afg', totalTokens: 900, totalToolUseCount: 2, totalDurationMs: 1200 } });
  const done = await waitFor(async () => (await chats()).find((e) => e.role === 'agent-done' && e.toolUseId === 'toolu_fg'));
  assert.ok(done);
  assert.strictEqual(done.text, 'All links work.');
  assert.strictEqual(done.tokens, 900);
});
