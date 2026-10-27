'use strict';
// Resolves a file reference from Claude's reply (a markdown link, an inline-code path, a
// file:line) to a file the panel may show in the code view.
// Safety: pages on localhost can request these, so only files inside Claude Code session folders
// are served, never hidden files or folders (.env, .git, .ssh), key or secret files, binaries,
// or files over 512 KB.

const fs = require('fs');
const path = require('path');
const { stripBom } = require('./textcut');
const { tooBroad } = require('./paths');

const MAX_BYTES = 512 * 1024;
const MAX_WALK = 6000;
const MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__', 'venv']);
const SECRET_RE = /(^|[-_.])(secret|secrets|credential|credentials|password|passwd)([-_.]|$)|^id_(rsa|dsa|ecdsa|ed25519)|^_netrc$|\.(pem|key|p12|pfx|keystore|jks|crt|cer|gpg|tfvars|token)$/i;
// Words that name a key when the file is a data file (token.txt, apikey.json, auth.json,
// serviceAccount.json, private). Code files with these names (auth.ts, token.js) are not keys.
const KEY_WORD_RE = /(^|[-_.])(tokens?|api[-_]?keys?|private|auth|access[-_]?tokens?)([-_.]|$)|service[-_]?accounts?/i;
const DATA_EXT_RE = /^(json|txt|ya?ml|toml|ini|conf|cfg|properties|xml|plist)$/i;

// A data file named for a key (lib/sendproject.js keeps these on the computer too).
function keyDataName(name) {
  const s = String(name || '');
  const dot = s.lastIndexOf('.');
  const ext = dot > 0 ? s.slice(dot + 1) : '';
  return (!ext || DATA_EXT_RE.test(ext)) && KEY_WORD_RE.test(s);
}

// Whether a file name (no folders) looks like a key or secrets file.
function secretName(name) {
  return SECRET_RE.test(String(name || '')) || keyDataName(name);
}

// C:\a\b and C:/a/b are the same; drive letters compare case-insensitively.
function norm(p) {
  const x = path.resolve(String(p).replace(/\\/g, '/'));
  return /^[a-z]:/i.test(x) ? x[0].toLowerCase() + x.slice(1) : x;
}

function inside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Why a path inside a root may not be served, or null.
function blocked(file, root) {
  const rel = path.relative(norm(root), norm(file));
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some((p) => p.startsWith('.'))) return 'hidden files and folders are not shown';
  if (secretName(parts[parts.length - 1] || '')) return 'this looks like a key or secrets file, so it is not shown';
  return null;
}

function stat(p) {
  try {
    return fs.statSync(p);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EINVAL', 'ENAMETOOLONG'].includes(err.code)) return null;
    throw err;
  }
}

function realPath(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'EINVAL', 'ENAMETOOLONG'].includes(err.code)) return null;
    throw err;
  }
}

// "file:///C:/x", "./src\\a.js", "%20" escapes from markdown links.
function cleanRef(ref) {
  let r = String(ref || '').trim().replace(/^<|>$/g, '');
  if (/^file:\/\//i.test(r)) r = r.slice(7).replace(/^\/([a-z]:)/i, '$1');
  try {
    if (/%[0-9a-f]{2}/i.test(r)) r = decodeURIComponent(r);
  } catch (err) {
    if (!(err instanceof URIError)) throw err;
  }
  return r.replace(/^\.[\\/]/, '');
}

function rootOf(file, roots) {
  return roots.find((r) => inside(file, r)) || null;
}

function relTo(file, roots) {
  const root = rootOf(file, roots);
  return root ? path.relative(root, file).replace(/\\/g, '/') || '.' : file;
}

// Files under the roots whose path ends with `tail` (for "components.jsx" or "src/App.jsx"
// written relative to some other folder).
function findBySuffix(tail, roots) {
  const want = tail.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!want) return [];
  const hits = [];
  let seen = 0;
  const walk = (dir, depth, root) => {
    if (depth > MAX_DEPTH || seen > MAX_WALK || hits.length >= 20) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(err.code)) return;
      throw err;
    }
    for (const d of entries) {
      if (++seen > MAX_WALK) return;
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue;
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).replace(/\\/g, '/').toLowerCase();
      if (rel === want || rel.endsWith('/' + want)) hits.push(full);
      if (d.isDirectory()) walk(full, depth + 1, root);
    }
  };
  for (const r of roots) walk(r, 0, r);
  return [...new Set(hits)];
}

