'use strict';
// Page control ("drive"): Claude runs in the live server through the Agent SDK, controlled from the page.
// Safety:
// - Started only by the user; gives a random key, sent only on that project's page streams, that every
//   drive request must include. Always works on a fork, never the session open in Claude Code.
// - Uses the user's login and permissions; prompts go to the panel, unanswered denied after 10 min.
// - Bypass is only enabled after the user confirms it in the EditLens window.

const { PRODUCT_NAME } = require('../lib/name');
const { plainError } = require('../lib/plainerr');
const modes = require('../lib/modes');
const guard = require('../lib/guard');
const config = require('../lib/config');
const { selfCall, editlensPorts, startsNew, NEW_REASON } = require('../lib/selfguard');
const settingsLib = require('../lib/settings');
const taskuser = require('../lib/taskuser');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sliceSafe } = require('../lib/textcut');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { pathToFileURL } = require('url');

const { SDK_PACKAGE } = require('../lib/sdkinfo');
const pagekeep = require('../lib/pagekeep');
const { pluginState } = require('../lib/pluginstate');
const sdkerr = require('../lib/sdkerr');
const effortLib = require('../lib/effort');
const PERMISSION_TIMEOUT_MS = 10 * 60000;
// Claude's multiple-choice question (AskUserQuestion): the page can't answer it, so it is refused with
// this message (the user's choice D16) and no card is shown. Claude then asks in its reply instead.
const QUESTION_TOOL = 'AskUserQuestion';
const QUESTION_REFUSAL = "The person can't answer multiple-choice questions from the page yet. Ask this in your reply text instead, with the options as a short list.";
const MODE_NAMES = { default: 'Ask', acceptEdits: 'Accept edits', plan: 'Plan', auto: 'Auto', dontAsk: "Don't ask" };
// Added to Claude's system prompt in page control.
const WORK_IN_PLACE = [
  'You are working inside an app that is already running and open in the user\'s browser, with the EditLens panel on the page.',
  'Work inside the existing project: read a file before you change it, extend what is there, and make focused edits instead of rewriting whole files.',
  'Never start the app over, scaffold a new project, or replace existing pages, styles or config to add something new. Add new pages, components or styles next to the existing ones.',
  'Never remove the EditLens integration (the EditLens Vite plugin, Next.js wrapper, Express middleware or script tag) or change the dev server\'s host and port.',
  'Never add EditLens to project files yourself: the page is connected already. If the user asks you to, wrap the added lines in `// editlens:start` and `// editlens:end` comments (on their own lines) so /editlens stop can remove them.',
  'If the request seems to need replacing existing work, ask the user first.',
].join(' ');
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Environment of the Claude Code session that started the live server; it must not be passed to the
// page-controlled session (it would look like a nested session, or use that session's identity).
const DROP_ENV = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(?!OAUTH_TOKEN$|USE_BEDROCK$|USE_VERTEX$|USE_FOUNDRY$|GIT_BASH_PATH$|SKIP_\w+_AUTH$)\w+|CLAUDE_SESSION_\w+|CLAUDE_EFFORT|CLAUDE_AFTER_LAST_COMPACT|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_ENV_FILE)$/;

function sdkDir(stateDir) {
  return process.env.EDITLENS_SDK_DIR || path.join(stateDir, 'sdk');
}

// The SDK's entry file, or null when it is not installed yet.
function sdkEntry(stateDir) {
  const candidates = [
    path.join(sdkDir(stateDir), 'node_modules', SDK_PACKAGE, 'sdk.mjs'),
    path.join(__dirname, '..', 'node_modules', SDK_PACKAGE, 'sdk.mjs'),
  ];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG', 'ELOOP'].includes(err.code)) return false;
    throw err;
  }
}

// The user's claude binary (hooks report CLAUDE_CODE_EXECPATH; on Windows the desktop copy isn't
// on PATH), else PATH and usual install dirs. Null: use the SDK's bundled copy.
function findClaude(reported, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  const p = platform === 'win32' ? path.win32 : path.posix;
  const win = platform === 'win32';
  const names = win ? ['claude.exe'] : ['claude'];
  const candidates = [];
  if (env.EDITLENS_CLAUDE_PATH) candidates.push(env.EDITLENS_CLAUDE_PATH);
  for (const r of reported) if (typeof r === 'string' && r) candidates.push(r);
  for (const dir of String(env.PATH || env.Path || '').split(win ? ';' : ':')) if (dir) for (const n of names) candidates.push(p.join(dir, n));
  candidates.push(p.join(home, '.local', 'bin', names[0]), p.join(home, '.claude', 'local', names[0]));
  if (!win) candidates.push('/usr/local/bin/claude', '/opt/homebrew/bin/claude');
  // The Claude desktop app's own copy (its Code tab), newest version first.
  const appData = win ? env.APPDATA || p.join(home, 'AppData', 'Roaming') : platform === 'darwin' ? p.join(home, 'Library', 'Application Support') : null;
  if (appData) for (const dir of versionDirs(p.join(appData, 'Claude', 'claude-code'))) candidates.push(p.join(appData, 'Claude', 'claude-code', dir, names[0]));
  // Checked on every start: the desktop app's claude.exe moves when the app updates. A .cmd/.ps1
  // shim can't be spawned without a shell; only real executables qualify.
  return candidates.find((c) => isClaudeProgram(c, platform)) || null;
}

// "2.1.293" style folder names, newest first.
function versionDirs(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return [];
    throw err;
  }
  const parts = (n) => n.split('.').map(Number);
  // Each part a safe whole number: a part too long for one would sort as Infinity.
  return names.filter((n) => /^\d+(\.\d+){1,3}$/.test(n) && parts(n).every(Number.isSafeInteger)).sort((a, b) => {
    const x = parts(a);
    const y = parts(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((y[i] || 0) !== (x[i] || 0)) return (y[i] || 0) - (x[i] || 0);
    return 0;
  });
}

// A path reported by a hook or bin/drive.js that is really a claude program.
function isClaudeProgram(file, platform = process.platform) {
  if (typeof file !== 'string' || !file) return false;
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!p.isAbsolute(file)) return false;
  const name = p.basename(file);
  if (!(platform === 'win32' ? /^claude(\.exe)?$/i : /^claude$/).test(name)) return false;
  return isFile(file);
}

// The SDK's bundled Claude: an optional package (absent with --omit=optional).
function runtimePackage(platform = process.platform, arch = process.arch, musl = isMusl()) {
  return `${SDK_PACKAGE}-${platform}-${arch}${platform === 'linux' && musl ? '-musl' : ''}`;
}
function isMusl() {
  if (process.platform !== 'linux' || !process.report || typeof process.report.getReport !== 'function') return false;
  const header = process.report.getReport().header || {};
  return !header.glibcVersionRuntime;
}
function hasRuntime(stateDir, pkg = runtimePackage()) {
  return [path.join(sdkDir(stateDir), 'node_modules'), path.join(__dirname, '..', 'node_modules')]
    .some((dir) => fs.existsSync(path.join(dir, ...pkg.split('/'), 'package.json')));
}

