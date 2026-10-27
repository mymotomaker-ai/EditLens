#!/usr/bin/env node
'use strict';
// EditLens server. Receives events from the Claude Code hooks and the page-pointer
// MCP tool, follows session transcripts, keeps messages typed on the page for Claude, and
// sends everything live to connected pages through Server-Sent Events. No dependencies.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { writeAtomic } = require('../lib/atomic');
const pageRunsLib = require('../lib/pageruns');
const { SessionStore, resumeCommand, titleOf } = require('../lib/sessionstore');
const pagekeep = require('../lib/pagekeep');
const sendproject = require('../lib/sendproject');
const { newer } = require('../lib/client');
const crypto = require('crypto');
const config = require('../lib/config');
const { PRODUCT_NAME } = require('../lib/name');
const { SessionWatcher } = require('./transcript');
const { related, within, tooBroad, normalize } = require('../lib/paths');
const safepath = require('../lib/safepath');
const worktree = require('../lib/worktree');
const ccsettings = require('../lib/ccsettings');
const { classify } = require('../lib/classify');
const { diffText, clampHunks, countStats } = require('../lib/diff');
const { buildHints } = require('../lib/hints');
const { SnapshotStore } = require('./snapshots');
const { NAME_RE } = require('../lib/commands');
const { resolveRef } = require('../lib/fileref');
const { routesFor } = require('../lib/routes');
const { Boards, BOARD_TOOLS } = require('./board');
const { BackupStore, skipReason, readNow } = require('./backups');
const { createUndo, seqOf, viaFor } = require('./undo');
const { createHostRestore, createRemoteRestore, BACKUP_ID } = require('./remote-restore');
const { summarize } = require('./summary');
const { SummaryWatch, sinceParam, waitParam } = require('./summary-wait');
const { Connector, cleanWrappers } = require('./connector');
const { PairHost, loginName, addresses } = require('./pair-host');
const { canOpenBrowser, openAdvice, answerAddress } = require('../lib/browser');
const { PairRemotes, keepsKey, updateText } = require('./pair-remote');
const { findIntegrations } = require('../lib/connect');
const attachments = require('../lib/attachments');
const screenshots = require('../lib/screenshots');
const modes = require('../lib/modes');
const { Driver, isClaudeProgram, sdkEntry, plainExit } = require('./driver');
const { Tasks } = require('./tasks');
const { Asks } = require('./asks');
const { AnswerDesk, LOOSE_MODES } = require('./answer');
const { cleanName, controlArgs, knownKey } = require('../lib/pairwire');
const settingsLib = require('../lib/settings');
const taskuser = require('../lib/taskuser');
const { peerUid, pidUid, canTell } = require('../lib/peeruid');
const OWN_UID = typeof process.getuid === 'function' ? process.getuid() : null;
const otherUsers = new Set(); // uids refused, logged once each
// D21: where the account of a connection can't be told, pages need this user's page key.
const pagekey = require('../lib/pagekey');
const KEY_ASK = 'Open this page once from Claude Code: /editlens';
const KEY_WINDOW = 'Open the EditLens window from your page\'s panel. If the panel asks for it, open your page once from Claude Code: /editlens';
let unknownSeen = false; // a connection whose account couldn't be told came, since this server started
let PAGE_KEY = null;
function userPageKey() {
  if (!PAGE_KEY) PAGE_KEY = pagekey.pageKey(config.stateDir, config.port);
  return PAGE_KEY;
}
// Whether page addresses /editlens opens or prints need the page key: on macOS and Windows, and on
// Linux once a connection came whose account couldn't be told (WSL, for example).
function keysNeeded() {
  return OWN_UID === null || !canTell() || unknownSeen;
}
const { localHost } = require('../lib/localhost');
const { trimLog, LOG_MAX } = require('../lib/logtrim');

const { clientScript } = require('../lib/client-script');
const effortLib = require('../lib/effort');
const remotework = require('../lib/remotework');
const MAX_BODY = 6 * 1024 * 1024; // an edit event: file text before (2 MB) and after (512 KB), escaped
const HEARTBEAT_MS = 15000;
const REPLAY_EVENTS = 120;
const MAX_SESSIONS = 8;
const MESSAGE_MAX = 4000;
const WAIT_MAX_MS = 30000;
const LISTEN_STALE_MS = 35000;

fs.mkdirSync(config.stateDir, { recursive: true });
const token = crypto.randomBytes(24).toString('hex');

const history = [];
let historyBytes = 0;
const HISTORY_BYTES = 16 * 1024 * 1024; // kept events, at most
const REPLAY_BYTES = 4 * 1024 * 1024; // sent to a page that just opened, at most
function jsonBytes(v) {
  try {
    return Buffer.byteLength(JSON.stringify(v));
  } catch (err) {
    if (err instanceof TypeError) return 0; // a cycle: never from JSON input
    throw err;
  }
}
const clients = new Map(); // event stream -> { pair } (pair: the paired computer it came through, or null)
const pages = new Map(); // pageId -> { id, url, title, root, listen, res }
const sessions = new Map(); // sessionId -> SessionWatcher
const modDisplay = new Map(); // sessionId -> { surfaces, drawn, at } from the mod inside Claude Code
// A dev server /editlens found but couldn't confirm is this project's: the mod offers a one-click
// Connect for it (the click is the user's confirmation). project folder -> { cwd, url, at }
const connectHints = new Map();
const HINT_MS = 30 * 60000;
const HINT_URL = /^http:\/\/localhost:\d{2,5}$/;
function connectHint(cwd) {
  if (!cwd) return null;
  for (const h of connectHints.values()) {
    if (Date.now() - h.at < HINT_MS && rootMatches(h.cwd, cwd)) return h.url;
  }
  return null;
}
// The summary GET /summary sends for one session and project folder.
function summaryBody(sessionId, cwd) {
  const ds = driver.status();
  const target = ds.active && ds.sessionId && (!cwd || !ds.cwd || rootMatches(ds.cwd, cwd)) ? ds.sessionId : sessionId;
  const usageEv = target ? latestVolatile.get(`usage:${target}`) : null;
  const modeEv = target ? latestVolatile.get(`mode:${target}`) : null;
  const control = ds.active && (!cwd || !ds.cwd || rootMatches(ds.cwd, cwd));
  return { ...summarize({
    // Page control's level (EditLens sets it), else the terminal session's own (read only).
    effort: control ? ds.effort || null : terminalEffort(sessionId),
    // This terminal's own level, also while page control runs (the Details row, Effort here).
    effortHere: terminalEffort(sessionId),
    // Running tasks and ones that ended in the last 30 minutes (agent chips, Details, Agents).
    tasks: agentTasks(cwd),
    sessionId, cwd, version: config.version, claudeState, driver: ds, mode: modeEv ? modeEv.mode : null,
    usage: usageEv || null, pages: [...pages.values()].map(({ res: _res, ...p }) => p), history, rootMatches,
    connection: cwd ? connector.list().find((c) => rootMatches(c.cwd, cwd)) || null : null, integrations: integrationsOf(cwd),
    pageControl: driver.readiness(),
    pageControlError: (() => { const e = ds.lastError; return e && Date.now() - e.at < 30 * 60000 && (!cwd || rootMatches(e.cwd, cwd)) ? e.error : null; })(),
    pairing: pairNotices.filter((n) => Date.now() - n.at < 10 * 60000),
    // here: the pairing is for this folder (a paired computer sees only its own folder's page).
    // waiting: a pairing code from /editlens pair in this folder is open (gone once it is used).
    paired: pairedSummary(cwd),
    display: sessionId ? modDisplay.get(sessionId) || null : null,
  }), ...taskNotices(cwd), connectHint: connectHint(cwd), settingsPending: pendingSettings(), openFrom: openFrom(cwd),
  // The name people gave page control's conversation here (Main in Details and the agents list).
  mainName: control && ds.sessionId ? sessionStore.name(`pc:${ds.sessionId}`) : null,
  // A newer EditLens is installed than this server, and what it waits for (null: nothing).
  ...(installedVersion ? { installed: installedVersion, updateBusy: busyReason() } : {}) };
}
// Tasks that wait or did not start, here (asked by a paired computer) and on paired computers
// (asked from here), newest first: the line above the prompt and Details show them.
function taskNotices(cwd) {
  const list = [...tasks.notices(cwd, rootMatches), ...laptopNotices(cwd)].sort((a, b) => b.at - a.at);
  return { tasksWaiting: list.filter((n) => n.state === 'waiting').length, taskNotices: list.slice(0, 5) };
}

// Tasks for the agents list in Details and /editlens agents: this project's tasks on paired
// computers (where: 'there') and paired computers' tasks running here (where: 'here'). Running ones,
// and the ones that ended in the last 30 minutes, newest first, at most 10. Never an id in a name:
// key and task are for Follow and Stop only.
const AGENT_TASK_MS = 30 * 60000;
// The effort fields a task card includes ({ level, used, supported, cap, source } or { inherited }),
// kept short and of the right types; null when there are none.
function effortField(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (e.inherited === true) return { inherited: true };
  const word = (v) => (typeof v === 'string' && /^[A-Za-z0-9 ._-]{1,30}$/.test(v) ? v : null);
  const out = { level: word(e.level), used: word(e.used), supported: typeof e.supported === 'boolean' ? e.supported : null, cap: word(e.cap), source: word(e.source) };
  return out.level || out.used || out.supported === false ? out : null;
}
// A time in ms from a file or another computer's answer: a finite number above 0, else null.
function timeOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function agentTasks(cwd) {
  const out = [];
  const recent = (state, at) => !MIRROR_DONE.has(state) || Date.now() - (timeOf(at) || 0) < AGENT_TASK_MS;
  const text = (v, n) => (typeof v === 'string' && v ? v.slice(0, n) : null);
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);
  const hosts = pairRemotes.status().hosts;
  for (const f of remote.computers.values()) {
    const host = hosts.find((h) => h.name === f.name || h.name === f.key) || (hosts.length === 1 ? hosts[0] : null);
    for (const [id, t] of f.tasks) {
      const dir = f.dirs.get(id);
      if (!dir || (cwd && !rootMatches(dir, cwd)) || !recent(t.state, t.updatedAt)) continue;
      out.push({ key: `r:${f.name}:${id}`, task: id, where: 'there', computer: f.name, login: host && host.login ? host.login : null, name: sessionStore.name(`r:${f.name}:${id}`),
        kind: t.kind === 'sent' ? 'mine' : 'theirs', inCopy: t.kind === 'copy', prompt: text(t.prompt, 200), state: text(t.state, 20), waiting: count(t.waiting),
        editCount: count(t.editCount), startedAt: timeOf(t.startedAt), model: text(t.model, 80), mode: text(t.mode, 30), effort: effortField(t.effort) });
    }
  }
  for (const t of tasks.items.values()) {
    if (!t.by || (cwd && !rootMatches(t.cwd, cwd)) || !recent(t.state, t.updatedAt)) continue;
    out.push({ key: `t:${t.id}`, task: t.id, where: 'here', computer: String(t.by).slice(0, 100), login: null, name: sessionStore.name(`task:${t.id}`),
      kind: t.kind === 'sent' ? 'sent' : t.copy ? 'copy' : 'shared', prompt: text(t.prompt, 200), state: text(t.state, 20), waiting: t.permissions ? t.permissions.size : 0,
      editCount: count(t.editCount), startedAt: timeOf(t.startedAt), model: text(t.model, 80), mode: text(t.mode, 30), effort: effortField(tasks.effortOf(t)) });
  }
  return out.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, 10);
}

// ---------- the Sessions list ----------
// Page control's conversations and this project's tasks, grouped: this computer first, then one group
// per paired computer. Each row says how to continue it in Claude Code (cd "<folder>" && claude --resume
// <id>); nothing here starts or answers anything. Times are numbers; the page and terminal format them.
const SESSION_ROWS = 15; // per group
const TASK_STATE_WORDS = new Set(['waiting', 'starting', 'working', 'idle', 'ended', 'stopped', 'failed', 'refused']);
function sessionsList(cwd) {
  const here = [];
  const ds = driver.status();
  const pageHere = ds.active && (!cwd || !ds.cwd || rootMatches(ds.cwd, cwd));
  const pageState = () => (ds.permissions && ds.permissions.length ? 'asking' : ds.phase === 'starting' ? 'starting' : ds.phase === 'signin' ? 'signin' : ds.working ? 'working' : 'idle');
  // Page control on, before Claude said its conversation's id (it says it with the first reply).
  if (pageHere && !ds.sessionId) {
    here.push({ key: 'pc:new', kind: 'page', name: 'Page control', ownName: 'Page control', renamed: false, state: pageState(), running: true, current: true,
      how: 'Page control', model: ds.model || null, effort: ds.effort ? ds.effort.level || null : null, mode: ds.mode || null, startedAt: null, at: null, folder: ds.cwd || cwd || null, sessionId: null, command: null, follow: 'main' });
  }
  for (const r of sessionStore.pageRuns(cwd, rootMatches)) {
    const live = pageHere && ds.sessionId === r.id;
    if (live) sessionStore.pageInfo(r.id, { model: ds.model, effort: ds.effort && ds.effort.level, mode: ds.mode });
    const key = `pc:${r.id}`;
    const own = r.title || 'Page control session';
    here.push({ key, kind: 'page', name: sessionStore.name(key) || own, ownName: own, renamed: Boolean(sessionStore.name(key)), state: live ? pageState() : 'stopped', running: live, current: live,
      how: 'Page control', model: r.model, effort: r.effort, mode: r.mode, startedAt: r.startedAt, at: live ? null : r.endedAt || r.startedAt,
      folder: r.cwd, sessionId: r.id, command: resumeCommand(r.cwd, r.id), follow: live ? 'main' : null });
    if (here.length >= SESSION_ROWS) break;
  }
  const word = (v) => (typeof v === 'string' && TASK_STATE_WORDS.has(v) ? v : 'ended');
  const slotsHere = tasks.slots();
  const taskRows = [...tasks.items.values()].filter((t) => t.by && (!cwd || rootMatches(t.cwd, cwd)))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).slice(0, SESSION_ROWS).map((t) => {
      const key = `task:${t.id}`;
      const own = titleOf(t.prompt) || `Task from ◆ ${t.by}`;
      const asks = t.permissions ? t.permissions.size : 0;
      const st = word(t.state);
      const where = t.kind === 'sent' ? `copy of ◆ ${t.by}'s project` : t.copy ? 'copy of this project' : 'this project';
      return { key, kind: 'here', computer: String(t.by).slice(0, 100), name: sessionStore.name(key) || own, ownName: own, renamed: Boolean(sessionStore.name(key)),
        state: asks ? 'asking' : st, running: Boolean(asks) || ['waiting', 'starting', 'working'].includes(st), how: `Task from ◆ ${String(t.by).slice(0, 100)} · ${where}`,
        model: t.model || null, effort: t.effort && effortLib.isLevel(t.effort.level) ? t.effort.level : null, mode: t.mode || null, startedAt: t.startedAt || null, at: t.updatedAt || null,
        folder: t.dir || null, sessionId: t.sessionId || null, command: resumeCommand(t.dir, t.sessionId, t.account), follow: key, slots: st === 'waiting' ? slotsHere : null };
    });
  here.push(...taskRows);
  const groups = [{ key: 'here', computer: null, title: 'This computer', rows: here }];
  for (const f of remote.computers.values()) {
    const rows = [];
    for (const [id, t] of f.tasks) {
      const dir = f.dirs.get(id);
      if (!dir || (cwd && !rootMatches(dir, cwd))) continue;
      const key = `r:${f.name}:${id}`;
      const own = titleOf(t.prompt) || `Task on ◆ ${f.name}`;
      const asks = Number.isSafeInteger(t.waiting) && t.waiting > 0 ? t.waiting : 0;
      const st = word(t.state);
      const mine = t.kind === 'sent';
      rows.push({ key, kind: 'there', computer: f.name, name: sessionStore.name(key) || own, ownName: own, renamed: Boolean(sessionStore.name(key)),
        state: asks ? 'asking' : st, running: Boolean(asks) || ['waiting', 'starting', 'working'].includes(st), how: `Task · ${mine ? 'copy of this project' : t.kind === 'copy' ? 'copy of its project' : 'its own project'}`,
        model: typeof t.model === 'string' ? t.model.slice(0, 80) : null, effort: t.effort && effortLib.isLevel(t.effort.level) ? t.effort.level : null, mode: typeof t.mode === 'string' ? t.mode.slice(0, 30) : null,
        startedAt: timeOf(t.startedAt), at: timeOf(t.updatedAt), folder: typeof t.dir === 'string' ? t.dir.slice(0, 1000) : null,
        sessionId: typeof t.sessionId === 'string' ? t.sessionId : null, command: resumeCommand(t.dir, t.sessionId, t.account), follow: key, slots: st === 'waiting' ? f.slots || null : null });
    }
    if (!rows.length) continue;
    rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    groups.push({ key: `r:${f.name}`, computer: f.name, title: `◆ ${f.name}`, rows: rows.slice(0, SESSION_ROWS), slots: f.slots || null });
  }
  groups[0].slots = slotsHere;
  const all = groups.flatMap((g) => g.rows);
  // The names people gave them, by the keys the page's chips use ('main': page control now).
  const names = {};
  for (const r of all) {
    if (!r.renamed) continue;
    names[r.key] = r.name;
    if (r.kind === 'page' && r.current) names.main = r.name;
  }
  // running: live ones that have started; waiting: not started yet (both have Stop).
  const waiting = all.filter((r) => r.running && r.state === 'waiting').length;
  return { groups, total: all.length, running: all.filter((r) => r.running).length - waiting, waiting, names };
}

// Pages of that project fetch the list again (a name changed, page control started or ended).
function sessionsChanged(cwd) {
  broadcastVolatile({ type: 'sessions-changed', sessionId: 'sessions-changed', cwd: cwd || null });
}

// Stop by name (/editlens stop <name>) or by key (the terminal's Sessions pane), only a running one,
// the same way as its own Stop: page control switches to Manual, a task stops. -> answer body
async function stopSession(cwd, { key, name }) {
  const rows = sessionsList(cwd).groups.flatMap((g) => g.rows);
  let row = null;
  if (typeof key === 'string' && key) row = rows.find((r) => r.key === key) || null;
  else {
    const want = String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!want) return { status: 400, body: { error: 'Name the session to stop.' } };
    const named = rows.filter((r) => r.name.toLowerCase() === want);
    const live = named.filter((r) => r.running);
    if (live.length > 1) return { status: 409, body: { error: `${live.length} running sessions are named "${named[0].name}". Rename one, then try again.`, choices: live.map((r) => r.name) } };
    row = live[0] || named[0] || null;
    if (!row) return { status: 404, body: { error: `No session here is named "${String(name).trim().slice(0, 60)}".`, running: rows.filter((r) => r.running).map((r) => r.name).slice(0, 10) } };
  }
  if (!row) return { status: 404, body: { error: 'That session is not in the list any more.' } };
  if (!row.running) return { status: 409, body: { error: `"${row.name}" is not running.`, name: row.name } };
  if (row.kind === 'page') {
    clearAutoWant('stopped from Claude Code');
    forgetKept('/editlens stop <name>');
    const done = driver.stop('stopped from Claude Code');
    return { status: done && done.error ? 409 : 200, body: { ...done, stopped: row.name, kind: 'page' } };
  }
  if (row.kind === 'here') {
    const t = tasks.byId(row.key.slice(5));
    if (!t) return { status: 404, body: { error: 'That task is not here any more.' } };
    log(`task ${t.id}: stopped from Claude Code (by name)`);
    tasks.stopTask(t);
    return { status: 200, body: { ok: true, stopped: row.name, kind: 'here' } };
  }
  const f = remote.computers.get(computerKey(row.computer)) || [...remote.computers.values()].find((x) => x.name === row.computer);
  const id = row.key.slice(row.key.lastIndexOf(':') + 1);
  if (!f) return { status: 404, body: { error: `◆ ${row.computer} is not paired any more.` } };
  log(`task ${id} on ${f.name}: stopped from Claude Code (by name)`);
  const done = await pairRemotes.task(f.key, { op: 'stop', task: id });
  return { status: done && done.error ? 409 : 200, body: done && done.error ? done : { ok: true, stopped: row.name, kind: 'there' } };
}

// The paired computers for the line above the prompt and Details.
function pairedSummary(cwd) {
  const host = pairHost.status();
  const w = host.waiting;
  return {
    host: host.pairs.map((p) => ({ name: p.name, connected: p.connected, here: cwd ? rootMatches(p.cwd, cwd) : null, folder: path.basename(p.cwd), lastSeen: p.lastSeen })),
    // unreachable: the computers are connected but its edits can't be fetched (the follow loop keeps trying).
    joined: pairRemotes.status().hosts.map((h) => {
      const down = followDown(h.name);
      const state = h.state === 'connected' && down ? 'unreachable' : h.state;
      return { name: h.name, state, url: h.url, error: state === 'connected' ? null : (down && down.error) || h.error || null };
    }),
    waiting: w && (!cwd || rootMatches(w.cwd, cwd)) ? { minutesLeft: w.minutesLeft, id: w.id } : null,
  };
}

// No browser can open on this computer (a VPS through SSH): how the user opens the page from
// their own computer, for the line above the prompt and Details. null when a browser opens here.
const browserHere = canOpenBrowser();
function answerUrl() {
  return answerAddress({ port: config.port, browser: browserHere, user: loginName(), addresses: addresses(), key: knownKey(pairHost.status().pairs) });
}
function openFrom(cwd) {
  if (browserHere.ok || !cwd) return null;
  const c = connector.list().find((x) => x.url && rootMatches(x.cwd, cwd));
  if (!c) return null;
  const advice = openAdvice({ browser: browserHere, cwd, pairs: pairHost.status().pairs, pageUrl: c.url, livePort: config.port, user: loginName(), addresses: addresses() });
  // The address to open there, with the page key where pages need it (D21), as /editlens prints it.
  if (advice && advice.url && keysNeeded()) advice.url = pagekey.keyedUrl(advice.url, userPageKey());
  return advice;
}
// The mod's waiting requests. Checked again after events to pages (fanOut), page control, pages that open
// or close, paired computers and every POST; the rest (files, times) is checked every few seconds.
const summaryWatch = new SummaryWatch(summaryBody);
const messages = []; // messages typed on a page: { id, text, pageId, root, status, ts }
const waiters = new Set(); // pending /messages/wait requests
const reports = new Map(); // pointId -> [{ pageId, url, results }]
const snapshots = new SnapshotStore();
let listenState = { active: false, until: 0, lastWait: 0 };
let claudeState = { state: 'unknown', canListen: null, sessionId: null, cwd: null };
let seq = 0;
const INSTANCE = crypto.randomBytes(8).toString('hex');
let fileViews = 0;
let lastActivity = Date.now();

function log(...args) {
  process.stdout.write(`[${new Date().toISOString()}] ${args.join(' ')}\n`);
}

// Only respond to requests addressed to localhost: blocks DNS-rebinding attacks.
function hostAllowed(req) {
  return localHost(req.headers.host);
}

// Pages on localhost (any port) may use the server; other sites may not, because events
// include source code and page messages become instructions for Claude.
function originAllowed(origin) {
  if (!origin) return true;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|[\w-]+\.localhost)(:\d+)?$/i.test(origin)) return true;
  return config.extraOrigins.includes(origin);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  if (!origin || !originAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-editlens-token, Last-Event-ID',
    Vary: 'Origin',
  };
}

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(data);
}

// An expected refusal: the request handler's catch sends `status` with the message and logs one
// line, no stack.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const TOO_LARGE = 'The request is too large.';

