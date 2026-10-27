'use strict';
// Pairing two EditLens computers (for example a laptop and a VPS): the shared parts.
// Every connection is TLS with a pre-shared key (ECDHE-PSK, forward secret) and starts with one
// JSON line saying what it is for. The one-time code is the key for the first connection; after
// that each side keeps its own 256-bit pairing key.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL = 1;
const CODE_MINUTES = 10;
const TLS = { ciphers: 'ECDHE-PSK-CHACHA20-POLY1305', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' };
const JOIN_ID = 'editlens-join';
const HEADER_MAX = 4096;

// 31 letters and digits without look-alikes (no 0/O, 1/I/L): 28 of them, about 138 bits, in
// groups of four.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newCode() {
  let s = '';
  for (let i = 0; i < 28; i++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return s.match(/.{4}/g).join('-');
}
// "k7qf 29xa-..." -> "K7QF29XA..." or null when it isn't a code.
function normalizeCode(text) {
  const s = String(text || '').toUpperCase().replace(/[\s-]/g, '');
  return s.length === 28 && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}
function codeKey(code) {
  return crypto.createHash('sha256').update('editlens-pair-code:' + normalizeCode(code)).digest();
}

// "203.0.113.5:4318", "vps.example.com", "[::1]:4318" -> { host, port } or null.
function parseAddress(text, defaultPort) {
  const s = String(text || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '');
  const m = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(s) || /^([a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(s);
  if (!m) return null;
  const port = m[2] === undefined ? defaultPort : Number(m[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

// Reads the first line (JSON) of a connection; the bytes after it are returned to the socket for
// the next reader. -> Promise<object>
function readHeader(socket, timeoutMs = 10000, max = HEADER_MAX) {
  return new Promise((resolve, reject) => {
    // Chunks are kept in a list and joined once, when the line ends (no copy per chunk).
    const parts = [];
    let size = 0;
    const timer = setTimeout(() => finish(new Error('no header')), timeoutMs);
    function finish(err, value) {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      if (err) reject(err);
      else resolve(value);
    }
    function onData(chunk) {
      const at = chunk.indexOf(10);
      if (at < 0) {
        parts.push(chunk);
        size += chunk.length;
        if (size > max) finish(new Error('header too long'));
        return;
      }
      const nl = size + at;
      if (nl > max) return finish(new Error('header too long'));
      parts.push(chunk);
      const buf = Buffer.concat(parts, size + chunk.length);
      socket.pause();
      const rest = buf.subarray(nl + 1);
      if (rest.length) socket.unshift(rest);
      let value;
      try {
        value = JSON.parse(buf.subarray(0, nl).toString('utf8'));
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        return finish(new Error('bad header'));
      }
      if (!value || typeof value !== 'object') return finish(new Error('bad header'));
      return finish(null, value);
    }
    const onError = (err) => finish(err);
    const onClose = () => finish(new Error('closed'));
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    // A read before this one paused the socket; a new 'data' listener alone doesn't restart it.
    socket.resume();
  });
}

function writeLine(socket, value) {
  socket.write(JSON.stringify(value) + '\n');
}

// A short name for this computer, shown on the other side ("vps-1").
function cleanName(name) {
  const s = String(name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return s || 'remote';
}

// This computer's id for pairing (32 hex, in the state folder): a computer that pairs again
// replaces its own earlier pairing, whatever folder or address it used, and never another
// computer's with the same name. null when the folder can't be read or written.
function machineId(stateDir) {
  const file = path.join(stateDir, 'machine-id');
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(id)) return id;
  } catch (err) {
    if (!['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err.code)) throw err;
    if (err.code !== 'ENOENT') return null;
  }
  const id = crypto.randomBytes(16).toString('hex');
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, id + '\n', { mode: 0o600 });
  } catch (err) {
    if (!['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOTDIR'].includes(err.code)) throw err;
    return null;
  }
  return id;
}

// The words `/editlens control <name>` passes on: manual alone, or new and take. -> e.g. ['new', 'take']
function controlArgs(list) {
  const words = (Array.isArray(list) ? list : []).map((a) => String(a).toLowerCase());
  if (words.includes('manual')) return ['manual'];
  return ['new', 'take', '--later'].filter((w) => words.includes(w));
}

// The path of the key file a computer used to join through SSH (never the key itself): the other
// computer puts it in the ssh lines it prints. -> the path, or null for anything else.
const KEY_PATH_MAX = 260;
function keyPath(value) {
  if (typeof value !== 'string' || !value || value.length > KEY_PATH_MAX) return null;
  return /[\u0000-\u001f\u007f-\u009f]/.test(value) ? null : value;
}

// The key file the computers that joined this one through SSH used: the one path when they all
// sent the same, else null (none sent one, or two computers used different keys).
function knownKey(pairs) {
  const paths = new Set((Array.isArray(pairs) ? pairs : []).map((p) => (p ? keyPath(p.keyPath) : null)).filter(Boolean));
  return paths.size === 1 ? [...paths][0] : null;
}

// A task request or response (server/tasks.js): one JSON line, larger than a header.
const BODY_MAX = 1024 * 1024;

module.exports = { BODY_MAX, PROTOCOL, CODE_MINUTES, TLS, JOIN_ID, newCode, normalizeCode, codeKey, parseAddress, readHeader, writeLine, cleanName, controlArgs, machineId, keyPath, knownKey, KEY_PATH_MAX };
