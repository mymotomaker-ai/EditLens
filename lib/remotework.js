'use strict';
// This computer's side of tasks on a paired computer that work on THIS computer's project: the
// project is sent with the task, which works on a copy there, and its changed files are copied
// back only where this project's file is still as it was sent.
// call(op, extra) -> the paired computer's response ({ error } on failure), through the live-page
// MCP tool's link (POST /remote/task); this file has no network code.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const sendproject = require('./sendproject');
const safepath = require('./safepath');
const { diffText } = require('./diff');
const { writeAtomic } = require('./atomic');

// Raw bytes per upload request (the link has a 1 MB line limit, base64 adds a third, uploads may be slow).
const PART = 256 * 1024;
// That computer receives two projects from here at a time (server/tasks.js receive).
const BUSY_SENDING = /already being sent/i;
const SEND_WAIT_MS = 5 * 60000;
const SEND_RETRY_MS = 1000;
const FETCH_MAX = 8 * 1024 * 1024; // one file copied back
const KEPT = 50; // sent-project records kept

function git(dir, args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  return !r.error && r.status === 0 ? String(r.stdout).trim() : null;
}

// "git@github.com:me/app.git", "https://github.com/me/app" -> "github.com/me/app"
function remoteKey(url) {
  const s = String(url || '').trim().toLowerCase().replace(/\.git$/, '').replace(/\/+$/, '');
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](.+)$/.exec(s);
  return m ? `${m[1]}/${m[2]}` : s || null;
}

// Is the paired computer's project the same code as this one? -> { same: true|false|null, theirs }
// (null: that computer runs an older EditLens that can't tell).
async function compareProjects(call, dir) {
  const theirs = await call('project', {});
  if (!theirs || theirs.error) return { same: null, theirs: null };
  const roots = (git(dir, ['rev-list', '--max-parents=0', 'HEAD']) || '').split('\n').filter(Boolean);
  const mine = remoteKey(git(dir, ['remote', 'get-url', 'origin']));
  const same = roots.some((r) => (theirs.roots || []).includes(r)) || Boolean(mine && remoteKey(theirs.remote) === mine);
  return { same, theirs };
}

function recordFile(stateDir, task) {
  return path.join(stateDir, 'sent', `${String(task).replace(/[^0-9a-f]/g, '')}.json`);
}
function saveRecord(stateDir, task, record) {
  const dir = path.join(stateDir, 'sent');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordFile(stateDir, task), JSON.stringify(record), { mode: 0o600 });
  const all = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const old of all.slice(KEPT)) fs.unlinkSync(path.join(dir, old.n));
}
function readRecord(stateDir, task) {
  try {
    const r = JSON.parse(fs.readFileSync(recordFile(stateDir, task), 'utf8'));
    return r && typeof r.dir === 'string' && r.manifest && typeof r.manifest === 'object' ? r : null;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) return null;
    throw err;
  }
}

// Sends the project and starts the task on it. -> the task's report (with sent: { files, skipped })
// | { error }. effort: the task's level (lib/effort.js), sent as its own field; none: server default.
async function sendAndStart(call, { dir, prompt, stateDir, computer, effort }) {
  const packed = await sendproject.pack(dir);
  if (!packed.count) return { error: 'This project has no files to send.' };
  let upload = null;
  const waitUntil = Date.now() + SEND_WAIT_MS;
  for (let at = 0; at < packed.bundle.length || upload === null; at += PART) {
    let res = await call('upload', { upload: upload || undefined, data: packed.bundle.subarray(at, at + PART).toString('base64') });
    // Several tasks sent at the same time: that computer accepts two projects at a time, so the others wait
    // instead of failing.
    while (!upload && res && typeof res.error === 'string' && BUSY_SENDING.test(res.error) && Date.now() < waitUntil) {
      await new Promise((r) => setTimeout(r, SEND_RETRY_MS));
      res = await call('upload', { data: packed.bundle.subarray(at, at + PART).toString('base64') });
    }
    if (!res || res.error) {
      const e = res && res.error ? res.error : 'no answer';
      const who = computer || 'That computer';
      // First part refused: that EditLens can't accept a project. A later part: it restarted while
      // the project was being sent (an update), so the parts it had are lost.
      if (/No such task|Unknown op/i.test(e)) return { error: `${who} runs an older EditLens that can't take this project. Update EditLens there.` };
      if (upload && /expired|not received/i.test(e)) return { error: `${who} restarted while the project was being sent (EditLens there was probably updated). Start the task again.` };
      return { error: /closed the connection/.test(e) ? e : `Sending the project failed: ${e}` };
    }
    upload = res.upload;
    if (packed.bundle.length === 0) break;
  }
  const report = await call('start', { prompt, upload, ...(effort ? { effort } : {}) });
  if (!report || report.error) return report || { error: 'no answer' };
  saveRecord(stateDir, report.task, { dir, computer: computer || report.computer || null, manifest: packed.manifest, at: Date.now() });
  return { ...report, sent: { files: packed.count, bytes: packed.bytes, skipped: packed.skipped.slice(0, 50), notSent: 'node_modules, .git, .env files, .claude and .mcp.json stay on this computer' } };
}