// A body over MAX_BODY is read to its end and removed, so the client gets the 413 (a connection cut
// mid-upload gets a reset instead); past four times the limit the connection is closed.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY * 4) {
        req.destroy();
        reject(new HttpError(413, TOO_LARGE));
        return;
      }
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on('end', () => (size > MAX_BODY ? reject(new HttpError(413, TOO_LARGE)) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

// Raw bytes, at most `max`: a larger body is read to its end and removed (so the page gets the
// refusal message), or the connection is closed past four times the limit.
function readBuffer(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max * 4) {
        req.destroy();
        reject(new HttpError(413, TOO_LARGE));
        return;
      }
      if (size <= max) chunks.push(chunk);
    });
    req.on('end', () => resolve(size > max ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  try {
    const body = JSON.parse(await readBody(req));
    return body && typeof body === 'object' ? body : null;
  } catch (err) {
    if (err instanceof SyntaxError) return null;
    throw err;
  }
}

// The id names this server's start too ("<instance>.<seq>"), so a page that reconnects to a
// restarted server is seen as new (its backlog comes marked replay), whatever its old number.
function frame(event) {
  return `id: ${INSTANCE}.${event.seq}\nevent: claude\ndata: ${JSON.stringify(event)}\n\n`;
}

// A page that stops reading (frozen tab, paused debugger) is disconnected once 4 MB is waiting for it,
// so the server doesn't keep every event for it in memory. It reconnects later.
const SLOW_CLIENT_BYTES = 4 * 1024 * 1024;
function push(res, text) {
  if (res.destroyed) return;
  if (res.writableLength > SLOW_CLIENT_BYTES) {
    log('closing a page that stopped reading its events');
    res.destroy();
    return;
  }
  res.write(text);
}

// A paired computer's connection sees only the project it was paired for (server/pair-host.js
// sets it). Pages on this computer see every project.
// Which project an event belongs to: its folder; null when it belongs to none (settings, the
// listen state); false when it belongs to one that can't be told (shown to no paired page).
function eventCwd(ev) {
  if (typeof ev.taskCwd === 'string' && ev.taskCwd) return ev.taskCwd;
  if (typeof ev.cwd === 'string' && ev.cwd) return ev.cwd;
  if (typeof ev.root === 'string' && ev.root) return ev.root;
  const w = typeof ev.sessionId === 'string' && ev.sessionId ? sessions.get(ev.sessionId) : null;
  if (w && w.cwd) return w.cwd;
  if (typeof ev.file === 'string' && ev.file) return path.dirname(ev.file);
  return ev.sessionId || ev.agentId ? false : null;
}
// The files an event names on this computer (an edit made on a paired computer names its files there).
function eventFiles(ev) {
  if (!ev || ev.remote) return [];
  const out = typeof ev.file === 'string' && ev.file ? [ev.file] : [];
  if (Array.isArray(ev.files)) for (const f of ev.files.slice(0, 2000)) if (typeof f === 'string' && f) out.push(f);
  return out;
}
// A file of the paired folder: the folder or one inside it, where it really leads (links resolved),
// never a file of a project folder above it (Sol H1).
function pairHasFile(pair, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return false;
  const rel = path.relative(pair.cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return !safepath.inside(pair.cwd, rel).error;
}
// A folder of the paired project: the paired folder or one inside it, where it really leads (links
// resolved). Never a folder above it: chat, page control, boards and tasks there (Sol H1, 0.24.45).
function pairHasDir(pairCwd, dir) {
  if (typeof pairCwd !== 'string' || typeof dir !== 'string' || !path.isAbsolute(dir) || !within(dir, pairCwd)) return false;
  const rel = path.relative(pairCwd, dir);
  return !rel || !safepath.inside(pairCwd, rel).error;
}
// A page of this project: the same folder, or one inside the other. A paired computer's page (its
// root is the paired folder): only that folder or one inside it.
function pairedPage(id) {
  return String(id || '').startsWith('pair-');
}
function pageSees(page, cwd) {
  return Boolean(page && page.root && cwd) && rootMatches(page.root, cwd) && (!pairedPage(page.id) || pairHasDir(page.root, cwd));
}
// A snapshot a paired page may read: its file is in the paired folder or in a workspace of that
// pairing's tasks, where it really is (links resolved), and not an excluded file such as .git/config.
function pairSnapshot(pair, file) {
  const ok = (root) => {
    const at = safepath.fileIn(root, file);
    return !at.error && !sendproject.excluded(at.rel);
  };
  return ok(pair.cwd) || [...tasks.items.values()].some((t) => t.pairId === pair.id && typeof t.dir === 'string' && ok(t.dir));
}
function sees(scope, cwd, files = []) {
  if (!scope || !scope.pair) return true;
  if (!files.every((f) => pairHasFile(scope.pair, f))) return false;
  if (cwd === null) return true;
  // An edit of its files: from its own folder, a folder inside it, or a project folder that contains
  // it (never home or a drive). Anything else (chat, page control, boards): pairHasDir.
  if (files.length) return Boolean(cwd) && rootMatches(scope.pair.cwd, cwd) && !tooBroad(cwd);
  return pairHasDir(scope.pair.cwd, cwd);
}
function fanOut(text, cwd, files) {
  for (const [res, scope] of clients) if (sees(scope, cwd, files)) push(res, text);
  summaryWatch.nudge();
}

function broadcast(event) {
  const cwd = eventCwd(event);
  const files = eventFiles(event);
  const text = frame(event);
  for (const [res, scope] of clients) {
    if (!sees(scope, cwd, files)) continue;
    const view = scope.pair ? pairView(scope.pair, event) : event;
    push(res, view === event ? text : frame(view));
  }
  summaryWatch.nudge();
}
// An event as a paired page gets it: an edit's text only for a file of the paired folder that is
// not excluded (.git/config, .env, .claude), where it really leads; the same check as the edits
// watch-all sends (tasks.editsFor). Otherwise only that the file changed (Sol H2).
function pairView(pair, ev) {
  if (!SECRET_TEXT_EVENTS.has(ev.type) || ev.remote) return ev;
  const input = ev.input && typeof ev.input === 'object' ? ev.input : null;
  const named = [ev.file, input && (input.file_path || input.notebook_path)].filter((f) => typeof f === 'string' && f);
  const shown = named.every((f) => {
    const abs = path.isAbsolute(f) ? f : typeof ev.cwd === 'string' && path.isAbsolute(ev.cwd) ? path.resolve(ev.cwd, f) : null;
    const at = abs ? safepath.fileIn(pair.cwd, abs) : { error: 'outside' };
    const own = at.error ? null : worktree.withoutCopy(at.rel);
    return Boolean(own) && !sendproject.excluded(own);
  });
  return shown ? ev : withoutText(ev);
}

// Frequently replaced state (token usage): sent to pages now and to pages that connect later,
// but not kept in the history, so edits and chat are never removed to stay within the limit. No id
// line: it must not move a page's resume position.
const latestVolatile = new Map(); // "<type>:<sessionId>[:<agentId>]" -> event (usage, commands, mode)
function volatileFrame(event) {
  return `event: claude\ndata: ${JSON.stringify(event)}\n\n`;
}
function broadcastVolatile(event) {
  const ev = { ...event, ts: Date.now() };
  latestVolatile.set(`${event.type}:${event.sessionId}${event.agentId ? ':' + event.agentId : ''}`, ev);
  // Usage, commands and the mode of each session, plus the mode of each subagent.
  if (latestVolatile.size > MAX_SESSIONS * 3 + 100) latestVolatile.delete(latestVolatile.keys().next().value);
  fanOut(volatileFrame(ev), eventCwd(ev), eventFiles(ev));
}

// ---------- team board: notes, claims and findings shared by the main agent and subagents ----------
// Sent like volatile events (no id line, not in the history); a page gets every board in full
// when it connects.
function broadcastBoard(event) {
  lastActivity = Date.now();
  fanOut(volatileFrame(event), event.cwd || false);
}
// ---------- settings: kept by Claude Code (/config), reported by the hooks and the mod ----------
// The page shows them and can ask for a change; the mod (hooks/mod.mjs) makes it in Claude Code,
// which saves it. Without the mod running, the change stays only on the page.
const MOD_FRESH_MS = 8000;
const PENDING_MS = 20000;
// A report needs only the hook key, which any program running as this user can read. So a less strict
// value of these counts only when Claude Code's saved settings have it too (the Settings pane and /config
// save there first), or once the user allows it in the EditLens window. A stricter value counts immediately.
// task_account's Root (unsafe) already waits for the EditLens window (taskRootState).
const GATED_SETTINGS = ['safety_check', 'remote_tasks', 'paired_answers', 'permission_mode'];
// The user's "Keep the current setting" answers, kept across restarts.
const DECLINED_FILE = path.join(config.stateDir, 'settings-declined.json');
function loadDeclined() {
  const out = new Map();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DECLINED_FILE, 'utf8'));
  } catch (err) {
    if (!(err.code === 'ENOENT' || err instanceof SyntaxError)) log(`settings: could not read ${DECLINED_FILE} (${err.code || err.message})`);
    return out;
  }
  for (const key of GATED_SETTINGS) {
    const value = data && typeof data === 'object' ? settingsLib.check(key, data[key]) : undefined;
    if (value !== undefined) out.set(key, value);
  }
  return out;
}
// The strictest value of `key` in Claude Code's saved settings (one per install), or undefined.
function strictestSaved(key, saved) {
  const list = saved && saved[key];
  if (!list || !list.length) return undefined;
  return list.reduce((a, b) => (settingsLib.lessStrict(key, b, a) ? b : a));
}
// The values this server starts with go through the same hold as a report (startValues, reported
// before the server listens). Until then a gated setting is Claude Code's saved value, else its default,
// and the environment's value for it counts only through that hold. One the environment lacks: the saved one.
const settingsState = (() => {
  // given(): the options Claude Code gave this process, else its saved ones (a command run with
  // Claude's Bash tool gives none), else the defaults (settings check T1).
  const env = settingsLib.given();
  const saved = settingsLib.savedOptions();
  const d = settingsLib.defaults();
  const reported = { ...env.values };
  const startValues = { ...env.values };
  for (const key of GATED_SETTINGS) {
    const base = strictestSaved(key, saved);
    reported[key] = base === undefined ? d[key] : base;
    const given = settingsLib.check(key, process.env['CLAUDE_PLUGIN_OPTION_' + key.toUpperCase()]);
    if (given === undefined) startValues[key] = reported[key];
  }
  // held: key -> a less strict value reported but not in effect; declined: key -> the value the
  // user refused in the EditLens window (not asked again until the report changes).
  return {
    reported, startValues, from: env.from === 'env' ? 'claude-code' : 'defaults', modAt: 0, pending: [], nextId: 0, shown: '',
    held: new Map(), declined: loadDeclined(), live: false,
  };
})();
function saveDeclined() {
  try {
    if (settingsState.declined.size) writeAtomic(DECLINED_FILE, JSON.stringify(Object.fromEntries(settingsState.declined)), { mode: 0o600, mkdir: true });
    else fs.rmSync(DECLINED_FILE, { force: true });
  } catch (err) {
    if (!err.code) throw err;
    log(`settings: could not save the answer from the EditLens window (${err.code})`);
  }
}
function holdSetting(key, value) {
  if (settingsState.held.get(key) === value) return;
  settingsState.held.set(key, value);
  log(`settings: ${key} = ${JSON.stringify(value)} was reported but is not in Claude Code's saved settings; it waits for the EditLens window`);
  if (settingsState.declined.get(key) === value) return;
  const title = (settingsLib.SCHEMA[key] && settingsLib.SCHEMA[key].title) || key;
  desk.requestSetting(key, value, settingsState.reported[key]);
  pairNotice(`! A change to "${title}" needs your answer: allow it or keep the current setting in the EditLens window, ${answerUrl()}`);
}
function dropHeld(key) {
  settingsState.held.delete(key);
  if (settingsState.declined.delete(key)) saveDeclined();
  desk.dropSetting(key);
}
function applyHeld(key, why) {
  if (!settingsState.held.has(key)) return;
  const value = settingsState.held.get(key);
  dropHeld(key);
  settingsState.reported = { ...settingsState.reported, [key]: value };
  log(`settings: ${key} = ${JSON.stringify(value)} is in effect (${why})`);
  sendSettings(false);
}
// A held value the user has since saved in Claude Code (a session reported it a moment early).
function recheckHeld() {
  if (!settingsState.held.size) return;
  const saved = settingsLib.savedOptions();
  for (const [key, value] of [...settingsState.held]) if (settingsLib.savedAs(key, value, saved)) applyHeld(key, "saved in Claude Code's settings");
}
setInterval(recheckHeld, 3000).unref();
// The mod stopped (Claude Code closed): pages hear it now, so a change there is kept on the page.
setInterval(() => {
  if (settingsState.live && !modLive()) sendSettings(false);
}, 1000).unref();
function modLive() {
  return Date.now() - settingsState.modAt < MOD_FRESH_MS || summaryWatch.modHeld();
}
// Changes the page asked for that Claude Code doesn't have yet (the mod makes them).
function pendingSettings() {
  settingsState.pending = settingsState.pending.filter((p) => Date.now() - p.at < PENDING_MS);
  return settingsState.pending.map((p) => ({ id: p.id, key: p.key, value: p.value }));
}
// A change for the mod to make. One for the same key that is still waiting is replaced, and the new
// value is asked for even when Claude Code reported it: the mod may have made the earlier one already.
function queueSetting(key, value) {
  const waiting = settingsState.pending.some((p) => p.key === key);
  settingsState.pending = settingsState.pending.filter((p) => p.key !== key);
  if (waiting || settingsState.reported[key] !== value) settingsState.pending.push({ id: ++settingsState.nextId, key, value, at: Date.now() });
}
// The values in effect: what Claude Code reported. A page's request counts only once Claude Code
// has it, so a request it refuses never runs (a higher Tasks at once, a level).
function currentSettings() {
  return { ...settingsState.reported };
}
// What the page shows: the values in effect, with the page's requests that still wait for the mod.
function requestedSettings() {
  pendingSettings();
  const values = currentSettings();
  for (const p of settingsState.pending) values[p.key] = p.value;
  return values;
}
// The mod could not make these requests in Claude Code (a policy, a value it refused): they are
// removed, and pages show the values in effect again. ids: the request ids the mod got.
function refuseSettings(ids) {
  if (!Array.isArray(ids) || !ids.length) return;
  const refused = new Set(ids.filter((id) => Number.isSafeInteger(id)));
  const before = settingsState.pending.length;
  settingsState.pending = settingsState.pending.filter((p) => !refused.has(p.id));
  if (settingsState.pending.length !== before) sendSettings(false);
}
// pair: the paired computer a page came through. Its page shows this computer's values read-only,
// with this computer's name (via): only the user here changes them.
// invalid: a value saved in Claude Code that is not valid, while its default is used (a note under its row).
function settingsEvent(pair) {
  const values = requestedSettings();
  const bad = settingsLib.savedInvalid();
  const fields = settingsLib.describe(values).map((f) => (bad[f.key] !== undefined && values[f.key] === f.default ? { ...f, invalid: bad[f.key] } : f));
  const ev = { type: 'settings', values, fields, from: settingsState.from, canChange: modLive(), editable: settingsLib.PAGE_EDITABLE };
  if (!pair) return ev;
  return { ...ev, fields: ev.fields.map((f) => ({ ...f, pageEditable: false })), canChange: false, editable: [], via: pairHost.name };
}
function sendSettings(force) {
  // Tasks at once may have changed: waiting tasks start if the running-task limit allows it (never a stop).
  tasks.limitChanged();
  endPairedMessages();
  const ev = settingsEvent(null);
  const key = JSON.stringify(ev);
  settingsState.live = ev.canChange;
  if (!force && key === settingsState.shown) return;
  settingsState.shown = key;
  const text = volatileFrame(ev);
  let paired = null;
  for (const [res, scope] of clients) {
    if (scope && scope.pair) push(res, paired || (paired = volatileFrame(settingsEvent(scope.pair))));
    else push(res, text);
  }
  summaryWatch.nudge();
}
// raw: the values Claude Code gave a hook (its environment) or the mod (register's options).
function reportSettings(raw, from) {
  const values = settingsLib.normalize(raw);
  let saved; // Claude Code's saved settings, read only for a less strict value
  for (const key of GATED_SETTINGS) {
    const was = settingsState.reported[key];
    if (!settingsLib.lessStrict(key, was, values[key])) {
      dropHeld(key);
      continue;
    }
    if (saved === undefined) saved = settingsLib.savedOptions();
    if (settingsLib.savedAs(key, values[key], saved)) {
      dropHeld(key);
      continue;
    }
    holdSetting(key, values[key]);
    values[key] = was;
  }
  // Effort changed after an earlier report (not the first, which may only replace the defaults).
  const effortChanged = settingsState.from === 'claude-code' && settingsState.reported.effort !== values.effort;
  settingsState.reported = values;
  settingsState.from = from;
  // A change the page asked for is done once Claude Code has it.
  settingsState.pending = settingsState.pending.filter((p) => values[p.key] !== p.value);
  sendSettings(false);
  if (effortChanged) effortSettingChanged();
}
// The Effort setting changed in Claude Code (Settings on the page, /config, /editlens effort): page
// control running now moves to it, also from a session Max, since the user changed the setting after.
// Auto: Claude Code's level in that folder, else the level EditLens set is cleared (Claude's own).
// A level kept for page control goes, also at the same level (K1), unless /editlens effort set it.
let effortSaveAsked = null; // { level, at }: the level /editlens effort set for page control and saves
function effortSettingChanged() {
  const ds = driver.status();
  if (!ds.active) return;
  const level = effortLib.fromSettings(currentSettings(), ds.cwd || null);
  const asked = effortSaveAsked;
  effortSaveAsked = null;
  if (level && asked && asked.level === level && Date.now() - asked.at < PENDING_MS) return;
  (level ? driver.setEffort(level, { fromSetting: true }) : driver.clearEffort()).then((out) => {
    if (out.error) log(`page control kept its effort: ${out.error}`);
  }, (err) => log(`page control effort: ${err.message}`));
}

// ---------- page control: Claude runs here, controlled from the page (server/driver.js) ----------
// Claude programs the user's sessions run, newest last; kept across restarts so page control
// finds one before the next hook reports it.
const EXEC_PATHS_FILE = path.join(config.stateDir, 'claude-paths.json');
const execPaths = new Set(loadExecPaths());
function loadExecPaths() {
  try {
    const data = JSON.parse(fs.readFileSync(EXEC_PATHS_FILE, 'utf8'));
    return data && Array.isArray(data.paths) ? data.paths.filter((p) => isClaudeProgram(p)).slice(-5) : [];
  } catch (err) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err.code) || err instanceof SyntaxError) return [];
    throw err;
  }
}
function saveExecPaths() {
  try {
    fs.writeFileSync(EXEC_PATHS_FILE, JSON.stringify({ paths: [...execPaths] }));
  } catch (err) {
    if (!['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'ENOENT'].includes(err.code)) throw err;
    log(`could not save claude paths: ${err.code}`);
  }
}
let driveGrant = null; // { key, cwd, pageIds:Set }
// The sessions' "turn page control on when the page opens" waiters (bin/drive.js --auto): the newest
// one is the one that counts, and older ones are told to stop when they ask next. No pid files: a
// process is never signalled from a number that may now belong to another program.
let currentWaiter = null;
const seenWaiters = new Set();
const SUPERSEDED = 'A newer session is waiting for the page now.';
// Permission questions (commands, paths, file text), the sign-in link and the command list go
// only to the pages that were given page control; other pages are only told whether it is on or off.
const PRIVATE_DRIVE = new Set(['permission', 'permission-done', 'drive-signin', 'drive-commands']);
function grantedPage(pageId) {
  return Boolean(driveGrant && pageId && driveGrant.pageIds.has(pageId));
}
// The Sessions list (lib/sessionstore.js): the names people give sessions, and page control's
// conversations in each project (so a stopped one can be continued with claude --resume).
const sessionStore = new SessionStore({ file: path.join(config.stateDir, 'sessions.json'), log });
const driver = new Driver({
  emit: (ev) => {
    lastActivity = Date.now();
    if (ev.type === 'drive' && ev.phase === 'ready' && ev.sessionId && ev.cwd) {
      const st = driver.status();
      sessionStore.pageStarted({ id: ev.sessionId, cwd: ev.cwd, runId: st.runId || null, model: ev.model, effort: ev.effort && ev.effort.level, mode: st.mode });
    }
    if (ev.type === 'drive' && ev.phase === 'ended' && ev.sessionId) sessionStore.pageEnded(ev.sessionId);
    if (ev.type === 'drive' && ev.sessionId) sessionsChanged(ev.cwd || driver.status().cwd);
    summaryWatch.nudge(); // its questions go to some pages only, not through fanOut
    // No browser here: the page shows the sign-in link and the code box immediately.
    const f = volatileFrame({ ...ev, ...(ev.type === 'drive-signin' ? { noBrowser: !browserHere.ok } : {}), ts: Date.now() });
    if (PRIVATE_DRIVE.has(ev.type)) {
      for (const p of pages.values()) if (grantedPage(p.id)) push(p.res, f);
    } else {
      fanOut(f, ev.cwd || driver.status().cwd || false, eventFiles(ev));
    }
    if (ev.type === 'drive' && ev.phase === 'ended') {
      driveGrant = null;
      keepEnded(ev);
    } else if (ev.type === 'drive') {
      keepOn();
      // Page control runs again (restored, or the user's own start): nothing left to restore.
      if (ev.phase === 'ready') forgetRestore(null);
    }
    if (ev.type === 'drive' && ev.phase === 'ready' && ev.sessionId && ev.cwd) rememberPageRun(ev.cwd, ev.sessionId);
    // A level set for page control stays with its conversation (lib/effort.js remember()). Claude Code's
    // own and the Effort setting's are not kept, so a later setting applies when it continues.
    if ((ev.type === 'drive-effort' || (ev.type === 'drive' && ev.phase === 'ready')) && ev.sessionId && ev.effort) rememberEffort(ev.sessionId, ev.effort.fromClaude || ev.fromSetting ? null : ev.effort.level);
  },
  log,
  stateDir: config.stateDir,
  settings: () => currentSettings(),
  claudePaths: () => [...execPaths].reverse(),
});

// ---------- page control kept across a restart (lib/pagekeep.js) ----------
// While page control runs, a file says where and in which conversation; how it ended is added at the
// end (the user's Manual removes the file). A new server shows that reason, and if EditLens restarted or
// updated or the Claude program was removed, starts page control again when that page opens (30 min).
const KEEP_FILE = path.join(config.stateDir, 'page-control-on.json');
let keptAt = 0;
let keptKey = '';
function keepWrite(rec) {
  try {
    pagekeep.write(KEEP_FILE, rec);
  } catch (err) {
    if (!err || !err.code) throw err;
    log(`cannot save page control's state: ${err.code}`);
  }
}
function keepOn(force) {
  const st = driver.status();
  if (!st.active) return;
  const key = `${st.cwd}|${st.sessionId || ''}`;
  if (!force && key === keptKey && Date.now() - keptAt < HEARTBEAT_MS) return;
  keptKey = key;
  keptAt = Date.now();
  keepWrite({ cwd: st.cwd, sessionId: st.sessionId || st.fromSessionId || null, exe: driver.exePath(), version: config.version, pid: process.pid, aliveAt: keptAt, end: null });
}
// How it ended: the user's choice removes the file; any other end is kept, with its reason.
function keepEnded(ev) {
  keptKey = '';
  if (ev.reason === 'user' || ev.reason === 'moved') {
    try {
      pagekeep.remove(KEEP_FILE);
    } catch (err) {
      if (!err || !err.code) throw err;
      log(`cannot remove page control's state: ${err.code}`);
    }
    return;
  }
  if (ev.reason === 'shutdown') return; // shutdown() wrote why
  const rec = pagekeep.read(KEEP_FILE) || { cwd: ev.cwd, sessionId: ev.sessionId || null, version: config.version, pid: process.pid, aliveAt: Date.now() };
  const text = ev.error || pagekeep.TEXT[ev.reason] || 'Claude stopped unexpectedly.';
  keepWrite({ ...rec, cwd: ev.cwd || rec.cwd, sessionId: ev.sessionId || rec.sessionId, end: { reason: ev.reason, text, at: Date.now(), restore: ev.reason === 'claude-gone' } });
  if (ev.reason === 'claude-gone') wantRestore({ cwd: ev.cwd, sessionId: ev.sessionId || rec.sessionId || null, reason: 'claude-gone', text, at: Date.now() });
}
// { cwd, sessionId, reason, text, until, fails }: page control to start again when the page opens.
let restoreWant = null;
let restoreBusy = false;
function wantRestore(info) {
  restoreWant = { cwd: info.cwd, sessionId: info.sessionId || null, exe: info.exe || null, reason: info.reason, text: info.text, until: info.at + pagekeep.RESTORE_MS, fails: 0 };
  log(`page control ended in ${info.cwd} (${info.reason}): it starts again when that project's page opens, until ${new Date(restoreWant.until).toISOString()}`);
}
// why: null when page control simply runs again.
function forgetRestore(why) {
  if (!restoreWant) return;
  if (why) log(`page control will not start again by itself in ${restoreWant.cwd} (${why})`);
  restoreWant = null;
}
// The user chose Manual while page control was off: nothing is restored later either.
function forgetKept(why) {
  forgetRestore(why);
  try {
    pagekeep.remove(KEEP_FILE);
  } catch (err) {
    if (!err || !err.code) throw err;
    log(`cannot remove page control's state: ${err.code}`);
  }
}
async function tryRestore() {
  const w = restoreWant;
  if (!w || restoreBusy) return;
  if (Date.now() > w.until) return forgetRestore('more than 30 minutes passed');
  if (driver.busy()) {
    const st = driver.status();
    // Running elsewhere is the user's own choice there: never moved back here.
    if (st.active) forgetRestore(sameProject(st.cwd, w.cwd) ? null : `page control runs in ${st.cwd} now`);
    return undefined;
  }
  // Only this computer's own page of that project, never a paired computer's.
  if (!pagesFor(w.cwd, true).length) return undefined;
  restoreBusy = true;
  try {
    // The program it used (when still there; else the lookup /editlens control uses).
    const [status, answer] = await grantDrive({ cwd: w.cwd, claudePath: w.exe, restore: { sessionId: w.sessionId, reason: w.reason } });
    if (restoreWant !== w) return undefined;
    if (status === 200) {
      log(`page control starts again in ${w.cwd} (${w.reason})`);
      restoreWant = null;
    } else if (answer && answer.busy) {
      forgetRestore(answer.error);
    } else if (++w.fails >= 3) {
      forgetRestore(`could not start: ${answer && answer.error}`);
      driver.lastError = { error: `${w.text} It could not start again by itself: ${(answer && answer.error) || 'unknown error'}`, at: Date.now(), cwd: w.cwd, reason: w.reason };
    } else {
      log(`page control could not start again yet in ${w.cwd}: ${answer && answer.error}`);
    }
  } finally {
    restoreBusy = false;
  }
  return undefined;
}
// The end of this server's log file (the servers before it wrote there too), '' when unreadable.
function readLogTail() {
  let fd;
  try {
    fd = fs.openSync(config.logFile, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch (err) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err && err.code)) return '';
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
// What the server before this one left: why page control ended, and whether it starts again.
function loadKept() {
  let rec = pagekeep.read(KEEP_FILE);
  if (!rec) return;
  // Written by a hook for an older server, which doesn't say itself how page control ended: its log does.
  if (rec.observed && !rec.end) {
    const old = pagekeep.oldEnd(readLogTail(), Number(rec.pid));
    if (old && old.kind === 'user') {
      forgetKept('the user chose Manual before the update');
      return;
    }
    const at = old && Number.isFinite(old.at) ? old.at : old && Number.isFinite(old.lastAt) ? old.lastAt : rec.aliveAt;
    const reason = rec.version && rec.version !== config.version ? 'update' : 'restart';
    // Page control the user had on ended under an older EditLens that was waiting to update: it is
    // turned on again here.
    const text = old && old.kind === 'error' ? `${plainExit(old.error)} Then ${pagekeep.TEXT[reason]}` : pagekeep.TEXT[reason];
    rec = { ...rec, end: { reason, text, at, restore: true } };
  }
  const info = pagekeep.onStart(rec, { version: config.version });
  if (!info) {
    forgetKept('it ended more than 30 minutes ago');
    return;
  }
  driver.lastError = { error: info.text, at: info.at, cwd: info.cwd, reason: info.reason };
  log(`page control stopped in ${info.cwd} before this server started: ${info.text}`);
  if (info.restore) wantRestore(info);
}
// Sent projects' tasks run as the normal "editlens" account when there is one (lib/taskuser.js).
// Its hooks get their own key (taskUser.key), valid only for reporting edits in its workspaces.
const taskUser = { key: null, home: null };
// The task account's uid, looked up again every few seconds (it can be made or removed while the
// server runs). Its processes may only report edits here, whatever key they have (lib/peeruid.js).
const accountUid = { uid: null, at: 0 };
function taskAccountUid() {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  if (Date.now() - accountUid.at > 5000) {
    const a = taskuser.lookup();
    accountUid.uid = a ? a.uid : null;
    accountUid.at = Date.now();
  }
  return accountUid.uid;
}
const accountRefused = new Set(); // routes already logged, so a loop doesn't fill the log
const oldJoiners = new Set(); // pairing ids refused for an older EditLens there, logged once each
// Root (unsafe): on only after the user allowed it in the EditLens window, and only while the
// setting is still Root. Kept across restarts; never turned on by anything else.
const ROOT_FILE = path.join(config.stateDir, 'task-root.json');
const taskRoot = { on: false, at: 0, shown: null };
try {
  const saved = JSON.parse(fs.readFileSync(ROOT_FILE, 'utf8'));
  if (saved && saved.on === true) Object.assign(taskRoot, { on: true, at: timeOf(saved.at) || 0 });
} catch (err) {
  if (!(err.code === 'ENOENT' || err instanceof SyntaxError)) log(`tasks: could not read ${ROOT_FILE} (${err.code || err.message})`);
}
function saveTaskRoot() {
  try {
    if (taskRoot.on) fs.writeFileSync(ROOT_FILE, JSON.stringify({ on: true, at: taskRoot.at }), { mode: 0o600 });
    else fs.rmSync(ROOT_FILE, { force: true });
  } catch (err) {
    if (!err.code) throw err;
    log(`tasks: could not save the root choice (${err.code})`);
  }
}
// 'on' | 'waiting' (the setting is Root; the EditLens window waits for the user) | 'off'
function taskRootState() {
  const asks = currentSettings().task_account === 'Root (unsafe)' && process.platform === 'linux' && require('./driver').isRoot();
  if (!asks) {
    if (taskRoot.on) {
      taskRoot.on = false;
      saveTaskRoot();
      log('tasks: Root (unsafe) is off again');
    }
    desk.dropRoot();
    taskRoot.declined = false;
  } else if (!taskRoot.on && !taskRoot.declined) {
    desk.requestRoot();
  }
  const state = taskRoot.on ? 'on' : asks && !taskRoot.declined ? 'waiting' : 'off';
  if (state !== taskRoot.shown) {
    taskRoot.shown = state;
    // Every page here (and a paired computer's view of them) shows it while it is on.
    broadcastVolatile({ type: 'task-root', sessionId: 'task-root', state, computer: tasks.host });
    tasks.wakeAll();
  }
  return state;
}
setInterval(taskRootState, 3000).unref();
if (process.env.EDITLENS_TEST_PASSWD) log(`tasks: the task account is looked up in ${process.env.EDITLENS_TEST_PASSWD} (EDITLENS_TEST_PASSWD, for tests)`);
function taskAccount() {
  if (taskRootState() === 'on') return null;
  const a = taskuser.account({ setting: 'Auto', stateDir: config.stateDir });
  if (!a || a.error) {
    if (!a) taskUser.home = null;
    return a;
  }
  let plugin = path.join(a.stateDir, 'plugin');
  if (taskUser.home !== a.home || !fs.existsSync(plugin)) {
    try {
      const ready = taskuser.prepare(a, { port: config.port, token: taskUser.key, pluginRoot: path.join(__dirname, '..') });
      taskUser.key = ready.token;
      plugin = ready.plugin;
    } catch (err) {
      if (!err.code) throw err;
      return { error: `Could not set up the ${a.name} account's folders (${err.code}).` };
    }
    taskUser.home = a.home;
    log(`tasks: sent projects run as ${a.name} (${a.home})`);
  }
  return { ...a, port: config.port, plugin };
}
// An event from a task's hooks with the account's key: only edit reporting, only inside its
// workspaces, and never a path EditLens would read for it (transcript, program).
const TASK_EVENTS = new Set(['session', 'commands', 'prompt', 'pending', 'step', 'change', 'idle', 'end']);
const TASK_EDIT_EVENTS = new Set(['pending', 'step', 'change']);
function taskEventOk(body) {
  const a = taskUser.home ? taskuser.lookup() : null;
  if (!a || a.home !== taskUser.home || !TASK_EVENTS.has(body.type)) return false;
  const root = path.join(a.home, taskuser.WORKSPACES);
  for (const k of ['file', 'cwd', 'projectDir']) {
    if (body[k] == null) continue;
    if (typeof body[k] !== 'string' || !within(path.resolve(body[k]), root)) return false;
    // Nor through a link the task made to a file elsewhere.
    try {
      if (!within(fs.realpathSync(body[k]), root)) return false;
    } catch (err) {
      if (!err || !err.code) throw err;
      if (err.code !== 'ENOENT') return false;
    }
  }
  return Boolean(body.cwd || body.file || body.projectDir);
}

// Tasks a paired computer's Claude runs here (server/tasks.js). Their cards (with permission
// questions) go only to this project's pages.
const tasks = new Tasks({
  account: taskAccount,
  rootTasks: () => taskRoot.on,
  stateDir: config.stateDir,
  log,
  host: cleanName(require('os').hostname().split('.')[0]),
  emit: (card) => {
    lastActivity = Date.now();
    const f = volatileFrame({ ...card, ts: Date.now() });
    for (const p of pages.values()) if (pageSees(p, card.cwd)) push(p.res, f);
  },
  makeDriver: (o) => new Driver({ ...o, log, stateDir: config.stateDir, settings: () => currentSettings() }),
  // A start that names no level: this computer's Effort setting (Auto: Claude Code's level in cwd).
  defaultEffort: (cwd) => effortLib.fromSettings(currentSettings(), cwd),
  // Tasks at once (checked in tasks.js: a bad value is 4). Its pages show "N of M running".
  limit: () => currentSettings().tasks_at_once,
  // "Paired computers can run Claude here": waiting tasks don't start while it is off (Sol S2).
  runsAllowed: () => currentSettings().remote_tasks !== false,
  onSlots: (slots) => broadcastVolatile({ type: 'task-slots', sessionId: 'task-slots:here', computer: null, running: slots.running, limit: slots.limit }),
  claudePaths: () => [...execPaths].reverse(),
  onTurn: (t) => {
    // Files the turn changed by commands, shown as its edits before the copy card counts them.
    tasks.commandEdits(t).then((list) => {
      for (const e of list) commandEdit(t, e);
    }, (err) => log(`task ${t.id}: could not look for files changed by commands (${err.message})`)).finally(() => {
      if (t.copy && t.root) copyCard(t.root, t.copy, { agentName: `Task from ${t.by}` });
    });
  },
  // The turn waits for this (tasks.beforeTurn, at most 2 s), which logs a failure.
  onTurnStart: (t) => tasks.scanTurnStart(t),
});
// Permission questions open in Claude Code itself (server/asks.js): listed on this project's
// pages, answered only in Claude Code.
const asks = new Asks({
  log,
  emit: (ev) => {
    const f = volatileFrame({ ...ev, ts: ev.ts || Date.now() });
    for (const p of pages.values()) if (pageSees(p, ev.cwd)) push(p.res, f);
  },
});
// The EditLens window (server/answer.js): the only place a question is allowed.
// paired_answers: a computer that joined this one may answer here (only drive and task questions).
// A question from a session in the paired folder or one inside it; never one from a folder above it (Sol H1).
const desk = new AnswerDesk({ pairAnswers: () => currentSettings().paired_answers === true, inPair: (pair, cwd) => pairHasDir(pair.cwd, cwd) && !tooBroad(cwd) });
const ANSWER_IN_WINDOW = 'Allow it in the EditLens window. A page can only deny.';
const PAIR_ANSWER_OFF = 'Answer on that computer itself. To answer from here, turn on "Paired computers can answer questions here" in /config on that computer.';

// A session EditLens runs itself (page control, a task): its questions are already cards.
function drivenSession(id) {
  if (!id) return false;
  if (driver.status().sessionId === id) return true;
  for (const t of tasks.items.values()) if (t.sessionId === id) return true;
  return false;
}

// Ops on one task, below: an unknown op is reported before the task is looked up.
const TASK_OPS = new Set(['check', 'watch', 'send', 'changes', 'diff', 'files', 'search', 'undo-merge', 'file', 'stop', 'merge', 'effort']);
// Ops that run no Claude here and change nothing here (list, copy files, read or stop a task):
// they work while "Paired computers can run Claude here" is off.
const OPS_WITHOUT_RUNS = new Set(['list', 'watch-all', 'project', 'project-files', 'project-file',
  'check', 'watch', 'changes', 'diff', 'files', 'search', 'file', 'stop']);
// Page control requests a paired page may make while that setting is off: the ones that stop work
// (permission: Deny only, see below).
const PAIRED_STOPS = new Set(['POST /drive/stop', 'POST /drive/interrupt', 'POST /drive/stop-agent', 'POST /drive/signin-cancel', 'POST /drive/permission']);
// A request from a paired computer's Claude (server/pair-host.js).
async function taskRequest(pair, body) {
  const op = body && typeof body.op === 'string' ? body.op : '';
  // Restore of an edit Claude made here: no Claude runs, and that computer's page could do it
  // through the link anyway, so the setting below does not apply.
  if (op === 'edit-restore') return hostRestore.handle(pair, body);
  if (currentSettings().remote_tasks === false && !OPS_WITHOUT_RUNS.has(op)) {
    const error = tasks.runsOff();
    // The pages here say so too, not only the agent that asked.
    if (op === 'start' || op === 'send') tasks.refuse(pair, op === 'start' ? body.prompt : body.text, error, { task: op === 'send' ? String(body.task || '').slice(0, 40) || null : null });
    return { error };
  }
  if (op === 'list') return { computer: tasks.host, project: pair.cwd, tasks: tasks.list(pair) };
  if (op === 'watch-all') return tasks.watchAll(pair, Number(body.since), Number(body.wait), Number.isSafeInteger(body.editsSince) ? body.editsSince : null);
  // effort: its own field, checked in tasks.startTask (one of the five levels, or none).
  if (op === 'start') return tasks.start(pair, { prompt: body.prompt, upload: typeof body.upload === 'string' ? body.upload : null, effort: body.effort });
  if (op === 'upload') return tasks.receive(pair, body);
  if (op === 'project') return tasks.project(pair);
  // Read-only copies from this project (copy_from_computer on the other computer): no Claude runs.
  if (op === 'project-files') return tasks.projectFiles(pair, body.path, Number(body.offset), body.hash);
  if (op === 'project-file') return tasks.projectFile(pair, body.path, Number(body.offset));
  if (!TASK_OPS.has(op)) return { error: `Unknown op "${op}".` };
  const t = tasks.mine(pair, body.task);
  if (!t) {
    const error = 'No such task from this computer. List them with op "list".';
    if (op === 'send') tasks.refuse(pair, body.text, error, { task: String(body.task || '').slice(0, 40) || 'unknown' });
    return { error };
  }
  if (op === 'check') return tasks.check(t, Number(body.since), Number(body.wait), Number.isSafeInteger(body.activitySince) ? body.activitySince : null);
  if (op === 'watch') return tasks.watch(t, Number(body.since), Number(body.wait));
  if (op === 'send') return tasks.send(pair, t.id, body.text);
  if (op === 'changes') return tasks.changes(t);
  if (op === 'diff') return tasks.diff(t, body.paths, Number(body.offset));
  if (op === 'files') return tasks.files(t, body.glob, Number(body.offset));
  if (op === 'search') return tasks.search(t, body.text, body.glob, Number(body.max));
  if (op === 'undo-merge') return undoMerge(t);
  if (op === 'file') return tasks.workspaceFile(t, body.path, Number(body.offset));
  if (op === 'stop') {
    log(`task ${t.id}: stopped by ${pair.name}`);
    return tasks.stop(pair, t.id);
  }
  // The task card on that computer's page (its effort chip): a level, never text from a prompt.
  if (op === 'effort') return tasks.setEffort(t, body.level);
  if (op === 'merge') {
    if (t.kind === 'sent') return { error: `This task works on a copy of the project sent from ${t.by}: its changes are copied to the original project there (apply_computer_task on ${t.by}).` };
    if (!t.copy) return { error: 'This task works in the project folder itself: there is nothing to merge.' };
    if (t.state === 'working' || t.state === 'starting') return { error: 'The task is still working. Merge when it is done.' };
    if (t.state === 'waiting') return { error: 'The task has not started yet: it waits for a free session. Merge when it is done.' };
    // The paired folder in the repository ('' when it is the whole repository): the copy is of the
    // whole repository, but only that folder's files are merged (Sol H4).
    const sub = path.relative(path.join(t.root, '.claude', 'worktrees', t.copy), t.dir).split(path.sep).join('/');
    if (sub === '..' || sub.startsWith('../') || path.isAbsolute(sub)) return { error: 'The task\'s copy is not where it was made, so it is not merged.' };
    const inSub = (rel) => !sub || rel === sub || rel.startsWith(`${sub}/`);
    if (body.dryRun) {
      // What merging would do, writing nothing.
      const st = await worktree.status(t.root, t.copy);
      if (st.error) return st;
      const pick = (k) => st.files.filter((f) => f.state === k && inSub(f.relFile)).map((f) => f.relFile);
      const outside = sub ? st.files.filter((f) => f.state !== 'same' && !inSub(f.relFile)).map((f) => f.relFile) : null;
      return { dryRun: true, wouldMerge: pick('clean'), wouldCombine: pick('merged'), leftForUser: pick('conflict'), same: pick('same').length, ...(outside ? { outside } : {}) };
    }
    // Only files the user hasn't changed here: the rest wait for the user in the panel.
    const { undoList, ...done } = await mergeCopy(t.root, t.copy, [], { cleanOnly: true, only: sub });
    if (done.error) return done;
    t.lastMerge = undoList || null;
    log(`task ${t.id}: merged by ${pair.name} (${done.applied.length} files)`);
    const notes = [done.conflicts.length ? `Files the project on ${tasks.host} also changed were not merged: the user there decides those in the EditLens panel.` : null,
      done.outside && done.outside.length ? `Files outside ${sub} (the paired folder) were not merged: they stay in the task's copy on ${tasks.host}.` : null].filter(Boolean);
    return { ...done, note: notes.length ? notes.join(' ') : undefined };
  }
  return { error: `Unknown op "${op}".` };
}

// A page id as this server keeps it: a paired computer's pages get their own names, so they can
// never replace (or be mistaken for) a page on this computer.
function pageKey(req, raw) {
  const id = String(raw || '').slice(0, 64);
  const pair = req.socket.editlensPair;
  return pair && id ? `pair-${crypto.createHash('sha256').update(pair.id).digest('hex').slice(0, 8)}-${id}` : id;
}
function pageFor(req, raw) {
  return pages.get(pageKey(req, raw)) || null;
}

function grantedOrSameProject(pageId, cwd) {
  return pageSees(pageId ? pages.get(pageId) : null, cwd);
}

// The key works only from a page it was given to, while that page is connected.
function driveKeyOk(key, pageId) {
  if (!driveGrant || typeof key !== 'string') return false;
  if (typeof pageId !== 'string' || !driveGrant.pageIds.has(pageId) || !pages.has(pageId)) return false;
  // Byte lengths: a key that is not ASCII has more bytes than characters (timingSafeEqual throws).
  return sameKey(key, driveGrant.key);
}

// Pages connected with /editlens (a Vite run or a proxy), owned by this server.
const connector = new Connector({
  stateDir: config.stateDir,
  livePort: config.port,
  log,
  emit: (ev) => {
    fanOut(volatileFrame({ ...ev, ts: Date.now() }), eventCwd(ev), eventFiles(ev));
  },
});
try {
  cleanWrappers(config.stateDir);
} catch (err) {
  log(`cannot clear old connect configs: ${err.code || err.message}`);
}
// EditLens lines in a project's own files, for the reminder in Claude Code (cached briefly).
const integrationCache = new Map();
function integrationsOf(cwd) {
  if (!cwd) return [];
  const hit = integrationCache.get(normalize(cwd));
  if (hit && Date.now() - hit.at < 15000) return hit.value;
  let value;
  try {
    value = findIntegrations(cwd).map(({ rel, line, marked }) => ({ rel, line, marked }));
  } catch (err) {
    // A file system error (it names a syscall) shows no integrations and is not cached: the next
    // call scans again.
    if (!err || typeof err.syscall !== 'string') throw err;
    return [];
  }
  integrationCache.set(normalize(cwd), { at: Date.now(), value });
  if (integrationCache.size > 50) integrationCache.delete(integrationCache.keys().next().value);
  return value;
}

// Files as they were before Claude changed them, for "Restore previous version" in the panel.
const backups = new BackupStore(path.join(config.stateDir, 'backups'));
// Screenshots pasted into the panel's message box.
const shots = new screenshots.ShotStore(path.join(config.stateDir, 'screenshots'), { log });
shots.prune();
function keepBackup(body, text) {
  // Never for a task running as the normal account (Restore writes as this server's user), nor for
  // an edit on a paired computer (that file is there).
  if (body.fromTaskAccount || body.remote) return null;
  if (body.type !== 'change' || body.created || typeof text !== 'string' || !text) return null;
  try {
    return backups.save({ file: body.file, relFile: body.relFile, cwd: body.cwd, text, after: body.after });
  } catch (err) {
    if (err && err.code) {
      log(`backup of ${body.file} failed: ${err.code}`);
      return null;
    }
    throw err;
  }
}

const boards = new Boards({
  dir: path.join(config.stateDir, 'boards'),
  onEntry: (board, entry) => broadcastBoard({ type: 'board', cwd: board.cwd, entry }),
  onClear: (board) => broadcastBoard({ type: 'board-clear', cwd: board.cwd }),
});
try {
  boards.loadRecent();
} catch (err) {
  log('cannot load team boards:', err.message);
}

// An event from a hook (or a merge): file text goes to the snapshot store and the backups, and
// the page gets the rest. -> the event as pages see it, before it gets its seq.
// Sol H6: a key or credentials file's text is never kept or shown, whatever sent it (an older
// hook, a task's Claude): the event keeps only that the file changed (lib/sendproject.js secretFile).
const SECRET_TEXT_EVENTS = new Set(['pending', 'change', 'code', 'ask']);
function stripSecret(body) {
  if (!SECRET_TEXT_EVENTS.has(body.type)) return body;
  const input = body.input && typeof body.input === 'object' ? body.input : null;
  const file = typeof body.file === 'string' ? body.file : input && typeof (input.file_path || input.notebook_path) === 'string' ? input.file_path || input.notebook_path : '';
  const cwd = typeof body.cwd === 'string' ? body.cwd : '';
  const rel = cwd && file && path.isAbsolute(file) ? path.relative(cwd, file) : '';
  const named = [typeof body.relFile === 'string' ? body.relFile : '', rel && !rel.startsWith('..') ? rel : file];
  // By its names, and by where the file really leads (a link to a key file, Sol H9).
  if (body.secret !== true && !named.some((p) => p && sendproject.secretFile(p)) && !(file && path.isAbsolute(file) && sendproject.secretPath(cwd, file))) return body;
  return { ...withoutText(body), secret: true };
}
// The event with only that the file changed: no text of the file or of the edit.
function withoutText(body) {
  const input = body.input && typeof body.input === 'object' ? body.input : null;
  const out = { ...body };
  for (const k of ['before', 'after', 'content']) delete out[k];
  if (body.type === 'change') {
    Object.assign(out, { hunks: [], truncated: false, stats: null, routes: [], hints: { selectors: [], ids: [], classes: [], texts: [] } });
    if (body.autoIntent === true || typeof body.intent !== 'string') out.intent = body.created ? 'Created the file' : 'Changed the file';
  }
  if (input) out.input = input.notebook_path ? { notebook_path: input.notebook_path } : { file_path: input.file_path };
  return out;
}

function takeEvent(body) {
  // The page does not need local transcript paths; file text goes to the snapshot store.
  // noBackup: the file is not in this project (a task's workspace), or the event is a restore that
  // already kept its own copy.
  const { transcriptPath, before, after, content, execPath, settings: _settings, noBackup, ...publicEvent } = body;
  if (body.type === 'pending') snapshots.rememberBefore(body.toolUseId, before, typeof body.existed === 'boolean' ? body.existed : undefined);
  // A Write the hook reported as a new file (no originalFile) to a file that was already there.
  if (body.type === 'change' && body.created && snapshots.existedBefore(body.toolUseId) === true) {
    publicEvent.created = false;
    body.created = false;
  }
  if (body.type === 'change' || body.type === 'code') {
    const id = `s${seq + 1}`; // the seq this event is about to get
    const known = typeof before === 'string' && !(before === '' && snapshots.existedBefore(body.toolUseId) === true);
    const prior = body.type === 'change' ? (known ? before : snapshots.takeBefore(body.toolUseId)) : null;
    const text = body.type === 'change' ? after : content;
    const backup = noBackup ? null : keepBackup(body, prior);
    if (backup) publicEvent.backup = backup;
    else if (!noBackup && body.type === 'change' && !body.created && !body.fromTaskAccount && !body.remote) {
      // Say why Restore is missing: a key file, or the file is over 2 MB or is binary.
      const why = body.secret === true ? 'secret' : skipReason(prior, typeof prior === 'string' ? NaN : fileSize(body.file));
      if (why) publicEvent.backupSkipped = why;
    }
    if (snapshots.add(id, { file: body.file, relFile: body.relFile, before: prior, after: text, kind: body.type === 'change' ? body.kind : 'view' })) {
      publicEvent.snapshot = id;
      publicEvent.animated = snapshots.items.get(id).before !== null;
    }
  }
  noteEditor(body, publicEvent);
  return publicEvent;
}

function fileSize(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) return NaN;
  try {
    return fs.statSync(file).size;
  } catch (err) {
    if (err && err.code) return NaN;
    throw err;
  }
}

// A restore (Restore, Undo, Remove file, or undoing a task's merge) goes to the pages as a normal
// edit of kind 'restore', so the code view plays it, the page marks it and other tabs see it.
// done: from backups.restore / replace / removeFile. via: 'restore' | 'undo' | 'remove' | 'merge-undo'
// | 'undo-edit' (only one edit removed, server/undo.js).
function restoreEvent(done, via, restoredFrom, extra) {
  const before = typeof done.before === 'string' ? done.before : '';
  const after = typeof done.after === 'string' ? done.after : '';
  const hunks = diffText(before, after);
  const clamped = clampHunks(hunks);
  const stats = countStats(hunks);
  const n = Math.max(stats.added, stats.removed); // a changed line counts once
  const ext = path.extname(done.file).toLowerCase();
  const cwd = typeof done.cwd === 'string' && done.cwd ? done.cwd : path.dirname(done.file);
  const intent = via === 'merge-undo' ? (done.deleted ? 'Merge undone: removed the file it added' : 'Merge undone: put back as before the merge')
    : via === 'remove' ? 'Removed the file Claude created'
      : via === 'undo' ? (done.reason === 'remove' ? 'Put back the removed file' : done.reason === 'undo-edit' ? 'Put the undone edit back' : 'Undid restore')
        : via === 'undo-edit' ? 'Undid one earlier edit. Later changes kept.'
          : `Restored ${n} line${n === 1 ? '' : 's'}`;
  const body = {
    type: 'change', kind: 'restore', fileKind: classify(done.relFile, after), tool: 'Restore', via, restoredFrom: restoredFrom || null,
    ts: Date.now(), sessionId: null, agentId: null, agentType: null, cwd, project: path.basename(cwd), file: done.file, relFile: done.relFile, ext, routes: [],
    created: done.before === null || done.before === undefined, deleted: Boolean(done.deleted), intent, autoIntent: false,
    hunks: clamped.hunks, truncated: clamped.truncated, stats, hints: buildHints({ ext, hunks, fileText: after }),
    before, after, noBackup: true, ...extra,
  };
  const publicEvent = takeEvent(body);
  // Its own Restore puts back what this restore replaced.
  if (done.undo) publicEvent.backup = done.undo;
  const event = addEvent(publicEvent);
  // A paired computer that shows this project's edits shows the restore too.
  feedEdit(body, event, null);
  return event;
}

// "Undo only this edit" and the terminal's recent edits (server/undo.js).
const undoCore = createUndo({ history, snapshots, backups, restoreEvent, log });
// The same for edits made on a paired computer (server/remote-restore.js): hostRestore does the
// work here for that computer's pages; remoteRestore asks it for this computer's pages.
const hostRestore = createHostRestore({ history, backups, undo: undoCore, restoreEvent, log, instance: INSTANCE });
const remoteRestore = createRemoteRestore({ history, pairs: { editRestore: (name, body) => pairRemotes.editRestore(name, body) }, follow: (name) => followComputer(name) });
// pageId -> the first seq that page got: a page numbers its edits from there (its markers).
const pageFrom = new Map();
// Whose numbers the terminal uses: this project's open page that has numbered the longest, else
// a page that would open now. -> { root, from }
function numberAnchor(cwd) {
  let best = null;
  for (const p of pages.values()) {
    if (!p.root || (cwd && !rootMatches(p.root, cwd))) continue;
    const from = pageFrom.get(p.id);
    if (Number.isFinite(from) && (!best || from < best.from)) best = { root: p.root, from };
  }
  if (best) return best;
  const tail = replayTail();
  return { root: cwd || null, from: tail.length ? tail[0].seq : seq + 1 };
}
// The numbers a page shows: from its own start when it is open.
function pageAnchor(page) {
  const from = pageFrom.get(page.id);
  return Number.isFinite(from) ? { root: page.root, from } : numberAnchor(page.root);
}

// ---------- edits with an earlier copy, listed again after a restart ----------
// The event history is in memory; this small index on disk restores the edit cards (with
// Restore) of edits whose earlier copy is still kept.
const EDIT_INDEX = path.join(config.stateDir, 'backups', 'edits.json');
const EDIT_INDEX_MAX = 100;
const EDIT_INDEX_BYTES = 1024 * 1024;
const EDIT_ENTRY_BYTES = 48 * 1024;
let editIndex = [];
function indexEntry(event) {
  const { seq: _s, receivedAt: _r, snapshot: _sn, animated: _a, replay: _rp, earlier: _e, ...keep } = event;
  if (jsonBytes(keep) > EDIT_ENTRY_BYTES) {
    keep.hunks = [];
    keep.truncated = true;
    delete keep.hints;
  }
  return jsonBytes(keep) > EDIT_ENTRY_BYTES ? null : keep;
}
function rememberEdit(event) {
  // A paired computer's edit: its copy is there, not here.
  if (event.type !== 'change' || !event.backup || event.earlier || event.remote) return;
  const entry = indexEntry(event);
  if (!entry) return;
  editIndex.push(entry);
  let bytes = editIndex.reduce((n, e) => n + jsonBytes(e), 0);
  while (editIndex.length > EDIT_INDEX_MAX || (editIndex.length > 1 && bytes > EDIT_INDEX_BYTES)) bytes -= jsonBytes(editIndex.shift());
  try {
    writeAtomic(EDIT_INDEX, JSON.stringify(editIndex), { mkdir: true });
  } catch (err) {
    if (!(err && err.code)) throw err;
    log(`cannot save the list of edits with earlier copies: ${err.code}`);
  }
}
function loadEditIndex() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(EDIT_INDEX, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) log('the list of edits with earlier copies was unreadable: starting a new one');
    else if (!(err && err.code === 'ENOENT')) {
      if (!(err && err.code)) throw err;
      log(`cannot read the list of edits with earlier copies: ${err.code}`);
    }
  }
  if (!Array.isArray(list)) list = [];
  // Only edits whose copy is still kept; each is sent again as an event of this server, marked earlier.
  editIndex = list.filter((e) => e && typeof e === 'object' && e.type === 'change' && typeof e.file === 'string' && backups.has(e.backup)).slice(-EDIT_INDEX_MAX);
  for (const e of editIndex) {
    const ts = Number(e.ts);
    addEvent({ ...e, ts: Number.isFinite(ts) && ts > 0 ? ts : Date.now(), earlier: true });
  }
}

