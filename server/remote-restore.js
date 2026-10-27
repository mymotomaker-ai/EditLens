'use strict';
// Restore and "Undo only this edit" for an edit made on a paired computer. The page on the joined
// computer (a laptop) asks its own server, which asks the computer where the edit was made (a VPS)
// through the pairing link (op "edit-restore", server/pair-host.js). The VPS uses its own /restore code;
// the restore goes to the laptop's pages like its edits do. The VPS checks everything itself: the edit
// is in its history, made in the paired project (never a copy, a task's workspace or a task account's
// edit), and its file is in that project. Nothing the laptop sends is used as a path.

const path = require('path');
const { within } = require('../lib/paths');
const { fileIn } = require('../lib/safepath');
const { seqOf, viaFor, inPageScope } = require('./undo');
const { readNow, GONE, skipReason } = require('./backups');

const ACTIONS = new Set(['restore', 'remove', 'undo', 'back']);
const BACKUP_ID = /^b[0-9a-f]{16}$/;
const VIAS = new Set(['restore', 'undo', 'remove', 'undo-edit']);
const NOT_LISTED = 'That edit is no longer listed. Reload the page, then try again.';
const OUTSIDE = 'That file is not in the project this computer is paired with.';

const fail = (status, body) => ({ status, body: { ok: false, ...body } });
// No Undo copy of the current file can be kept: 'large' | 'binary' (server/backups.js skipReason).
const NO_UNDO = new Set(['large', 'binary']);
const noUndoOf = (v) => (NO_UNDO.has(v) ? { noUndo: v } : {});
const backupId = (v) => (typeof v === 'string' && BACKUP_ID.test(v) ? v : null);

