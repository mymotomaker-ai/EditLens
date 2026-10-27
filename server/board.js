'use strict';
// Team board: per-project notes, claims and findings shared by the main agent and subagents.
// Authorship comes from the PreToolUse hook (see `expect`), not the agent, matched by tool input.
// Saved as JSONL so it survives restarts.

const fs = require('fs');
const path = require('path');
const { sliceSafe } = require('../lib/textcut');
const { writeAtomic } = require('../lib/atomic');
const crypto = require('crypto');

const BOARD_PRUNE_MS = 90 * 86400000;

// The first line of a file, reading at most max bytes of it (a board's header is small).
function firstLine(file, max) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(max);
    const got = fs.readSync(fd, buf, 0, max, 0);
    return buf.toString('utf8', 0, got).split('\n', 1)[0];
  } finally {
    fs.closeSync(fd);
  }
}

const MAX_ENTRIES = 500;
const WHO_TTL_MS = 60000;
const TEXT_MAX = 2000;
const KINDS = new Set(['note', 'question', 'answer', 'decision', 'blocker', 'finding', 'claim', 'done', 'join', 'leave']);
const NOTE_KINDS = new Set(['note', 'question', 'answer', 'decision', 'blocker']);

// The same JSON for the same input, whatever the key order: the hook and the MCP server must
// compute the same key for one tool call.
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function callKey(tool, input) {
  const short = String(tool || '').replace(/^mcp__.*__/, '');
  return crypto.createHash('sha1').update(`${short}\n${stable(input || {})}`).digest('hex');
}

function normDir(p) {
  const x = path.resolve(String(p).replace(/\\/g, '/'));
  return /^[a-z]:/i.test(x) ? x[0].toLowerCase() + x.slice(1) : x;
}

function clip(v, max) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > max ? `${sliceSafe(s, max - 1)}…` : s;
}