// ---------- subagents in their own copy (lib/worktree.js) ----------
const copyAgents = new Map(); // "<project>\0<copy>" -> the subagent working in it
const editors = new Map(); // a project file -> the agent that edited it last, and when
const OVERLAP_MS = 10 * 60000;

function copyKey(root, name) {
  return `${normalize(root)}\0${name}`;
}

// Who edits what: a copy's edits name their subagent; two agents editing the same project file
// within a few minutes (both outside a copy) get a warning on the page.
function noteEditor(body, publicEvent) {
  if (body.type !== 'change' || typeof body.file !== 'string') return;
  if (body.copy && typeof body.cwd === 'string') {
    copyAgents.set(copyKey(body.cwd, body.copy), { agentId: body.agentId || null, agentType: body.agentType || null, sessionId: body.sessionId || null });
    if (copyAgents.size > 200) copyAgents.delete(copyAgents.keys().next().value);
    return;
  }
  if (body.merged || body.remote || body.kind === 'restore') return;
  const key = normalize(body.file);
  const who = body.agentId || 'main';
  const prev = editors.get(key);
  const now = Date.now();
  if (prev && prev.who !== who && now - prev.at < OVERLAP_MS) publicEvent.overlap = { agentId: prev.agentId, agentType: prev.agentType };
  editors.delete(key);
  editors.set(key, { who, agentId: body.agentId || null, agentType: body.agentType || null, at: now });
  if (editors.size > 2000) editors.delete(editors.keys().next().value);
}

// What a copy has, short enough to send to pages.
function copySummary(st) {
  const files = st.files.map((f) => ({ relFile: f.relFile, state: f.state, added: f.added, deleted: f.deleted, why: f.why || undefined }));
  const count = (k) => files.filter((f) => f.state === k).length;
  return { name: st.name, branch: st.branch, files: files.slice(0, 100), more: Math.max(0, files.length - 100), ready: count('clean') + count('merged'), conflicts: count('conflict'), same: count('same') };
}

// A subagent that worked in its own copy finished: a card on the page says what it changed.
function copyFinished(body) {
  let root = typeof body.copyRoot === 'string' ? body.copyRoot : null;
  let name = typeof body.copy === 'string' ? body.copy : null;
  if (!name) {
    for (const [k, v] of copyAgents) {
      if (v.agentId && v.agentId === body.agentId) [root, name] = k.split('\0');
    }
  }
  if (!root || !name || tooBroad(root)) return;
  copyCard(root, name, { sessionId: body.sessionId || null, agentId: body.agentId || null, agentType: body.agentType || null, agentName: typeof body.name === 'string' ? body.name.slice(0, 200) : null });
}
// Runs git without blocking; the card is sent when git is done. Never throws.
function copyCard(root, name, who) {
  return worktree.status(root, name).then((st) => {
    if (st.error) return log(`copy ${name}: ${st.error}`);
    return addEvent({ type: 'copy', cwd: root, file: st.dir, ts: Date.now(), ...who, ...copySummary(st) });
  }, (err) => log(`copy ${name}: could not check it (${err.message})`));
}

// The project folders a page may manage copies in: its own project's git top folder. A paired
// computer's page: only the paired folder or one inside it (Sol H1).
function copyRootFor(page, root, pair = null) {
  if (!page || !page.root || typeof root !== 'string' || !root || tooBroad(root)) return null;
  if (!rootMatches(page.root, root) || (pair && !within(root, pair.cwd))) return null;
  return fs.existsSync(path.join(root, '.claude', 'worktrees')) ? root : null;
}

// Copies a copy's changes into the project; each file that changes shows as an edit on the page,
// with Restore, labelled with the subagent.
async function mergeCopy(root, name, take, { cleanOnly = false, only = '' } = {}) {
  const res = await worktree.merge(root, name, { take, cleanOnly, only });
  if (res.error) return res;
  const who = copyAgents.get(copyKey(root, name)) || {};
  const undoList = []; // what undoing this merge needs: the backup, and what the merge wrote
  for (const a of res.applied) {
    if (a.binary) {
      undoList.push({ relFile: a.relFile, file: a.file, backup: null, binary: true });
      continue;
    }
    const before = a.before === null ? '' : a.before;
    const after = a.after === null ? '' : a.after;
    const hunks = diffText(before, after);
    const clamped = clampHunks(hunks);
    const ext = path.extname(a.file).toLowerCase();
    const body = {
      type: 'change', tool: 'Merge', merged: name, ts: Date.now(),
      sessionId: who.sessionId || null, agentId: who.agentId || null, agentType: who.agentType || null,
      cwd: root, project: path.basename(root), file: a.file, relFile: a.relFile, ext,
      kind: classify(a.relFile, after), routes: [], created: a.before === null, deleted: a.after === null,
      intent: a.after === null ? 'Deleted, as in its copy' : `Merged from its copy (${name})`, autoIntent: false,
      hunks: clamped.hunks, truncated: clamped.truncated, stats: countStats(hunks), hints: buildHints({ ext, hunks, fileText: after }),
      before, after,
    };
    const ev = addEvent(takeEvent(body));
    undoList.push({ relFile: a.relFile, file: a.file, backup: ev.backup || null, created: a.before === null, deleted: a.after === null, after: a.after === null ? null : sha256(after) });
  }
  const st = await worktree.status(root, name);
  if (!st.error) broadcastVolatile({ type: 'copy-state', sessionId: null, cwd: root, file: st.dir, ...copySummary(st) });
  log(`copy ${name}: merged ${res.applied.length} file(s), ${res.conflicts.length} left`);
  return { ok: true, applied: res.applied.map((a) => a.relFile), conflicts: res.conflicts, same: res.same, ...(res.outside ? { outside: res.outside } : {}), undoList };
}

// ---------- tasks this computer's Claude gave a paired computer ----------
// One loop per paired computer keeps this computer's tasks there current (op "watch-all": one request
// per change). The cache answers waits that need no new request (wait_for_computer_tasks, GET
// /remote/tasks); each task's card on this project's pages shows its work, edits and questions live.
const MIRROR_DONE = new Set(['idle', 'ended', 'stopped', 'failed']);
const FOLLOW_IDLE_MS = 10 * 60000; // keep following this long after every task is done or waiting
const REMOTE_KEPT = 50; // tasks cached per computer
// computers: computer -> { seq, tasks, dirs, running, until }
const remote = { seq: 0, computers: new Map(), waiters: new Set() };

// { running, limit } as a paired computer sends it, checked (whole numbers, limit 1 to 8), or null.
function slotsOf(v) {
  if (!v || typeof v !== 'object') return null;
  const running = Number(v.running);
  const limit = Number(v.limit);
  if (!Number.isSafeInteger(running) || running < 0 || !Number.isSafeInteger(limit)) return null;
  if (limit < settingsLib.TASKS_MIN || limit > settingsLib.TASKS_MAX) return null;
  return { running: Math.min(running, 99), limit };
}

function remoteCard(computer, task, localDir, c) {
  const perms = Array.isArray(c.permissions) ? c.permissions : [];
  // Its app, through the pairing link (the address the ◆ button opens).
  const host = pairRemotes.status().hosts.find((h) => h.name === computer) || (pairRemotes.status().hosts.length === 1 ? pairRemotes.status().hosts[0] : null);
  broadcastVolatile({
    appUrl: host && host.url && host.site ? host.url : null,
    answerUrl: host && typeof host.answerUrl === 'string' ? host.answerUrl : null,
    type: 'task-remote', sessionId: `task-${task}`, cwd: localDir, taskId: task, computer: String(computer).slice(0, 100),
    prompt: String(c.prompt || '').slice(0, 600), state: String(c.state || ''), error: c.error || null, note: c.note || null,
    lastReply: String(c.lastReply || '').slice(0, 600), kind: c.kind || null, startedAt: c.startedAt || null,
    // Each file as the project names it (an older EditLens there sends the path in a subagent's copy).
    edits: Array.isArray(c.edits) ? c.edits.slice(-20).map((e) => (e && typeof e.relFile === 'string' ? { ...e, relFile: worktree.withoutCopy(e.relFile) } : e)) : [],
    editCount: Number.isInteger(c.editCount) ? c.editCount : 0,
    // For the agent details card: the model and mode its Claude runs with, and how this computer
    // connects to it.
    model: typeof c.model === 'string' ? c.model.slice(0, 80) : null, mode: typeof c.mode === 'string' ? c.mode.slice(0, 30) : null,
    login: host && typeof host.login === 'string' && host.login ? host.login.slice(0, 120) : null, effort: c.effort && typeof c.effort === 'object' && effortLib.isLevel(c.effort.level) ? effortLib.shape(c.effort) : null,
    // Answered on that computer only (its panel): here they are counted, never answered.
    waiting: perms.length, waitingFor: perms.slice(0, 3).map((p) => String(p.title || p.tool || 'Permission').slice(0, 120)),
    // "2 of 4 running" there, and the command that continues its session there (Sessions).
    slots: slotsOf(c.slots) || (remote.computers.get(computerKey(computer)) || {}).slots || null,
    resume: resumeCommand(typeof c.file === 'string' ? c.file : null, typeof c.sessionId === 'string' ? c.sessionId : null, c.account),
    // The card's Now line (its current tool step) and its "root" tag.
    step: typeof c.step === 'string' ? c.step.slice(0, 160) : null, asRoot: c.asRoot === 'root' || c.asRoot === 'unsafe' ? c.asRoot : null,
  });
}

// What a task's card says about its files, for the summary in Claude Code's chat
// (mcp/live-page.js): { count, added, removed }, each null when not known (not every edit is kept
// on the card, or an edit came without counts).
function cardFiles(c) {
  const edits = c && Array.isArray(c.edits) ? c.edits.filter((e) => e && typeof e.relFile === 'string') : [];
  const total = c && Number.isInteger(c.editCount) ? c.editCount : edits.length;
  const all = edits.length === total;
  // Line counts from the other computer: whole numbers, and sums that stay whole numbers (Sol L1).
  const num = (v) => (v !== null && v !== undefined && v !== '' && Number.isSafeInteger(Number(v)) && Number(v) >= 0 ? Number(v) : null);
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    const a = num(e.added);
    const r = num(e.removed);
    if (a === null || r === null) added = removed = null;
    if (added !== null) {
      added += a;
      removed += r;
      if (!Number.isSafeInteger(added) || !Number.isSafeInteger(removed)) added = removed = null;
    }
  }
  return { count: all ? new Set(edits.map((e) => worktree.withoutCopy(e.relFile))).size : null, added: all ? added : null, removed: all ? removed : null };
}

function remoteChanged() {
  remote.seq++;
  for (const w of [...remote.waiters]) w();
  remote.waiters.clear();
}

// Start (or keep) following a paired computer's tasks. task/localDir: a task started or continued
// from this project, whose card goes to its pages.
// "" (the only paired computer) and its name are one computer: one loop, each edit once.
function computerKey(name) {
  const key = String(name || '');
  if (key) return key;
  const hosts = pairRemotes.status().hosts;
  return hosts.length === 1 && hosts[0].name ? hosts[0].name : '';
}

// Where each followed computer's edits were up to, and which project here each of its tasks came
// from, kept across a restart of this server: a page that stays open gets the edits made meanwhile
// once, not the last couple of minutes again, and a task's card keeps updating.
const FOLLOW_FILE = path.join(config.stateDir, 'pair-follow.json');
function loadFollow() {
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(FOLLOW_FILE, 'utf8'));
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err.code)) throw err;
    if (err.code !== 'ENOENT') log(`cannot read where paired computers' edits were up to: ${err.code}`);
    return {};
  }
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}
const followSaved = loadFollow();
let followSaveTimer = null;
let followSavedAt = 0;
function saveFollowNow() {
  clearTimeout(followSaveTimer);
  followSaveTimer = null;
  followSavedAt = Date.now();
  const out = {};
  for (const [key, f] of remote.computers) out[key] = { editSeq: f.editSeq, dirs: [...f.dirs] };
  try {
    writeAtomic(FOLLOW_FILE, JSON.stringify(out), { mkdir: true });
  } catch (err) {
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY'].includes(err.code)) throw err;
    log(`cannot save where paired computers' edits were up to: ${err.code}`);
  }
}
// Immediately, or at most once a second while edits keep coming (and when the server stops).
function saveFollowSoon() {
  if (followSaveTimer) return;
  const wait = followSavedAt + 1000 - Date.now();
  if (!(wait > 0)) return saveFollowNow();
  followSaveTimer = setTimeout(saveFollowNow, wait);
  if (followSaveTimer.unref) followSaveTimer.unref();
}
function savedFollow(key) {
  const s = followSaved[key];
  const editSeq = s && Number.isSafeInteger(s.editSeq) && s.editSeq > 0 ? s.editSeq : 0;
  const dirs = new Map((s && Array.isArray(s.dirs) ? s.dirs : [])
    .filter((d) => Array.isArray(d) && /^[0-9a-f]{12}$/.test(String(d[0])) && typeof d[1] === 'string' && d[1] && !tooBroad(d[1])).slice(-REMOTE_KEPT));
  return { editSeq, dirs };
}

