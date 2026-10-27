'use strict';
// The last page control conversation in each project (server.js), so page control turned on
// automatically in a new session continues it. Keyed by lib/paths normalize(), so C:\x and c:/x/
// on Windows are one entry.
const fs = require('fs');
const { normalize } = require('./paths');
const { writeAtomic } = require('./atomic');

const KEEP = 20;

function read(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (err) {
    if (err instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err && err.code)) return {};
    throw err;
  }
}

// Saves sessionId for cwd (the newest KEEP projects). Throws fs errors (with a code).
function remember(file, cwd, sessionId, now = Date.now()) {
  const runs = read(file);
  const key = normalize(cwd);
  if (runs[key] && runs[key].sessionId === sessionId) return;
  // An entry an older version saved under another spelling of the same folder.
  for (const k of Object.keys(runs)) if (k !== key && normalize(k) === key) delete runs[k];
  runs[key] = { sessionId, at: now };
  const keep = Object.entries(runs).filter(([, r]) => r && Number.isFinite(r.at)).sort((a, b) => b[1].at - a[1].at).slice(0, KEEP);
  writeAtomic(file, JSON.stringify(Object.fromEntries(keep)), { mkdir: true });
}

// -> { sessionId, at } for cwd, or null.
function find(file, cwd) {
  const runs = read(file);
  const key = normalize(cwd);
  if (runs[key]) return runs[key];
  const old = Object.keys(runs).find((k) => normalize(k) === key);
  return old ? runs[old] : null;
}

module.exports = { remember, find };
