'use strict';
// Follows a Claude Code session transcript (JSONL) and its subagent transcripts, turning
// new entries into chat events: Claude's replies, tool steps, subagent starts and results.

const fs = require('fs');
const path = require('path');
const { sliceSafe } = require('../lib/textcut');
const { StringDecoder } = require('string_decoder');
const { UsageTracker, scanFile } = require('./usage');

const POLL_MS = 250;
const BACKLOG_BYTES = 128 * 1024;
const CHUNK_MAX = 1024 * 1024; // read per tick; the rest waits for the next one (the file only grows)
const LINE_MAX = 8 * 1024 * 1024; // a longer line (a huge tool result) is skipped, not kept
const BACKLOG_EVENTS = 40;
const TEXT_MAX = 4000;
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const IDLE_MS = 60000; // a file unchanged this long is polled every 2 s instead of every 250 ms
const IDLE_EVERY = 8;
const AGENT_QUIET_MS = 10 * 60000; // a subagent file unchanged this long is no longer followed
const AGENT_DONE_GRACE_MS = 5000; // after a subagent's result: one last read, then stop

// A file being written, locked (Windows, antivirus) or gone for a moment: skip this tick, log once.
const TRANSIENT = new Set(['ENOENT', 'ENOTDIR', 'EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EAGAIN']);
const logged = new Set();
function transient(err, file) {
  if (!err || !TRANSIENT.has(err.code)) return false;
  const key = `${err.code} ${file}`;
  if (err.code !== 'ENOENT' && !logged.has(key) && logged.size < 200) {
    logged.add(key);
    process.stdout.write(`[transcript] ${err.code} on ${file}; trying again\n`);
  }
  return true;
}

function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  return s.length > max ? sliceSafe(s, max - 1) + '…' : s;
}

function base(p) {
  return String(p || '').split(/[\\/]/).pop();
}

// The file a tool call works on, so the code view can follow an agent: { file, line, end, op }.
function toolTarget(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  const file = name === 'NotebookEdit' ? i.notebook_path : i.file_path;
  if (typeof file !== 'string' || !file || !path.isAbsolute(file)) return {};
  if (name === 'Read') {
    const offset = Number(i.offset);
    const limit = Number(i.limit);
    // Safe whole line numbers only: a huge offset or limit gives no range (never Infinity).
    const line = offset >= 1 && Number.isSafeInteger(Math.floor(offset)) ? Math.floor(offset) : null;
    const last = line && Number.isFinite(limit) && limit >= 1 ? line + Math.floor(limit) - 1 : null;
    const end = Number.isSafeInteger(last) ? last : null;
    return { file, line, end, op: 'read' };
  }
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return { file, line: null, end: null, op: 'edit' };
  return {};
}

// One-line description of a tool call.
function toolSummary(name, input) {
  const i = input && typeof input === 'object' ? input : {};
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return base(i.file_path);
    case 'NotebookEdit':
      return base(i.notebook_path);
    case 'Bash':
      return clip(i.description || i.command, 500);
    case 'Grep':
    case 'Glob':
      return clip(i.pattern, 300);
    case 'WebFetch':
      return clip(i.url, 500);
    case 'WebSearch':
      return clip(i.query, 300);
    case 'TodoWrite':
      return Array.isArray(i.todos) ? `${i.todos.length} items` : '';
    default:
      if (name.startsWith('mcp__')) return clip(i.note || i.selector || '', 300);
      return '';
  }
}

function toolLabel(name) {
  const m = /^mcp__(?:plugin_[^_]+_)?(.+?)__(.+)$/.exec(name);
  return m ? m[2].replace(/_/g, ' ') : name;
}

// Text a person typed (not tool results, not harness-injected context).
function userText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text);
  return texts.length ? texts.join('\n') : null;
}

function isHumanText(text) {
  if (!text || !text.trim()) return false;
  const t = text.trim();
  // Slash-command wrappers, reminders, hook feedback and interrupts are not chat.
  return !t.startsWith('<') && !t.startsWith('[Request interrupted') && !/^Stop hook feedback/i.test(t) && !t.startsWith('Caveat:');
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
}

