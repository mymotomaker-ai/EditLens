'use strict';
// System errors (from spawn, exec, fs and sockets) in plain words for the user: never
// "spawn xdg-open ENOENT". Errors EditLens made itself have no code and keep their own text.

const WORDS = {
  ENOENT: 'it was not found',
  EACCES: 'permission was denied',
  EPERM: 'the system did not allow it',
  ETIMEDOUT: 'there was no response in time',
  ECONNREFUSED: 'nothing is running there',
  ECONNRESET: 'the connection was closed',
  EPIPE: 'the connection was closed',
  EADDRINUSE: 'the port is already in use',
  EADDRNOTAVAIL: 'that address is not on this computer',
  EHOSTUNREACH: 'can\'t connect to that computer',
  ENETUNREACH: 'can\'t connect to the network',
  ENOTFOUND: 'that name can\'t be found',
  EAI_AGAIN: 'that name can\'t be found right now',
  ENOSPC: 'the disk is full',
  EMFILE: 'too many files are open',
  ENFILE: 'too many files are open',
  EISDIR: 'it is a folder, not a file',
  ENOTDIR: 'a part of the path is not a folder',
  EEXIST: 'it already exists',
  EBUSY: 'it is in use',
  EROFS: 'the disk is read-only',
  ENAMETOOLONG: 'the name is too long',
};

// The program a failed spawn named ("spawn xdg-open" -> "xdg-open"), or ''.
function programOf(err) {
  const m = /^spawn(?:Sync)? (.+)$/.exec(String((err && err.syscall) || ''));
  const p = m ? m[1] : typeof (err && err.path) === 'string' && /^spawn/.test(String(err.syscall || '')) ? err.path : '';
  return String(p).split(/[\\/]/).pop();
}

// -> plain words for err (an Error, a code string, or anything else).
function plainError(err) {
  if (err === undefined || err === null || err === '') return 'no reason was given';
  const code = typeof err === 'string' ? (/^E[A-Z_]+$/.test(err) ? err : null) : err && typeof err.code === 'string' ? err.code : null;
  if (code && WORDS[code]) {
    const prog = typeof err === 'object' ? programOf(err) : '';
    if (prog && code === 'ENOENT') return `${prog} is not installed here`;
    if (prog && (code === 'EACCES' || code === 'EPERM')) return `${prog} is not allowed to run here`;
    const port = typeof err === 'object' && Number.isInteger(err.port) ? err.port : null;
    if (port !== null && (code === 'ECONNREFUSED' || code === 'EADDRINUSE')) return `${WORDS[code]} (port ${port})`;
    return WORDS[code];
  }
  if (typeof err === 'string') return err;
  const msg = String((err && err.message) || err);
  // A system message with a code but no known words: keep only the first line, without the
  // "spawn x" / "open '/path'" parts that mean nothing to a user.
  return code ? msg.split('\n')[0].replace(/^[A-Z_]+:\s*/, '').replace(/,?\s*(spawn|open|connect|listen|read|write)\b.*$/, '') || 'a system error happened' : msg;
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

// A message from another program (Claude Code, the Agent SDK, the live server), in plain words:
// its first line, without an "Error:" or "Claude Code returned an error result:" prefix, without
// ids, and with system codes in words. -> text ('' for nothing)
function plainMessage(text) {
  let t = String(text === undefined || text === null ? '' : text).split('\n').map((l) => l.trim()).find(Boolean) || '';
  // "Error:" at the start, and an error's name inside ("... (JSONParseError: Unexpected end ...)").
  t = t.replace(/^(?:(?:\w*Error|Uncaught \w+):\s*)+/, '').replace(/^Claude Code returned an error result:\s*/i, '').replace(/\b\w*Error:\s*/g, '');
  if (/no conversation found/i.test(t)) return 'this chat has nothing saved yet, so there is nothing to continue';
  t = t.replace(/\s*(?:with\s+)?(?:session\s+)?id:?\s*(?=[0-9a-f]{8}-)/gi, ' ').replace(UUID, '');
  // "connect ECONNREFUSED 127.0.0.1:4317" -> "nothing is running there (127.0.0.1:4317)"
  t = t.replace(/\b(?:connect|listen|read|write|open|getaddrinfo|spawn(?:Sync)? \S+)\s+(E[A-Z_]{3,})(?:\s+(\S+))?/g, (m, code, where) => (WORDS[code] ? WORDS[code] + (where ? ` (${where.replace(/^'|'$/g, '')})` : '') : m));
  t = t.replace(/\b(E[A-Z]{3,}[A-Z_]*)\b/g, (code) => WORDS[code] || code);
  t = t.replace(/\s+([:,.;])/g, '$1').replace(/[\s:;,]+$/, '').replace(/\s{2,}/g, ' ').trim();
  return t.length > 160 ? t.slice(0, 159).replace(/\s+\S*$/, '') + '…' : t;
}

module.exports = { plainError, plainMessage, WORDS };
