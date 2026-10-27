'use strict';
// Safety check: asks before a write that replaces most of a file or removes EditLens from the
// build config, whatever the permission mode. Used by the driver and the PreToolUse hook.
// Off via the Safety check setting or EDITLENS_GUARD=off.

const fs = require('fs');
const path = require('path');
const { spawnSync, execFile } = require('child_process');
const settings = require('./settings');
const { secretPath } = require('./sendproject');

const MAX_BYTES = 1024 * 1024;
const MIN_LINES = 12; // smaller files are rewritten freely
const KEEP_SHARE = 0.5; // a write that keeps less than half of the file's lines is a replacement
// Files that load EditLens into the app, and the words that show it is there.
const INTEGRATION_FILE = /^(vite\.config|next\.config|webpack\.config|nuxt\.config|astro\.config|svelte\.config)\.(m?[jt]s|cjs)$|^index\.html?$|^(server|app)\.(m?[jt]s|cjs)$/i;
const INTEGRATION_MARK = /editlens|edit-lens|live-edits|claude-live|claudeLive|127\.0\.0\.1:4317\/live\.js|localhost:4317\/live\.js/;

// The same reading of the Safety check setting as everywhere else (false, 0, off, no). setting: the
// value in effect when the caller has one (the server's, which may differ from the value in its
// environment at start); else this process's environment (a hook). EDITLENS_GUARD=off always counts.
function off(setting) {
  if (settings.check('safety_check', process.env.EDITLENS_GUARD) === false) return true;
  if (typeof setting === 'boolean') return setting;
  return settings.fromEnv().values.safety_check === false;
}

// Size of a regular file, or null when there is none to read.
function fileSize(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? st.size : null;
  } catch (err) {
    if (err && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENAMETOOLONG', 'ELOOP'].includes(err.code)) return null;
    throw err;
  }
}

function sizeText(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;
}

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    const text = fs.readFileSync(file, 'utf8');
    return text.includes('\u0000') ? null : text;
  } catch (err) {
    if (err && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EISDIR', 'ENAMETOOLONG', 'ELOOP'].includes(err.code)) return null;
    throw err;
  }
}

// The file's text after the tool call, or null when it can't be computed.
function afterText(tool, input, before) {
  const i = input || {};
  if (tool === 'Write') return typeof i.content === 'string' ? i.content : null;
  const apply = (text, e) => {
    if (text === null || !e || typeof e.old_string !== 'string' || typeof e.new_string !== 'string' || !e.old_string) return null;
    if (!text.includes(e.old_string)) return null;
    return e.replace_all ? text.split(e.old_string).join(e.new_string) : text.replace(e.old_string, () => e.new_string);
  };
  if (tool === 'Edit') return apply(before, i);
  if (tool === 'MultiEdit' && Array.isArray(i.edits)) return i.edits.reduce(apply, before);
  return null;
}

function lines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[{}()[\];,]+$/.test(l));
}

// Share of the old file's meaningful lines that are still there afterwards (0..1).
function keptShare(before, after) {
  const old = lines(before);
  if (!old.length) return 1;
  const left = new Map();
  for (const l of lines(after)) left.set(l, (left.get(l) || 0) + 1);
  let kept = 0;
  for (const l of old) {
    const c = left.get(l) || 0;
    if (c > 0) {
      kept++;
      left.set(l, c - 1);
    }
  }
  return kept / old.length;
}

// Each git call gets 1.2 s, so all three fit in the Bash hook's 5 s limit.
const GIT_MS = 1200;
const GIT_OPTS = { encoding: 'utf8', timeout: GIT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 };

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, ...GIT_OPTS });
  return r.error || r.status !== 0 ? null : r.stdout;
}

// The same without blocking (the live server runs it for page control).
function gitAsync(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, ...GIT_OPTS }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function wantsCommit(command) {
  return typeof command === 'string' && /\bgit\b[^|;&\n]*\bcommit\b/.test(command);
}

// The EditLens repository itself is not checked.
function isOwnRepo(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return Boolean(pkg && pkg.name === 'editlens');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR' || err instanceof SyntaxError)) return false;
    throw err;
  }
}

function addedMarks(diff, hits) {
  let file = null;
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('+++ ')) file = l.replace(/^\+\+\+ (b\/)?/, '');
    else if (l.startsWith('+') && INTEGRATION_MARK.test(l) && !/editlens:(start|end)/.test(l) && file && !hits.some((h) => h.file === file)) hits.push({ file, line: l.slice(1).trim().slice(0, 120) });
  }
  return hits;
}

