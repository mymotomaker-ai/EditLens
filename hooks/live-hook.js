#!/usr/bin/env node
'use strict';
// Single entry point for every EditLens hook: live-hook.js <phase> (see PHASES at the end).
// session: start the live server. prompt: show the task and deliver page messages. pending/step:
// an edit before and after (the diff for the page). idle: wait for a page message at Stop.
// board/agent-start/agent-stop: the team board. agent: a subagent that edits gets a git worktree.
// A hook must never block Claude: every failure is logged and the script exits 0.

const fs = require('fs');
const path = require('path');
const { sliceSafe, stripBom } = require('../lib/textcut');
const { writeAtomic } = require('../lib/atomic');
const config = require('../lib/config');
const { PRODUCT_NAME } = require('../lib/name');
const { ensureServer, postEvent, postJson, getJson } = require('../lib/client');
const { classify, changedRoutes } = require('../lib/classify');
const { diffText, normalizeStructuredPatch, clampHunks, countStats } = require('../lib/diff');
const { buildHints } = require('../lib/hints');
const { listCommands } = require('../lib/commands');
const { formatMessages } = require('../lib/messages');
const { callKey, labelFor } = require('../server/board');
const guard = require('../lib/guard');
const { trimLog } = require('../lib/logtrim');
const settings = require('../lib/settings');
const { detect, findIntegrations, appsIn, devServerOf, runCommand } = require('../lib/connect');
const worktree = require('../lib/worktree');
const { selfCall, editlensPorts, startsNew, NEW_REASON } = require('../lib/selfguard');
const { saveAsked, askedNew } = require('../lib/starter');
const { readSmall } = require('../lib/readsmall');
const { versionWarning } = require('../lib/versions');
const { secretPath } = require('../lib/sendproject');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const INTENT_MAX = 1000;
const RESULT_MAX = 4000; // a subagent's last reply, as the page shows a result
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

function logLine(msg) {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true });
    trimLog(config.hookLogFile);
    fs.appendFileSync(config.hookLogFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (err) {
    // Logging may fail; report it on stderr (shown only in Claude Code's debug output).
    process.stderr.write(`EditLens: cannot write log: ${err.message}\n`);
  }
}

// Hook input: an edit has the file's text up to three times (content, originalFile, the patch),
// and the hook keeps at most 2 MB of it. Claude Code writes it immediately, so a slow input is a fault.
const INPUT_MAX = 32 * 1024 * 1024;
const INPUT_MS = 5000;

function readStdin(stream = process.stdin, { maxBytes = INPUT_MAX, timeoutMs = INPUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const fail = (err) => {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(Object.assign(new Error(`hook input not complete after ${timeoutMs} ms`), { code: 'ETIMEDOUT' })), timeoutMs);
    stream.on('data', (c) => {
      bytes += c.length;
      if (bytes > maxBytes) fail(Object.assign(new Error(`hook input over ${maxBytes} bytes`), { code: 'E2BIG' }));
      else chunks.push(c);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EISDIR' || err.code === 'EACCES') return null;
    throw err;
  }
}

function truncate(text, max) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > max ? sliceSafe(clean, max - 1) + '…' : clean;
}

// Claude's text before tool call `toolUseId` in the same turn, from the transcript. Null if the
// call isn't in the transcript yet (never guesses from older text).
function latestIntent(transcriptPath, toolUseId) {
  if (!transcriptPath || !toolUseId) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, 'r');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return null;
    throw err;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    let anchored = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line.startsWith('{')) continue; // also skips the first, possibly cut, line
      let entry;
      try {
        entry = JSON.parse(line);
      } catch (err) {
        if (err instanceof SyntaxError) continue;
        throw err;
      }
      const content = entry.message?.content;
      if (!anchored) {
        if (entry.type !== 'assistant' || !Array.isArray(content)) continue;
        const at = content.findIndex((b) => b.type === 'tool_use' && b.id === toolUseId);
        if (at < 0) continue;
        anchored = true;
        const text = lastText(content.slice(0, at));
        if (text) return text;
        continue;
      }
      // A real user prompt ends the search: older text belongs to an earlier task.
      if (entry.type === 'user' && typeof content === 'string') return null;
      if (entry.type === 'assistant' && Array.isArray(content)) {
        const text = lastText(content);
        if (text) return text;
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function lastText(blocks) {
  const texts = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim());
  if (!texts.length) return null;
  const text = texts[texts.length - 1].text.trim();
  // Last sentence or line: usually "Now I'll make the header sticky."
  const parts = text.split(/\n+|(?<=[.!?])\s+/).filter((p) => p.trim());
  return truncate(parts[parts.length - 1] || text, INTENT_MAX);
}

const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'];
function effortOf(input) {
  const level = input.effort && typeof input.effort === 'object' ? input.effort.level : process.env.CLAUDE_EFFORT;
  return EFFORT_LEVELS.includes(level) ? level : null;
}