function finite(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

// The Agent call's result when Claude Code runs the subagent in the background: it only says the
// subagent started (with ids and a file path meant for Claude, never shown). -> the subagent's id,
// '' when it isn't given, or null for a subagent that ran to its end in the call.
function backgroundStart(r, content) {
  const text = resultText(content).trim();
  if (r.status !== 'async_launched' && r.isAsync !== true && !/^Async agent launched/.test(text)) return null;
  if (typeof r.agentId === 'string' && /^[\w-]{1,100}$/.test(r.agentId)) return r.agentId;
  const m = /^agentId: ([\w-]{1,100})\b/m.exec(text);
  return m ? m[1] : '';
}

// Claude Code's note that a background task ended (a user line in the main transcript):
// { agentId, toolUseId, status, text, tokens, toolCount, durationMs }, or null for other text.
function taskNotification(text) {
  if (typeof text !== 'string' || !text.trimStart().startsWith('<task-notification>')) return null;
  const tag = (name) => {
    const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
    return m ? m[1].trim() : null;
  };
  // The result is the subagent's own text, which can have tags of its own: up to the last </result>.
  const from = text.indexOf('<result>');
  const to = text.lastIndexOf('</result>');
  const result = from >= 0 && to > from ? text.slice(from + '<result>'.length, to).trim() : '';
  const status = tag('status');
  // Whole numbers only: a missing or empty tag is unknown, not 0.
  const count = (v) => (typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : null);
  return {
    agentId: tag('task-id'),
    toolUseId: tag('tool-use-id'),
    status: !status || status === 'completed' ? 'completed' : 'failed',
    text: result.replace(/^\[Subagent hand-back\][^\n]*\n+/, ''),
    tokens: count(tag('subagent_tokens') ?? tag('total_tokens')),
    toolCount: count(tag('tool_uses')),
    durationMs: count(tag('duration_ms')),
  };
}

// Reads appended lines from a file by polling its size (works on every OS, including network drives).
class Tail {
  constructor(file, onEntry, { backlog }) {
    this.file = file;
    this.onEntry = onEntry;
    this.offset = 0;
    this.partial = '';
    this.timer = null;
    this.backlog = backlog;
  }

  start() {
    let size = 0;
    try {
      size = fs.statSync(this.file).size;
    } catch (err) {
      if (!transient(err, this.file)) throw err;
    }
    this.startSize = size;
    this.changedAt = Date.now();
    this.ticks = 0;
    this.decoder = new StringDecoder('utf8');
    this.offset = this.backlog ? Math.max(0, size - BACKLOG_BYTES) : 0;
    if (this.backlog && this.offset > 0) this.skipFirstLine = true;
    this.read(true);
    this.timer = setInterval(() => {
      // Unchanged files are polled less often.
      if (Date.now() - this.changedAt > IDLE_MS && ++this.ticks % IDLE_EVERY !== 0) return;
      this.read(false);
    }, POLL_MS);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  // New bytes since the last read, or null when there are none (or the file can't be read now).
  chunk() {
    let fd;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch (err) {
      if (transient(err, this.file)) return null;
      throw err;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) {
        // File was truncated or replaced: start over.
        this.offset = 0;
        this.partial = '';
        this.decoder = new StringDecoder('utf8');
      }
      if (size === this.offset) return null;
      const buf = Buffer.alloc(Math.min(size - this.offset, CHUNK_MAX));
      const got = fs.readSync(fd, buf, 0, buf.length, this.offset);
      this.offset += got;
      this.more = this.offset < size;
      // A character split between two reads is kept for the next one.
      return this.decoder.write(buf.subarray(0, got));
    } catch (err) {
      if (transient(err, this.file)) return null;
      throw err;
    } finally {
      fs.closeSync(fd);
    }
  }

  read(initial) {
    const added = this.chunk();
    if (added === null) return;
    this.changedAt = Date.now();
    const text = this.partial + added;
    const lines = text.split('\n');
    this.partial = lines.pop();
    if (this.skipFirstLine) {
      if (lines.length) {
        lines.shift();
        this.skipFirstLine = false;
      } else {
        this.partial = ''; // still inside the line being skipped
      }
    }
    if (this.partial.length > LINE_MAX) {
      // Too long to keep whole (a huge tool result): skip it, and the rest of it when it comes.
      this.partial = '';
      this.skipFirstLine = true;
    }
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        // Only objects are entries: a line of null or a list would stop the rest of the batch (Sol L4).
        if (e && typeof e === 'object' && !Array.isArray(e)) entries.push(e);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
    }
    this.onEntry(entries, initial);
    // A big write is read a megabyte at a time, each on its own turn of the event loop.
    if (this.more && this.timer) setImmediate(() => {
      if (this.timer) this.read(false);
    });
  }

}

