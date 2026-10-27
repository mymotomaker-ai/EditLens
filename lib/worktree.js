'use strict';
// Subagents in their own copy of the project: Claude Code's `isolation: "worktree"` puts each in a
// git worktree at <project>/.claude/worktrees/<name> (branch worktree-<name>), so agents working
// at the same time can't overwrite each other. This module finds the copies, lists their changes,
// and merges them into the project file by file (three-way). Same-line changes on both sides are
// never merged silently.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const { tooBroad } = require('./paths');
const { writeAtomic } = require('./atomic');
const { inside } = require('./safepath');

const MAX_FILES = 500;
const MAX_BYTES = 8 * 1024 * 1024;
// Subagent types that only read: they get no copy.
const READ_ONLY_AGENTS = new Set(['Explore', 'Plan', 'claude-code-guide', 'statusline-setup', 'output-style-setup']);
const NAME_RE = /^[A-Za-z0-9._+-]{1,128}$/;
// A project file another program has open (Windows) or that can't be written: a merge leaves it.
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ETXTBSY']);
const COPY_RE = /^(.*?)[\\/]\.claude[\\/]worktrees[\\/]([A-Za-z0-9._+-]{1,128})(?:[\\/](.*))?$/;

function git(cwd, args, { buffer = false, input, timeoutMs = 20000 } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: timeoutMs, input });
  const timedOut = Boolean(r.error && r.error.code === 'ETIMEDOUT');
  return { ok: !r.error && r.status === 0, status: r.error ? -1 : r.status, out: r.stdout, err: String(r.stderr || (r.error && r.error.message) || ''), timedOut };
}

// The same without blocking: status and merge run many git commands, and the live server must
// keep responding. At most GIT_AT_ONCE run at a time.
const GIT_AT_ONCE = 4;
let gitRunning = 0;
const gitQueue = [];
// as: { name, home } runs git as that account (a task workspace it owns: git refuses another
// owner's repository, and files git writes must stay the account's).
function gitAsync(cwd, args, { buffer = false, env = null, as = null } = {}) {
  // as.gone: the account was removed; git does not run as anyone else in its place.
  if (as && as.gone) return Promise.resolve({ ok: false, status: -1, out: buffer ? Buffer.alloc(0) : '', err: `the account ${as.name} is gone` });
  const cmd = as ? 'runuser' : 'git';
  const argv = as ? ['-u', as.name, '--', 'git', '-C', cwd, ...args] : ['-C', cwd, ...args];
  // As the account: none of root's keys or tokens (lib/taskuser.js keeps only what git needs).
  const fullEnv = as ? require('./taskuser').baseEnv(as, process.env, env) : env ? { ...process.env, ...env } : null;
  return new Promise((resolve) => {
    const run = () => {
      gitRunning++;
      execFile(cmd, argv, { encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000, ...(fullEnv ? { env: fullEnv } : {}) }, (err, stdout, stderr) => {
        gitRunning--;
        if (gitQueue.length) gitQueue.shift()();
        resolve({ ok: !err, status: err ? (Number.isInteger(err.code) ? err.code : -1) : 0, out: stdout, err: String(stderr || (err && err.message) || '') });
      });
    };
    if (gitRunning < GIT_AT_ONCE) run();
    else gitQueue.push(run);
  });
}

// git cat-file with names on stdin. -> stdout Buffer | null (git failed or stopped reading).
function catFile(dir, mode, names, maxBuffer) {
  return new Promise((resolve) => {
    let writeFailed = false;
    const child = execFile('git', ['-C', dir, 'cat-file', mode], { encoding: 'buffer', maxBuffer, windowsHide: true, timeout: 20000 }, (err, stdout) => resolve(err || writeFailed ? null : stdout));
    // git exited before reading all the names (EPIPE): this batch counts as unread.
    child.stdin.on('error', (err) => {
      writeFailed = true;
      if (err.code !== 'EPIPE') child.kill();
    });
    child.stdin.end(names.join(''));
  });
}

