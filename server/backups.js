'use strict';
// On-disk copies of files from before Claude changed them, for "Restore previous version".
// New files have no copy. A restore saves the current file first, so it can be undone.

const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('../lib/atomic');
const { inside, fileIn } = require('../lib/safepath');
const crypto = require('crypto');

const MAX_COPIES = 200;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ID = /^b[0-9a-f]{16}$/;
// The copies are listed in memory (save adds, remove and prune delete). The folder is read again
// after this many saves, so copies another process saved (bin/connect.js) are counted too.
const REREAD_SAVES = 100;

function usable(text) {
  return typeof text === 'string' && Buffer.byteLength(text) <= MAX_FILE_BYTES && !text.includes('\u0000');
}

class BackupStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.index = null; // [{ name, size, time }], oldest first; null: not read yet
    this.stale = false; // read the folder again before the next use
    this.saves = 0;
  }

  pathOf(id) {
    return path.join(this.dir, id + '.json');
  }

  // -> backup id, or null when there is nothing worth keeping.
  // after: the file as the edit left it, kept too so "Undo only this edit" still works after a restart.
  save({ file, relFile, cwd, text, reason, after }) {
    if (typeof file !== 'string' || !path.isAbsolute(file) || !usable(text)) return null;
    const id = 'b' + crypto.randomBytes(8).toString('hex');
    const item = { id, file, relFile: String(relFile || path.basename(file)), cwd: typeof cwd === 'string' ? cwd : null, text, reason: reason || 'edit', ts: Date.now() };
    if (usable(after)) item.after = after;
    const json = JSON.stringify(item);
    fs.writeFileSync(this.pathOf(id), json);
    if (this.index) this.index.push({ name: id + '.json', size: Buffer.byteLength(json), time: Date.now() });
    if (++this.saves >= REREAD_SAVES) {
      this.saves = 0;
      this.stale = true;
    }
    this.prune();
    return id;
  }

  get(id) {
    if (typeof id !== 'string' || !ID.test(id)) return null;
    let raw;
    try {
      raw = fs.readFileSync(this.pathOf(id), 'utf8');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM')) return null;
      throw err;
    }
    try {
      const item = JSON.parse(raw);
      return item && typeof item.file === 'string' && typeof item.text === 'string' ? item : null;
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  }

  // The kept copies, oldest first: [{ name, size, time }].
  list() {
    return this.current().slice();
  }

  current() {
    if (!this.index || this.stale) {
      this.index = this.readFolder(this.index || []);
      this.stale = false;
    }
    return this.index;
  }

  // The copies in the folder. known: the list read until now, whose order is kept (file times can be
  // coarser than the time between two saves); only copies it does not have are read.
  readFolder(known) {
    const had = new Map(known.map((f, pos) => [f.name, { ...f, pos }]));
    let names;
    try {
      names = fs.readdirSync(this.dir).filter((n) => /^b[0-9a-f]{16}\.json$/.test(n));
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
    const out = [];
    for (const n of names) {
      if (had.has(n)) {
        out.push(had.get(n));
        continue;
      }
      try {
        const st = fs.statSync(path.join(this.dir, n));
        out.push({ name: n, size: st.size, time: st.mtimeMs, pos: known.length });
      } catch (err) {
        if (!(err && err.code === 'ENOENT')) throw err;
      }
    }
    return out.sort((a, b) => a.time - b.time || a.pos - b.pos).map(({ pos: _p, ...f }) => f);
  }

  // Removes the oldest copies first once there are too many or they take too much space.
  prune() {
    const all = this.current();
    let total = all.reduce((n, f) => n + f.size, 0);
    let gone = false;
    while (all.length && (all.length > MAX_COPIES || total > MAX_TOTAL_BYTES)) {
      const old = all[0];
      try {
        fs.unlinkSync(path.join(this.dir, old.name));
      } catch (err) {
        if (!(err && err.code === 'ENOENT')) throw err;
        gone = true; // removed by something else: the list is older than the current state
      }
      all.shift();
      total -= old.size;
    }
    if (gone) this.stale = true;
  }

  // Whether backup `id` is still kept.
  has(id) {
    return typeof id === 'string' && ID.test(id) && fs.existsSync(this.pathOf(id));
  }

  remove(id) {
    if (typeof id !== 'string' || !ID.test(id)) return;
    try {
      fs.unlinkSync(this.pathOf(id));
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) throw err;
    }
    if (this.index) this.index = this.index.filter((f) => f.name !== id + '.json');
  }

  // What a restore of `id` would do, for the question asked first. noUndo: the current file can't
  // be kept for Undo ('large' | 'binary'), so the restore needs noUndo: true.
  // -> { ok, relFile, exists, same, readOnly, noUndo? } or { error, gone }
  check(id) {
    const item = this.get(id);
    if (!item) return { error: GONE, gone: true };
    const at = checked(item.file, item.cwd, item.relFile);
    if (at.error) return at;
    const now = readNow(at.file);
    if (now.error) return { error: `Could not read ${item.relFile}: ${now.error}` };
    const noUndo = now.text !== null && now.text !== item.text ? skipReason(now.text) : null;
    return { ok: true, file: item.file, relFile: item.relFile, cwd: item.cwd, exists: now.text !== null, same: now.text === item.text, readOnly: now.text !== null && readOnly(item.file), ...(noUndo ? { noUndo } : {}) };
  }

  // Puts the file back as it was in backup `id`. The current text is kept first (the undo copy),
  // and deleted again if the write fails. root: only a file there (a pairing's folder), links resolved.
  // noUndo: true writes even when the current text can't be kept (refused otherwise, with noUndo).
  // -> { ok, file, relFile, cwd, undo, same, before, after, reason, missing } or { error, gone?, noUndo? }
  restore(id, { root = null, noUndo = false } = {}) {
    const item = this.get(id);
    if (!item) return { error: GONE, gone: true };
    return this.replace({ file: item.file, relFile: item.relFile, cwd: item.cwd, text: item.text, reason: item.reason || 'edit', root, noUndo });
  }

  // Writes `text` to the file, keeping its current text first (an undo copy saved with `keep` as
  // its reason). expect: the text the caller worked from; the file changed since -> not written.
  // -> like restore()
  replace({ file: given, relFile, cwd, text, reason, keep, expect, root = null, noUndo = false }) {
    const base = { file: given, relFile, cwd, reason: reason || 'edit' };
    const at = checked(given, cwd, relFile, root);
    if (at.error) return at;
    const file = at.file;
    const now = readNow(file);
    if (now.error) return { error: `Could not read ${relFile}: ${now.error}` };
    if (expect !== undefined && now.text !== expect) return { error: `${relFile} changed just now, so it was not changed. Try again.` };
    if (now.text === text) return { ok: true, ...base, undo: null, same: true };
    if (now.text !== null && readOnly(file)) return { error: `${relFile} is read-only, so it was not changed. Make it writable, then try again.` };
    let undo = null;
    // Over 2 MB or not text: no copy can be kept, so this can't be undone (Sol 0.24.46 M6).
    const why = now.text === null ? null : skipReason(now.text);
    if (why && noUndo !== true) return noUndoRefusal(relFile, why, 'changed');
    if (now.text !== null && !why) {
      try {
        undo = this.save({ file, relFile, cwd, text: now.text, reason: keep || 'restore' });
      } catch (err) {
        if (!(err && err.code)) throw err;
        return { error: `Could not keep a copy of the current ${relFile} (${err.code}), so it was not changed.` };
      }
    }
    try {
      writeAtomic(file, text, { mkdir: true, keepOwner: true });
    } catch (err) {
      this.remove(undo);
      if (err && err.code) return { error: `Could not write ${relFile}: ${err.code}` };
      throw err;
    }
    return { ok: true, ...base, undo, before: now.text, after: text, missing: now.text === null };
  }

  // Removes a file Claude created; its text is kept first, so restoring that copy creates it again.
  // A file that can't be kept is removed only with noUndo: true.
  // -> { ok, undo, before, after: '' } or { error }
  removeFile({ file: given, relFile, cwd, root = null, noUndo = false }) {
    const rel = String(relFile || path.basename(given));
    const at = checked(given, cwd, rel, root);
    if (at.error) return at;
    const file = at.file;
    const now = readNow(file);
    if (now.error) return { error: `Could not read ${rel}: ${now.error}` };
    if (now.text === null) return { error: `${rel} is already gone.` };
    const why = skipReason(now.text);
    if (why && noUndo !== true) return noUndoRefusal(rel, why, 'removed');
    let undo = null;
    try {
      if (!why) undo = this.save({ file, relFile: rel, cwd, text: now.text, reason: 'remove' });
    } catch (err) {
      if (!(err && err.code)) throw err;
      return { error: `Could not keep a copy of ${rel} (${err.code}), so it was not removed.` };
    }
    try {
      fs.unlinkSync(file);
    } catch (err) {
      this.remove(undo);
      if (err && err.code) return { error: `Could not remove ${rel}: ${err.code}` };
      throw err;
    }
    return { ok: true, file: given, relFile: rel, cwd, undo, before: now.text, after: '', deleted: true, reason: 'remove' };
  }
}

