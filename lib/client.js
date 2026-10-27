'use strict';
// Hook-side helpers: start the live server when needed and post events to it.
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');
const { trimLog } = require('./logtrim');
const { migrateState, legacyDir } = require('./migrate');

const OWN_ROOT = path.join(__dirname, '..');

// The largest answer read; EditLens's own answers are far smaller.
const ANSWER_MAX = 64 * 1024 * 1024;

function request(method, urlPath, body, timeoutMs, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    // An incomplete response, or one that never ends, fails as "no answer" (ETIMEDOUT) instead of
    // waiting forever (Sol M8). The whole request has a limit too, not only each wait for data.
    let settled = false;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(value);
    };
    const noAnswer = (why) => Object.assign(new Error(why), { code: 'ETIMEDOUT' });
    const req = http.request(
      {
        host: config.host,
        port: config.port,
        path: urlPath,
        method,
        timeout: timeoutMs,
        // A new connection each time: a keep-alive connection to a server that has restarted fails
        // with ECONNRESET and would look like no server at all.
        agent: false,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers } : headers,
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        res.on('data', (c) => {
          bytes += c.length;
          if (bytes <= ANSWER_MAX) return chunks.push(c);
          req.destroy();
          return done(Object.assign(new Error(`the answer is over ${ANSWER_MAX} bytes`), { code: 'E2BIG' }));
        });
        res.on('end', () => done(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', () => done(noAnswer('the response ended early')));
        res.on('close', () => { if (!res.complete) done(noAnswer('the response ended early')); });
      },
    );
    const deadline = setTimeout(() => req.destroy(noAnswer('timeout')), Math.max(5000, timeoutMs * 3));
    req.on('timeout', () => req.destroy(noAnswer('timeout')));
    req.on('error', (err) => done(err));
    if (data) req.write(data);
    req.end();
  });
}

// Connection-level failures that mean "no server there yet".
const DOWN_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH']);

// The running server's /health response, or null when nothing listens. A server too busy to
// respond in time is { busy: true }, never "down", so no second server starts beside it.
async function health() {
  let res;
  try {
    res = await request('GET', '/health', undefined, 1500);
  } catch (err) {
    if (err.code === 'ETIMEDOUT') return { busy: true };
    if (DOWN_CODES.has(err.code)) return null;
    throw err;
  }
  if (res.status !== 200) return null;
  try {
    return JSON.parse(res.body);
  } catch (err) {
    if (err instanceof SyntaxError) return {};
    throw err;
  }
}

async function isUp() {
  return (await health()) !== null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Asks the server to exit and waits until the port is free. force: false (an update) lets a server
// running page control or a task refuse. -> true | false | { busy: 'page control' | 'tasks' }
// issue: set to why it didn't stop ('refused': key not accepted; 'no answer'; 'still running').
async function stopServer({ force = true, issue = {} } = {}) {
  try {
    // The newest installed version: the server says "updated" when it stops for that one.
    // Timeout 3 s: a busy server on a slow laptop can take over 1 s to respond.
    // x-claude-live-token: for servers from before the rename to EditLens.
    const version = newestCopy().version;
    let res = await request('POST', '/shutdown', { force, version }, 3000, { 'x-editlens-token': readToken(), 'x-claude-live-token': readToken(legacyDir()) });
    // The key changed between the read and the request (the server restarted): try once more.
    if (res.status === 401) res = await request('POST', '/shutdown', { force, version }, 3000, { 'x-editlens-token': readToken(), 'x-claude-live-token': readToken(legacyDir()) });
    if (res.status === 401 || res.status === 403) {
      issue.why = 'refused';
      return false;
    }
    if (res.status === 409) {
      let why = 'tasks';
      try {
        const body = JSON.parse(res.body);
        if (body && (body.busy === 'page control' || body.busy === 'tasks')) why = body.busy;
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
      }
      return { busy: why };
    }
  } catch (err) {
    if (!DOWN_CODES.has(err.code)) throw err;
    if (err.code === 'ETIMEDOUT') issue.why = 'no answer';
  }
  for (let i = 0; i < 60; i++) {
    if (!(await isUp())) return true;
    await sleep(75);
  }
  if (!issue.why) issue.why = 'still running';
  return false;
}

function pluginsDir() {
  return process.env.EDITLENS_PLUGINS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'plugins');
}
// A copy's version, or null when it is not a usable EditLens copy.
function copyVersion(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (!pkg || pkg.name !== 'editlens' || typeof pkg.version !== 'string' || !fs.statSync(path.join(root, 'server', 'server.js')).isFile()) return null;
    return pkg.version;
  } catch (err) {
    if (err instanceof SyntaxError || ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'].includes(err && err.code)) return null;
    throw err;
  }
}
function listDir(dir) {
  try {
    return fs.readdirSync(dir).map((n) => path.join(dir, n));
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err && err.code)) return [];
    throw err;
  }
}
// The installed copies of the plugin: this one, the ones Claude Code lists, and its plugin cache.
function installedCopies() {
  const dir = pluginsDir();
  const roots = [OWN_ROOT];
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'installed_plugins.json'), 'utf8'));
    for (const [key, val] of Object.entries((data && data.plugins) || {})) {
      if (key.split('@')[0] !== 'editlens') continue;
      for (const e of Array.isArray(val) ? val : [val]) if (e && typeof e.installPath === 'string') roots.push(e.installPath);
    }
  } catch (err) {
    if (!(err instanceof SyntaxError) && !['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR'].includes(err && err.code)) throw err;
  }
  for (const market of listDir(path.join(dir, 'cache'))) roots.push(...listDir(path.join(market, 'editlens')));
  roots.push(path.join(dir, 'marketplaces', 'editlens'));
  return [...new Set(roots.map((r) => path.resolve(r)))];
}
// The newest installed copy, so a session still running an older copy never starts an older
// server. -> { root, version, file }
function newestCopy() {
  let best = { root: OWN_ROOT, version: config.version };
  for (const root of installedCopies()) {
    const version = root === path.resolve(OWN_ROOT) ? null : copyVersion(root);
    if (version && newer(version, best.version)) best = { root, version };
  }
  return { ...best, file: path.join(best.root, 'server', 'server.js') };
}