function base(input, type) {
  const cwd = input.cwd || process.cwd();
  return {
    type,
    ts: Date.now(),
    sessionId: input.session_id || null,
    toolUseId: input.tool_use_id || null,
    // Set when a subagent made the call (absent for the main agent), so the code view can follow it.
    agentId: input.agent_id || null,
    agentType: input.agent_type || null,
    // Claude Code's permission mode (Shift+Tab), shown read-only in the panel.
    permissionMode: typeof input.permission_mode === 'string' ? input.permission_mode : null,
    // Claude Code's effort level (/effort), shown read-only on the page in Manual. Only in tool-use
    // hooks, and absent for a model without effort; CLAUDE_EFFORT has the same value.
    effort: effortOf(input),
    cwd,
    project: path.basename(cwd),
    // The server follows this transcript to show Claude's replies live; it is not sent to pages.
    transcriptPath: input.transcript_path || null,
    // The claude program this session runs, for page control (not sent to pages).
    execPath: process.env.CLAUDE_CODE_EXECPATH || null,
    // The installed plugin's version: an older server says so on its pages.
    pluginVersion: config.version,
    // The auto-compact window from this session's environment (it takes precedence over settings files).
    compactEnv: process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW || null,
  };
}

function filePathOf(input) {
  const ti = input.tool_input || {};
  return ti.file_path || ti.notebook_path || null;
}

function relative(cwd, file) {
  const rel = path.relative(cwd, file);
  return rel && !rel.startsWith('..') ? rel : file;
}

// A file in a subagent's own copy (<project>/.claude/worktrees/<name>/...): the event belongs to
// the project, names the file by its project path, and says which copy it is in.
// -> the file's path relative to the project (or its copy).
function placeFile(ev, file) {
  const c = worktree.copyOf(file);
  if (!c) return relative(ev.cwd, file);
  ev.cwd = c.root;
  ev.project = path.basename(c.root);
  ev.copy = c.name;
  ev.realFile = path.join(c.root, c.rel);
  return relative(c.dir, file);
}

const OCCURRENCES_MAX = 1000; // replace_all places at most this many (the page shows 400 lines anyway)

// Line numbers (1-based) where `needle` starts in `haystack`: the first only, or each one that does
// not overlap the one before (as replace_all replaces them). [] when it is not there.
function locateAll(haystack, needle, all) {
  if (typeof haystack !== 'string' || typeof needle !== 'string' || !needle) return [];
  const lines = [];
  let line = 1;
  let from = 0;
  for (let idx = haystack.indexOf(needle); idx >= 0 && lines.length < OCCURRENCES_MAX; idx = haystack.indexOf(needle, idx + needle.length)) {
    for (let i = haystack.indexOf('\n', from); i >= 0 && i < idx; i = haystack.indexOf('\n', i + 1)) line++;
    from = idx;
    lines.push(line);
    if (!all) break;
  }
  return lines;
}

function newlines(text) {
  return (String(text || '').match(/\n/g) || []).length;
}

// Moves a snippet diff (old_string -> new_string) to each place it was made in the file: exact
// places of old_string in the file before (Edit's originalFile) when known, else places of
// new_string in the file now. all: replace_all, every place, not just the first.
function snippetHunks(oldStr, newStr, fileText, { all = false, original = null } = {}) {
  const hunks = diffText(oldStr || '', newStr || '');
  // Lines each earlier replacement added (or removed, when negative).
  const grow = newlines(newStr) - newlines(oldStr);
  const shifted = (oldOffset, newOffset) => hunks.map((h) => ({ ...h, oldStart: h.oldStart + oldOffset, newStart: h.newStart + newOffset }));
  const before = typeof original === 'string' ? locateAll(original, oldStr, all) : [];
  if (before.length) return before.flatMap((at, k) => shifted(at - 1, at - 1 + k * grow));
  const now = locateAll(fileText, newStr, all);
  if (now.length) return now.flatMap((at, k) => shifted(at - 1 - k * grow, at - 1));
  return shifted(0, 0);
}

