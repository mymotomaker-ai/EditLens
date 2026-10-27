// A stand-in for the Agent SDK's query(), for test/signin.test.js, test/modes.test.js and the previews.
// Like Claude Code without a login, it answers "Not logged in · Please run /login" until
// FAKE_CLAUDE_STATE/signed-in exists; then it replies "Done: <message>".
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

// The real SDK takes a moment to load; tests that race two starts set this to see it.
const importMs = Number(process.env.FAKE_SDK_IMPORT_MS);
if (Number.isFinite(importMs) && importMs > 0) await new Promise((r) => setTimeout(r, Math.min(importMs, 5000)));

// FAKE_SDK_HOOKS=1: a write runs the plugin's edit hooks (PreToolUse, then PostToolUse) as Claude
// Code does, from the plugin the session loads: options.plugins, else the installed one
// (FAKE_SDK_INSTALLED_PLUGIN). No plugin: no hooks, noted in FAKE_CLAUDE_STATE/nohooks. The
// caption is Claude's sentence before the tool call, in a transcript like Claude Code's.
let toolN = 0;
// The number in a command ("hold 4000"), at most `max`: a number too big to be exact is `max`.
function count(digits, max) {
  const n = Number(digits);
  return Number.isSafeInteger(n) ? Math.min(n, max) : max;
}
function runHook(plugin, phase, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(plugin, 'hooks', 'live-hook.js'), phase], { env: { ...env, CLAUDE_PLUGIN_ROOT: plugin }, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(input));
  });
}
async function writeWithHooks(options, rel, body, agentId, sessionId) {
  const file = path.join(options.cwd, rel);
  const plugin = (options.plugins && options.plugins[0] && options.plugins[0].path) || process.env.FAKE_SDK_INSTALLED_PLUGIN || null;
  const env = { ...process.env, ...options.env };
  const id = `toolu_fake${++toolN}`;
  const state = process.env.FAKE_CLAUDE_STATE;
  const transcript = path.join(state, 'transcript.jsonl');
  const intent = `Writing ${rel}: ${body}`;
  fs.appendFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: intent }, { type: 'tool_use', id, name: 'Write', input: { file_path: file } }] } }) + '\n');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const input = { session_id: sessionId, transcript_path: transcript, cwd: options.cwd, tool_name: 'Write', tool_use_id: id,
    tool_input: { file_path: file, content: body + '\n' }, ...(agentId ? { agent_id: agentId, agent_type: 'general-purpose' } : {}) };
  if (!plugin) fs.appendFileSync(path.join(state, 'nohooks'), rel + '\n');
  if (plugin) await runHook(plugin, 'pending', { ...input, hook_event_name: 'PreToolUse' }, env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body + '\n');
  if (plugin) await runHook(plugin, 'step', { ...input, hook_event_name: 'PostToolUse', tool_response: before === null ? { type: 'create' } : { type: 'update', originalFile: before } }, env);
}