// An older server can't keep page control across an update itself, so its project and
// conversation are saved here and the new server starts it again.
async function noteOldControl(running) {
  // keeps: this server saves page control itself (lib/pagekeep.js).
  if (!running || running.keeps === true) return false;
  let sum;
  try {
    const res = await request('GET', '/summary', undefined, 1500, { 'x-editlens-token': readToken() });
    sum = res.status === 200 ? JSON.parse(res.body) : null;
  } catch (err) {
    if (err instanceof SyntaxError || DOWN_CODES.has(err.code)) return false;
    throw err;
  }
  if (!sum || sum.control !== 'page' || typeof sum.sessionId !== 'string') return false;
  let runs = {};
  try {
    runs = JSON.parse(fs.readFileSync(path.join(config.stateDir, 'page-control-last.json'), 'utf8')) || {};
  } catch (err) {
    if (!(err instanceof SyntaxError) && !['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err && err.code)) throw err;
  }
  const found = Object.entries(runs).find(([, r]) => r && r.sessionId === sum.sessionId);
  if (!found) return false;
  const pid = Number(running.pid);
  require('./pagekeep').write(path.join(config.stateDir, 'page-control-on.json'), {
    cwd: found[0], sessionId: sum.sessionId, version: running.version || null, pid: Number.isSafeInteger(pid) ? pid : null, aliveAt: Date.now(), end: null, observed: true,
  });
  return true;
}

// True when version a is later than b ("0.18.10" > "0.18.9"); unknown versions are not later.
function newer(a, b) {
  const pa = String(a || '').split('.').map(Number);
  const pb = String(b || '').split('.').map(Number);
  if (pa.length !== 3 || pb.length !== 3 || pa.concat(pb).some((n) => !Number.isInteger(n))) return false;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] > pb[i];
  return false;
}

async function ensureServer() {
  // A task's Claude running as the normal account reports to the server that started it and
  // never starts its own (lib/taskuser.js).
  if (process.env.EDITLENS_NO_START === '1') return { started: false, noStart: true };
  const running = await health();
  if (running && running.busy) return { started: false, busy: true };
  // Another user's server on this port (a shared Linux computer): it refuses this user, and we
  // must not stop it.
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  if (running && Number.isInteger(running.uid) && me !== null && running.uid !== me) return { started: false, otherUser: running.uid };
  const copy = newestCopy();
  if (running && running.version === copy.version) return { started: false };
  // A newer server (another install of the plugin) is kept: replacing it would stop its page
  // control and Vite processes, and its page script is newer anyway.
  if (running && newer(running.version, copy.version)) return { started: false, newer: running.version };
  // A server from another plugin version serves an old page script: replace it so updates take
  // effect without a reboot.
  if (running) {
    // An update never stops page control or a paired computer's task: the old server exits when
    // they finish, and page control starts again in the new one (lib/pagekeep.js).
    const issue = {};
    const stopped = await stopServer({ force: false, issue });
    if (stopped && stopped.busy) {
      if (stopped.busy === 'page control') {
        await noteOldControl(running).catch((err) => {
          // A file or network error from the system (it names a syscall) only leaves the note out.
          if (!err || typeof err.syscall !== 'string') throw err;
        });
      }
      return { started: false, waiting: stopped.busy, running: running.version || 'unknown', installed: copy.version };
    }
    if (stopped !== true) return { started: false, stale: running.version || 'unknown', installed: copy.version, why: issue.why || 'still running' };
  }
  migrateState();
  fs.mkdirSync(config.stateDir, { recursive: true });
  trimLog(config.logFile);
  const out = fs.openSync(config.logFile, 'a');
  const child = spawn(process.execPath, [copy.file], {
    detached: true,
    // Run from the state folder, never the plugin folder: on Windows a process's working
    // folder is locked, which would block the next plugin update.
    cwd: config.stateDir,
    windowsHide: true,
    stdio: ['ignore', out, out],
    // Without EDITLENS_SAY, scripts the server runs print plain text (lib/say.js). Without
    // EDITLENS_DRIVEN: the server is never Claude running from a page (bin/drive.js take).
    // EDITLENS_PORT: the port this process uses, not a Port setting changed since it read it.
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'EDITLENS_SAY' && k !== 'EDITLENS_DRIVEN')), EDITLENS_PORT: String(config.port) },
  });
  child.unref();
  fs.closeSync(out);
  // Up to 10 s: a slow or busy computer (or CI) can take more than 2 s to start Node.
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await isUp()) return { started: true, pid: child.pid, version: copy.version, replaced: running ? running.version || 'unknown' : null };
  }
  const why = lastLogLine(config.logFile);
  throw new Error(`EditLens server did not start${why ? ` (${why})` : ''}; see ${config.logFile}`);
}

