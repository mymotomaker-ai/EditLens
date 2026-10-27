'use strict';
// Tasks from a paired computer: its Claude asks this computer's Claude to do something. Each
// task runs Claude here through the Agent SDK (like page control), in its own copy of the project
// (a git worktree) when the project uses git, in this computer's permission mode (never Bypass by
// default). Permission questions go to the people on the pages, never to the asking agent. A task
// keeps running after the link that started it closes; the asking computer checks it by its id.

const fs = require('fs');
const path = require('path');
const { sliceSafe } = require('../lib/textcut');
const { writeAtomic } = require('../lib/atomic');
const crypto = require('crypto');
const worktree = require('../lib/worktree');
const sendproject = require('../lib/sendproject');
const safepath = require('../lib/safepath');
const taskuser = require('../lib/taskuser');
const { sdkEntry, isRoot } = require('./driver');
const sdkerr = require('../lib/sdkerr');
const { EditFeed } = require('./editfeed');
const effortLib = require('../lib/effort');
const settingsLib = require('../lib/settings');

// Claude sessions running for tasks at once: the Tasks at once setting (limit(), lib/settings.js).
const MAX_WAITING = 8; // tasks waiting for a free session; more are refused
const REFUSED_KEPT_MS = 10 * 60000; // a refused start is shown this long (pages, the line in Claude Code)
const MAX_KEPT = 50;
const IDLE_CLOSE_MS = 30 * 60000; // a finished task's session closes after this; a follow-up resumes it
const PROMPT_MAX = 100000;
const REPLY_MAX = 20000; // one reply (whole files and diffs fit)
const REPLIES_KEPT = 30;
const CHECK_WAIT_MAX = 60; // seconds a "check" may wait for a change (the asker allows 2 minutes)
const BUSY = new Set(['waiting', 'starting', 'working']);
const REPORT_MAX = 800 * 1024; // a report's replies, under the pairing link's 1 MB response limit
const UPLOAD_MAX = 60 * 1024 * 1024; // one sent project, gzipped
const UPLOAD_MS = 10 * 60000;
const PAGE_MAX = 512 * 1024; // one page of a file from a task's workspace
const DIFF_PAGE = 60 * 1024; // one page of a task's diff
const DIFF_KEEP_MS = 15000; // the last big diff, kept for its next pages
const LIST_PAGE = 500; // files in one page of a listing
const LIST_KEEP_MS = 10000; // a project listing is kept this long after its last page, for the next page
const LISTINGS_KEPT = 20;
const SEARCH_MAX = 200; // matches in one search
const COPY_FILES_MAX = 5000; // files listed for a copy from this computer's project
const COPY_FILE_MAX = 20 * 1024 * 1024; // larger files are left out of such a copy
const HASH_PAGE_MAX = 64 * 1024 * 1024; // bytes hashed for one listing page or one hash request
const os = require('os');
const ACTIVITY_KEPT = 300; // tool steps kept per task (titles only)
const ACTIVITY_REPORT = 100; // tool steps in one report
const SAVE_SOON_MS = 1000; // tool steps save the task list at most this often
const SAVE_NOW_MS = 250; // other changes, gathered into one write
const EDITS_KEPT = 100; // a task's file edits kept for its card (live on both computers)
const KNOWN_TEXT_MAX = 256 * 1024; // a file's text kept to show what a command changed in it
const KNOWN_TOTAL = 8 * 1024 * 1024; // such texts per task, at most
const KNOWN_FILES = 2000;
const SCAN_FILE_MAX = 8 * 1024 * 1024; // larger files are not compared
const SCAN_FILES = 500; // files compared after a turn
const TURN_SCAN_WAIT_MS = 2000; // a turn waits at most this long for its start scan (Sol L11)
const COMMAND_EDITS_MAX = 100; // files shown from one turn
// Every edit here a paired computer may see (its tasks', and sessions in its paired project), in
// full, so its panel and code view show them live: kept by size (server/editfeed.js), each file's
// text up to FEED_TEXT_MAX, at most FEED_BUDGET of them per response (under the link's 1 MB).
const FEED_TEXT_MAX = 60 * 1024;
const FEED_BUDGET = 400 * 1024;
const FEED_FIRST_MS = 2 * 60000; // a computer that just started following gets the edits from this long ago
// Build output and installs in a sent project's workspace never count as the task's changes.
const WORKSPACE_EXCLUDE = ['node_modules/', 'dist/', 'build/', '.next/', '.nuxt/', '.svelte-kit/', '.turbo/', '.cache/', '.vite/', 'coverage/', '.parcel-cache/', '*.log'];
// Every task: the asker shows the result to a person, who needs to know where to look.
// Every message to a task's Claude says who wrote it: another computer's Claude, not a person.
const fromAgent = (by) => `[From the Claude on ${by}, not typed by a person here.]\n`;
const FINISH = '\n\n[EditLens: when you finish, end with the files you changed and where to see the result in the app (the page, route or address, for example #/admin).]';
// Appended to a task session's system prompt: who gives it work, and how to end each turn.
const taskNote = (by) => `You were given this task by the Claude on ${by} (another computer), not by a person at this computer. ` +
  `Its messages start with "[From the Claude on ${by}...]". A person can still answer your permission questions here. ` +
  'End every turn with these lines: "Done:" (what you did), "Changed files:", "Where to see it:" (page, route or address), "Checks run:" (command and result), "Open questions:".';

const sentNote = (by) => `You work in a copy of a project sent from ${by}. No page is open here, so run the project's checks yourself (its tests, build or lint). ` +
  'Read a file before you change it and make focused edits. Never remove EditLens lines (its Vite plugin, Next.js wrapper, Express middleware or script tag). ' +
  `Your changes are copied to the original project on ${by} only when its Claude applies them.`;

// A tool step as the asking computer sees it: the tool and a shortened path or command, never its
// input or output. Obvious secrets typed inline are masked.
function maskSecrets(s) {
  return String(s)
    .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PWD)[A-Z0-9_]*)=("[^"]*"|'[^']*'|\S+)/gi, '$1=***')
    .replace(/(--?(?:token|password|pass|secret|key|api-key|auth)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, '$1 ***');
}
function stepTitle(tool, input) {
  const i = input && typeof input === 'object' ? input : {};
  const what = tool === 'Bash' ? i.command : i.file_path || i.notebook_path || i.path || i.pattern || i.url || i.query || i.description || '';
  return clip(`${tool}${what ? ' ' + maskSecrets(String(what).replace(/\s+/g, ' ')) : ''}`, 160);
}
const GIT_ID = ['-c', 'user.name=EditLens', '-c', 'user.email=editlens@localhost', '-c', 'commit.gpgsign=false'];

const clip = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? sliceSafe(t, n - 1) + '…' : t;
};

function isInside(file, dir) {
  const r = path.relative(dir, file);
  return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r);
}

// A permission question as pages show it: what is asked, never the file text (diff, preview).
// The EditLens window, where it is answered, shows it all.
function pageQuestion(p) {
  return { id: p.id, tool: p.tool, title: p.title || null, detail: p.detail ? clip(p.detail, 300) : null, warning: p.warning || null, note: p.note || null, canAlways: Boolean(p.canAlways), ts: p.ts, agentId: p.agentId || null, agentKey: p.agentKey || null, agentMode: p.agentMode || null };
}

// Claude's text in one SDK message from the main agent, or ''.
function replyText(msg) {
  if (!msg || msg.type !== 'assistant' || msg.parent_tool_use_id) return '';
  const content = msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
}

// The replies that fit in one response (counted in bytes), oldest first; the rest come with the next check.
// A task's note for its card: the root sentence is left out, as the card's "root" tag says it.
function cardNote(note, root) {
  const text = note && root ? note.replace(root, '').trim() : note;
  return text || null;
}

function fitReplies(list) {
  let total = 0;
  const out = [];
  for (const r of list) {
    total += Buffer.byteLength(JSON.stringify(r));
    if (total > REPORT_MAX && out.length) break;
    out.push(r);
  }
  return out;
}

// The last finished turn's result. Its text is left out when it is the last reply (usually the
// case), so a long reply (a whole file) isn't sent twice.
function resultOf(t) {
  const r = t.result;
  if (!r) return null;
  const last = t.replies.length ? t.replies[t.replies.length - 1] : null;
  if (r.text && r.text === last) return { isError: r.isError, turns: r.turns, sameAsLastReply: true };
  return r;
}

// A git remote as the other computer may see it: only its scheme, host and path, never a user
// name, password or a token in its query or fragment (https://user:ghp_…@github.com/…, ?access_token=).
function publicRemote(url) {
  if (!url) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const u = new URL(url);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
      return null;
    }
  }
  // scp-like (git@github.com:me/app.git): host and path, without the user and anything after ? or #.
  return url.replace(/[?#].*$/s, '').replace(/^[^/]*@(?=[^@/:]+:)/, '') || null;
}

// relFile -> what was said about its last edit. Claude's own words take priority over a command scan's
// ("Changed by a command"), whichever came first.
function intentsByFile(edits) {
  const said = new Map();
  for (const e of (Array.isArray(edits) ? edits : []).filter((x) => x && x.intent)) {
    const had = said.get(e.relFile);
    if (!had || had.auto || !e.auto) said.set(e.relFile, e);
  }
  return new Map([...said].map(([k, e]) => [k, e.intent]));
}

// sha256 of a file (as sendproject.sha), read in chunks so the server keeps serving meanwhile.
// O_NOFOLLOW: a file swapped for a link after the listing is not read. fd: a file already open
// (closed here).
function hashFile(file, fd = null) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file, fd === null ? { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) } : { fd, autoClose: true })
      .on('error', reject)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')));
  });
}

// fn(item) for each item, at most n running at the same time.
async function eachLimit(items, n, fn) {
  let next = 0;
  const run = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
}

// An edited file's real name inside the task's folder or the paired project is one whose text is
// never sent. A file in a subagent's copy there is checked as the project's file (its
// ".claude/worktrees/<name>/" would otherwise count as the never-sent .claude folder).
function feedSecret(rel) {
  const own = worktree.withoutCopy(rel);
  return !own || sendproject.excluded(own);
}
function hideText(it) {
  it.before = null;
  it.after = null;
  it.hunks = [];
  it.secret = true;
}

const REPLACED = 'The task\'s workspace was replaced by another folder, so its files are not read.';

// One page of an open file, which is closed here. Size and type come from the opened file itself.
// -> { path, size, offset, data (base64), next } | { error }
function pageOf(fd, clean, offset) {
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: 'Not a file.' };
    const from = Math.max(0, Math.min(Number.isSafeInteger(offset) ? offset : 0, st.size));
    let buf = Buffer.alloc(Math.min(PAGE_MAX, st.size - from));
    buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, from));
    const len = buf.length;
    return { path: clean, size: st.size, offset: from, data: buf.toString('base64'), next: from + len < st.size ? from + len : null };
  } catch (err) {
    if (err && err.code) return { error: err.code };
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

// Up to max bytes of an open file, read without blocking the server. -> Promise<Buffer>
function readFd(fd, max) {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(max);
    let got = 0;
    const next = () => {
      if (got >= max) return resolve(buf);
      fs.read(fd, buf, got, max - got, got, (err, n) => {
        if (err) return reject(err);
        got += n;
        if (n === 0) return resolve(buf.subarray(0, got));
        next();
      });
    };
    next();
  });
}

// A workspace file name a task may show or send: plain (as cleanRel writes it, no control
// characters), not excluded, not Claude Code's own worktrees.
function shownName(n) {
  return typeof n === 'string' && sendproject.cleanRel(n) === n && !/[\x00-\x1f\x7f]/.test(n) && !sendproject.excluded(n) && !n.startsWith('.claude/worktrees/');
}

// The name in a part's "diff --git a/<n> b/<n>" line (no renames: both the same), or null when
// git quoted it or it doesn't read that way.
function headerName(part) {
  const line = part.slice(0, part.indexOf('\n') === -1 ? part.length : part.indexOf('\n'));
  const len = (line.length - 16) / 2;
  if (!line.startsWith('diff --git a/') || !Number.isSafeInteger(len) || len < 1) return null;
  const n = line.slice(13, 13 + len);
  return line === `diff --git a/${n} b/${n}` ? n : null;
}