// Follows one session: its main transcript plus <session>/subagents/agent-*.jsonl.
class SessionWatcher {
  // compactLimit(model): the user's auto-compact window for this session, or null.
  constructor({ sessionId, transcriptPath, cwd, emit, onUsage, compactLimit, doneGraceMs = AGENT_DONE_GRACE_MS }) {
    this.doneGraceMs = doneGraceMs;
    this.sessionId = sessionId;
    this.transcriptPath = transcriptPath;
    this.cwd = cwd;
    this.emit = emit;
    this.onUsage = onUsage || (() => {});
    this.usage = new UsageTracker();
    this.usage.compactLimit = compactLimit || null;
    this.usageReady = false;
    this.usageQueue = []; // live lines that arrive while the first scan runs
    this.usageSent = -1;
    this.agentToolIds = new Set();
    this.agents = new Map(); // agentId -> Tail, or null once it is no longer followed
    this.agentOfTool = new Map(); // Agent tool call id -> agentId
    // Subagents run in the background: Agent call id -> { toolUseId, agentId, ended, counted, text }.
    this.background = new Map();
    this.stopped = new Map(); // agentId -> final text, for an end seen before its start result
    this.lastSeen = Date.now();
    this.subDir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  }

  start() {
    this.main = new Tail(this.transcriptPath, (entries, initial) => this.onMain(entries, initial), { backlog: true });
    this.main.start();
    // Totals need the whole transcript, not just the backlog the chat shows; the tail adds the rest.
    scanFile(this.transcriptPath, this.main.startSize || 0, this.usage).then(
      () => {
        this.usageReady = true;
        for (const e of this.usageQueue.splice(0)) this.usage.ingest(e);
        this.reportUsage();
      },
      (err) => {
        this.usageReady = true;
        for (const e of this.usageQueue.splice(0)) this.usage.ingest(e);
        process.stdout.write(`[usage] cannot read ${this.transcriptPath}: ${err.message}\n`);
      },
    );
    this.usageTimer = setInterval(() => this.reportUsage(), 1000);
    this.usageTimer.unref();
    this.scanTimer = setInterval(() => this.scanAgents(), 1000);
    this.scanTimer.unref();
  }

  stop() {
    this.main.stop();
    clearInterval(this.scanTimer);
    clearInterval(this.usageTimer);
    for (const t of this.agents.values()) if (t) t.stop();
  }

  // A subagent finished: read its file once more for the last steps, then stop following it.
  agentDone(agentId, toolUseId) {
    this.agentToolIds.delete(toolUseId);
    this.agentOfTool.delete(toolUseId);
    if (!agentId) return;
    const tail = this.agents.get(agentId);
    if (!tail) {
      this.agents.set(agentId, null);
      return;
    }
    const t = setTimeout(() => {
      tail.read(false);
      tail.stop();
      if (this.agents.get(agentId) === tail) this.agents.set(agentId, null);
    }, this.doneGraceMs);
    t.unref();
  }

  // The Agent call ran the subagent in the background: its card stays working until it ends.
  backgroundStarted(agentId, toolUseId, events) {
    this.agentToolIds.delete(toolUseId);
    if (agentId) this.agentOfTool.set(toolUseId, agentId);
    if (!this.background.has(toolUseId)) this.background.set(toolUseId, { toolUseId, agentId: agentId || null, ended: false, counted: false, text: '' });
    // Only the newest are kept; ones still running first.
    for (const [k, v] of this.background) {
      if (this.background.size <= 200) break;
      if (v.ended) this.background.delete(k);
    }
    if (agentId && this.stopped.has(agentId)) this.backgroundEnded(toolUseId, { text: this.stopped.get(agentId) }, events);
  }

  backgroundOf(agentId, toolUseId) {
    if (toolUseId && this.background.has(toolUseId)) return this.background.get(toolUseId);
    if (!agentId) return null;
    for (const bg of this.background.values()) {
      if (!bg.agentId && this.agentOfTool.get(bg.toolUseId) === agentId) bg.agentId = agentId;
      if (bg.agentId === agentId) return bg;
    }
    return null;
  }

  // Claude Code's task notification (taskNotification): ends that background subagent's card.
  notified(note, events) {
    const bg = note && this.backgroundOf(note.agentId, note.toolUseId);
    if (bg) this.backgroundEnded(bg.toolUseId, note, events, true);
  }

  // A background subagent ended: its final text, and Claude Code's counts when the end came from
  // its task notification. The first end marks the card done; the notification only adds counts.
  backgroundEnded(toolUseId, { text, status = 'completed', tokens = null, toolCount = null, durationMs = null, backlog = false }, events, counted = false) {
    const bg = this.background.get(toolUseId);
    if (!bg || (bg.ended && (!counted || bg.counted))) return;
    const first = !bg.ended;
    bg.ended = true;
    if (counted) bg.counted = true;
    if (typeof text === 'string' && text.trim()) bg.text = clip(text, TEXT_MAX);
    const ev = { role: 'agent-done', toolUseId, agentId: bg.agentId, status, text: bg.text, durationMs, toolCount, tokens };
    if (events) events.push(ev);
    else this.send(ev, backlog);
    if (first) this.agentDone(bg.agentId, toolUseId);
  }

