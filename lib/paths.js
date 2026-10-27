'use strict';
// Path comparison that works across Windows and POSIX spellings of the same folder:
// Vite reports C:/proj, Claude Code on Windows reports C:\proj, drive letters vary in case.
const crypto = require('crypto');
const os = require('os');
const path = require('path');

function normalize(p) {
  const raw = String(p || '');
  const unc = /^[\\/]{2}[^\\/]/.test(raw);
  let s = raw.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  if (unc) return '/' + s.toLowerCase(); // \\server\share\Proj: Windows, so case-insensitive
  // Drive letters and Windows paths are case-insensitive.
  return /^[a-z]:\//i.test(s) || /^[a-z]:$/i.test(s) ? s.toLowerCase() : s;
}

// True when `a` and `b` are the same folder, or one contains the other.
// A missing side matches nothing: callers that want "no filter" say so themselves.
function related(a, b) {
  if (!a || !b) return false;
  const x = normalize(a);
  const y = normalize(b);
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/');
}

// True when `child` is the folder `parent` or inside it.
function within(child, parent) {
  if (!child || !parent) return false;
  const x = normalize(child);
  const y = normalize(parent);
  return x === y || x.startsWith(y + '/');
}

// Not a usable project folder: relative, a drive or filesystem root, the home folder or above it.
// Such a folder would match every project, so it is never accepted from a page.
function tooBroad(p, home = os.homedir()) {
  const x = normalize(p);
  if (!x || !(x.startsWith('/') || /^[a-z]:/.test(x)) || x === '/' || /^[a-z]:$/.test(x) || /^\/\/[^/]+(\/[^/]+)?$/.test(x)) return true;
  const h = normalize(home);
  return Boolean(h) && (x === h || h.startsWith(x + '/'));
}

// A temporary dot-file name next to a project file, renamed to it once written. Dev-server
// watchers (Vite, Next.js, nodemon) ignore dot-files, so they don't rebuild for it.
function tmpBeside(file) {
  return path.join(path.dirname(file), `.${path.basename(file)}.editlens-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
}

module.exports = { normalize, related, within, tooBroad, tmpBeside };
