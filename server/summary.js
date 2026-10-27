'use strict';
// Per-session summary for the mod's line and Details pane. Unknown values are null, never NaN.

const { LARGE_WINDOW } = require('./usage');

const MAX_AGENTS = 40;

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

function sum(values) {
  const known = values.map(num).filter((v) => v !== null);
  const total = known.length ? known.reduce((a, b) => a + b, 0) : null;
  return Number.isFinite(total) ? total : null; // a sum past the largest number is unknown
}

// Subagents of one session, from the chat events in the history.
function agentsOf(history, sessionId) {
  const byKey = new Map();
  for (const ev of history) {
    if (ev.type !== 'chat' || (sessionId && ev.sessionId !== sessionId)) continue;
    if (ev.role !== 'agent-start' && ev.role !== 'agent-step' && ev.role !== 'agent-done') continue;
    const key = ev.toolUseId || (ev.agentId ? 'a:' + ev.agentId : null);
    if (!key) continue;
    let a = byKey.get(key);
    if (!a) {
      a = { key, agentId: null, name: null, type: null, status: 'working', model: null, tokens: null, ctx: null, out: new Map(), toolCalls: 0, startedAt: ev.ts || null, endedAt: null };
      byKey.set(key, a);
    }
    if (ev.agentId) a.agentId = ev.agentId;
    if (ev.role === 'agent-start') {
      a.name = ev.description || a.name;
      a.type = ev.agentType || a.type;
      if (ev.ts) a.startedAt = ev.ts;
    } else if (ev.role === 'agent-step') {
      a.type = a.type || ev.agentType || null;
      if (ev.model) a.model = ev.model;
      if (num(ev.ctx) !== null) a.ctx = ev.ctx;
      if (ev.msgId && num(ev.out) !== null) a.out.set(ev.msgId, ev.out);
      if (ev.kind === 'tool') a.toolCalls++;
    } else {
      a.status = ev.status === 'failed' ? 'failed' : 'done';
      if (num(ev.tokens) !== null) a.tokens = ev.tokens;
      if (num(ev.toolCount) !== null) a.toolCalls = ev.toolCount;
      a.endedAt = ev.ts || null;
    }
  }
  return [...byKey.values()].map((a) => {
    const written = sum([...a.out.values()]);
    // Claude Code's own total once the subagent is done; until then, its context plus what it wrote.
    const both = a.ctx === null && written === null ? null : (a.ctx || 0) + (written || 0);
    const soFar = Number.isFinite(both) ? both : null; // a sum past the largest number is unknown
    return {
      key: a.key, agentId: a.agentId, name: a.name, type: a.type, status: a.status, model: a.model,
      // Subagents run at the main agent's level (Claude Code doesn't report one of their own).
      effort: { inherited: true },
      tokens: a.tokens !== null ? a.tokens : soFar, tokensFinal: a.tokens !== null,
      context: a.ctx, toolCalls: a.toolCalls, startedAt: a.startedAt, endedAt: a.endedAt,
    };
  });
}

// usage: the latest usage snapshot of the session (server/usage.js), or null.
// effort: the main agent's (lib/effort.js shape: page control's, else the terminal's own);
// effortHere: the terminal session's own; tasks: running tasks with their effort.
function summarize({ sessionId, cwd, version, claudeState, driver, mode, usage, pages, history, rootMatches, connection, integrations, pageControl, pageControlError, pairing, paired, display, effort, effortHere, tasks }) {
  const control = Boolean(driver && driver.active && (!cwd || !driver.cwd || rootMatches(driver.cwd, cwd)));
  // In page control the work happens in the copy the panel runs; show that one.
  const target = control && driver.sessionId ? driver.sessionId : sessionId || null;
  let state = 'unknown';
  if (control) state = driver.phase === 'signin' ? 'signin' : driver.working ? 'working' : driver.phase === 'starting' ? 'starting' : 'idle';
  else if (claudeState && claudeState.sessionId && claudeState.sessionId === target) state = claudeState.state || 'unknown';
  const agents = agentsOf(history || [], target);
  const running = agents.filter((a) => a.status === 'working').length;
  const u = usage || null;
  const t = u && u.totals ? u.totals : null;
  const mainTotal = t ? sum([t.input, t.cacheRead, t.cacheCreate, t.output]) : null;
  const agentTotal = sum(agents.map((a) => a.tokens));
  const subagentReported = t ? num(t.subagentTokens) : null;
  // The window of the model chosen in Claude Code ([1m] = 1M) when nothing else is known yet
  // (no NaN: unknown stays null).
  const ctx = u && u.context ? u.context : null;
  const chosen = String((control && driver.model) || (u && u.model) || '');
  const big = /\[1m\]$/i.test(chosen) && (!ctx || !ctx.windowSource);
  const used = ctx ? num(ctx.used) : null;
  const win = big ? LARGE_WINDOW : ctx ? num(ctx.window) : null;
  const winSource = big ? 'model' : ctx ? ctx.windowSource || null : null;
  const open = (pages || []).filter((p) => !cwd || !p.root || rootMatches(p.root, cwd));
  return {
    live: true,
    version: version || null,
    sessionId: target,
    control: control ? 'page' : 'manual',
    state,
    mode: (control ? driver.mode : mode) || null,
    model: (control && driver.model) || (u && (u.modelName || u.model)) || null,
    effort: effort && typeof effort === 'object' ? effort : null,
    effortHere: effortHere && typeof effortHere === 'object' ? effortHere : null,
    tasks: Array.isArray(tasks) ? tasks.slice(0, 20) : [],
    pages: open.slice(0, 10).map((p) => ({ url: p.url || null, title: p.title || null })),
    pageCount: open.length,
    agents: agents.slice(-MAX_AGENTS),
    agentCount: agents.length,
    agentsRunning: running,
    tokens: {
      context: u && u.context ? num(u.context.used) : null,
      window: win,
      windowSource: winSource,
      percent: u && u.context ? (big && used !== null ? Math.min(100, (used / LARGE_WINDOW) * 100) : num(u.context.percent)) : null,
      main: mainTotal,
      // Subagents: finished ones as Claude Code counts them, or EditLens's count (it includes running ones).
      subagents: subagentReported === null ? agentTotal : agentTotal === null ? subagentReported : Math.max(subagentReported, agentTotal),
      costUSD: u ? num(u.costUSD) : null,
    },
    permissions: control && Array.isArray(driver.permissions) ? driver.permissions.length : 0,
    // Connections made by /editlens, and EditLens lines found in project files.
    connection: connection ? { kind: connection.kind, url: connection.url || null } : null,
    integrations: Array.isArray(integrations) ? integrations.slice(0, 20) : [],
    // Can page control start? signedIn: null = not checked yet.
    pageControl: control
      ? { installed: true, signedIn: driver.phase === 'signin' ? false : true }
      : pageControl ? { installed: Boolean(pageControl.installed), signedIn: typeof pageControl.signedIn === 'boolean' ? pageControl.signedIn : null } : null,
    // Why page control stopped, when it stopped with an error in the last 30 minutes.
    pageControlError: !control && typeof pageControlError === 'string' ? pageControlError : null,
    // Pairing messages for this computer: [{ id, at, text }] from the last 10 minutes.
    pairing: Array.isArray(pairing) ? pairing.slice(-5) : [],
    paired: paired && typeof paired === 'object' ? paired : null,
    // Surfaces the mod reported in the last minute (null: no report).
    display: display && typeof display === 'object' ? { surfaces: display.surfaces || [], drawn: display.drawn || [], at: display.at || null } : null,
  };
}

module.exports = { summarize, agentsOf };