function changeHunks(input, fileText) {
  const ti = input.tool_input || {};
  const tr = input.tool_response && typeof input.tool_response === 'object' ? input.tool_response : {};
  const fromClaude = normalizeStructuredPatch(tr.structuredPatch);
  if (fromClaude) return fromClaude;
  switch (input.tool_name) {
    case 'Edit':
      return snippetHunks(ti.old_string, ti.new_string, fileText, { all: ti.replace_all === true, original: typeof tr.originalFile === 'string' ? stripBom(tr.originalFile) : null });
    case 'MultiEdit':
      // Each edit applies to the result of the one before, so only the current file can place them.
      return (Array.isArray(ti.edits) ? ti.edits : []).flatMap((e) => (e && typeof e === 'object' ? snippetHunks(e.old_string, e.new_string, fileText, { all: e.replace_all === true }) : []));
    case 'Write': {
      // Byte order marks removed on both sides, so a moved one is not a change at line 1.
      const original = typeof tr.originalFile === 'string' ? stripBom(tr.originalFile) : '';
      return diffText(original, stripBom(typeof ti.content === 'string' ? ti.content : fileText || ''));
    }
    case 'NotebookEdit':
      return diffText('', typeof ti.new_source === 'string' ? ti.new_source : '');
    default:
      return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// The caption used when the transcript text is missing, built from the change itself. A changed line
// counts once (+1 −1 is 1 line).
function describe(tool, hints, stats, created) {
  const target = hints.selectors[0] || (hints.ids[0] && '#' + hints.ids[0]) || (hints.texts[0] && `"${truncate(hints.texts[0], 40)}"`) ||
    (hints.classes[0] && '.' + hints.classes[0]);
  const verb = created ? 'Created the file' : stats.removed === 0 ? 'Added' : stats.added === 0 ? 'Removed' : 'Changed';
  if (created) return verb;
  // Never "0 lines": an edit that changed no line says so.
  if (!(stats.added + stats.removed)) return target ? `Edited ${target}` : 'Saved with no line changes';
  const n = verb === 'Added' ? stats.added : verb === 'Removed' ? stats.removed : Math.max(stats.added, stats.removed);
  return target ? `${verb} ${target}` : `${verb} ${n} line${n === 1 ? '' : 's'}`;
}

async function onChange(input) {
  if (!EDIT_TOOLS.has(input.tool_name)) return;
  const file = filePathOf(input);
  if (!file) return;
  const ev = base(input, 'change');
  if (secretPath(ev.cwd, file)) return onSecretChange(input, ev, file);
  // Above the largest text kept, the edit shows without its text (the page says it is too big).
  const read = readSmall(file, TEXT_BACKUP_MAX);
  const fileText = read === undefined ? null : stripBom(read);
  const hunks = changeHunks(input, fileText);
  const stats = countStats(hunks);
  const ext = path.extname(file).toLowerCase();
  const hints = buildHints({ ext, hunks, fileText });
  const relFile = placeFile(ev, file);
  const kind = classify(relFile, fileText);
  const routes = kind === 'backend' ? changedRoutes(relFile, fileText, hunks) : [];
  const clamped = clampHunks(hunks);
  const tr = input.tool_response || {};
  const created = input.tool_name === 'Write' && (tr.type === 'create' || (!tr.originalFile && stats.removed === 0));
  // The transcript is sometimes written just after the edit: retry briefly, then describe the change.
  let intent = latestIntent(input.transcript_path, input.tool_use_id);
  for (let i = 0; !intent && i < 6 && input.transcript_path; i++) {
    await sleep(150);
    intent = latestIntent(input.transcript_path, input.tool_use_id);
  }
  await postEvent({
    ...ev,
    tool: input.tool_name,
    file,
    relFile,
    ext,
    kind,
    routes,
    created: Boolean(created),
    intent: intent || describe(input.tool_name, hints, stats, created),
    autoIntent: !intent,
    hunks: clamped.hunks,
    truncated: clamped.truncated,
    stats,
    hints,
    // Full text for the live code view, kept out of the event stream (the text before the edit is
    // from PreToolUse, or Write). Limited as the server keeps them (code view 512 KB, Restore 2 MB):
    // a larger text would make the edit too large to send, and its card would never appear.
    after: fitText(fileText, TEXT_VIEW_MAX),
    before: typeof tr.originalFile === 'string' ? fitText(tr.originalFile, TEXT_BACKUP_MAX) : created ? '' : undefined,
  });
}

// A key or credentials file (lib/sendproject.js secretPath): the page gets "file changed" and no
// text. The file is not read and no line of the edit is sent.
async function onSecretChange(input, ev, file) {
  const relFile = placeFile(ev, file);
  const tr = input.tool_response || {};
  const created = input.tool_name === 'Write' && (tr.type === 'create' || !tr.originalFile);
  const intent = latestIntent(input.transcript_path, input.tool_use_id);
  await postEvent({
    ...ev,
    tool: input.tool_name,
    file,
    relFile,
    ext: path.extname(file).toLowerCase(),
    kind: classify(relFile, null),
    routes: [],
    created: Boolean(created),
    intent: intent || (created ? 'Created the file' : 'Changed the file'),
    autoIntent: !intent,
    secret: true,
    hunks: [],
    truncated: false,
    stats: null,
    hints: { selectors: [], ids: [], classes: [], texts: [] },
  });
}

// The largest file texts the server keeps (server/snapshots.js, server/backups.js).
const TEXT_VIEW_MAX = 512 * 1024;
const TEXT_BACKUP_MAX = 2 * 1024 * 1024;
function fitText(text, max) {
  return typeof text === 'string' && Buffer.byteLength(text) <= max ? text : undefined;
}

async function onPending(input) {
  if (!EDIT_TOOLS.has(input.tool_name)) return;
  const file = filePathOf(input);
  if (!file) return;
  // A write that replaces most of a file, or removes EditLens from the app, asks first, whatever
  // the permission mode.
  const risk = guard.check(input.tool_name, input.tool_input || {}, input.cwd);
  if (risk) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: risk.reason } }));
  const ev = base(input, 'pending');
  const intent = latestIntent(input.transcript_path, input.tool_use_id);
  if (secretPath(ev.cwd, file)) {
    // A key or credentials file: not read, and no text sent.
    const relFile = placeFile(ev, file);
    await postEvent({ ...ev, tool: input.tool_name, file, relFile, intent, secret: true, existed: fs.existsSync(file) });
    return;
  }
  // The file as it is before the edit, so the page can replay the change line by line.
  const read = readSmall(file, TEXT_VIEW_MAX);
  const before = typeof read === 'string' ? stripBom(read) : read;
  const relFile = placeFile(ev, file);
  await postEvent({ ...ev, tool: input.tool_name, file, relFile, intent, before: before === null ? '' : fitText(before, TEXT_VIEW_MAX), existed: before !== null });
}

// A git commit that adds EditLens to the project asks first (lib/guard.js).
async function onBash(input) {
  const self = ['Bash', 'PowerShell', 'WebFetch'].includes(input.tool_name)
    && selfCall(input.tool_name, input.tool_input || {}, { stateDir: config.stateDir, ports: editlensPorts(config) });
  // Claude's own /editlens new: only right after the user typed it.
  const denied = self || (startsNew(input.tool_name, input.tool_input) && !askedNew(config.stateDir, input.session_id) ? NEW_REASON : null);
  if (denied) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: denied } }));
    return;
  }
  if (input.tool_name !== 'Bash') return;
  const risk = guard.check('Bash', input.tool_input || {}, input.cwd);
  if (risk) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: risk.reason } }));
}