// The base version of many files, one git process per 100 files: sizes first (--batch-check), then
// only the contents of files small enough to merge (--batch), so a big file is never read into
// memory. -> Map rel -> Buffer, or undefined when larger than MAX_BYTES (missing files are left out).
async function baseFiles(dir, rev, rels) {
  const out = new Map();
  // A name with a line break can't go in the batch: one git show each (rare).
  for (const rel of rels.filter((r) => /[\r\n]/.test(r))) {
    const sized = await gitAsync(dir, ['cat-file', '-s', `${rev}:${rel}`]);
    if (!sized.ok) continue;
    const n = Number.parseInt(String(sized.out).trim(), 10);
    if (!Number.isInteger(n) || n > MAX_BYTES) {
      out.set(rel, undefined);
      continue;
    }
    const shown = await gitAsync(dir, ['show', `${rev}:${rel}`], { buffer: true });
    if (shown.ok) out.set(rel, shown.out);
  }
  const plain = rels.filter((r) => !/[\r\n]/.test(r));
  for (let i = 0; i < plain.length; i += 100) {
    const part = plain.slice(i, i + 100);
    const sizes = await catFile(dir, '--batch-check', part.map((rel) => `${rev}:${rel}\n`), 1024 * 1024);
    if (!sizes) continue; // these files then count as missing from the base, so never "same"
    const lines = sizes.toString('utf8').split('\n');
    const small = [];
    let total = 0;
    part.forEach((rel, k) => {
      const head = String(lines[k] || '').split(' ');
      if (head[1] !== 'blob' || head.length < 3) return; // missing, or not a file
      const size = Number.parseInt(head[2], 10);
      if (!Number.isInteger(size) || size < 0 || size > MAX_BYTES) out.set(rel, undefined);
      else {
        small.push(rel);
        total += size;
      }
    });
    if (!small.length) continue;
    const r = await catFile(dir, '--batch', small.map((rel) => `${rev}:${rel}\n`), total + small.length * 128 + 1024);
    if (!r) {
      for (const rel of small) out.delete(rel);
      continue;
    }
    let at = 0;
    for (const rel of small) {
      const nl = r.indexOf(10, at);
      if (nl < 0) break;
      const head = r.subarray(at, nl).toString('utf8').split(' ');
      at = nl + 1;
      if (head[1] === 'missing' || head.length < 3) continue;
      const size = Number.parseInt(head[2], 10);
      if (!Number.isInteger(size) || size < 0 || at + size > r.length) break;
      if (head[1] === 'blob') out.set(rel, r.subarray(at, at + size));
      at += size + 1; // the content, then a newline
    }
  }
  return out;
}

// "<project>/.claude/worktrees/<name>/src/App.jsx" -> { root, name, dir, rel } or null.
function copyOf(p) {
  const m = COPY_RE.exec(String(p || ''));
  if (!m || !m[1]) return null;
  const root = m[1];
  return { root, name: m[2], dir: path.join(root, '.claude', 'worktrees', m[2]), rel: m[3] || '' };
}

// A path shown to people: ".claude/worktrees/<name>/src/a.js" (at the start or after a folder)
// becomes "src/a.js", because the copy's folder is internal. Slashes are kept as they are.
const COPY_PART_RE = /(^|[\\/])\.claude[\\/]worktrees[\\/][A-Za-z0-9._+-]{1,128}(?:[\\/]|$)/;
function withoutCopy(rel) {
  const s = String(rel || '');
  const m = COPY_PART_RE.exec(s);
  return m ? s.slice(m.index + m[0].length) : s;
}

// file relative to dir, as the project names it: a file in a subagent's copy inside dir counts as
// the same file in dir. -> "src/a.js" (forward slashes), or null when file is not inside dir.
function projectRel(dir, file) {
  const rel = path.relative(String(dir || ''), String(file || ''));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const out = withoutCopy(rel.split(path.sep).join('/'));
  return out || null;
}

// The project is a git repository with at least one commit (a worktree needs a commit to start from).
// timeoutMs: how long git may take (a hook has a few seconds). -> true/false
function canCopy(cwd, { timeoutMs } = {}) {
  return copyCheck(cwd, { timeoutMs }).ok;
}
// The same, saying why not: { ok, why } (why: 'not git', 'inside a copy' or 'git was too slow').
function copyCheck(cwd, { timeoutMs = 20000 } = {}) {
  if (!cwd) return { ok: false, why: 'no folder' };
  if (copyOf(cwd)) return { ok: false, why: 'inside a copy' };
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { timeoutMs });
  if (r.timedOut) return { ok: false, why: `git was too slow (over ${timeoutMs} ms)` };
  return r.ok ? { ok: true, why: null } : { ok: false, why: 'not git' };
}