// Why that computer's edits can't be fetched now ({ error, since }), or null.
function followDown(name) {
  const f = remote.computers.get(computerKey(name));
  return f && f.down ? f.down : null;
}

// Every paired computer with a page open here: its edits stream to the pages (one loop each).
function followPaired() {
  if (!pages.size) return;
  for (const h of pairRemotes.status().hosts) if (h.name) followComputer(h.name);
}

function followComputer(name, task, localDir) {
  const key = computerKey(name);
  let f = remote.computers.get(key);
  // key: the name this computer connects to it by; name: the name it gives itself (shown on pages).
  if (!f) remote.computers.set(key, (f = { seq: 0, ...savedFollow(key), tasks: new Map(), cards: new Map(), running: false, until: 0, name: key, key }));
  if (/^[0-9a-f]{12}$/.test(String(task || '')) && typeof localDir === 'string' && localDir && !tooBroad(localDir)) {
    f.dirs.set(task, localDir);
    if (f.dirs.size > REMOTE_KEPT) f.dirs.delete(f.dirs.keys().next().value);
    saveFollowSoon();
  }
  f.until = Date.now() + FOLLOW_IDLE_MS;
  if (f.running) {
    // Waiting after a failure: a page that opens or the link reconnecting retries now.
    if (f.wake) f.wake();
    return;
  }
  f.running = true;
  (async () => {
    let fails = 0;
    for (;;) {
      const r = await pairRemotes.task(key, { op: 'watch-all', since: f.seq, wait: 50, editsSince: f.editSeq });
      if (!r || r.error || !Array.isArray(r.tasks)) {
        // An older EditLens there: follow each task with op "watch".
        if (r && /Unknown op/i.test(String(r.error || ''))) {
          for (const [id, dir] of f.dirs) mirrorOne(key, id, dir);
          break;
        }
        fails++;
        // Said on the line above the prompt and in Details (pairedSummary) while it lasts.
        if (fails >= 3 && !f.down) {
          f.down = { error: String((r && r.error) || `${f.name} did not respond`).slice(0, 300), since: Date.now() };
          log(`edits on ${f.name}: can't get them (${f.down.error}); trying again`);
          summaryWatch.nudge();
        }
        // While a page is open here and it is paired, it never stops trying (every 30 s at most).
        // Otherwise it stops after 5 tries: a page that opens, the link reconnecting or the 30 s
        // check starts it again (followPaired).
        if (fails > 5 && !(pages.size && pairedWith(key))) break;
        await new Promise((res) => {
          const timer = setTimeout(res, Math.min(30000, 2000 * fails));
          f.wake = () => {
            clearTimeout(timer);
            res();
          };
        });
        f.wake = null;
        continue;
      }
      fails = 0;
      if (f.down) {
        log(`edits on ${f.name}: getting them again`);
        f.down = null;
        summaryWatch.nudge();
      }
      const seq = Number.isSafeInteger(r.seq) && r.seq > 0 ? r.seq : 0;
      // That computer restarted (its numbers decreased): take everything it has again.
      if (seq < f.seq) f.tasks.clear();
      f.seq = seq;
      if (r.computer) f.name = String(r.computer).slice(0, 100);
      for (const e of r.tasks) {
        if (!e || !/^[0-9a-f]{12}$/.test(String(e.task))) continue;
        const { card, ...summary } = e;
        f.tasks.delete(e.task);
        // note: why it waits ("Waiting · vm is running 4 tasks"), for the line in Claude Code.
        f.tasks.set(e.task, { ...summary, computer: f.name, note: card && typeof card.note === 'string' ? card.note.slice(0, 300) : null, files: card ? cardFiles(card) : null });
        if (f.tasks.size > REMOTE_KEPT) f.tasks.delete(f.tasks.keys().next().value);
        if (card && f.dirs.has(e.task)) {
          // Kept to draw again when that computer starts or stops letting this one answer.
          f.cards.delete(e.task);
          f.cards.set(e.task, card);
          if (f.cards.size > REMOTE_KEPT) f.cards.delete(f.cards.keys().next().value);
          remoteCard(f.name, e.task, f.dirs.get(e.task), card);
        }
      }
      if (r.tasks.length) remoteChanged();
      // How many of its Tasks at once run there now ("2 of 4 running" on this project's cards).
      const slots = slotsOf(r.slots);
      if (slots && JSON.stringify(slots) !== JSON.stringify(f.slots || null)) {
        f.slots = slots;
        broadcastVolatile({ type: 'task-slots', sessionId: `task-slots:${f.name}`, computer: f.name, running: slots.running, limit: slots.limit });
      }
      // Root (unsafe) on there: every page here warns while it is on.
      if (typeof r.rootTasks === 'boolean' && r.rootTasks !== Boolean(f.rootTasks)) {
        f.rootTasks = r.rootTasks;
        broadcastVolatile({ type: 'task-root', sessionId: `task-root:${f.name}`, state: r.rootTasks ? 'on' : 'off', computer: f.name, remote: true });
      }
      // Its edits, in full: on this computer's pages with their code (never highlighted here).
      if (Array.isArray(r.edits)) {
        for (const it of r.edits) {
          try {
            remoteEdit(f, it);
          } catch (err) {
            if (!(err instanceof Error)) throw err;
            log(`edits on ${f.name}: one could not be shown (${err.message})`);
          }
        }
        // Edits made there while this computer was offline and no longer kept there: pages say how many.
        if (r.lost && typeof r.lost === 'object') remoteLost(f, r.lost);
        if (Number.isSafeInteger(r.editSeq) && r.editSeq > 0 && r.editSeq !== f.editSeq) {
          f.editSeq = r.editSeq;
          saveFollowSoon();
        }
      }
      const busy = [...f.tasks.values()].some((x) => !MIRROR_DONE.has(x.state) || x.waiting > 0);
      // While it is paired and a page is open here, its sessions' edits continue to be sent.
      if (!busy && Date.now() > f.until && !(pages.size && pairedWith(key))) break;
    }
  })().catch((err) => log(`tasks on ${key || 'the paired computer'}: could not get their updates (${err.message})`)).finally(() => {
    f.running = false;
    f.wake = null;
    // Stopped with no page open: no longer reported as unreachable.
    if (f.down && !pages.size) {
      f.down = null;
      summaryWatch.nudge();
    }
  });
}

// Joined to that computer (name "" when it is the only one).
function pairedWith(name) {
  const hosts = pairRemotes.status().hosts;
  return name ? hosts.some((h) => h.name === name) : hosts.length === 1;
}

// One edit on a paired computer (tasks.pushEdit there) as an edit card here: labelled with that computer,
// in its own Agents switcher row, with code view replay; never highlighted. Restore is done there
// (server/remote-restore.js): only Claude's edits and restores in its project include the ref it needs.
// A task started from a project here shows on that project's pages; anything else on every page here.
function remoteEdit(f, it) {
  if (it && it.outside) return remoteOutside(f, it);
  if (!it || typeof it.rel !== 'string' || !it.rel || it.rel.split('/').includes('..')) return;
  const task = /^[0-9a-f]{12}$/.test(String(it.task || '')) ? it.task : null;
  const dir = task ? f.dirs.get(task) || null : null;
  // An older EditLens there names a file in a subagent's copy by its path in the copy.
  const rel = (worktree.withoutCopy(it.rel) || it.rel).slice(0, 500);
  const text = (v) => (typeof v === 'string' ? v : undefined);
  const before = text(it.before);
  const after = it.deleted ? '' : text(it.after);
  const hunks = Array.isArray(it.hunks) ? it.hunks : before !== undefined && after !== undefined ? diffText(before, after) : [];
  const clamped = clampHunks(hunks);
  const ext = path.extname(rel).toLowerCase();
  const name = f.name || 'paired computer';
  const source = task ? `task ${task.slice(0, 6)}` : it.agentType ? `${it.agentType} session` : 'session';
  // Its counts as that computer sent them, else from its lines; null when neither is known (a key
  // file, or a file too large to send), so pages say "lines not known yet" instead of "0 lines".
  const sent = it.stats && typeof it.stats === 'object' ? [Number(it.stats.added), Number(it.stats.removed)] : null;
  const stats = sent && sent.every((n) => Number.isFinite(n) && n >= 0) ? { added: sent[0], removed: sent[1] }
    : hunks.length || (before !== undefined && after !== undefined) ? countStats(hunks) : null;
  const kind = task ? 'task' : 'session';
  // An EditLens there older than Restore through the link sends no ref at all (null: not restorable).
  const old = kind === 'session' && it.ref === undefined;
  const ref = kind === 'session' ? remoteRef(it.ref, rel) : null;
  const rst = ref ? remoteRestoreFields(f, it.restore) : null;
  addEvent(takeEvent({
    type: 'change', tool: rst ? 'Restore' : typeof it.tool === 'string' ? it.tool.slice(0, 40) : 'Edit', ts: Date.now(), sessionId: null,
    // Its own row in the Agents switcher (and the code view's Follow): one per task, one for the
    // sessions there. A restore is the user's action, not Claude's: no row.
    agentId: rst ? null : `r:${name}:${task || 'sessions'}`, agentType: rst ? null : `◆ ${name}`,
    remote: { computer: name, kind, task, taskKind: it.taskKind === 'mine' ? 'mine' : it.taskKind === 'theirs' ? 'theirs' : null, inCopy: it.inCopy === true,
      source, prompt: typeof it.prompt === 'string' ? it.prompt.slice(0, 200) : null, anywhere: !dir, secret: Boolean(it.secret),
      link: typeof f.key === 'string' ? f.key : '', ref: ref || undefined, old: old || undefined },
    taskCwd: dir || undefined, cwd: dir || null, project: dir ? path.basename(dir) : null,
    // Its path there: the code view keeps it separate from this project's own file of the same name.
    file: String(it.file || rel).slice(0, 1000), relFile: `◆ ${name}: ${rel}`,
    ext, kind: rst ? 'restore' : classify(rel, after || ''), routes: [], created: Boolean(it.created), deleted: Boolean(it.deleted),
    intent: typeof it.intent === 'string' ? it.intent.slice(0, 300) : '', autoIntent: false,
    hunks: clamped.hunks, truncated: clamped.truncated || Boolean(it.truncated), stats, hints: buildHints({ ext, hunks, fileText: after || '' }),
    before, after,
    // Its copy's id there: the page's Restore code finds cards by it (requests are sent there).
    ...(ref && ref.backup ? { backup: ref.backup } : {}),
    ...(ref && (it.backupSkipped === 'large' || it.backupSkipped === 'binary') ? { backupSkipped: it.backupSkipped } : {}),
    ...(rst ? { ...rst, fileKind: classify(rel, after || '') } : {}),
  }));
}

// The ref a paired computer sent with its edit, checked: { seq, backup, rel } or null.
function remoteRef(ref, rel) {
  if (!ref || typeof ref !== 'object') return null;
  const s = seqOf(ref.seq);
  const backup = ref.backup === null || ref.backup === undefined ? null : typeof ref.backup === 'string' && BACKUP_ID.test(ref.backup) ? ref.backup : undefined;
  // inst: that computer's server start, sent back with a restore (an older EditLens sends none).
  const inst = typeof ref.inst === 'string' && /^[0-9a-f]{16}$/.test(ref.inst) ? ref.inst : null;
  return s && backup !== undefined ? { seq: s, backup, rel, ...(inst ? { inst } : {}) } : null;
}

// A restore there: which card here it belongs to. Its numbers are that computer's, so they are
// matched to the cards of its edits here.
function remoteRestoreFields(f, r) {
  if (!r || typeof r !== 'object' || !['restore', 'undo', 'remove', 'undo-edit'].includes(r.via)) return null;
  const id = (v) => (typeof v === 'string' && BACKUP_ID.test(v) ? v : null);
  const here = (v) => {
    const s = seqOf(v);
    if (!s) return null;
    for (let i = history.length - 1; i >= 0; i--) {
      const e = history[i];
      if (e.remote && e.remote.link === f.key && e.remote.ref && e.remote.ref.seq === s) return e.seq;
    }
    return null;
  };
  return { via: r.via, restoredFrom: id(r.restoredFrom), undidBackup: id(r.undidBackup), undidSeq: here(r.undidSeq), removedSeq: here(r.removedSeq) };
}

// Claude on the paired computer edits outside the project this computer is paired with: those
// edits are not sent, so the pages here say where it works instead (once per folder, every 10 min).
function remoteOutside(f, it) {
  const where = typeof it.cwd === 'string' ? it.cwd.slice(0, 500) : '';
  if (!where) return;
  f.outsideShown = f.outsideShown || new Map();
  if (Date.now() - (f.outsideShown.get(where) || 0) < 10 * 60000) return;
  f.outsideShown.set(where, Date.now());
  if (f.outsideShown.size > 50) f.outsideShown.delete(f.outsideShown.keys().next().value);
  const name = f.name || 'the paired computer';
  log(`edits on ${name} in ${where}: outside the paired project, not sent`);
  broadcastVolatile({ type: 'remote-outside', sessionId: `outside:${name}`, cwd: null, computer: name, where, paired: typeof it.pairCwd === 'string' ? it.pairCwd.slice(0, 500) : null, ts: Date.now() });
}

// That computer removed edits this one had not received yet (it keeps as many as its size limit
// allows, and this computer was offline longer): every page here says how many, once.
function remoteLost(f, lost) {
  const n = Number(lost.count);
  const count = Number.isSafeInteger(n) && n > 0 ? n : 0;
  const more = lost.more === true;
  if (!count && !more) return;
  const name = f.name || 'the paired computer';
  const text = count
    ? `${more ? 'More than ' : ''}${count} older ${count === 1 && !more ? 'edit' : 'edits'} from ◆ ${name} ${count === 1 && !more ? 'was' : 'were'} not kept there while this computer was away, so ${count === 1 && !more ? 'it is' : 'they are'} not shown here.`
    : `Older edits from ◆ ${name} were not kept there while this computer was away, so they are not shown here.`;
  log(`edits on ${name}: ${text}`);
  broadcastVolatile({ type: 'remote-missed', sessionId: `missed:${name}:${Date.now()}`, cwd: null, computer: name, count, more, text, ts: Date.now() });
}

// Paired computers' edits are received while a page is open here, not only while a task runs:
// from the moment a page opens or a link reconnects (followPaired), and checked every 30 s.
setInterval(followPaired, 30000).unref();

// Tasks this computer's Claude asked a paired computer for that wait to be sent, or did not start:
// the project's pages (a card) and the line in Claude Code (summary taskNotices) show them, not
// only the agent that asked. key -> { key, computer, cwd, state: 'waiting' | 'refused', prompt,
// short, text, followUp, at }. A notice is cleared when its task starts (its own card then shows it).
const startNotices = new Map();
const NOTICE_REFUSED_MS = 10 * 60000;
const NOTICE_SENDING_MS = 6 * 60000; // lib/remotework.js waits 5 minutes for a turn to send
function startNotice(key, n) {
  const old = startNotices.get(key);
  if (!n) {
    if (!old) return;
    startNotices.delete(key);
    broadcastVolatile({ type: 'task-notice', sessionId: `notice:${key}`, cwd: old.cwd, state: 'cleared' });
  } else {
    const rec = { key, ...n, at: Date.now() };
    startNotices.delete(key);
    startNotices.set(key, rec);
    if (startNotices.size > 30) startNotices.delete(startNotices.keys().next().value);
    if (n.state === 'refused') log(`task on ${n.computer} didn't start: ${n.text}`);
    broadcastVolatile({ type: 'task-notice', sessionId: `notice:${key}`, cwd: n.cwd, computer: n.computer, state: n.state, prompt: n.prompt, text: n.text, why: n.why || null, followUp: Boolean(n.followUp) });
  }
  summaryWatch.nudge();
}
// What POST /remote/task saw for one op of a task start: a notice, or none (the task started).
function noteStart(key, { op, answer, computer, cwd, prompt, followUp }) {
  const who = computer || 'the paired computer';
  const err = answer && typeof answer.error === 'string' ? answer.error : answer ? null : 'no answer';
  const base = { computer: who, cwd: typeof cwd === 'string' && cwd ? cwd.slice(0, 1000) : null, prompt: String(prompt || '').trim().slice(0, 300), followUp: Boolean(followUp) };
  if (op === 'upload') {
    if (err && /already being sent/i.test(err)) {
      return startNotice(key, { ...base, state: 'waiting', short: `Task waiting to be sent to ◆ ${who}`, text: `Waiting · ◆ ${who} is receiving 2 other projects from this computer. This one is sent next.` });
    }
    if (!err) return startNotices.has(key) && startNotices.get(key).state === 'waiting' ? startNotice(key, null) : undefined;
  }
  if (!err) return startNotice(key, null);
  return startNotice(key, { ...base, state: 'refused', short: `${followUp ? 'Follow-up' : 'Task'} on ◆ ${who} didn't start`, text: `Didn't start · ${err}`, why: err.slice(0, 600) });
}
// For the summary: notices of this project (cwd), and its tasks that wait there for a free session.
function laptopNotices(cwd) {
  const out = [];
  const now = Date.now();
  for (const n of startNotices.values()) {
    if (now - n.at > (n.state === 'refused' ? NOTICE_REFUSED_MS : NOTICE_SENDING_MS)) continue;
    if (cwd && !(n.cwd && rootMatches(n.cwd, cwd))) continue;
    out.push({ where: 'there', computer: n.computer, state: n.state, short: n.short, text: n.text, prompt: n.prompt, at: n.at });
  }
  for (const f of remote.computers.values()) {
    for (const t of f.tasks.values()) {
      const dir = f.dirs.get(t.task);
      if (cwd && !(dir && rootMatches(dir, cwd))) continue;
      if (t.state === 'waiting') {
        out.push({ where: 'there', computer: f.name, state: 'waiting', short: `Task waiting on ◆ ${f.name}`, text: t.note || `Waiting · ◆ ${f.name} has no free session. It starts when one of its tasks finishes.`, prompt: t.prompt || '', at: timeOf(t.updatedAt) || now });
      } else if (t.state === 'failed' && !(Number.isSafeInteger(Number(t.replyCount)) && Number(t.replyCount) > 0) && now - (timeOf(t.updatedAt) || 0) < NOTICE_REFUSED_MS) {
        out.push({ where: 'there', computer: f.name, state: 'refused', short: `Task on ◆ ${f.name} didn't start`, text: `Didn't start · ${t.error || 'unknown error'}`, prompt: t.prompt || '', at: timeOf(t.updatedAt) || now });
      }
    }
  }
  return out;
}

// A task just started or given a follow-up: working from now in the copy here, so a wait right
// after it never sees the last turn's "idle".
function noteStarted(name, report) {
  const f = remote.computers.get(computerKey(name));
  const id = String(report.task || '');
  if (!f || !/^[0-9a-f]{12}$/.test(id)) return;
  const old = f.tasks.get(id) || {};
  f.tasks.delete(id);
  f.tasks.set(id, { ...old, task: id, computer: f.name, state: typeof report.state === 'string' ? report.state : 'working', seq: old.seq || 0,
    waiting: 0, replyCount: Number.isInteger(report.replyCount) ? report.replyCount : old.replyCount || 0, activityCount: old.activityCount || 0,
    editCount: old.editCount || 0, prompt: String(report.prompt || old.prompt || '').slice(0, 120), updatedAt: Date.now(),
    effort: report.effort && typeof report.effort === 'object' ? report.effort : old.effort || null });
  remoteChanged();
}

// The cached tasks (every followed computer), returned immediately or at the next change.
async function remoteTasks(since, wait) {
  const ms = Math.min(60, Math.max(0, Number.isFinite(wait) ? wait : 0)) * 1000;
  if (ms && Number.isSafeInteger(since) && since >= remote.seq) {
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        remote.waiters.delete(done);
        resolve();
      }, ms);
      remote.waiters.add(done);
    });
  }
  // The same computer followed by two names ("" when it is the only one, and its name): once.
  const byId = new Map();
  for (const f of remote.computers.values()) {
    for (const t of f.tasks.values()) if (!byId.has(t.task) || (byId.get(t.task).seq || 0) < (t.seq || 0)) byId.set(t.task, t);
  }
  // How many of its Tasks at once run on each computer ("2 of 4 running"), when it said.
  const slots = {};
  for (const f of remote.computers.values()) if (f.slots && f.name) slots[f.name] = f.slots;
  return { seq: remote.seq, tasks: [...byId.values()], slots };
}

// Following one task with op "watch" (a paired computer on EditLens 0.23.3).
const mirrors = new Map(); // "<computer>\0<task>" -> true while followed
function mirrorTask(computer, task, localDir) {
  followComputer(computer, task, localDir);
}
function mirrorOne(computer, task, localDir) {
  if (!/^[0-9a-f]{12}$/.test(task) || typeof localDir !== 'string' || !localDir || tooBroad(localDir)) return;
  const key = `${computer}\0${task}`;
  if (mirrors.has(key)) return;
  mirrors.set(key, true);
  (async () => {
    let since = 0;
    let fails = 0;
    for (let round = 0; round < 2000; round++) {
      const r = await pairRemotes.task(computer, { op: 'watch', task, since, wait: 50 });
      if (!r || r.error || !r.card) {
        if (r && /No such task|unknown op|op "/i.test(String(r.error || ''))) break;
        if (++fails > 5) break;
        await new Promise((res) => setTimeout(res, 2000 * fails));
        continue;
      }
      fails = 0;
      since = Number.isFinite(Number(r.updatedAt)) ? Number(r.updatedAt) : Date.now();
      remoteCard(String(r.computer || computer), task, localDir, r.card);
      if (MIRROR_DONE.has(r.card.state) && !(Array.isArray(r.card.permissions) && r.card.permissions.length)) break;
    }
  })().catch((err) => log(`task ${task} on ${computer}: could not get its updates (${err.message})`)).finally(() => mirrors.delete(key));
}

// One file apply_computer_task wrote.
// body: { task, computer, dir, path, status, intent, before, after, binary }
function remoteApplied(body) {
  const dir = typeof body.dir === 'string' ? body.dir : '';
  const rel = typeof body.path === 'string' ? body.path.replace(/\\/g, '/') : '';
  if (!dir || tooBroad(dir) || !rel || rel.split('/').includes('..') || path.isAbsolute(rel)) return { error: 'bad file' };
  const file = path.join(dir, rel);
  const from = typeof body.computer === 'string' && body.computer ? body.computer.slice(0, 100) : 'the paired computer';
  log(body.undo ? `undid the apply of ${rel}` : body.task ? `task ${String(body.task).slice(0, 20)}: applied ${rel} from ${from}` : `copied ${rel} from ${from}`);
  if (body.binary) return { ok: true, shown: false };
  const deleted = body.status === 'deleted';
  const before = typeof body.before === 'string' ? body.before : undefined;
  const after = deleted ? '' : typeof body.after === 'string' ? body.after : undefined;
  const hunks = before !== undefined && after !== undefined ? diffText(before, after) : [];
  const clamped = clampHunks(hunks);
  const ext = path.extname(file).toLowerCase();
  const said = typeof body.intent === 'string' && body.intent.trim() ? body.intent.trim().slice(0, 300) : deleted ? 'Deleted' : before === '' ? 'Added' : 'Changed';
  addEvent(takeEvent({
    type: 'change', tool: 'Apply', ts: Date.now(), sessionId: null, agentId: null, agentType: null, remoteTask: String(body.task || '').slice(0, 20), from,
    cwd: dir, project: path.basename(dir), file, relFile: rel, ext, kind: classify(rel, after || ''), routes: [],
    created: before === '', deleted, intent: body.undo ? said : `${said} (from ${from})`, autoIntent: false,
    hunks: clamped.hunks, truncated: clamped.truncated, stats: countStats(hunks), hints: buildHints({ ext, hunks, fileText: after || '' }),
    before, after,
  }));
  return { ok: true, shown: true };
}

// The last time Claude here added a task's changes: apply_computer_task into this project, or
// merge_computer_task into that computer's own project (mcp/live-page.js says so). The task's card
// says "Added to your files" with Undo. task id -> { task, computer, how: 'apply' | 'merge', apply,
// count, cwd, at, undone }
const taskApplied = new Map();
const APPLIED_KEPT = 50;
function appliedEvent(rec) {
  broadcastVolatile({ type: 'task-applied', sessionId: `task-applied-${rec.task}`, cwd: rec.cwd, taskId: rec.task, computer: rec.computer, how: rec.how,
    count: rec.count, at: rec.at, undone: rec.undone, canUndo: !rec.undone && (rec.how === 'merge' || Boolean(rec.apply)) });
}
// body: { task, computer, dir, how, apply, count }, or { task | apply, dir, undone: true }
function noteApplied(body) {
  const task = String(body.task || '');
  const cwd = typeof body.dir === 'string' && body.dir && !tooBroad(body.dir) ? body.dir : null;
  if (body.undone === true) {
    const apply = String(body.apply || '');
    const old = taskApplied.get(task) || [...taskApplied.values()].find((r) => apply && r.apply === apply);
    if (!old || (cwd && !rootMatches(cwd, old.cwd))) return { ok: true };
    old.undone = true;
    appliedEvent(old);
    return { ok: true };
  }
  if (!/^[0-9a-f]{12}$/.test(task) || !cwd) return { error: 'bad task or dir' };
  const n = Number(body.count);
  const rec = {
    task, computer: typeof body.computer === 'string' ? body.computer.slice(0, 100) : '', how: body.how === 'merge' ? 'merge' : 'apply',
    apply: /^[0-9a-f]{12}$/.test(String(body.apply || '')) ? String(body.apply) : null, count: Number.isSafeInteger(n) && n >= 0 ? n : 0, cwd, at: Date.now(), undone: false,
  };
  taskApplied.delete(task);
  taskApplied.set(task, rec);
  if (taskApplied.size > APPLIED_KEPT) taskApplied.delete(taskApplied.keys().next().value);
  appliedEvent(rec);
  return { ok: true };
}
// Undo on a task card: the same work as undo_computer_task_apply (the files are restored here, each
// only while it is as the apply left it) or undo_computer_task_merge (done on that computer).
async function undoApplied(rec) {
  let out;
  if (rec.how === 'apply') {
    if (!rec.apply) return { error: 'This apply can\'t be undone from the page. Ask Claude to use undo_computer_task_apply.' };
    const text = (b, max) => (b && remotework.isText(b) && b.length <= max ? b.toString('utf8') : undefined);
    out = await remotework.undoApply({ stateDir: config.stateDir, apply: rec.apply, files: null,
      onUndone: (f) => remoteApplied({ undo: true, dir: rec.cwd, path: f.path, status: f.after === null ? 'deleted' : 'changed', intent: 'Undone: back as it was before the apply',
        binary: Boolean((f.before && !remotework.isText(f.before)) || (f.after && !remotework.isText(f.after))) || undefined,
        before: f.before ? text(f.before, 2 * 1024 * 1024) : '', after: f.after ? text(f.after, 512 * 1024) : '' }) });
  } else {
    const f = [...remote.computers.values()].find((x) => x.dirs.has(rec.task));
    out = f ? await pairRemotes.task(f.key, { op: 'undo-merge', task: rec.task }) : { error: `◆ ${rec.computer || 'The paired computer'} is not connected.` };
  }
  if (!out || out.error) return out || { error: 'No response.' };
  // Files not put back keep the card's Undo, so it can try them again (Sol M6).
  const kept = Array.isArray(out.kept) ? out.kept.length : 0;
  rec.undone = kept === 0;
  appliedEvent(rec);
  log(`task ${rec.task}: the ${rec.how} was undone from a page (${(out.undone || []).length} files, ${kept} kept)`);
  return kept ? { ...out, partial: true } : out;
}

// A file a task's Claude changed by a command (not Edit or Write): shown as its edit, as the hook
// would have reported it. e: tasks.commandEdits()
function commandEdit(t, e) {
  const before = typeof e.before === 'string' ? e.before : undefined;
  const after = typeof e.after === 'string' ? e.after : undefined;
  const hunks = before !== undefined && after !== undefined ? diffText(before, after) : [];
  const clamped = clampHunks(hunks);
  const ext = path.extname(e.rel).toLowerCase();
  const body = {
    type: 'change', tool: 'Bash', ts: Date.now(), sessionId: t.sessionId || null, agentId: null, agentType: null, cwd: t.dir,
    file: e.file, relFile: e.rel, ext, kind: classify(e.rel, after || ''), routes: [], created: Boolean(e.created), deleted: Boolean(e.deleted),
    intent: e.deleted ? 'Deleted by a command' : e.created ? 'Created by a command' : 'Changed by a command', autoIntent: true,
    hunks: clamped.hunks, truncated: clamped.truncated || after === undefined, stats: countStats(hunks), hints: buildHints({ ext, hunks, fileText: after || '' }),
    before, after,
  };
  // The file is in the task's workspace, not this project: no Restore.
  const publicEvent = takeEvent({ ...body, noBackup: true });
  tasks.noteEdit(t, e.file, body);
  if (t.kind === 'sent') {
    publicEvent.task = { id: t.id, by: t.by };
    publicEvent.taskCwd = t.cwd;
  }
  feedEdit(body, addEvent(publicEvent), t);
}

// An edit here that a paired computer's panel shows live (tasks.pushEdit): its tasks' edits, and
// edits by sessions here in the project it is paired with. Never one shown here from elsewhere.
// publicEvent: the event as added (with its seq).
function feedEdit(body, publicEvent, t) {
  if (body.remote || (!t && !pairHost.pairs.length)) return;
  // A session's edit outside every paired project is never sent (only its folder is named), so
  // its text is not kept for them (they are kept on disk: server/editfeed.js). Where the file really
  // is counts: a folder link in a paired project can lead to another project (Sol 0.24.45 H2).
  const shared = Boolean(t) || pairHost.pairs.some((p) => p && typeof p.cwd === 'string' && !safepath.fileIn(p.cwd, body.file).error);
  const snap = shared && publicEvent.snapshot ? snapshots.items.get(publicEvent.snapshot) : null;
  const text = (v) => (typeof v === 'string' ? v : null);
  // What the paired computer sends back to ask for Restore here (server/remote-restore.js checks
  // it all again): only for Claude's edits and restores in this project, never a task's, a
  // copy's or the task account's. rel is added by tasks.editsFor.
  const ref = !t && !publicEvent.copy && !publicEvent.task && !publicEvent.fromTaskAccount && Number.isSafeInteger(publicEvent.seq)
    ? { seq: publicEvent.seq, backup: publicEvent.backup || null, inst: INSTANCE } : null;
  const restore = publicEvent.kind === 'restore' ? {
    via: publicEvent.via, restoredFrom: publicEvent.restoredFrom || null, undidBackup: publicEvent.undidBackup || null,
    undidSeq: publicEvent.undidSeq || null, removedSeq: publicEvent.removedSeq || null,
  } : null;
  tasks.pushEdit({
    ref, restore, backupSkipped: publicEvent.backupSkipped || null,
    kind: t ? 'task' : 'session', task: t ? t.id : null, pairId: t ? t.pairId : null, taskKind: t ? (t.kind === 'sent' ? 'mine' : 'theirs') : null,
    // A task on this project works in a copy of it (a git project) or in the project itself.
    inCopy: t ? Boolean(t.kind === 'sent' || t.copy) : null,
    by: t ? t.by : null, prompt: t ? String(t.prompt || '').slice(0, 200) : null, dir: t ? t.dir : null, file: body.file,
    tool: typeof body.tool === 'string' ? body.tool.slice(0, 40) : 'Edit', intent: typeof body.intent === 'string' ? body.intent.slice(0, 300) : '',
    agentType: t ? null : typeof body.agentType === 'string' ? body.agentType.slice(0, 60) : null, sessionId: t ? null : body.sessionId || null,
    sessionCwd: t ? null : typeof body.cwd === 'string' ? body.cwd.slice(0, 1000) : null,
    stats: publicEvent.stats || null, created: Boolean(publicEvent.created), deleted: Boolean(publicEvent.deleted),
    hunks: shared && Array.isArray(publicEvent.hunks) ? publicEvent.hunks : [], truncated: Boolean(publicEvent.truncated),
    before: snap ? text(snap.before) : null, after: snap ? text(snap.after) : null, ts: Date.now(),
  });
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Undoes a task's last merge here: a file is restored only while it is still as the merge left it.
function undoMerge(t) {
  const list = Array.isArray(t.lastMerge) ? t.lastMerge : [];
  if (!list.length) return { error: 'Nothing to undo: this task\'s changes were not merged here (or the undo was already done).' };
  const out = { undone: [], kept: [] };
  const again = []; // not put back now, but maybe later: kept for the next undo (Sol M6)
  for (const u of list) {
    // Where the file really is now: a folder on its path can have become a link since the merge (Sol H2).
    const rel = path.relative(t.root, u.file);
    const at = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? safepath.inside(t.root, rel) : { error: 'outside' };
    if (at.error || at.rel !== rel.split(path.sep).join('/') || sendproject.excluded(at.rel)) {
      out.kept.push({ path: u.relFile, why: 'it is outside the project now (through a link)' });
      again.push(u);
      continue;
    }
    let now = null;
    try {
      now = fs.readFileSync(at.file, 'utf8');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        if (err && err.code) {
          out.kept.push({ path: u.relFile, why: err.code });
          again.push(u);
          continue;
        }
        throw err;
      }
    }
    const unchanged = u.deleted ? now === null : now !== null && sha256(now) === u.after;
    if (u.binary || !unchanged || (!u.created && !u.backup)) {
      out.kept.push({ path: u.relFile, why: u.binary ? 'binary file: not kept for undo' : !unchanged ? 'changed since the merge' : 'its earlier version is no longer kept' });
      // Changed since the merge: it can be as the merge left it again. The others never can.
      if (!u.binary && !unchanged && (u.created || u.backup)) again.push(u);
      continue;
    }
    let done;
    if (u.created) {
      try {
        fs.unlinkSync(at.file);
      } catch (err) {
        if (!err || !err.code) throw err;
        out.kept.push({ path: u.relFile, why: err.code });
        again.push(u);
        continue;
      }
      done = { file: u.file, relFile: u.relFile, cwd: t.cwd, before: now, after: '', deleted: true, undo: null };
    } else {
      // Undoing a merge is itself the undo, as before: done also when the merged file can't be kept.
      done = backups.restore(u.backup, { noUndo: true });
      if (done.error) {
        out.kept.push({ path: u.relFile, why: done.error });
        if (!done.gone) again.push(u);
        continue;
      }
    }
    out.undone.push(u.relFile);
    // Shown on every page like an edit: "Merge undone", played in the code view.
    if (!done.same) restoreEvent({ ...done, cwd: done.cwd || t.cwd }, 'merge-undo', u.backup);
  }
  t.lastMerge = again.length ? again : null;
  log(`task ${t.id}: merge undone (${out.undone.length} files, ${out.kept.length} kept)`);
  if (!out.kept.length) return out;
  return { ...out, partial: true, note: again.length ? 'Some files were not put back (see kept). Undo again to try those files.' : 'Some files were not put back (see kept).' };
}

// The newest events for a page that just opened: REPLAY_EVENTS of them, within REPLAY_BYTES.
function replayTail() {
  let i = history.length;
  let bytes = 0;
  while (i > 0 && history.length - i < REPLAY_EVENTS && (i === history.length || bytes + history[i - 1].bytes <= REPLAY_BYTES)) {
    i -= 1;
    bytes += history[i].bytes;
  }
  return history.slice(i);
}

function addEvent(raw) {
  const event = { ...raw, seq: ++seq, receivedAt: Date.now() };
  const ts = Number(event.ts);
  // Replace anything non-numeric so the page never shows "NaN ago".
  event.ts = Number.isFinite(ts) && ts > 0 ? ts : event.receivedAt;
  // Its size, measured once (not sent: not enumerable), so the history is limited by bytes as well
  // as by count: a run of big edits can't use a hundred megabytes.
  Object.defineProperty(event, 'bytes', { value: jsonBytes(event) });
  history.push(event);
  historyBytes += event.bytes;
  let drop = 0;
  while (drop < history.length - 1 && (history.length - drop > config.historySize || historyBytes > HISTORY_BYTES)) {
    historyBytes -= history[drop].bytes;
    drop += 1;
  }
  if (drop) history.splice(0, drop);
  lastActivity = Date.now();
  broadcast(event);
  rememberEdit(event);
  return event;
}

// ---------- sessions: follow the transcript of every session that reports in ----------
const SESSION_END_GRACE_MS = 30000;
const endTimers = new Map(); // sessionId -> timer that stops following it after it ended
const pastCwds = new Map(); // folders of sessions no longer followed -> when, newest last (max 20)

function dropSession(sessionId) {
  const w = sessions.get(sessionId);
  clearTimeout(endTimers.get(sessionId));
  endTimers.delete(sessionId);
  if (!w) return;
  w.stop();
  sessions.delete(sessionId);
  if (w.cwd) {
    pastCwds.delete(w.cwd);
    pastCwds.set(w.cwd, Date.now());
    if (pastCwds.size > 20) pastCwds.delete(pastCwds.keys().next().value);
  }
  for (const key of [...latestVolatile.keys()]) {
    if (key.split(':')[1] === sessionId) latestVolatile.delete(key); // <type>:<session>[:<agent>]
  }
}

// A session that ended stops being followed after a short wait (a /resume reports in again).
function sessionEnded(sessionId) {
  if (!sessions.has(sessionId)) return;
  clearTimeout(endTimers.get(sessionId));
  const t = setTimeout(() => dropSession(sessionId), SESSION_END_GRACE_MS);
  t.unref();
  endTimers.set(sessionId, t);
}

// A project folder a session sent: a real folder, not a file, / or the home folder.
function projectDir(cwd) {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 4096 || tooBroad(cwd)) return false;
  try {
    return fs.statSync(cwd).isDirectory();
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENAMETOOLONG', 'ELOOP', 'EINVAL'].includes(err.code)) return false;
    throw err;
  }
}
const NOT_PROJECT = 'That is not a project folder: run this in your project\'s folder.';