const SIGNIN_TIMEOUT_MS = 10 * 60000;
// Another Claude Code with the same login was renewing it at that moment: busy, not signed out.
const BUSY_SIGNIN_RE = /another Claude Code process is refreshing/i;
const BUSY_RETRY_MS = [2000, 5000, 10000];
// Tests set EDITLENS_BUSY_RETRY_MS to wait less.
function busyDelay(n) {
  const v = Number(process.env.EDITLENS_BUSY_RETRY_MS);
  return Number.isFinite(v) && v >= 0 ? v : BUSY_RETRY_MS[n];
}
const BUSY_TEXT = "Claude's sign-in on this computer was busy (another Claude Code was renewing it) and 3 more tries didn't help. Try again in a minute. No new sign-in is needed.";
// Claude starts with the same login are at least START_GAP_MS apart, so two never renew it at the same time.
const START_GAP_MS = 3000;
const startAt = new Map(); // login (account name, '' for this user) -> earliest next start

async function startGate(key) {
  const now = Date.now();
  const at = Math.max(now, startAt.get(key) || 0);
  startAt.set(key, at + START_GAP_MS);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}
// What Claude Code says when it has no login (or the login expired).
const SIGNED_OUT_RE = /please run \/login|not logged in|invalid api key|oauth token (has )?expired|authentication_error|could not resolve authentication/i;
// Errors that can mention the login but are not about it: the network, a rate limit, a busy
// service. These never ask for a new sign-in; the user is told what happened instead.
const NETWORK_RE = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|fetch failed|connection error|network error|socket hang up|timed out/i;
const RATE_RE = /rate.?limit|too many requests|\b429\b|usage limit/i;
const SERVICE_RE = /overloaded|\b529\b|\b50[0234]\b|internal server error|service unavailable|bad gateway/i;
// -> plain words for an error that is not a missing login, or null.
function notSignInError(text) {
  const t = String(text || '');
  if (BUSY_SIGNIN_RE.test(t)) return BUSY_TEXT;
  if (NETWORK_RE.test(t)) return "Claude couldn't connect to Anthropic's servers: the network on this computer failed or timed out. Check the connection, then try again. No new sign-in is needed.";
  if (RATE_RE.test(t)) return 'Claude reached its usage or rate limit. Wait a few minutes, then try again. No new sign-in is needed.';
  if (SERVICE_RE.test(t)) return "Anthropic's servers were busy or had an error. Try again in a minute. No new sign-in is needed.";
  return null;
}

// The SDK's own copy of the claude program, when it was installed with one.
function runtimeBinary(stateDir, platform = process.platform) {
  const pkg = runtimePackage(platform);
  const name = platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of [path.join(sdkDir(stateDir), 'node_modules'), path.join(__dirname, '..', 'node_modules')]) {
    const f = path.join(dir, ...pkg.split('/'), name);
    if (isFile(f)) return f;
  }
  return null;
}

// `claude auth status` -> true | false | null (can't tell, e.g. older claude).
// account: check that account's own login instead (lib/taskuser.js).
function signedIn(exe, env, account = null) {
  if (!exe) return Promise.resolve(null);
  const cmd = account ? 'runuser' : exe;
  const args = account ? ['-u', account.name, '--', exe, 'auth', 'status', '--json'] : ['auth', 'status', '--json'];
  if (account) env = taskuser.envFor(account, env, account.port);
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout: 20000, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout) => {
      let out = null;
      try {
        out = JSON.parse(String(stdout || '').trim());
      } catch (parseErr) {
        // Inside a callback a throw would end the server: report it as "can't tell" instead.
        if (!(parseErr instanceof SyntaxError)) process.stdout.write(`[signin] auth status: ${parseErr.message}\n`);
      }
      if (out && typeof out.loggedIn === 'boolean') return resolve(out.loggedIn);
      // Signed out can also be a non-zero exit with no JSON; anything else is "can't tell".
      resolve(err && /not (logged|signed) in/i.test(String(stdout || '') + String(err.message || '')) ? false : null);
    });
  });
}

// The text of an SDK message, for spotting "please run /login".
function messageText(msg) {
  const content = msg && msg.message && msg.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c.text === 'string' ? c.text : '')).join(' ');
  return typeof (msg && msg.result) === 'string' ? msg.result : '';
}
function busySignin(msg) {
  return Boolean(msg && msg.type === 'result' && msg.is_error && BUSY_SIGNIN_RE.test(messageText(msg)));
}
function signedOutMessage(msg) {
  if (!msg) return false;
  const text = messageText(msg);
  if (notSignInError(text)) return false;
  if (msg.error === 'authentication_failed') return true;
  // Claude's own short notice, not a reply that happens to mention /login.
  if (msg.type === 'assistant' || (msg.type === 'result' && msg.is_error)) return text.length < 200 && SIGNED_OUT_RE.test(text);
  return false;
}

const CLAUDE_GONE = pagekeep.TEXT['claude-gone'];
// How the claude process ended, in plain words (lib/sdkerr.js); no error: it ended by itself.
// The raw error is logged where it happened.
function plainExit(error) {
  return sdkerr.plainSdk(error).text;
}

const NO_CLAUDE = "Page control couldn't find the Claude program on this computer. Run /editlens control again from Claude Code: it passes the program's location and installs what's missing. If it still fails, set EDITLENS_CLAUDE_PATH to the full path of claude.exe (or claude), then run it again.";

// Permission suggestions, kept to the running session (never written to a settings file).
function sessionOnly(suggestions) {
  return Array.isArray(suggestions) ? suggestions.filter((x) => x && typeof x === 'object').map((x) => ({ ...x, destination: 'session' })) : undefined;
}

function cleanEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!DROP_ENV.test(k)) env[k] = v;
  return env;
}

// The Claude that page control and tasks start always gets this copy of EditLens (SDK plugins option,
// --plugin-dir); Claude Code uses it instead of an installed copy of the same name. An installed copy
// also on for the project (lib/pluginstate.js) is only logged: EDITLENS_PLUGIN_ROOT makes an older
// Claude Code that loads both run only this copy's hooks (hooks/live-hook.js), so no edit appears twice.
const PLUGIN_DIR = path.join(__dirname, '..');

// Claude started without EditLens (its init message lists the plugins it loaded): its edits and
// replies would never appear on the page. -> plain reason | null (loaded, or an older Claude Code
// that does not list them)
function pluginMissing(msg) {
  if (!msg || !Array.isArray(msg.plugins)) return null;
  if (msg.plugins.some((p) => p && p.name === 'editlens')) return null;
  const errs = Array.isArray(msg.plugin_errors) ? msg.plugin_errors.filter((e) => e && /editlens|inline/i.test(String(e.plugin || ''))) : [];
  const why = errs.length && typeof errs[0].message === 'string' ? ` (${clip(errs[0].message, 200)})` : '';
  return `Claude started without the EditLens plugin${why}, so its edits and replies would not appear on this page. ` +
    'Run /plugin in Claude Code and check that editlens is on and allowed for this project (an organization policy can block it), then turn page control on again.';
}

function clip(s, max) {
  const t = String(s == null ? '' : s);
  return t.length > max ? `${sliceSafe(t, max - 1)}…` : t;
}