  // SubagentStop from the hook: ends a background subagent with its last reply.
  subagentStopped(agentId, text) {
    if (typeof agentId !== 'string' || !agentId) return;
    const bg = this.backgroundOf(agentId);
    if (bg) return this.backgroundEnded(bg.toolUseId, { text }, null);
    this.rememberStop(agentId, text);
  }

  rememberStop(agentId, text) {
    this.stopped.set(agentId, typeof text === 'string' ? text : '');
    if (this.stopped.size > 50) this.stopped.delete(this.stopped.keys().next().value);
  }

  // Subagents whose result never appeared (killed, or from an older Claude Code): stop when quiet.
  stopQuietAgents() {
    for (const [agentId, tail] of this.agents) {
      if (tail && Date.now() - tail.changedAt > AGENT_QUIET_MS) {
        tail.stop();
        this.agents.set(agentId, null);
      }
    }
    // Finished ones are only remembered so their file is not followed again; keep the newest.
    if (this.agents.size > 500) {
      for (const [agentId, tail] of this.agents) {
        if (this.agents.size <= 400) break;
        if (!tail) this.agents.delete(agentId);
      }
    }
  }

  send(ev, backlog) {
    this.emit({ ...ev, type: 'chat', sessionId: this.sessionId, cwd: this.cwd, backlog: Boolean(backlog), ts: Date.now() });
  }

  // At most once a second, and only when something changed.
  reportUsage(force) {
    if (!this.usageReady || (!force && this.usage.version === this.usageSent)) return;
    this.usageSent = this.usage.version;
    this.onUsage({ type: 'usage', sessionId: this.sessionId, cwd: this.cwd, ...this.usage.snapshot() });
  }