// One at a time: auto control when the page opens and /editlens control can arrive together, and
// two overlapping starts would leave Claude running with no page that has the key. The later one
// then finds Claude running and gives its pages the same key.
let grantChain = Promise.resolve();
// Page control on for a project: from /editlens control (bin/drive.js), or by itself when the
// project's page opens (autoControl). -> [status, answer]
function grantDrive(body) {
  const next = grantChain.then(() => grantDriveNow(body));
  // The caller gets this grant's error from `next`; the chain only waits for it to finish.
  grantChain = next.then(() => undefined, () => undefined);
  return next;
}
async function grantDriveNow(body) {
  // Start page control on a fork of the session; the key is sent only on this project's streams.
  let cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
  if (!cwd) return [400, { error: 'missing project folder' }];
  // Turned on by itself (also the setup run a session start's request began, origin auto): only this
  // computer's own pages, unless a paired computer asked (paired).
  const ownOnly = (Boolean(body.auto) || body.origin === 'auto') && body.paired !== true;
  // Asked for by a paired computer: refused once that pairing is removed, also during the start (Sol M3).
  const pairedBy = pairIdOf(body.pairedBy);
  const unpaired = () => Boolean(pairedBy) && !pairHost.has(pairedBy);
  const UNPAIRED = 'The pairing was removed during the start.';
  if (unpaired()) return [409, { error: UNPAIRED }];
  // Who asked decides the settings checked, now and after the start (Sol S5).
  const kind = controlKind(body);
  const refused = controlRefusal(kind);
  if (refused) return [409, { error: refused, refused: true }];
  const on = driver.status();
  // The session page control runs in, asked for by its id: it is already on.
  const itself = Boolean(on.active && body.sessionId && body.sessionId === on.sessionId && sameProject(on.cwd, cwd) && !tasks.owns(cwd, null));
  // A task's Claude (or page control's own) running /editlens control: it would take the project's page.
  // caller: the session that ran it; a task in the project folder itself is known by it (Sol M6).
  const caller = typeof body.caller === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.caller) ? body.caller : null;
  if (!itself && (ownSession(cwd, body.sessionId) || (caller && tasks.owns(cwd, caller)))) return [403, { error: OWN_SESSION }];
  if (body.auto) {
    const w = typeof body.waiter === 'string' && /^[0-9a-f]{16}$/.test(body.waiter) ? body.waiter : null;
    if (w && !seenWaiters.has(w)) {
      seenWaiters.add(w);
      if (seenWaiters.size > 100) seenWaiters.delete(seenWaiters.values().next().value);
      currentWaiter = w;
    }
    if (w && w !== currentWaiter) return [409, { error: SUPERSEDED, superseded: true }];
  }
  // One Claude runs from the page at a time: another project's page never takes control of it (its
  // messages would go to the Claude working in the first project's folder).
  // Only what the user typed moves it (/editlens control take): never auto control, a page or a tool.
  const runningIn = driver.status().active ? driver.status().cwd : null;
  let moved = null; // { from, unused }: page control ended in another project to start here
  if (runningIn && !sameProject(runningIn, cwd)) {
    const held = driveHolder();
    const take = body.take === true && !body.auto && !body.restore;
    if (body.auto || body.restore || ((held.turn || held.page) && !take)) {
      return [409, { error: busyText(runningIn, held.turn), busy: true, held: runningIn, working: Boolean(held.turn) }];
    }
    // Nothing stops there until this project's page is open (bin/drive.js waits for it).
    if (!pagesFor(cwd, ownOnly).length) return [409, { error: NO_PAGE_OPEN }];
    // Nobody uses it there (no page open, no turn), or the user typed take: Manual there, as
    // /editlens manual does (a turn in progress stops), then it starts here.
    driver.stop(take ? `moved to ${cwd} by /editlens control take` : `no page open for it in ${runningIn}: switched to Manual so it can start in ${cwd}`,
      `Page control moved to ${cwd}. This page is in Manual again.`, { by: 'moved', report: `It moved to ${cwd}, where /editlens control${take ? ' take' : ''} was run.` });
    moved = { from: runningIn, unused: !held.turn && !held.page };
  } else if (runningIn && !rootMatches(runningIn, cwd)) {
    cwd = runningIn; // the same folder through a symlink: keep the spelling its pages use
  }
  const restore = body.restore && typeof body.restore === 'object' ? body.restore : null;
  const targets = pagesFor(cwd, ownOnly || Boolean(restore));
  if (!targets.length) return [409, { error: NO_PAGE_OPEN }];
  // A new chat, or another conversation, asked for while page control runs here: it ends, then
  // starts as asked (as /editlens manual, then /editlens control new, would). A new chat nothing
  // was sent to yet is kept: two asks at the same time start one Claude.
  const running = driver.status();
  const other = typeof body.sessionId === 'string' && body.sessionId && !itself && body.sessionId !== running.fromSessionId;
  const unusedNew = !running.fromSessionId && !running.used;
  if (running.active && sameProject(running.cwd, cwd) && !restore && ((body.fresh && !unusedNew) || other)) {
    driver.stop(body.fresh ? 'a new chat was asked for' : `the conversation ${body.sessionId} was asked for`, 'Page control started again in another chat.');
  }
  const already = driver.status().active;
  // The Claude Code session to copy: the one the user named, or the latest one in this project
  // once it has a conversation (a session that just started has none written yet: Claude can't
  // continue it, and its first /editlens runs before anything is written).
  // Never a task's session: page control would continue the task's conversation in its copy.
  const latest = claudeState.sessionId && claudeState.cwd && rootMatches(cwd, claudeState.cwd) && !tasks.owns(claudeState.cwd, claudeState.sessionId)
    && hasConversation(claudeState.sessionId) ? claudeState.sessionId : null;
  let from = body.fresh ? null : typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : latest;
  // Turned on by itself when the session started: a conversation with nothing in it yet can't
  // be continued, so the page starts a new one.
  if (body.auto && from && !hasConversation(from)) from = null;
  // ...unless page control already had a conversation in this project (before an update or a
  // restart): that one continues, and the page says so.
  let continued = false;
  // Started again after a restart: the same page conversation continues.
  if (restore) {
    from = typeof restore.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(restore.sessionId) ? restore.sessionId : null;
    continued = Boolean(from);
  }
  if (body.auto && !from && !body.fresh && !driver.status().active) {
    const last = lastPageRun(cwd);
    if (last) {
      from = last;
      continued = true;
    }
  }
  let note = null;
  let newChat = false;
  // The grant exists before Claude starts, so a sign-in link during the start is sent to these pages.
  const before = driveGrant;
  // The same project spelled another way (a trailing slash, a folder inside it) keeps the key its pages have.
  if (!driveGrant || !rootMatches(driveGrant.cwd, cwd)) driveGrant = { key: crypto.randomBytes(24).toString('hex'), cwd, pageIds: new Set() };
  const grant = driveGrant;
  for (const p of targets) grant.pageIds.add(p.id);
  if (!driver.status().active) {
    // bin/drive.js knows the session's claude path; the desktop claude.exe is not on PATH.
    const given = isClaudeProgram(body.claudePath) ? [body.claudePath] : [];
    const claudePaths = [...given, ...[...execPaths].reverse()];
    // Its owner is known before the start: removing the pairing meanwhile stops it (pairsRemoved).
    const owner = pairedBy ? { pairId: pairedBy, runId: null } : null;
    controlBy = owner;
    // The pairing was removed, or a setting it needs changed, during an await: page control this call
    // started ends. -> why, or null
    const gone = () => {
      const why = unpaired() ? UNPAIRED : controlRefusal(kind);
      if (!why) return null;
      if (controlBy === owner) controlBy = null;
      if (driveGrant === grant) driveGrant = before;
      if (driver.status().active) {
        if (unpaired()) driver.stop('the paired computer that asked for it was unpaired', 'Page control ended: the computer that turned it on is no longer paired.');
        else driver.stop(`a setting changed while it started: ${why}`, `Page control ended: ${why}`);
      }
      return why;
    };
    let started = await driver.start({ cwd, resume: from, claudePaths, fork: !continued, effort: continued ? pageEffort(from, Boolean(restore)) : undefined });
    let why = gone();
    if (why) return [409, { error: why }];
    // Claude can still stop right after starting (a refused option, a bad install): say so here
    // instead of reporting page control as on.
    let up = started.error ? started : await driver.started();
    why = gone();
    if (why) return [409, { error: why }];
    if (up.error && continued) {
      // The earlier page conversation can't be continued: start a new one, and say so.
      log('drive: could not continue the earlier page conversation:', up.error);
      from = null;
      continued = false;
      note = 'Page control started a new conversation: the earlier one on this page could not be continued.';
      started = await driver.start({ cwd, resume: null, claudePaths });
      why = gone();
      if (why) return [409, { error: why }];
      up = started.error ? started : await driver.started();
      why = gone();
      if (why) return [409, { error: why }];
    }
    if (up.error) {
      if (driveGrant === grant) driveGrant = before;
      if (controlBy === owner) controlBy = null;
      return [409, { error: up.error }];
    }
    // The conversation to continue wasn't found: Claude started a new one (the page was told).
    if (from && driver.status().newChat) {
      from = null;
      continued = false;
      newChat = true;
    }
    if (restore) note = pagekeep.backText(restore.reason, { continued, newChat });
    else if (continued) note = `${PRODUCT_NAME} restarted, so page control started again: it continues your earlier conversation on this page.`;
  }
  // Page control can end while it starts (Manual, a crash): then there is no key to give.
  if (driveGrant !== grant || !driver.status().active) return [409, { error: 'Page control was stopped.' }];
  if (!already) controlBy = pairedBy ? { pairId: pairedBy, runId: driver.status().runId } : null;
  const frameText = volatileFrame({ type: 'drive-grant', key: grant.key, cwd, fromSessionId: from, continued, note });
  for (const p of targets) push(p.res, frameText);
  return [200, { ok: true, from: already ? driver.status().fromSessionId || null : from, continued, newChat, already, signIn: driver.status().phase === 'signin', pages: targets.map((p) => ({ url: p.url, title: p.title })),
    ...(moved ? { moved: moved.from, unused: moved.unused } : {}) }];
}

// Page control runs for this page's project and no page that has its key is open: the page may
// have it (as if it had been open when page control started). A paired page only when the key
// was given to a paired page.
function keyFree(pageId) {
  const page = pages.get(pageId);
  if (!driveGrant || !pageSees(page, driveGrant.cwd)) return false;
  const ids = [...driveGrant.pageIds];
  if (String(pageId).startsWith('pair-') && !ids.some((id) => String(id).startsWith('pair-'))) return false;
  return !ids.some((id) => id !== pageId && pages.has(id));
}

const NO_PAGE_OPEN = `No page with the ${PRODUCT_NAME} panel is open for this project. Open your page, then run this again.`;
// The pages that get page control. Turned on by itself at the start of a session: only this
// computer's own pages, never a paired computer's (that one asks with /editlens control <name>).
function pagesFor(cwd, ownOnly) {
  return [...pages.values()].filter((p) => pageSees(p, cwd) && !(ownOnly && String(p.id).startsWith('pair-')));
}

// Is the page control that runs now in use? turn: 'asking' (a permission question waits for an
// answer), 'working' (mid-turn, or starting), or null. page: a page of its project is open, or one
// closed moments ago (a reload reconnects within a few seconds).
const PAGE_GRACE_MS = 15000;
let drivePageGoneAt = 0;
function pageGraceMs() {
  const v = Number(process.env.EDITLENS_PAGE_GRACE_MS); // tests wait less
  return Number.isFinite(v) && v >= 0 ? v : PAGE_GRACE_MS;
}
function driveHolder() {
  const st = driver.status();
  const turn = Array.isArray(st.permissions) && st.permissions.length ? 'asking' : st.working || st.phase === 'starting' ? 'working' : null;
  const page = [...pages.values()].some((p) => p.root && sameProject(p.root, st.cwd)) || Date.now() - drivePageGoneAt < pageGraceMs();
  return { turn, page };
}
// A page stream closed: remember when, if it was a page of the project page control runs in.
function notePageGone(p) {
  const st = driver.status();
  if (p && p.root && st.active && sameProject(p.root, st.cwd)) drivePageGoneAt = Date.now();
}
function busyText(where, turn) {
  const doing = turn === 'asking' ? ' and needs your answer to a permission question there' : turn === 'working' ? ' and is working on a reply there' : '';
  return `Claude is already running from the page in ${where}${doing}.`;
}
// The same project folder, also when one spelling goes through a symlink or "..".
function sameProject(a, b) {
  if (rootMatches(a, b)) return true;
  const x = realDir(a);
  const y = realDir(b);
  return Boolean(x && y) && rootMatches(x, y);
}
function realDir(p) {
  if (typeof p !== 'string' || !p) return null;
  try {
    return fs.realpathSync.native(p);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG', 'EINVAL'].includes(err.code)) return null;
    throw err;
  }
}

// "Turn page control on when this project's page opens", asked by a session's start (the hook, when the
// setting "What /editlens does" says so). Kept here, so it applies however late the page opens or reloads;
// the newest session's counts. Cleared by a start, the user's choice (/editlens control, manual or stop,
// Manual on the page) or the end of that session. Never starts dev scripts: only an open page turns it on.
let autoWant = null; // { cwd, claudePath, sessionId, waiter, lastTry, fails } and the chat asked for
let autoBusy = false;
const AUTO_RETRY_MS = 30000;
const AUTO_FAILS_MAX = 3;
const { OWN_SESSION } = require('../lib/sdkerr');
// A task's folder or session, or page control's own session.
function ownSession(cwd, sessionId) {
  const own = driver.status();
  return tasks.owns(cwd, sessionId || null) || Boolean(own.active && sessionId && own.sessionId === sessionId);
}
// A pairing's id (server/pair-host.js), or null.
function pairIdOf(v) {
  return typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null;
}
// Who asked for page control (Sol S5): 'paired' (a paired computer), 'auto' (a session start by itself,
// or the setup run it began: origin auto) or 'asked' (/editlens control typed here, origin asked).
function controlKind(body) {
  if (pairIdOf(body.pairedBy) || body.paired === true) return 'paired';
  if (body.origin === 'asked') return 'asked';
  return body.auto === true || body.origin === 'auto' ? 'auto' : 'asked';
}
// The settings in effect that page control asked for this way needs, checked again before and after
// its setup and start. /editlens control typed here needs none of them. -> why it can't start, or null
function controlRefusal(kind) {
  const s = currentSettings();
  if (kind === 'paired' && s.remote_tasks === false) return tasks.runsOff();
  if (kind !== 'auto') return null;
  const how = 'Type /editlens control to start it.';
  if (!settingsLib.startsControl(s)) return `"What /editlens does" is now "Connect the page", so page control did not turn on by itself. ${how}`;
  if (!s.auto_connect) return `"Connect when Claude Code starts" is now off, so page control did not turn on by itself. ${how}`;
  return null;
}
// Page control a paired computer turned on here ({ pairId, runId }, runId null while it starts), or
// null. It ends when that pairing is removed (the user's choice, D6); page control turned on here
// keeps running.
let controlBy = null;
function pairsRemoved(ids) {
  if (autoWant && autoWant.pairedBy && ids.includes(autoWant.pairedBy)) clearAutoWant('its pairing was removed');
  const by = controlBy;
  if (!by || !ids.includes(by.pairId)) return false;
  controlBy = null;
  const ds = driver.status();
  // runId null: still starting (grantDriveNow); stopped now, so the start ends without a grant.
  if (by.runId !== null && (!ds.active || ds.runId !== by.runId)) return false;
  forgetKept('its pairing was removed');
  driver.stop('the paired computer that turned it on was unpaired', 'Page control ended: the computer that turned it on is no longer paired.');
  return true;
}
function setAutoWant(body) {
  const cwd = body && typeof body.cwd === 'string' && body.cwd ? body.cwd : null;
  if (!cwd) return { error: 'missing project folder' };
  if (!projectDir(cwd)) return { error: NOT_PROJECT };
  // A task's Claude or the page's own Claude asking: page control there would take the project's page.
  if (ownSession(cwd, body.sessionId)) return { error: OWN_SESSION };
  // Asked for by a paired computer that is no longer paired (removed while bin/drive.js ran).
  if (pairIdOf(body.pairedBy) && !pairHost.has(body.pairedBy)) return { error: 'The pairing was removed.' };
  const waiter = crypto.randomBytes(8).toString('hex');
  seenWaiters.add(waiter);
  if (seenWaiters.size > 100) seenWaiters.delete(seenWaiters.values().next().value);
  currentWaiter = waiter; // an older session's waiter (bin/drive.js --auto) stops when it asks next
  // A new chat or a session id: /editlens control new or <id> typed where no browser opens (bin/drive.js).
  const resume = typeof body.resume === 'string' && /^[0-9a-f-]{36}$/i.test(body.resume) ? body.resume : null;
  // paired: asked by /editlens control <name> from a paired computer, so its page counts too.
  // kind: a session start's own request (the hook gives no origin) counts as 'auto' (Sol S5).
  autoWant = { cwd, claudePath: isClaudeProgram(body.claudePath) ? body.claudePath : null, sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 100) : null, waiter, lastTry: 0, fails: 0,
    fresh: body.fresh === true, resume, paired: body.paired === true, pairedBy: pairIdOf(body.pairedBy),
    kind: controlKind({ pairedBy: body.pairedBy, paired: body.paired, origin: body.origin === 'asked' ? 'asked' : 'auto' }) };
  return { ok: true, installed: Boolean(sdkEntry(config.stateDir)) };
}
function autoSetup(w) {
  log(`auto page control: setting up page control for ${w.cwd}`);
  try {
    const out = fs.openSync(path.join(config.stateDir, 'auto-control.log'), 'w');
    const child = require('child_process').spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'drive.js'), '--wait', '300'], {
      // EDITLENS_ORIGIN: its grant is checked as the request it sets up for (Sol S5). EDITLENS_NO_START:
      // it ends with this server and never starts another one after this server stopped.
      cwd: config.stateDir, env: { ...process.env, CLAUDE_PROJECT_DIR: w.cwd, ...(w.claudePath ? { CLAUDE_CODE_EXECPATH: w.claudePath } : {}), ...(w.pairedBy ? { EDITLENS_PAIRED_BY: w.pairedBy } : {}),
        EDITLENS_ORIGIN: w.kind === 'auto' ? 'auto' : 'asked', EDITLENS_NO_START: '1' },
      detached: true, stdio: ['ignore', out, out], windowsHide: true,
    });
    fs.closeSync(out);
    child.on('error', (err) => log(`auto page control: setup could not run (${err.message})`));
    child.unref();
  } catch (err) {
    if (!err || !err.code) throw err;
    log(`auto page control: setup could not run (${err.message})`);
  }
}
function clearAutoWant(why) {
  if (!autoWant) return;
  log(`auto page control: not waiting any more (${why})`);
  autoWant = null;
}
async function tryAutoControl() {
  const w = autoWant;
  if (!w || autoBusy || driver.status().active) return;
  // Page control turned on again after a restart reports this itself (tryRestore).
  if (restoreBusy || (restoreWant && sameProject(restoreWant.cwd, w.cwd))) return;
  if (!pagesFor(w.cwd, !w.paired).length) return;
  // The settings in effect now, not when it was asked for: one changed meanwhile ends the wait (Sol S5).
  const refused = controlRefusal(w.kind);
  if (refused) return clearAutoWant(refused);
  if (Date.now() - w.lastTry < AUTO_RETRY_MS) return;
  if (!sdkEntry(config.stateDir)) {
    // The first time: /editlens control's own steps (bin/drive.js) set up the SDK, showing it on the
    // page, then turn page control on. It installs with --ignore-scripts: no package script runs.
    autoWant = null;
    autoSetup(w);
    return;
  }
  w.lastTry = Date.now();
  autoBusy = true;
  try {
    const [status, answer] = await grantDrive({ cwd: w.cwd, claudePath: w.claudePath, auto: true, waiter: w.waiter, fresh: w.fresh, sessionId: w.resume, paired: w.paired, pairedBy: w.pairedBy,
      origin: w.kind === 'asked' ? 'asked' : 'auto' });
    if (autoWant !== w) return;
    if (status === 200) {
      const roots = [...pages.values()].map((p) => p.root).filter(Boolean);
      log(`auto page control: on in ${w.cwd}${roots.some((r) => sameProject(r, w.cwd)) ? '' : ' (not a page\'s own folder)'}`);
      autoWant = null;
    } else if (answer && answer.superseded) {
      autoWant = null;
    } else if (answer && answer.refused) {
      clearAutoWant(answer.error);
    } else if (++w.fails >= AUTO_FAILS_MAX) {
      clearAutoWant(`could not start: ${answer && answer.error}`);
    } else {
      log(`auto page control: could not start yet (${answer && answer.error})`);
    }
  } finally {
    autoBusy = false;
  }
}

// The effort level of each page conversation, so one that continues (after a restart, or turned on
// by itself in a new session) keeps the level the page picked.
const EFFORT_FILE = path.join(config.stateDir, 'page-control-effort.json');
function rememberEffort(sessionId, level) {
  try {
    effortLib.remember(EFFORT_FILE, sessionId, level);
  } catch (err) {
    if (!err || !err.code) throw err;
    log(`cannot save the page conversation's effort: ${err.code}`);
  }
}
// -> the level kept for the conversation page control continues, or undefined (the setting).
// restored: EditLens starts it again under the same conversation (a restart), so Max stays too;
// a new session starts at the saved level (Max lasts for one session, D24).
function pageEffort(from, restored) {
  return (from && effortLib.kept(EFFORT_FILE, from, { restored })) || undefined;
}

// The last conversation page control had in each project, so page control turned on by itself
// in a new session (after an update or a restart) continues it instead of starting a new one.
const PAGE_RUNS_FILE = path.join(config.stateDir, 'page-control-last.json');
const PAGE_RUN_KEEP_MS = 24 * 3600 * 1000;
function rememberPageRun(cwd, sessionId) {
  try {
    pageRunsLib.remember(PAGE_RUNS_FILE, cwd, sessionId);
  } catch (err) {
    if (!err || !err.code) throw err;
    log('cannot remember the page conversation:', err.message);
  }
}
// -> the session id, when it is recent and its transcript is still there, else null
function lastPageRun(cwd) {
  const r = pageRunsLib.find(PAGE_RUNS_FILE, cwd);
  if (!r || typeof r.sessionId !== 'string' || !/^[0-9a-f-]{36}$/.test(r.sessionId) || !Number.isFinite(r.at) || Date.now() - r.at > PAGE_RUN_KEEP_MS) return null;
  const base = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(require('os').homedir(), '.claude'), 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(base);
  } catch (err) {
    if (err && err.code) return null;
    throw err;
  }
  return dirs.some((d) => fs.existsSync(path.join(base, d, `${r.sessionId}.jsonl`))) ? r.sessionId : null;
}

// True when the session's transcript has something in it (it can be continued).
function hasConversation(sessionId) {
  const w = sessions.get(sessionId);
  if (!w || !w.transcriptPath) return false;
  try {
    return fs.statSync(w.transcriptPath).size > 0;
  } catch (err) {
    if (err && err.code) return false;
    throw err;
  }
}

// CLAUDE_CODE_AUTO_COMPACT_WINDOW as each session has it (its hooks report it); it takes precedence
// over settings.
const compactEnvs = new Map(); // sessionId -> text
function noteCompactEnv(ev) {
  if (typeof ev.sessionId !== 'string' || !ev.sessionId || !Object.prototype.hasOwnProperty.call(ev, 'compactEnv')) return;
  if (typeof ev.compactEnv === 'string' && ev.compactEnv) compactEnvs.set(ev.sessionId, ev.compactEnv.slice(0, 20));
  else compactEnvs.delete(ev.sessionId);
  if (compactEnvs.size > 200) compactEnvs.delete(compactEnvs.keys().next().value);
}

