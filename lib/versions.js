'use strict';
// Are this computer's Node and Claude Code new enough for EditLens? Checked at session start, at
// most once a day per claude program (cached in versions.json), so an old install explains why
// things don't appear instead of failing silently. -> a line to show, or ''.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeAtomic } = require('./atomic');

const NODE_MIN = 18;
const CLAUDE_MIN = '2.1.287';
const CLAUDE_MIN_DESKTOP = '2.1.286';
const DAY_MS = 86400000;

function parse(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  const parts = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  // A part too long for a whole number (Infinity) makes the version unknown.
  return parts && parts.every(Number.isSafeInteger) ? parts : null;
}
// a < b, for "x.y.z" versions. Unknown versions are never "older".
function older(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

function readCache(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (err) {
    if (err instanceof SyntaxError || (err && err.code)) return {};
    throw err;
  }
}

// The version `exe --version` prints, or null. Cached a day per exe.
function claudeVersion(exe, stateDir, now = Date.now()) {
  if (typeof exe !== 'string' || !exe) return null;
  const file = path.join(stateDir, 'versions.json');
  const cache = readCache(file);
  const hit = cache[exe];
  const at = hit && Number(hit.at);
  if (hit && Number.isFinite(at) && now - at < DAY_MS) return typeof hit.version === 'string' ? hit.version : null;
  const r = spawnSync(exe, ['--version'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
  const found = !r.error && r.status === 0 ? parse(r.stdout) : null;
  const version = found ? found.join('.') : null;
  const next = { ...cache, [exe]: { version, at: now } };
  const keys = Object.keys(next);
  for (const k of keys.slice(0, Math.max(0, keys.length - 10))) delete next[k];
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    writeAtomic(file, JSON.stringify(next));
  } catch (err) {
    // Only the "new version" note uses this file, so a folder that can't be written is not fatal.
    if (!err || !['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(err.code)) throw err;
  }
  return version;
}

function versionWarning({ nodeVersion = process.versions.node, exe = process.env.CLAUDE_CODE_EXECPATH, desktop = false, stateDir, product = 'EditLens' } = {}) {
  const major = Number(String(nodeVersion).split('.')[0]);
  if (Number.isInteger(major) && major < NODE_MIN) return `✕ ${product} needs Node ${NODE_MIN} or newer: this computer has Node ${nodeVersion}\n! Fix  update Node.js, then restart Claude Code`;
  const min = desktop ? CLAUDE_MIN_DESKTOP : CLAUDE_MIN;
  const have = stateDir ? claudeVersion(exe, stateDir) : null;
  if (have && older(have, min)) return `✕ ${product} needs Claude Code ${min} or newer: this is ${have}\n! Fix  › claude update`;
  return '';
}

// The running server is older than this copy (it was kept because page control is busy).
// -> [what runs, what to type] or null
function olderNote(running, version) {
  const have = running && typeof running.version === 'string' ? running.version : null;
  if (!have || !parse(have) || !older(have, version)) return null;
  return [`EditLens ${have} is running`, `/editlens restart for ${version}`];
}

module.exports = { versionWarning, claudeVersion, older, olderNote, NODE_MIN, CLAUDE_MIN };