// The log's last line (why a server didn't start), short and plain; '' when there is none.
function lastLogLine(file) {
  let text;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const buf = Buffer.alloc(Math.min(size, 4096));
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return '';
    throw err;
  }
  const line = text.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return line.replace(/^\[[^\]]*\]\s*/, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 160);
}

// The server's key from `dir` (default: state folder), or '' when there is none.
function readToken(dir = config.stateDir) {
  if (!dir) return '';
  try {
    return fs.readFileSync(path.join(dir, path.basename(config.tokenFile)), 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return '';
    throw err;
  }
}

// `start: false` posts only to a server that is already running (returns null otherwise).
function postEvent(event, opts) {
  return postJson('/event', event, opts);
}

// Authenticated POST for hook/MCP endpoints. A timeout is not retried: slow != stopped.
async function postJson(urlPath, body, { start = true, timeoutMs = 1500 } = {}) {
  const attempt = () => request('POST', urlPath, body, timeoutMs, { 'x-editlens-token': readToken() });
  let res;
  try {
    res = await attempt();
  } catch (err) {
    if (!DOWN_CODES.has(err.code) || (err.code === 'ETIMEDOUT' && timeoutMs > 1500)) throw err;
    if (!start) return null;
    await ensureServer();
    res = await attempt();
  }
  if (res.status === 401) {
    // The server restarted since we read the token and has written a new one.
    res = await attempt();
  }
  if (res.status !== 200) throw new Error(`server answered ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}

// Authenticated GET for hook/MCP endpoints. Starts the server if it is not running.
async function getJson(urlPath, timeoutMs = 1500) {
  const attempt = () => request('GET', urlPath, undefined, timeoutMs, { 'x-editlens-token': readToken() });
  let res;
  try {
    res = await attempt();
  } catch (err) {
    if (!DOWN_CODES.has(err.code)) throw err;
    await ensureServer();
    res = await attempt();
  }
  if (res.status === 401) res = await attempt();
  if (res.status !== 200) throw new Error(`server answered ${res.status}: ${res.body}`);
  return JSON.parse(res.body);
}

// D21: this user's page key when the page addresses /editlens opens or prints need it (macOS, Windows),
// else null; also null from a server too old to know it. Asked once per command.
let pageKeyAsked = null;
function pageKey() {
  if (!pageKeyAsked) {
    pageKeyAsked = getJson('/page-key', 3000).then((r) => (r && r.needed === true && /^[0-9a-f]{32}$/.test(String(r.key)) ? r.key : null), (err) => {
      if (!(err instanceof Error)) throw err;
      return null;
    });
  }
  return pageKeyAsked;
}

module.exports = { pageKey, lastLogLine, newestCopy, installedCopies, noteOldControl, newer, ensureServer, stopServer, postEvent, postJson, getJson, isUp, health, request, readToken, DOWN_CODES };
