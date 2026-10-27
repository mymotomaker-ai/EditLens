'use strict';
// Shared settings for the hook scripts and the live server.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 4317;

// The plugin's own version, so a server still running from an older install can be replaced.
function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch (err) {
    if (err.code === 'ENOENT' || err instanceof SyntaxError) return '0.0.0';
    throw err;
  }
}

// A whole number written only with digits ("4705x", "4705.9", "1e3" and "0x10" don't count),
// in range; the mod and bin/statusline.js read EDITLENS_PORT the same way. -> the number or null
function strictInt(raw, min, max) {
  const s = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,9}$/.test(s)) return null;
  const value = Number(s);
  return value >= min && value <= max ? value : null;
}

// Parse an integer env var, using the default when it is missing, not a whole number or out of range.
function intFromEnv(name, fallback, min, max) {
  const value = strictInt(process.env[name], min, max);
  return value === null ? fallback : value;
}

// The Port setting: Claude Code gives it to hooks; the MCP server and commands run from Bash get
// no plugin options, so they read it from Claude Code's settings file. -> the port (4317 when unset)
function settingPort(env = process.env) {
  if (env.CLAUDE_PLUGIN_OPTION_PORT !== undefined) return strictInt(env.CLAUDE_PLUGIN_OPTION_PORT, 1024, 65535) ?? DEFAULT_PORT;
  const saved = require('./settings').savedOptions(env);
  return saved && Array.isArray(saved.port) && saved.port.length ? saved.port[0] : DEFAULT_PORT;
}

const host = '127.0.0.1';
const stateDir = process.env.EDITLENS_STATE_DIR || path.join(os.homedir(), '.claude', 'editlens');

// The port a Claude Code session started with, kept in a file per session: a Port setting changed
// later applies only after Claude Code restarts (the mod, the hooks, the MCP server and the status
// line all read this file before the setting).
const SESSION_ID = /^[\w-]{1,100}$/;
function sessionPortFile(id) {
  return typeof id === 'string' && SESSION_ID.test(id) ? path.join(stateDir, 'session-ports', id) : null;
}
// -> the kept port, or null when none is kept for this session
function keptPort(id) {
  const file = sessionPortFile(id);
  if (!file) return null;
  try {
    return strictInt(fs.readFileSync(file, 'utf8'), 1, 65535);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(err.code)) return null;
    throw err;
  }
}
function keepPort(id, value) {
  const file = sessionPortFile(id);
  if (file && strictInt(value, 1, 65535) !== null) require('./atomic').writeAtomic(file, String(value), { mkdir: true });
}

// Ports kept for sessions not started for 30 days are removed when Claude Code starts.
const KEEP_DAYS = 30;
function pruneKept(now = Date.now()) {
  const dir = path.join(stateDir, 'session-ports');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return;
    throw err;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > KEEP_DAYS * 24 * 3600 * 1000) fs.unlinkSync(file);
    } catch (err) {
      if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'EBUSY'].includes(err.code)) throw err;
    }
  }
}

// EDITLENS_PORT first, then the port kept for this session, then the Port setting, then 4317.
const envPort = intFromEnv('EDITLENS_PORT', null, 1, 65535);
let port = envPort !== null ? envPort : keptPort(process.env.EDITLENS_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID);
if (port === null) port = settingPort();

// A hook's session, from its input. atStart (Claude Code just started, or resumed the session after a
// restart): the Port setting's port, kept for the session; else the port kept for it. Programs the
// hook starts (the live server) get it as EDITLENS_PORT. -> the port
function useSession(id, { atStart = false } = {}) {
  const kept = envPort === null && sessionPortFile(id) && !atStart ? keptPort(id) : null;
  if (envPort === null && sessionPortFile(id)) port = kept !== null ? kept : settingPort();
  process.env.EDITLENS_PORT = String(port);
  if (envPort === null && kept === null) keepPort(id, port);
  if (atStart) pruneKept();
  return port;
}

module.exports = {
  version: readVersion(),
  get port() {
    return port;
  },
  host,
  get baseUrl() {
    return `http://${host}:${port}`;
  },
  stateDir,
  get tokenFile() {
    return path.join(stateDir, `token-${port}`);
  },
  get logFile() {
    return path.join(stateDir, `server-${port}.log`);
  },
  hookLogFile: path.join(stateDir, 'hooks.log'),
  // Copy of bin/statusline.js that users point Claude Code's statusLine setting at.
  statusLineFile: path.join(stateDir, 'statusline.js'),
  // How many events the server keeps for replay to pages that connect late.
  historySize: intFromEnv('EDITLENS_HISTORY', 600, 1, 5000),
  // Port another computer pairs with (open only while pairing: /editlens pair).
  pairPort: intFromEnv('EDITLENS_PAIR_PORT', 4318, 1, 65535),
  // Server exits after this many minutes with no events and no connected pages.
  idleMinutes: intFromEnv('EDITLENS_IDLE_MINUTES', 120, 1, 7 * 24 * 60),
  // Extra allowed page origins (comma separated) besides localhost ones.
  extraOrigins: (process.env.EDITLENS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // How long the Stop hook waits for a page message; capped below its 60-min timeout (hooks.json).
  listenMinutes: intFromEnv('EDITLENS_WAIT_MINUTES', 5, 0, 59),
  intFromEnv,
  strictInt,
  settingPort,
  keptPort,
  keepPort,
  useSession,
};