// A whole file from the task's workspace. -> { data: Buffer } | { missing: true } | { error }
async function fetchFile(call, task, rel) {
  return fetchPages((offset) => call('file', { task, path: rel, offset }), FETCH_MAX);
}

// A file read in pages. -> { data } | { missing } | { error }. Each page must start where the last
// one ended (no gap, no overlap, no start again from 0), and the bytes are counted up to max.
async function fetchPages(ask, max) {
  const parts = [];
  let offset = 0;
  for (;;) {
    const page = await ask(offset);
    if (!page || page.error) return { error: page && page.error ? page.error : 'no answer' };
    if (page.missing) return { missing: true };
    const buf = Buffer.from(String(page.data || ''), 'base64');
    parts.push(buf);
    offset += buf.length;
    if (offset > max) return { error: `larger than ${max / 1024 / 1024} MB` };
    if (page.next === null || page.next === undefined) break;
    if (!buf.length || Number(page.next) !== offset) return { error: 'bad page' };
  }
  return { data: Buffer.concat(parts) };
}

const isText = (b) => !b.subarray(0, 8000).includes(0);

// A file from the task, as text, with how it differs from this project's file.
async function showFile(call, { task, rel, dir }) {
  const got = await fetchFile(call, task, rel);
  if (got.error) return got;
  if (got.missing) return { text: `${rel} does not exist in the task's workspace (it was deleted there, or never existed).` };
  if (!isText(got.data)) return { text: `${rel}: binary, ${got.data.length} bytes.` };
  const theirs = got.data.toString('utf8');
  let local = null;
  const here = dir ? localFile(dir, rel) : null;
  if (here) {
    try {
      local = fs.readFileSync(here, 'utf8');
    } catch (err) {
      // No local copy to compare with: the workspace text is shown on its own.
      if (!err || !['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(err.code)) throw err;
    }
  }
  let out = `--- ${rel} in the task's workspace (${got.data.length} bytes) ---\n${theirs}`;
  if (local !== null && local !== theirs) {
    const hunks = diffText(local, theirs);
    out += `\n--- how it differs from ${rel} here ---\n` + hunks.map((h) => `@@ -${h.oldStart} +${h.newStart} @@\n${h.lines.join('\n')}`).join('\n');
  } else if (local !== null) {
    out += `\n--- the same as ${rel} here ---`;
  }
  return { text: out };
}

const UNDO_FILE_MAX = 2 * 1024 * 1024; // a file's earlier version kept for undo
const UNDO_TOTAL_MAX = 60 * 1024 * 1024;
const APPLIES_KEPT = 20;

// The real path of rel in this project, or null when it is excluded or (through a link) outside it.
function localFile(dir, rel) {
  const clean = sendproject.cleanRel(rel);
  if (!clean || sendproject.excluded(clean)) return null;
  const at = safepath.inside(dir, clean);
  return at.error || sendproject.excluded(at.rel) ? null : at.file;
}

// The file's bytes (null: not there; undefined: not a plain file, or a link). Read from the descriptor
// it was checked on, up to the size it had then: a link or a named pipe swapped in after the check
// is not followed or waited on.
function readOrNull(file) {
  let fd;
  try {
    const was = fs.lstatSync(file);
    if (!was.isFile()) return undefined;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.dev !== was.dev || st.ino !== was.ino) return undefined;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    if (err && err.code) return undefined;
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// What applying one change would do, from hashes only.
// -> 'write' | 'delete' | 'same' | { conflict } | { error }
function classify(dir, change, manifest) {
  const rel = sendproject.cleanRel(change.path);
  if (!rel || sendproject.excluded(rel)) return { error: 'not a file this can write' };
  if (change.status === 'link') return { error: 'a link there, not a file: links are never applied' };
  const here = localFile(dir, rel);
  if (!here) return { error: 'outside the project (through a link)' };
  const now = readOrNull(here);
  if (now === undefined) return { conflict: 'it is not a plain file here' };
  const nowHash = now === null ? null : sendproject.sha(now);
  const sent = Object.prototype.hasOwnProperty.call(manifest, rel) ? manifest[rel] : null;
  if (change.status === 'deleted') {
    if (nowHash === null) return 'same';
    return nowHash === sent ? 'delete' : { conflict: 'you changed it here since it was sent' };
  }
  if (nowHash !== null && change.hash && nowHash === change.hash) return 'same';
  if (nowHash !== sent) return { conflict: sent === null ? 'a file with that name was added here meanwhile' : nowHash === null ? 'you deleted it here since it was sent' : 'you changed it here since it was sent' };
  return 'write';
}

function appliesDir(stateDir) {
  return path.join(stateDir, 'applies');
}
// Removes the oldest applies first: keeps at most 20, and 60 MB of earlier versions.
function pruneApplies(stateDir) {
  const dir = appliesDir(stateDir);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{12}$/.test(n));
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  const all = names.map((n) => {
    const d = path.join(dir, n);
    let size = 0;
    for (const f of fs.readdirSync(d)) size += fs.statSync(path.join(d, f)).size;
    return { d, size, t: fs.statSync(d).mtimeMs };
  }).sort((a, b) => b.t - a.t);
  let total = 0;
  all.forEach((a, i) => {
    total += a.size;
    if (i >= APPLIES_KEPT || total > UNDO_TOTAL_MAX) fs.rmSync(a.d, { recursive: true, force: true });
  });
}

// Copies a sent-project task's changes into this project. files: only these paths (optional).
// dryRun: report only, from hashes. onApplied({ path, status, intent, before, after }) for each
// file written, so the panel shows it like any other edit. Earlier versions are kept for undoApply.
// -> { apply, applied, same, conflicts, failed } | { dryRun, wouldApply, ... } | { error }
async function applyTask(call, { task, stateDir, files, onApplied, dryRun = false }) {
  const record = readRecord(stateDir, task);
  if (!record) return { error: 'This computer did not send its project with that task (or the record is gone). For a task on the other computer\'s own project, use merge_computer_task.' };
  const list = await call('changes', { task });
  if (!list || list.error) return list || { error: 'no answer' };
  if (list.kind !== 'sent') return { error: 'That task works on the other computer\'s own project. Use merge_computer_task.' };
  // A file the task is still writing must not be copied here half written.
  if (list.busy) return { error: `The task is still working (${list.state || 'busy'}). Wait until check_computer_task says it is idle, then apply.` };
  const want = Array.isArray(files) && files.length ? new Set(files.map((f) => sendproject.cleanRel(f)).filter(Boolean)) : null;
  const out = { applied: [], same: [], conflicts: [], failed: [] };
  const plan = [];
  for (const change of list.files || []) {
    if (want && !want.has(change.path)) continue;
    const c = classify(record.dir, change, record.manifest);
    if (c === 'same') out.same.push(change.path);
    else if (c.conflict) out.conflicts.push({ path: change.path, why: c.conflict });
    else if (c.error) out.failed.push({ path: change.path, why: c.error });
    else plan.push({ change, action: c });
  }
  if (dryRun) {
    return { dryRun: true, project: record.dir, wouldApply: plan.map((p) => `${p.change.path} (${p.action === 'delete' ? 'deleted there' : p.change.status})`), same: out.same, conflicts: out.conflicts, failed: out.failed, truncated: list.truncated || undefined };
  }
  // The journal is written before the first write: what was there, and later what was written.
  const id = crypto.randomBytes(6).toString('hex');
  const jdir = path.join(appliesDir(stateDir), id);
  const journal = { task, computer: record.computer || null, dir: record.dir, at: Date.now(), files: [] };
  if (plan.length) fs.mkdirSync(jdir, { recursive: true, mode: 0o700 });
  const saveJournal = () => fs.writeFileSync(path.join(jdir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  for (const p of plan) {
    const rel = sendproject.cleanRel(p.change.path);
    const file = path.join(record.dir, rel);
    const prev = readOrNull(file);
    if (prev !== null && prev !== undefined && prev.length > UNDO_FILE_MAX && !(want && want.has(rel))) {
      out.failed.push({ path: p.change.path, why: `over ${UNDO_FILE_MAX / 1024 / 1024} MB here, so it can't be undone: list it in files to apply it anyway` });
      continue;
    }
    let data;
    if (p.action === 'write') {
      const got = await fetchFile(call, task, p.change.path);
      if (got.error) {
        out.failed.push({ path: p.change.path, why: got.error });
        continue;
      }
      if (got.missing) continue;
      data = got.data;
    }
    const entry = { path: rel, existed: prev !== null, kept: null, wrote: null, landed: false };
    if (prev && prev.length <= UNDO_FILE_MAX) {
      entry.kept = `${journal.files.length}.bin`;
      fs.writeFileSync(path.join(jdir, entry.kept), prev, { mode: 0o600 });
    }
    journal.files.push(entry);
    saveJournal();
    const r = sendproject.applyChange(record.dir, p.change, data, record.manifest);
    if (r.ok && !r.same) {
      entry.landed = true;
      entry.wrote = p.change.status === 'deleted' ? null : sendproject.sha(data);
      saveJournal();
    }
    if (r.ok) (r.same ? out.same : out.applied).push(p.change.path);
    else if (r.conflict) out.conflicts.push({ path: p.change.path, why: r.conflict });
    else out.failed.push({ path: p.change.path, why: r.error });
    if (r.ok && !r.same && onApplied) await onApplied({ path: p.change.path, status: p.change.status, intent: p.change.intent || null, before: r.before || null, after: p.change.status === 'deleted' ? null : data });
  }
  if (journal.files.some((f) => f.landed)) pruneApplies(stateDir);
  else if (plan.length) fs.rmSync(jdir, { recursive: true, force: true });
  return { project: record.dir, computer: record.computer || null, apply: journal.files.some((f) => f.landed) ? id : undefined, ...out, truncated: list.truncated || undefined };
}

// Reverses an apply, file by file, only where a file is still as the apply left it.
// onUndone({ path, before, after }): each file put back (Buffers or null).
// -> { undone, kept: [{ path, why }], left } | { error }; left: files of the apply not put back yet.
async function undoApply({ stateDir, apply, files, onUndone }) {
  if (!/^[0-9a-f]{12}$/.test(String(apply || ''))) return { error: 'Give the apply id (from apply_computer_task).' };
  const jdir = path.join(appliesDir(stateDir), apply);
  let journal;
  try {
    journal = JSON.parse(fs.readFileSync(path.join(jdir, 'journal.json'), 'utf8'));
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err instanceof SyntaxError)) return { error: 'That apply is no longer kept (only the last 20 are).' };
    throw err;
  }
  const want = Array.isArray(files) && files.length ? new Set(files.map((f) => sendproject.cleanRel(f)).filter(Boolean)) : null;
  const out = { undone: [], kept: [] };
  const named = (journal.files || []).filter((f) => f && (!want || want.has(f.path)));
  if (named.length && !named.some((f) => f.landed)) return { ...out, already: true, note: 'Already undone: none of these files is still as it left them.' };
  for (const f of journal.files || []) {
    if (!f || !f.landed || (want && !want.has(f.path))) continue;
    const file = localFile(journal.dir, f.path);
    if (!file) {
      out.kept.push({ path: f.path, why: 'it is outside the project now (through a link)' });
      continue;
    }
    const now = readOrNull(file);
    if (now === undefined) {
      out.kept.push({ path: f.path, why: 'it is not a plain file now' });
      continue;
    }
    const nowHash = now === null ? null : sendproject.sha(now);
    if (nowHash !== f.wrote) {
      out.kept.push({ path: f.path, why: 'changed since the apply' });
      continue;
    }
    let prev = null;
    if (f.existed) {
      if (!f.kept) {
        out.kept.push({ path: f.path, why: 'its earlier version was not kept' });
        continue;
      }
      prev = fs.readFileSync(path.join(jdir, f.kept));
    }
    try {
      if (prev === null) fs.unlinkSync(file);
      else {
        writeAtomic(file, prev, { mkdir: true });
      }
    } catch (err) {
      if (!err || !err.code) throw err;
      out.kept.push({ path: f.path, why: `${err.code}: in use or read-only here` });
      continue;
    }
    f.landed = false;
    out.undone.push(f.path);
    if (onUndone) await onUndone({ path: f.path, before: now, after: prev });
  }
  fs.writeFileSync(path.join(jdir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  out.left = (journal.files || []).filter((f) => f && f.landed).length;
  return out;
}

const COPY_TOTAL_MAX = 200 * 1024 * 1024; // one copy from a paired computer's project
const LIST_MAX = 5000; // files in one listing (server/tasks.js COPY_FILES_MAX)
const LIST_PAGES_MAX = 50; // pages of one listing (500 files each there)
const HASH_ASK_FILES = 500; // same as server/tasks.js LIST_PAGE and HASH_PAGE_MAX: one hash request
const HASH_ASK_BYTES = 64 * 1024 * 1024;
// The paired computer stopped answering (server/pair-remote.js task()): every later file would fail too.
const LINK_DOWN = /^Can't connect to |closed the connection/;

// A whole file from the paired computer's own project. -> { data } | { missing } | { error }
async function fetchProjectFile(call, rel, max = COPY_TOTAL_MAX) {
  return fetchPages((offset) => call('project-file', { path: rel, offset }), max);
}

// The other computer's hashes of these files ({ path, size }), requested in groups of at most
// HASH_ASK_FILES files and HASH_ASK_BYTES. -> Map path -> sha (a missing path: unknown).
async function remoteHashes(call, files) {
  const got = new Map();
  let group = [];
  let bytes = 0;
  const ask = async () => {
    if (!group.length) return;
    const res = await call('project-files', { path: '', hash: group });
    const shas = res && res.shas && typeof res.shas === 'object' ? res.shas : {};
    for (const p of group) if (typeof shas[p] === 'string' && /^[0-9a-f]{64}$/.test(shas[p])) got.set(p, shas[p]);
    group = [];
    bytes = 0;
  };
  for (const f of files) {
    const size = Number(f.size);
    if (!Number.isSafeInteger(size) || size < 0 || size > HASH_ASK_BYTES) continue;
    if (group.length >= HASH_ASK_FILES || bytes + size > HASH_ASK_BYTES) await ask();
    group.push(f.path);
    bytes += size;
  }
  await ask();
  return got;
}

// Copies a file or folder from the paired computer's project into this project as plain files (no Claude
// runs there). Matching files are skipped; a different file here is a conflict unless overwrite. Each copy
// gets an id like an apply, so undo_computer_task_apply can reverse it. totalMax: the most bytes it receives.
// -> { copy, from, to, copied, same, conflicts, failed, skipped } | { dryRun, ... } | { error }
async function copyFrom(call, { from, to, dir, stateDir, computer, overwrite = false, dryRun = false, onApplied, totalMax = COPY_TOTAL_MAX }) {
  // The whole project only when requested as ".": a missing path is a mistake, not "everything".
  if (typeof from !== 'string' || !from.trim()) return { error: 'Give "path": a file or folder in that computer\'s project, relative to it ("." for the whole project).' };
  const src = from.trim() === '.' ? '' : sendproject.cleanRel(from);
  if (src === null) return { error: 'Give the path in that computer\'s project, relative to it (no .. and no drive letters).' };
  const listed = [];
  let head = null;
  let offset = 0;
  for (let pages = 1; ; pages++) {
    // No hashes in the listing: they are requested below, only where they are needed.
    const page = await call('project-files', { path: src, offset, hash: false });
    if (!page || page.error) return { error: page && page.error ? page.error : 'no answer' };
    head = head || page;
    if (Array.isArray(page.files)) listed.push(...page.files);
    if (listed.length > LIST_MAX) return { error: `That computer listed over ${LIST_MAX} files: copy a smaller folder.` };
    if (page.next === null || page.next === undefined) break;
    // Each page must move forward, in at most LIST_PAGES_MAX pages.
    const next = Number(page.next);
    if (!Number.isSafeInteger(next) || next <= offset || pages >= LIST_PAGES_MAX) return { error: 'bad page' };
    offset = next;
  }
  const bytes = listed.reduce((n, f) => n + (Number.isSafeInteger(Number(f.size)) && Number(f.size) > 0 ? Number(f.size) : 0), 0);
  const tooBig = (n) => `That is ${Math.round(n / 1024 / 1024)} MB (${listed.length} files), over the ${totalMax / 1024 / 1024} MB a copy may receive. Copy a smaller folder.`;
  if (bytes > totalMax) return { error: tooBig(bytes) };
  // Where it is saved: "to" (a folder here, or the file's new path), else the same path as there.
  let dest = to === undefined || to === null || to === '' ? null : to === '.' ? '' : sendproject.cleanRel(to);
  if (dest === null && to !== undefined && to !== null && to !== '') return { error: 'Give "to" as a path in this project, relative to it.' };
  const target = (rel) => {
    if (dest === null) return rel;
    if (head.kind === 'file') return dest || path.posix.basename(rel);
    const inner = src ? rel.slice(src.length + 1) : rel;
    const base = src ? path.posix.basename(src) : '';
    return [dest, base, inner].filter(Boolean).join('/');
  };
  const out = { copied: [], same: [], conflicts: [], failed: [] };
  const rows = [];
  for (const f of listed) {
    const rel = sendproject.cleanRel(target(f.path));
    if (!rel || sendproject.excluded(rel)) {
      out.failed.push({ path: f.path, why: 'not a file this can write here' });
      continue;
    }
    // Through a folder link to outside the project, or to a key file: not read, not written.
    const here = localFile(dir, rel);
    if (!here) {
      out.failed.push({ path: f.path, why: 'not a file this can write here (outside the project through a link, or excluded)' });
      continue;
    }
    const now = readOrNull(here);
    if (now === undefined) {
      out.conflicts.push({ path: rel, why: 'it is not a plain file here' });
      continue;
    }
    rows.push({ f, rel, now });
  }
  // A file of another size is a different file: only same-size files need the other computer's
  // hash. An older version puts hashes in the listing and can't send them separately.
  const older = listed.some((f) => f.sha);
  const shas = older ? new Map() : await remoteHashes(call, rows.filter((r) => r.now !== null && r.now.length === Number(r.f.size)).map((r) => r.f));
  const plan = [];
  const manifest = Object.create(null);
  for (const { f, rel, now } of rows) {
    const nowHash = now === null ? null : sendproject.sha(now);
    const theirs = f.sha || shas.get(f.path) || null;
    if (nowHash !== null && theirs && nowHash === theirs) {
      out.same.push(rel);
      continue;
    }
    if (nowHash !== null && !overwrite) {
      out.conflicts.push({ path: rel, why: 'a different file is already here (pass overwrite: true to replace it; it can be undone)' });
      continue;
    }
    manifest[rel] = nowHash;
    plan.push({ from: f.path, rel, size: f.size });
  }
  const summary = { computer: computer || null, from: `${head.root}/${src || ''}`.replace(/\/$/, ''), to: path.join(dir, dest === null ? src : dest || ''),
    notCopied: 'node_modules, build output, .git, .env files, keys and links stay there', skipped: (head.skipped || []).length ? head.skipped : undefined, capped: head.capped };
  if (dryRun) return { dryRun: true, ...summary, wouldCopy: plan.map((p) => p.rel), bytes, same: out.same, conflicts: out.conflicts, failed: out.failed };
  const id = crypto.randomBytes(6).toString('hex');
  const jdir = path.join(appliesDir(stateDir), id);
  const journal = { task: null, copy: true, computer: computer || null, dir, at: Date.now(), files: [] };
  if (plan.length) fs.mkdirSync(jdir, { recursive: true, mode: 0o700 });
  const saveJournal = () => fs.writeFileSync(path.join(jdir, 'journal.json'), JSON.stringify(journal), { mode: 0o600 });
  let linkDown = null;
  let tooMuch = null;
  // The bytes received count, not the sizes listed: the other computer may send more (Sol M5).
  let received = 0;
  for (const p of plan) {
    const got = await fetchProjectFile(call, p.from, totalMax - received);
    if (got.error && LINK_DOWN.test(got.error)) {
      linkDown = got.error;
      break;
    }
    if (got.error && /^larger than/.test(got.error)) {
      tooMuch = `the files sent were larger than listed, over the ${totalMax / 1024 / 1024} MB a copy may receive. Copy a smaller folder.`;
      break;
    }
    if (got.data) received += got.data.length;
    if (got.error || got.missing) {
      out.failed.push({ path: p.rel, why: got.error || 'gone there meanwhile' });
      continue;
    }
    const here = localFile(dir, p.rel);
    if (!here) {
      out.failed.push({ path: p.rel, why: 'not a file this can write (outside the project through a link, or excluded)' });
      continue;
    }
    const prev = readOrNull(here);
    const entry = { path: p.rel, existed: Boolean(prev), kept: null, wrote: null, landed: false };
    if (prev && prev.length <= UNDO_FILE_MAX) {
      entry.kept = `${journal.files.length}.bin`;
      fs.writeFileSync(path.join(jdir, entry.kept), prev, { mode: 0o600 });
    } else if (prev) {
      out.failed.push({ path: p.rel, why: `over ${UNDO_FILE_MAX / 1024 / 1024} MB here, so it can't be undone: replace it yourself` });
      continue;
    }
    journal.files.push(entry);
    saveJournal();
    const r = sendproject.applyChange(dir, { path: p.rel, status: prev ? 'changed' : 'added' }, got.data, manifest);
    if (r.ok && !r.same) {
      entry.landed = true;
      entry.wrote = sendproject.sha(got.data);
      saveJournal();
      out.copied.push(p.rel);
      if (onApplied) await onApplied({ path: p.rel, status: prev ? 'changed' : 'added', intent: `Copied from ${computer || 'the paired computer'}`, before: r.before || null, after: got.data });
    } else if (r.ok) out.same.push(p.rel);
    else if (r.conflict) out.conflicts.push({ path: p.rel, why: r.conflict });
    else out.failed.push({ path: p.rel, why: r.error });
  }
  const landed = journal.files.some((f) => f.landed);
  if (landed) pruneApplies(stateDir);
  else if (plan.length) fs.rmSync(jdir, { recursive: true, force: true });
  if (linkDown) {
    return { error: `Copied ${out.copied.length} of ${plan.length} files, then the link stopped: ${linkDown} Run it again to finish: files already copied are skipped.`
      + (landed ? ` To undo what was copied, use undo_computer_task_apply with copy id ${id}.` : '') };
  }
  if (tooMuch) {
    return { error: `Copied ${out.copied.length} of ${plan.length} files, then stopped: ${tooMuch}`
      + (landed ? ` To undo what was copied, use undo_computer_task_apply with copy id ${id}.` : '') };
  }
  return { ...summary, copy: landed ? id : undefined, ...out };
}

// A file from the task, lines start..end (1-based, inclusive) only.
async function showLines(call, { task, rel, start, end }) {
  const got = await fetchFile(call, task, rel);
  if (got.error) return got;
  if (got.missing) return { text: `${rel} does not exist in the task's workspace.` };
  if (!isText(got.data)) return { text: `${rel}: binary, ${got.data.length} bytes.` };
  const lines = got.data.toString('utf8').split('\n');
  const a = Number.isSafeInteger(start) && start > 0 ? start : 1;
  if (a > lines.length) return { text: `${rel} has ${lines.length} line${lines.length === 1 ? '' : 's'}; line ${a} is past its end.` };
  const b = Number.isSafeInteger(end) && end >= a ? Math.min(end, lines.length) : lines.length;
  return { text: `--- ${rel} lines ${a}-${b} of ${lines.length} ---\n` + lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`).join('\n') };
}

module.exports = { compareProjects, sendAndStart, fetchFile, showFile, showLines, applyTask, undoApply, copyFrom, remoteKey, readRecord, isText };