export function query({ prompt, options }) {
  const signedIn = () => fs.existsSync(path.join(process.env.FAKE_CLAUDE_STATE, 'signed-in'));
  const log = path.join(process.env.FAKE_CLAUDE_STATE, 'queries');
  fs.appendFileSync(log, JSON.stringify({ cwd: options.cwd, resume: options.resume || null, fork: options.forkSession === true, exe: options.pathToClaudeCodeExecutable || null, append: options.systemPrompt && options.systemPrompt.append || null, effort: options.effort || null }) + '\n');
  let closed = false;
  let mode = process.env.FAKE_START_MODE || 'default';
  // The test calls the session's hooks (PreToolUse) here, as Claude Code would.
  globalThis.__fakeSdkOptions = options;
  // FAKE_CLAUDE_STATE/known-sessions lists the conversations Claude Code has: continuing another
  // one fails as Claude Code does ("No conversation found", then the SDK's error).
  const known = path.join(process.env.FAKE_CLAUDE_STATE, 'known-sessions');
  const missing = options.resume && fs.existsSync(known) && !fs.readFileSync(known, 'utf8').split('\n').includes(options.resume);
  // With FAKE_SDK_HOOKS each session has its own id, as Claude Code's do.
  const sessionId = process.env.FAKE_SDK_HOOKS === '1' ? `${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}-2222-3333-4444-555555555555` : '11111111-2222-3333-4444-555555555555';
  async function* run() {
    if (missing) {
      const text = `No conversation found with session ID: ${options.resume}`;
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [text] };
      throw new Error(`Claude Code returned an error result: ${text}`);
    }
    // FAKE_SDK_PLUGINS=list: the init lists the plugins loaded, as Claude Code does; =blocked: a
    // policy kept them out (none loaded, an error for the one passed).
    const listed = process.env.FAKE_SDK_PLUGINS === 'list' ? { plugins: (options.plugins || []).map((p) => ({ name: 'editlens', path: p.path })) }
      : process.env.FAKE_SDK_PLUGINS === 'blocked' ? { plugins: [], plugin_errors: [{ plugin: 'inline[0]', type: 'generic-error', message: 'Plugin "editlens" is blocked by managed settings' }] } : {};
    yield { type: 'system', subtype: 'init', session_id: sessionId, model: process.env.FAKE_SDK_MODEL || 'fake-model', permissionMode: mode, ...listed };
    // FAKE_SDK_SESSION_HOOK=1: the plugin's SessionStart hook runs too, as Claude Code runs it.
    const plugin = (options.plugins && options.plugins[0] && options.plugins[0].path) || process.env.FAKE_SDK_INSTALLED_PLUGIN || null;
    if (process.env.FAKE_SDK_SESSION_HOOK === '1' && plugin) {
      const transcript = path.join(process.env.FAKE_CLAUDE_STATE, 'transcript.jsonl');
      await runHook(plugin, 'session', { session_id: sessionId, transcript_path: transcript, cwd: options.cwd, hook_event_name: 'SessionStart', source: options.resume ? 'resume' : 'startup' },
        { ...process.env, ...options.env, CLAUDE_PROJECT_DIR: options.cwd });
      fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, 'session-hooks'), options.cwd + '\n');
    }
    for await (const msg of prompt) {
      if (closed) return;
      // What the host sent, as written (tests check a task's text is never a typed, human prompt).
      fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, 'messages'), JSON.stringify({ text: msg.message.content, composed: msg.client_composed === true, human: Boolean(msg.origin && msg.origin.kind === 'human'), origin: msg.origin || null }) + '\n');
      // EditLens's own lines (who wrote a task's text, where to see the result) are not the command.
      const text = String(msg.message.content).split('\n').filter((l) => !/^\[(From the Claude on |EditLens: )/.test(l)).join('\n').trim();
      // "exit": the claude process ends by itself (the SDK's loop ends with no error);
      // "crash": it ends with an exit code, as the SDK reports it.
      if (text === 'exit') return;
      if (text === 'crash') throw new Error('Claude Code process exited with code 1');
      // "odd": an error result EditLens has no words for (raw text with an id).
      if (text === 'odd') throw new Error('Claude Code returned an error result: Unexpected state in session 99999999-8888-7777-6666-555555555555');
      // "spawn <agentId> <toolUseId>": a subagent starts, as the SDK reports it.
      const sp = /^spawn (\S+) (\S+)$/.exec(text);
      if (sp) {
        yield { type: 'system', subtype: 'task_started', task_id: sp[1], tool_use_id: sp[2], description: 'Fake subagent' };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'spawned' };
        continue;
      }
      if (!signedIn()) {
        yield { type: 'assistant', error: 'authentication_failed', message: { role: 'assistant', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } };
        yield { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' };
        continue;
      }
      // "busy <n>": the first n tries fail as when another Claude Code is renewing the same login.
      const busy = /^busy (\d+)$/.exec(text);
      if (busy) {
        const f = path.join(process.env.FAKE_CLAUDE_STATE, 'busy');
        const saved = fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0;
        const n = Number.isInteger(saved) && saved >= 0 ? saved : 0;
        fs.writeFileSync(f, String(n + 1));
        if (n < count(busy[1], 1000)) {
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, error: 'authentication_failed', result: 'Failed to refresh OAuth token: another Claude Code process is refreshing it' };
          continue;
        }
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Done after busy' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Done after busy' };
        continue;
      }
      // "ask <command>" (alone, or as the last line under a title): Claude wants to run a command and
      // asks first, as the SDK does.
      const ask = /(?:^|\n)ask (.+)$/.exec(text);
      if (ask && options.canUseTool) {
        const d = await options.canUseTool('Bash', { command: ask[1] }, { signal: new AbortController().signal, suggestions: [] });
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: d.behavior === 'allow' ? `Ran: ${ask[1]}` : 'Not allowed.' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: d.behavior };
        continue;
      }
      // "write <file> <text>": Claude edits a file in its folder. "long <n>": a reply of n characters.
      const wr = /^write (\S+) ([\s\S]*)$/.exec(text.split('\n').filter((l) => l.trim() && !l.startsWith('[EditLens')).pop());
      // Claude Code started through spawnClaudeCodeProcess (a task as a normal account): the
      // write happens in that process, as that account.
      if (wr && options.spawnClaudeCodeProcess) {
        const child = options.spawnClaudeCodeProcess({ command: options.pathToClaudeCodeExecutable, args: ['task-write', wr[1], wr[2], options.plugins && options.plugins[0] ? options.plugins[0].path : ''], cwd: options.cwd,
          env: { ...process.env, ...options.env }, signal: new AbortController().signal });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { err += d; });
        await new Promise((resolve) => child.on('close', resolve));
        fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, 'spawned'), JSON.stringify({ out: out.trim(), err: err.trim().slice(0, 500) }) + '\n');
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Wrote as ${out.trim()}` }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'wrote' };
        continue;
      }
      // "agent <id> write <file> <text>": a subagent's write (FAKE_SDK_HOOKS only).
      const aw = /^agent (\S+) write (\S+) ([\s\S]*)$/.exec(text.split('\n').filter((l) => l.trim() && !l.startsWith('[EditLens')).pop() || '');
      if (aw && process.env.FAKE_SDK_HOOKS === '1') {
        await writeWithHooks(options, aw[2], aw[3], aw[1], sessionId);
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `Wrote ${aw[2]}` }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'wrote' };
        continue;
      }
      if (wr && process.env.FAKE_SDK_HOOKS === '1') {
        await writeWithHooks(options, wr[1], wr[2], null, sessionId);
      } else if (wr) {
        fs.mkdirSync(path.dirname(path.join(options.cwd, wr[1])), { recursive: true });
        fs.writeFileSync(path.join(options.cwd, wr[1]), wr[2] + '\n');
      }
      // "steps": tool calls (one with a secret in its command, one by a subagent) and a result with costs.
      if (text === 'steps') {
        yield { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [
          { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'API_TOKEN=abc123 npm test --password hunter2' } },
          { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'src/a.js', old_string: 'one', new_string: 'two' } }] } };
        yield { type: 'assistant', parent_tool_use_id: 'tu0', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu3', name: 'Read', input: { file_path: 'src/b.js' } }] } };
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Stepped.' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Stepped.', num_turns: 3, duration_ms: 4200, total_cost_usd: 0.0123 };
        continue;
      }
      // A task's work in one message (test/taskcard-preview.js): "files a.html,b.html" lines write
      // those files, and "step <Tool> <what>" lines are tool calls it makes (its current step).
      const workLines = text.split('\n');
      for (const l of workLines) {
        const fl = /^files (\S+)$/.exec(l);
        if (!fl) continue;
        for (const rel of fl[1].split(',').filter(Boolean)) {
          const body = `<h1>${path.basename(rel)}</h1>\n<p>Written by the task.</p>`;
          if (process.env.FAKE_SDK_HOOKS === '1') await writeWithHooks(options, rel, body, null, sessionId);
          else {
            fs.mkdirSync(path.dirname(path.join(options.cwd, rel)), { recursive: true });
            fs.writeFileSync(path.join(options.cwd, rel), body + '\n');
          }
        }
      }
      const stepCalls = workLines.map((l) => /^step (\S+) (.+)$/.exec(l)).filter(Boolean);
      if (stepCalls.length) {
        yield { type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: stepCalls.map((m, i) => ({ type: 'tool_use', id: `tustep${i}`, name: m[1], input: m[1] === 'Bash' ? { command: m[2] } : { file_path: m[2] } })) } };
      }
      // "hold <ms>" (alone, or as the last line under a title): a turn that lasts that long.
      const hold = /(?:^|\n)hold (\d+)$/.exec(text);
      if (hold) {
        await new Promise((r) => setTimeout(r, count(hold[1], 60000)));
        if (closed) return;
        yield { type: 'result', subtype: 'success', is_error: false, result: 'held' };
        continue;
      }
      const long = /^long (\d+)$/.exec(text);
      if (long) {
        yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(count(long[1], 1e6)) }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'long' };
        continue;
      }
      fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, 'answered'), text + '\n');
      // "reply: <text>" (\n for a line break): its answer instead of "Done: <message>".
      const said = /(?:^|\n)reply: (.*)/.exec(text);
      const answer = said ? said[1].replace(/\\n/g, '\n') : `Done: ${text}`;
      yield { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: answer }] } };
      yield { type: 'result', subtype: 'success', is_error: false, result: answer };
    }
  }
  const it = run();
  it.supportedCommands = async () => {
    if (missing) throw new Error('Claude Code process exited with code 1');
    return [{ name: 'review', description: 'Review', argumentHint: '' }];
  };
  it.interrupt = async () => {};
  it.stopTask = async (id) => fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, 'stopped'), id + '\n');
  it.setPermissionMode = async (m) => {
    if (m === 'bypassPermissions' && !options.allowDangerouslySkipPermissions) throw new Error('Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions');
    mode = m;
    fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, 'modes'), m + '\n');
  };
  // Effort, as Claude Code applies it: FAKE_EFFORT_CAP is the organization's limit, FAKE_EFFORT_SETTINGS_CAP
  // a maxEffortLevel in the settings, FAKE_MODEL_EFFORT=none a model without effort, =nomax one
  // without Max (Max runs as High there).
  const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
  let effort = options.effort || null;
  const modelEffort = process.env.FAKE_MODEL_EFFORT || 'all';
  const applied = () => {
    if (modelEffort === 'none') return null;
    let l = effort || process.env.FAKE_EFFORT_DEFAULT || 'high';
    if (l === 'max' && modelEffort === 'nomax') l = 'high';
    for (const cap of [process.env.FAKE_EFFORT_CAP, process.env.FAKE_EFFORT_SETTINGS_CAP]) if (LEVELS.includes(cap) && LEVELS.indexOf(l) > LEVELS.indexOf(cap)) l = cap;
    return l;
  };
  it.applyFlagSettings = async (flags) => {
    if (flags && 'effortLevel' in flags) effort = flags.effortLevel;
    fs.appendFileSync(path.join(process.env.FAKE_CLAUDE_STATE, 'flags'), JSON.stringify(flags) + '\n');
  };
  it.getSettings = async () => ({ effective: process.env.FAKE_EFFORT_SETTINGS_CAP ? { maxEffortLevel: process.env.FAKE_EFFORT_SETTINGS_CAP } : {}, sources: [], applied: { model: 'fake-model', effort: applied() } });
  it.supportedModels = async () => [{ value: 'fake-model', displayName: 'Fake', description: 'A stand-in', supportsEffort: modelEffort !== 'none',
    supportedEffortLevels: modelEffort === 'none' ? [] : modelEffort === 'nomax' ? LEVELS.slice(0, 4) : LEVELS }];
  it.close = () => { closed = true; };
  return it;
}