// A whole positive line number, or null (never NaN).
function lineNo(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

function shortId(agentId) {
  return typeof agentId === 'string' && agentId ? agentId.slice(-4) : '';
}

// "Main", the task description Claude gave the subagent ("Frontend: bold prices"), or else its
// type and id ("Explore 3f2a").
function labelFor(who) {
  if (!who || !who.known) return 'Unknown agent';
  if (!who.agentId) return 'Main';
  if (who.name) return who.name;
  return `${who.agentType || 'Subagent'} ${shortId(who.agentId)}`.trim();
}

class Board {
  constructor(dir, cwd) {
    this.cwd = cwd;
    this.key = crypto.createHash('sha1').update(normDir(cwd)).digest('hex').slice(0, 16);
    this.file = path.join(dir, `${this.key}.jsonl`);
    this.entries = [];
    this.nextId = 1;
    this.load();
  }

  load() {
    let text;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch (err) {
        if (err instanceof SyntaxError) continue; // a line left incomplete by a crash
        throw err;
      }
      if (e && e.header) continue;
      if (!e || !Number.isInteger(e.id) || !KINDS.has(e.kind)) continue;
      this.entries.push(e);
      this.nextId = Math.max(this.nextId, e.id + 1);
    }
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
  }

  rewrite() {
    const lines = [JSON.stringify({ header: true, cwd: this.cwd }), ...this.entries.map((e) => JSON.stringify(e))];
    writeAtomic(this.file, `${lines.join('\n')}\n`);
  }

  add(entry) {
    const e = { ...entry, id: this.nextId++, ts: Date.now() };
    this.entries.push(e);
    if (this.entries.length > MAX_ENTRIES + 100 || !fs.existsSync(this.file)) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
      this.rewrite();
    } else {
      fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`);
    }
    return e;
  }

  clear() {
    this.entries = [];
    this.rewrite();
  }

  get(id) {
    return this.entries.find((e) => e.id === id) || null;
  }

  // Claims that are not done or cancelled yet.
  openClaims() {
    const closed = new Set(this.entries.filter((e) => e.kind === 'done').map((e) => e.claimId));
    return this.entries.filter((e) => e.kind === 'claim' && !closed.has(e.id));
  }

  agents() {
    const map = new Map();
    for (const e of this.entries) {
      const k = e.agentId || (e.known ? 'main' : 'unknown');
      const a = map.get(k) || { agentId: e.agentId || null, agentType: e.agentType || null, label: e.author, joined: e.ts, left: null, posts: 0 };
      if (e.kind === 'join') a.joined = e.ts;
      if (e.kind === 'leave') a.left = e.ts;
      else if (e.kind !== 'join') a.posts++;
      map.set(k, a);
    }
    return [...map.values()];
  }
}

class Boards {
  constructor({ dir, onEntry, onClear }) {
    this.dir = dir;
    this.onEntry = onEntry || (() => {});
    this.onClear = onClear || (() => {});
    this.boards = new Map(); // normDir(cwd) -> Board
    this.pending = new Map(); // call key -> [{ who, at }]
    this.names = new Map(); // agentId -> task description, from the agent's join entry
    fs.mkdirSync(dir, { recursive: true });
  }

  // Loads boards used in the last week, so a page that opens before any agent posts still sees them.
  // Deletes boards unchanged for 90 days; otherwise one file per project would stay forever.
  loadRecent(maxAgeMs = 7 * 86400000, pruneMs = BOARD_PRUNE_MS) {
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => n.endsWith('.jsonl'));
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    const now = Date.now();
    const recent = [];
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const age = now - fs.statSync(file).mtimeMs;
        if (age > pruneMs) fs.unlinkSync(file);
        else if (age <= maxAgeMs) recent.push({ file, age });
      } catch (err) {
        // Removed meanwhile, a broken link, or no access: that board is skipped.
        if (!err || !['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM', 'EBUSY'].includes(err.code)) throw err;
      }
    }
    recent.sort((a, b) => a.age - b.age);
    for (const { file } of recent.slice(0, 50)) {
      try {
        const header = JSON.parse(firstLine(file, 64 * 1024));
        if (header && header.header && typeof header.cwd === 'string') this.board(header.cwd);
      } catch (err) {
        if (!(err instanceof SyntaxError) && err.code !== 'ENOENT') throw err;
      }
    }
  }

  board(cwd) {
    const k = normDir(cwd);
    let b = this.boards.get(k);
    if (!b) {
      b = new Board(this.dir, cwd);
      this.boards.set(k, b);
      for (const e of b.entries) if (e.kind === 'join' && e.agentId && e.name) this.names.set(e.agentId, e.name);
    }
    return b;
  }

  all() {
    return [...this.boards.values()];
  }

  // From the PreToolUse hook: the next board call with this input comes from this agent.
  expect(key, who) {
    this.rememberName(who);
    const now = Date.now();
    for (const [k, list] of this.pending) {
      const live = list.filter((p) => now - p.at < WHO_TTL_MS);
      if (live.length) this.pending.set(k, live);
      else this.pending.delete(k);
    }
    const list = this.pending.get(key) || [];
    list.push({ who, at: now });
    this.pending.set(key, list);
  }

  // Claude Code writes a subagent's description a moment after SubagentStart, so the name can
  // arrive with any later hook call.
  rememberName(who) {
    const name = who && who.agentId ? clip(who.name, 60) : '';
    if (!name) return;
    this.names.set(who.agentId, name);
    if (this.names.size > 500) this.names.delete(this.names.keys().next().value);
  }

  identify(key) {
    const list = this.pending.get(key);
    if (!list || !list.length) return { known: false, agentId: null, agentType: null, sessionId: null, projectDir: null };
    const { who } = list.shift();
    if (!list.length) this.pending.delete(key);
    return { ...who, known: true };
  }

  entryFrom(who, fields) {
    const name = who.name || (who.agentId && this.names.get(who.agentId)) || null;
    return {
      kind: fields.kind,
      author: labelFor({ ...who, name }),
      known: Boolean(who.known),
      agentId: who.agentId || null,
      agentType: who.agentType || null,
      sessionId: who.sessionId || null,
      ...fields,
    };
  }

  post(board, who, fields) {
    const e = board.add(this.entryFrom(who, fields));
    this.onEntry(board, e);
    return e;
  }

  // Automatic entries from the SubagentStart / SubagentStop hooks.
  lifecycle(cwd, who, kind, summary) {
    const board = this.board(cwd);
    const name = clip(who.name, 60) || null;
    this.rememberName(who);
    const known = { ...who, name: name || undefined, known: true };
    const fields = { kind, text: kind === 'leave' ? clip(summary, 400) : '', ...(kind === 'join' && name ? { name } : {}) };
    const e = this.post(board, known, fields);
    // When a subagent finishes, its open claims are released.
    if (kind === 'leave' && who.agentId) {
      for (const c of board.openClaims().filter((x) => x.agentId === who.agentId)) {
        this.post(board, known, { kind: 'done', claimId: c.id, status: 'released', text: 'Released when the agent finished.' });
      }
    }
    return e;
  }

  clear(cwd) {
    const board = this.board(cwd);
    board.clear();
    this.onClear(board);
  }

  // One MCP tool call. -> { text, isError? }
  act(tool, args, who, cwd) {
    const board = this.board(cwd);
    const me = who.agentId || (who.known ? 'main' : null);
    const mine = (e) => me && (e.agentId || (e.known ? 'main' : null)) === me;
    switch (tool) {
      case 'read_board': {
        const since = Number.isInteger(Number(args.since)) && Number(args.since) > 0 ? Number(args.since) : 0;
        const limitRaw = Number(args.limit);
        const limit = Number.isFinite(limitRaw) && limitRaw >= 1 ? Math.min(Math.floor(limitRaw), 100) : 30;
        const topic = clip(args.topic, 80).toLowerCase();
        let list = board.entries.filter((e) => e.id > since && e.kind !== 'join');
        if (topic) list = list.filter((e) => String(e.topic || '').toLowerCase() === topic);
        const shown = list.slice(-limit);
        const claims = board.openClaims();
        const lines = [`Team board for ${board.cwd}. You are ${labelFor(who)}.`];
        lines.push(claims.length ? 'Open claims:' : 'Open claims: none.');
        for (const c of claims) lines.push(`  #${c.id} ${c.author}${mine(c) ? ' (you)' : ''}: ${c.text}${c.files && c.files.length ? ` [files: ${c.files.join(', ')}]` : ''}`);
        if (!shown.length) lines.push(since ? `Nothing new since #${since}.` : 'No posts yet.');
        else {
          if (list.length > shown.length) lines.push(`(${list.length - shown.length} older entries not shown; pass since or a larger limit.)`);
          lines.push('Entries:');
          for (const e of shown) lines.push(`  ${formatEntry(e, board)}${mine(e) ? ' (you)' : ''}`);
        }
        lines.push(`Latest id: ${board.entries.length ? board.entries[board.entries.length - 1].id : 0}. Pass it as since next time to see only new entries.`);
        return { text: lines.join('\n') };
      }
      case 'post_note': {
        const text = clip(args.text, TEXT_MAX);
        if (!text) return { text: 'Give the note text.', isError: true };
        const kind = NOTE_KINDS.has(args.kind) ? args.kind : 'note';
        const replyTo = Number.isInteger(Number(args.reply_to)) && board.get(Number(args.reply_to)) ? Number(args.reply_to) : null;
        const e = this.post(board, who, { kind, text, topic: clip(args.topic, 80) || null, replyTo });
        return { text: `Posted #${e.id} as ${e.author}.` };
      }
      case 'claim_task': {
        const text = clip(args.task, 400);
        if (!text) return { text: 'Describe the task you are claiming.', isError: true };
        const files = Array.isArray(args.files) ? [...new Set(args.files.map((f) => clip(f, 300)).filter(Boolean))].slice(0, 30) : [];
        const fileKey = (f) => f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
        const want = new Set(files.map(fileKey));
        const same = text.toLowerCase();
        const clash = board.openClaims().find((c) => !mine(c) && (String(c.text).toLowerCase() === same || (c.files || []).some((f) => want.has(fileKey(f)))));
        if (clash && args.force !== true) {
          return { text: `Not claimed: ${clash.author} already claimed #${clash.id} "${clash.text}"${clash.files && clash.files.length ? ` on ${clash.files.join(', ')}` : ''}. Coordinate with post_note (reply_to ${clash.id}), pick another part, or pass force: true to share it.` };
        }
        const e = this.post(board, who, { kind: 'claim', text, files });
        return { text: `Claimed as #${e.id}. When you finish, call complete_task with id ${e.id} and a one-line result.` };
      }
      case 'complete_task': {
        const id = Number(args.id);
        const claim = Number.isInteger(id) ? board.get(id) : null;
        if (!claim || claim.kind !== 'claim') return { text: `There is no claim #${args.id} on this board.`, isError: true };
        if (!board.openClaims().some((c) => c.id === id)) return { text: `Claim #${id} is already closed.` };
        const status = args.status === 'dropped' ? 'dropped' : 'done';
        const e = this.post(board, who, { kind: 'done', claimId: id, status, text: clip(args.result, TEXT_MAX) || (status === 'done' ? 'Done.' : 'Cancelled.') });
        return { text: `Marked #${id} ${status} (#${e.id}).${mine(claim) ? '' : ` It was claimed by ${claim.author}.`}` };
      }
      case 'share_finding': {
        const file = clip(args.file, 400);
        const note = clip(args.note, TEXT_MAX);
        if (!file || !note) return { text: 'Give the file and a note about what you found.', isError: true };
        const line = lineNo(args.line);
        const endLine = line === null ? null : Math.max(line, lineNo(args.end_line) || line);
        const rel = path.isAbsolute(file) ? path.relative(board.cwd, file) : file;
        const shownFile = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.replace(/\\/g, '/') : file;
        const e = this.post(board, who, { kind: 'finding', file: shownFile, line, endLine, text: note, topic: clip(args.topic, 80) || null });
        return { text: `Shared finding #${e.id} on ${shownFile}${line ? `:${line}${endLine !== line ? `-${endLine}` : ''}` : ''}.` };
      }
      default:
        return { text: `Unknown board tool ${tool}`, isError: true };
    }
  }
}

function formatEntry(e, board) {
  const tag = e.topic ? ` [${e.topic}]` : '';
  switch (e.kind) {
    case 'claim':
      return `#${e.id} ${e.author} claimed: ${e.text}${e.files && e.files.length ? ` [files: ${e.files.join(', ')}]` : ''}`;
    case 'done': {
      const c = board && board.get(e.claimId);
      return `#${e.id} ${e.author} ${e.status || 'done'} #${e.claimId}${c ? ` "${c.text}"` : ''}: ${e.text}`;
    }
    case 'finding':
      return `#${e.id} ${e.author} finding${tag} in ${e.file}${e.line ? `:${e.line}${e.endLine && e.endLine !== e.line ? `-${e.endLine}` : ''}` : ''}: ${e.text}`;
    case 'leave':
      return `#${e.id} ${e.author} finished${e.text ? `: ${e.text}` : '.'}`;
    default:
      return `#${e.id} ${e.author} ${e.kind}${tag}${e.replyTo ? ` (re #${e.replyTo})` : ''}: ${e.text}`;
  }
}

module.exports = { Boards, Board, callKey, stable, labelFor, formatEntry, normDir, BOARD_TOOLS: ['read_board', 'post_note', 'claim_task', 'complete_task', 'share_finding'] };
