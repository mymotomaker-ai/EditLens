'use strict';
// Permission questions from Claude Code's own window, added by the PermissionRequest hook. The page
// lists them but never answers them: the page is the app Claude edits, so it could approve its own requests.
// Removed when the tool call ends, the agent or session stops, a new prompt is sent, or after 15 min.
const crypto = require('crypto');
const { describeTool } = require('./driver');

const MAX = 100;
const STALE_MS = 15 * 60000;

function fingerprint(tool, input) {
  let text;
  try {
    text = JSON.stringify(input === undefined ? null : input);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err; // a cycle: never from JSON hook input
    text = '';
  }
  return crypto.createHash('sha1').update(`${tool}\0${text}`).digest('hex');
}

class Asks {
  // emit(event): sends to the pages of event.cwd's project.
  constructor({ emit, log }) {
    this.emit = emit || (() => {});
    this.log = log || (() => {});
    this.items = new Map(); // id -> question
  }

  // body: { sessionId, agentId, agentType, cwd, tool, input } -> the question, or null
  add(body) {
    this.sweep();
    const tool = typeof body.tool === 'string' && body.tool ? body.tool.slice(0, 200) : null;
    const cwd = typeof body.cwd === 'string' && body.cwd ? body.cwd : null;
    if (!tool || !cwd) return null;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
    const agentId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null;
    const fp = fingerprint(tool, body.input);
    // The same question asked again.
    for (const q of this.items.values()) if (q.sessionId === sessionId && q.agentId === agentId && q.fp === fp) return q;
    const d = describeTool(tool, body.input && typeof body.input === 'object' ? body.input : {});
    const q = {
      id: crypto.randomBytes(6).toString('hex'), sessionId, agentId, agentType: typeof body.agentType === 'string' ? body.agentType.slice(0, 120) : null,
      cwd, tool, fp, title: d.title, detail: d.detail || null, note: d.note || null, ts: Date.now(),
    };
    this.items.set(q.id, q);
    while (this.items.size > MAX) this.drop(this.items.keys().next().value, 'stale');
    this.emit(this.card(q));
    return q;
  }

  card(q) {
    return { type: 'ask', id: q.id, sessionId: q.sessionId, agentId: q.agentId, agentType: q.agentType, cwd: q.cwd, tool: q.tool, title: q.title, detail: q.detail, note: q.note, ts: q.ts };
  }

  drop(id, why) {
    const q = this.items.get(id);
    if (!q) return;
    this.items.delete(id);
    this.emit({ type: 'ask-done', id, cwd: q.cwd, sessionId: q.sessionId, why });
  }

  // A tool call ended: removes the question for that call, else the oldest for that tool from the
  // same agent.
  done(body) {
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
    const agentId = typeof body.agentId === 'string' && body.agentId ? body.agentId : null;
    const tool = typeof body.tool === 'string' ? body.tool : '';
    const same = [...this.items.values()].filter((q) => q.sessionId === sessionId && q.agentId === agentId && q.tool === tool);
    if (!same.length) return 0;
    const fp = fingerprint(tool, body.input);
    const q = same.find((x) => x.fp === fp) || same[0];
    this.drop(q.id, 'answered');
    return 1;
  }

  // The agent stopped (agentId), or the whole session did (agentId undefined).
  clear(sessionId, agentId) {
    let n = 0;
    for (const q of [...this.items.values()]) {
      if (q.sessionId !== sessionId) continue;
      if (agentId !== undefined && q.agentId !== agentId) continue;
      this.drop(q.id, 'ended');
      n++;
    }
    return n;
  }

  sweep() {
    const now = Date.now();
    for (const q of [...this.items.values()]) if (now - q.ts > STALE_MS) this.drop(q.id, 'stale');
  }

  list(match) {
    this.sweep();
    return [...this.items.values()].filter((q) => match(q.cwd)).map((q) => this.card(q));
  }
}

module.exports = { Asks, fingerprint, STALE_MS };