// Should this Agent call get its own copy? -> true/false.
function wantsCopy(toolInput) {
  const ti = toolInput || {};
  if (ti.isolation || ti.cwd) return false; // the caller chose already
  return !READ_ONLY_AGENTS.has(String(ti.subagent_type || ''));
}

function readOrNull(file) {
  try {
    const st = fs.statSync(file);
    // undefined: too big to merge.
    if (!st.isFile() || st.size > MAX_BYTES) return st.isFile() ? undefined : null;
    return fs.readFileSync(file);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

function same(a, b) {
  if (a === null || b === null) return a === b;
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
}

const isText = (b) => b === null || (Buffer.isBuffer(b) && !b.subarray(0, 8000).includes(0));

// A three-way merge of one file's text. -> merged Buffer, or null when the same lines changed on both sides.
async function mergeText(ours, base, theirs) {
  const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'editlens-merge-'));
  try {
    const names = ['project', 'base', 'copy'].map((n) => path.join(tmp, n));
    await Promise.all(names.map((f, i) => fs.promises.writeFile(f, [ours, base, theirs][i] || Buffer.alloc(0))));
    const r = await gitAsync(tmp, ['merge-file', '-p', ...names], { buffer: true });
    return r.status === 0 ? r.out : null;
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

function listCopies(root) {
  const dir = path.join(root, '.claude', 'worktrees');
  let names;
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && NAME_RE.test(d.name)).map((d) => d.name);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
  return names.filter((n) => fs.existsSync(path.join(dir, n, '.git')));
}

// What one copy changed: { name, dir, branch, files: [{ relFile, state, deleted, added }] } or
// { error }. state: same (already in the project), clean (only the copy changed it), merged (both,
// in different places), conflict (same lines, or binary or very large: left for the user).
// States are cached by base, size and times; a merge always checks the state again.
const stateCache = new Map(); // "<copy dir>\0<rel>" -> { stamp, state }
const STATE_CACHE_MAX = 5000;
function stamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return '-';
    throw err;
  }
}

// .claude/** (except the copies, already skipped), .mcp.json, .env files and keys: the same list
// that keeps them out of sent projects (lib/sendproject.js).
function heldBack(rel) {
  return require('./sendproject').excluded(rel);
}

// Both sides resolved with lib/safepath.js: a link in the project or in the copy may not lead
// outside either one, nor to a file the merge keeps back. -> { src, dst } real paths, or { why }
function sides(root, dir, rel) {
  const src = inside(dir, rel);
  const dst = inside(root, rel);
  if (src.error || dst.error) return { why: 'a link leads outside the project: not merged' };
  if (heldBack(src.rel) || heldBack(dst.rel)) return { why: 'configuration or key file: not merged' };
  return { src: src.file, dst: dst.file, dstRel: dst.rel };
}
// rel is the folder sub or a file in it ('' : the whole repository).
const under = (rel, sub) => !sub || rel === sub || rel.startsWith(`${sub}/`);