// Hashes of the named files in the project at real (copy_from_computer asks for the files whose
// size matches one it has). A path that is not a plain file in the project gets null.
async function projectHashes(real, paths) {
  const shas = {};
  let budget = HASH_PAGE_MAX;
  for (const p of paths.slice(0, LIST_PAGE)) {
    const rel = typeof p === 'string' ? sendproject.cleanRel(p) : null;
    if (!rel || sendproject.excluded(rel) || Object.prototype.hasOwnProperty.call(shas, rel)) continue;
    shas[rel] = null;
    try {
      // No link anywhere in the path: a folder link (keys -> .ssh) can't lead to an excluded file.
      // Opened once that way and hashed from that descriptor (Sol M5).
      const at = safepath.openNoLinks(real, rel);
      if (at.error) continue;
      if (at.st.size > COPY_FILE_MAX || at.st.size > budget) {
        fs.closeSync(at.fd);
        continue;
      }
      budget -= at.st.size;
      shas[rel] = await hashFile(path.join(real, rel), at.fd); // the name is not opened again (fd is used)
    } catch (err) {
      // Missing or unreadable: null, so the other computer treats it as unknown.
      if (!err || !err.code) throw err;
    }
  }
  return shas;
}

// A workspace file the command-edit scan may read: a clean name, not excluded, not in .claude.
function scanAllowed(rel) {
  return Boolean(sendproject.cleanRel(rel)) && !sendproject.excluded(rel) && !rel.startsWith('.claude/');
}

class Tasks {
  // makeDriver(opts) -> a Driver (server/driver.js); emit(event): sends to pages (kept in the history);
  // claudePaths(): the claude programs known here; host: this computer's name.
  constructor({ stateDir, log, emit, makeDriver, claudePaths, host, onTurn, onTurnStart, account, rootTasks, defaultEffort, limit, onSlots, idleCloseMs, runsAllowed }) {
    // "Paired computers can run Claude here" in effect now: off, no task's Claude starts (Sol S2).
    this.runsAllowed = typeof runsAllowed === 'function' ? runsAllowed : () => true;
    // A finished task's session closes after this (tests give a shorter time).
    this.idleCloseMs = Number.isFinite(idleCloseMs) && idleCloseMs > 0 ? idleCloseMs : IDLE_CLOSE_MS;
    // The Tasks at once setting (checked here, so a bad value is 4).
    this.limit = typeof limit === 'function' ? limit : () => settingsLib.TASKS_DEFAULT;
    // ({ running, limit }) when the number running or the limit changes (pages show "N of M running").
    this.onSlots = onSlots || (() => {});
    this.lastSlots = '';
    // True while the user's Root (unsafe) choice is on (paired computers show a warning).
    this.rootTasks = rootTasks || (() => false);
    // The level a task in cwd starts at when its start gives none (this computer's setting; null:
    // Auto with none in Claude Code's settings, so Claude Code's own level).
    this.defaultEffort = defaultEffort || (() => effortLib.DEFAULT);
    this.stateDir = stateDir;
    this.file = path.join(stateDir, 'tasks.json');
    this.log = log || (() => {});
    this.emit = emit || (() => {});
    this.makeDriver = makeDriver;
    this.claudePaths = claudePaths || (() => []);
    this.host = host || 'this computer';
    this.onTurn = onTurn || (() => {}); // (task) after each finished turn: the copy card
    this.onTurnStart = onTurnStart || (() => {}); // (task) a turn starts; may return a promise
    this.scannedTurn = new WeakSet(); // tasks whose next "working" was scanned for already (beforeTurn)
    // The normal account sent projects' tasks run as (lib/taskuser.js), { error }, or null.
    this.account = account || (() => null);
    this.items = new Map();
    this.waiters = new Map(); // task id -> Set of resolve functions (waitChange)
    this.seq = Date.now(); // increases with every change; starts from the clock: a restart never decreases it
    this.pairWaiters = new Set(); // { pairId, done } for "watch-all"
    this.saveTimer = null;
    this.uploads = new Map(); // projects being sent: upload id -> { pairId, parts, size, at, timer }
    this.listings = new Map(); // listings kept for later pages: root + path -> { at, all, skipped, kind }
    this.pendingSent = 0; // sent projects between the start request and their task (roomForTask)
    this.queue = []; // { t, go }: tasks (or follow-ups) waiting for a free session, oldest first
    this.refusals = []; // { id, by, cwd, prompt, error, at, followUp }: starts that were refused (refuse)
    // Edits paired computers see live (pushEdit), kept by size and on disk (server/editfeed.js).
    this.feed = new EditFeed({ dir: path.join(stateDir, 'pair-edits'), log: this.log });
    this.feedSeq = Math.max(Date.now(), this.feed.last()); // from the clock, like seq
    this.load();
  }

