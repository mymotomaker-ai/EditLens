'use strict';
// One check for a path inside a project, links included: every part that exists is resolved with
// realpath, so a folder link in the middle (link/new.txt) can't lead outside. Callers apply their
// exclusions to the resolved name (rel), never only to the name they were given. A task's workspace,
// which a task can change while it is read, is read with openNoLinks: no link on any part of the path.
const fs = require('fs');
const path = require('path');

function isInside(file, root) {
  const r = path.relative(root, file);
  return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r);
}

// root: the project folder; rel: a clean relative path (lib/sendproject.js cleanRel).
// -> { file, rel, exists } with file the real path and rel the real path inside the real root
// ('/' separated) | { error: 'outside' } | { error: <fs code> }. The file itself may not exist yet.
function inside(root, rel) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch (err) {
    if (err && err.code) return { error: err.code };
    throw err;
  }
  const at = resolve(path.join(root, rel));
  if (at.error) return at;
  if (!isInside(at.file, realRoot)) return { error: 'outside' };
  return { file: at.file, rel: path.relative(realRoot, at.file).split(path.sep).join('/'), exists: at.exists };
}

// Where an absolute name really leads: every part that exists is resolved with realpath, and the
// parts not there yet are added as written. -> { file, exists } | { error: 'outside' | <fs code> }
function resolve(file) {
  const rest = [];
  let p = file;
  for (;;) {
    let real = null;
    try {
      real = fs.realpathSync(p);
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) {
        if (err && err.code) return { error: err.code };
        throw err;
      }
    }
    if (real !== null) return { file: rest.length ? path.join(real, ...rest) : real, exists: rest.length === 0 };
    const up = path.dirname(p);
    if (up === p) return { error: 'outside' };
    rest.unshift(path.basename(p));
    p = up;
  }
}

// An absolute file name checked as inside() checks rel. root may be named as given or by its real
// path (a name stored already resolved). -> as inside()
function fileIn(root, file) {
  if (typeof root !== 'string' || typeof file !== 'string' || !path.isAbsolute(file)) return { error: 'outside' };
  let real;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    if (err && err.code) return { error: err.code };
    throw err;
  }
  for (const base of new Set([root, real])) if (isInside(file, base)) return inside(base, path.relative(base, file));
  return { error: 'outside' };
}

// A folder's identity, so a folder put in its place later (renamed away, or a link at its path) is
// told apart from it. -> { dev, ino } (strings) | null (not a folder now)
function folderId(dir) {
  let st;
  try {
    st = fs.statSync(dir, { bigint: true });
  } catch (err) {
    if (err && err.code) return null;
    throw err;
  }
  return st.isDirectory() ? { dev: String(st.dev), ino: String(st.ino) } : null;
}
const sameId = (st, id) => String(st.dev) === id.dev && String(st.ino) === id.ino;

// Linux: each part is opened inside the folder opened before it (/proc/self/fd/<n>/<part>), so a
// part swapped for a link after a check can't lead elsewhere. Other systems have no task account
// (lib/taskuser.js is Linux only): each part is checked with lstat, then the file is opened.
const C = fs.constants;
const NOFOLLOW = C.O_NOFOLLOW || 0;
const BY_FD = process.platform === 'linux' && fs.existsSync('/proc/self/fd');

// Opens a file under root without following a link on any part of rel (root's own path aside).
// id: root's folderId when it was made: a root replaced since is refused. uid: only a file this
// account owns (a task account's workspace). rel: a clean relative path ('/' separated).
// -> { fd, st } (the caller closes fd) | { error: 'replaced' | 'link' | 'owner' | 'not a file' | fs code }
function openNoLinks(root, rel, { id = null, uid = null } = {}) {
  const parts = String(rel || '').split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return { error: 'outside' };
  const dirs = [];
  let fd = null;
  let p = root;
  try {
    if (BY_FD) dirs.push(fs.openSync(root, C.O_RDONLY | C.O_DIRECTORY));
    const top = BY_FD ? fs.fstatSync(dirs[0], { bigint: true }) : fs.statSync(root, { bigint: true });
    if (!top.isDirectory() || (id && !sameId(top, id))) return { error: 'replaced' };
    for (let i = 0; i < parts.length; i++) {
      p = BY_FD ? `/proc/self/fd/${dirs[dirs.length - 1]}/${parts[i]}` : path.join(p, parts[i]);
      if (!BY_FD && fs.lstatSync(p).isSymbolicLink()) return { error: 'link' };
      if (i < parts.length - 1) {
        if (BY_FD) dirs.push(fs.openSync(p, C.O_RDONLY | C.O_DIRECTORY | NOFOLLOW));
      } else {
        fd = fs.openSync(p, C.O_RDONLY | NOFOLLOW | (C.O_NONBLOCK || 0));
      }
    }
    const st = fs.fstatSync(fd);
    const why = !st.isFile() ? 'not a file' : uid !== null && st.uid !== uid ? 'owner' : null;
    if (why) return { error: why };
    const out = { fd, st };
    fd = null;
    return out;
  } catch (err) {
    if (!err || !err.code) throw err;
    // A link met with O_NOFOLLOW: ELOOP, or ENOTDIR where a folder was expected.
    const link = err.code === 'ELOOP' || (err.code === 'ENOTDIR' && isLink(p));
    return { error: link ? 'link' : err.code };
  } finally {
    if (fd !== null) fs.closeSync(fd);
    for (const d of dirs) fs.closeSync(d);
  }
}
function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch (err) {
    if (err && err.code) return false;
    throw err;
  }
}

module.exports = { inside, isInside, resolve, fileIn, folderId, openNoLinks };