// One line saying what a tool call wants to do, for the Allow / Deny card.
function describeTool(tool, input) {
  const i = input || {};
  switch (tool) {
    case 'Bash':
      return { title: 'Run a command', detail: clip(i.command, 2000), note: clip(i.description, 200) };
    case 'Edit':
    case 'MultiEdit':
      return { title: 'Edit a file', detail: clip(i.file_path, 400), diff: tool === 'Edit' ? { before: clip(i.old_string, 1500), after: clip(i.new_string, 1500) } : null,
        ...(i.replace_all === true ? { note: 'Changes every match in the file, not only the first.' } : {}) };
    case 'Write':
      return { title: 'Write a file', detail: clip(i.file_path, 400), preview: clip(i.content, 1500) };
    case 'NotebookEdit':
      return { title: 'Edit a notebook', detail: clip(i.notebook_path, 400) };
    case 'WebFetch':
      return { title: 'Get a web page', detail: clip(i.url, 600) };
    case 'WebSearch':
      return { title: 'Search the web', detail: clip(i.query, 400) };
    case 'ExitPlanMode':
      return { title: 'Approve Claude\'s plan', detail: clip(i.plan, 6000) };
    case 'AskUserQuestion':
      return { title: 'Answer Claude\'s question', detail: clip(questionText(i.questions), 3000) };
    default:
      return { title: toolTitle(tool), detail: clip(JSON.stringify(i), 1500) };
  }
}
// AskUserQuestion's questions, each with its options, as lines.
function questionText(questions) {
  if (!Array.isArray(questions)) return '';
  return questions.slice(0, 10).filter((q) => q && typeof q === 'object').map((q) => {
    const options = Array.isArray(q.options) ? q.options.slice(0, 20).filter((o) => o && typeof o.label === 'string') : [];
    return [String(q.question || q.header || ''), ...options.map((o) => `  • ${o.label}${typeof o.description === 'string' && o.description ? `: ${o.description}` : ''}`)].join('\n');
  }).join('\n\n');
}
// An MCP tool's title: EditLens's own live-page tools in words ("List live pages"), another
// server's tool by its name and server ("Use create_issue (github)"). Any other tool: "Use <name>".
function toolTitle(tool) {
  const name = String(tool || '');
  const own = /^mcp__(?:plugin_editlens_)?live-page__([\w-]+)$/.exec(name);
  if (own) {
    const words = own[1].replace(/[_-]+/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : `Use ${name}`;
  }
  const other = /^mcp__([\w-]+?)__([\w-]+)$/.exec(name);
  if (other) {
    // A plugin's server is named plugin_<plugin>_<server>.
    const server = /^plugin_[^_]+_(.+)$/.exec(other[1]);
    return `Use ${other[2]} (${server ? server[1] : other[1]})`;
  }
  return `Use ${name}`;
}

// Messages typed on the page, sent to the SDK as they arrive.
class InputQueue {
  constructor() {
    this.items = [];
    this.waiting = null;
    this.closed = false;
  }

  push(msg) {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: msg, done: false });
    } else this.items.push(msg);
  }

  close() {
    this.closed = true;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class Driver {
  // composed: every message is text written by a paired computer's Claude (a task), never typed by
  // a person: no slash commands, no @file expansion (client_composed).
  // workPrompt: replaces WORK_IN_PLACE when Claude doesn't work in a running app (a sent copy).
  constructor({ emit, log, stateDir, platform, settings, root, onMessage, composed, systemAppend, peer, account, workPrompt, claudePaths }) {
    // Claude programs the hooks reported lately, newest first (read again if the one in use is removed).
    this.claudePaths = typeof claudePaths === 'function' ? claudePaths : () => [];
    this.account = account || null; // run Claude Code as this normal account (lib/taskuser.js)
    this.composed = composed === true;
    // The name of the computer whose Claude writes the messages (a task), sent as a peer origin.
    this.peer = typeof peer === 'string' && peer ? peer.slice(0, 64) : null;
    // Added to the system prompt (a task's note: who gives it work).
    this.systemAppend = typeof systemAppend === 'string' && systemAppend ? systemAppend : '';
    this.workPrompt = typeof workPrompt === 'string' && workPrompt ? workPrompt : WORK_IN_PLACE;
    // As root, Claude Code refuses Bypass permissions; tests set it.
    this.root = typeof root === 'boolean' ? root : isRoot();
    this.onMessage = onMessage || null; // every SDK message, for a task that reports Claude's replies
    this.emit = emit; // (event) -> sends it to pages
    this.settings = settings || null; // () -> the EditLens settings (lib/settings.js)
    this.log = log;
    this.stateDir = stateDir;
    this.platform = platform || process.platform; // tests set 'win32' to test Windows
    this.run = null;
    this.starting = false; // a start is between its first check and this.run being set
    this.stops = 0; // counts stop() calls, so a stop while the SDK loads still counts
    this.lastSignedIn = null; // what the last sign-in check said: true, false, or null (not checked yet)
    this.sdkChecked = { at: 0, installed: false };
  }

  // Can page control start? installed: re-checked at most every 10 s; signedIn: null until the
  // first start.
  readiness() {
    const now = Date.now();
    if (now - this.sdkChecked.at > 10000) this.sdkChecked = { at: now, installed: Boolean(sdkEntry(this.stateDir)) };
    return { installed: this.sdkChecked.installed, signedIn: this.lastSignedIn };
  }

  // The claude program the run uses (null: the SDK's own, or nothing runs). Never sent to pages.
  exePath() {
    return this.run ? this.run.exe || null : null;
  }

  // Page control runs, or is starting (a start is between its first check and this.run being set).
  busy() {
    return Boolean(this.run || this.starting);
  }

  status() {
    const r = this.run;
    if (!r) return this.lastError ? { active: false, lastError: this.lastError } : { active: false };
    return {
      active: true, runId: r.id, phase: r.phase, cwd: r.cwd, sessionId: r.sessionId, fromSessionId: r.from, continued: Boolean(r.from && !r.fork), newChat: Boolean(r.newChat), working: r.working,
      model: r.model, permissions: [...r.permissions.values()].map((p) => p.card), mode: r.mode, agentModes: Object.fromEntries(r.agentModes),
      signin: r.signin ? { url: r.signin.url } : null, retry: Boolean(r.retryText), effort: this.effortOf(r),
      used: Boolean(r.lastText || r.retryText), // a message was sent in this chat
    };
  }

  // The run's effort, in the shape pages and the summary get (lib/effort.js shape()).
  effortOf(run) {
    const e = run && run.effort;
    return e && e.level ? effortLib.shape({ ...e, source: 'page' }) : null;
  }

  // -> { ok, signIn } | { error }. Not signed in: waits in the "signin" phase until the panel's Sign in ends.
  // claudePaths: newest first. effort: the level to start at (lib/effort.js LEVELS); else the setting.
  // fork: resume as a copy of that session (page control started from a session the user still has
  // open); false continues the session itself (a task resuming its own session).
  async start(opts) {
    // Claimed before the first await: two starts at the same time would both pass the check below, and the
    // second run would replace the first.
    if (this.run || this.starting) return { error: 'Claude is already running here. Switch to Manual first.' };
    this.starting = true;
    try {
      return await this.startNow(opts || {});
    } finally {
      this.starting = false;
    }
  }

  async startNow({ cwd, resume, claudePaths, fork = true, effort }) {
    const stops = this.stops;
    this.lastError = null;
    if (typeof cwd !== 'string' || !cwd || !fs.existsSync(cwd)) return { error: 'The project folder does not exist.' };
    if (resume && !SESSION_RE.test(resume)) return { error: 'Bad session id.' };
    const entry = sdkEntry(this.stateDir);
    if (!entry) return { error: 'The Claude Agent SDK is not installed yet. Run /editlens control in Claude Code (it installs it).' };
    // As an account: its own Claude Code (it can't run root's).
    const exe = this.account ? this.account.claude : findClaude(claudePaths || [], { platform: this.platform });
    if (!exe && !hasRuntime(this.stateDir, runtimePackage(this.platform))) return { error: NO_CLAUDE };
    const sdk = await import(pathToFileURL(entry).href);
    if (this.stops !== stops) return { error: 'Page control was stopped.' };
    const run = {
      id: crypto.randomBytes(6).toString('hex'), cwd, from: resume || null, fork: fork !== false, sessionId: null, phase: 'starting', working: false, model: null,
      input: null, permissions: new Map(), query: null, mode: null, bypassOk: false, agentModes: new Map(), taskTool: new Map(), guards: new Map(), startedAt: Date.now(), sdk, exe, launch: 0, retryText: null, signin: null,
      claudePaths: Array.isArray(claudePaths) ? claudePaths.filter((p) => typeof p === 'string') : [], goneTries: 0,
      // level: asked for (null: Auto and Claude Code's settings name none, so none is sent and
      // readEffort takes Claude's own); used, supported, cap: what Claude reports (readEffort).
      effort: { level: effortLib.isLevel(effort) ? effort : effortLib.fromSettings(this.settings ? this.settings() : null, cwd), used: null, supported: null, cap: null, fromSetting: !effortLib.isLevel(effort) },
      modelInfo: undefined, // the model's ModelInfo from supportedModels(); null: not listed
    };
    this.run = run;
    this.emit({ type: 'drive', phase: 'starting', cwd, fromSessionId: run.from });
    await startGate(this.account ? this.account.name : '');
    if (this.run !== run) return { error: 'Page control was stopped.' };
    const ok = await signedIn(exe || runtimeBinary(this.stateDir, this.platform), cleanEnv(), this.account);
    if (ok !== null) this.lastSignedIn = ok;
    if (this.run !== run) return { error: 'Page control was stopped.' };
    if (ok === false) {
      this.needSignIn(run, 'signed-out');
      return { ok: true, signIn: true };
    }
    return this.launch(run);
  }

  launch(run) {
    // The program it used has been removed (Claude Code updated): use the current one, as a start would.
    if (run.exe && !this.account && !isFile(run.exe)) {
      const was = run.exe;
      run.exe = this.findAgain(run, was);
      this.log(`drive: ${was} was removed; ${run.exe ? `using ${run.exe}` : 'using the SDK\'s own claude'}`);
      if (!run.exe && !hasRuntime(this.stateDir, runtimePackage(this.platform))) {
        const error = `${CLAUDE_GONE} No other Claude program was found on this computer. Run /editlens control in Claude Code.`;
        this.finish(run, error, null, { reason: 'claude-gone' });
        return { error };
      }
    }
    const id = ++run.launch;
    run.input = new InputQueue();
    run.phase = 'starting';
    const options = {
      cwd: run.cwd,
      // EDITLENS_DRIVEN: tells its hooks the panel shows the questions here (no second copy).
      env: { ...cleanEnv(), EDITLENS_DRIVEN: '1', ...(this.account ? this.accountSettings() : { EDITLENS_PLUGIN_ROOT: PLUGIN_DIR }) },
      canUseTool: (tool, input, opts) => this.ask(run, tool, input, opts),
      // Lets the panel switch to Bypass permissions later; it stays off until the user confirms
      // it in the EditLens window (setMode), and a start-up in Bypass is switched back to Ask. Claude Code
      // refuses to start with it as root, so a root user gets no Bypass at all.
      allowDangerouslySkipPermissions: !this.root,
      // The mode picked in the settings (never Bypass); the panel can change it any time.
      permissionMode: settingsLib.modeId(this.settings ? this.settings() : null),
      // The level the run has (a restart of Claude keeps the one the page picked since).
      ...(run.effort.level ? { effort: run.effort.level } : {}),
      hooks: { PreToolUse: [{ hooks: [async (input) => this.agentRule(run, input)] }] },
      // Claude works in the app that is already running on the page: it must not start it again.
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.systemAppend ? `${this.workPrompt}\n\n${this.systemAppend}` : this.workPrompt },
      ...(run.from ? { resume: run.from, forkSession: run.fork } : {}),
      ...(run.exe ? { pathToClaudeCodeExecutable: run.exe } : {}),
      // An account loads the copy it can read (its own Claude Code has no EditLens installed).
      plugins: [{ type: 'local', path: this.account ? this.account.plugin : PLUGIN_DIR }],
      ...(this.account ? { spawnClaudeCodeProcess: taskuser.spawner(this.account, this.account.port) } : {}),
      stderr: (line) => this.log('drive:', clip(line, 400)),
    };
    if (!this.account) {
      const ps = pluginState(run.cwd);
      this.log(`drive: EditLens passed to Claude directly from ${PLUGIN_DIR}${ps.active ? ' (an installed copy is also on for this project; Claude Code uses the one passed)' : ` (${ps.why})`}`);
    }
    this.log(`drive: starting in ${run.cwd}${run.from ? (run.fork ? ` from a copy of ${run.from}` : ` resuming ${run.from}`) : ''}${run.exe ? ` with ${run.exe}` : ' with the SDK\'s own claude'}${this.account ? ` as ${this.account.name}` : ''}`);
    try {
      run.query = run.sdk.query({ prompt: run.input, options });
    } catch (err) {
      this.log('drive: claude could not start:', err.message);
      const error = /native cli binary|claude code executable|pathToClaudeCodeExecutable/i.test(err.message) ? NO_CLAUDE : `Claude could not start. ${sdkerr.plainSdk(err.message, sdkerr.SEE_LOG).text}`;
      // Pages may already show "starting": tell them it ended.
      this.finish(run, error);
      return { error };
    }
    this.emit({ type: 'drive', phase: 'starting', cwd: run.cwd, fromSessionId: run.from });
    this.consume(run, id);
    this.loadCommands(run, id);
    // A message typed while Claude waited for the sign-in is sent now.
    if (run.retryText) {
      const text = run.retryText;
      run.retryText = null;
      this.send(text);
    }
    return { ok: true };
  }

  // No login: stop the session that can't work, keep the page in control, and ask the user to sign in.
  needSignIn(run, reason) {
    // The message that got "please run /login" is sent again after the sign-in.
    if (!run.retryText && run.working && run.lastText) run.retryText = run.lastText;
    run.launch++; // the old session's messages no longer count
    run.phase = 'signin';
    run.working = false;
    this.lastSignedIn = false;
    if (run.input) run.input.close();
    try {
      if (run.query && typeof run.query.close === 'function') run.query.close();
    } catch (err) {
      this.log('drive: close failed:', err.message);
    }
    run.query = null;
    this.emit({ type: 'drive', phase: 'signin', cwd: run.cwd, reason, retry: Boolean(run.retryText) });
  }

  // Runs `claude auth login` (opens the browser). Credentials stay with claude, never here.
  signIn({ console: useConsole } = {}) {
    const run = this.run;
    if (!run) return { error: 'Claude is not running here.' };
    // The user signs in for an account themselves, in that account (docs/pairing.md, "Tasks as a normal
    // account").
    if (this.account) return { error: `The ${this.account.name} account signs in on its own: su - ${this.account.name}, then claude, then /login.` };
    if (run.phase !== 'signin') return { error: 'Claude is already signed in.' };
    if (run.signin) return { ok: true, already: true };
    const exe = run.exe || runtimeBinary(this.stateDir, this.platform);
    if (!exe) return { error: NO_CLAUDE };
    let child;
    try {
      child = spawn(exe, ['auth', 'login', ...(useConsole ? ['--console'] : ['--claudeai'])], { env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return { error: `Could not start the sign-in: ${plainError(err)}` };
    }
    // Writing the code after the child exited is EPIPE: an error event, not a crash.
    child.stdin.on('error', (err) => process.stdout.write(`[signin] could not send the code: ${err.code || err.message}\n`));
    const signin = { child, url: null, tail: '', timer: null };
    run.signin = signin;
    const emit = (state, extra) => this.emit({ type: 'drive-signin', cwd: run.cwd, state, ...extra });
    const read = (chunk) => {
      const text = String(chunk).replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
      signin.tail = (signin.tail + text).slice(-2000);
      const m = /https:\/\/[^\s"'<>]+/.exec(text);
      if (m && !signin.url) {
        signin.url = m[0];
        emit('waiting', { url: signin.url });
      }
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (err) => {
      if (run.signin !== signin) return;
      run.signin = null;
      clearTimeout(signin.timer);
      emit('failed', { error: `Could not start the sign-in: ${plainError(err)}` });
    });
    child.on('close', async (code) => {
      if (run.signin !== signin) return;
      run.signin = null;
      clearTimeout(signin.timer);
      const ok = code === 0 ? await signedIn(exe, cleanEnv()) : false;
      if (ok !== null) this.lastSignedIn = ok;
      if (this.run !== run) return;
      if (ok === false) {
        const last = signin.tail.split('\n').map((l) => l.trim()).filter((l) => l && !/^https:/.test(l) && !/paste code/i.test(l)).pop();
        return emit('failed', { error: `The sign-in didn't finish${last ? `: ${last}` : '.'}` });
      }
      emit('done', {});
      const out = this.launch(run);
      if (out.error) {
        this.run = run; // finish() reports it
        this.finish(run, out.error);
      }
    });
    signin.timer = setTimeout(() => {
      if (run.signin !== signin) return;
      child.kill();
    }, SIGNIN_TIMEOUT_MS);
    emit('started', { console: Boolean(useConsole) });
    return { ok: true };
  }

  // The code the sign-in page shows when the browser can't send it back by itself; it is sent
  // to "claude auth login", which is waiting for it.
  signInCode(code) {
    const s = this.run && this.run.signin;
    if (!s) return { error: 'No sign-in is waiting for a code.' };
    const c = typeof code === 'string' ? code.trim() : '';
    if (!c || c.length > 2000 || /[\r\n]/.test(c)) return { error: 'That code is not valid.' };
    if (s.child.exitCode !== null || s.child.stdin.destroyed) return { error: 'The sign-in already ended. Start it again.' };
    s.child.stdin.write(c + '\n');
    return { ok: true };
  }

  cancelSignIn() {
    const s = this.run && this.run.signin;
    if (!s) return { ok: true };
    this.run.signin = null;
    clearTimeout(s.timer);
    s.child.kill();
    this.emit({ type: 'drive-signin', cwd: this.run.cwd, state: 'cancelled' });
    return { ok: true };
  }

  async consume(run, id) {
    let error = null;
    const query = run.query;
    try {
      for await (const msg of query) {
        if (this.run !== run || run.launch !== id) break;
        if (busySignin(msg) && (run.busyTries || 0) < BUSY_RETRY_MS.length && run.lastText) {
          // Sent again after a pause; the result is not passed on, so nothing reads it as signed out.
          const n = run.busyTries || 0;
          run.busyTries = n + 1;
          this.log(`drive: the sign-in was busy, trying again (${n + 1} of ${BUSY_RETRY_MS.length})`);
          const text = run.lastText;
          const timer = setTimeout(() => {
            if (this.run === run && run.launch === id) this.send(text);
          }, busyDelay(n));
          if (timer.unref) timer.unref();
          continue;
        }
        // The conversation to continue isn't there: the error that follows starts a new one (newChat).
        if (msg.type === 'result' && msg.is_error && run.from && sdkerr.notFound([messageText(msg), ...(Array.isArray(msg.errors) ? msg.errors : [])].join(' '))) {
          run.notFound = true;
          continue;
        }
        if (msg.type === 'result' && !msg.is_error) run.busyTries = 0;
        if (this.onMessage) this.onMessage(busySignin(msg) ? { ...msg, result: BUSY_TEXT } : msg);
        if (signedOutMessage(msg)) {
          this.log('drive: claude is not signed in');
          this.needSignIn(run, 'signed-out');
          return;
        }
        if (msg.type === 'system' && (msg.subtype === 'init' || msg.subtype === 'status') && msg.permissionMode) this.noteMode(run, msg.permissionMode);
        if (msg.type === 'system' && msg.subtype === 'task_started' && typeof msg.task_id === 'string' && typeof msg.tool_use_id === 'string') {
          // The subagent's id (in its tool calls) and the Agent call that started it (the panel's card).
          run.taskTool.set(msg.task_id, msg.tool_use_id);
          if (run.taskTool.size > 500) run.taskTool.delete(run.taskTool.keys().next().value);
        }
        if (msg.type === 'system' && msg.subtype === 'init' && pluginMissing(msg)) {
          // Never run without EditLens: nothing Claude does would appear on the page.
          const why = pluginMissing(msg);
          this.log(`drive: Claude started without EditLens in ${run.cwd}; plugins: ${clip(JSON.stringify(msg.plugins), 300)}`);
          this.stop('Claude started without EditLens', null, { by: 'no-plugin', error: why });
          return;
        }
        if (msg.type === 'system' && msg.subtype === 'init') {
          run.sessionId = msg.session_id;
          run.model = msg.model || null;
          if (run.phase === 'starting') run.phase = 'ready';
          this.emit({ type: 'drive', phase: 'ready', cwd: run.cwd, sessionId: run.sessionId, fromSessionId: run.from, model: run.model, effort: this.effortOf(run), fromSetting: run.effort.fromSetting === true });
          this.readEffort(run, id);
        } else if (msg.type === 'result') {
          run.working = false;
          this.emit({ type: 'drive', phase: 'idle', cwd: run.cwd, sessionId: run.sessionId, isError: Boolean(msg.is_error), subtype: msg.subtype || null });
        }
      }
    } catch (err) {
      error = err.message;
      this.log('drive: session failed:', err.stack || err.message);
    }
    if (this.run === run && run.launch === id) {
      const plain = error ? notSignInError(error) : null;
      if (plain) error = plain;
      else if (error && SIGNED_OUT_RE.test(error)) return this.needSignIn(run, 'signed-out');
      // The Claude program was removed while it ran (Claude Code updated and removed its folder).
      if (run.exe && !this.account && !isFile(run.exe)) return this.claudeGone(run, error);
      // The conversation to continue doesn't exist (not written yet, or kept elsewhere): a new one, now.
      if (run.from && !run.newChat && (run.notFound || sdkerr.notFound(error))) return this.newChat(run);
      // The SDK's loop also ends with no error when Claude exits by itself: never switch to Manual silently.
      const why = sdkerr.plainSdk(error);
      this.log(`drive: Claude stopped by itself in ${run.cwd}${error ? `: ${error}` : ' (no error given)'}`);
      this.finish(run, why.text, null, { reason: why.kind === 'exit' ? 'claude-exit' : 'error' });
    }
  }

  // Starts a new conversation in the same run when the one to continue wasn't found, and says so.
  newChat(run) {
    this.log(`drive: the conversation ${run.from} wasn't found; starting a new one in ${run.cwd}`);
    run.newChat = true;
    run.from = null;
    run.fork = true;
    // A message sent before Claude failed is sent again to the new one.
    if (run.working && run.lastText && !run.retryText) run.retryText = run.lastText;
    run.working = false;
    const out = this.launch(run);
    if (!out.error) this.emit({ type: 'drive-note', cwd: run.cwd, text: sdkerr.NEW_CHAT, newChat: true });
  }

  // The claude program in use was removed: page control continues the same conversation with the
  // current one (the lookup /editlens control uses), or ends saying why.
  claudeGone(run, error) {
    const gone = run.exe;
    const exe = run.goneTries < 3 ? this.findAgain(run, gone) : null;
    run.goneTries++;
    this.log(`drive: the Claude program ${gone} was removed${error ? ` (${error})` : ''}; ${exe ? `continuing with ${exe}` : 'no other one was found'}`);
    if (!exe && (run.goneTries > 3 || !hasRuntime(this.stateDir, runtimePackage(this.platform)))) {
      return this.finish(run, `${CLAUDE_GONE} No other Claude program was found on this computer. Run /editlens control in Claude Code.`, null, { reason: 'claude-gone' });
    }
    // Questions the old process asked can't be answered any more.
    for (const p of [...run.permissions.values()]) p.answer('deny');
    run.exe = exe;
    if (run.sessionId) {
      run.from = run.sessionId;
      run.fork = false;
    }
    run.working = false;
    const out = this.launch(run);
    if (out.error) return undefined; // the start attempt ended it and said why
    this.emit({ type: 'drive-note', cwd: run.cwd, text: pagekeep.backText('claude-gone', { exe }) });
    return undefined;
  }

  // The claude program to use instead of `gone`. -> path | null
  findAgain(run, gone) {
    const paths = [...this.claudePaths(), ...run.claudePaths].filter((p) => p !== gone);
    return findClaude(paths, { platform: this.platform });
  }

  // After start(): resolves once Claude responded (ready, idle, sign-in) or stopped. -> { ok } | { error }
  async started(timeoutMs = 20000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const st = this.status();
      if (!st.active) return { error: (st.lastError && st.lastError.error) || 'Claude stopped right after starting.' };
      if (st.phase !== 'starting') return { ok: true };
      if (Date.now() > end) return { ok: true, slow: true };
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  // Also completes Claude's start-up, so the panel can say "ready" before the first message.
  async loadCommands(run, id) {
    try {
      const list = await run.query.supportedCommands();
      if (this.run !== run || run.launch !== id || !Array.isArray(list)) return;
      if (run.phase === 'starting') {
        run.phase = 'ready';
        this.emit({ type: 'drive', phase: 'ready', cwd: run.cwd, fromSessionId: run.from });
      }
      this.emit({ type: 'drive-commands', cwd: run.cwd, commands: list.slice(0, 300).map((c) => ({ name: clip(c.name, 80), description: clip(c.description, 200), argumentHint: clip(c.argumentHint || '', 80) })) });
    } catch (err) {
      this.log('drive: no command list:', err.message);
    }
  }

  // text: a string, or content blocks (pasted screenshots, then the text) from the page.
  send(text) {
    const run = this.run;
    if (!run) return { error: 'Claude is not running here.' };
    if (run.phase === 'signin' || !run.input) {
      // Sent once Claude is signed in and running.
      run.retryText = text;
      if (run.phase === 'signin') this.emit({ type: 'drive', phase: 'signin', cwd: run.cwd, reason: 'waiting', retry: true });
      return { ok: true, waiting: true };
    }
    run.lastText = text;
    run.working = true;
    // Typed by the user on their own page: a human prompt, like typing into Claude Code. A task's
    // text was written by another computer's Claude: delivered as written, so a leading "/" is
    // never run as a command (/login, /editlens join...).
    run.input.push(this.composed
      // A peer origin (checked on Claude Code 2.1.295: acted on, not kept waiting; never "human").
      ? { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, client_composed: true, ...(this.peer ? { origin: { kind: 'peer', from: this.peer, fromMode: 'prompting', name: this.peer } } : {}) }
      : { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, origin: { kind: 'human' } });
    this.emit({ type: 'drive', phase: 'working', cwd: run.cwd, sessionId: run.sessionId });
    return { ok: true };
  }

  // Bypass not confirmed in the EditLens window (e.g. a settings defaultMode) reverts to the plugin's mode.
  noteMode(run, mode) {
    if (!modes.isMode(mode)) return;
    if (mode === 'bypassPermissions' && !run.bypassOk) {
      const safe = settingsLib.modeId(this.settings ? this.settings() : null);
      run.mode = safe;
      Promise.resolve(run.query && run.query.setPermissionMode(safe)).catch((err) => this.log('drive: could not turn off Bypass permissions:', err.message));
      this.emit({ type: 'drive-mode', cwd: run.cwd, mode: safe, agentModes: Object.fromEntries(run.agentModes), note: 'Your settings start Claude in Bypass permissions. Page control starts in ' + (MODE_NAMES[safe] || safe) + ' instead; pick Bypass permissions in the mode menu to turn it on.' });
      return;
    }
    if (run.mode === mode) return;
    run.mode = mode;
    this.emit({ type: 'drive-mode', cwd: run.cwd, mode, agentModes: Object.fromEntries(run.agentModes) });
  }

  // From the panel's mode menu or Alt+M. Bypass needs confirm: true (allowed in the EditLens window first).
  async setMode(mode, { confirm } = {}) {
    const run = this.run;
    if (!run || !run.query) return { error: 'Claude is not running here.' };
    if (!modes.isMode(mode)) return { error: 'Unknown permission mode.' };
    if (mode === 'bypassPermissions' && confirm !== true) return { error: 'Bypass permissions needs a confirmation in the EditLens window.' };
    if (mode === 'bypassPermissions' && this.root) return { error: BYPASS_ROOT };
    if (mode === 'bypassPermissions') run.bypassOk = true;
    try {
      await run.query.setPermissionMode(mode);
    } catch (err) {
      if (mode === 'bypassPermissions') run.bypassOk = false;
      this.log('drive: permission mode change failed:', err.message);
      return { error: `Claude didn't switch. ${sdkerr.plainSdk(err.message, sdkerr.SEE_LOG).text}` };
    }
    if (mode !== 'bypassPermissions') run.bypassOk = false;
    this.noteMode(run, mode);
    return { ok: true, mode };
  }

  // A subagent's own mode; mode null = same as Claude. agent: the panel's card key (the Agent
  // call id) or the subagent's id.
  setAgentMode(agent, mode, { confirm } = {}) {
    const run = this.run;
    if (!run) return { error: 'Claude is not running here.' };
    if (typeof agent !== 'string' || !/^[\w-]{1,100}$/.test(agent)) return { error: 'Unknown subagent.' };
    if (mode !== null && !modes.AGENT_MODES.includes(mode)) return { error: 'Unknown permission mode.' };
    if (mode === 'bypassPermissions' && confirm !== true) return { error: 'Bypass permissions needs a confirmation in the EditLens window.' };
    if (mode === 'bypassPermissions' && this.root) return { error: BYPASS_ROOT };
    if (mode === null) run.agentModes.delete(agent);
    else run.agentModes.set(agent, mode);
    if (run.agentModes.size > 200) run.agentModes.delete(run.agentModes.keys().next().value);
    this.emit({ type: 'drive-mode', cwd: run.cwd, mode: run.mode, agentModes: Object.fromEntries(run.agentModes) });
    return { ok: true };
  }

  // Stop one subagent (the Agents switcher's Stop); Claude continues with the rest of its turn.
  // agent: the subagent's id, or the Agent call that started it.
  async stopAgent(agent) {
    const run = this.run;
    if (!run || !run.query) return { error: 'Claude is not running here.' };
    let id = typeof agent === 'string' && run.taskTool.has(agent) ? agent : null;
    if (!id) for (const [task, tool] of run.taskTool) if (tool === agent) id = task;
    if (!id) return { error: "That subagent isn't running in page control." };
    if (typeof run.query.stopTask !== 'function') return { error: "This Claude Agent SDK can't stop one subagent. Use Stop to interrupt Claude." };
    try {
      await run.query.stopTask(id);
    } catch (err) {
      this.log('drive: subagent stop failed:', err.message);
      return { error: `The subagent didn't stop. ${sdkerr.plainSdk(err.message, sdkerr.SEE_LOG).text}` };
    }
    return { ok: true };
  }

  // From the panel's effort menu, a task card, /editlens effort or the Effort setting: applies from
  // Claude's next step, even mid-turn. level: one of lib/effort.js LEVELS, nothing else.
  // fromSetting: a change of the Effort setting, not a level picked for page control.
  // -> { ok, effort } | { error }
  async setEffort(level, { fromSetting = false } = {}) {
    if (!effortLib.isLevel(level)) return { error: effortLib.BAD_LEVEL };
    const run = this.run;
    if (!run) return { error: 'Claude is not running here.' };
    const was = run.effort;
    run.effort = { ...was, level, fromClaude: false, fromSetting: fromSetting === true };
    // Not started yet (a sign-in): the level is used when Claude starts.
    if (!run.query) {
      this.emitEffort(run);
      return { ok: true, effort: this.effortOf(run) };
    }
    if (typeof run.query.applyFlagSettings !== 'function') {
      run.effort = was;
      return { error: "This Claude Agent SDK can't change the effort while Claude runs. Run /editlens control again in Claude Code to update it." };
    }
    try {
      await run.query.applyFlagSettings({ effortLevel: level });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (this.run === run) run.effort = was;
      this.log('drive: effort change failed:', err.message);
      return { error: `Claude didn't change its effort. ${sdkerr.plainSdk(err.message, sdkerr.SEE_LOG).text}` };
    }
    if (this.run !== run) return { error: 'Page control was stopped.' };
    await this.readEffort(run, run.launch);
    return { ok: true, effort: this.effortOf(run) };
  }

  // The Effort setting is Auto and Claude Code's settings name no level: the level EditLens set is
  // cleared (applyFlagSettings null), so Claude uses its own level again. -> { ok, effort } | { error }
  async clearEffort() {
    const run = this.run;
    if (!run) return { error: 'Claude is not running here.' };
    const was = run.effort;
    run.effort = { level: null, used: null, supported: null, cap: null };
    // Not started yet (a sign-in): none is sent when Claude starts.
    if (!run.query) return { ok: true, effort: null };
    if (typeof run.query.applyFlagSettings !== 'function') {
      run.effort = was;
      return { error: "This Claude Agent SDK can't change the effort while Claude runs. Run /editlens control again in Claude Code to update it." };
    }
    try {
      await run.query.applyFlagSettings({ effortLevel: null });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (this.run === run) run.effort = was;
      this.log('drive: effort change failed:', err.message);
      return { error: `Claude didn't change its effort. ${sdkerr.plainSdk(err.message, sdkerr.SEE_LOG).text}` };
    }
    if (this.run !== run) return { error: 'Page control was stopped.' };
    await this.readEffort(run, run.launch);
    return { ok: true, effort: this.effortOf(run) };
  }

  emitEffort(run) {
    this.emit({ type: 'drive-effort', cwd: run.cwd, sessionId: run.sessionId, effort: this.effortOf(run), fromSetting: Boolean(run.effort && run.effort.fromSetting) });
  }

  // What Claude really uses after a level was asked for: Claude Code's get_settings (applied.effort,
  // after caps and the model's own limits) and the model's levels (supportedModels()). Older SDKs
  // have neither: then only the level asked for is known.
  async readEffort(run, id) {
    const q = run.query;
    if (!q) return;
    let applied = null;
    let appliedKnown = false;
    let settingsCap = null;
    if (typeof q.getSettings === 'function') {
      try {
        const s = await q.getSettings();
        if (s && s.applied && typeof s.applied === 'object' && 'effort' in s.applied) {
          applied = typeof s.applied.effort === 'string' ? s.applied.effort : null;
          appliedKnown = true;
        }
        const eff = s && s.effective && typeof s.effective === 'object' ? s.effective : null;
        if (eff && effortLib.isLevel(eff.maxEffortLevel)) settingsCap = eff.maxEffortLevel;
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        this.log('drive: could not read the effort Claude uses:', err.message);
      }
    }
    if (run.modelInfo === undefined && run.model && typeof q.supportedModels === 'function') {
      try {
        const list = await q.supportedModels();
        const bare = String(run.model).replace(/\[1m\]$/i, '');
        run.modelInfo = (Array.isArray(list) ? list : []).find((m) => m && (m.value === run.model || m.value === bare || m.resolvedModel === run.model || m.resolvedModel === bare)) || null;
      } catch (err) {
        if (!(err instanceof Error)) throw err;
        this.log('drive: no model list:', err.message);
        run.modelInfo = null;
      }
    }
    if (this.run !== run || run.launch !== id) return;
    const m = run.modelInfo || null;
    // None was sent (Auto): Claude's own level is the one the page shows and changes from. A model
    // without effort gets the default, so its chip can say "Effort not used".
    if (!run.effort.level && (effortLib.isLevel(applied) || (appliedKnown && applied === null))) run.effort = { ...run.effort, level: applied || effortLib.DEFAULT, fromClaude: true };
    const r = effortLib.resolve({
      requested: run.effort.level, applied, appliedKnown, settingsCap,
      models: m && Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : null,
      supports: m && typeof m.supportsEffort === 'boolean' ? m.supportsEffort : null,
    });
    run.effort = { ...run.effort, ...r };
    this.emitEffort(run);
  }

  // The account's Claude Code has none of this user's plugin settings, so its hooks would use the
  // defaults: they get this user's Subagent copies and Safety check when Off (setting values only).
  // Read when Claude starts; the safety check here (agentRule) also follows later changes.
  accountSettings() {
    return {
      ...(this.setting('subagent_copies') === false ? { EDITLENS_SUBAGENT_COPIES: 'off' } : {}),
      ...(this.setting('safety_check') === false ? { EDITLENS_GUARD: 'off' } : {}),
    };
  }

  setting(key) {
    const values = this.settings ? this.settings() : null;
    return values && key in values ? values[key] : settingsLib.defaults()[key];
  }

  agentModeOf(run, agentId) {
    if (!agentId) return null;
    return run.agentModes.get(agentId) || run.agentModes.get(run.taskTool.get(agentId)) || null;
  }

  // PreToolUse hook in the page-controlled session: applies a subagent's own mode.
  async agentRule(run, input) {
    // Never its own approval endpoints or EditLens's keys (lib/selfguard.js).
    // Nor /editlens new: a message from the page is never the user typing it.
    const self = input && ['Bash', 'PowerShell', 'WebFetch'].includes(input.tool_name)
      && (selfCall(input.tool_name, input.tool_input || {}, { stateDir: this.stateDir, ports: editlensPorts({ ...config, stateDir: this.stateDir }) })
        || (startsNew(input.tool_name, input.tool_input) ? NEW_REASON : null));
    if (self) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: self } };
    // Refused here too, so no mode (Bypass included) lets the question through without an answer.
    if (input && input.tool_name === QUESTION_TOOL) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: QUESTION_REFUSAL } };
    // A subagent's mode that refuses (Plan) is checked before the safety check, so a question can't turn
    // a refusal into an approval (Sol M2). Without its own mode, Claude's Plan refuses the live-page
    // tools that change something.
    const mode = input && this.agentModeOf(run, input.agent_id);
    const d = mode ? modes.agentDecision(mode, run.mode, input.tool_name, input.tool_input || {}, run.cwd)
      : input ? modes.sessionDecision(run.mode, input.tool_name) : null;
    if (d && d.decision === 'deny') return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: d.reason } };
    // Then the safety check, for Claude and every subagent, in every mode: a write that replaces
    // most of a file, or an edit that removes EditLens from the app, is always asked about.
    const g = input && await guard.checkAsync(input.tool_name, input.tool_input || {}, run.cwd, { off: this.setting('safety_check') === false });
    if (g) {
      if (input.tool_use_id) {
        run.guards.set(input.tool_use_id, g);
        while (run.guards.size > 50) run.guards.delete(run.guards.keys().next().value);
      }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: g.reason } };
    }
    if (!d) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } };
  }

  ask(run, tool, input, opts) {
    if (tool === QUESTION_TOOL) return Promise.resolve({ behavior: 'deny', message: QUESTION_REFUSAL });
    return new Promise((resolve) => {
      const id = crypto.randomBytes(6).toString('hex');
      const agentId = opts && typeof opts.agentID === 'string' ? opts.agentID : null;
      const card = { id, tool: clip(tool, 120), ...describeTool(tool, input), canAlways: Array.isArray(opts && opts.suggestions) && opts.suggestions.length > 0, ts: Date.now(),
        agentId, agentKey: agentId ? run.taskTool.get(agentId) || null : null, agentMode: this.agentModeOf(run, agentId) };
      const g = opts && opts.toolUseID ? run.guards.get(opts.toolUseID) : null;
      if (g) {
        run.guards.delete(opts.toolUseID);
        card.title = g.kind === 'integration' ? 'Remove EditLens from the app' : 'Replace most of a file';
        card.warning = g.reason;
        card.canAlways = false; // this question is asked again every time
      }
      const signal = opts && opts.signal ? opts.signal : null;
      const done = (decision, result) => {
        if (!run.permissions.has(id)) return;
        run.permissions.delete(id);
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', cancel);
        this.emit({ type: 'permission-done', id, decision, cwd: run.cwd });
        resolve(result);
      };
      // Removed again by done(), so a signal used for several questions keeps no listener per answer.
      const cancel = () => done('cancelled', { behavior: 'deny', message: 'Cancelled.' });
      const timer = setTimeout(() => done('timeout', { behavior: 'deny', message: 'Nobody answered the permission question in the EditLens window in 10 minutes.' }), PERMISSION_TIMEOUT_MS);
      run.permissions.set(id, {
        card,
        answer: (decision) => {
          if (decision === 'allow' || (decision === 'always' && !card.canAlways)) done('allow', { behavior: 'allow', updatedInput: input });
          // "Always" lasts for this session only, as the card says: the SDK's suggestions usually
          // name the project's settings file, which would keep a rule an agent proposed forever.
          else if (decision === 'always') done('always', { behavior: 'allow', updatedInput: input, updatedPermissions: sessionOnly(opts && opts.suggestions) });
          else done('deny', { behavior: 'deny', message: `The user denied this in the ${PRODUCT_NAME} panel.` });
        },
      });
      if (signal) signal.addEventListener('abort', cancel, { once: true });
      this.emit({ type: 'permission', cwd: run.cwd, sessionId: run.sessionId, ...card });
    });
  }

  answer(id, decision) {
    const p = this.run && this.run.permissions.get(String(id));
    if (!p) return { error: 'That question was already answered.' };
    p.answer(decision);
    return { ok: true };
  }

  async interrupt() {
    const run = this.run;
    if (!run || !run.query) return { error: 'Claude is not running here.' };
    try {
      await run.query.interrupt();
    } catch (err) {
      this.log('drive: interrupt failed:', err.message);
      return { error: `Could not stop Claude. ${sdkerr.plainSdk(err.message, sdkerr.SEE_LOG).text}` };
    }
    return { ok: true };
  }

  // note: what the project's pages say instead of the plain "Manual control" notice.
  // by: 'user' (Manual, /editlens manual), 'moved' (to another project; report: why, for a page of
  // this project that opens later) or 'shutdown' (the server stops; it says why itself).
  // error: why, when the user didn't choose it (a restart).
  stop(why, note, { by = 'user', report = null, error = null } = {}) {
    this.stops++;
    const run = this.run;
    if (!run) return { ok: true };
    this.log('drive: stopping', why || '');
    for (const p of [...run.permissions.values()]) p.answer('deny');
    if (run.signin) this.cancelSignIn();
    if (run.input) run.input.close();
    try {
      if (run.query && typeof run.query.close === 'function') run.query.close();
    } catch (err) {
      this.log('drive: close failed:', err.message);
    }
    this.finish(run, error, note, { reason: by, report });
    return { ok: true };
  }

  // reason: why it ended ('user', 'moved', 'shutdown', 'error', 'claude-exit', 'claude-gone').
  // report: kept like an error (not shown as one now) for pages that open later.
  finish(run, error, note, { reason = error ? 'error' : 'user', report = null } = {}) {
    if (this.run !== run) return;
    this.run = null;
    // Kept for the panel and the Claude Code line: an end the user didn't choose must not look like Manual.
    const kept = error || report;
    this.lastError = kept ? { error: clip(kept, 400), at: Date.now(), cwd: run.cwd, reason } : null;
    this.emit({ type: 'drive', phase: 'ended', cwd: run.cwd, sessionId: run.sessionId, reason, error: error ? clip(error, 400) : null, ...(note ? { note: clip(note, 400) } : {}) });
  }
}

const BYPASS_ROOT = 'Bypass permissions isn\'t available here: Claude Code refuses it when it runs as root. Run Claude Code as a normal user to use it.';
function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

module.exports = { pluginMissing, PLUGIN_DIR, plainExit, BUSY_SIGNIN_RE, BUSY_TEXT, busySignin, notSignInError, isRoot, sessionOnly, Driver, InputQueue, describeTool, sdkEntry, sdkDir, findClaude, versionDirs, isClaudeProgram, runtimePackage, hasRuntime, runtimeBinary, signedIn, signedOutMessage, cleanEnv, SDK_PACKAGE, NO_CLAUDE };