  load() {
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (['EACCES', 'EPERM', 'EBUSY', 'EISDIR', 'ENOTDIR', 'EIO'].includes(err.code)) {
        this.log(`tasks: the task list can't be read (${err.code}); it is left as it is`);
        this.readOnly = true;
      } else if (!(err.code === 'ENOENT' || err instanceof SyntaxError)) {
        throw err;
      }
    }
    // A time that is not a number, or is in the future (an older or damaged list): the list's own time.
    let saved = Date.now();
    if (data) {
      try {
        saved = Math.min(saved, fs.statSync(this.file).mtimeMs);
      } catch (err) {
        if (!err || !err.code) throw err;
        // Removed or locked since it was read: the time now.
        if (err.code !== 'ENOENT') this.log(`tasks: the task list's time can't be read (${err.code}); using the time now`);
      }
    }
    const time = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= Date.now() + 60000 ? v : fallback);
    for (const t of (data && Array.isArray(data.tasks) ? data.tasks : [])) {
      if (!t || !/^[0-9a-f]{12}$/.test(t.id) || typeof t.cwd !== 'string' || typeof t.dir !== 'string') continue;
      t.updatedAt = time(t.updatedAt, saved);
      t.startedAt = time(t.startedAt, t.updatedAt);
      // This computer (or EditLens) restarted: its Claude sessions are gone; a follow-up resumes them.
      const live = ['starting', 'working', 'idle'].includes(t.state);
      // It waited for a free session: the wait is gone with the restart.
      if (t.state === 'waiting') {
        t.state = 'ended';
        t.note = `EditLens on ${this.host} restarted while this task waited for a free session, so it did not start. Start it again (or send the follow-up again).`;
      }
      const replies = Array.isArray(t.replies) ? t.replies.filter((r) => typeof r === 'string') : [];
      // Saved before 0.22.3 (no count), or a count that doesn't fit: the kept replies are all there is.
      const replyCount = Number.isInteger(t.replyCount) && t.replyCount >= replies.length ? t.replyCount : replies.length;
      const edits = Array.isArray(t.edits) ? t.edits.filter((e) => e && typeof e.relFile === 'string').slice(-EDITS_KEPT) : [];
      const activity = Array.isArray(t.activity) ? t.activity.filter((a) => a && typeof a.title === 'string').slice(-ACTIVITY_KEPT) : [];
      const effort = t.effort && typeof t.effort === 'object' && effortLib.isLevel(t.effort.level) ? { level: t.effort.level, used: null, supported: null, cap: null } : null;
      // The workspace's identity as saved; a list from before 0.24.46 has none (dirIdOf takes it now).
      const was = t.dirId;
      t.dirId = was && typeof was === 'object' && /^\d{1,30}$/.test(was.dev) && /^\d{1,30}$/.test(was.ino) ? { dev: was.dev, ino: was.ino } : null;
      this.items.set(t.id, { ...t, asRoot: t.asRoot === 'root' || t.asRoot === 'unsafe' ? t.asRoot : null, effort, activity, activityCount: Number.isInteger(t.activityCount) && t.activityCount >= activity.length ? t.activityCount : activity.length, edits, editCount: Number.isInteger(t.editCount) && t.editCount >= edits.length ? t.editCount : edits.length, replies, replyCount, permissions: new Map(), driver: null, timer: null, state: live ? 'ended' : t.state, note: live ? `EditLens on ${this.host} restarted (an update, or Claude Code restarted there), so this task's Claude stopped. Send a follow-up to continue it.` : t.note || null });
      this.dirIdOf(this.items.get(t.id));
    }
  }

  save() {
    if (this.readOnly) return;
    const list = [...this.items.values()].slice(-MAX_KEPT).map((t) => ({
      id: t.id, by: t.by, pairId: t.pairId, cwd: t.cwd, dir: t.dir, dirId: t.dirId || null, copy: t.copy, root: t.root, prompt: t.prompt, state: t.state, error: t.error || null,
      note: t.note || null, kind: t.kind || null, model: t.model || null, mode: t.mode || null, base: t.base || null, account: t.account || null, sessionId: t.sessionId || null, startedAt: t.startedAt, updatedAt: t.updatedAt, result: t.result || null, replies: t.replies.slice(-5), replyCount: t.replyCount || 0,
      edits: (t.edits || []).slice(-30), editCount: t.editCount || 0, activity: (t.activity || []).slice(-50), activityCount: t.activityCount || 0, stats: t.stats || null,
      effort: t.effort && effortLib.isLevel(t.effort.level) ? { level: t.effort.level } : null, asRoot: t.asRoot || null,
    }));
    const text = JSON.stringify({ tasks: list });
    if (text === this.savedText) return; // nothing new to write
    try {
      writeAtomic(this.file, text, { mode: 0o600 });
      this.savedText = text;
    } catch (err) {
      if (!err.code) throw err;
      this.log(`tasks: could not save (${err.code})`);
    }
  }

  // Running or starting (a start reserves its place before its first await).
  live() {
    return [...this.items.values()].filter((t) => t.driver || t.starting || t.reserved);
  }

  // Tasks at once, as the setting says now. A change applies to the next task that starts:
  // running tasks are never stopped by it.
  maxLive() {
    return settingsLib.taskLimit(this.limit());
  }

  // Tasks working, asking, or starting (a finished task's open session doesn't count: it closes
  // to stay within the limit). -> { running, limit }, for "2 of 4 running".
  slots() {
    const busy = this.live().filter((t) => !(t.driver && !t.starting && t.state === 'idle' && !t.permissions.size)).length;
    return { running: busy + this.pendingSent, limit: this.maxLive() };
  }

  // Pages and paired computers are told of a change in slots(): a task started or finished, or the
  // setting changed (then waiting tasks may start now).
  slotsChanged() {
    const now = this.slots();
    const key = `${now.running}/${now.limit}`;
    if (key === this.lastSlots) return;
    this.lastSlots = key;
    this.onSlots(now);
    this.wakeAll();
  }

  // The Tasks at once setting changed: waiting tasks start if the running-task limit allows it now.
  limitChanged() {
    this.drainSoon();
    this.slotsChanged();
  }

  // Whether one more Claude session may start. A finished task keeps its session open for a follow-up
  // (IDLE_CLOSE_MS), so before a new task is refused the oldest finished ones close: a
  // follow-up resumes them. False only when "Tasks at once" tasks are really working (or asking).
  roomForTask() {
    for (;;) {
      if (this.live().length + this.pendingSent < this.maxLive()) return true;
      const idle = this.live().filter((t) => t.driver && !t.starting && t.state === 'idle' && !t.permissions.size)
        .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))[0];
      if (!idle) return false;
      this.log(`task ${idle.id}: its finished session closed to stay within the limit, so a new task can start`);
      idle.note = 'Its Claude session closed to stay within the limit, so a new task can start. A follow-up continues it.';
      this.close(idle, 'idle');
    }
  }

  // Why a task waits, for its card and the line in Claude Code.
  waitNote() {
    return `Waiting · ${this.host} is running ${this.runningWords()}. It starts when one of them finishes.`;
  }

  // "4 tasks", "1 task": the Tasks at once setting, in words.
  runningWords() {
    const n = this.maxLive();
    return `${n} ${n === 1 ? 'task' : 'tasks'}`;
  }

  // A start (or follow-up) the asking computer's Claude asked for and that did not start: the
  // pages here and the line in Claude Code show it, not only the agent that asked.
  // -> the card it sent
  refuse(pair, prompt, error, { task = null } = {}) {
    const r = {
      id: crypto.randomBytes(6).toString('hex'), by: pair ? pair.name : 'Paired computer', cwd: pair ? pair.cwd : null, pairId: pair ? pair.id : null,
      prompt: clip(typeof prompt === 'string' ? prompt.trim() : '', 600), error: clip(String(error || ''), 600), at: Date.now(), followUp: Boolean(task), task,
    };
    this.refusals.push(r);
    this.refusals = this.refusals.filter((x) => Date.now() - x.at < REFUSED_KEPT_MS).slice(-10);
    this.log(`task ${task ? `${task} follow-up` : 'start'} from ${r.by} refused: ${r.error}`);
    const card = { type: 'task', taskId: `r${r.id}`, by: r.by, cwd: r.cwd, prompt: r.prompt, state: 'refused', error: r.error, startedAt: r.at, ts: r.at,
      followUp: r.followUp, permissions: [], edits: [], editCount: 0, lastReply: '' };
    this.emit(card);
    return card;
  }

  // What the line in Claude Code and Details show about tasks here: waiting ones, and starts that
  // were refused or failed before Claude replied (last 10 minutes). cwd: that project only.
  // -> [{ where: 'here', computer, state: 'waiting' | 'refused', short, text, prompt, at }]
  notices(cwd, matches) {
    const out = [];
    const fits = (dir) => !cwd || (dir && matches(dir, cwd));
    for (const t of this.items.values()) {
      if (!fits(t.cwd)) continue;
      if (t.state === 'waiting') out.push({ where: 'here', computer: t.by, state: 'waiting', short: `Task from ◆ ${t.by} waiting`, text: `${t.note || this.waitNote()} (${clip(t.prompt, 80)})`, prompt: clip(t.prompt, 120), at: t.updatedAt });
      else if (t.state === 'failed' && !(t.replyCount > 0) && Date.now() - (t.updatedAt || 0) < REFUSED_KEPT_MS) {
        out.push({ where: 'here', computer: t.by, state: 'refused', short: `Task from ◆ ${t.by} didn't start`, text: `Didn't start · ${t.error || 'unknown error'}`, prompt: clip(t.prompt, 120), at: t.updatedAt });
      }
    }
    for (const r of this.refusals) {
      if (Date.now() - r.at >= REFUSED_KEPT_MS || !fits(r.cwd)) continue;
      out.push({ where: 'here', computer: r.by, state: 'refused', short: `${r.followUp ? 'Follow-up' : 'Task'} from ◆ ${r.by} didn't start`, text: `Didn't start · ${r.error}`, prompt: r.prompt, at: r.at });
    }
    return out.sort((a, b) => b.at - a.at);
  }

  // Why a paired computer's work does not run here: the setting is off.
  runsOff() {
    return `Running Claude from paired computers is turned off on ◆ ${this.host} ("Paired computers can run Claude here" in /config on ◆ ${this.host}).`;
  }

  // Waiting tasks start as sessions become free, oldest first.
  drainSoon() {
    if (this.draining || !this.queue.length) return;
    this.draining = true;
    setImmediate(() => {
      this.draining = false;
      this.drain();
    });
  }

  drain() {
    // The setting was turned off while they waited: none starts, and each one fails saying why, as a
    // start that fails does (Sol S2).
    if (!this.runsAllowed()) {
      for (const { t } of this.queue.splice(0)) if (t.state === 'waiting') this.fail(t, this.runsOff());
      return;
    }
    while (this.queue.length && this.roomForTask()) {
      const entry = this.queue.shift();
      const t = entry.t;
      if (t.state !== 'waiting') continue; // stopped while it waited
      // Counted as running from now (live()), while its project is unpacked or its copy made.
      t.reserved = true;
      t.note = null;
      this.log(`task ${t.id}: a session is free, starting`);
      Promise.resolve().then(entry.go).then((out) => {
        if (out && out.error && t.state !== 'failed') this.fail(t, out.error);
      }, (err) => {
        this.log(`task ${t.id}: could not start (${err.stack || err.message})`);
        this.fail(t, `Could not start: ${err.message}`);
      }).finally(() => {
        t.reserved = false;
        this.drainSoon();
      });
    }
  }

  // Keeps t waiting for a free session; go() starts it then (-> { ok } | { error }).
  // -> null, or { error } when too many already wait
  wait(t, go) {
    if (this.queue.filter((e) => e.t.state === 'waiting').length >= MAX_WAITING) {
      return { error: `${this.host} is running ${this.runningWords()} and ${MAX_WAITING} more are waiting. Wait for some to finish, or stop one.` };
    }
    t.state = 'waiting';
    t.note = this.waitNote();
    this.queue.push({ t, go });
    this.log(`task ${t.id} from ${t.by}: waiting for a free session (${this.queue.length} waiting)`);
    this.changed(t);
    return null;
  }

  // What pages show (the panel's task card).
  card(t) {
    return {
      type: 'task', taskId: t.id, by: t.by, cwd: t.cwd, file: t.dir, workspace: t.copy, prompt: clip(t.prompt, 600), state: t.state,
      // The root sentence is the card's "root" tag (asRoot), not a paragraph.
      error: t.error || null, note: cardNote(t.note, this.rootNote(t.asRoot, t.kind !== 'sent')), startedAt: t.startedAt, ts: t.updatedAt,
      asRoot: t.asRoot || null, step: this.stepOf(t),
      lastReply: clip(t.replies.length ? t.replies[t.replies.length - 1] : '', 600), permissions: [...t.permissions.values()].map(pageQuestion),
      kind: t.kind || (t.copy ? 'copy' : 'shared'), edits: (t.edits || []).slice(-20), editCount: t.editCount || 0, effort: this.effortOf(t),
      // For the agent details card: what its Claude runs with.
      model: t.model || null, mode: t.mode || null,
      // For the Sessions list: how many run here ("2 of 4 running"), and what continues it in
      // Claude Code there (cd "<file>" && claude --resume <sessionId>; as <account> when set).
      slots: this.slots(), sessionId: t.sessionId || null, account: t.account || null,
    };
  }

  // Why a task runs as root, for the asking agent (asRoot: 'root' | 'unsafe' | null). shared: a task
  // in the paired project, which runs as the account EditLens runs as. -> text | null
  rootNote(asRoot, shared = false) {
    if (asRoot === 'unsafe') return `This task runs as ROOT on ${this.host}: the user turned on Root (unsafe) there.`;
    if (asRoot === 'root' && shared) return `This task runs as root on ${this.host}: tasks in the paired project run as the account EditLens runs as there.`;
    if (asRoot === 'root') return `This task runs as root on ${this.host}. For a normal account instead, the user types /editlens task-user in Claude Code on ${this.host} (once).`;
    return null;
  }

  // The task's current tool step ("Edit src/a.js", "Bash npm test"), for the card's Now line;
  // null unless its Claude is working.
  stepOf(t) {
    const last = (t.state === 'starting' || t.state === 'working') && Array.isArray(t.activity) && t.activity.length ? t.activity[t.activity.length - 1] : null;
    return last && typeof last.title === 'string' ? last.title : null;
  }

  // The task's effort (lib/effort.js shape), or null for a task from before 0.24.34.
  effortOf(t) {
    return t.effort && effortLib.isLevel(t.effort.level) ? effortLib.shape({ ...t.effort, source: 'page' }) : null;
  }

  // From a task card (here, or on the asking computer through the pairing link): applies from the
  // task's next step when its Claude runs, else from its next follow-up. Only one of the five
  // levels, as its own field. -> { ok, task, effort } | { error }
  async setEffort(t, level) {
    if (!effortLib.isLevel(level)) return { error: effortLib.BAD_LEVEL };
    if (['ended', 'stopped', 'failed', 'refused'].includes(t.state) && !t.driver) {
      t.effort = { ...(t.effort || {}), level, used: null, supported: null, cap: null };
      this.changed(t);
      return { ok: true, task: t.id, effort: this.effortOf(t) };
    }
    const was = t.effort;
    t.effort = { ...(t.effort || { used: null, supported: null, cap: null }), level };
    if (t.driver && t.driver.busy()) {
      const out = await t.driver.setEffort(level);
      if (out.error) {
        t.effort = was;
        this.changed(t);
        return { error: out.error };
      }
      if (out.effort) t.effort = { ...out.effort };
    }
    this.log(`task ${t.id}: effort ${level}`);
    this.changed(t);
    return { ok: true, task: t.id, effort: this.effortOf(t) };
  }

  // The task whose Claude made this edit (its session, or a file in its own workspace), or null.
  taskOfEdit(sessionId, file) {
    for (const t of this.items.values()) {
      if (sessionId && t.sessionId === sessionId) return t;
      if (typeof file === 'string' && t.dir !== t.cwd && isInside(file, t.dir)) return t;
    }
    return null;
  }

  // A task's folder or session: its git copy, its workspace, or the folder or session of a task here.
  owns(cwd, sessionId) {
    const copy = worktree.copyOf(cwd);
    if (copy && copy.name.startsWith('editlens-task-')) return true;
    const spaces = path.join(this.stateDir, 'workspaces');
    if (typeof cwd === 'string' && (path.resolve(cwd) === spaces || isInside(cwd, spaces))) return true;
    for (const t of this.items.values()) {
      if (sessionId && t.sessionId === sessionId) return true;
      if (typeof cwd === 'string' && t.dir && t.dir !== t.cwd && (path.resolve(cwd) === path.resolve(t.dir) || isInside(cwd, t.dir))) return true;
    }
    return false;
  }

  // One file edit by the task's Claude: on its card, live (here and on the asking computer).
  noteEdit(t, file, ev) {
    // A file in a subagent's copy inside the task's folder is named as in the project.
    const rel = worktree.projectRel(t.dir, file);
    if (!rel) return;
    const stats = ev.stats && typeof ev.stats === 'object' ? ev.stats : {};
    // null: not known (no counts came with the edit), so the cards never say "0 lines" for it.
    const num = (n) => (n !== null && n !== undefined && n !== '' && Number.isFinite(Number(n)) && Number(n) >= 0 ? Number(n) : null);
    t.edits = (t.edits || []).concat({
      relFile: rel, intent: clip(ev.intent || '', 200), added: num(stats.added), removed: num(stats.removed),
      created: Boolean(ev.created), deleted: Boolean(ev.deleted), auto: Boolean(ev.autoIntent), ts: Date.now(),
    }).slice(-EDITS_KEPT);
    t.editCount = (t.editCount || 0) + 1;
    this.changed(t);
  }

  // The asking computer's panel follows the task: its card at each change (long poll).
  // since: the updatedAt it has. -> { card, updatedAt }
  async watch(t, since, wait) {
    const ms = Math.min(CHECK_WAIT_MAX, Math.max(0, Number.isFinite(wait) ? wait : 0)) * 1000;
    if (ms && Number.isFinite(since) && since >= t.updatedAt) await this.waitChange(t, ms);
    return { card: this.card(t), updatedAt: t.updatedAt, computer: this.host };
  }

  // What the asking agent gets. since: replies already seen.
  report(t, since = 0, activitySince = null) {
    const from = Math.max(0, Math.min(Number.isInteger(since) ? since : 0, t.replyCount || 0));
    const skip = Math.max(0, (t.replyCount || 0) - t.replies.length); // replies no longer kept
    const replies = fitReplies(t.replies.slice(Math.max(0, from - skip)));
    const shown = Math.max(from, skip) + replies.length;
    return {
      task: t.id, computer: this.host, state: t.state, error: t.error || null, note: t.note || null, effort: this.effortOf(t),
      model: t.model || null, mode: t.mode || null,
      workspace: t.kind === 'sent' ? { sentFrom: t.by, folder: t.dir } : t.copy ? { name: t.copy, folder: t.dir } : { shared: true, folder: t.dir },
      prompt: clip(t.prompt, 300), startedAt: t.startedAt, updatedAt: t.updatedAt,
      replies, replyCount: t.replyCount || 0, result: resultOf(t),
      filesEdited: t.edits && t.edits.length ? [...new Set(t.edits.map((e) => e.relFile))].slice(-50) : undefined,
      ...this.activityOf(t, activitySince),
      stats: t.stats || undefined,
      moreReplies: shown < (t.replyCount || 0) ? `More replies: check again with since=${shown}.` : undefined,
      waitingForPermission: [...t.permissions.values()].map((p) => ({ tool: p.tool, title: p.title || null, detail: p.detail || null })),
    };
  }

  // light: only a tool step (the task list is saved a moment later, not now).
  changed(t, light = false) {
    t.updatedAt = Date.now();
    this.seq = Math.max(this.seq + 1, Date.now());
    t.seq = this.seq;
    this.saveSoon(light ? SAVE_SOON_MS : SAVE_NOW_MS);
    this.emit(this.card(t));
    for (const w of [...this.pairWaiters]) {
      if (w.pairId === t.pairId) {
        this.pairWaiters.delete(w);
        w.done(true);
      }
    }
    const waiting = this.waiters.get(t.id);
    if (waiting) {
      this.waiters.delete(t.id);
      for (const done of waiting) done(true);
    }
    // A session may be free now (a task finished, failed or stopped): a waiting one starts.
    if (this.queue.length && t.state !== 'waiting' && !BUSY.has(t.state)) this.drainSoon();
    this.slotsChanged();
  }

  // Many changes one after another (replies, steps) make one write: a state change within SAVE_NOW_MS,
  // a tool step within SAVE_SOON_MS.
  saveSoon(ms = SAVE_SOON_MS) {
    const due = Date.now() + ms;
    if (this.saveTimer && this.saveDue <= due) return;
    clearTimeout(this.saveTimer);
    this.saveDue = due;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, ms);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  // Paired computers' "watch-all" requests respond now (something they show changed, like the root warning).
  wakeAll() {
    for (const w of [...this.pairWaiters]) {
      this.pairWaiters.delete(w);
      w.done(true);
    }
  }

  // One edit for paired computers' panels. item: { kind: 'task' | 'session', task?, pairId?, file,
  // dir (what rel is relative to: the task's folder, or null for a session), tool, intent, stats,
  // created, deleted, hunks, truncated, before, after, ts }
  pushEdit(item) {
    this.feedSeq = Math.max(this.feedSeq + 1, Date.now());
    const it = { ...item, fseq: this.feedSeq };
    // Kept by where the file really is now (a folder link on its path resolved), so a link removed
    // later can't make it look like a file of the project; editsFor checks it again (Sol 0.24.45 H2).
    const real = typeof it.file === 'string' && path.isAbsolute(it.file) ? safepath.resolve(it.file) : { error: 'outside' };
    if (!real.error) it.file = real.file;
    // Secrets are never sent through the link; a huge file is sent as its changed lines only. A
    // session's file is checked against each paired project when it is sent (editsFor).
    const at = it.dir ? safepath.fileIn(it.dir, it.file) : null;
    if (real.error || (at && (at.error || feedSecret(at.rel))) || sendproject.excluded(path.basename(it.file))) hideText(it);
    for (const k of ['before', 'after']) if (typeof it[k] === 'string' && it[k].length > FEED_TEXT_MAX) it.before = it.after = null;
    this.feed.push(it);
    for (const w of [...this.pairWaiters]) {
      this.pairWaiters.delete(w);
      w.done(true);
    }
  }

  // The edits this pairing may see after since (0: the last couple of minutes), within the size limit.
  // -> { edits, editSeq, lost? } (lost: { count, more }: edits after since no longer kept)
  editsFor(pair, since) {
    const from = Number.isSafeInteger(since) && since > 0 && since <= this.feedSeq ? since : 0;
    const oldest = from ? 0 : Date.now() - FEED_FIRST_MS;
    const edits = [];
    let size = 0;
    let last = from || this.feedSeq;
    const outside = new Set(); // folders already named in this response
    for (const it of this.feed.items()) {
      if (it.fseq <= from || (oldest && it.ts < oldest)) continue;
      // Where the file really is now: inside the task's folder, or inside the paired project, with
      // the exclusions checked on that name. A task's file outside its folder is never sent.
      let at = null;
      if (it.kind === 'task') {
        if (it.pairId !== pair.id) continue;
        at = safepath.fileIn(it.dir, it.file);
        // The task's folder is gone (removed after the task): the name as checked when it was kept.
        if (at.error === 'ENOENT' && isInside(it.file, it.dir)) at = { rel: path.relative(it.dir, it.file).split(path.sep).join('/') };
        if (at.error) {
          last = it.fseq;
          continue;
        }
      } else {
        at = safepath.fileIn(pair.cwd, it.file);
        if (at.error) {
          // A session here working in another folder: its edits stay here, but the paired computer
          // is told where it works (the folder only, never a file or its text), once per response.
          const where = typeof it.sessionCwd === 'string' && it.sessionCwd && !isInside(it.sessionCwd, pair.cwd) ? it.sessionCwd : null;
          if (where && !outside.has(where)) {
            outside.add(where);
            edits.push({ kind: 'session', outside: true, cwd: where, pairCwd: pair.cwd, ts: it.ts, fseq: it.fseq });
          }
          last = it.fseq;
          continue;
        }
      }
      const { pairId, dir, ...out } = it;
      if (feedSecret(at.rel)) hideText(out);
      // The file as the project names it, never a subagent copy's ".claude/worktrees/<name>/" path.
      out.rel = worktree.withoutCopy(at.rel);
      const n = Buffer.byteLength(JSON.stringify(out));
      if (edits.length && size + n > FEED_BUDGET) break;
      size += n;
      edits.push(out);
      last = it.fseq;
    }
    // Its edits that were removed (offline longer than the feed keeps them): its page says how many.
    const lost = this.feed.lost(from, (d) => (d.kind === 'task' ? d.pairId === pair.id : typeof d.file === 'string' && isInside(d.file, pair.cwd)));
    return { edits, editSeq: edits.length ? last : this.feedSeq, ...(lost ? { lost } : {}) };
  }

  // The asking computer keeps every task it started current with one request per change:
  // responds immediately when a task of this pairing changed after since, else at the next change or
  // after wait seconds. -> { computer, seq, tasks: [summary + card] } (only the changed ones)
  // editsSince (newer computers): also the edits it may see (editsFor), and waits for those too.
  async watchAll(pair, since, wait, editsSince) {
    const after = Number.isSafeInteger(since) && since > 0 ? since : 0;
    // A since ahead of this computer's numbering (its clock went back): everything.
    const from = after > this.seq ? 0 : after;
    const changedSince = () => [...this.items.values()].filter((x) => x.pairId === pair.id && (x.seq || 0) > from);
    let list = changedSince();
    const wantsEdits = Number.isSafeInteger(editsSince) && editsSince >= 0;
    let feed = wantsEdits ? this.editsFor(pair, editsSince) : null;
    const ms = Math.min(CHECK_WAIT_MAX, Math.max(0, Number.isFinite(wait) ? wait : 0)) * 1000;
    if (!list.length && !(feed && feed.edits.length) && ms) {
      await new Promise((resolve) => {
        const w = { pairId: pair.id, done: null };
        const timer = setTimeout(() => {
          this.pairWaiters.delete(w);
          resolve(false);
        }, ms);
        w.done = (v) => {
          clearTimeout(timer);
          resolve(v);
        };
        this.pairWaiters.add(w);
      });
      list = changedSince();
      if (wantsEdits) feed = this.editsFor(pair, editsSince);
    }
    // Each card is small (reply text cut to 600 characters, 20 edits), so 50 of them fit in one line.
    return { computer: this.host, seq: this.seq, tasks: list.slice(-50).map((x) => ({ ...this.summary(x), card: this.card(x) })), ...(feed || {}), rootTasks: this.rootTasks(), slots: this.slots() };
  }

  // The tool steps after activitySince (the count the asker has seen), the last 100.
  activityOf(t, activitySince) {
    const count = t.activityCount || 0;
    const list = t.activity || [];
    if (!count) return {};
    const from = Number.isSafeInteger(activitySince) && activitySince >= 0 ? Math.min(activitySince, count) : Math.max(0, count - 20);
    const skip = count - list.length; // steps no longer kept
    const fresh = list.slice(Math.max(0, from - skip));
    const shown = fresh.slice(-ACTIVITY_REPORT);
    return {
      activity: shown.length ? shown.map((a) => `${a.agent === 'main' ? '' : '[subagent] '}${a.title}`) : undefined,
      activityCount: count,
      moreActivity: fresh.length > shown.length ? `${fresh.length - shown.length} earlier steps not shown.` : undefined,
    };
  }

  // A task in one line, for lists and waits.
  summary(t) {
    return {
      task: t.id, state: t.state, seq: t.seq || 0, waiting: t.permissions.size, replyCount: t.replyCount || 0, activityCount: t.activityCount || 0,
      editCount: t.editCount || 0, prompt: clip(t.prompt, 120), updatedAt: t.updatedAt, error: t.error || null, effort: this.effortOf(t),
      startedAt: t.startedAt || null, kind: t.kind || (t.copy ? 'copy' : 'shared'), model: t.model || null, mode: t.mode || null,
      // The Sessions list on the asking computer: the command that continues it here.
      sessionId: t.sessionId || null, dir: t.dir || null, account: t.account || null,
    };
  }

  // Resolves true at the task's next change, false after ms: a long-poll for "check", so the asking
  // computer makes one request per change instead of one every 2 seconds.
  waitChange(t, ms) {
    return new Promise((resolve) => {
      let set = this.waiters.get(t.id);
      if (!set) this.waiters.set(t.id, (set = new Set()));
      const timer = setTimeout(() => {
        set.delete(done);
        if (!set.size && this.waiters.get(t.id) === set) this.waiters.delete(t.id);
        resolve(false);
      }, ms);
      function done(v) {
        clearTimeout(timer);
        resolve(v);
      }
      set.add(done);
    });
  }

  // "check" with wait (seconds, at most CHECK_WAIT_MAX): responds immediately when the task is done or a
  // question waits, else at its next change or when the wait ends.
  async check(t, since, wait, activitySince = null) {
    const ms = Math.min(CHECK_WAIT_MAX, Math.max(0, Number.isFinite(wait) ? wait : 0)) * 1000;
    if (ms && BUSY.has(t.state) && !t.permissions.size) await this.waitChange(t, ms);
    return this.report(t, since, activitySince);
  }

  mine(pair, id) {
    const t = this.items.get(String(id || ''));
    return t && t.pairId === pair.id ? t : null;
  }

  list(pair) {
    return [...this.items.values()].filter((t) => t.pairId === pair.id).map((t) => ({ task: t.id, state: t.state, prompt: clip(t.prompt, 120), updatedAt: t.updatedAt, workspace: t.copy || null,
      model: t.model || null, mode: t.mode || null }));
  }

  // -> report | { error }. A start that is refused (no task kept) is shown on the pages here too.
  async start(pair, body) {
    const ctx = { task: null };
    const out = await this.startTask(pair, body, ctx);
    if (out && out.error && !ctx.task) this.refuse(pair, body && body.prompt, out.error);
    return out;
  }

  // effort: one of the five levels (lib/effort.js), given by the asking computer as its own field,
  // never read from the prompt; none: this computer's setting.
  async startTask(pair, { prompt, upload, effort }, ctx) {
    const text = typeof prompt === 'string' ? prompt.trim() : '';
    if (effort !== undefined && effort !== null && !effortLib.isLevel(effort)) return { error: effortLib.BAD_LEVEL };
    ctx.level = effortLib.isLevel(effort) ? effort : this.defaultEffort(pair.cwd);
    if (!effortLib.isLevel(ctx.level)) ctx.level = null;
    if (!text) return { error: 'Give the task: what Claude should do.' };
    if (text.length > PROMPT_MAX) return { error: `The task is too long (over ${PROMPT_MAX} characters).` };
    if (!fs.existsSync(pair.cwd)) return { error: `The project folder ${pair.cwd} no longer exists on ${this.host}.` };
    if (!sdkEntry(this.stateDir)) return { error: `Claude can't take tasks on ${this.host} yet: it needs the Claude Agent SDK there. Ask the user to type /editlens control ${this.host} once on this computer (or /editlens control on ${this.host}); that installs it.` };
    const id = crypto.randomBytes(6).toString('hex');
    // No free session: the task waits for one (its card says so here and on the asking computer).
    if (!this.roomForTask()) return this.startLater(pair, id, text, upload, ctx);
    if (upload) {
      // Counted until its task is kept (receiving and unpacking take a while), so several sent at
      // the same time can't all pass the check above.
      this.pendingSent++;
      const slot = { held: true };
      const release = () => {
        if (!slot.held) return;
        slot.held = false;
        this.pendingSent--;
      };
      try {
        return await this.startSent(pair, id, text, upload, release, ctx);
      } finally {
        release();
      }
    }
    return this.startShared(pair, id, text, ctx);
  }

  // The task is kept now, as waiting, and starts when a session is free (drain).
  startLater(pair, id, text, upload, ctx) {
    let u = null;
    if (upload) {
      // The project is removed from the uploads (they expire) and kept with the waiting task.
      u = this.uploads.get(String(upload));
      if (!u || u.pairId !== pair.id) return { error: 'The project was not received (or the upload expired). Start the task again.' };
      this.dropUpload(String(upload));
    }
    if (this.queue.filter((e) => e.t.state === 'waiting').length >= MAX_WAITING) {
      return { error: `${this.host} is running ${this.runningWords()} and ${MAX_WAITING} more are waiting. Wait for some to finish, or stop one.` };
    }
    const t = {
      id, by: pair.name, pairId: pair.id, cwd: pair.cwd, dir: u ? path.join(this.stateDir, 'workspaces', id) : pair.cwd, copy: null, root: null, kind: u ? 'sent' : null,
      prompt: text, state: 'waiting', replies: [], replyCount: 0, permissions: new Map(), startedAt: Date.now(), updatedAt: Date.now(), note: this.waitNote(),
      effort: { level: ctx.level, used: null, supported: null, cap: null },
    };
    this.keep(t);
    ctx.task = t;
    this.wait(t, () => (u
      ? this.startSent(pair, id, text, null, () => {}, { task: t, level: ctx.level }, u, t)
      : this.startShared(pair, id, text, { task: t, level: ctx.level }, t)));
    return this.report(t);
  }

  // A task in the paired project (its own git worktree when it can have one). waiting: the task
  // that waited for a free session, filled in here.
  async startShared(pair, id, text, ctx, waiting = null) {
    let ws = null;
    if (worktree.canCopy(pair.cwd)) {
      ws = worktree.create(pair.cwd, `editlens-task-${id}`);
      if (ws.error) return { error: `Could not make a workspace for the task: ${ws.error}` };
    }
    const fields = {
      id, by: pair.name, pairId: pair.id, cwd: pair.cwd, dir: ws ? ws.cwd : pair.cwd, copy: ws ? ws.name : null, root: ws ? ws.root : null,
      dirId: ws ? safepath.folderId(ws.cwd) : null, prompt: text, state: 'starting', replies: [], replyCount: 0, permissions: new Map(), startedAt: Date.now(), updatedAt: Date.now(),
      // A task that waited keeps the level it has now (its card may have changed it meanwhile).
      effort: waiting && waiting.effort ? waiting.effort : { level: ctx.level || null, used: null, supported: null, cap: null },
      // It runs as the account EditLens runs as: as root, the card's "root" tag and a note say so.
      asRoot: isRoot() && process.platform === 'linux' ? (this.rootTasks() ? 'unsafe' : 'root') : null,
    };
    fields.note = [ws ? null : 'This project is not a git project, so the task works in the project folder itself (shared with other agents).',
      this.rootNote(fields.asRoot, true)].filter(Boolean).join(' ') || null;
    const t = waiting ? Object.assign(waiting, { ...fields, permissions: waiting.permissions, replies: waiting.replies, startedAt: waiting.startedAt }) : fields;
    if (!waiting) this.keep(t);
    ctx.task = t;
    this.log(`task ${id} from ${pair.name}: starting in ${t.dir}`);
    const out = await this.run(t, null, fromAgent(pair.name) + text + FINISH);
    if (!out.error) return this.report(t);
    // It never started: remove its unused empty copy.
    if (ws && t.state === 'failed') worktree.remove(ws.root, ws.name);
    return out;
  }

  // A new task in the list; the oldest finished tasks are removed (a running one never is).
  keep(t) {
    this.items.set(t.id, t);
    for (const old of [...this.items.values()]) {
      if (this.items.size <= MAX_KEPT) break;
      if (!old.driver && !old.starting && !old.reserved && old.state !== 'waiting' && old !== t) {
        this.items.delete(old.id);
        this.dropCopy(old);
      }
    }
  }

  // A project sent from the paired computer, in parts. body: { upload?: id, data: base64, done? }
  // -> { upload, received } | { error }
  receive(pair, body) {
    const now = Date.now();
    this.sweepUploads(now);
    let id = typeof body.upload === 'string' ? body.upload : '';
    let u = id ? this.uploads.get(id) : null;
    if (id && (!u || u.pairId !== pair.id)) return { error: 'That upload expired. Start the task again.' };
    if (!u) {
      if ([...this.uploads.values()].filter((x) => x.pairId === pair.id).length >= 2) return { error: 'Two projects are already being sent from this computer. Wait for them.' };
      id = crypto.randomBytes(8).toString('hex');
      u = { pairId: pair.id, parts: [], size: 0, at: now };
      this.uploads.set(id, u);
    }
    const part = typeof body.data === 'string' ? Buffer.from(body.data, 'base64') : Buffer.alloc(0);
    if (u.size + part.length > UPLOAD_MAX) {
      this.dropUpload(id);
      return { error: `The project is too large to send (over ${UPLOAD_MAX / 1024 / 1024} MB compressed).` };
    }
    u.parts.push(part);
    u.size += part.length;
    u.at = now;
    // An upload that stops before every part is received (the other computer disconnected) is removed
    // by its own timer, not only when the next upload arrives.
    clearTimeout(u.timer);
    u.timer = setTimeout(() => this.sweepUploads(), UPLOAD_MS + 1000);
    u.timer.unref();
    return { upload: id, received: u.size };
  }

  sweepUploads(now = Date.now()) {
    for (const [k, u] of this.uploads) if (now - u.at > UPLOAD_MS) this.dropUpload(k);
  }

  dropUpload(id) {
    const u = this.uploads.get(id);
    if (!u) return null;
    clearTimeout(u.timer);
    this.uploads.delete(id);
    return u;
  }

  // A sent project into dir: as root without an account; with one, into root's own folder first,
  // then copied in as the account. -> Promise<{ count } | { error }>
  async unpackSent(bundle, dir, acct, id) {
    if (!acct) return sendproject.unpack(bundle, dir);
    const staging = path.join(this.stateDir, 'staging', id);
    await fs.promises.mkdir(path.dirname(staging), { recursive: true, mode: 0o700 });
    try {
      const out = await sendproject.unpack(bundle, staging);
      if (out.error) return out;
      const copied = await taskuser.copyInAs(acct, staging, dir);
      if (!copied.ok) {
        await taskuser.runAs(acct, ['rm', '-rf', '--', dir]);
        return { error: `Could not give the workspace to the ${acct.name} account (${copied.err || 'failed'}).` };
      }
      return out;
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }

  // A task in a copy of the paired computer's own project, sent with the task. Its changes are copied back
  // there (op "changes" and "file"); nothing here changes.
  // held, waiting: the project and the task that waited for a free session (startLater).
  async startSent(pair, id, text, uploadId, release = () => {}, ctx = {}, held = null, waiting = null) {
    const u = held || this.uploads.get(String(uploadId));
    if (!u || u.pairId !== pair.id) return { error: 'The project was not received (or the upload expired). Start the task again.' };
    if (!held) this.dropUpload(String(uploadId));
    // As a normal account when there is one: the workspace is in its home and belongs to it.
    const acct = this.account();
    if (acct && acct.error) return { error: `${this.host}: ${acct.error}` };
    const dir = path.join(acct ? acct.workspaces : path.join(this.stateDir, 'workspaces'), id);
    const bundle = Buffer.concat(u.parts);
    u.parts = []; // one copy, not two, while it is written out
    // The account's folder is the account's: root unpacks in its own folder, and the files are
    // copied in, git is set up and the folder is removed as the account (lib/taskuser.js runAs).
    const as = acct ? { name: acct.name, home: acct.home } : null;
    const remove = () => (acct ? taskuser.runAs(acct, ['rm', '-rf', '--', dir]) : fs.promises.rm(dir, { recursive: true, force: true }));
    // Stopped while its project was unpacked or set up: it never starts, and its workspace goes (Sol M5).
    const stopped = () => Boolean(waiting) && waiting.state === 'stopped';
    const out = await this.unpackSent(bundle, dir, acct, id);
    if (out.error) return out;
    // Its identity now, before the task's Claude runs: a folder put in its place later is refused.
    const dirId = safepath.folderId(dir);
    if (stopped()) {
      await remove();
      return {};
    }
    // Its own git repository, so the changes are exactly what the task did (and Claude there can
    // use git as usual).
    const steps = [['init', '-q'], ['add', '-A'], [...GIT_ID, 'commit', '-q', '--allow-empty', '-m', `Project as sent from ${pair.name}`], ['rev-parse', 'HEAD']];
    let base = null;
    for (const args of steps) {
      // Async, so the server is not blocked (a large project takes a while to add).
      const r = await worktree.gitAsync(dir, args, as ? { as } : {});
      if (stopped()) {
        await remove();
        return {};
      }
      if (!r.ok) {
        await remove();
        return { error: r.err.includes('ENOENT') ? `git is needed on ${this.host} for a sent project.` : `Could not set up the workspace: ${clip(r.err, 300)}` };
      }
      base = String(r.out).trim();
    }
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    const listed = WORKSPACE_EXCLUDE.join('\n') + '\n';
    if (acct) {
      const w = await taskuser.runAs(acct, ['sh', '-c', 'cat > "$1"', 'sh', exclude], { input: listed });
      if (!w.ok) this.log(`task ${id}: could not write the workspace's exclude list (${w.err})`);
      if (stopped()) {
        await remove();
        return {};
      }
    } else {
      try {
        fs.writeFileSync(exclude, listed);
      } catch (err) {
        if (!err || !err.code) throw err;
        this.log(`task ${id}: could not write the workspace's exclude list (${err.code})`);
      }
    }
    const fields = {
      id, by: pair.name, pairId: pair.id, cwd: pair.cwd, dir, dirId, copy: null, root: null, kind: 'sent', base, account: acct ? acct.name : null,
      prompt: text, state: 'starting', replies: [], replyCount: 0, permissions: new Map(), startedAt: Date.now(), updatedAt: Date.now(),
      effort: waiting && waiting.effort ? waiting.effort : { level: ctx.level || null, used: null, supported: null, cap: null },
      // As root: a note for the asking agent; pages show a "root" tag instead (card asRoot).
      asRoot: !acct && isRoot() && process.platform === 'linux' ? (this.rootTasks() ? 'unsafe' : 'root') : null,
    };
    fields.note = this.rootNote(fields.asRoot);
    const t = waiting ? Object.assign(waiting, { ...fields, permissions: waiting.permissions, replies: waiting.replies, startedAt: waiting.startedAt }) : fields;
    if (!waiting) this.keep(t);
    ctx.task = t;
    release();
    this.log(`task ${id} from ${pair.name}: ${out.count} files received, starting in ${dir}${acct ? ` as ${acct.name}` : ''}`);
    const intro = `[EditLens: you work on ${this.host} in a copy of a project sent from ${pair.name} (${out.count} files; node_modules and .env files were not sent, so install dependencies if you need them). ` +
      `Your changes are copied to the original project on ${pair.name} when its Claude applies them: leave them as files in this folder. Committing here is fine; don't push anywhere. ` +
      `The user runs and sees the app on ${pair.name}, so don't start a dev server for them; build only when the task needs it.]\n\n`;
    const started = await this.run(t, null, intro + fromAgent(pair.name) + text + FINISH);
    if (!started.error) return this.report(t);
    if (t.state === 'failed') await remove();
    return started;
  }

  // How git runs in the task's workspace: as the account that owns it, if any. That account gone:
  // git does not run (never as this server's user, in a folder that account could write).
  gitOpts(t, extra = {}) {
    if (!t.account) return extra;
    const a = taskuser.lookup(t.account);
    return a ? { ...extra, as: { name: a.name, home: a.home } } : { ...extra, as: { name: t.account, gone: true } };
  }

  // rel names a file inside dir with no link on its path, and its real name is not excluded.
  plainIn(dir, rel) {
    const at = safepath.inside(dir, rel);
    return !at.error && at.rel === rel && !sendproject.excluded(at.rel);
  }

  // The files a task changed in its workspace: [{ path, status: added | changed | deleted }].
  async changes(t) {
    if (t.kind === 'sent') {
      if (!fs.existsSync(t.dir)) return { error: 'The task\'s workspace is gone.' };
      if (this.replaced(t)) return { error: REPLACED };
      const [diff, added] = await Promise.all([
        worktree.gitAsync(t.dir, ['diff', '--name-status', '-z', '--no-renames', t.base, '--'], this.gitOpts(t)),
        worktree.gitAsync(t.dir, ['ls-files', '-z', '--others', '--exclude-standard'], this.gitOpts(t)),
      ]);
      if (!diff.ok || !added.ok) return { error: 'git could not read the workspace.' };
      const files = [];
      const f = diff.out.split('\0');
      for (let i = 0; i + 1 < f.length; i += 2) {
        const status = f[i] === 'A' ? 'added' : f[i] === 'D' ? 'deleted' : 'changed';
        if (shownName(f[i + 1])) files.push({ path: f[i + 1], status });
      }
      for (const rel of added.out.split('\0').filter(Boolean)) {
        if (shownName(rel) && !files.some((x) => x.path === rel)) files.push({ path: rel, status: 'added' });
      }
      // What Claude there said about each file (its last edit), for the edits shown here.
      const said = intentsByFile(t.edits);
      for (const f of files) if (said.has(f.path)) f.intent = said.get(f.path);
      // Each file's hash and size there, so the asking computer can tell what applying would do
      // without getting anything (a dry run), and gets only what it will write.
      // Four files at a time, each hashed as a stream: memory use stays within a limit for a large copy.
      await eachLimit(files.slice(0, 2000), 4, async (f) => {
        if (f.status === 'deleted') return;
        // Read as root, so never through a link the task made (to a key file elsewhere), on any
        // part of the path (openIn): a link is listed as one, with no hash or size.
        const at = this.openIn(t, f.path);
        if (at.error) {
          if (at.error === 'link' || at.error === 'not a file' || at.error === 'owner') f.status = 'link';
          return;
        }
        try {
          f.hash = await hashFile(null, at.fd);
          f.size = at.st.size;
        } catch (err) {
          // Removed meanwhile, or not readable (a file system error names a syscall): listed with no
          // hash or size.
          if (!err || typeof err.syscall !== 'string') throw err;
        }
      });
      return { task: t.id, kind: 'sent', state: t.state, busy: BUSY.has(t.state) || Boolean(t.starting) || undefined, files: files.slice(0, 2000), truncated: files.length > 2000 };
    }
    if (!t.copy) return { task: t.id, kind: 'shared', files: [], note: 'This task works in the project folder itself: its changes are already there.' };
    const st = await worktree.status(t.root, t.copy);
    if (st.error) return st;
    return {
      task: t.id, kind: 'copy',
      files: st.files.filter((x) => x.state !== 'same').map((x) => ({ path: x.relFile, status: x.deleted ? 'deleted' : x.added ? 'added' : 'changed', merge: x.state })),
      note: 'These are in the task\'s copy on this computer. merge_computer_task copies them into the project here.',
    };
  }

  // Files a task changed by commands (cat > file, sed -i, a generator), not by Edit.
  // Each task keeps in memory each changed file's hash (and text when small) as last shown. At the
  // start of a turn the files changed until then are saved; after the turn, any file that differs from
  // that is reported, so it shows like an edit.
  known(t) {
    if (!t.known) Object.defineProperty(t, 'known', { value: new Map(), enumerable: false, writable: true });
    return t.known;
  }

  // text: the file's content (string or Buffer), or null when it is gone.
  remember(t, rel, text) {
    const known = this.known(t);
    if (text === null) {
      known.delete(rel);
      known.set(rel, { gone: true, sha: null, text: null });
      return;
    }
    const buf = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8');
    const small = buf.length <= KNOWN_TEXT_MAX && !buf.includes(0);
    known.delete(rel); // newest last, so the oldest texts are removed first
    known.set(rel, { sha: sendproject.sha(buf), text: small ? buf.toString('utf8') : null, size: buf.length });
    let total = 0;
    for (const v of [...known.values()].reverse()) {
      total += v.text ? v.text.length : 0;
      if (total > KNOWN_TOTAL) v.text = null;
    }
    if (known.size > KNOWN_FILES) known.delete(known.keys().next().value);
  }

  // An edit the task's hook reported (Edit, Write): known, so a scan doesn't show it again.
  async rememberEdit(t, file, after) {
    const rel = path.relative(t.dir, file).split(path.sep).join('/');
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;
    if (typeof after === 'string') return this.remember(t, rel, after);
    const r = await this.readRel(t, rel);
    if (r) this.remember(t, rel, r.missing ? null : r.buf);
  }

  // One file of the workspace, read as root through openIn: never through a link on any part of
  // its path, and so never an excluded file under another name (Sol 0.24.43 H4, 0.24.45 H4).
  // -> { buf } | { missing } | null
  async readRel(t, rel) {
    if (!scanAllowed(rel)) return null;
    const at = this.openIn(t, rel);
    if (at.error) return at.error === 'ENOENT' || at.error === 'ENOTDIR' ? { missing: true } : null;
    try {
      if (at.st.size > SCAN_FILE_MAX) return null;
      return { buf: await readFd(at.fd, at.st.size) };
    } catch (err) {
      if (err && err.code) return null;
      throw err;
    } finally {
      fs.closeSync(at.fd);
    }
  }

  // A file of the task's workspace, opened for reading: in the folder made for the task (one put in
  // its place is refused), with no link on any part of the path, and with a task account only a
  // file that account owns, so root reads nothing the account could not (Sol 0.24.45 H4, H5).
  // -> as safepath.openNoLinks
  openIn(t, rel) {
    let uid = null;
    if (t.account) {
      const a = taskuser.lookup(t.account);
      if (!a) return { error: 'EACCES' };
      uid = a.uid;
    }
    return safepath.openNoLinks(t.dir, rel, { id: this.dirIdOf(t), uid });
  }

  // The identity of a workspace EditLens made (a sent project's, or a copy), taken when it was made
  // (or, for a task listed by an older EditLens, when it was first loaded or read). A task in the
  // project folder itself has none: that folder may be replaced on purpose (a deploy's link).
  dirIdOf(t) {
    if (t.kind !== 'sent' && !t.copy) return null;
    if (!t.dirId) t.dirId = safepath.folderId(t.dir);
    return t.dirId;
  }

  // The task's workspace path now leads to another folder (moved away, a link put in its place).
  replaced(t) {
    const was = this.dirIdOf(t);
    const now = safepath.folderId(t.dir);
    return Boolean(was && now && (was.dev !== now.dev || was.ino !== now.ino));
  }

  // The files that differ from the task's start, as changes() lists them. -> [rel] | null
  async changedRels(t) {
    if (t.kind !== 'sent' && !t.copy) return null; // works in the project itself: no start to compare with
    const ch = await this.changes(t);
    if (!ch || ch.error || !Array.isArray(ch.files)) return null;
    return ch.files.filter((f) => f.status !== 'link' && scanAllowed(f.path)).map((f) => f.path);
  }

  // A turn starts: save what the changed files have now.
  async scanTurnStart(t) {
    const rels = await this.changedRels(t);
    if (!rels) return;
    const known = this.known(t);
    for (const rel of rels.slice(0, SCAN_FILES)) {
      if (known.has(rel)) continue;
      const r = await this.readRel(t, rel);
      if (r) this.remember(t, rel, r.missing ? null : r.buf);
    }
  }

  // The file as it was at the task's start (its commit). -> string ('' when it wasn't there) | null
  async baseText(t, rel) {
    let base = t.base;
    if (t.kind !== 'sent') {
      const st = await worktree.status(t.root, t.copy);
      if (st.error || !st.base) return null;
      base = st.base;
    }
    if (!base) return null;
    const r = await worktree.gitAsync(t.dir, ['show', `${base}:${rel}`], this.gitOpts(t));
    if (!r.ok) return /does not exist|exists on disk, but not in/.test(r.err) ? '' : null;
    return r.out.length <= KNOWN_TEXT_MAX && !r.out.includes('\0') ? r.out : null;
  }

  // A turn ended: the files that changed without an edit showing them.
  // -> [{ rel, file, before (null: not known), after (null: binary or big), created, deleted }]
  async commandEdits(t) {
    const rels = await this.changedRels(t);
    if (!rels) return [];
    const known = this.known(t);
    // A file saved before that is back to how it started is a change too.
    const all = [...new Set([...rels, ...[...known.keys()].filter((k) => !known.get(k).gone)])].slice(0, SCAN_FILES);
    const out = [];
    for (const rel of all) {
      const r = await this.readRel(t, rel);
      if (!r) continue;
      const was = known.get(rel);
      if (r.missing ? was && was.gone : was && was.sha === sendproject.sha(r.buf)) continue;
      if (r.missing && !was && !rels.includes(rel)) continue;
      const before = was ? (was.gone ? '' : was.text) : await this.baseText(t, rel);
      const text = r.missing ? '' : r.buf.length <= KNOWN_TEXT_MAX && !r.buf.includes(0) ? r.buf.toString('utf8') : null;
      out.push({ rel, file: path.join(t.dir, rel), before, after: text, created: before === '' && !r.missing, deleted: Boolean(r.missing) });
      this.remember(t, rel, r.missing ? null : r.buf);
      if (out.length >= COMMAND_EDITS_MAX) break;
    }
    return out;
  }

  // The task's whole change as one unified diff (added files included), paged. paths: only these.
  // -> { task, diff, offset, next, size } | { error }
  async diff(t, paths, offset) {
    if (!fs.existsSync(t.dir)) return { error: 'The task\'s workspace is gone.' };
    if (this.replaced(t)) return { error: REPLACED };
    let base = t.base;
    if (t.kind !== 'sent') {
      if (!t.copy || !t.root) return { error: 'This task works in the project folder itself: its changes are already there (no diff kept).' };
      const st = await worktree.status(t.root, t.copy);
      if (st.error) return st;
      base = st.base;
    }
    const want = Array.isArray(paths) ? paths.map((p) => sendproject.cleanRel(p)).filter(Boolean).slice(0, 200) : [];
    const from0 = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    // The next pages of a diff just read come from the one kept (only one, for a short while), so
    // paging through a big diff doesn't compute it again for every page.
    const key = JSON.stringify([t.id, base, want]);
    const kept = this.diffKept;
    if (from0 && kept && kept.key === key && Date.now() - kept.at < DIFF_KEEP_MS) return this.diffPage(t, kept.text, from0);
    this.diffKept = null;
    // A temporary index has every file as it is now, so added files appear too.
    const opts = this.gitOpts(t);
    // As the account, the temporary index is in a folder it owns, made and removed by the account.
    const a = opts.as ? taskuser.lookup(t.account) : null;
    if (opts.as && !a) return { error: 'The task\'s account is gone.' };
    const tmp = a ? await this.tempAs(a) : await fs.promises.mkdtemp(path.join(os.tmpdir(), 'editlens-diff-'));
    if (!tmp) return { error: 'git could not read the workspace.' };
    try {
      const env = { GIT_INDEX_FILE: path.join(tmp, 'index') };
      const add = await worktree.gitAsync(t.dir, ['add', '-A', '--', '.', ':(exclude).claude/worktrees'], { ...opts, env });
      if (!add.ok) return { error: 'git could not read the workspace.' };
      // The allowed names first (-z: exact names); then only parts whose header is one of them. A
      // header git quoted or that can't be read is left out, so a secret file's lines never appear.
      const spec = want.length ? want.map((w) => `:(literal)${w}`) : ['.'];
      const names = await worktree.gitAsync(t.dir, ['diff', '--cached', '--name-only', '-z', '--no-renames', base, '--', ...spec], { ...opts, env });
      if (!names.ok) return { error: 'git could not compare the workspace.' };
      const allowed = new Set(String(names.out).split('\0').filter(shownName));
      let text = '';
      if (allowed.size) {
        const r = await worktree.gitAsync(t.dir, ['diff', '--cached', '--no-ext-diff', '--no-color', '--no-renames', base, '--', ...spec], { ...opts, env });
        if (!r.ok) return { error: 'git could not compare the workspace.' };
        text = String(r.out).split(/(?=^diff --git )/m).filter((part) => allowed.has(headerName(part))).join('');
      }
      // The workspace replaced while git compared it: the text is another folder's (Sol M2).
      if (this.replaced(t)) return { error: REPLACED };
      if (text.length > DIFF_PAGE) {
        this.diffKept = { key, text, at: Date.now() };
        clearTimeout(this.diffTimer);
        this.diffTimer = setTimeout(() => {
          this.diffKept = null;
        }, DIFF_KEEP_MS);
        this.diffTimer.unref();
      }
      return this.diffPage(t, text, from0);
    } finally {
      if (a) {
        taskuser.runAs(a, ['rm', '-rf', '--', tmp]).then((r) => { if (!r.ok) this.log(`diff: could not remove ${tmp} (${r.err})`); });
      } else {
        fs.rm(tmp, { recursive: true, force: true }, (err) => { if (err) this.log(`diff: could not remove ${tmp} (${err.code || err.message})`); });
      }
    }
  }

  // A new folder in the account's own folder (TASK_STATE), made by the account. -> path | null
  async tempAs(a) {
    const parent = path.join(a.home, taskuser.TASK_STATE);
    const r = await taskuser.runAs(a, ['mktemp', '-d', '-p', parent, 'editlens-diff-XXXXXXXX']);
    const made = r.ok ? r.out.trim() : '';
    if (path.dirname(made) === parent && /^editlens-diff-[A-Za-z0-9]{8}$/.test(path.basename(made))) return made;
    this.log(`diff: could not make a folder as ${a.name} (${r.err || made})`);
    return null;
  }

  diffPage(t, text, offset) {
    const from = Math.min(offset, text.length);
    const page = text.slice(from, from + DIFF_PAGE);
    const next = from + page.length < text.length ? from + page.length : null;
    return { task: t.id, diff: page || '(no changes)', offset: from, next, size: text.length };
  }

  // The workspace's files (git's view: tracked and untracked-not-ignored), paged. glob: a git pathspec glob.
  async files(t, glob, offset) {
    if (!fs.existsSync(t.dir)) return { error: 'The task\'s workspace is gone.' };
    if (this.replaced(t)) return { error: REPLACED };
    const spec = typeof glob === 'string' && glob.trim() ? [`:(glob)${glob.trim().slice(0, 200)}`] : ['.'];
    const r = await worktree.gitAsync(t.dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...spec], this.gitOpts(t));
    if (!r.ok) return { error: 'git could not list the workspace.' };
    const all = [...new Set(String(r.out).split('\0').filter(shownName))].sort();
    const from = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    const page = all.slice(from, from + LIST_PAGE);
    return { task: t.id, files: page, total: all.length, offset: from, next: from + page.length < all.length ? from + page.length : null };
  }

  // Lines in the workspace's files that contain the text (not a pattern).
  // -> { matches: ["path:line: text"] }
  // git runs as the task's account when there is one (gitOpts), so it reads only what that account
  // can; a workspace folder replaced by another is refused first (Sol 0.24.45 H5).
  async search(t, text, glob, max) {
    if (!fs.existsSync(t.dir)) return { error: 'The task\'s workspace is gone.' };
    if (this.replaced(t)) return { error: REPLACED };
    const needle = String(text || '');
    if (!needle || needle.length > 500) return { error: 'Give the text to look for (up to 500 characters).' };
    const limit = Number.isSafeInteger(max) && max > 0 ? Math.min(max, SEARCH_MAX) : 50;
    const spec = typeof glob === 'string' && glob.trim() ? [`:(glob)${glob.trim().slice(0, 200)}`] : ['.'];
    const r = await worktree.gitAsync(t.dir, ['grep', '-z', '-n', '-I', '-F', '--untracked', '--no-color', '-e', needle, '--', ...spec], this.gitOpts(t));
    // 1: nothing found.
    if (!r.ok && r.status !== 1) return { error: 'git could not search the workspace.' };
    // The workspace replaced while git searched it: what git read is another folder's (Sol M2).
    if (this.replaced(t)) return { error: REPLACED };
    const matches = [];
    let total = 0;
    // -z: name NUL line NUL text, so a ':' in a file name can't move the split. Each name is checked
    // where it really leads now: a folder link on its path (to a sibling, to .git) leaves it out.
    for (const m of String(r.out).matchAll(/([^\0]*)\0(\d+)\0([^\n]*)\n/g)) {
      if (!shownName(m[1]) || !this.plainIn(t.dir, m[1])) continue;
      total++;
      if (matches.length < limit) matches.push(`${m[1]}:${m[2]}: ${clip(m[3].trim(), 300)}`);
    }
    return { task: t.id, matches, total, more: total > matches.length ? `${total - matches.length} more; use glob to limit it.` : undefined };
  }

  // One page of a file in the task's workspace, read through openIn.
  // -> { path, size, offset, data (base64), next } | { path, missing } | { error }
  workspaceFile(t, rel, offset) {
    const clean = sendproject.cleanRel(rel);
    if (!clean || sendproject.excluded(clean)) return { error: 'Not a file in the workspace.' };
    const at = this.openIn(t, clean);
    if (at.error === 'ENOENT' || at.error === 'ENOTDIR') return { path: clean, missing: true };
    if (at.error === 'replaced') return { error: REPLACED };
    if (at.error === 'not a file') return { error: 'Not a file.' };
    if (at.error) return { error: /^E[A-Z]+$/.test(at.error) ? at.error : 'Not a file in the workspace.' };
    return pageOf(at.fd, clean, offset);
  }

  // One page of a file under dir, never outside it (links included). where: for the messages.
  readPage(dir, rel, offset, where) {
    const clean = sendproject.cleanRel(rel);
    if (!clean || sendproject.excluded(clean)) return { error: `Not a file in ${where}.` };
    // A link is followed only inside dir, and the name it leads to is checked too (alias -> .env).
    const at = safepath.inside(dir, clean);
    if (at.error) return { error: at.error === 'outside' ? `Not a file in ${where}.` : at.error };
    if (!at.exists) return { path: clean, missing: true };
    if (sendproject.excluded(at.rel)) return { error: `Not a file in ${where}.` };
    // The real path the check found, opened with no link on any part of it: a link swapped in since
    // the check is not followed (Sol M5). Removed since the check: reported like a missing file.
    const open = safepath.openNoLinks(dir, at.rel);
    if (open.error === 'ENOENT' || open.error === 'ENOTDIR') return { path: clean, missing: true };
    if (open.error === 'not a file') return { error: 'Not a file.' };
    if (open.error) return { error: /^E[A-Z]+$/.test(open.error) ? open.error : `Not a file in ${where}.` };
    return pageOf(open.fd, clean, offset);
  }

  // Read-only listing of this computer's own project (no Claude runs): files under a folder (or one
  // file) with sizes and hashes. No dependencies, build output, .git, .env files, keys or links.
  // hash: omitted -> shas up to HASH_PAGE_MAX (older computers); false -> none; [paths] -> { shas } only.
  // -> { root, path, files: [{ path, size, sha }], total, bytes, next, skipped } | { shas } | { error }
  async projectFiles(pair, sub, offset, hash) {
    const root = pair && pair.cwd;
    if (!root) return { error: 'No project is paired on this computer.' };
    const want = sub === undefined || sub === null || sub === '' || sub === '.' ? '' : sendproject.cleanRel(sub);
    if (want === null) return { error: 'Give a path inside the project (relative, no ..).' };
    if (want && sendproject.excluded(want)) return { error: `${want} is never copied (dependencies, .git, .env files and keys stay on ${this.host}).` };
    let real;
    try {
      real = fs.realpathSync(root);
    } catch (err) {
      if (err && err.code) return { error: `The project folder on ${this.host} can't be read (${err.code}).` };
      throw err;
    }
    if (Array.isArray(hash)) return { shas: await projectHashes(real, hash) };
    const from = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
    // A later page comes from the list its first page made, so no file is listed twice or left out.
    const key = `${real}\0${want}`;
    let list = from ? this.listings.get(key) : null;
    if (!list || Date.now() - list.at > LIST_KEEP_MS) {
      list = this.listProject(pair, real, want);
      if (list.error) return list;
      this.listings.delete(key);
      this.listings.set(key, list);
      for (const [k, v] of this.listings) if (Date.now() - v.at > LIST_KEEP_MS || this.listings.size > LISTINGS_KEPT) this.listings.delete(k);
    }
    list.at = Date.now();
    const { all, kind } = list;
    const skipped = list.skipped.slice();
    // Hashes let the other computer skip files it already has; it asks only for files whose size
    // matches one it has, so most files are never read. Read without blocking the server.
    const slice = all.slice(from, from + LIST_PAGE);
    const files = [];
    let budget = hash === false ? 0 : HASH_PAGE_MAX;
    for (const f of slice) {
      let sha = null;
      if (f.size <= budget) {
        budget -= f.size;
        try {
          sha = await hashFile(f.abs);
        } catch (err) {
          if (!err || !err.code) throw err;
          skipped.push({ path: f.path, why: err.code });
          continue;
        }
      }
      files.push({ path: f.path, size: f.size, sha });
    }
    return { root: pair.cwd, path: want || '.', kind, files, total: all.length, bytes: all.reduce((n, f) => n + f.size, 0),
      offset: from, next: from + slice.length < all.length ? from + slice.length : null, capped: all.length >= COPY_FILES_MAX || undefined, skipped: skipped.slice(0, 50) };
  }

  // The files under want (or the one file) in the project at real, sorted.
  // -> { at, all: [{ path, size, abs }], skipped, kind } | { error }
  listProject(pair, real, want) {
    const all = [];
    const skipped = [];
    const add = (rel, abs) => {
      if (sendproject.excluded(rel)) return undefined;
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch (err) {
        // Removed or unreadable since the folder was read: skipped, like a folder walk() can't read.
        if (err && err.code) return skipped.push({ path: rel, why: err.code });
        throw err;
      }
      if (st.isSymbolicLink()) return skipped.push({ path: rel, why: 'a link' });
      if (!st.isFile()) return undefined;
      if (st.size > COPY_FILE_MAX) return skipped.push({ path: rel, why: `over ${COPY_FILE_MAX / 1024 / 1024} MB` });
      all.push({ path: rel, size: st.size, abs });
      return undefined;
    };
    const walk = (rel, abs) => {
      let entries;
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch (err) {
        if (err && err.code) return skipped.push({ path: rel || '.', why: err.code });
        throw err;
      }
      for (const e of entries) {
        if (all.length >= COPY_FILES_MAX) return undefined;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!sendproject.WALK_SKIP.has(e.name) && !sendproject.excluded(r)) walk(r, path.join(abs, e.name));
        } else add(r, path.join(abs, e.name));
      }
      return undefined;
    };
    // A folder link above want (link/sub) is refused too; a link at its end is refused below.
    const up = want ? path.posix.dirname(want) : '.';
    if (up !== '.') {
      const at = safepath.inside(real, up);
      if (at.error === 'outside' || (!at.error && at.file !== path.join(real, up))) return { error: `${want} is behind a link: links are never copied.` };
    }
    const start = want ? path.join(real, want) : real;
    let st;
    try {
      st = fs.lstatSync(start);
    } catch (err) {
      if (err && err.code === 'ENOENT') return { error: `${want} does not exist in the project on ${this.host} (${pair.cwd}).` };
      if (err && err.code) return { error: err.code };
      throw err;
    }
    if (st.isSymbolicLink()) return { error: `${want} is a link: links are never copied.` };
    if (st.isDirectory()) walk(want, start);
    else add(want, start);
    all.sort((a, b) => (a.path < b.path ? -1 : 1));
    return { at: Date.now(), all, skipped, kind: st.isDirectory() ? 'folder' : 'file' };
  }

  // One page of a file in this computer's own project (read-only). -> as workspaceFile
  projectFile(pair, rel, offset) {
    if (!pair || !pair.cwd) return { error: 'No project is paired on this computer.' };
    return this.readPage(pair.cwd, rel, offset, 'the project');
  }

  // Which project this computer's tasks work on, so the asking computer can tell whether it is
  // the same code as its own.
  project(pair) {
    const head = worktree.git(pair.cwd, ['rev-list', '--max-parents=0', 'HEAD']);
    const remote = worktree.git(pair.cwd, ['remote', 'get-url', 'origin']);
    return { computer: this.host, cwd: pair.cwd, roots: head.ok ? String(head.out).split('\n').filter(Boolean).slice(0, 5) : [], remote: remote.ok ? publicRemote(String(remote.out).trim()) : null };
  }

  // A task left the list: its copy is removed too, unless it has changes nobody merged (those stay
  // for the copy card in the panel). Runs in the background; never throws.
  dropCopy(t) {
    if (t.kind === 'sent') {
      // A sent project's workspace is EditLens's own folder: it is removed with the task.
      const a = t.account ? taskuser.lookup(t.account) : null;
      const dir = path.join(a ? path.join(a.home, taskuser.WORKSPACES) : path.join(this.stateDir, 'workspaces'), t.id);
      if (t.dir !== dir) return Promise.resolve(true);
      // As the account in its own folder (lib/taskuser.js runAs).
      if (a) {
        taskuser.runAs(a, ['rm', '-rf', '--', dir]).then((r) => { if (!r.ok) this.log(`task ${t.id}: could not remove its workspace (${r.err})`); });
      } else {
        fs.rm(dir, { recursive: true, force: true }, (err) => { if (err) this.log(`task ${t.id}: could not remove its workspace (${err.code || err.message})`); });
      }
      return Promise.resolve(true);
    }
    if (!t.copy || !t.root) return Promise.resolve(false);
    return worktree.status(t.root, t.copy).then((st) => {
      if (st.error) return false;
      if (st.files.some((f) => f.state !== 'same')) return false;
      const gone = worktree.remove(t.root, t.copy);
      if (gone.error) this.log(`task ${t.id}: could not remove its copy (${gone.error})`);
      return !gone.error;
    }, (err) => {
      this.log(`task ${t.id}: could not check its copy (${err.message})`);
      return false;
    });
  }

  // Starts (or resumes) the task's Claude session and gives it text. -> { ok } | { error }
  // One start at a time per task: a follow-up or a second start while it starts is refused.
  async run(t, resume, text) {
    if (t.starting) return { error: 'The task is still starting. Check it, then send the follow-up.' };
    t.starting = true;
    try {
      return await this.runOnce(t, resume, text);
    } finally {
      t.starting = false;
    }
  }

  async runOnce(t, resume, text) {
    // Checked again here: a start that waited, or unpacked a sent project, can end after the setting changed.
    if (!this.runsAllowed()) return this.fail(t, this.runsOff());
    let acct = null;
    if (t.account) {
      acct = this.account();
      if (!acct || acct.error || acct.name !== t.account) return this.fail(t, acct && acct.error ? acct.error : `The ${t.account} account this task ran as is gone (or turned off in the settings) on ${this.host}.`);
    }
    const driver = this.makeDriver({
      account: acct,
      composed: true,
      peer: t.by,
      systemAppend: taskNote(t.by),
      // A sent project is a copy with no page open here: the "running app" prompt would be false.
      workPrompt: t.kind === 'sent' ? sentNote(t.by) : null,
      emit: (ev) => this.onDriverEvent(t, driver, ev),
      onMessage: (msg) => this.onMessage(t, msg),
    });
    t.driver = driver;
    t.error = null;
    t.result = null; // a new turn (start or resume): no old result while it works
    t.state = 'starting';
    this.changed(t);
    // Stopped (or replaced) while it started: this Claude stops too, so none runs untracked.
    const gone = () => {
      if (t.driver === driver) return null;
      driver.stop('task stopped');
      return { error: 'The task was stopped.' };
    };
    // A follow-up continues the task's own session (no new copy of it each time).
    const started = await driver.start({ cwd: t.dir, resume: resume || undefined, claudePaths: this.claudePaths(), fork: false, effort: t.effort && effortLib.isLevel(t.effort.level) ? t.effort.level : this.defaultEffort(t.cwd) });
    let stopped = gone();
    if (stopped) return stopped;
    if (started.error) return this.fail(t, started.error, driver);
    if (started.signIn) {
      return this.fail(t, acct
        ? `The ${acct.name} account on ${this.host} isn't signed in to Claude. The user signs it in once: ssh to ${this.host}, run su - ${acct.name}, then claude, then /login. Then try again.`
        : `Claude isn't signed in on ${this.host}. Sign in there (run claude, then /login), then try again.`, driver);
    }
    const ready = await driver.started();
    stopped = gone();
    if (stopped) return stopped;
    if (ready.error) return this.fail(t, ready.error, driver);
    await this.beforeTurn(t);
    stopped = gone();
    if (stopped) return stopped;
    const sent = this.sendTurn(t, driver, text);
    if (sent.error) return this.fail(t, sent.error, driver);
    t.state = 'working';
    this.changed(t);
    return { ok: true };
  }

  // onTurnStart, as a promise that never rejects (its errors are logged).
  turnStart(t) {
    return Promise.resolve().then(() => this.onTurnStart(t))
      .catch((err) => this.log(`task ${t.id}: could not record its files (${err && err.message})`));
  }

  // A turn is about to start: the files changed until now are recorded first, so a file the turn
  // changes by a command immediately is shown as its edit (Sol L11). It waits at most
  // TURN_SCAN_WAIT_MS; a slower scan continues, and the turn starts without waiting for it.
  async beforeTurn(t) {
    let timer = null;
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), TURN_SCAN_WAIT_MS); });
    const first = await Promise.race([this.turnStart(t).then(() => 'done'), late]);
    clearTimeout(timer);
    if (first === 'late') this.log(`task ${t.id}: its turn started before its files were recorded (the scan needed more than ${TURN_SCAN_WAIT_MS / 1000} s)`);
  }

  // driver.send for a turn beforeTurn has scanned for: its "working" event does not scan again.
  sendTurn(t, driver, text) {
    this.scannedTurn.add(t);
    try {
      return driver.send(text);
    } finally {
      this.scannedTurn.delete(t);
    }
  }

  // driver: the Claude that failed; a newer one on the task is not changed.
  fail(t, error, driver = t.driver) {
    if (driver && t.driver !== driver) {
      driver.stop('task failed');
      return { error: clip(error, 600) };
    }
    const d = t.driver;
    t.driver = null;
    if (d) d.stop('task failed');
    t.permissions.clear(); // its Claude is gone: nobody waits for these answers now
    t.state = 'failed';
    t.error = clip(error, 600);
    this.log(`task ${t.id}: ${t.error}`);
    this.changed(t);
    return { error: t.error };
  }

  onMessage(t, msg) {
    const text = replyText(msg);
    if (text) {
      t.replies.push(clip(text, REPLY_MAX));
      t.replyCount = (t.replyCount || 0) + 1;
      if (t.replies.length > REPLIES_KEPT) t.replies.splice(0, t.replies.length - REPLIES_KEPT);
    }
    if (msg && msg.type === 'system' && msg.subtype === 'init' && typeof msg.session_id === 'string') t.sessionId = msg.session_id;
    // The model and permission mode its Claude runs with, for the agent details card (pages, Details).
    if (msg && msg.type === 'system' && (msg.subtype === 'init' || msg.subtype === 'status')) {
      if (msg.subtype === 'init' && typeof msg.model === 'string' && msg.model) t.model = clip(msg.model, 80);
      if (typeof msg.permissionMode === 'string' && /^[A-Za-z]{1,30}$/.test(msg.permissionMode)) t.mode = msg.permissionMode;
    }
    if (msg && msg.type === 'result') {
      // An error result in plain words; its raw text (with ids) only in the log.
      const raw = typeof msg.result === 'string' ? msg.result : Array.isArray(msg.errors) ? msg.errors.join('; ') : '';
      if (msg.is_error) this.log(`task ${t.id}: error result: ${clip(raw, 600)}`);
      t.result = { text: msg.is_error ? sdkerr.plainSdk(raw || null, undefined, { task: true }).text : clip(raw, REPLY_MAX), isError: Boolean(msg.is_error), turns: Number.isFinite(msg.num_turns) ? msg.num_turns : null };
      const num = (n) => (Number.isFinite(n) && n >= 0 ? n : null);
      t.stats = { turns: num(msg.num_turns), seconds: num(msg.duration_ms) === null ? null : Math.round(msg.duration_ms / 1000), costUsd: num(msg.total_cost_usd) };
    }
    // Tool steps (the main agent's and its subagents'): titles only.
    const blocks = msg && msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content) ? msg.message.content : [];
    let steps = 0;
    for (const b of blocks) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      t.activity = (t.activity || []).concat({ at: Date.now(), agent: msg.parent_tool_use_id ? 'subagent' : 'main', title: stepTitle(b.name, b.input) }).slice(-ACTIVITY_KEPT);
      t.activityCount = (t.activityCount || 0) + 1;
      steps++;
    }
    if (steps) this.changed(t, true);
  }

  onDriverEvent(t, driver, ev) {
    if (t.driver !== driver || !ev) return;
    if (ev.type === 'permission') {
      const { type, cwd, sessionId, ...card } = ev;
      t.permissions.set(card.id, card);
      return this.changed(t);
    }
    if (ev.type === 'permission-done') {
      t.permissions.delete(ev.id);
      return this.changed(t);
    }
    if (ev.type === 'drive-signin') return undefined;
    // What its Claude really uses (clamped, or none on a model without effort): on the card.
    if (ev.type === 'drive-effort' && ev.effort) {
      t.effort = { level: ev.effort.level, used: ev.effort.used, supported: ev.effort.supported, cap: ev.effort.cap };
      return this.changed(t);
    }
    if (ev.type === 'drive-note') {
      this.log(`task ${t.id}: ${ev.text}`);
      return undefined;
    }
    if (ev.type !== 'drive') return undefined;
    if (ev.phase === 'signin') {
      this.fail(t, `Claude isn't signed in on ${this.host}. Sign in there (run claude, then /login), then send a follow-up.`);
      return undefined;
    }
    if (ev.phase === 'working') {
      // A turn this file did not start (beforeTurn did not run): its files are recorded now.
      if (t.state !== 'working' && !this.scannedTurn.has(t)) this.turnStart(t);
      t.state = 'working';
      clearTimeout(t.timer);
    }
    else if (ev.phase === 'idle') {
      t.state = 'idle';
      clearTimeout(t.timer);
      // Closed only if it is still waiting with this Claude when the time is up.
      t.timer = setTimeout(() => {
        if (t.state === 'idle' && t.driver === driver) this.close(t, 'idle');
      }, this.idleCloseMs);
      if (t.timer.unref) t.timer.unref();
      this.onTurn(t);
    } else if (ev.phase === 'ended') {
      t.driver = null;
      clearTimeout(t.timer);
      t.permissions.clear();
      if (ev.error) {
        t.state = 'failed';
        t.error = clip(ev.error, 600);
      } else if (t.state !== 'stopped') {
        t.state = 'ended';
      }
    } else {
      return undefined;
    }
    return this.changed(t);
  }

  close(t, why) {
    const d = t.driver;
    if (!d) return;
    t.driver = null;
    clearTimeout(t.timer);
    d.stop(why);
    t.permissions.clear(); // its Claude is gone: nobody waits for these answers now
    if (t.state !== 'failed') t.state = why === 'stopped' ? 'stopped' : 'ended';
    this.changed(t);
  }

  // A follow-up from the asking agent. -> report | { error }. One that can't be sent is shown on
  // the pages here too.
  async send(pair, id, text) {
    const out = await this.sendFollowUp(pair, id, text);
    if (out && out.error) this.refuse(pair, text, out.error, { task: String(id || '').slice(0, 40) || null });
    return out;
  }

  async sendFollowUp(pair, id, text) {
    const t = this.mine(pair, id);
    if (!t) return { error: 'No such task from this computer.' };
    const msg = typeof text === 'string' ? text.trim() : '';
    if (!msg) return { error: 'Give the message.' };
    if (msg.length > PROMPT_MAX) return { error: 'The message is too long.' };
    if (t.starting) return { error: 'The task is still starting. Check it, then send the follow-up.' };
    if (t.driver) await this.beforeTurn(t);
    // Its Claude can end while the files are recorded: then the follow-up starts it again below.
    if (t.driver) {
      const sent = this.sendTurn(t, t.driver, fromAgent(t.by) + msg);
      if (sent.error) return { error: sent.error };
      clearTimeout(t.timer);
      t.state = 'working';
      t.note = null;
      t.result = null; // the last turn's result is not this one's
      this.changed(t);
      return this.report(t, t.replyCount);
    }
    if (t.state === 'waiting') return { error: 'The task is still waiting for a free session. Check it, then send the follow-up.' };
    if (!fs.existsSync(t.dir)) return { error: 'The task\'s workspace is gone (it was removed). Start a new task.' };
    const before = t.replyCount || 0;
    // No free session: the follow-up waits for one, like a new task.
    if (!this.roomForTask()) {
      const full = this.wait(t, () => this.run(t, t.sessionId, fromAgent(t.by) + msg));
      return full || this.report(t, before);
    }
    t.note = null;
    const out = await this.run(t, t.sessionId, fromAgent(t.by) + msg);
    return out.error ? out : this.report(t, before);
  }

  stop(pair, id) {
    const t = this.mine(pair, id);
    if (!t) return { error: 'No such task from this computer.' };
    return this.stopTask(t);
  }

  stopTask(t) {
    if (t.state === 'waiting') {
      // It never started: remove it from the waiting list.
      this.queue = this.queue.filter((e) => e.t !== t);
      t.state = 'stopped';
      t.note = 'Stopped before it started.';
      this.changed(t);
      return this.report(t);
    }
    if (t.driver) {
      t.state = 'stopped';
      this.close(t, 'stopped');
    }
    return this.report(t);
  }

  // From a page: Stop, and answers to permission questions (people only).
  byId(id) {
    return this.items.get(String(id || '')) || null;
  }

  answer(t, permissionId, decision) {
    if (!t.driver) return { error: 'That task is not running.' };
    if (!['allow', 'always', 'deny'].includes(decision)) return { error: 'Answer allow, always or deny.' };
    return t.driver.answer(permissionId, decision);
  }

  stopAll() {
    for (const t of this.items.values()) {
      if (!t.driver) continue;
      t.note = `EditLens stopped on ${this.host}, so this task's Claude stopped. Send a follow-up to continue it.`;
      this.close(t, 'server stopping');
    }
    // A save that was waiting happens now, before the server exits.
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}

module.exports = { publicRemote, Tasks, replyText, intentsByFile };