async function status(root, name, { fresh = false } = {}) {
  if (!NAME_RE.test(String(name || ''))) return { error: 'unknown copy' };
  const dir = path.join(root, '.claude', 'worktrees', name);
  if (!fs.existsSync(path.join(dir, '.git'))) return { error: 'That copy is gone.' };
  const [head, mainHead] = await Promise.all([gitAsync(dir, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']), gitAsync(root, ['rev-parse', 'HEAD'])]);
  if (!head.ok || !mainHead.ok) return { error: 'git could not read the copy.' };
  const [headRev, branchName] = head.out.trim().split('\n');
  const base = await gitAsync(dir, ['merge-base', headRev, mainHead.out.trim()]);
  const baseRev = base.ok ? base.out.trim() : headRev;
  const [changed, added] = await Promise.all([
    gitAsync(dir, ['diff', '--name-only', '-z', '--no-renames', baseRev, '--']),
    gitAsync(dir, ['ls-files', '-z', '--others', '--exclude-standard']),
  ]);
  const rels = [...new Set([changed, added].flatMap((r) => (r.ok ? r.out.split('\0') : [])).filter(Boolean))]
    .filter((rel) => !/^\.claude\/worktrees\//.test(rel))
    .slice(0, MAX_FILES);
  const stamps = new Map(rels.map((rel) => [rel, `${baseRev}|${stamp(path.join(dir, rel))}|${stamp(path.join(root, rel))}`]));
  // Read the cached states now: adding new ones below may remove old ones from the cache.
  const kept = new Map();
  if (!fresh) for (const rel of rels) {
    const c = stateCache.get(`${dir}\0${rel}`);
    if (c && c.stamp === stamps.get(rel)) kept.set(rel, c.state);
  }
  // Claude Code configuration (hooks, MCP servers, "always allow" rules) and key files an agent
  // wrote in its copy are never merged into the project: the user copies them manually.
  const where = new Map(rels.map((rel) => [rel, heldBack(rel) ? { why: 'configuration or key file: not merged' } : sides(root, dir, rel)]));
  const todo = rels.filter((rel) => !kept.has(rel) && !where.get(rel).why);
  const bases = await baseFiles(dir, baseRev, todo);
  const found = new Map(await Promise.all(todo.map(async (rel) => [rel, await fileState(where.get(rel), rel, bases.has(rel) ? bases.get(rel) : null)])));
  const files = rels.map((rel) => {
    const why = where.get(rel).why;
    if (why) return { relFile: rel, added: false, deleted: false, state: 'held', why };
    const key = `${dir}\0${rel}`;
    if (!found.has(rel)) return kept.get(rel);
    stateCache.delete(key);
    stateCache.set(key, { stamp: stamps.get(rel), state: found.get(rel) });
    if (stateCache.size > STATE_CACHE_MAX) stateCache.delete(stateCache.keys().next().value);
    return found.get(rel);
  });
  return { name, dir, branch: branchName || null, base: baseRev, files, truncated: rels.length >= MAX_FILES };
}

// at: { src, dst } from sides()
async function fileState(at, rel, base) {
  const theirs = readOrNull(at.src);
  const ours = readOrNull(at.dst);
  const out = { relFile: rel, added: base === null && theirs !== null, deleted: theirs === null };
  if (theirs === undefined || ours === undefined || base === undefined) return { ...out, state: 'conflict', why: 'too large to merge' };
  if (same(theirs, ours) || same(theirs, base)) return { ...out, state: 'same' };
  if (same(ours, base)) return { ...out, state: 'clean' };
  if (ours === null || theirs === null || !isText(ours) || !isText(base) || !isText(theirs)) return { ...out, state: 'conflict' };
  const merged = await mergeText(ours, base, theirs);
  // Already merged once: the project has everything the copy changed.
  return { ...out, state: !merged ? 'conflict' : same(merged, ours) ? 'same' : 'merged' };
}

// Merges the copy's changes into the project, one merge per copy at a time. `take`: conflicting
// files to copy as they are from the copy (the panel keeps the old version for Restore). cleanOnly:
// only clean files (a merge requested by another computer's Claude); the rest wait for the user.
// -> { applied: [{ relFile, file, before, after, binary }], conflicts: [relFile], same: n } | { error }

// only: a folder of the repository (a paired subfolder). Files elsewhere, also through a link, stay
// in the copy and are listed in the result's outside: [relFile].
const merging = new Map(); // copy dir -> promise
function merge(root, name, opts) {
  const key = path.join(String(root), '.claude', 'worktrees', String(name));
  const prev = merging.get(key) || Promise.resolve();
  const next = prev.then(() => mergeNow(root, name, opts));
  const tail = next.then(() => undefined, () => undefined);
  merging.set(key, tail);
  tail.then(() => {
    if (merging.get(key) === tail) merging.delete(key);
  });
  return next;
}

async function mergeNow(root, name, { take = [], cleanOnly = false, only = '' } = {}) {
  const st = await status(root, name, { fresh: true });
  if (st.error) return st;
  const applied = [];
  const conflicts = [];
  const outside = [];
  let sameCount = 0;
  const bases = await baseFiles(st.dir, st.base, st.files.filter((f) => f.state === 'merged' || f.state === 'clean').map((f) => f.relFile));
  for (const f of st.files) {
    if (f.state === 'same' || f.state === 'held') {
      if (f.state === 'same') sameCount++;
      continue;
    }
    if (!under(f.relFile, only)) {
      outside.push(f.relFile);
      continue;
    }
    if ((f.state === 'conflict' && !take.includes(f.relFile)) || (cleanOnly && f.state !== 'clean')) {
      conflicts.push(f.relFile);
      continue;
    }
    // Checked again just before reading and writing: a link may have appeared since.
    const at = sides(root, st.dir, f.relFile);
    if (!at.why && !under(at.dstRel, only)) {
      outside.push(f.relFile);
      continue;
    }
    if (at.why) {
      conflicts.push(f.relFile);
      continue;
    }
    const target = at.dst;
    const ours = readOrNull(target);
    const theirs = readOrNull(at.src);
    if (ours === undefined || theirs === undefined) {
      conflicts.push(f.relFile);
      continue;
    }
    let next = theirs;
    let state = f.state;
    // Checked again: the project file may have changed since the status above (a clean file is
    // then merged like any other, or left for the user).
    if (state === 'clean') {
      const base = bases.has(f.relFile) ? bases.get(f.relFile) : null;
      if (!same(ours, base)) {
        if (same(ours, theirs)) {
          sameCount++;
          continue;
        }
        if (ours === null || theirs === null || !isText(ours) || !isText(base) || !isText(theirs)) {
          conflicts.push(f.relFile);
          continue;
        }
        state = 'merged';
      }
    }
    if (state === 'merged') {
      next = await mergeText(ours, bases.get(f.relFile) || Buffer.alloc(0), theirs);
      // A folder on either path may have become a link during the merge (Sol H3), or the project
      // file changed: left for the user rather than written.
      const again = sides(root, st.dir, f.relFile);
      if (again.why || again.dst !== target || again.src !== at.src) next = null;
      if (next && !same(readOrNull(target), ours)) next = null;
      if (!next) {
        conflicts.push(f.relFile); // the project changed again since the check
        continue;
      }
    }
    try {
      if (next === null) {
        if (ours !== null) fs.rmSync(target, { force: true });
      } else {
        writeAtomic(target, next, { mkdir: true });
      }
    } catch (err) {
      // A file locked (Windows) or read-only: left for the user; the other files continue. Any
      // other error (a full disk) leaves the file too, and is written to the log with its code.
      if (!err || !err.code) throw err;
      if (!LOCKED.has(err.code)) console.error(`[editlens] merging ${f.relFile} failed (${err.code}); it is left in the copy`);
      conflicts.push(f.relFile);
      continue;
    }
    const binary = !isText(ours) || !isText(next);
    applied.push({ relFile: f.relFile, file: target, binary, before: binary || ours === null ? null : ours.toString('utf8'), after: binary || next === null ? null : next.toString('utf8') });
  }
  return { name, applied, conflicts, same: sameCount, ...(only ? { outside } : {}) };
}

// Removes the copy and its branch. Only for a copy under the project's .claude/worktrees.
function remove(root, name) {
  if (!NAME_RE.test(String(name || ''))) return { error: 'unknown copy' };
  const dir = path.join(root, '.claude', 'worktrees', name);
  if (!fs.existsSync(path.join(dir, '.git'))) return { ok: true, gone: true };
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const r = git(root, ['worktree', 'remove', '--force', dir]);
  if (!r.ok) return { error: `git could not remove the copy: ${r.err.trim().split('\n').pop()}` };
  const b = branch.ok ? branch.out.trim() : '';
  if (b === `worktree-${name}`) git(root, ['branch', '-D', b]);
  return { ok: true };
}

// A new copy of the project for one task, made as Claude Code makes them (from the last commit,
// branch worktree-<name>). cwd may be a folder inside the repository: the task then works in the
// same folder of the copy. -> { root, name, dir, cwd } or { error }.
function create(cwd, name) {
  if (!NAME_RE.test(String(name || ''))) return { error: 'bad name' };
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok || !git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) return { error: 'not a git project with a commit' };
  const root = path.resolve(top.out.trim());
  // The home folder (or a drive) as a git repository: a copy of all of it is never made.
  if (tooBroad(root)) return { error: `the git repository here is ${root}, too big to copy` };
  const dir = path.join(root, '.claude', 'worktrees', name);
  const r = git(root, ['worktree', 'add', '-q', '-b', `worktree-${name}`, dir, 'HEAD']);
  if (!r.ok) return { error: `git could not make the copy: ${r.err.trim().split('\n').pop()}` };
  const rel = path.relative(fs.realpathSync(root), fs.realpathSync(cwd));
  return { root, name, dir, cwd: rel && !rel.startsWith('..') ? path.join(dir, rel) : dir };
}

module.exports = { copyOf, withoutCopy, projectRel, canCopy, copyCheck, wantsCopy, listCopies, status, merge, remove, create, git, gitAsync, READ_ONLY_AGENTS };