// "Subagents work in their own copy" (on by default): in a git project, an Agent call for a
// subagent that can edit gets Claude Code's worktree isolation, unless the call already set one.
// EDITLENS_SUBAGENT_COPIES=off: the user's setting is Off (a task as the task account, server/driver.js).
// The note covers both cases: a Claude Code that ignores updatedInput runs it in the project folder.
const COPY_NOTE = 'EditLens asked for this subagent to work in its own copy of the project (a git worktree), so it cannot ' +
  'overwrite edits that you or other agents make at the same time. If its result names a copy and its branch, add its changes ' +
  'to the project when it is done (for example git merge, or copy the changed files) or tell the user they can click Merge in ' +
  'the EditLens panel, then remove the copy. If its result names no copy, it worked in the project folder itself.';

async function onAgentCall(input) {
  if (input.tool_name !== 'Agent' && input.tool_name !== 'Task') return;
  if (!settings.fromEnv().values.subagent_copies || settings.check('subagent_copies', process.env.EDITLENS_SUBAGENT_COPIES) === false) return;
  const ti = input.tool_input || {};
  if (!worktree.wantsCopy(ti)) return;
  // The hook has 5 s, git gets 2. If git is too slow (network drive, locked index): no copy, logged.
  const check = worktree.copyCheck(input.cwd || process.cwd(), { timeoutMs: 2000 });
  if (!check.ok) {
    if (check.why !== 'not git' && check.why !== 'inside a copy') logLine(`subagent copy skipped: ${check.why}`);
    return;
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, isolation: 'worktree' }, additionalContext: COPY_NOTE } }));
}

// Messages typed on the page.

async function takeMessages(input, via) {
  // The task account may only report edits (the server refuses everything else): no page messages.
  if (process.env.EDITLENS_TASK_ACCOUNT === '1') return [];
  const cwd = encodeURIComponent(input.cwd || process.cwd());
  const res = await getJson(`/messages/take?cwd=${cwd}&via=${via}`);
  return Array.isArray(res.messages) ? res.messages : [];
}

function addContext(eventName, text) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext: text } }));
}

async function onPrompt(input) {
  // /editlens new typed by the user: the Bash guard allows the skill's start.js new (onBash).
  try {
    saveAsked(config.stateDir, input.session_id, input.prompt);
  } catch (err) {
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC'].includes(err.code)) throw err;
    logLine(`could not save the /editlens new prompt: ${err.code}`);
  }
  // Not only at session start: a server older than this plugin (started by a session that still
  // runs an older copy) is replaced as soon as nothing runs in it.
  if (process.env.EDITLENS_NO_START !== '1') {
    try {
      const r = await ensureServer();
      if (r.replaced) logLine(`replaced a server from plugin version ${r.replaced} with ${r.version || config.version}`);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      logLine(`could not check the server's version: ${err.message}`);
    }
  }
  await postEvent({ ...base(input, 'prompt'), text: truncate(input.prompt || '', 2000), canListen: !remoteSession(), ...settingsReport() });
  const list = await takeMessages(input, 'prompt');
  if (list.length) addContext('UserPromptSubmit', formatMessages(list));
}

// Page messages are not added mid-turn: Claude correctly treats text inside tool output as
// untrusted. They are sent when the turn ends (Stop) or with the next prompt.
async function onStep(input) {
  if (EDIT_TOOLS.has(input.tool_name)) await onChange(input);
}

// Sessions run outside a local terminal (Remote Control, the desktop or web app, the SDK) treat a
// turn that stays open for minutes as not responding, so they never wait for page messages.
function remoteSession() {
  const env = process.env;
  if (env.EDITLENS_WAIT_ANYWHERE === '1') return null;
  const remoteKey = Object.keys(env).find((k) => k.startsWith('CLAUDE_CODE_REMOTE') && env[k]);
  if (remoteKey) return remoteKey;
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT || '');
  if (entry && entry !== 'cli') return `CLAUDE_CODE_ENTRYPOINT=${entry}`;
  return null;
}

// Claude finished its turn. If a page is listening, wait for the user to type something there
// and send it to Claude by blocking the stop; otherwise let the turn end.
async function onIdle(input) {
  const remote = remoteSession();
  await postEvent({ ...base(input, 'idle'), canListen: !remote });
  let list = await takeMessages(input, 'stop');
  if (remote && !list.length) logLine(`not listening: session is not a local terminal (${remote})`);
  const deadline = Date.now() + (remote ? 0 : config.listenMinutes * 60000);
  const cwd = encodeURIComponent(input.cwd || process.cwd());
  let listened = false;
  try {
    while (!list.length && Date.now() < deadline) {
      const timeout = Math.min(25000, deadline - Date.now());
      if (timeout < 1000) break;
      listened = true;
      const res = await getJson(`/messages/wait?cwd=${cwd}&timeout=${timeout}&until=${deadline}`, timeout + 5000);
      list = Array.isArray(res.messages) ? res.messages : [];
      if (!list.length && !res.listening) break;
    }
  } finally {
    if (listened && !list.length) await getJson('/listen-end', 1500).catch((err) => logLine(`listen-end failed: ${err.message}`));
  }
  if (list.length) process.stdout.write(JSON.stringify({ decision: 'block', reason: formatMessages(list) }));
}

