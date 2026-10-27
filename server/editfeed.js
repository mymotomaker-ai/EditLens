'use strict';
// The edits paired computers see live (server/tasks.js pushEdit, editsFor), kept on disk and by size,
// not count, so a laptop that was closed, asleep or offline, or a restart here, loses nothing within
// BUDGET: it continues from the position it saved (pair-follow.json there).
// Two files rotate: new edits go to the current one; when it is over half of BUDGET the older file is
// removed and the current one becomes the older. Removed edits are counted (`dropped`), so the other
// computer's page can say how many of its edits were not kept.
const fs = require('fs');
const path = require('path');

const BUDGET = 24 * 1024 * 1024; // bytes of edits kept (both files), file text included
const DROPPED_KEPT = 20000; // removed edits remembered (no text), to count what a computer missed
const FILES = ['edits-old.jsonl', 'edits.jsonl'];
const IO_CODES = ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'EBUSY', 'EISDIR', 'ENOTDIR', 'EIO', 'EMFILE'];

class EditFeed {
  constructor({ dir, log, budget = BUDGET }) {
    this.dir = dir;
    this.log = log || (() => {});
    this.half = Math.max(1, Math.floor(budget / 2));
    this.old = []; // { it, size } in the older file
    this.cur = [];
    this.curSize = 0;
    this.dropped = []; // { fseq, kind, pairId, file, sessionCwd } of removed edits, oldest first
    this.droppedMore = false; // more were removed than DROPPED_KEPT remembers
    this.disk = true; // false after a write failed: kept in memory only
    this.load();
  }

  file(i) {
    return path.join(this.dir, FILES[i]);
  }

  readLines(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      if (!IO_CODES.includes(err.code)) throw err;
      this.log(`paired computers' edits: can't read ${file} (${err.code}); starting without them`);
      return [];
    }
    const out = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const it = JSON.parse(line);
        if (it && Number.isSafeInteger(it.fseq)) out.push({ it, size: Buffer.byteLength(line) + 1 });
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err; // a line left incomplete by a crash: skipped
      }
    }
    return out;
  }

  load() {
    this.old = this.readLines(this.file(0));
    this.cur = this.readLines(this.file(1));
    this.curSize = this.cur.reduce((n, x) => n + x.size, 0);
    let dropped = null;
    try {
      dropped = JSON.parse(fs.readFileSync(path.join(this.dir, 'edits-dropped.json'), 'utf8'));
    } catch (err) {
      if (!(err instanceof SyntaxError) && err.code !== 'ENOENT' && !IO_CODES.includes(err.code)) throw err;
    }
    if (dropped && Array.isArray(dropped.list)) {
      this.dropped = dropped.list.filter((d) => d && Number.isSafeInteger(d.fseq)).slice(-DROPPED_KEPT);
      this.droppedMore = dropped.more === true;
    }
  }

  // Every kept edit, oldest first.
  items() {
    return this.old.map((x) => x.it).concat(this.cur.map((x) => x.it));
  }

  // The newest edit's number, or 0.
  last() {
    const all = this.cur.length ? this.cur : this.old;
    return all.length ? all[all.length - 1].it.fseq : 0;
  }

  push(it) {
    const line = JSON.stringify(it);
    const size = Buffer.byteLength(line) + 1;
    if (this.curSize + size > this.half && this.cur.length) this.rotate();
    this.cur.push({ it, size });
    this.curSize += size;
    this.write(() => {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // The file text of edits: only this user reads it.
      fs.appendFileSync(this.file(1), line + '\n', { mode: 0o600 });
    });
  }

  // The older file is removed; the current one becomes the older one.
  rotate() {
    for (const { it } of this.old) {
      this.dropped.push({ fseq: it.fseq, kind: it.kind, pairId: it.pairId || null, file: it.file, sessionCwd: it.sessionCwd || null });
    }
    if (this.dropped.length > DROPPED_KEPT) {
      this.dropped.splice(0, this.dropped.length - DROPPED_KEPT);
      this.droppedMore = true;
    }
    if (this.old.length) this.log(`paired computers' edits: ${this.old.length} older edits removed (over ${Math.round((this.half * 2) / 1024 / 1024)} MB kept)`);
    this.old = this.cur;
    this.cur = [];
    this.curSize = 0;
    this.write(() => {
      fs.renameSync(this.file(1), this.file(0));
      fs.writeFileSync(path.join(this.dir, 'edits-dropped.json'), JSON.stringify({ list: this.dropped, more: this.droppedMore }), { mode: 0o600 });
    });
  }

  write(fn) {
    if (!this.disk) return;
    try {
      fn();
    } catch (err) {
      if (!IO_CODES.includes(err.code)) throw err;
      this.disk = false;
      this.log(`paired computers' edits: can't save them in ${this.dir} (${err.code}); kept in memory until EditLens restarts`);
    }
  }

  // Removed edits after `from` that `visible` (a kept edit -> bool) lets that computer see.
  // -> { count, more } (more: older ones were removed too, beyond what is remembered) | null
  lost(from, visible) {
    if (!(from > 0) || !this.dropped.length) return null;
    let count = 0;
    for (const d of this.dropped) if (d.fseq > from && visible(d)) count++;
    const more = this.droppedMore && from < this.dropped[0].fseq;
    return count || more ? { count, more } : null;
  }
}

module.exports = { EditFeed, BUDGET };
