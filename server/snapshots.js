'use strict';
// File text before/after each edit and for show_code. Events include only the id, so the event
// stream and replay history stay small.

const { diffText } = require('../lib/diff');

const MAX_SNAPSHOTS = 80;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_PENDING = 32;
// Hunks above this many lines are not animated line by line; the page shows the result.
const MAX_ANIMATED_LINES = 3000;

function usableText(text) {
  return typeof text === 'string' && Buffer.byteLength(text) <= MAX_FILE_BYTES && !text.includes('\u0000');
}

class SnapshotStore {
  constructor() {
    this.items = new Map(); // id -> snapshot
    this.bytes = 0;
    this.before = new Map(); // toolUseId -> file text read just before the edit
    this.existed = new Map(); // toolUseId -> whether the file was there before the edit
  }

  // Whether the file existed before this tool call (true / false), or null when unknown.
  existedBefore(toolUseId) {
    return toolUseId && this.existed.has(toolUseId) ? this.existed.get(toolUseId) : null;
  }

  // PreToolUse reads the file before Claude changes it.
  rememberBefore(toolUseId, text, existed) {
    if (toolUseId && typeof existed === 'boolean') {
      this.existed.set(toolUseId, existed);
      while (this.existed.size > MAX_PENDING) this.existed.delete(this.existed.keys().next().value);
    }
    if (!toolUseId || !usableText(text)) return;
    this.before.set(toolUseId, text);
    while (this.before.size > MAX_PENDING) this.before.delete(this.before.keys().next().value);
  }

  takeBefore(toolUseId) {
    if (!toolUseId || !this.before.has(toolUseId)) return null;
    const text = this.before.get(toolUseId);
    this.before.delete(toolUseId);
    return text;
  }

  // Returns the new snapshot id, or null when the text is missing, binary or too large.
  add(id, { file, relFile, before, after, kind }) {
    if (!usableText(after)) return null;
    const snap = {
      id,
      file: String(file || ''),
      relFile: String(relFile || file || ''),
      kind: kind || 'view',
      before: usableText(before) ? before : null,
      after,
      hunks: undefined, // computed on first request
    };
    snap.size = Buffer.byteLength(after) + (snap.before ? Buffer.byteLength(snap.before) : 0);
    this.items.set(id, snap);
    this.bytes += snap.size;
    while (this.items.size > MAX_SNAPSHOTS || this.bytes > MAX_TOTAL_BYTES) {
      const [oldId, old] = this.items.entries().next().value;
      this.items.delete(oldId);
      this.bytes -= old.size;
    }
    return id;
  }

  get(id) {
    const snap = this.items.get(id);
    if (!snap) return null;
    if (snap.hunks === undefined) {
      if (snap.before === null) {
        snap.hunks = null;
      } else {
        const hunks = diffText(snap.before, snap.after);
        const lines = hunks.reduce((n, h) => n + h.lines.length, 0);
        snap.hunks = lines <= MAX_ANIMATED_LINES ? hunks : null;
      }
    }
    return { id: snap.id, file: snap.file, relFile: snap.relFile, kind: snap.kind, before: snap.before, after: snap.after, hunks: snap.hunks };
  }
}

module.exports = { SnapshotStore, MAX_FILE_BYTES };