// Copies the status line script to a path that is kept across plugin updates. A per-process temp
// file and a rename, so sessions running at the same time don't conflict.
function writeShared(file, text, write = writeAtomic) {
  try {
    write(file, text);
  } catch (err) {
    // Windows: the other session's rename happened first. Fine only when its copy is the same.
    if (!err || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
    if (readFileOrNull(file) !== text) throw err;
  }
}

function installStatusLine() {
  const source = path.join(__dirname, '..', 'bin', 'statusline.js');
  const target = config.statusLineFile;
  const text = fs.readFileSync(source, 'utf8');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // The Port setting, for the status line (it runs without the plugin's settings).
  const portFile = path.join(path.dirname(target), 'port');
  if (readFileOrNull(portFile) !== String(config.port)) writeShared(portFile, String(config.port));
  if (readFileOrNull(target) === text) return;
  writeShared(target, text);
}

// A short launcher at a path kept across updates, for the editlens skill (desktop app): Claude
// shows the command it runs, and this keeps the versioned plugin folder out of it.
function launcherText() {
  const start = path.join(__dirname, '..', 'bin', 'start.js');
  return `#!/usr/bin/env node\n'use strict';\n// /editlens, from the EditLens plugin that wrote this file (at each session start).\nrequire(${JSON.stringify(start)});\n`;
}

function installLauncher() {
  const target = path.join(config.stateDir, 'start.js');
  const text = launcherText();
  fs.mkdirSync(config.stateDir, { recursive: true });
  if (readFileOrNull(target) !== text) writeShared(target, text);
}

// An update while page control or a paired computer's task runs: the old server keeps running it.
// /editlens manual ends page control (/editlens stop only disconnects the page).
function updateText(version, running, waiting) {
  const control = waiting === 'page control';
  return `✦ ${PRODUCT_NAME} ${version} is installed, but an older one (${running}) is still running · it updates when ${control ? 'page control stops, and starts again' : 'the running task finishes'}\n  To update now: /editlens restart${control ? ' (page control starts again)' : ' (the running task stops)'}`;
}
// An older server that didn't stop when asked (why: lib/client.js stopServer's issue).
function staleText(version, running, why) {
  const what = why === 'refused' ? "didn't accept the request to stop" : why === 'no answer' ? "didn't respond to the request to stop" : "didn't stop when asked";
  return `✦ ${PRODUCT_NAME} ${version} is installed, but an older one (${running}) is still running: it ${what}\n  To update now: /editlens restart`;
}

// hooks.json gives SessionStart 10 s. The whole phase has one deadline, and each step gets only the
// time left, so the answer is always written (the last second is for that).
const SESSION_MS = 9000;

// A clock for one phase: left() is the time left in ms (0 when it is over).
function phaseClock(ms) {
  const end = Date.now() + ms;
  return { left: () => Math.max(0, end - Date.now()) };
}

// Runs one step of a phase: -> its result, or `late` when the phase's time runs out first. A step
// that fails is logged and gives `late` too, so the next steps still run.
async function inTime(clock, what, run, late) {
  const ms = clock.left();
  if (ms <= 0) {
    logLine(`${what}: skipped, no time left`);
    return late;
  }
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      logLine(`${what}: not done after ${ms} ms`);
      resolve(late);
    }, ms);
  });
  try {
    return await Promise.race([run(), timeout]);
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    logLine(`${what} failed: ${err.message}`);
    return late;
  } finally {
    clearTimeout(timer);
  }
}