  onMain(entries, initial) {
    if (!initial) {
      if (this.usageReady) for (const e of entries) this.usage.ingest(e);
      else this.usageQueue.push(...entries);
    }
    const events = [];
    for (const e of entries) {
      // Older versions also write subagent lines here; the subagent files already have them.
      if (e.isSidechain) continue;
      const content = e.message && e.message.content;
      // A background task ended: written as soon as it ends, and again when Claude reads it.
      if (e.type === 'queue-operation' && e.operation === 'enqueue') this.notified(taskNotification(e.content), events);
      if (e.type === 'user') {
        const text = userText(content);
        if (!e.isMeta && isHumanText(text)) events.push({ role: 'user', text: clip(text, TEXT_MAX) });
        this.notified(taskNotification(text), events);
        // Esc / Stop: Claude Code records the interrupt here, and no Stop hook runs.
        if (!initial && text && text.trim().startsWith('[Request interrupted')) this.emit({ type: 'interrupted' });
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && b.type === 'tool_result' && this.agentToolIds.has(b.tool_use_id)) {
              const r = e.toolUseResult && typeof e.toolUseResult === 'object' ? e.toolUseResult : {};
              const bgId = backgroundStart(r, b.content);
              if (bgId !== null) {
                this.backgroundStarted(bgId || this.agentOfTool.get(b.tool_use_id) || '', b.tool_use_id, events);
                continue;
              }
              if (!initial) this.agentDone(r.agentId || this.agentOfTool.get(b.tool_use_id), b.tool_use_id);
              const summary = resultText(r.content || b.content).replace(/^\[Subagent hand-back\][^\n]*\n+/, '');
              events.push({
                role: 'agent-done',
                toolUseId: b.tool_use_id,
                agentId: r.agentId || null,
                status: b.is_error ? 'failed' : r.status || 'completed',
                text: clip(summary, TEXT_MAX),
                durationMs: finite(r.totalDurationMs),
                toolCount: finite(r.totalToolUseCount),
                tokens: finite(r.totalTokens),
              });
            }
          }
        }
      } else if (e.type === 'assistant' && Array.isArray(content)) {
        for (const b of content) {
          if (!b) continue;
          if (b.type === 'text' && b.text && b.text.trim()) {
            events.push({ role: 'assistant', text: clip(b.text, TEXT_MAX) });
          } else if (b.type === 'tool_use' && AGENT_TOOLS.has(b.name)) {
            this.agentToolIds.add(b.id);
            const i = b.input || {};
            events.push({
              role: 'agent-start',
              toolUseId: b.id,
              description: clip(i.description, 300),
              agentType: clip(i.subagent_type || 'general-purpose', 60),
              prompt: clip(i.prompt, TEXT_MAX),
              background: Boolean(i.run_in_background),
              // Its effort: the main agent's (Claude Code doesn't report a subagent's own level).
              effort: { inherited: true },
            });
          } else if (b.type === 'tool_use') {
            events.push({ role: 'tool', toolUseId: b.id, tool: toolLabel(b.name), summary: toolSummary(b.name, b.input), ...toolTarget(b.name, b.input) });
          }
        }
      }
    }
    const list = initial ? events.slice(-BACKLOG_EVENTS) : events;
    for (const ev of list) this.send(ev, initial);
  }

  scanAgents() {
    let names;
    try {
      names = fs.readdirSync(this.subDir);
    } catch (err) {
      if (transient(err, this.subDir)) return;
      throw err;
    }
    this.stopQuietAgents();
    const firstScan = !this.scanned;
    this.scanned = true;
    for (const name of names) {
      const m = /^agent-([\w-]+)\.jsonl$/.exec(name);
      if (!m || this.agents.has(m[1])) continue;
      const agentId = m[1];
      // Subagents from earlier in a resumed session: their start and result are already in the
      // main transcript backlog, so don't replay their steps as if they were running now.
      if (firstScan && !this.recentlyWritten(path.join(this.subDir, name))) {
        this.agents.set(agentId, null);
        continue;
      }
      const meta = this.readMeta(agentId);
      if (meta.toolUseId) this.agentOfTool.set(meta.toolUseId, agentId);
      // Agents that finished before following started get only their start/result from the main transcript.
      const tail = new Tail(path.join(this.subDir, name), (entries, initial) => this.onAgent(agentId, meta, entries, initial), { backlog: true });
      this.agents.set(agentId, tail);
      tail.start();
    }
  }

  recentlyWritten(file) {
    try {
      return Date.now() - fs.statSync(file).mtimeMs < 60000;
    } catch (err) {
      if (transient(err, file)) return false;
      throw err;
    }
  }

  readMeta(agentId) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this.subDir, `agent-${agentId}.meta.json`), 'utf8'));
      return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
    } catch (err) {
      if (err instanceof SyntaxError || transient(err, this.subDir)) return {};
      throw err;
    }
  }

  onAgent(agentId, meta, entries, initial) {
    if (!meta.toolUseId) Object.assign(meta, this.readMeta(agentId));
    for (const e of entries) {
      const content = e.message && e.message.content;
      if (e.type !== 'assistant' || !Array.isArray(content)) continue;
      // The subagent's model and token use, for its details in the Agents switcher. One reply can
      // span several lines with the same id and usage, so the page counts each id once.
      const m = e.message || {};
      const u = m.usage && typeof m.usage === 'object' ? m.usage : {};
      const parts = [u.input_tokens, u.cache_creation_input_tokens, u.cache_read_input_tokens].map(finite).filter((v) => v !== null && v >= 0);
      const ctx = parts.reduce((x, y) => x + y, 0); // past the largest number: unknown
      const usage = {
        model: typeof m.model === 'string' && m.model !== '<synthetic>' ? clip(m.model, 80) : null,
        msgId: typeof m.id === 'string' ? m.id.slice(0, 100) : null,
        ctx: parts.length && Number.isFinite(ctx) ? ctx : null,
        out: finite(u.output_tokens),
      };
      for (const b of content) {
        if (!b) continue;
        const ev = { role: 'agent-step', agentId, toolUseId: meta.toolUseId || null, agentType: meta.agentType || null, ...usage };
        if (b.type === 'text' && b.text && b.text.trim()) {
          meta.lastText = b.text;
          this.send({ ...ev, kind: 'text', text: clip(b.text, TEXT_MAX) }, initial);
        } else if (b.type === 'tool_use') this.send({ ...ev, kind: 'tool', tool: toolLabel(b.name), summary: toolSummary(b.name, b.input), ...toolTarget(b.name, b.input) }, initial);
      }
      // Its last reply (no tool call after it) ends a subagent run in the background.
      if (m.stop_reason !== 'end_turn' || content.some((b) => b && b.type === 'tool_use')) continue;
      const text = resultText(content).trim() || String(meta.lastText || '').trim();
      const bg = this.backgroundOf(agentId, meta.toolUseId);
      if (!bg) this.rememberStop(agentId, text);
      else if (!bg.ended) this.backgroundEnded(bg.toolUseId, { text, backlog: initial }, null);
    }
  }
}

module.exports = { SessionWatcher, Tail, toolTarget };