function commitVerdict(hits) {
  if (!hits.length) return null;
  const files = hits.map((h) => h.file).join(', ');
  return { kind: 'commit', file: hits[0].file, reason: `This commit adds EditLens to ${files} (${hits[0].line}). That's for local development only. Deny to keep it out of the commit (run /editlens stop remove, or connect with /editlens, which needs no project changes); allow if you meant to commit it.` };
}

const DIFF = ['-U0', '--no-color', '--no-ext-diff'];

// A `git commit` whose changes add EditLens to the project (editlens() in vite.config, the script
// tag) asks first, because EditLens is for local development only. The unstaged diff (for
// commit -a) is read only when the staged one found nothing.
function commitCheck(command, cwd) {
  if (!wantsCommit(command)) return null;
  const dir = cwd || process.cwd();
  const top = git(['rev-parse', '--show-toplevel'], dir);
  if (!top || isOwnRepo(top.trim())) return null;
  const hits = addedMarks(git(['diff', '--cached', ...DIFF], dir), []);
  if (!hits.length && /\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(command)) addedMarks(git(['diff', ...DIFF], dir), hits);
  return commitVerdict(hits);
}

async function commitCheckAsync(command, cwd) {
  if (!wantsCommit(command)) return null;
  const dir = cwd || process.cwd();
  const top = await gitAsync(['rev-parse', '--show-toplevel'], dir);
  if (!top || isOwnRepo(top.trim())) return null;
  const hits = addedMarks(await gitAsync(['diff', '--cached', ...DIFF], dir), []);
  if (!hits.length && /\s(-[a-zA-Z]*a[a-zA-Z]*|--all)\b/.test(command)) addedMarks(await gitAsync(['diff', ...DIFF], dir), hits);
  return commitVerdict(hits);
}

// -> null, or { reason, kind: 'replace' | 'integration' | 'commit', file }
// opts.off: true or false, the Safety check setting in effect is off (page control passes it).
function check(tool, input, cwd, opts = {}) {
  if (off(opts.off)) return null;
  if (tool === 'Bash') return commitCheck(input && input.command, cwd);
  if (!['Write', 'Edit', 'MultiEdit'].includes(tool)) return null;
  const raw = input && input.file_path;
  if (typeof raw !== 'string' || !raw) return null;
  const file = path.resolve(cwd || process.cwd(), raw);
  // A key or credentials file (lib/sendproject.js secretPath, links followed) is never read: only
  // the size rule below applies to it.
  const before = secretPath(cwd || process.cwd(), file) ? null : readText(file);
  // Too big to compare by lines: a Write that leaves less than half its size is asked about by size.
  if (before === null && tool === 'Write' && typeof input.content === 'string') {
    const size = fileSize(file);
    const next = Buffer.byteLength(input.content, 'utf8');
    if (size !== null && size > MAX_BYTES && next < size * KEEP_SHARE) {
      const rel = cwd ? path.relative(cwd, file) || path.basename(file) : path.basename(file);
      return { kind: 'replace', file, reason: `This replaces ${rel} (${sizeText(size)}) with ${sizeText(next)}. Check that Claude read the file and isn't rewriting it from the start.` };
    }
  }
  if (before === null) return null; // a new file, or one we can't read
  const after = afterText(tool, input, before);
  if (after === null) return null;
  const name = path.basename(file);
  const rel = cwd ? path.relative(cwd, file) || name : name;
  if (INTEGRATION_FILE.test(name) && INTEGRATION_MARK.test(before) && !INTEGRATION_MARK.test(after)) {
    return { kind: 'integration', file, reason: `This change removes EditLens from ${rel}, so the page would stop showing Claude's edits. Allow it only if you meant to remove editlens.` };
  }
  const oldCount = lines(before).length;
  if (tool === 'Write' && oldCount >= MIN_LINES) {
    const share = keptShare(before, after);
    if (share < KEEP_SHARE) {
      const pct = Math.round((1 - share) * 100);
      return { kind: 'replace', file, reason: `This replaces most of ${rel}: ${pct}% of its ${oldCount} lines would be gone. Check that Claude read the file and isn't rewriting it from the start.` };
    }
  }
  return null;
}

// For the live server: git runs without blocking it.
async function checkAsync(tool, input, cwd, opts = {}) {
  if (off(opts.off)) return null;
  if (tool === 'Bash') return commitCheckAsync(input && input.command, cwd);
  return check(tool, input, cwd, opts);
}

module.exports = { check, checkAsync, commitCheck, commitCheckAsync, keptShare, afterText, INTEGRATION_MARK };