async function onSession(input, clock = phaseClock(SESSION_MS)) {
  try {
    installStatusLine();
    installLauncher();
  } catch (err) {
    logLine(`cannot copy the status line script or the /editlens launcher: ${err.message}`);
  }
  // Late: the same note as a server that is too busy to answer.
  const { started, replaced, stale, waiting, running, otherUser, busy, why } = await inTime(clock, 'server check', () => ensureServer(), { started: false, busy: true });
  if (otherUser !== undefined) {
    const note = `${PRODUCT_NAME}: port ${config.port} is used by another user's ${PRODUCT_NAME} on this computer. Set EDITLENS_PORT (or the Port setting in /editlens settings) to a free port, then restart Claude Code.`;
    logLine(note);
    // Plain text with the symbols (a SessionStart message has no colour): what went wrong, then the fix.
    const shown = `✕ ${PRODUCT_NAME} can't start: port ${config.port} belongs to another user here\n! Fix  › /config, search "editlens", set Port to a free one (or EDITLENS_PORT), then restart Claude Code`;
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: note }, systemMessage: shown }));
    return;
  }
  // An update never interrupts Claude running from the page or a paired computer's task: say so.
  const updateNote = waiting ? updateText(config.version, running, waiting)
    : stale ? staleText(config.version, stale, why) : busy ? `✦ ${PRODUCT_NAME} ${config.version} is installed, but the running server didn't respond in time · it is checked again with your next prompt` : '';
  if (waiting) logLine(updateNote);
  if (replaced) logLine(`replaced a server from plugin version ${replaced} with ${config.version}`);
  if (stale) logLine(`a server from plugin version ${stale} did not stop; pages keep the old script until it exits`);
  await inTime(clock, 'session event', () => postEvent({ ...base(input, 'session'), source: input.source || 'startup', canListen: !remoteSession(), ...settingsReport() }), null);
  const startup = (input.source || 'startup') === 'startup';
  // The desktop app resumes its session when it restarts: page control starts again then too.
  const resumed = (input.source || 'startup') === 'resume';
  const connected = (startup ? await inTime(clock, 'auto connect', () => autoConnect(input, clock), '') : '') +
    (startup || resumed ? await inTime(clock, 'auto page control', () => autoControl(input), '') : '');
  await inTime(clock, 'command list', () => {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    const commands = listCommands({ projectDir, pluginRoot: path.join(__dirname, '..'), pluginName: 'editlens' });
    return postEvent({ ...base(input, 'commands'), transcriptPath: null, commands });
  }, null);
  // SessionStart stdout is added to Claude's context.
  const context = connected +
    `${PRODUCT_NAME} is on (${config.baseUrl}${started ? ', just started' : ''}). ` +
      'Each file edit is shown live in the browser page under development, with your last sentence before the edit as its caption, ' +
      'so state in one short sentence what you are about to change before each edit. ' +
      'Your replies also appear in that panel. The user can also message you from it: those messages are sent to you ' +
      "through this plugin's Stop hook (when you finish a turn) or alongside their next prompt. " +
      'To show the user something on the page, use the highlight_on_page tool. ' +
      'A split-screen code view next to the page shows each of your edits line by line; to show the user code you are ' +
      'discussing, or to open the backend and frontend files you are about to change side by side, use the show_code tool. ' +
      (teamOff() ? '' : 'Subagents you start share a team board with you (read_board, post_note, claim_task, complete_task, share_finding) and are told to use it; ' +
        'when you split work between them, give each a distinct part and read the board before merging their results. ') +
      'To connect a page, the user runs /editlens (or /editlens <port or address> for a running dev server), which changes no project file. If you do add EditLens to a project file ' +
      '(script tag, Vite plugin, middleware), put the added lines between `editlens:start` and `editlens:end` comments on their own lines, ' +
      'so /editlens stop remove can remove them when the work is done. ' +
      'For the /editlens commands, pairing with another computer, tasks on a paired computer and subagent copies, use the editlens-guide skill.\n';
  // The desktop Code tab may not draw the mod's line, so this message says EditLens is on
  // (on resume too: the app resumes its session on restart).
  const welcome = desktopApp() && ['startup', 'resume'].includes(input.source || 'startup') ? desktopWelcome() : '';
  let versionNote = '';
  try {
    versionNote = versionWarning({ desktop: desktopApp(), stateDir: config.stateDir, product: PRODUCT_NAME });
  } catch (err) {
    if (!err || !err.code) throw err;
    logLine(`version check: ${err.code}`);
  }
  const setupNote = controlSetupNote(input);
  if (welcome || updateNote || versionNote || setupNote) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context }, systemMessage: [versionNote, updateNote, setupNote, welcome].filter(Boolean).join('\n') }));
  } else {
    process.stdout.write(context);
  }
}

function desktopApp() {
  return process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop';
}

// Outside a terminal Claude can't wait for page messages (remoteSession), so chatting from the page
// needs page control, whose one-time setup only the user starts. Shown once per start.
function controlSetupNote(input) {
  if (!remoteSession() || (input.source || 'startup') !== 'startup' || process.env.EDITLENS_NO_START === '1') return '';
  const values = settings.fromEnv().values;
  if (!settings.startsControl(values) || require('../server/driver').sdkEntry(config.stateDir)) return '';
  return '✦ Page control sets itself up when your page opens · once, about 30 MB\n  It downloads ' + require('../lib/sdkinfo').sdkSource() + '.\n  In this app, page messages are sent to Claude here with your next prompt.';
}

function desktopWelcome() {
  return '✦ EditLens is on. Type /editlens to connect your page · /editlens help';
}

// The settings Claude Code gave this hook (/config), for the server and the page. Nothing when
// this Claude Code doesn't pass plugin settings, or when EditLens started it (page control or a
// task): its defaults are not the user's settings.
function settingsReport() {
  if (startedByEditLens()) return {};
  const env = settings.fromEnv();
  return env.set ? { settings: env.values } : {};
}

// "Connect when Claude Code starts" (on by default): a Vite project that doesn't load EditLens
// gets its own Vite with EditLens added; another project is connected through the proxy when its
// dev server is already running. Nothing in the project changes.
// A Claude EditLens started itself (page control or a task): server/driver.js sets EDITLENS_DRIVEN.
function startedByEditLens() {
  return process.env.EDITLENS_DRIVEN === '1';
}

