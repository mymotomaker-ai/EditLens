'use strict';
// Page control the user turned on, saved in a file while it runs (server/server.js). A new server
// (after an update, a restart or a crash) reads it to say why page control ended, and starts it again
// in the same project and conversation when that page opens again. Choosing Manual deletes the
// file, so it is never restored.
const fs = require('fs');
const { writeAtomic } = require('./atomic');
const { NEW_CHAT } = require('./sdkerr');

// Restored only within this time after page control ended.
const RESTORE_MS = 30 * 60000;
// Why page control ended without the user choosing it (shown after "Page control stopped: ").
const TEXT = {
  update: 'EditLens was updated and restarted.',
  restart: 'EditLens restarted.',
  'claude-gone': 'The Claude program it used was removed (Claude Code updated).',
};
// What the page says when it starts again (the reason without its full stop).
const BACK = {
  update: 'EditLens was updated and restarted',
  restart: 'EditLens restarted',
  'claude-gone': 'the Claude program it used was removed (Claude Code updated)',
};
const RESTORABLE = new Set(Object.keys(TEXT));

function read(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) && typeof data.cwd === 'string' && data.cwd ? data : null;
  } catch (err) {
    if (err instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err && err.code)) return null;
    throw err;
  }
}

// Throws fs errors (with a code).
function write(file, rec) {
  writeAtomic(file, JSON.stringify(rec), { mkdir: true });
}

function remove(file) {
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if (!['ENOENT', 'ENOTDIR'].includes(err && err.code)) throw err;
  }
}

// How a new server reads the file another server left.
// -> { cwd, sessionId, reason, text, at, restore } | null (too old, or not page control)
function onStart(rec, { version, now = Date.now() } = {}) {
  if (!rec || typeof rec.cwd !== 'string' || !rec.cwd) return null;
  const end = rec.end && typeof rec.end === 'object' ? rec.end : null;
  const at = Number(end ? end.at : rec.aliveAt);
  if (!Number.isFinite(at) || at > now + 60000 || now - at > RESTORE_MS) return null;
  // No end written: that server stopped before it could write one (killed, or its computer slept).
  let reason = end && typeof end.reason === 'string' ? end.reason : 'restart';
  if ((reason === 'restart' || reason === 'update') && typeof rec.version === 'string' && rec.version && version) reason = rec.version === version ? reason : 'update';
  const text = end && typeof end.text === 'string' && end.text ? end.text.slice(0, 400) : TEXT[reason] || 'Claude stopped unexpectedly.';
  return {
    cwd: rec.cwd,
    sessionId: typeof rec.sessionId === 'string' && /^[0-9a-f-]{36}$/i.test(rec.sessionId) ? rec.sessionId : null,
    exe: typeof rec.exe === 'string' && rec.exe ? rec.exe : null,
    reason, text, at, restore: RESTORABLE.has(reason) && !(end && end.restore === false),
  };
}

// "Page control starts again: EditLens restarted. It continues your page conversation."
// newChat: the earlier conversation wasn't found (lib/sdkerr.js).
function backText(reason, { continued = true, exe = null, newChat = false } = {}) {
  const why = BACK[reason] || 'it stopped unexpectedly';
  const uses = exe ? ` It now uses ${exe}.` : '';
  const conv = newChat ? NEW_CHAT : continued ? 'It continues your page conversation.' : 'It started a new conversation: the earlier one could not be continued.';
  return `Page control starts again: ${why}.${uses} ${conv}`;
}

// How an older server (one that doesn't write this file) ended page control, from its log lines
// between its start ("listening on ... (pid N)") and the next server's.
// -> { kind: 'user' | 'shutdown' | 'error' | 'other' | null, at, error, lastAt } | null
function oldEnd(text, pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  const lines = String(text || '').split('\n');
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/ listening on /.test(lines[i]) && lines[i].includes(`(pid ${pid})`)) {
      start = i;
      break;
    }
  }
  if (start < 0) return null;
  let found = null;
  let lastAt = NaN;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\[(\d{4}-\d\d-\d\dT[^\]]+)\] (.*)$/.exec(lines[i]);
    if (!m) continue;
    if (/ listening on .*\(pid \d+\)/.test(m[2])) break; // the next server
    const at = Date.parse(m[1]);
    if (!Number.isFinite(at)) continue;
    lastAt = at;
    const msg = m[2];
    if (/^drive: stopping /.test(msg)) {
      const kind = /^drive: stopping (switched to manual from the page|stopped from Claude Code)/.test(msg) ? 'user' : /^drive: stopping server shutting down/.test(msg) ? 'shutdown' : 'other';
      found = { kind, at };
    } else if (/^drive: session failed: /.test(msg)) found = { kind: 'error', at, error: msg.slice('drive: session failed: '.length, 400) };
    else if (/^drive: starting in /.test(msg)) found = null; // started again, so an earlier end doesn't count
  }
  return { kind: null, ...(found || {}), lastAt };
}

module.exports = { RESTORE_MS, TEXT, read, write, remove, onStart, backText, oldEnd };
