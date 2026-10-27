'use strict';
// "Undo only this edit" (the page's Restore question and the terminal's /editlens undo), and the
// terminal's list of recent edits. One implementation for both: the page routes and the hook-key routes in
// server.js only translate their input to (seq, n) and send back what these return.
// Every function returns { status, body }; body is { ok: true, text, ... } or { ok: false, ... }.

const path = require('path');
const { reverseEdit } = require('../lib/undoedit');
const { related } = require('../lib/paths');
const { readNow, GONE, skipReason } = require('./backups');

const RECENT_MAX = 30;
const REASON_MAX = 120;

// A positive whole number from input, or null.
function seqOf(v) {
  const n = typeof v === 'string' && /^\d{1,15}$/.test(v) ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// The edit's reason on one short line, or ''.
function oneLine(reason) {
  if (typeof reason !== 'string') return '';
  const line = reason.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const cut = line.length > REASON_MAX ? line.slice(0, REASON_MAX - 1).trimEnd() + '…' : line;
  return cut.replace(/[.\s]+$/, '');
}

function linesText(lines) {
  if (!Array.isArray(lines)) return '';
  const a = Number(lines[0]);
  const b = Number(lines[1]);
  if (!Number.isFinite(a) || a < 1) return '';
  if (!Number.isFinite(b) || b <= a) return `line ${a}`;
  return `lines ${a}–${b}`;
}

// The fixed message Claude gets when only it can undo the edit (a later edit touched its lines).
function conflictMessage({ n, file, lines, reason }) {
  const no = seqOf(n);
  const name = typeof file === 'string' && file ? file : 'this file';
  const extra = [linesText(lines), oneLine(reason)].filter(Boolean).join(', ');
  return `Undo only ${no ? `edit ${no}` : 'one edit'} in ${name}${extra ? ` (${extra})` : ''}. Keep the later changes.`;
}

function fileName(ev) {
  return String(ev.relFile || ev.file || 'this file');
}

// Same rule as inScope() in client/src/2-page.js: which edits a page with this root shows (and numbers).
function inPageScope(root, ev) {
  if (ev.remote && ev.remote.anywhere) return true;
  const f = ev.taskCwd || ev.realFile || ev.file || ev.cwd;
  if (!root || !f) return true;
  return related(root, f);
}

// A restore of a copy kept by a restore, a removal or an undo of one edit undoes that action.
function viaFor(done) {
  return done.reason === 'restore' || done.reason === 'remove' || done.reason === 'undo-edit' ? 'undo' : 'restore';
}

const fail = (status, body) => ({ status, body: { ok: false, ...body } });
// A refused write (server/backups.js): its reason, and noUndo when no Undo copy could be kept.
// gone: also say whether the copy is gone (a restore of a copy).
const refused = (status, done, gone = true) => fail(status, { error: done.error, ...(gone ? { gone: Boolean(done.gone) } : {}), ...(done.noUndo ? { noUndo: done.noUndo } : {}) });

function createUndo({ history, snapshots, backups, restoreEvent, log }) {
  // An edit by Claude in this project whose earlier text is kept (it has Restore).
  function findEdit(seq) {
    const s = seqOf(seq);
    const ev = s ? history.find((e) => e.seq === s) : null;
    if (!ev || ev.type !== 'change' || ev.kind === 'restore' || !ev.backup || ev.copy || ev.task || ev.remote || ev.fromTaskAccount || typeof ev.file !== 'string') return null;
    return ev;
  }
  // Why edit `seq` can't be undone or restored here, as a failure.
  function refuse(seq, n) {
    const s = seqOf(seq);
    const ev = s ? history.find((e) => e.seq === s) : null;
    const what = seqOf(n) ? `Edit ${seqOf(n)}` : 'That edit';
    if (!ev || ev.type !== 'change') return fail(404, { error: 'That edit is no longer listed. Reload the page, then try again.' });
    if (ev.kind === 'restore') return fail(409, { error: `${what} is a restore, not an edit by Claude. Use Undo on its card on the page.` });
    if (ev.copy || ev.task || ev.remote || ev.fromTaskAccount) return fail(409, { error: `${what} was made in a copy of the project or on another computer, so it can't be undone here.` });
    if (ev.created) return fail(409, { error: `${what} created ${fileName(ev)}, so there is no earlier version. Use Remove file on the page to undo it.` });
    return fail(409, { error: `No earlier version of ${fileName(ev)} was kept for ${what.toLowerCase()}, so it can't be undone here.` });
  }
  // Read directly: snapshots.get() also computes the diff, which is not needed here.
  function snapshotOf(ev) {
    return ev.snapshot && snapshots.items.has(ev.snapshot) ? snapshots.items.get(ev.snapshot) : null;
  }
  // The text the edit wrote is still known (needed to remove that edit alone).
  function afterKept(ev) {
    const snap = snapshotOf(ev);
    if (snap && typeof snap.after === 'string') return true;
    const item = backups.get(ev.backup);
    return Boolean(item && typeof item.after === 'string');
  }
  // The newest event in the history that matches.
  function latest(fn) {
    for (let i = history.length - 1; i >= 0; i--) if (fn(history[i])) return history[i];
    return null;
  }

  // Page numbers: a page numbers the edits in the order it gets them, starting with the first one.
  // anchor: { root, from } (from: the first seq that page got).
  function numbers(anchor) {
    const from = anchor && Number.isFinite(anchor.from) ? anchor.from : 0;
    const root = anchor && anchor.root ? anchor.root : null;
    const out = new Map();
    let n = 0;
    for (const e of history) if (e.seq >= from && e.type === 'change' && inPageScope(root, e)) out.set(e.seq, ++n);
    return out;
  }
  function seqForNumber(n, anchor) {
    const want = seqOf(n);
    if (!want) return null;
    for (const [s, no] of numbers(anchor)) if (no === want) return s;
    return null;
  }

  // The edit's text before and after it, and the file now. -> { ev, before, after, now } or a failure
  function texts(ev) {
    const item = backups.get(ev.backup);
    if (!item) return fail(404, { error: GONE, gone: true });
    const snap = snapshotOf(ev);
    const before = snap && typeof snap.before === 'string' ? snap.before : item.text;
    const after = snap && typeof snap.after === 'string' ? snap.after : item.after;
    const now = readNow(ev.file);
    if (now.error) return fail(409, { error: `Could not read ${fileName(ev)}: ${now.error}` });
    if (now.text === null) return fail(409, { error: `${fileName(ev)} no longer exists, so this edit can't be undone in it.` });
    return { ok: true, before, after, now: now.text };
  }

  function plan(ev, n) {
    const t = texts(ev);
    if (!t.ok) return { failure: t };
    const r = reverseEdit({ before: t.before, after: t.after, now: t.now });
    if (r.error === 'not-kept') return { failure: fail(409, { error: 'EditLens no longer has the text this edit wrote, so it can\'t undo only this edit. Restore still puts the whole file back.', notKept: true }) };
    if (r.error) return { failure: fail(409, { error: 'This edit changed nothing, so there is nothing to undo.' }) };
    if (!r.clean) {
      return { failure: fail(409, { conflict: true, lines: r.lines, message: conflictMessage({ n, file: fileName(ev), lines: r.lines, reason: ev.intent }) }) };
    }
    return { r, now: t.now };
  }

  // Can this edit be removed alone now? Changes nothing.
  function check(seq, n) {
    const ev = findEdit(seq);
    if (!ev) return refuse(seq, n);
    if (undoneNow(ev)) return { status: 200, body: { ok: false, undone: true, error: `${seqOf(n) ? `Edit ${seqOf(n)}` : 'This edit'} is already undone.` } };
    const p = plan(ev, n);
    if (p.failure) return { status: 200, body: p.failure.body };
    const noUndo = p.r.text === p.now ? null : skipReason(p.now);
    return { status: 200, body: { ok: true, clean: true, lines: p.r.lines, same: p.r.text === p.now, ...(noUndo ? { noUndo } : {}) } };
  }

  // The newest "Undo only this edit" of ev that was not put back since, or null.
  function undoneNow(ev) {
    const u = latest((e) => e.type === 'change' && e.via === 'undo-edit' && e.undidBackup === ev.backup && e.backup);
    if (!u) return null;
    const back = latest((e) => e.type === 'change' && e.restoredFrom === u.backup && e.seq > u.seq);
    return back ? null : u;
  }

  // root (undo, putBack): only a file there, its real path checked again at the write (a pairing's
  // folder, so a link made after the caller's check can't lead to a sibling project, Sol H3).
  // noUndo: true writes even when no Undo copy of the current file can be kept (refused otherwise).
  function undo(seq, n, { root = null, noUndo = false } = {}) {
    const ev = findEdit(seq);
    if (!ev) return refuse(seq, n);
    if (undoneNow(ev)) {
      const what = seqOf(n) ? `Edit ${seqOf(n)}` : 'This edit';
      return fail(409, { error: `${what} is already undone.`, undone: true });
    }
    const p = plan(ev, n);
    if (p.failure) return p.failure;
    const rel = fileName(ev);
    const what = seqOf(n) ? `edit ${seqOf(n)}` : 'this edit';
    if (p.r.text === p.now) return { status: 200, body: { ok: true, same: true, relFile: rel, text: `${rel} already does not have ${what}. Nothing changed.` } };
    const done = backups.replace({ file: ev.file, relFile: rel, cwd: ev.cwd, text: p.r.text, reason: 'undo-edit', keep: 'undo-edit', expect: p.now, root, noUndo });
    if (done.error) return refused(409, done, false);
    log(`undid only edit ${ev.seq} in ${ev.file}`);
    const out = restoreEvent(done, 'undo-edit', null, { undidSeq: ev.seq, undidBackup: ev.backup });
    return { status: 200, body: { ok: true, relFile: rel, undo: done.undo, via: 'undo-edit', seq: out.seq, lines: p.r.lines, text: `Undid only ${what} in ${rel}. Later changes kept.` } };
  }

  // Put it back: the file as it was before "Undo only this edit" (the copy kept first).
  function putBack(seq, n, { root = null, noUndo = false } = {}) {
    const ev = findEdit(seq);
    if (!ev) return refuse(seq, n);
    const u = latest((e) => e.type === 'change' && e.via === 'undo-edit' && e.undidBackup === ev.backup && e.backup);
    if (!u) return fail(404, { error: 'This edit was not undone, so there is nothing to put back.' });
    const rel = fileName(ev);
    const done = backups.restore(u.backup, { root, noUndo });
    if (done.error) return refused(done.gone ? 404 : 409, done);
    const what = seqOf(n) ? `edit ${seqOf(n)}` : 'the edit';
    if (done.same) return { status: 200, body: { ok: true, same: true, relFile: rel, text: `${rel} already has ${what} back. Nothing changed.` } };
    log(`put edit ${ev.seq} back in ${ev.file}`);
    const out = restoreEvent(done, viaFor(done), u.backup);
    return { status: 200, body: { ok: true, relFile: rel, undo: done.undo, via: 'undo', seq: out.seq, text: `Put ${what} back in ${rel}.` } };
  }

  // Restore N: the whole file as it was before edit N (later changes to it are undone too).
  function restore(seq, n, { noUndo = false } = {}) {
    const ev = findEdit(seq);
    if (!ev) return refuse(seq, n);
    const rel = fileName(ev);
    const done = backups.restore(ev.backup, { noUndo });
    if (done.error) return refused(done.gone ? 404 : 409, done);
    const what = seqOf(n) ? `edit ${seqOf(n)}` : 'the edit';
    if (done.same) return { status: 200, body: { ok: true, same: true, relFile: rel, text: `${rel} is already as it was before ${what}. Nothing changed.` } };
    log(`restored ${ev.file} from ${ev.backup}`);
    const via = viaFor(done);
    const out = restoreEvent(done, via, ev.backup);
    return { status: 200, body: { ok: true, relFile: rel, undo: done.undo, via, seq: out.seq, text: `Restored ${rel} as it was before ${what}. Later changes to it were undone too.` } };
  }

  // Restore N back: undo the newest restore of edit N's earlier version.
  function unrestore(seq, n, { noUndo = false } = {}) {
    const ev = findEdit(seq);
    if (!ev) return refuse(seq, n);
    const r = latest((e) => e.type === 'change' && e.kind === 'restore' && e.via === 'restore' && e.restoredFrom === ev.backup && e.backup);
    const what = seqOf(n) ? `edit ${seqOf(n)}` : 'this edit';
    if (!r) return fail(404, { error: `${fileName(ev)} was not restored from ${what}, so there is nothing to undo.` });
    const done = backups.restore(r.backup, { noUndo });
    if (done.error) return refused(done.gone ? 404 : 409, done);
    const rel = fileName(ev);
    if (done.same) return { status: 200, body: { ok: true, same: true, relFile: rel, text: `${rel} is already as it was before the restore. Nothing changed.` } };
    log(`undid the restore of ${ev.file}`);
    const out = restoreEvent(done, viaFor(done), r.backup);
    return { status: 200, body: { ok: true, relFile: rel, undo: done.undo, via: 'undo', seq: out.seq, text: `Undid the restore of ${rel}.` } };
  }

  // This session's edits, newest first, numbered like the page's markers.
  function recent({ session, anchor }) {
    const nums = numbers(anchor);
    const out = [];
    for (let i = history.length - 1; i >= 0 && out.length < RECENT_MAX; i--) {
      const e = history[i];
      if (e.type !== 'change' || e.kind === 'restore' || !nums.has(e.seq)) continue;
      if (session && e.sessionId !== session) continue;
      const ok = Boolean(findEdit(e.seq)) && backups.has(e.backup);
      const ts = Number(e.ts);
      // Line counts only when the edit came with them (null: not known, never shown as 0).
      const count = (v) => (e.stats && typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
      out.push({
        n: nums.get(e.seq), seq: e.seq, file: String(e.relFile || (typeof e.file === 'string' ? path.basename(e.file) : '')),
        reason: oneLine(e.intent), time: Number.isFinite(ts) && ts > 0 ? ts : null, canUndo: ok && afterKept(e), canRestore: ok, kind: typeof e.kind === 'string' ? e.kind : null,
        added: count(e.stats && e.stats.added), removed: count(e.stats && e.stats.removed), created: e.created === true,
        // Who made it: a subagent's id and type (the mod names it from the summary's agents), or Main.
        agentId: typeof e.agentId === 'string' && e.agentId ? e.agentId.slice(0, 100) : null, agentType: typeof e.agentType === 'string' && e.agentType ? oneLine(e.agentType).slice(0, 60) : null,
      });
    }
    return out;
  }

  return { findEdit, refuse, numbers, seqForNumber, check, undo, putBack, restore, unrestore, recent };
}

module.exports = { createUndo, conflictMessage, oneLine, linesText, seqOf, viaFor, inPageScope };