function listFolder(dir, roots) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(err.code)) return { error: 'This folder could not be read.' };
    throw err;
  }
  const items = entries
    .filter((d) => !d.name.startsWith('.') && !(d.isDirectory() && SKIP_DIRS.has(d.name)))
    .map((d) => ({ name: d.name, rel: relTo(path.join(dir, d.name), roots), dir: d.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
    .slice(0, 300);
  return { kind: 'dir', rel: relTo(dir, roots), entries: items };
}

// -> { kind: 'file', file, rel, text } | { kind: 'dir', rel, entries } | { kind: 'choices', matches }
//    | { error }
function resolveRef(ref, roots) {
  const clean = cleanRef(ref);
  // A drive or filesystem root (or the home folder) is never a project: it would expose every file.
  const usable = [...new Set(roots.filter((r) => r && !tooBroad(r)).map((r) => path.resolve(r)))];
  if (!clean) return { error: 'Empty file reference.' };
  if (!usable.length) return { error: 'No Claude Code session has reported its project folder yet.' };
  const abs = /^([a-z]:[\\/]|[\\/])/i.test(clean);
  // Relative to a session folder, or to its parent (a path that starts with the folder's own name).
  const bases = abs ? [''] : usable.flatMap((r) => [r, path.dirname(r)]);
  let found = null;
  let outside = false;
  for (const b of bases) {
    const p = path.resolve(b, clean);
    const st = stat(p);
    if (!st) continue;
    if (!rootOf(p, usable)) {
      outside = true;
      continue;
    }
    found = { p, st };
    break;
  }
  if (!found) {
    const matches = abs ? [] : findBySuffix(clean, usable);
    if (matches.length === 1) {
      const st = stat(matches[0]);
      if (st) found = { p: matches[0], st };
    } else if (matches.length > 1) {
      return { kind: 'choices', matches: matches.map((m) => relTo(m, usable)).sort() };
    }
  }
  if (!found) return { error: outside ? `${clean} is outside this project, so it is not shown.` : `Couldn't find ${clean} in this project.` };
  const root = rootOf(found.p, usable);
  const why = blocked(found.p, root);
  if (why) return { error: `${relTo(found.p, usable)}: ${why}.` };
  // A symlink inside the project may point outside it: check its real target too.
  const real = realPath(found.p);
  const realRoot = real && rootOf(real, usable.map((r) => realPath(r) || r));
  if (!real || !realRoot) return { error: `${relTo(found.p, usable)} links outside this project, so it is not shown.` };
  const realWhy = blocked(real, realRoot);
  if (realWhy) return { error: `${relTo(found.p, usable)}: ${realWhy}.` };
  if (found.st.isDirectory()) return listFolder(found.p, usable);
  if (!found.st.isFile()) return { error: `${clean} is not a regular file.` };
  if (found.st.size > MAX_BYTES) return { error: `${relTo(found.p, usable)} is larger than 512 KB, too big for the code view.` };
  const raw = fs.readFileSync(found.p, 'utf8');
  if (raw.includes('\u0000')) return { error: `${relTo(found.p, usable)} is a binary file.` };
  // A byte order mark would show as an invisible first character.
  const text = stripBom(raw);
  return { kind: 'file', file: found.p, rel: relTo(found.p, usable), text, bom: text !== raw || undefined };
}

module.exports = { resolveRef, cleanRef, inside, norm, secretName, keyDataName };