function watchSession(ev) {
  const { sessionId, transcriptPath } = ev;
  if (!sessionId || typeof transcriptPath !== 'string' || !transcriptPath.endsWith('.jsonl')) return;
  const existing = sessions.get(sessionId);
  if (existing) {
    existing.lastSeen = Date.now();
    clearTimeout(endTimers.get(sessionId));
    endTimers.delete(sessionId);
    return;
  }
  if (sessions.size >= MAX_SESSIONS) dropSession([...sessions.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0].sessionId);
  const emit = (e) => (e.type === 'interrupted' ? setClaudeState({ state: 'stopped', sessionId, cwd: ev.cwd }) : addEvent(e));
  const compactLimit = (model) => ccsettings.compactWindow(ev.cwd, model, compactEnvs.get(sessionId));
  const watcher = new SessionWatcher({ sessionId, transcriptPath, cwd: ev.cwd, emit, onUsage: broadcastVolatile, compactLimit });
  sessions.set(sessionId, watcher);
  try {
    watcher.start();
  } catch (err) {
    log('cannot read transcript', transcriptPath, err.message);
    sessions.delete(sessionId);
  }
}

// ---------- what Claude is doing, so pages can say what happens to a message ----------
// working: mid-turn, messages are sent when the turn ends. idle: turn ended, messages are sent with
// the next prompt (or now, while listening). stopped: the user pressed Esc / Stop; no Stop hook runs,
// so messages wait for the next prompt. closed: the session ended.
const STATE_BY_EVENT = { session: 'idle', prompt: 'working', pending: 'working', change: 'working', idle: 'idle', end: 'closed' };

function setClaudeState(patch) {
  const next = { ...claudeState, ...patch };
  if (typeof next.canListen !== 'boolean') next.canListen = null;
  if (next.state === claudeState.state && next.canListen === claudeState.canListen) {
    claudeState = next;
    return;
  }
  claudeState = next;
  addEvent({ type: 'state', state: next.state, canListen: next.canListen, sessionId: next.sessionId, cwd: next.cwd });
}

function trackState(ev) {
  const state = STATE_BY_EVENT[ev.type];
  if (!state) return;
  // A session that ends while another one is working does not make Claude "closed".
  if (state === 'closed' && claudeState.sessionId && ev.sessionId && claudeState.sessionId !== ev.sessionId) return;
  setClaudeState({
    state,
    sessionId: ev.sessionId || null,
    cwd: ev.cwd || null,
    ...(typeof ev.canListen === 'boolean' ? { canListen: ev.canListen } : {}),
  });
}

// ---------- permission mode of each session and subagent, as the hooks report it ----------
// Read-only on the page: a page can't change the mode of a Claude Code window (Shift+Tab there).
function noteMode(ev) {
  if (!modes.isMode(ev.permissionMode) || !ev.sessionId) return;
  const agentId = typeof ev.agentId === 'string' && ev.agentId ? ev.agentId : null;
  const prev = latestVolatile.get(`mode:${ev.sessionId}${agentId ? ':' + agentId : ''}`);
  if (prev && prev.mode === ev.permissionMode) return;
  broadcastVolatile({ type: 'mode', sessionId: ev.sessionId, agentId, mode: ev.permissionMode, cwd: ev.cwd || null });
}

// ---------- effort of each terminal session, as Claude Code reports it ----------
// Its hooks (CLAUDE_EFFORT) and the status line say the level a session in the user's terminal uses.
// Read-only: EditLens never changes it (the user types /effort there).
function noteEffort(sessionId, cwd, level) {
  if (typeof sessionId !== 'string' || !sessionId || !effortLib.isLevel(level) || drivenSession(sessionId)) return;
  const prev = latestVolatile.get(`effort:${sessionId}`);
  if (prev && prev.effort && prev.effort.level === level) return;
  broadcastVolatile({ type: 'effort', sessionId, cwd: typeof cwd === 'string' ? cwd : null, effort: effortLib.shape({ level, used: level, supported: true, source: 'terminal' }) });
}
// -> the terminal session's effort (lib/effort.js shape), or null when it hasn't said yet.
function terminalEffort(sessionId) {
  if (!sessionId) return null;
  const ev = latestVolatile.get(`effort:${sessionId}`);
  if (ev && ev.effort) return ev.effort;
  const u = latestVolatile.get(`usage:${sessionId}`);
  const level = u && typeof u.effort === 'string' ? u.effort : null;
  return effortLib.isLevel(level) ? effortLib.shape({ level, used: level, supported: true, source: 'terminal' }) : null;
}
// Running tasks of this project, here (asked by a paired computer) and on paired computers (asked
// from here), with their effort: /editlens effort lists them.
function effortTasks(cwd) {
  const out = [];
  for (const t of tasks.items.values()) {
    if (!['waiting', 'starting', 'working', 'idle'].includes(t.state) || (cwd && !rootMatches(t.cwd, cwd))) continue;
    out.push({ task: t.id, computer: t.by, where: 'here', state: t.state, effort: tasks.effortOf(t) });
  }
  for (const f of remote.computers.values()) {
    for (const t of f.tasks.values()) {
      const dir = f.dirs.get(t.task);
      if (!['waiting', 'starting', 'working', 'idle'].includes(t.state) || (cwd && !(dir && rootMatches(dir, cwd)))) continue;
      out.push({ task: t.task, computer: f.name, where: 'there', state: t.state, effort: t.effort && typeof t.effort === 'object' ? effortLib.shape(t.effort) : null });
    }
  }
  return out.slice(0, 20);
}

// ---------- messages typed on the page ----------
// A message is sent to a session working in the page's project: same folder, or one inside the other.
// A page without a project folder matches no session (it gets the least access, not the most).
function rootMatches(root, cwd) {
  return related(root, cwd);
}

// The folders a page may read files from: only folders Claude Code sessions run in, and only those
// in the page's own project. The page's root picks among them; it is never a root itself.
// pair: a paired computer's page reads only the paired folder and folders inside it (a session in
// a folder above it gives the paired folder, not its own).
function pageRoots(page, pair = null) {
  if (!page || !page.root) return [];
  const out = [];
  for (const cwd of [...[...sessions.values()].map((w) => w.cwd), claudeState.cwd, ...pastCwds.keys()]) {
    if (!cwd || tooBroad(cwd) || !rootMatches(page.root, cwd) || tasks.owns(cwd, null)) continue;
    const dir = !pair || within(cwd, pair.cwd) ? cwd : within(pair.cwd, cwd) ? pair.cwd : null;
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out;
}
const NO_ROOT = "This page doesn't say which project it belongs to. Add data-root=\"<your project folder>\" to its EditLens script tag.";

// D27 B (Sol N1): with "Paired computers can run Claude here" off, messages from paired pages that wait
// for Claude end, and their page shows why (not "You canceled it").
function endPairedMessages() {
  if (currentSettings().remote_tasks !== false) return;
  const ended = messages.filter((m) => m.status === 'queued' && (m.paired || pairedPage(m.pageId)));
  if (!ended.length) return;
  for (const m of ended) m.status = 'cancelled';
  addEvent({ type: 'cancelled', ids: ended.map((m) => m.id), reason: tasks.runsOff() });
}

function takeMessages(cwd, via) {
  endPairedMessages();
  const taken = messages.filter((m) => m.status === 'queued' && rootMatches(m.root, cwd) && (!pairedPage(m.pageId) || pairHasDir(m.root, cwd)));
  if (!taken.length) return [];
  for (const m of taken) m.status = 'delivered';
  addEvent({ type: 'delivered', ids: taken.map((m) => m.id), via });
  return taken.map((m) => ({ id: m.id, text: m.text, command: m.command || null, attachments: m.attachments || [],
    images: (m.images || []).map((i) => ({ ...screenshots.publicShot(i), file: i.file })) }));
}

function listeningPages(cwd) {
  return [...pages.values()].filter((p) => p.listen && pageSees(p, cwd));
}

function setListen(active, until) {
  const changed = listenState.active !== active;
  listenState = { ...listenState, active, until: active ? until : 0 };
  if (changed || active) addEvent({ type: 'listen', active, until: listenState.until });
}

function wakeWaiters() {
  for (const w of [...waiters]) {
    const taken = takeMessages(w.cwd, 'listen');
    if (taken.length) {
      waiters.delete(w);
      clearTimeout(w.timer);
      setListen(false, 0);
      send(w.res, 200, { messages: taken, listening: true });
    }
  }
}

function resumeSeq(req, url) {
  const header = req.headers['last-event-id'];
  let raw = header ?? url.searchParams.get('since');
  if (raw === null || raw === undefined || raw === '') return null;
  // "<instance>.<seq>" (the header, or since= from a page that opened its stream again): from
  // another start of the server, the page is new here.
  if (header !== undefined || String(raw).includes('.')) {
    const m = /^([0-9a-f]{16})\.(\d+)$/.exec(String(raw));
    if (!m || m[1] !== INSTANCE) return null;
    raw = m[2];
  }
  const n = Number.parseInt(raw, 10);
  // A number from before this server started (it counts from 1 again): treat the page as new.
  return Number.isInteger(n) && n >= 0 && n <= seq ? n : null;
}

function openStream(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders(req),
  });
  res.write('retry: 1500\n\n');
  // Lets a page running an older live.js offer a reload after the plugin is updated. No id line: it must
  // not move the page's resume position. `instance` changes on every start (event numbers start over).
  // A page of no project (EditLens's own page, a script tag without data-root) is told where the
  // projects' pages are, so it can send the user there.
  const projects = req.socket.editlensPair ? [] : projectPages();
  res.write(`event: claude\ndata: ${JSON.stringify({ type: 'hello', version: config.version, instance: INSTANCE, via: pairHost.via(req.socket), projects })}\n\n`);
  // A paired computer's page belongs to the project it was paired for, whatever it says.
  const pair = req.socket.editlensPair || null;
  const scope = { pair };
  const pageId = pageKey(req, url.searchParams.get('page'));
  if (pageId) {
    pages.set(pageId, {
      id: pageId,
      url: String(url.searchParams.get('url') || '').slice(0, 500),
      title: String(url.searchParams.get('title') || '').slice(0, 200),
      // A drive, filesystem root or the home folder would match every project: treated as none.
      root: pair ? pair.cwd : (() => { const r = String(url.searchParams.get('root') || '').slice(0, 1000); return r && !tooBroad(r) ? r : null; })(),
      listen: url.searchParams.get('listen') !== '0',
      res,
    });
    summaryWatch.nudge();
    // The paired computers' edits stream to it from now, not from the next 30 s check.
    followPaired();
    // This project's page opened: page control turns on now if a session start asked for it (autoControl:
    // "What /editlens does" and "Connect when Claude Code starts" both on, the defaults).
    setImmediate(() => tryRestore().catch((err) => log(`page control restore: ${err.message}`))
      .then(() => tryAutoControl()).catch((err) => log(`auto page control: ${err.message}`)));
  }
  const since = resumeSeq(req, url);
  // A new page gets the recent backlog (marked replay) so the panel is not empty.
  const backlog = since === null ? replayTail() : history.filter((e) => e.seq > since);
  // A new page numbers its edits from its backlog; a page that resumes keeps its numbers.
  if (pageId && (since === null || !pageFrom.has(pageId))) {
    pageFrom.delete(pageId);
    pageFrom.set(pageId, backlog.length ? backlog[0].seq : seq + 1);
    if (pageFrom.size > 200) pageFrom.delete(pageFrom.keys().next().value);
  }
  for (const e of backlog) if (sees(scope, eventCwd(e), eventFiles(e))) res.write(frame({ ...(pair ? pairView(pair, e) : e), replay: since === null }));
  if (listenState.active) res.write(frame({ type: 'listen', active: true, until: listenState.until, seq: 0 }));
  // The current state, even when its event is no longer in the history.
  if (claudeState.state !== 'unknown' && sees(scope, claudeState.cwd || false)) res.write(frame({ type: 'state', ...claudeState, seq: 0 }));
  for (const u of latestVolatile.values()) if (sees(scope, eventCwd(u), eventFiles(u))) res.write(volatileFrame(u));
  res.write(volatileFrame(settingsEvent(pair)));
  const drive = driver.status();
  // Page control stopped without the user choosing it (an error, a restart): the page says why
  // rather than plain Manual, also a page that stayed open through a restart.
  const endedWhy = !drive.active && drive.lastError && Date.now() - drive.lastError.at < 30 * 60000 && grantedOrSameProject(pageId, drive.lastError.cwd) ? drive.lastError.error : null;
  if (endedWhy) res.write(volatileFrame({ type: 'drive-error', error: endedWhy }));
  // This project's tasks from paired computers.
  const page = pageId ? pages.get(pageId) : null;
  if (page && page.root) {
    for (const t of [...tasks.items.values()].slice(-20)) if (pageSees(page, t.cwd)) res.write(volatileFrame(tasks.card(t)));
    for (const q of asks.list((cwd) => pageSees(page, cwd))) res.write(volatileFrame(q));
  }
  if (drive.active && sees(scope, drive.cwd || false)) {
    // The same tab, reloaded: it gets the key again on its own stream (the page never stores it).
    // A new tab of the project gets it when no tab that has it is open any more. Decided before
    // the status, so that tab also gets the questions already waiting (Sol M12).
    if (driveGrant && pageId && !driveGrant.pageIds.has(pageId) && keyFree(pageId)) driveGrant.pageIds.add(pageId);
    res.write(volatileFrame({ type: 'drive-status', ...drive, ...(grantedPage(pageId) ? {} : { permissions: [], signin: null }) }));
    if (driveGrant && pageId && driveGrant.pageIds.has(pageId)) res.write(volatileFrame({ type: 'drive-grant', key: driveGrant.key, cwd: driveGrant.cwd, resume: true }));
  } else {
    // Off: a page that missed the end (a restart, a broken stream) leaves Page control now.
    res.write(volatileFrame({ type: 'drive-status', active: false, ...(endedWhy ? { error: endedWhy } : {}) }));
  }
  for (const b of boards.all()) {
    if (b.entries.length && sees(scope, b.cwd || false)) res.write(volatileFrame({ type: 'board-sync', cwd: b.cwd, entries: b.entries.slice(-200) }));
  }
  clients.set(res, scope);
  lastActivity = Date.now();
  req.on('close', () => {
    clients.delete(res);
    if (pageId && pages.get(pageId)?.res === res) {
      notePageGone(pages.get(pageId));
      pages.delete(pageId);
      summaryWatch.nudge();
    }
  });
}

// The pages that belong to a project, open now or connected with /editlens: [{ url, name }].
function projectPages() {
  const out = new Map();
  const add = (url, cwd) => {
    let origin;
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
      origin = u.origin;
    } catch (err) {
      if (err instanceof TypeError) return;
      throw err;
    }
    if (origin !== config.baseUrl && !out.has(origin)) out.set(origin, { url: origin, name: cwd ? path.basename(cwd) : '' });
  };
  for (const p of pages.values()) if (p.root && !String(p.id).startsWith('pair-')) add(p.url, p.root);
  for (const c of connector.list()) if (c.state === 'running' && c.url) add(c.url, c.cwd);
  return [...out.values()].slice(0, 10);
}

function serveClient(req, res) {
  let js;
  try {
    js = clientScript();
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    log('cannot read client script:', err.message);
    send(res, 500, 'client script missing');
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
    ...corsHeaders(req),
  });
  res.end(js);
}

// EditLens's own address: not a page to work on. It lists the projects' pages instead (no panel,
// so no message box that can't send to Claude).
// key: the page key this address was opened with (D21), passed on to the pages' links.
function homePage(note, key = null) {
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const list = projectPages();
  const links = list.length
    ? `<p>Open your project's page:</p><ul>${list.map((p) => `<li><a href="${esc(pagekey.keyedUrl(p.url, key))}">${esc(p.url)}</a>${p.name ? ` (${esc(p.name)})` : ''}</li>`).join('')}</ul>`
    : '<p>No project page is connected yet. In Claude Code, in your project folder, run <code>/editlens</code>: it connects your page and prints the address to open.</p>';
  return `<!doctype html><meta charset="utf-8"><title>${PRODUCT_NAME}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px/1.6 "Segoe UI Variable Text","Segoe UI",-apple-system,system-ui,sans-serif;background:#f4f2ec;color:#2b2a26;display:grid;place-items:center;min-height:100vh}
@media (prefers-color-scheme:dark){body{background:#141413;color:#e8e6df}a{color:#e9a07a}}main{max-width:36em;padding:0 16px}
code{font:.9em "Cascadia Mono",Consolas,ui-monospace,Menlo,monospace}</style>
<main><h1>${PRODUCT_NAME} is running</h1>${note ? `<p>${esc(note)}</p>` : ''}
<p>This address is ${PRODUCT_NAME} itself, not your app, so you can't work with Claude here.</p>${links}</main>`;
}