// The saved file, checked again now (lib/safepath.js): a folder in its path may have become a link
// since the edit. It may not lead outside the project, nor to a file EditLens keeps out of tasks
// (.claude, .git, keys) when the saved name was not one. root: a pairing's folder, which the file
// must really be in too (Sol H3). -> { file: the real path } | { error }
function checked(file, cwd, relFile, root = null) {
  const at = inProject(file, cwd, relFile);
  if (at.error || !root) return at;
  const r = fileIn(root, at.file);
  return r.error ? { error: `${relFile} is outside the paired folder (through a folder link), so it was not changed.` } : { file: r.file };
}
function inProject(file, cwd, relFile) {
  // Saved without its project, or outside it from the start: nothing to check against (as before).
  if (typeof cwd !== 'string' || !cwd) return { file };
  const rel = path.relative(cwd, file).split(path.sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || path.isAbsolute(rel)) return { file };
  const at = inside(cwd, rel);
  if (at.error === 'outside') return { error: `${relFile} is outside the project now (a folder in its path is a link), so it was not changed.` };
  if (at.error) return { error: `Could not read ${relFile}: ${at.error}` };
  const { excluded } = require('../lib/sendproject');
  if (excluded(at.rel) && !excluded(rel)) return { error: `${relFile} now leads to ${at.rel} (a folder in its path is a link), so it was not changed.` };
  return { file: at.file };
}

