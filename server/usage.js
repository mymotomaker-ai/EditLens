'use strict';
// Token usage of one session from its transcript, merged with status line numbers
// (bin/statusline.js) when reported. Never guesses a limit: unknown values stay null.

const fs = require('fs');
const readline = require('readline');

const STANDARD_WINDOW = 200000;
const LARGE_WINDOW = 1000000;
const AGENT_TOOLS = new Set(['Task', 'Agent']);
const USAGE_KEYS = ['input', 'cacheRead', 'cacheCreate', 'output'];

// A finite, non-negative number, or null (never NaN).
function num(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

// A token count: num() and at most Number.MAX_SAFE_INTEGER, so adding counts never produces Infinity.
function tokens(v) {
  const n = num(v);
  return n !== null && n <= Number.MAX_SAFE_INTEGER ? n : null;
}

function pct(v) {
  const n = num(v);
  return n === null ? null : Math.min(n, 1000);
}

function isPrompt(e) {
  if (e.type !== 'user' || e.isMeta) return false;
  const c = e.message && e.message.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n') : '';
  if (Array.isArray(c) && c.some((b) => b && b.type === 'tool_result')) return false;
  const t = String(text || '').trim();
  return Boolean(t) && !t.startsWith('<') && !t.startsWith('[Request interrupted') && !/^Stop hook feedback/i.test(t) && !t.startsWith('Caveat:');
}

const SEEN_MAX = 5000; // API responses whose usage lines may still repeat

// Plan limits belong to the account, not one session: the latest status line report counts for
// every session here, including ones that never run a status line (page control and tasks run
// through the Agent SDK, the desktop app). { rateLimits, at } | null
let sharedLimits = null;

class UsageTracker {
  constructor() {
    this.seen = new Map(); // API message id -> its usage (one response spans several lines)
    this.toolIds = new Set(); // tool_use ids counted
    this.model = null;
    this.modelKeys = []; // model names from Claude Code's cost records, e.g. "claude-opus-5-5[1m]"
    // The model as chosen in Claude Code, e.g. "claude-opus-5-5[1m]" (the API's id has no [1m]).
    this.requested = null;
    this.compactLimit = null; // (model) -> the auto-compact window or null (server/transcript.js sets it)
    this.context = null; // { input, cacheRead, cacheCreate, output } of the latest main response
    this.totals = { input: 0, cacheRead: 0, cacheCreate: 0, output: 0, responses: 0 };
    this.turns = 0;
    this.toolCalls = 0;
    this.subagents = 0;
    this.subagentTokens = 0;
    this.compactions = 0;
    this.startedAt = null;
    this.lastAt = null;
    this.effort = null;
    this.costRecord = null; // { costUSD, durationMs } from Claude Code's cost-state lines
    this.status = null; // latest status line report, see merge()
    this.compactAt = null; // time of the latest compaction: a status report from before it has an old count
    this.modelAt = null; // time the transcript's model last changed: an older status report has the old model
    this.version = 0; // increases on every change, so the server only broadcasts real updates
  }

  ingest(e) {
    if (!e || typeof e !== 'object') return;
    const at = Date.parse(e.timestamp);
    if (Number.isFinite(at)) {
      if (this.startedAt === null || at < this.startedAt) this.startedAt = at;
      if (this.lastAt === null || at > this.lastAt) this.lastAt = at;
    }
    if (e.type === 'cost-state') {
      this.costRecord = { costUSD: num(e.totalCostUSD), durationMs: num(e.totalDuration), unknownCost: Boolean(e.hasUnknownModelCost) };
      if (e.modelUsage && typeof e.modelUsage === 'object') this.modelKeys = Object.keys(e.modelUsage);
      this.version++;
      return;
    }
    // Claude Code writes the chosen model (with its [1m] for a 1M window) as an attachment at the
    // start and on every reply: the window is known from the first reply, not only past 200K.
    const chosen = e.isSidechain ? null : e.type === 'attachment' && e.attachment && e.attachment.type === 'model' && e.attachment.identity ? e.attachment.identity.modelId
      : e.type === 'assistant' ? e.requestedModel : null;
    const when = Number.isFinite(at) ? at : Date.now();
    if (typeof chosen === 'string' && chosen && chosen.length < 200 && chosen !== this.requested) {
      this.requested = chosen;
      this.noteModel(when);
    }
    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      this.compactions++;
      this.context = null; // repopulated by the next response
      if (this.compactAt === null || when > this.compactAt) this.compactAt = when;
      this.version++;
      return;
    }
    if (e.isSidechain) return;
    if (isPrompt(e)) {
      this.turns++;
      this.version++;
      return;
    }
    if (e.type === 'user' && e.toolUseResult && typeof e.toolUseResult === 'object') {
      const t = tokens(e.toolUseResult.totalTokens);
      if (t !== null && e.toolUseResult.agentId) {
        this.subagentTokens += t;
        this.version++;
      }
      return;
    }
    if (e.type !== 'assistant' || !e.message) return;
    const m = e.message;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (!b || b.type !== 'tool_use') continue;
        // A line written twice repeats its tool calls: each id counts once.
        if (typeof b.id === 'string' && b.id) {
          if (this.toolIds.has(b.id)) continue;
          this.toolIds.add(b.id);
          if (this.toolIds.size > SEEN_MAX) this.toolIds.delete(this.toolIds.values().next().value);
        }
        this.toolCalls++;
        if (AGENT_TOOLS.has(b.name)) this.subagents++;
      }
    }
    if (e.effort && typeof e.effort === 'object' && typeof e.effort.level === 'string') this.effort = e.effort.level;
    else if (typeof e.effort === 'string') this.effort = e.effort;
    const u = m.usage;
    if (typeof m.model === 'string' && m.model !== '<synthetic>' && m.model !== this.model) {
      this.model = m.model;
      this.noteModel(when);
    }
    if (!u || typeof u !== 'object' || m.model === '<synthetic>') {
      this.version++;
      return;
    }
    const usage = {
      input: tokens(u.input_tokens) || 0,
      cacheRead: tokens(u.cache_read_input_tokens) || 0,
      cacheCreate: tokens(u.cache_creation_input_tokens) || 0,
      output: tokens(u.output_tokens) || 0,
    };
    this.context = usage;
    // One response is written as several lines that repeat its usage (later lines can include the
    // final output count): count each response once, with its latest numbers.
    const id = m.id || e.requestId || e.uuid;
    const prior = id ? this.seen.get(id) : null;
    if (prior) for (const k of USAGE_KEYS) this.totals[k] -= prior[k];
    else this.totals.responses++;
    for (const k of USAGE_KEYS) this.totals[k] += usage[k];
    if (id) {
      this.seen.set(id, usage);
      // Only recent responses get more lines: the oldest are forgotten past SEEN_MAX.
      if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value);
    }
    this.version++;
  }

  noteModel(when) {
    if (this.modelAt === null || when > this.modelAt) this.modelAt = when;
    this.version++;
  }

  // The status report. After a later model change in the transcript to another model, without its
  // model and window: they belong to the old model.
  statusNow() {
    const s = this.status;
    if (!s) return {};
    if (this.modelAt === null || (typeof s.at === 'number' && s.at > this.modelAt)) return s;
    const now = this.requested || this.model;
    const base = (m) => String(m || '').replace(/\[1m\]$/i, '');
    const id = s.model && typeof s.model.id === 'string' ? s.model.id : '';
    const same = s.transcriptModel ? now === s.transcriptModel : id === now || (!/\[1m\]$/i.test(id) && base(now) === id);
    return same ? s : { ...s, model: null, context_window: null };
  }

  // What Claude Code's status line reported (bin/statusline.js forwards it).
  merge(report) {
    this.status = { ...report, at: Date.now(), transcriptModel: this.requested || this.model };
    if (report && report.rate_limits && typeof report.rate_limits === 'object') sharedLimits = { rateLimits: report.rate_limits, at: this.status.at };
    this.version++;
  }

  // The context window, and where that number comes from. The user's auto-compact window
  // (compactLimit, lib/ccsettings.js) is where Claude compacts: the lower of it and the model's.
  // Unknown: size null (never an assumed 200k).
  window(used) {
    const model = this.modelWindow(used);
    const limit = this.compactLimit ? this.compactLimit(this.requested || this.model || null) : null;
    if (limit) return { size: model.size ? Math.min(limit, model.size) : limit, source: 'autocompact' };
    return model;
  }
  modelWindow(used) {
    const s = this.statusNow().context_window;
    const reported = s && num(s.context_window_size);
    if (reported) return { size: reported, source: 'claude-code' };
    if (this.requested) {
      if (/\[1m\]$/i.test(this.requested)) return { size: LARGE_WINDOW, source: 'model' };
    } else {
      const model = this.model || '';
      if (model && this.modelKeys.some((k) => k.startsWith(model) && /\[1m\]$/i.test(k))) return { size: LARGE_WINDOW, source: 'model' };
    }
    if (used !== null && used > STANDARD_WINDOW) return { size: LARGE_WINDOW, source: 'observed' };
    return { size: null, source: null };
  }

  snapshot() {
    const s = this.statusNow();
    // A status report from before the latest compaction counts the context before it: not used.
    const current = this.compactAt === null || (typeof s.at === 'number' && s.at > this.compactAt);
    const cw = current && s.context_window && typeof s.context_window === 'object' ? s.context_window : {};
    const ctx = this.context;
    // Claude Code's own count is used before the transcript's (same input-only formula).
    const used = tokens(cw.total_input_tokens) ?? (ctx ? ctx.input + ctx.cacheRead + ctx.cacheCreate : null);
    const win = this.window(used);
    // Claude Code's own percentage is used first; it uses the same input-only formula.
    // Against the auto-compact window, our own: Claude Code's is against the model's window.
    const reportedPct = win.source === 'autocompact' ? null : pct(cw.used_percentage);
    const percent = reportedPct !== null ? reportedPct : used === null || !win.size ? null : Math.min(100, (used / win.size) * 100);
    const cost = s.cost && typeof s.cost === 'object' ? s.cost : {};
    const statusCost = num(cost.total_cost_usd);
    const costRecord = this.costRecord || {};
    const limits = {};
    // The newest report counts: this session's own, or a later one from another session.
    const ownLimits = s.rate_limits && typeof s.rate_limits === 'object' ? s.rate_limits : null;
    const own = ownLimits && !(sharedLimits && sharedLimits.at > s.at) ? ownLimits : null;
    const rl = own || (sharedLimits ? sharedLimits.rateLimits : {});
    for (const key of ['five_hour', 'seven_day', 'spend_limit']) {
      const w = rl[key];
      const p = w && pct(w.used_percentage);
      if (p === null || p === undefined) continue;
      const resets = num(w.resets_at);
      // In ms; a time too large for a number (Infinity) is unknown.
      const resetsAt = resets !== null && Number.isFinite(resets * 1000) ? resets * 1000 : null;
      // Claude Code removes a window once it resets; do the same for an older report.
      if (resetsAt !== null && resetsAt < Date.now()) continue;
      limits[key] = { percent: p, resetsAt };
    }
    const durationMs = num(cost.total_duration_ms) ?? (this.startedAt !== null ? Math.max(0, Date.now() - this.startedAt) : costRecord.durationMs ?? null);
    return {
      model: (s.model && typeof s.model.id === 'string' && s.model.id) || this.requested || this.model,
      modelName: (s.model && typeof s.model.display_name === 'string' && s.model.display_name) || null,
      effort: (s.effort && typeof s.effort.level === 'string' && s.effort.level) || this.effort,
      context: {
        used,
        percent,
        window: win.size,
        windowSource: win.source,
        input: ctx ? ctx.input : null,
        cacheRead: ctx ? ctx.cacheRead : null,
        cacheCreate: ctx ? ctx.cacheCreate : null,
        lastOutput: ctx ? ctx.output : null,
      },
      totals: { ...this.totals, subagentTokens: this.subagentTokens },
      turns: this.turns,
      toolCalls: this.toolCalls,
      subagents: this.subagents,
      compactions: this.compactions,
      startedAt: this.startedAt,
      durationMs,
      costUSD: statusCost ?? costRecord.costUSD ?? null,
      costSource: statusCost !== null ? 'claude-code' : costRecord.costUSD !== null && costRecord.costUSD !== undefined ? 'transcript' : null,
      limits: Object.keys(limits).length ? limits : null,
      limitsFrom: !Object.keys(limits).length ? null : own ? 'this-session' : 'other-session',
      fromStatusLine: Boolean(this.status),
      statusAt: this.status ? this.status.at : null,
    };
  }
}

// Count everything in a transcript up to `end` bytes (the live tail reads the rest).
function scanFile(file, end, tracker) {
  return new Promise((resolve, reject) => {
    if (end <= 0) return resolve();
    const stream = fs.createReadStream(file, { start: 0, end: end - 1, encoding: 'utf8' });
    const failed = (err) => (err.code === 'ENOENT' ? resolve() : reject(err));
    stream.on('error', failed);
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('error', failed);
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        tracker.ingest(JSON.parse(line));
      } catch (err) {
        if (err instanceof SyntaxError) return;
        // Not a throw inside an event handler: that would end the server.
        rl.close();
        stream.destroy();
        reject(err);
      }
    });
    rl.on('close', resolve);
  });
}

function resetSharedLimits() {
  sharedLimits = null;
}

module.exports = { UsageTracker, scanFile, num, resetSharedLimits, STANDARD_WINDOW, LARGE_WINDOW };