function intParam(url, name, fallback, min, max) {
  const n = Number.parseInt(url.searchParams.get(name), 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

// A key compared in constant time (as the window and drive keys are).
function sameKey(sent, key) {
  if (typeof sent !== 'string' || typeof key !== 'string' || !key) return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handle(req, res) {
  // A page's addresses can start with a key (/gk-...): through a pairing link the link's key, checked
  // by the gateway on the other computer (D11); here, this user's page key (D21). Not part of the route.
  const gk = /^\/gk-([0-9a-f]{32})(?=\/)/.exec(req.url);
  if (gk) req.url = req.url.slice(gk[0].length);
  const pageKeyOk = Boolean(gk) && !req.socket.editlensPair && sameKey(gk[1], userPageKey());
  if (!hostAllowed(req)) return send(res, 403, 'host not allowed');
  const url = new URL(req.url, config.baseUrl);
  if (req.method === 'OPTIONS') {
    if (!originAllowed(req.headers.origin)) return send(res, 403, 'origin not allowed');
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }
  if (req.headers.origin && !originAllowed(req.headers.origin)) return send(res, 403, 'origin not allowed');
  // Through a pairing link: only the two addresses the paired computer opened for this project
  // (its site and its end of the link), not any other page on that computer.
  const pair = req.socket.editlensPair || null;
  // A pairing removed since this connection opened: nothing more through it.
  if (pair && !pairHost.has(pair.id)) {
    req.socket.destroy();
    return undefined;
  }
  if (pair && req.headers.origin && !pair.origins.includes(String(req.headers.origin).toLowerCase())) {
    return send(res, 403, pair.origins.length ? 'origin not allowed' : `update ${PRODUCT_NAME} on ${pair.name}, then reload this page`);
  }
  // A computer that joined with EditLens older than 0.24.45 has no key at its own addresses for this
  // link, so another account there could use it: refused, whatever the route (D14).
  if (pair && !keepsKey(pair.peerVersion)) {
    if (!oldJoiners.has(pair.id) && oldJoiners.size < 20) {
      oldJoiners.add(pair.id);
      log(`refused page requests from ◆ ${pair.name}: it runs ${pair.peerVersion ? `EditLens ${pair.peerVersion}` : 'an older EditLens'}; update it there`);
    }
    return send(res, 403, updateText(pair.name));
  }
  const cors = corsHeaders(req);
  // Hooks and the MCP tool. Never a paired computer's page, whatever it sends.
  const sent = req.headers['x-editlens-token'];
  const trusted = sameKey(sent, token) && !req.socket.editlensPair;
  // A task's hooks running as the normal account (taskAccount): POST /event only, checked there.
  const taskKey = !trusted && Boolean(taskUser.key) && sameKey(sent, taskUser.key) && !req.socket.editlensPair;
  const route = `${req.method} ${url.pathname}`;
  // The task account (another user on this computer) is never a page, the window or a hook of
  // root's: its sockets get the health check and its own edit reports, nothing else.
  const acctUid = pair ? null : taskAccountUid();
  if (acctUid !== null && peerUid(req.socket) === acctUid && route !== 'GET /health' && !(taskKey && taskuser.keyAllows(route))) {
    if (!accountRefused.has(route) && accountRefused.size < 50) {
      accountRefused.add(route);
      log(`refused ${route} from the ${taskuser.NAME} account (it may only report its edits)`);
    }
    return send(res, 403, { error: 'forbidden' });
  }
  // Any other user on this computer (a shared Linux computer): not a page, hook or window of this user's.
  // Their own EditLens needs another port; the health check tells them so.
  const uid = pair || OWN_UID === null ? null : peerUid(req.socket);
  if (uid !== null && uid !== OWN_UID && uid !== acctUid && route !== 'GET /health') {
    if (!otherUsers.has(uid) && otherUsers.size < 20) {
      otherUsers.add(uid);
      log(`refused requests from user ${uid}: this server is user ${OWN_UID}'s`);
    }
    return send(res, 403, { error: `This ${PRODUCT_NAME} server belongs to another user on this computer. Set EDITLENS_PORT (or the Port setting) to a free port.` });
  }
  // An account EditLens can't tell (macOS, Windows): only the health check and the page script
  // without this user's key, the hook key or the page key (D21). Single-user Linux is as above.
  const keyNeeded = !pair && uid === null && !trusted && !pageKeyOk;
  if (keyNeeded) {
    if (!unknownSeen) {
      unknownSeen = true;
      log('a connection whose account can\'t be told: pages need the page key (/editlens opens the address with it)');
    }
    if (route !== 'GET /health' && route !== 'GET /live.js') {
      if (route === 'GET /answer') return send(res, 403, KEY_WINDOW);
      return send(res, 403, /text\/html/.test(String(req.headers.accept || '')) ? KEY_ASK : { error: KEY_ASK, key: 'needed' }, cors);
    }
  }

  // ----- open to localhost pages -----
  switch (route) {
    case 'GET /health':
      // pid and uid are for this computer's own tools (lib/client.js): not sent through a pairing link.
      // key: 'needed' tells the page script to ask for the page key (D21).
      return send(res, 200, { ok: true, version: config.version, keeps: true, clients: clients.size, pages: pages.size, events: seq,
        ...(pair ? {} : { pid: process.pid, uid: OWN_UID }), ...(keyNeeded ? { key: 'needed' } : {}) }, cors);
    case 'GET /events':
      return openStream(req, res, url);
    case 'GET /snapshot': {
      // A page names the server start its snapshot id came from: ids start again after a restart, so
      // an id with none (saved by 0.24.43) can name another file now (Sol M8).
      if (url.searchParams.get('instance') !== INSTANCE) return send(res, 404, { error: 'snapshot expired' }, cors);
      const snap = snapshots.get(String(url.searchParams.get('id') || ''));
      if (snap && pair && !pairSnapshot(pair, snap.file)) return send(res, 404, { error: 'snapshot expired' }, cors);
      return snap ? send(res, 200, snap, cors) : send(res, 404, { error: 'snapshot expired' }, cors);
    }
    case 'GET /file': {
      // A file named in Claude's reply, clicked in the panel: opened in the code view.
      const page = pageFor(req, url.searchParams.get('page'));
      const roots = pageRoots(page, pair);
      if (!roots.length) return send(res, 404, { error: page && page.root ? 'No Claude Code session is open in this project.' : NO_ROOT }, cors);
      const found = resolveRef(String(url.searchParams.get('ref') || '').slice(0, 1000), roots);
      if (found.error) return send(res, 404, { error: found.error }, cors);
      if (found.kind !== 'file') return send(res, 200, found, cors);
      const id = `f${++fileViews}`;
      snapshots.add(id, { file: found.file, relFile: found.rel, before: null, after: found.text, kind: 'view' });
      return send(res, 200, { kind: 'file', type: 'code', snapshot: id, file: found.file, relFile: found.rel }, cors);
    }
    case 'GET /pages': {
      // File -> app page map from the project's routes (lib/routes.js).
      const page = pageFor(req, url.searchParams.get('page'));
      const roots = pageRoots(page, pair);
      for (const r of roots) {
        const found = routesFor(r);
        if (found.routes.length) return send(res, 200, { root: r, routes: found.routes.slice(0, 300), files: found.files }, cors);
      }
      return send(res, 200, { root: roots[0] || null, routes: [], files: {} }, cors);
    }
    case 'GET /summary': {
      if (pair) return send(res, 404, 'not found');
      // Session summary for the mod (hooks/mod.mjs). Localhost only, like the stream; no file text.
      // since=<seq>&wait=<s>: kept open until it changes (server/summary-wait.js), for the mod only.
      const sessionId = String(url.searchParams.get('session') || '').slice(0, 100) || null;
      const cwd = String(url.searchParams.get('cwd') || '').slice(0, 1000) || null;
      const fromMod = url.searchParams.get('mod') === '1' && trusted && !req.headers.origin;
      // The mod of a Claude EditLens started (page control, a task) has its defaults, not the user's
      // settings: it never counts as the mod that makes the page's changes (modLive).
      const userMod = fromMod && url.searchParams.get('driven') !== '1' && !drivenSession(sessionId);
      if (fromMod) {
        const was = modLive();
        if (userMod) settingsState.modAt = Date.now();
        const list = (k) => String(url.searchParams.get(k) || '').split(',').filter((x) => /^[a-z]{1,20}$/.test(x)).slice(0, 8);
        if (sessionId) {
          modDisplay.set(sessionId, { surfaces: list('surfaces'), drawn: list('drawn'), at: Date.now() });
          if (modDisplay.size > 50) modDisplay.delete(modDisplay.keys().next().value);
        }
        if (!was && userMod) sendSettings(true); // the page may now change settings
      }
      const since = sinceParam(url.searchParams.get('since'));
      const wait = trusted && !req.headers.origin ? waitParam(url.searchParams.get('wait')) : 0;
      const out = await summaryWatch.answer({ sessionId, cwd, since, wait, mod: userMod, res });
      if (!out) return undefined; // the mod disconnected while it waited
      if (userMod) settingsState.modAt = Date.now();
      // instance: changes when the server restarts, so the mod removes ids it saw from the old one.
      // pageKey: for the terminal's Open button (the hook key only), where page addresses need it (D21).
      const key = trusted && !req.headers.origin && keysNeeded() ? { pageKey: userPageKey() } : {};
      return send(res, 200, { ...out.body, seq: out.seq, changed: out.changed, instance: INSTANCE, ...key }, cors);
    }
    case 'GET /settings':
      return send(res, 200, settingsEvent(pair), cors);
    case 'GET /sessions': {
      // The Sessions sheet (a page of this project), or the terminal's pane and /editlens sessions
      // (with the hook key). Never through a pairing link: that computer's own page lists its own.
      const page = pair ? null : pageFor(req, url.searchParams.get('page'));
      let cwd = null;
      if (page) {
        if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
        cwd = page.root;
      } else if (trusted) {
        cwd = url.searchParams.get('cwd') || null;
      } else {
        return send(res, 403, { error: pair ? 'Open the Sessions list on that computer\'s own page.' : 'Reload the page, then try again.' }, cors);
      }
      return send(res, 200, sessionsList(cwd), cors);
    }
    case 'POST /sessions/rename': {
      // Rename from the Sessions sheet or the terminal's pane: the name is kept here and used on
      // chips, cards, Details and in the terminal. An empty name restores the session's own.
      const body = await readJson(req);
      const page = body && !pair ? pageFor(req, body.page) : null;
      let cwd = null;
      if (page) {
        if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
        cwd = page.root;
      } else if (trusted && body && typeof body.cwd === 'string' && body.cwd) {
        cwd = body.cwd;
      } else {
        return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      }
      const key = String(body.key || '').slice(0, 200);
      const row = sessionsList(cwd).groups.flatMap((g) => g.rows).find((r) => r.key === key);
      if (!row || key === 'pc:new') return send(res, 404, { error: 'That session is not in this project\'s list.' }, cors);
      const done = sessionStore.rename(key, body.name);
      if (done.error) return send(res, 400, done, cors);
      log(`sessions: ${key} ${done.name ? 'renamed' : 'has its own name again'}`);
      sessionsChanged(cwd);
      return send(res, 200, { ok: true, key, name: done.name || row.ownName, renamed: Boolean(done.name) }, cors);
    }
    case 'POST /settings': {
      // A change from the panel: { page, key, value } or { page, reset: true }. Only what the page
      // may change (not the safety check, auto connect or the port), and only through Claude Code.
      // Never through a pairing link: the settings of this computer are changed here only.
      if (pair) return send(res, 403, { error: `Change it on ◆ ${pairHost.name} itself.` }, cors);
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
      const changes = [];
      if (body.reset === true) {
        const d = settingsLib.defaults();
        for (const k of settingsLib.PAGE_EDITABLE) changes.push([k, d[k]]);
      } else {
        const key = typeof body.key === 'string' ? body.key : '';
        if (!settingsLib.KEYS.includes(key)) return send(res, 400, { error: 'There is no setting with that name.' }, cors);
        if (!settingsLib.PAGE_EDITABLE.includes(key)) return send(res, 403, { error: 'Change this one in Claude Code: /config, then search "editlens".' }, cors);
        // The page sends JSON: a switch is true or false and a number is a number, never text.
        const type = settingsLib.SCHEMA[key].type;
        const value = typeof body.value === (type === 'boolean' || type === 'number' ? type : 'string') ? settingsLib.check(key, body.value) : undefined;
        if (value === undefined) return send(res, 400, { error: 'That value does not fit this setting.' }, cors);
        changes.push([key, value]);
      }
      if (!modLive()) return send(res, 409, { error: 'local', message: 'Saved on this page only. To change it everywhere, use /config in Claude Code (search "editlens").' }, cors);
      for (const [key, value] of changes) queueSetting(key, value);
      sendSettings(false);
      return send(res, 200, { ok: true, values: requestedSettings() }, cors);
    }
    // ----- the EditLens window: this origin only, never framed, no CORS -----
    case 'GET /answer': {
      // Through a pairing link only when this computer's setting "Paired computers can answer questions
      // here" is on (desk.allowed too).
      if (pair && !desk.pairAllowed()) return send(res, 403, PAIR_ANSWER_OFF);
      // Only a browser opening it as a window (every current browser sends these). A script would have
      // to fake them, so this only makes misuse harder; the real protection is the peer checks above.
      if (req.headers['sec-fetch-dest'] !== 'document' || req.headers['sec-fetch-mode'] !== 'navigate') return send(res, 403, 'open this as a window');
      const { html, nonce } = desk.page(PRODUCT_NAME);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...desk.headers(nonce) });
      return res.end(html);
    }
    case 'GET /answer/list':
      if (!desk.allowed(req)) return send(res, 403, { error: 'forbidden' });
      return send(res, 200, desk.list({ drive: driver.status(), tasks: [...tasks.items.values()], asks, host: tasks.host, pair }));
    case 'POST /answer': {
      if (!desk.allowed(req)) return send(res, 403, { error: 'forbidden' });
      const body = await readJson(req);
      if (!body) return send(res, 400, { error: 'bad request' });
      const decision = ['allow', 'always', 'deny'].includes(body.decision) ? body.decision : 'deny';
      // Through the link: only questions it lists (page control and tasks in the paired project).
      if (pair && !desk.pairCan(pair, body, { drive: driver.status(), task: tasks.byId(body.task) })) return send(res, 403, { error: 'Answer this on that computer itself.' });
      if (pair) log(`EditLens window: ${decision} for a ${body.kind === 'task' ? 'task' : 'page control'} question, from ◆ ${pair.name}`);
      let out;
      if (body.kind === 'drive') out = driver.answer(String(body.id || ''), decision);
      else if (body.kind === 'task') {
        const t = tasks.byId(body.task);
        out = t ? tasks.answer(t, String(body.id || ''), decision) : { error: 'That task is gone.' };
      } else if (body.kind === 'root') {
        const c = desk.take(body.id);
        if (!c || c.kind !== 'root') out = { error: 'That request was already answered.' };
        else if (decision === 'deny') {
          // Root stays off: asked again only when the setting is changed to another value and back.
          out = { ok: true };
          taskRoot.declined = true;
          taskRootState();
        } else {
          taskRoot.on = true;
          taskRoot.at = Date.now();
          saveTaskRoot();
          log('tasks: ROOT (UNSAFE) turned on in the EditLens window');
          taskRootState();
          out = { ok: true };
        }
      } else if (body.kind === 'setting') {
        const c = desk.take(body.id);
        if (!c || c.kind !== 'setting' || settingsState.held.get(c.key) !== c.value) out = { error: 'That request was already answered, or the setting changed since.' };
        else if (decision === 'deny') {
          settingsState.declined.set(c.key, c.value);
          saveDeclined();
          log(`settings: ${c.key} = ${JSON.stringify(c.value)} kept out in the EditLens window`);
          out = { ok: true };
        } else {
          applyHeld(c.key, 'allowed in the EditLens window');
          out = { ok: true };
        }
      } else if (body.kind === 'mode') {
        const c = desk.take(body.id);
        if (!c || c.kind !== 'mode') out = { error: 'That request was already answered or expired.' };
        else if (decision === 'deny') out = { ok: true };
        else if (!c.runId || c.runId !== driver.status().runId) out = { error: 'That request was for page control that has ended. Pick the mode on the page again.' };
        else out = c.agent === null ? await driver.setMode(c.mode, { confirm: true }) : driver.setAgentMode(c.agent, c.mode, { confirm: true });
      } else {
        out = { error: 'unknown question' };
      }
      log(`answer window: ${body.kind} ${decision}${out.error ? ` (${out.error})` : ''}`);
      return send(res, out.error ? 409 : 200, out);
    }
    case 'GET /live.js':
      return serveClient(req, res);
    case 'GET /':
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(homePage(null, pageKeyOk ? userPageKey() : null));
    case 'POST /message': {
      const body = await readJson(req);
      // "Paired computers can run Claude here" off: a paired page can't give Claude work (Sol N1).
      if (pair && currentSettings().remote_tasks === false) return send(res, 403, { error: tasks.runsOff() }, cors);
      // A command picked in the palette: Claude runs it with its Skill tool when it reads it.
      let command = null;
      if (body && body.command && typeof body.command === 'object') {
        const name = String(body.command.name || '');
        if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad command name' }, cors);
        const args = typeof body.command.args === 'string' ? body.command.args.trim().slice(0, MESSAGE_MAX) : '';
        command = { name, args };
      }
      let text = command ? `/${command.name}${command.args ? ' ' + command.args : ''}` : body && typeof body.text === 'string' ? body.text.trim() : '';
      const page = body && pageFor(req, body.pageId);
      if (!page || !page.root) return send(res, 403, { error: page ? NO_ROOT : 'Reload the page, then try again.' }, cors);
      // Screenshots pasted into the message box (sent before with POST /shot).
      const picked = command ? { shots: [] } : shots.pick(body.images, { root: page.root, pair: pair ? pair.id : null }, rootMatches);
      if (picked.error) return send(res, 410, { error: picked.error }, cors);
      if (!text && picked.shots.length) text = 'Look at this.';
      if (!text) return send(res, 400, { error: 'empty message' }, cors);
      if (text.length > MESSAGE_MAX) return send(res, 413, { error: 'message too long' }, cors);
      // Things the user pointed at on the page, sent with the message.
      const atts = command ? [] : attachments.clean(body.attachments);
      const msg = { id: crypto.randomBytes(6).toString('hex'), text, pageId: page ? page.id : null, root: page.root, status: 'queued', ts: Date.now(), command, attachments: atts, images: picked.shots,
        paired: Boolean(pair) };
      messages.push(msg);
      if (messages.length > 200) messages.splice(0, messages.length - 200);
      // computer: the paired computer whose page sent it, for the label on this computer's pages; host:
      // this computer, when its own page sent it, for the label on a paired computer's page.
      addEvent({ type: 'page-message', id: msg.id, text, pageId: msg.pageId, root: msg.root, status: 'queued', command, attachments: atts.length ? atts : undefined,
        images: picked.shots.length ? picked.shots.map(screenshots.publicShot) : undefined, computer: pair ? pair.name : undefined, host: pair ? undefined : tasks.host });
      const listening = waiters.size > 0;
      wakeWaiters();
      return send(res, 200, { id: msg.id, listening, state: claudeState.state, canListen: claudeState.canListen }, cors);
    }
    case 'POST /shot': {
      // A screenshot pasted into the message box: kept only when its first bytes say PNG, JPEG or
      // WebP. The page's file name and type are never used.
      const page = pageFor(req, url.searchParams.get('page'));
      if (!page || !page.root) {
        req.resume();
        return send(res, 403, { error: page ? NO_ROOT : 'Reload the page, then try again.' }, cors);
      }
      const buf = await readBuffer(req, screenshots.MAX_BYTES);
      const out = buf ? shots.save(buf, { root: page.root, pair: pair ? pair.id : null }) : { error: screenshots.REFUSED };
      if (out.error) return send(res, 415, { error: out.error }, cors);
      return send(res, 200, screenshots.publicShot(out.shot), cors);
    }
    case 'GET /shot': {
      // A sent screenshot, for the message bubble: only for a page of the same project.
      const page = pageFor(req, url.searchParams.get('page'));
      const shot = page && page.root ? shots.get(url.searchParams.get('id'), { root: page.root, pair: pair ? pair.id : null }, rootMatches) : null;
      if (!shot) return send(res, 404, { error: screenshots.GONE }, cors);
      const data = await fs.promises.readFile(shot.file).catch((err) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (!data) return send(res, 404, { error: screenshots.GONE }, cors);
      res.writeHead(200, { 'Content-Type': shot.type, 'Content-Length': data.length, 'Cache-Control': 'private, max-age=3600',
        'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'cross-origin', ...cors });
      return res.end(data);
    }
    case 'POST /message/cancel': {
      // Cancel a message Claude has not received yet: only from a page of its project (pageFor keeps a
      // paired page to its paired project).
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page || !page.root) return send(res, 403, { error: page ? NO_ROOT : 'Reload the page, then try again.' }, cors);
      const msg = messages.find((m) => m.id === String(body.id || ''));
      if (!msg || !pageSees(page, msg.root)) return send(res, 404, { error: 'unknown message' }, cors);
      if (msg.status === 'cancelled') return send(res, 200, { ok: true, already: true }, cors);
      if (msg.status !== 'queued') return send(res, 409, { error: 'Claude already has this message' }, cors);
      msg.status = 'cancelled';
      addEvent({ type: 'cancelled', ids: [msg.id] });
      return send(res, 200, { ok: true }, cors);
    }
    case 'POST /restore': {
      // "Restore previous version": only for a known page and a file in its project.
      // { page, id }: restore backup id. { page, id, check: true }: only say what it would do.
      // { page, remove: seq }: remove the file that edit seq created (its text is kept for undo).
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
      // An edit named by number must be from this server start: numbers start again at 1 after a
      // restart, so an older card's "edit 1" would be a different edit now.
      const byNumber = body.remote === true || body.undoEdit !== undefined || body.remove !== undefined;
      if (byNumber && body.instance !== INSTANCE) return send(res, 409, { ok: false, error: 'This edit is from before EditLens restarted. Reload the page to see the current edits.', restarted: true }, cors);
      // An edit made on a paired computer: done there ({ remote: true, edit: seq, id } names its
      // card and copy; undoEdit and remove name its card). server/remote-restore.js
      const away = remoteRestore.target(body);
      if (away) {
        const out = await remoteRestore.handle(page, body, away);
        return send(res, out.status, out.body, cors);
      }
      // { page, undoEdit: seq, check? , back? }: remove only that edit from the file (or put it back).
      if (body.undoEdit !== undefined) {
        const s = seqOf(body.undoEdit);
        const ev = s ? undoCore.findEdit(s) : null;
        if (!ev) {
          const no = undoCore.refuse(s, null);
          return send(res, no.status, no.body, cors);
        }
        if (!rootMatches(page.root, ev.cwd || path.dirname(ev.file)) || (pair && !pairHasFile(pair, ev.file))) return send(res, 403, { ok: false, error: 'That file belongs to another project.' }, cors);
        const n = undoCore.numbers(pageAnchor(page)).get(s) || null;
        // A paired page: the paired folder again at the write (Sol H3).
        // noUndo: "without Undo" chosen on the card (no copy of the current file can be kept).
        const scope = { root: pair ? pair.cwd : null, noUndo: body.noUndo === true };
        const out = body.back === true ? undoCore.putBack(s, n, scope) : body.check === true ? undoCore.check(s, n) : undoCore.undo(s, n, scope);
        return send(res, out.status, out.body, cors);
      }
      if (body.remove !== undefined) {
        const n = Number(body.remove);
        const ev = Number.isInteger(n) && n > 0 ? history.find((e) => e.seq === n) : null;
        if (!ev || ev.type !== 'change' || !ev.created || ev.copy || ev.task || ev.remote || typeof ev.file !== 'string') return send(res, 404, { error: 'That edit is no longer listed. Reload the page, then try again.' }, cors);
        if (!rootMatches(page.root, ev.cwd || path.dirname(ev.file)) || (pair && !pairHasFile(pair, ev.file))) return send(res, 403, { error: 'That file belongs to another project.' }, cors);
        // A check (asked first for a paired computer's file) never removes anything.
        if (body.check === true) {
          const now = readNow(ev.file);
          const noUndo = now.text === null || now.error ? null : skipReason(now.text);
          return send(res, 200, { ok: true, exists: now.text !== null, ...(noUndo ? { noUndo } : {}) }, cors);
        }
        // A paired page: the paired folder again at the write (a folder link made since the check).
        const done = backups.removeFile({ file: ev.file, relFile: ev.relFile, cwd: ev.cwd, root: pair ? pair.cwd : null, noUndo: body.noUndo === true });
        if (done.error) return send(res, 409, done, cors);
        log(`removed ${ev.file} (created by edit ${n})`);
        const out = restoreEvent(done, 'remove', null, { removedSeq: n });
        return send(res, 200, { ok: true, relFile: done.relFile, undo: done.undo, deleted: true, seq: out.seq }, cors);
      }
      const item = backups.get(String(body.id || ''));
      if (!item) return send(res, 404, { error: 'That earlier version is no longer kept (EditLens keeps the last 200).', gone: true }, cors);
      if (!rootMatches(page.root, item.cwd || path.dirname(item.file)) || (pair && !pairHasFile(pair, item.file))) return send(res, 403, { error: 'That file belongs to another project.' }, cors);
      if (body.check) return send(res, 200, backups.check(item.id), cors);
      const done = backups.restore(item.id, { root: pair ? pair.cwd : null, noUndo: body.noUndo === true });
      if (done.error) return send(res, done.gone ? 404 : 409, done, cors);
      if (done.same) return send(res, 200, { ok: true, relFile: done.relFile, same: true, undo: null }, cors);
      log(`restored ${item.file} from ${item.id}`);
      // Restoring the copy a restore kept is an undo of that restore.
      const via = viaFor(done);
      const out = restoreEvent(done, via, item.id);
      return send(res, 200, { ok: true, relFile: done.relFile, undo: done.undo, via, missing: Boolean(done.missing), seq: out.seq }, cors);
    }
    case 'GET /copy': {
      // A subagent's copy, as it is now: what merging each file would do.
      const page = pageFor(req, url.searchParams.get('page'));
      if (!page) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      const root = copyRootFor(page, String(url.searchParams.get('root') || ''), pair);
      if (!root) return send(res, 403, { error: 'That copy belongs to another project.' }, cors);
      const st = await worktree.status(root, String(url.searchParams.get('name') || ''));
      return st.error ? send(res, 404, st, cors) : send(res, 200, copySummary(st), cors);
    }
    case 'POST /task/effort':
    case 'POST /task/answer':
    case 'POST /task/stop': {
      // A task from a paired computer: Stop, and Allow / Deny, from this project's pages only.
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
      const t = tasks.byId(body.task);
      if (!t || !pageSees(page, t.cwd)) return send(res, 404, { error: 'No such task in this project.' }, cors);
      if (route === 'POST /task/stop') {
        log(`task ${t.id}: stopped from a page`);
        return send(res, 200, tasks.stopTask(t), cors);
      }
      // The effort chip on its card: one of the five levels.
      if (route === 'POST /task/effort') {
        const done = await tasks.setEffort(t, body.level);
        return send(res, done.error ? 409 : 200, done, cors);
      }
      if (body.decision !== 'deny') return send(res, 403, { error: ANSWER_IN_WINDOW, answerWindow: true }, cors);
      const done = tasks.answer(t, String(body.id || ''), 'deny');
      return send(res, done.error ? 409 : 200, done, cors);
    }
    case 'POST /remote/task-effort': {
      // The effort chip on the card of a task this project gave a paired computer: sent to that
      // computer, which checks the level again. Only from a page of the project the task came from.
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      if (!page.root || String(page.id).startsWith('pair-')) return send(res, 403, { error: NO_ROOT }, cors);
      if (!effortLib.isLevel(body.level)) return send(res, 400, { error: effortLib.BAD_LEVEL }, cors);
      const id = String(body.task || '');
      const f = /^[0-9a-f]{12}$/.test(id) ? [...remote.computers.values()].find((c) => c.dirs.has(id)) : null;
      if (!f || !rootMatches(page.root, f.dirs.get(id))) return send(res, 404, { error: 'No such task from this project.' }, cors);
      const out = await pairRemotes.task(f.key, { op: 'effort', task: id, level: body.level });
      if (out && !out.error) log(`task ${id} on ${f.name}: effort ${body.level} from a page`);
      return send(res, out && out.error ? 409 : 200, out || { error: 'No response.' }, cors);
    }
    case 'POST /remote/task/stop': {
      // Stop on a task this project gave a paired computer (its card or its details card): the
      // same op the stop_computer_task tool sends. Only this project's pages, never one opened
      // through a pairing link.
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page || pair) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
      const id = String(body.task || '');
      const f = /^[0-9a-f]{12}$/.test(id) ? [...remote.computers.values()].find((x) => x.dirs.has(id) && rootMatches(page.root, x.dirs.get(id))) : null;
      if (!f) return send(res, 404, { error: 'No such task from this project.' }, cors);
      log(`task ${id} on ${f.name}: stopped from a page`);
      const done = await pairRemotes.task(f.key, { op: 'stop', task: id });
      return send(res, done && done.error ? 409 : 200, done || { error: `${f.name} did not respond.` }, cors);
    }
    case 'POST /remote/task/undo-apply': {
      // Undo on a task card after Claude added the task's changes: only this project's pages,
      // never one opened through a pairing link.
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page || pair) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
      const rec = taskApplied.get(String(body.task || ''));
      if (!rec || !rootMatches(page.root, rec.cwd)) return send(res, 404, { error: 'Nothing from this task was added to this project.' }, cors);
      if (rec.undone) return send(res, 409, { error: 'Already undone.' }, cors);
      const done = await undoApplied(rec);
      return send(res, done.error ? 409 : 200, done, cors);
    }
    case 'POST /copy/merge':
    case 'POST /copy/remove': {
      // Merge or Remove on a copy card: only for a known page and a copy in its project.
      const body = await readJson(req);
      const page = body && pageFor(req, body.page);
      if (!page) return send(res, 403, { error: 'Reload the page, then try again.' }, cors);
      if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
      const root = copyRootFor(page, String(body.root || ''), pair);
      if (!root) return send(res, 403, { error: 'That copy belongs to another project.' }, cors);
      const name = String(body.name || '');
      if (route === 'POST /copy/remove') {
        const done = worktree.remove(root, name);
        if (done.error) return send(res, 409, done, cors);
        log(`copy ${name}: removed`);
        broadcastVolatile({ type: 'copy-state', sessionId: null, cwd: root, file: path.join(root, '.claude', 'worktrees', name), name, removed: true });
        return send(res, 200, done, cors);
      }
      const take = Array.isArray(body.take) ? body.take.filter((t) => typeof t === 'string').slice(0, 100) : [];
      const done = await mergeCopy(root, name, take);
      return send(res, done.error ? 409 : 200, done, cors);
    }
    case 'POST /page': {
      const body = await readJson(req);
      const page = body && pageFor(req, body.id);
      if (!page) return send(res, 404, { error: 'unknown page' }, cors);
      if (typeof body.listen === 'boolean') page.listen = body.listen;
      // Stop a waiting Stop hook promptly when the last listening page stops listening.
      if (!body.listen) {
        for (const w of [...waiters]) {
          if (!listeningPages(w.cwd).length) {
            waiters.delete(w);
            clearTimeout(w.timer);
            send(w.res, 200, { messages: [], listening: false });
          }
        }
      }
      return send(res, 200, { ok: true }, cors);
    }
    // ----- page control: every request includes the key that /editlens control gave this page -----
    case 'POST /drive/message':
    case 'POST /drive/permission':
    case 'POST /drive/interrupt':
    case 'POST /drive/signin':
    case 'POST /drive/signin-code':
    case 'POST /drive/signin-cancel':
    case 'POST /drive/mode':
    case 'POST /drive/agent-mode':
    case 'POST /drive/effort':
    case 'POST /drive/stop-agent':
    case 'POST /drive/stop': {
      const body = await readJson(req);
      if (!body || !driveKeyOk(body.key, pageKey(req, body.pageId))) return send(res, 403, { error: "This page doesn't control Claude. Run /editlens control in Claude Code.", notDriving: true }, cors);
      // "Paired computers can run Claude here" turned off after page control started: a paired page
      // can still stop Claude, nothing more (Sol M3). Checked on each request.
      if (pair && currentSettings().remote_tasks === false && !PAIRED_STOPS.has(route)) {
        return send(res, 403, { error: tasks.runsOff() }, cors);
      }
      if (route === 'POST /drive/stop') {
        clearAutoWant('Manual on the page');
        forgetKept('Manual on the page');
        return send(res, 200, driver.stop('switched to manual from the page'), cors);
      }
      if (route === 'POST /drive/interrupt') return send(res, 200, await driver.interrupt(), cors);
      if (route === 'POST /drive/signin') return send(res, 200, driver.signIn({ console: body.console === true }), cors);
      if (route === 'POST /drive/signin-code') return send(res, 200, driver.signInCode(body.code), cors);
      if (route === 'POST /drive/signin-cancel') return send(res, 200, driver.cancelSignIn(), cors);
      if (route === 'POST /drive/stop-agent') return send(res, 200, await driver.stopAgent(body.agent), cors);
      // The panel's effort menu: one of the five levels, as its own field.
      if (route === 'POST /drive/effort') {
        if (!effortLib.isLevel(body.level)) return send(res, 400, { error: effortLib.BAD_LEVEL }, cors);
        const out = await driver.setEffort(body.level);
        return send(res, out.error ? 409 : 200, out, cors);
      }
      // A less strict mode (Accept edits, Bypass) waits for the EditLens window; a stricter one is
      // made immediately.
      if (route === 'POST /drive/mode') {
        if (LOOSE_MODES.has(body.mode)) return send(res, 200, { pending: true, id: desk.requestMode(null, body.mode, null, driver.status().runId).id }, cors);
        return send(res, 200, await driver.setMode(body.mode), cors);
      }
      if (route === 'POST /drive/agent-mode') {
        const mode = body.mode === null ? null : body.mode;
        const st = driver.status();
        if (LOOSE_MODES.has(mode) || (mode === null && LOOSE_MODES.has(st.mode))) {
          if (typeof body.agent !== 'string' || !/^[\w-]{1,100}$/.test(body.agent)) return send(res, 400, { error: 'Unknown subagent.' }, cors);
          return send(res, 200, { pending: true, id: desk.requestMode(body.agent, mode, typeof body.label === 'string' ? body.label.slice(0, 120) : null, st.runId).id }, cors);
        }
        return send(res, 200, driver.setAgentMode(body.agent, mode), cors);
      }
      if (route === 'POST /drive/permission') {
        if (body.decision !== 'deny') return send(res, 403, { error: ANSWER_IN_WINDOW, answerWindow: true }, cors);
        return send(res, 200, driver.answer(body.id, 'deny'), cors);
      }
      let text = typeof body.text === 'string' ? body.text.trim() : '';
      if (body.command && typeof body.command === 'object') {
        const name = String(body.command.name || '');
        if (!NAME_RE.test(name)) return send(res, 400, { error: 'bad command name' }, cors);
        const args = typeof body.command.args === 'string' ? body.command.args.trim().slice(0, MESSAGE_MAX) : '';
        text = `/${name}${args ? ' ' + args : ''}`;
      }
      const atts = attachments.clean(body.attachments);
      const drivePage = pageFor(req, body.pageId);
      const picked = drivePage && drivePage.root ? shots.pick(body.images, { root: drivePage.root, pair: pair ? pair.id : null }, rootMatches)
        : body.images ? { error: screenshots.GONE } : { shots: [] };
      if (picked.error) return send(res, 410, { error: picked.error }, cors);
      if (!text && !atts.length && !picked.shots.length) return send(res, 400, { error: 'empty message' }, cors);
      if (text.length > MESSAGE_MAX) return send(res, 413, { error: 'message too long' }, cors);
      const full = atts.length ? `${text || 'Look at this.'}\n\n${attachments.formatAttachments(atts, text)}` : text || 'Look at this.';
      // Page control: the screenshots go to Claude in the message itself.
      let content;
      try {
        content = await screenshots.messageContent(full, picked.shots);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        return send(res, 410, { error: screenshots.GONE }, cors);
      }
      const out = driver.send(content);
      if (out.error) return send(res, 409, out, cors);
      // Its first message names the conversation in the Sessions list (until it is renamed).
      const ds = driver.status();
      if (text && !body.command) sessionStore.pageMessage(ds.sessionId || null, text, ds.runId || null);
      addEvent({ type: 'drive-message', text: text || 'Look at this.', attachments: atts.length ? atts : undefined, cwd: driveGrant ? driveGrant.cwd : null,
        images: picked.shots.length ? picked.shots.map(screenshots.publicShot) : undefined, computer: pair ? pair.name : undefined, host: pair ? undefined : tasks.host });
      return send(res, 200, out, cors);
    }
    case 'POST /board/clear': {
      // The Clear button on the Team tab.
      const body = await readJson(req);
      const page = body && pageFor(req, body.pageId);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
      const board = cwd && boards.all().find((b) => normalize(b.cwd) === normalize(cwd));
      if (!page || !board) return send(res, 404, { error: 'unknown page or board' }, cors);
      if (!page.root) return send(res, 403, { error: NO_ROOT }, cors);
      if (!pageSees(page, board.cwd)) return send(res, 403, { error: 'this board belongs to another project' }, cors);
      boards.clear(board.cwd);
      return send(res, 200, { ok: true }, cors);
    }
    case 'POST /report': {
      const body = await readJson(req);
      if (!body || typeof body.pointId !== 'string') return send(res, 400, { error: 'missing pointId' }, cors);
      const pointId = body.pointId.slice(0, 100);
      const list = reports.get(pointId) || [];
      // Each result is kept small, and only the latest 20 per point.
      const results = (Array.isArray(body.results) ? body.results.slice(0, 20) : []).map((r) => {
        const text = JSON.stringify(r === undefined ? null : r);
        return text.length > 4000 ? { truncated: true, text: text.slice(0, 4000) } : r;
      });
      list.push({ pageId: typeof body.pageId === 'string' ? body.pageId.slice(0, 64) : null, url: String(body.url || '').slice(0, 500), results });
      if (list.length > 20) list.splice(0, list.length - 20);
      reports.set(pointId, list);
      if (reports.size > 100) reports.delete(reports.keys().next().value);
      return send(res, 200, { ok: true }, cors);
    }
    default:
      break;
  }

  // ----- hooks and MCP tool only -----
  // A browser that opened some other address here (4317/index.html): the same page, not an error.
  if (!trusted && req.method === 'GET' && /text\/html/.test(String(req.headers.accept || '')) && !req.headers['x-editlens-token']) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(homePage(`There is nothing at ${url.pathname.slice(0, 200)} here.`, pageKeyOk ? userPageKey() : null));
  }
  if (!trusted && !(taskKey && taskuser.keyAllows(route))) return send(res, 401, 'bad token');
  switch (route) {
    case 'POST /agents/follow': {
      // Follow in the terminal's agents list (the mod): this project's open pages follow that agent
      // in the code view. Sent now only, never kept for pages that open later.
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
      const key = body && typeof body.key === 'string' ? body.key.slice(0, 200) : '';
      if (!cwd || !key) throw new HttpError(400, 'missing cwd or key');
      const open = [...pages.values()].filter((p) => pageSees(p, cwd)).length;
      if (!open) return send(res, 409, { error: NO_PAGE_OPEN });
      const agentId = typeof body.agentId === 'string' ? body.agentId.slice(0, 200) : null;
      fanOut(volatileFrame({ type: 'follow-agent', cwd, key, agentId, ts: Date.now() }), cwd);
      return send(res, 200, { ok: true, pages: open });
    }
    case 'POST /agents/stop': {
      // Stop in the terminal's agents list: a paired computer's task running here for this project,
      // or a subagent of page control. (A task on a paired computer is stopped with POST /remote/task.)
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
      if (!cwd) throw new HttpError(400, 'missing cwd');
      if (body.task) {
        const t = tasks.byId(body.task);
        if (!t || !rootMatches(t.cwd, cwd)) return send(res, 404, { error: 'No such task in this project.' });
        log(`task ${t.id}: stopped from Claude Code`);
        return send(res, 200, tasks.stopTask(t));
      }
      const ds = driver.status();
      if (!ds.active || (ds.cwd && !rootMatches(ds.cwd, cwd))) return send(res, 409, { error: 'Only a subagent of page control can be stopped here. Stop it in Claude Code.' });
      const done = await driver.stopAgent(typeof body.agent === 'string' ? body.agent : '');
      return send(res, done && done.error ? 409 : 200, done);
    }
    case 'POST /sessions/stop': {
      // /editlens stop <name> (typed by the person) and Stop in the terminal's Sessions pane.
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
      if (!cwd) throw new HttpError(400, 'missing cwd');
      const out = await stopSession(cwd, { key: typeof body.key === 'string' ? body.key.slice(0, 200) : null, name: typeof body.name === 'string' ? body.name.slice(0, 200) : null });
      return send(res, out.status, out.body);
    }
    case 'GET /page-key':
      // For /editlens and page control (the hook key): the page key, when page addresses need it (D21).
      return send(res, 200, keysNeeded() ? { needed: true, key: userPageKey() } : { needed: false, key: null });
    case 'GET /tasks/live':
      // For /editlens task-user off: never remove the account under a running task.
      return send(res, 200, { live: tasks.live().length });
    case 'GET /effort': {
      // /editlens effort: the EditLens setting, page control's level here, this terminal's own
      // (read only) and the running tasks'.
      const cwd = String(url.searchParams.get('cwd') || '');
      const ds = driver.status();
      // A change Claude Code doesn't have yet is not in effect (M10), but /editlens effort shows it (X2).
      const now = currentSettings();
      const want = requestedSettings();
      return send(res, 200, {
        setting: effortLib.fromSettings(now, cwd || null),
        auto: effortLib.isAuto(now),
        asked: want.effort !== now.effort ? { setting: effortLib.fromSettings(want, cwd || null), auto: effortLib.isAuto(want) } : null,
        page: ds.active && (!cwd || rootMatches(ds.cwd, cwd)) ? ds.effort || null : null,
        pageRunning: Boolean(ds.active && (!cwd || rootMatches(ds.cwd, cwd))),
        here: terminalEffort(String(url.searchParams.get('session') || '') || claudeState.sessionId),
        tasks: effortTasks(cwd || null),
      });
    }
    case 'POST /effort': {
      // /editlens effort <level|auto>: the EditLens setting (saved through Claude Code), and page
      // control now when it runs in this project. Never this terminal's own level (/effort there).
      // Max is never saved (D24): it changes only the page control session running now.
      const body = (await readJson(req)) || {};
      const auto = typeof body.level === 'string' && body.level.trim().toLowerCase() === 'auto';
      const cwd = typeof body.cwd === 'string' ? body.cwd : '';
      // Auto: page control moves to Claude Code's level when its settings name one, else to Claude's own.
      const level = auto ? effortLib.fromSettings(null, cwd || null) : effortLib.parse(body.level);
      if (!level && !auto) return send(res, 400, { error: effortLib.BAD_LEVEL });
      const value = auto ? effortLib.AUTO : effortLib.LABELS[level];
      const saves = modLive() && (auto || level !== 'max');
      if (saves) {
        queueSetting('effort', value);
        sendSettings(false);
      }
      const ds = driver.status();
      let page = null;
      if (ds.active && (!cwd || rootMatches(ds.cwd, cwd))) {
        // Auto with no level there: the level EditLens set is cleared, so Claude uses its own.
        // Set before the mod reports the save. Auto follows the setting, so its level is not kept.
        if (saves && level && !auto) effortSaveAsked = { level, at: Date.now() };
        const out = level ? await driver.setEffort(level, { fromSetting: auto }) : await driver.clearEffort();
        if (out.error) return send(res, 409, { error: out.error, level });
        page = out.effort;
      }
      return send(res, 200, { ok: true, level, auto, page, saved: saves });
    }
    case 'POST /settings/report': {
      // From the mod (its options) or a hook (its environment), and only from this server's user:
      // the connection's owner and, when the report gives its pid, the reporting process. Where
      // that can't be told (not Linux), the key alone counts, as in the user check above.
      const body = await readJson(req);
      // A mod's refusal has only the refused ids (values with it would replace the ones in effect).
      const onlyRefused = !!body && body.from === 'mod' && body.values === undefined && Array.isArray(body.refused);
      if (!body || (!onlyRefused && (!body.values || typeof body.values !== 'object'))) throw new HttpError(400, 'missing values');
      if (body.pid !== undefined && (!Number.isSafeInteger(body.pid) || body.pid <= 0)) throw new HttpError(400, 'pid must be a whole number above 0');
      const peer = OWN_UID === null ? null : peerUid(req.socket);
      if (peer !== null && peer !== OWN_UID) throw new HttpError(403, 'Settings come only from this computer user\'s Claude Code.');
      if (body.pid !== undefined && OWN_UID !== null && process.platform === 'linux' && pidUid(body.pid) !== OWN_UID) {
        throw new HttpError(403, `Process ${body.pid} is not running as this server's user.`);
      }
      if (body.from === 'mod') settingsState.modAt = Date.now();
      if (!onlyRefused) reportSettings(body.values, 'claude-code');
      if (body.from === 'mod') refuseSettings(body.refused);
      return send(res, 200, { ok: true, values: currentSettings() });
    }
    case 'POST /shutdown': {
      const body = (await readJson(req)) || {};
      const busy = busyReason();
      noteInstalled(body.version); // the newest installed copy: a stop for it is an update
      // An update (force: false) waits while Claude runs from the page or a task runs; this server
      // exits by itself once they are done (the heartbeat), and the next hook starts the new one.
      if (busy && body.force === false) {
        if (!updateWaiting) log(`an update is waiting until ${busy} finishes`);
        updateWaiting = true;
        return send(res, 409, { busy });
      }
      log('shutdown requested');
      send(res, 200, { ok: true });
      setImmediate(shutdown);
      return undefined;
    }
    case 'POST /event': {
      const raw = await readJson(req);
      if (!raw || typeof raw.type !== 'string') return send(res, 400, 'missing type');
      const body = stripSecret(raw);
      if (taskKey) {
        if (!taskEventOk(body)) return send(res, 403, 'not allowed for a task');
        for (const k of ['transcriptPath', 'execPath', 'settings']) delete body[k];
        body.fromTaskAccount = true;
        // Only its edits show. Its session, prompts, idle and command list belong to the task's
        // card (server/tasks.js follows them through the SDK), never to this computer's own
        // Claude state, mode or command palette.
        if (!TASK_EDIT_EVENTS.has(body.type)) return send(res, 200, { ok: true, skipped: true });
      } else {
        delete body.fromTaskAccount;
      }
      delete body.remote; // only for edits on a paired computer (remoteEdit)
      noteCompactEnv(body);
      if (body.transcriptPath) watchSession(body);
      // Page control's own Claude or a task's reports its plugin defaults: never the user's settings (G1).
      if (body.settings && typeof body.settings === 'object' && (body.type === 'session' || body.type === 'prompt') && !drivenSession(body.sessionId)) {
        reportSettings(body.settings, 'claude-code');
      }
      noteInstalled(body.pluginVersion);
      if (isClaudeProgram(body.execPath)) {
        const known = execPaths.has(body.execPath) && [...execPaths].pop() === body.execPath;
        execPaths.delete(body.execPath);
        execPaths.add(body.execPath);
        if (execPaths.size > 5) execPaths.delete(execPaths.values().next().value);
        if (!known) saveExecPaths();
        // A Claude program again after the one page control used was removed.
        if (!known && restoreWant && restoreWant.reason === 'claude-gone') tryRestore().catch((err) => log(`page control restore: ${err.message}`));
      }
      // bin/drive.js setting up page control (a download that can take minutes); '' when done.
      if (body.type === 'setup') {
        broadcastVolatile({ type: 'setup', sessionId: null, cwd: typeof body.cwd === 'string' ? body.cwd : null, text: typeof body.text === 'string' ? body.text.slice(0, 300) : '' });
        return send(res, 200, { ok: true });
      }
      // The command list for the palette: sent to pages, not kept in the history.
      if (body.type === 'commands') {
        broadcastVolatile({ type: 'commands', sessionId: body.sessionId || null, cwd: body.cwd || null, commands: Array.isArray(body.commands) ? body.commands.slice(0, 300) : [] });
        return send(res, 200, { ok: true });
      }
      // Team board records from the hooks: who is about to call a board tool, and subagents
      // joining and finishing. Not part of the event stream.
      if (body.type === 'board-who') {
        if (typeof body.key !== 'string' || !/^[0-9a-f]{40}$/.test(body.key)) return send(res, 400, { error: 'bad key' });
        boards.expect(body.key, { sessionId: body.sessionId || null, agentId: body.agentId || null, agentType: body.agentType || null, name: typeof body.name === 'string' ? body.name : null, projectDir: body.projectDir || body.cwd || null });
        return send(res, 200, { ok: true });
      }
      if (body.type === 'ask') {
        if (drivenSession(body.sessionId)) return send(res, 200, { ok: true, skipped: true });
        const q = asks.add({ ...body, cwd: body.projectDir || body.cwd });
        return send(res, q ? 200 : 400, q ? { ok: true, id: q.id } : { error: 'missing tool or folder' });
      }
      if (body.type === 'ask-done') return send(res, 200, { ok: true, cleared: asks.done(body) });
      if (body.type === 'subagent-start' || body.type === 'subagent-stop') {
        const dir = body.projectDir || body.cwd;
        if (typeof dir !== 'string' || !dir || typeof body.agentId !== 'string' || !body.agentId) return send(res, 400, { error: 'missing agent or folder' });
        if (!body.copyOnly) boards.lifecycle(dir, { sessionId: body.sessionId || null, agentId: body.agentId, agentType: body.agentType || null, name: typeof body.name === 'string' ? body.name : null }, body.type === 'subagent-start' ? 'join' : 'leave', body.summary);
        if (body.type === 'subagent-stop') {
          copyFinished(body);
          asks.clear(body.sessionId || null, body.agentId);
          // A subagent run in the background: its card ends here, with its last reply.
          const w = typeof body.sessionId === 'string' ? sessions.get(body.sessionId) : null;
          if (w) w.subagentStopped(body.agentId, typeof body.result === 'string' ? body.result.slice(0, 20000) : '');
        }
        return send(res, 200, { ok: true });
      }
      // An edit by a task's Claude (from a paired computer): on the task's card, which both
      // computers' panels show live.
      const t = body.type === 'change' && typeof body.file === 'string' ? tasks.taskOfEdit(body.sessionId, body.file) : null;
      // In a copy of the asking computer's project: Restore belongs to that computer, so no copy here.
      const publicEvent = takeEvent(t && t.kind === 'sent' ? { ...body, noBackup: true } : body);
      if (body.type === 'change' && typeof body.file === 'string') {
        if (t) {
          tasks.noteEdit(t, body.file, body);
          tasks.rememberEdit(t, body.file, typeof body.after === 'string' ? body.after : undefined).catch((err) => log(`task ${t.id}: ${err.message}`));
        }
        // In a copy of the asking computer's project: shown on this project's pages (and the
        // asking computer's view of them) as that task's edit; Restore belongs to that computer.
        if (t && t.kind === 'sent') {
          publicEvent.task = { id: t.id, by: t.by };
          publicEvent.taskCwd = t.cwd;
          // A file in a subagent's copy inside the task's folder: named as in the project.
          publicEvent.relFile = worktree.projectRel(t.dir, body.file) || path.relative(t.dir, body.file).split(path.sep).join('/');
        }
      }
      // Claude stopped, the user typed a new prompt, or the session ended: no question is still waiting.
      if (['idle', 'prompt', 'end'].includes(body.type) && body.sessionId) asks.clear(body.sessionId);
      // The session that connected a page ended (not /clear or /resume): stop what it started.
      if (body.type === 'end' && body.sessionId) sessionEnded(body.sessionId);
      if (body.type === 'end' && autoWant && autoWant.sessionId === body.sessionId && !['clear', 'resume', 'compact'].includes(body.reason)) clearAutoWant('its session ended');
      if (body.type === 'end' && body.sessionId && !['clear', 'resume', 'compact'].includes(body.reason)) {
        connector.sessionEnded(body.sessionId).then(
          (n) => n && log(`connect: stopped ${n} connection(s) of session ${body.sessionId}`),
          (err) => log(`connect: stopping after session end failed: ${err.message}`),
        );
      }
      const event = addEvent(publicEvent);
      // After addEvent: the paired computer gets this edit's number here, for its Restore.
      if (body.type === 'change' && typeof body.file === 'string') feedEdit(body, event, t);
      trackState(body);
      noteMode(body);
      // The main agent's level only: a subagent can run at its own.
      if (!body.agentId) noteEffort(body.sessionId, body.cwd, body.effort);
      return send(res, 200, { ok: true, seq: event.seq, clients: clients.size, pages: pages.size });
    }
    case 'POST /board': {
      // A board tool call from the MCP server, matched to the agent the PreToolUse hook reported.
      const body = await readJson(req);
      if (!body || !BOARD_TOOLS.includes(body.tool)) return send(res, 400, { error: 'unknown board tool' });
      const who = boards.identify(String(body.key || ''));
      const cwd = who.projectDir || body.projectDir;
      if (typeof cwd !== 'string' || !cwd) return send(res, 400, { error: 'missing project folder' });
      const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
      return send(res, 200, boards.act(body.tool, args, who, cwd));
    }
    case 'POST /drive/grant': {
      const [status, answer] = await grantDrive(await readJson(req));
      return send(res, status, answer);
    }
    case 'POST /connect': {
      // From /editlens: connect this project's page without changing its files.
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
      if (!cwd) return send(res, 400, { error: 'missing project folder' });
      if (!projectDir(cwd)) return send(res, 400, { error: NOT_PROJECT });
      connectHints.delete(normalize(cwd));
      const out = await connector.connect({ cwd, target: typeof body.target === 'string' && body.target ? body.target.slice(0, 300) : null, port: body.port, sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : claudeState.sessionId && rootMatches(cwd, claudeState.cwd || cwd) ? claudeState.sessionId : null });
      return send(res, 200, out);
    }
    case 'POST /connect/hint': {
      // From /editlens or the session hook: a server that may be this project's (see connectHints).
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd.slice(0, 1000) : '';
      const target = body && typeof body.url === 'string' ? body.url : '';
      if (!cwd || tooBroad(cwd) || !HINT_URL.test(target)) return send(res, 400, { error: 'bad hint' });
      connectHints.delete(normalize(cwd));
      connectHints.set(normalize(cwd), { cwd, url: target, at: Date.now() });
      if (connectHints.size > 20) connectHints.delete(connectHints.keys().next().value);
      return send(res, 200, { ok: true });
    }
    case 'POST /disconnect': {
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
      if (!cwd) return send(res, 400, { error: 'missing project folder' });
      integrationCache.delete(normalize(cwd));
      return send(res, 200, await connector.disconnect(cwd, 'asked'));
    }
    // ----- pairing with another computer (/editlens pair on it, /editlens join on the other) -----
    case 'POST /pair': {
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' ? body.cwd : '';
      if (!projectDir(cwd)) return send(res, 400, { error: 'Run /editlens pair in your project\'s folder.' });
      return send(res, 200, await pairHost.newCode(cwd, { direct: body.direct === true }));
    }
    case 'POST /pair/off':
      return send(res, 200, pairHost.off());
    case 'GET /pair':
      return send(res, 200, { host: pairHost.status(), remotes: pairRemotes.status({ withKey: true }) });
    case 'POST /join': {
      const body = await readJson(req);
      if (!body || typeof body.address !== 'string' || typeof body.code !== 'string') return send(res, 400, { error: 'missing address or code' });
      const opts = { key: typeof body.key === 'string' && body.key ? body.key.slice(0, 1000) : null, sshPort: body.sshPort === undefined ? null : body.sshPort };
      const joined = await pairRemotes.join(body.address.slice(0, 300), body.code.slice(0, 100), opts);
      // This computer's line above the prompt says so too, as on the computer it joined.
      if (joined.ok && joined.host) pairNotice(`Paired with ◆ ${joined.host.name} · this computer can open its page and give Claude there tasks`, { kind: 'paired', name: joined.host.name, joined: true });
      return send(res, 200, joined);
    }
    case 'POST /join/off': {
      const body = await readJson(req);
      const name = body && typeof body.name === 'string' ? body.name.slice(0, 100) : '';
      const out = await pairRemotes.off(name);
      // A computer that joined this one, by its name: removed here (it isn't told).
      if (name && out.error) {
        const gone = pairHost.remove(name);
        if (gone.length) {
          pairNotice(`◆ ${gone[0].name} unpaired from this computer`);
          return send(res, 200, { removed: gone.map((g) => ({ name: g.name, told: false, joinedHere: true })) });
        }
      }
      return send(res, 200, out);
    }
    case 'POST /remote/task': {
      // The live-page MCP tools: this computer's Claude works with Claude on a paired computer.
      const body = await readJson(req);
      if (!body || typeof body.op !== 'string') return send(res, 400, { error: 'missing op' });
      // startId, startPrompt: the start this op belongs to (mcp/live-page.js), for its card.
      const { computer, localDir, startId, startPrompt, ...rest } = body;
      const name = typeof computer === 'string' ? computer : '';
      const key = typeof startId === 'string' && /^[0-9a-f]{8,32}$/.test(startId) ? startId : null;
      const who = computerKey(name) || name;
      // The asking agent stopped waiting for a start (lib/remotework.js said why): the page says so too.
      if (rest.op === 'start-failed') {
        if (key) noteStart(key, { op: 'start', answer: { error: String(rest.error || 'unknown error').slice(0, 600) }, computer: who, cwd: localDir, prompt: startPrompt });
        return send(res, 200, { ok: true });
      }
      // A start's level: the one the agent gave (its own field), else this computer's Effort setting
      // (tasks it starts). Auto sends none: the other computer uses its own setting. Anything else
      // is refused here, before it is sent.
      if (rest.op === 'start') {
        if (rest.effort === undefined || rest.effort === null) {
          const own = effortLib.isAuto(currentSettings()) ? null : effortLib.fromSettings(currentSettings());
          if (own) rest.effort = own;
          else delete rest.effort;
        }
        if (rest.effort !== undefined && !effortLib.isLevel(rest.effort)) return send(res, 200, { error: effortLib.BAD_LEVEL });
      }
      const answer = await pairRemotes.task(name, rest);
      const prompt = typeof startPrompt === 'string' ? startPrompt : rest.op === 'start' ? rest.prompt : rest.op === 'send' ? rest.text : '';
      if ((rest.op === 'upload' && !rest.upload && key) || rest.op === 'start' || rest.op === 'send') {
        noteStart(key || crypto.randomBytes(8).toString('hex'), { op: rest.op, answer, computer: (answer && answer.computer) || who, cwd: localDir, prompt, followUp: rest.op === 'send' });
      }
      // A task started or continued: this project's panel shows it live.
      if ((rest.op === 'start' || rest.op === 'send') && answer && !answer.error) {
        mirrorTask(name, String(answer.task || rest.task || ''), localDir);
        noteStarted(name, answer);
        // Its card now: the paired computer's updates from before this answer could not be
        // matched to this project yet, and the next one may come only when the task changes.
        const id = String(answer.task || '');
        if (rest.op === 'start' && /^[0-9a-f]{12}$/.test(id) && typeof localDir === 'string' && localDir && !tooBroad(localDir)) {
          const ws = answer.workspace || {};
          remoteCard(String(answer.computer || who), id, localDir, { prompt: answer.prompt, state: answer.state, error: answer.error, note: answer.note, effort: answer.effort,
            startedAt: answer.startedAt, kind: ws.sentFrom ? 'sent' : ws.name ? 'copy' : 'shared' });
        }
      }
      return send(res, 200, answer);
    }
    case 'GET /remote/tasks': {
      // The tasks this computer started on paired computers, as last reported (wait_for_computer_tasks).
      // follow=<name>: start following that computer's tasks (after a restart, or tasks started earlier).
      if (url.searchParams.has('follow')) followComputer(String(url.searchParams.get('follow') || '').slice(0, 100));
      const since = Number(url.searchParams.get('since'));
      return send(res, 200, await remoteTasks(Number.isSafeInteger(since) ? since : -1, Number(url.searchParams.get('wait'))));
    }
    case 'POST /remote/applied': {
      // apply_computer_task wrote a file from a task's workspace into this project: it shows on
      // the page like any other edit (highlight, Changes list, code view, Restore).
      const body = await readJson(req);
      const out = body ? remoteApplied(body) : { error: 'missing body' };
      return send(res, out.error ? 400 : 200, out);
    }
    case 'POST /remote/task-applied': {
      // apply_computer_task or merge_computer_task (or their undo) finished: the task's card says so.
      const body = await readJson(req);
      const out = body ? noteApplied(body) : { error: 'missing body' };
      return send(res, out.error ? 400 : 200, out);
    }
    case 'POST /join/control': {
      const body = await readJson(req);
      if (!body || typeof body.name !== 'string') return send(res, 400, { error: 'missing name' });
      return send(res, 200, await pairRemotes.control(body.name, controlArgs(body.args)));
    }
    case 'GET /claude-paths':
      // For bin/drive.js: the claude programs the hooks reported, newest first.
      return send(res, 200, { paths: [...execPaths].reverse() });
    case 'GET /connections':
      return send(res, 200, connector.list());
    case 'POST /drive/stop-waiting':
      // The user chose (/editlens control, manual or stop): a waiter from a session start is not needed.
      currentWaiter = null;
      clearAutoWant('the user chose');
      return send(res, 200, { ok: true });
    case 'POST /drive/auto': {
      // A session started with the setting on: page control turns on when this project's page opens.
      const out = setAutoWant(await readJson(req));
      if (out.ok) tryAutoControl().catch((err) => log(`auto page control: ${err.message}`));
      return send(res, out.ok ? 200 : 400, out);
    }
    case 'POST /drive/end': {
      // cwd (from /editlens stop): only page control in that folder or a folder inside it ends.
      const body = await readJson(req);
      const only = body && typeof body.cwd === 'string' && body.cwd ? path.resolve(body.cwd) : null;
      if (only) {
        const ds = driver.status();
        const mine = (c) => Boolean(c) && within(path.resolve(c), only);
        if (autoWant && mine(autoWant.cwd)) clearAutoWant('/editlens stop');
        if (restoreWant && mine(restoreWant.cwd)) forgetKept('/editlens stop');
        if (!ds.active || !mine(ds.cwd)) return send(res, 200, { ok: true, ended: false });
        forgetKept('/editlens stop');
        return send(res, 200, { ...driver.stop('stopped with /editlens stop'), ended: true });
      }
      clearAutoWant('stopped from Claude Code');
      forgetKept('/editlens manual');
      return send(res, 200, driver.stop('stopped from Claude Code'));
    }
    case 'POST /status': {
      // Status line input forwarded by bin/statusline.js (exact window, cost, plan limits).
      const body = await readJson(req);
      const sessionId = body && typeof body.session_id === 'string' ? body.session_id : '';
      if (!sessionId) return send(res, 400, { error: 'missing session_id' });
      const cwd = (body.workspace && body.workspace.current_dir) || body.cwd || null;
      if (!sessions.has(sessionId)) watchSession({ sessionId, transcriptPath: body.transcript_path, cwd });
      const watcher = sessions.get(sessionId);
      if (!watcher) return send(res, 404, { error: 'unknown session' });
      const { model, context_window, cost, rate_limits, effort, version } = body;
      watcher.usage.merge({ model, context_window, cost, rate_limits, effort, version });
      noteEffort(sessionId, cwd, effort && typeof effort === 'object' ? effort.level : null);
      watcher.reportUsage(true);
      // For the status line's "✦ live": a page of this project is open.
      const open = cwd ? [...pages.values()].filter((p) => p.root && rootMatches(p.root, cwd)).length : 0;
      return send(res, 200, { ok: true, pages: open });
    }
    case 'GET /history':
      return send(res, 200, history);
    case 'GET /pages/live':
      // The open pages, for the list_live_pages tool and /editlens (GET /pages is the page's own
      // route map, handled above for pages).
      return send(res, 200, [...pages.values()].map(({ res: _res, ...p }) => p));
    case 'GET /report':
      return send(res, 200, reports.get(String(url.searchParams.get('id') || '')) || []);
    case 'GET /messages/take':
      return send(res, 200, { messages: takeMessages(url.searchParams.get('cwd'), url.searchParams.get('via') || 'step') });
    case 'GET /messages/wait': {
      // Long poll used by the Stop hook while Claude is waiting and a page is listening.
      const cwd = url.searchParams.get('cwd');
      const timeout = intParam(url, 'timeout', 25000, 1000, WAIT_MAX_MS);
      // Absent or empty is "no deadline given" (Number('') is 0, a date in 1970, not NaN).
      const untilRaw = Number.parseInt(String(url.searchParams.get('until') || ''), 10);
      const until = Number.isInteger(untilRaw) && untilRaw > Date.now() ? untilRaw : Date.now() + timeout;
      const taken = takeMessages(cwd, 'listen');
      if (taken.length) return send(res, 200, { messages: taken, listening: true });
      if (!listeningPages(cwd).length) {
        setListen(false, 0);
        return send(res, 200, { messages: [], listening: false });
      }
      listenState.lastWait = Date.now();
      setListen(true, until);
      const w = { cwd, res };
      w.timer = setTimeout(() => {
        waiters.delete(w);
        send(res, 200, { messages: [], listening: listeningPages(cwd).length > 0 });
      }, timeout);
      waiters.add(w);
      req.on('close', () => {
        if (waiters.delete(w)) clearTimeout(w.timer);
      });
      return undefined;
    }
    case 'GET /listen-end':
      setListen(false, 0);
      return send(res, 200, { ok: true });
    // /editlens undo in the terminal: the same numbers as the page's markers, and the same core as
    // the page's Restore question (server/undo.js).
    case 'GET /edits/recent': {
      const sessionId = String(url.searchParams.get('session') || '').slice(0, 100) || null;
      const cwd = String(url.searchParams.get('cwd') || '').slice(0, 1000) || null;
      return send(res, 200, { edits: undoCore.recent({ session: sessionId, anchor: numberAnchor(cwd) }), instance: INSTANCE });
    }
    case 'POST /edits/undo':
    case 'POST /edits/restore': {
      const body = await readJson(req);
      const cwd = body && typeof body.cwd === 'string' && body.cwd ? body.cwd.slice(0, 1000) : null;
      let n = body ? seqOf(body.n) : null;
      if (!n) return send(res, 400, { ok: false, error: 'Give the number of an edit (a whole number from 1 up).' });
      // A row of the terminal's pane names its edit (seq) and this server start: the numbers can
      // change after it was listed (another page), so the edit acted on is the row's.
      const rowSeq = body.seq === undefined ? null : seqOf(body.seq);
      if (body.seq !== undefined && !rowSeq) return send(res, 400, { ok: false, error: 'The edit this row names is not a whole number. Open /editlens undo again.' });
      if (body.seq !== undefined && body.instance !== INSTANCE) {
        return send(res, 409, { ok: false, error: 'EditLens restarted after this list was shown. Pick the edit again in the new list.', restarted: true });
      }
      const anchor = numberAnchor(cwd);
      const s = rowSeq ? (undoCore.numbers(anchor).has(rowSeq) ? rowSeq : null) : undoCore.seqForNumber(n, anchor);
      if (rowSeq && !s) return send(res, 404, { ok: false, error: `Edit ${n} is no longer in the list. Pick it again in the new list.` });
      if (!s) return send(res, 404, { ok: false, error: `There is no edit ${n} in the list. Run /editlens undo to see the numbers.` });
      if (rowSeq) n = undoCore.numbers(anchor).get(s);
      // The list shows this session's edits: a number from another session is refused, not acted on.
      const session = typeof body.session === 'string' && body.session ? body.session.slice(0, 100) : null;
      const made = history.find((e) => e.seq === s);
      if (session && made && made.sessionId && made.sessionId !== session) {
        return send(res, 409, { ok: false, error: `Edit ${n} was made in another session, not in this one. Undo it on the page, or in that session.` });
      }
      const back = body.back === true;
      const out = route === 'POST /edits/undo' ? (back ? undoCore.putBack(s, n) : undoCore.undo(s, n)) : back ? undoCore.unrestore(s, n) : undoCore.restore(s, n);
      return send(res, out.status, out.body);
    }
    default:
      return send(res, 404, 'not found');
  }
}

