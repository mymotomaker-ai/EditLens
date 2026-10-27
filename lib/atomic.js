'use strict';
// Writes a file through a temporary dot-file beside it (dev-server watchers ignore those), then
// renames it, so a crash leaves the old file or the new one, never a half-written one.
// withLock: one writer at a time for a small shared list file, so two sessions starting at the
// same time don't lose each other's entry.
const fs = require('fs');
const path = require('path');
const { tmpBeside } = require('./paths');

const RETRY = new Set(['EPERM', 'EACCES', 'EBUSY']); // Windows: a reader or antivirus has it open
const LOCK_STALE_MS = 5000;

function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// data: string | Buffer. mode defaults to the existing file's mode; mkdir creates the folder.
// keepOwner: a server running as root keeps the file's owner (a file in a task account's folder
// must not become root's); a new file gets its folder's owner.
// Throws fs errors (with a code) after removing the temporary file.
function writeAtomic(file, data, { mode, mkdir = false, keepOwner = false } = {}) {
  const owner = keepOwner && runsAsRoot() ? ownerOf(file) || ownerOf(nearestFolder(file)) : null;
  if (mkdir) {
    const made = fs.mkdirSync(path.dirname(file), { recursive: true });
    if (owner && made) chownDown(made, path.dirname(file), owner);
  }
  let keep = mode;
  if (keep === undefined) {
    try {
      keep = fs.statSync(file).mode & 0o7777;
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
    }
  }
  const tmp = tmpBeside(file);
  // wx: never through a file or link already at that name (that one is not removed below).
  const fd = fs.openSync(tmp, 'wx', keep === undefined ? 0o666 : keep);
  try {
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
    // Owner first: chown clears setuid/setgid bits, which the chmod puts back.
    if (owner) fs.chownSync(tmp, owner.uid, owner.gid);
    if (keep !== undefined) fs.chmodSync(tmp, keep); // the umask may have narrowed it
    for (let i = 0; ; i += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (!err || !RETRY.has(err.code) || i >= 4) throw err;
        pause(25 * (i + 1));
      }
    }
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

function runsAsRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0;
}

// { uid, gid } of a file or folder, or null when it is not there.
function ownerOf(p) {
  try {
    const st = fs.statSync(p);
    return { uid: st.uid, gid: st.gid };
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

// The closest folder above `file` that exists.
function nearestFolder(file) {
  let dir = path.dirname(file);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return dir;
}

// Folders mkdir just made, from `top` down to `dir`, get the same owner.
function chownDown(top, dir, owner) {
  for (let d = dir; ; d = path.dirname(d)) {
    fs.chownSync(d, owner.uid, owner.gid);
    if (d === top || path.dirname(d) === d) break;
  }
}

// Runs fn() while it has `${file}.lock` (created exclusively). A lock older than LOCK_STALE_MS is
// from a process that died, and is replaced. Waits at most about a second, then runs anyway
// (losing a list entry is better than a hook that does not finish). -> fn's result
function withLock(file, fn) {
  const lock = `${file}.lock`;
  let held = false;
  for (let i = 0; i < 40 && !held; i += 1) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      held = true;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        // No folder yet, or no access: continue without the lock.
        if (err && (err.code === 'ENOENT' || RETRY.has(err.code))) break;
        throw err;
      }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
      } catch (e) {
        // The holder removed it first, or (Windows) it is still open: try again after the pause.
        if (!e || (e.code !== 'ENOENT' && !RETRY.has(e.code))) throw e;
      }
      pause(25);
    }
  }
  try {
    return fn();
  } finally {
    if (held) fs.rmSync(lock, { force: true });
  }
}

module.exports = { writeAtomic, withLock };