const GONE = 'That earlier version is no longer kept (EditLens keeps the last 200).';

// A write refused because its Undo copy can't be kept. why: 'large' | 'binary'; done: 'changed' | 'removed'.
function noUndoRefusal(rel, why, done) {
  const what = why === 'binary' ? 'is not a text file' : `is over ${MAX_FILE_BYTES / 1024 / 1024} MB`;
  return { error: `${rel} ${what}, so its current version can't be kept for Undo. It was not ${done}.`, noUndo: why };
}

// The file's text now: { text } (null when it is not there) or { error: code }. Read from the
// descriptor it was checked on, up to the size it had then; O_NONBLOCK: a named pipe put in its
// place is refused, not waited on.
function readNow(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
  } catch (err) {
    if (err && err.code === 'ENOENT') return { text: null };
    if (err && err.code) return { error: err.code };
    throw err;
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: st.isDirectory() ? 'EISDIR' : 'not a file' };
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    return { text: buf.toString('utf8', 0, got) };
  } catch (err) {
    if (err && err.code) return { error: err.code };
    throw err;
  } finally {
    fs.closeSync(fd);
  }
}

// A file nobody may write (mode r--r--r--, or no write access for this user). Renaming over it would
// still work, so this is checked first.
function readOnly(file) {
  try {
    if ((fs.statSync(file).mode & 0o222) === 0) return true;
    fs.accessSync(file, fs.constants.W_OK);
    return false;
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS')) return true;
    if (err && err.code) return false;
    throw err;
  }
}

// Why an edit's earlier text is not kept: 'large', 'binary', or null.
function skipReason(text, size) {
  if (typeof text === 'string') return Buffer.byteLength(text) > MAX_FILE_BYTES ? 'large' : text.includes('\u0000') ? 'binary' : null;
  return Number.isFinite(size) && size > MAX_FILE_BYTES ? 'large' : null;
}

module.exports = { BackupStore, MAX_FILE_BYTES, skipReason, GONE, readNow };