// ---------- on the computer where the edit was made ----------
// history, backups, undo (server/undo.js), restoreEvent: this server's own. instance: this server
// start's id, sent with each edit's ref (numbers start again when EditLens here restarts).
function createHostRestore({ history, backups, undo, restoreEvent, log, instance = null }) {
  // An edit (or a restore) made here in the paired project: its file is in the paired folder where
  // it really leads, not only as written (a folder link to a sibling project, Sol H3).
  function ours(ev, pair) {
    return Boolean(ev && ev.type === 'change' && typeof ev.file === 'string' && path.isAbsolute(ev.file) && !ev.copy && !ev.task && !ev.remote && !ev.fromTaskAccount
      && pair && typeof pair.cwd === 'string' && pair.cwd && within(ev.file, pair.cwd) && !within(pair.cwd, ev.file) && !fileIn(pair.cwd, ev.file).error);
  }
  function relOf(ev, pair) {
    return path.relative(pair.cwd, ev.file).split(path.sep).join('/');
  }
  function newest(fn) {
    for (let i = history.length - 1; i >= 0; i--) if (fn(history[i])) return history[i];
    return null;
  }

  // pair: the pairing the request came through (never from the request). -> { status, body }
  function handle(pair, body) {
    const what = body && typeof body.do === 'string' && ACTIONS.has(body.do) ? body.do : null;
    if (!what) return fail(400, { error: 'EditLens here does not know that request. Update EditLens on both computers.' });
    const check = body.check === true;
    // "Restore without Undo" on the page there: write even when no Undo copy can be kept here.
    const noUndo = body.noUndo === true;

    if (what === 'restore') {
      // By the copy it puts back: an edit's earlier version, or the copy a restore kept (its Undo).
      const id = backupId(body.backup);
      const ev = id ? newest((e) => e.type === 'change' && e.backup === id) : null;
      if (!ev) return fail(404, { error: NOT_LISTED });
      if (!ours(ev, pair)) return fail(403, { error: OUTSIDE });
      const item = backups.get(id);
      if (!item) return fail(404, { error: GONE, gone: true });
      if (item.file !== ev.file) return fail(403, { error: OUTSIDE });
      if (check) {
        const c = backups.check(id);
        if (c.error) return c.gone ? fail(404, { error: c.error, gone: true }) : { status: 200, body: { ok: false, error: c.error } };
        return { status: 200, body: { ok: true, exists: c.exists, same: c.same, readOnly: c.readOnly, ...noUndoOf(c.noUndo) } };
      }
      // The write is checked against the paired folder again (a link made since the check above).
      const done = backups.restore(id, { root: pair.cwd, noUndo });
      if (done.error) return fail(done.gone ? 404 : 409, { error: done.error, gone: Boolean(done.gone), ...noUndoOf(done.noUndo) });
      if (done.same) return { status: 200, body: { ok: true, same: true, undo: null } };
      log(`restored ${item.file} from ${id} (asked by ${pair.name})`);
      const via = viaFor(done);
      restoreEvent(done, via, id);
      return { status: 200, body: { ok: true, undo: done.undo, via, missing: Boolean(done.missing) } };
    }

    // The others name the edit by its number here, its copy and its file, as this computer sent
    // them; all three must match (numbers start again when EditLens here restarts).
    const s = seqOf(body.seq);
    // An edit from before a restart here is never matched to a new one with its number (Sol M1).
    // An older EditLens there sends no instance: refused, as the number alone can name another edit (Sol M3).
    if (body.inst === undefined && instance) return fail(409, { error: 'EditLens on the other computer is older. Update EditLens on both computers, then try again.' });
    if (body.inst !== undefined && body.inst !== instance) return fail(404, { error: NOT_LISTED });
    const ev = s ? history.find((e) => e.seq === s) : null;
    if (!ev) return fail(404, { error: NOT_LISTED });
    if (!ours(ev, pair)) return fail(403, { error: OUTSIDE });
    if ((backupId(body.backup) || null) !== (ev.backup || null) || body.rel !== relOf(ev, pair)) return fail(404, { error: NOT_LISTED });

    if (what === 'remove') {
      if (!ev.created || ev.deleted || ev.kind === 'restore') return fail(409, { error: 'This edit did not create the file, so there is nothing to remove.' });
      if (check) {
        const now = readNow(ev.file);
        if (now.error) return { status: 200, body: { ok: false, error: `Could not read the file: ${now.error}` } };
        return { status: 200, body: { ok: true, exists: now.text !== null, ...noUndoOf(now.text === null ? null : skipReason(now.text)) } };
      }
      const done = backups.removeFile({ file: ev.file, relFile: ev.relFile, cwd: ev.cwd, root: pair.cwd, noUndo });
      if (done.error) return fail(409, { error: done.error, ...noUndoOf(done.noUndo) });
      log(`removed ${ev.file} (created by edit ${s}, asked by ${pair.name})`);
      restoreEvent(done, 'remove', null, { removedSeq: s });
      return { status: 200, body: { ok: true, undo: done.undo, deleted: true } };
    }
    // Numbers on the pages there differ from this computer's, so messages name no number.
    // The paired folder again at the write, as for Restore above.
    if (what === 'undo') return check ? undo.check(s, null) : undo.undo(s, null, { root: pair.cwd, noUndo });
    return undo.putBack(s, null, { root: pair.cwd, noUndo });
  }

  return { handle };
}