async function autoConnect(input, clock = phaseClock(SESSION_MS)) {
  // Not for a session EditLens started: a task copy must not get its own page.
  if (process.env.EDITLENS_NO_START === '1' || startedByEditLens()) return '';
  const env = settings.fromEnv();
  if (!env.values.auto_connect) return '';
  // The project, or the one app in a folder inside it.
  const apps = appsIn(projectDir(input));
  if (apps.length !== 1) return '';
  const cwd = apps[0];
  try {
    if (findIntegrations(cwd).length) return '';
    const found = detect(cwd);
    let target = null;
    // Vite runs with EditLens added; a plain site is served by EditLens itself; anything else is
    // connected when its dev server already runs.
    if (found.kind !== 'vite' && found.kind !== 'static') {
      const server = await devServerOf(cwd, { skip: [config.port], stateDir: config.stateDir });
      // Only a server that is certainly this project's: a usual framework port may be another's.
      if (server && !server.sure) {
        await postJson('/connect/hint', { cwd, url: server.url }).catch((err) => logLine(`connect hint: ${err.message}`));
        return `EditLens: a server is running at ${server.url}, but it may be another project's, so this project's page isn't connected. If it is this project's, the user can click "Connect ${server.url.replace('http://', '')}" on the EditLens line above the prompt, or run /editlens ${server.url}.\n`;
      }
      target = server ? server.url : null;
      if (!target) {
        const cmd = runCommand(cwd, found);
        return cmd ? `EditLens: this project's dev server isn't running, so its page isn't connected. If the user wants the page, tell them to start it (${cmd}) and run /editlens.\n` : '';
      }
    }
    // Vite may take longer than this hook can wait; it continues starting in both cases.
    // Up to 6 s and not past the phase's deadline. Over 1.5 s, so postJson does not retry a timeout.
    const res = await postJson('/connect', { cwd, target, sessionId: input.session_id || null }, { timeoutMs: Math.min(6000, Math.max(1501, clock.left())) });
    if (res && res.url) return `EditLens connected this project's page at ${res.url} (no project files changed). Tell the user to open it if they ask where the page is.\n`;
  } catch (err) {
    if (err.code === 'ETIMEDOUT') return 'EditLens is starting this project\'s page; /editlens shows its address.\n';
    logLine(`auto connect failed: ${err.message}`);
  }
  return '';
}

// Page control on by default: when the session starts or resumes, the server turns page control on
// when this project's page opens (never a paired computer's page), installing the Agent SDK
// (about 30 MB) the first time. Off with "What /editlens does" = "Connect the page"; /editlens
// manual or Manual on the page also stop it.
async function autoControl(input) {
  // A session EditLens started (page control or a task) never asks: it would start another session
  // that controls the page.
  if (process.env.EDITLENS_NO_START === '1' || startedByEditLens()) return '';
  const env = settings.fromEnv();
  if (!env.values.auto_connect || !settings.startsControl(env.values)) return '';
  const apps = appsIn(projectDir(input));
  const cwd = apps.length === 1 ? apps[0] : projectDir(input);
  let out = null;
  try {
    out = await postJson('/drive/auto', { cwd, claudePath: process.env.CLAUDE_CODE_EXECPATH || null, sessionId: input.session_id || null });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    logLine(`auto page control could not be asked for: ${err.message}`);
    return '';
  }
  return out && out.installed === false
    ? 'EditLens: page control turns on by itself when this project\'s page opens (the user\'s "What /editlens does" setting). The first time, it sets itself up then (' + require('../lib/sdkinfo').sdkSource() + ', about 30 MB); the page shows it.\n'
    : 'EditLens: page control turns on by itself when this project\'s page opens (the user\'s "What /editlens does" setting); messages typed in the page panel then go to a Claude that runs from the page.\n';
}

// Team board: MCP calls don't say which agent makes them, but this hook does (no agent_id = main
// agent), so it tells the server first, keyed by the exact tool input.
function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

function teamOff() {
  return process.env.EDITLENS_TEAM === 'off';
}

async function onBoardCall(input) {
  await postEvent({
    type: 'board-who',
    key: callKey(input.tool_name, input.tool_input || {}),
    sessionId: input.session_id || null,
    agentId: input.agent_id || null,
    agentType: input.agent_type || null,
    name: input.agent_id ? agentDescription(input) : null,
    projectDir: projectDir(input),
  });
}