const server = http.createServer((req, res) => {
  // A POST may change what the mod's line shows (an event, a setting, a connection).
  if (req.method === 'POST') res.on('finish', () => summaryWatch.nudge());
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status === 500) log('request failed:', req.method, req.url, err.stack || err.message);
    else log(`request refused (${status}):`, req.method, req.url, err.message);
    if (!res.headersSent) send(res, status, status === 500 ? 'internal error' : { error: err.message });
    else res.end();
  });
});

// Pairing messages for the user (the mod shows them in Claude Code, the panel as a notice).
const pairNotices = [];
let noticeSeq = 0;
// about: what the mod shows for it ({ kind: 'paired', name, ... }), or nothing for a plain line.
function pairNotice(text, about) {
  const n = { id: ++noticeSeq, at: Date.now(), text, ...(about && typeof about === 'object' ? about : {}) };
  pairNotices.push(n);
  if (pairNotices.length > 20) pairNotices.shift();
  broadcastVolatile({ type: 'pair-notice', sessionId: null, ...n });
  summaryWatch.nudge(); // the line above the prompt shows it now, not after a waiting request ends
}

// This computer as the one others pair with: their page connections are sent to `server`.
const pairHost = new PairHost({
  onNotice: pairNotice,
  onRemoved: pairsRemoved,
  tasks: taskRequest,
  runsAllowed: () => currentSettings().remote_tasks !== false,
  answersAllowed: () => currentSettings().paired_answers === true,
  stateDir: config.stateDir,
  port: config.pairPort,
  httpServer: server,
  version: config.version,
  livePort: config.port,
  log,
  siteOf: (cwd) => {
    // A site of the paired folder or one inside it, never one serving a folder above it (Sol H1).
    const c = connector.list().find((x) => x.state === 'running' && x.url && within(x.cwd, cwd));
    return c ? c.url : null;
  },
});
// Computers this one joined: each gets local addresses for its site and live server.
// A link that reconnects (this server or that computer restarted) is followed again immediately.
const pairRemotes = new PairRemotes({ stateDir: config.stateDir, port: config.pairPort, log, onChange: (h, why) => {
  summaryWatch.nudge();
  // It started or stopped letting this computer answer its questions: its task cards say so now.
  if (why === 'answers' && h) {
    for (const f of remote.computers.values()) {
      if (f.name !== h.name && f.key !== computerKey(h.name)) continue;
      for (const [task, card] of f.cards) if (f.dirs.has(task)) remoteCard(f.name, task, f.dirs.get(task), card);
    }
  }
  if (h && h.state === 'connected') followPaired();
} });

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log(`port ${config.port} already in use; another EditLens server is probably running`);
    process.exit(0);
  }
  // The server can't listen (EACCES, EADDRNOTAVAIL): nothing to keep running.
  log(`cannot listen on ${config.host}:${config.port}: ${err.code || err.message}`);
  process.exit(1);
});

try {
  loadEditIndex();
} catch (err) {
  if (!(err && err.code)) throw err;
  log(`cannot list earlier edits: ${err.code}`);
}

// The values this server started with: a less strict one that Claude Code has not saved waits for the
// EditLens window, as from a report.
reportSettings(settingsState.startValues, settingsState.from);
delete settingsState.startValues;

server.listen(config.port, config.host, () => {
  // Write the token only after this server has the port, so hooks never read an old one.
  // Written to a temp file and renamed: a hook never reads an empty token mid-write.
  writeAtomic(config.tokenFile, token, { mode: 0o600 });
  log(`${PRODUCT_NAME} listening on ${config.baseUrl} (pid ${process.pid})`);
  loadKept();
  pairHost.sync().then((err) => err && log(`pairing: ${err}`), (err) => log(`pairing: ${err.message}`));
  pairRemotes.start().catch((err) => log(`paired computers: ${err.message}`));
});

// The server's own log (its stdout) is kept under 2 MB while it runs.
let logTrimDenied = false;
const logTrim = setInterval(() => {
  try {
    if (trimLog(config.logFile, 2 * LOG_MAX)) log('log trimmed');
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(err.code)) throw err;
    // Busy or removed: tried again in 10 minutes. Not allowed: said once.
    if ((err.code === 'EPERM' || err.code === 'EACCES') && !logTrimDenied) log(`the log can't be trimmed (${err.code})`);
    logTrimDenied = logTrimDenied || err.code === 'EPERM' || err.code === 'EACCES';
  }
}, 10 * 60000);
logTrim.unref();

// What an update must not interrupt. -> 'page control' | 'tasks' | null
// A newer EditLens installed than this server (a hook or an update told it): pages and the line in
// Claude Code say so until this server is replaced.
let installedVersion = null;
function noteInstalled(v) {
  if (typeof v !== 'string' || !newer(v, config.version) || v === installedVersion) return;
  installedVersion = v;
  log(`EditLens ${v} is installed; this server runs ${config.version}`);
  announceUpdate();
}
function announceUpdate() {
  if (installedVersion) broadcastVolatile({ type: 'update-waiting', sessionId: null, cwd: null, running: config.version, installed: installedVersion, busy: busyReason() });
}
function busyReason() {
  // Also while it starts: a waiting update must never end page control.
  if (driver.busy()) return 'page control';
  if (tasks.live().length) return 'tasks';
  return null;
}
let updateWaiting = false;

const heartbeat = setInterval(() => {
  for (const res of clients.keys()) push(res, ': ping\n\n');
  if (updateWaiting && !busyReason()) {
    log('the waiting update can start now: stopping');
    // Page control that ended moments ago without the user choosing it is turned on again in the new server.
    const rec = pagekeep.read(KEEP_FILE);
    if (rec && rec.end && rec.end.restore !== true && timeOf(rec.end.at) !== null && Date.now() - rec.end.at < 2 * 60000) {
      keepWrite({ ...rec, end: { ...rec.end, reason: 'update', text: `${rec.end.text} Then ${pagekeep.TEXT.update}`, restore: true } });
    }
    shutdown();
    return;
  }
  // A Stop hook that was interrupted (Esc in the terminal) stops polling; clear the indicator.
  if (listenState.active && waiters.size === 0 && Date.now() - listenState.lastWait > LISTEN_STALE_MS) setListen(false, 0);
  const idleMs = Date.now() - lastActivity;
  if (driver.status().active) keepOn(); // when it was last known to run, for the next server
  if (clients.size === 0 && idleMs > config.idleMinutes * 60000 && !driver.busy() && !connector.items.size && !pairHost.active() && !pairRemotes.size) {
    log('not in use, shutting down');
    shutdown();
  }
}, HEARTBEAT_MS);

function shutdown() {
  clearInterval(heartbeat);
  if (followSaveTimer) saveFollowNow();
  // Page control the user had on: the next server says why it stopped and starts it again.
  const st = driver.status();
  const reason = updateWaiting || installedVersion ? 'update' : 'restart';
  if (st.active) {
    keepWrite({ cwd: st.cwd, sessionId: st.sessionId || null, exe: driver.exePath(), version: config.version, pid: process.pid, aliveAt: Date.now(), end: { reason, text: pagekeep.TEXT[reason], at: Date.now() } });
    log(`page control stops for the ${reason}; the next server starts it again in ${st.cwd}`);
  }
  driver.stop('server shutting down', null, { by: 'shutdown', error: st.active ? pagekeep.TEXT[reason] : null });
  tasks.stopAll();
  connector.killAll();
  pairHost.close();
  pairRemotes.close().catch((err) => log(`paired computers: ${err.message}`));
  for (const s of sessions.values()) s.stop();
  for (const res of clients.keys()) res.end();
  summaryWatch.releaseAll(); // the mod's waiting requests: answered now, not after their wait
  server.close(() => process.exit(0));
  // Kept-alive connections too (Node 18 leaves them open): a client must not connect to this server
  // through one while it exits, or after a newer server took the port.
  server.closeAllConnections();
  // Pages keep connections open; do not wait on them forever.
  setTimeout(() => process.exit(0), 1000).unref();
}

// Handler for uncaught errors: a bug in one request or timer is logged; pages and page control keep running.
process.on('uncaughtException', (err) => log('unexpected error (still running):', err && err.stack ? err.stack : String(err)));
process.on('unhandledRejection', (err) => log('unexpected rejection (still running):', err && err.stack ? err.stack : String(err)));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