// ---------- on the computer whose page asks ----------
// history: this server's events; pairs: server/pair-remote.js; follow(name): keep getting that
// computer's edits (so the result shows on the page).
function createRemoteRestore({ history, pairs, follow }) {
  // The remote edit a page's /restore request is about, or null when it is about a local one.
  // { undoEdit | remove: seq } name the card; { remote: true, edit: seq, id } names the card and the copy.
  function target(body) {
    if (body.remote === true) {
      const s = seqOf(body.edit);
      return { ev: (s && history.find((e) => e.seq === s)) || null };
    }
    const raw = body.undoEdit !== undefined ? body.undoEdit : body.remove;
    const s = raw === undefined ? null : seqOf(raw);
    const ev = s ? history.find((e) => e.seq === s) : null;
    return ev && ev.remote ? { ev } : null;
  }

  // -> Promise<{ status, body }>
  async function handle(page, body, { ev }) {
    if (!ev || ev.type !== 'change' || !ev.remote || typeof ev.remote !== 'object') return fail(404, { error: NOT_LISTED });
    if (!inPageScope(page.root, ev)) return fail(403, { error: 'That file belongs to another project.' });
    const r = ev.remote;
    const name = typeof r.computer === 'string' && r.computer ? r.computer : 'the paired computer';
    const check = body.check === true;
    // Shown disabled on the page, with the reason: a check is not an error.
    const blocked = (error) => (check ? { status: 200, body: { ok: false, blocked: true, error } } : fail(409, { blocked: true, error }));
    const OLD = `Update EditLens on ${name} to restore its edits.`;
    if (r.old) return blocked(OLD);
    const ref = r.ref;
    if (!ref || typeof ref !== 'object') return fail(409, { error: `This edit on ${name} can't be restored from here.` });
    let ask;
    if (body.remote === true) {
      const id = backupId(body.id);
      if (!id) return fail(404, { error: GONE, gone: true });
      ask = { do: 'restore', backup: id };
    } else {
      ask = { do: body.remove !== undefined ? 'remove' : body.back === true ? 'back' : 'undo', seq: ref.seq, backup: ref.backup || null, rel: ref.rel, ...(ref.inst ? { inst: ref.inst } : {}) };
    }
    // Only when the user chose it on the card ("Restore without Undo").
    if (body.noUndo === true && !check) ask.noUndo = true;
    const got = await pairs.editRestore(typeof r.link === 'string' ? r.link : '', { op: 'edit-restore', ...ask, check });
    if (got.down) return blocked(`${name} is not connected. Try again when it reconnects.`);
    if (got.old) return blocked(OLD);
    const out = clean(got.answer, ev, name);
    if (!check && out.body.ok && !out.body.same) follow(typeof r.link === 'string' ? r.link : '');
    return out;
  }

  // Only known fields, in known shapes, from the other computer's response.
  function clean(answer, ev, name) {
    if (!answer || typeof answer !== 'object') return fail(502, { error: `${name} sent a response EditLens could not read. Try again.` });
    if (typeof answer.error === 'string') return fail(502, { error: `${name}: ${answer.error.slice(0, 300)}` });
    const b = answer.body && typeof answer.body === 'object' && !Array.isArray(answer.body) ? answer.body : null;
    const st = Number(answer.status);
    if (!b || !Number.isInteger(st) || st < 200 || st > 599) return fail(502, { error: `${name} sent a response EditLens could not read. Try again.` });
    const out = { ok: b.ok === true, relFile: typeof ev.relFile === 'string' ? ev.relFile : undefined };
    for (const k of ['same', 'exists', 'readOnly', 'gone', 'conflict', 'notKept', 'deleted', 'missing', 'clean']) if (b[k] !== undefined) out[k] = b[k] === true;
    for (const [k, n] of [['error', 500], ['text', 500], ['message', 1000]]) if (typeof b[k] === 'string') out[k] = b[k].slice(0, n);
    if (typeof b.via === 'string' && VIAS.has(b.via)) out.via = b.via;
    Object.assign(out, noUndoOf(b.noUndo));
    const undo = backupId(b.undo);
    if (b.undo !== undefined) out.undo = undo;
    if (Array.isArray(b.lines)) {
      const a = Number(b.lines[0]);
      const z = Number(b.lines[1]);
      if (Number.isSafeInteger(a) && a > 0 && Number.isSafeInteger(z) && z >= a) out.lines = [a, z];
    }
    if (!out.ok && !out.error && !out.conflict) out.error = `${name} could not do it. Try again.`;
    return { status: st, body: out };
  }

  return { target, handle };
}

module.exports = { createHostRestore, createRemoteRestore, BACKUP_ID };