// The short task description Claude gave the subagent ("Frontend: bold prices"), from the file
// Claude Code keeps next to the subagent's transcript. Null when it doesn't exist (yet).
function agentDescription(input) {
  if (typeof input.transcript_path !== 'string' || !/^[\w-]+$/.test(input.agent_id)) return null;
  const file = path.join(input.transcript_path.replace(/\.jsonl$/, ''), 'subagents', `agent-${input.agent_id}.meta.json`);
  const text = readFileOrNull(file);
  if (!text) return null;
  try {
    const meta = JSON.parse(text);
    return typeof meta.description === 'string' && meta.description.trim() ? truncate(meta.description.trim(), 200) : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

async function onAgentStart(input) {
  if (!input.agent_id || teamOff() || process.env.EDITLENS_TASK_ACCOUNT === '1') return;
  const name = agentDescription(input);
  try {
    await postEvent({ type: 'subagent-start', sessionId: input.session_id || null, agentId: input.agent_id, agentType: input.agent_type || null, name, projectDir: projectDir(input) });
  } catch (err) {
    logLine(`cannot post subagent start: ${err.message}`);
  }
  const me = labelFor({ known: true, agentId: input.agent_id, agentType: input.agent_type, name });
  addContext(
    'SubagentStart',
    `You are "${me}" on this project's team board, which the main agent and the other subagents share ` +
      '(tools read_board, post_note, claim_task, complete_task and share_finding from the live-page MCP server, if your tool list has them). ' +
      'Call read_board first to see what the others claimed or found. Before you change files, claim_task them, and call complete_task when done. ' +
      'Post code locations others need with share_finding, and decisions, questions or blockers with post_note. Keep posts short. ' +
      'Your final reply still goes to the main agent as usual.',
  );
}

// Also with the team board off: a subagent run in the background ends its card here (copyOnly
// keeps it off the board).
async function onAgentStop(input) {
  const copy = worktree.copyOf(input.cwd);
  if (!input.agent_id || process.env.EDITLENS_TASK_ACCOUNT === '1') return;
  const full = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
  const last = full.split('\n').find((l) => l.trim()) || '';
  // Its whole last reply (its lines kept) for the card's result; the first line for the board.
  const result = full.length > RESULT_MAX ? sliceSafe(full, RESULT_MAX - 1) + '…' : full;
  await postEvent({ type: 'subagent-stop', sessionId: input.session_id || null, agentId: input.agent_id, agentType: input.agent_type || null, name: agentDescription(input), projectDir: projectDir(input), summary: truncate(last, 1000), result, copy: copy ? copy.name : null, copyRoot: copy ? copy.root : null, copyOnly: teamOff() }, { start: false });
}

// Claude Code shows a permission question: the page lists it with the other waiting questions.
// Prints nothing, so Claude Code asks as usual; the user answers only in Claude Code.
async function onAsk(input) {
  // Page control and tasks show their own questions.
  if (startedByEditLens() || !input.tool_name) return;
  let toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const file = EDIT_TOOLS.has(input.tool_name) ? filePathOf(input) : null;
  // An edit of a key or credentials file: only its path is sent, not the text of the edit.
  const secret = typeof file === 'string' && secretPath(input.cwd || process.cwd(), file);
  if (secret) toolInput = input.tool_name === 'NotebookEdit' ? { notebook_path: file } : { file_path: file };
  if (JSON.stringify(toolInput).length > 20000) toolInput = { note: 'too long to show' };
  await postEvent({ type: 'ask', sessionId: input.session_id || null, agentId: input.agent_id || null, agentType: input.agent_type || null,
    cwd: input.cwd || process.cwd(), projectDir: projectDir(input), tool: input.tool_name, input: toolInput, ...(secret ? { secret: true } : {}) }, { start: false });
}

// The session closed: pages say so instead of waiting. Never starts a server just for this.
async function onEnd(input) {
  await postEvent({ ...base(input, 'end'), reason: input.reason || null, transcriptPath: null }, { start: false });
}

const PHASES = {
  session: onSession, prompt: onPrompt, pending: onPending, step: onStep, change: onStep, idle: onIdle, end: onEnd,
  board: onBoardCall, 'agent-start': onAgentStart, 'agent-stop': onAgentStop, bash: onBash, agent: onAgentCall, ask: onAsk,
};

// Page control passes its own copy of EditLens to Claude (server/driver.js). An older Claude Code
// also loads the installed copy: only the passed copy reports, so no edit appears twice.
function otherCopy() {
  const passed = process.env.EDITLENS_PLUGIN_ROOT;
  if (!passed || !startedByEditLens()) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch (err) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return path.resolve(p);
      throw err;
    }
  };
  // Windows paths sometimes differ only in case.
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  return !same(real(passed), real(path.join(__dirname, '..')));
}

// The debug log keeps names, ids and paths. Any other text (file text, prompts, commands) is
// logged as its length only, so the log never has a key file's text.
const DEBUG_KEEP = new Set(['session_id', 'cwd', 'tool_use_id', 'tool_name', 'hook_event_name', 'file_path', 'filePath',
  'notebook_path', 'path', 'transcript_path', 'source', 'permission_mode', 'agent_id', 'agent_type', 'model', 'type']);
function debugView(value, key = '', depth = 0) {
  if (typeof value === 'string') return DEBUG_KEEP.has(key) ? value : `<${value.length} characters>`;
  if (!value || typeof value !== 'object') return value;
  if (depth > 6) return '<more>';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => debugView(v, '', depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = debugView(v, k, depth + 1);
  return out;
}

// The port this Claude Code session started with (lib/config.js useSession): a start or a resume
// takes the Port setting, every other hook the port kept for the session. After a /clear (a new
// session id) the mod keeps its port for the new id within 2 s. A file that can't be written is
// logged, and the port is still used.
function sessionPort(phase, input) {
  const atStart = phase === 'session' && ['startup', 'resume'].includes(input.source || 'startup');
  try {
    config.useSession(input.session_id, { atStart });
  } catch (err) {
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR'].includes(err.code)) throw err;
    logLine(`could not keep the session's port: ${err.code}`);
  }
}

async function main() {
  const phase = process.argv[2];
  const handler = PHASES[phase];
  if (!handler) throw new Error(`unknown phase "${phase}"`);
  if (process.env.EDITLENS_DISABLE === '1') return;
  if (otherCopy()) return;
  // SessionStart's deadline counts from here, so a slow input leaves less time for the steps.
  const clock = phase === 'session' ? phaseClock(SESSION_MS) : null;
  const raw = await readStdin(process.stdin, clock ? { timeoutMs: Math.max(1, Math.min(INPUT_MS, clock.left())) } : undefined);
  let input;
  try {
    input = raw.trim() ? JSON.parse(raw) : {};
  } catch (err) {
    // Node's parse error quotes part of the input: the log gets its length only.
    if (err instanceof SyntaxError) throw new Error(`hook input is not JSON (${raw.length} characters)`);
    throw err;
  }
  if (process.env.EDITLENS_DEBUG === '1') logLine(`${phase} input: ${JSON.stringify(debugView(input)).slice(0, 20000)}`);
  sessionPort(phase, input);
  await (clock ? handler(input, clock) : handler(input));
}

if (require.main === module) {
  main().then(
    () => process.exit(0),
    (err) => {
      logLine(`${process.argv[2]} failed: ${err.stack || err.message}`);
      process.exit(0);
    },
  );
}

module.exports = { debugView, describeChange: describe, updateText, staleText, changeHunks, otherCopy, readStdin, writeShared, autoConnect, phaseClock, inTime };
