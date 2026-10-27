'use strict';
// Sending a project to a paired computer for a task, and copying the task's changes back.
// pack: the project's files (git's view, or a folder walk) as one gzipped bundle with hashes.
// unpack (on the paired computer): writes it to a new workspace. applyChange: writes one file back
// only if the project's file is unchanged since it was sent. Never sent: .git, node_modules, .env
// files, .claude and .mcp.json (their hooks and MCP servers would run on the other computer).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { writeAtomic } = require('./atomic');
const { keyDataName } = require('./fileref');
const safepath = require('./safepath');

const FILE_MAX = 5 * 1024 * 1024; // larger files are left out (and listed)
const TOTAL_MAX = 100 * 1024 * 1024; // raw bytes in one bundle
const FILES_MAX = 20000;
const WALK_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', 'coverage', '.venv', 'venv', '__pycache__']);

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Relative, forward slashes, no '..', no absolute or drive paths, no NUL. -> the clean path or null.
function cleanRel(p) {
  const s = String(p || '');
  if (!s || s.length > 1000 || s.includes('\0') || /^[a-z]:/i.test(s) || s.startsWith('/') || s.startsWith('\\')) return null;
  const parts = s.replace(/\\/g, '/').split('/').filter((x) => x && x !== '.');
  if (!parts.length || parts.some((x) => x === '..')) return null;
  return parts.join('/');
}

// Files that never leave this computer, and that a task's changes may never write.
function excluded(rel) {
  const parts = rel.split('/');
  if (parts.some((x) => x === '.git' || x === 'node_modules')) return true;
  if (parts[0] === '.claude' || rel === '.mcp.json') return true;
  return secretFile(rel);
}

// A key or credentials file: .env files, key names, and files in key folders (.ssh, .aws ...).
// rel: relative to the project, or an absolute path (each of its folders is checked).
function secretFile(rel) {
  const parts = String(rel || '').replace(/\\/g, '/').split('/');
  const name = parts[parts.length - 1];
  if (parts.slice(0, -1).some((x) => SECRET_DIR.has(x.toLowerCase()))) return true;
  if (/^\.env(\..*)?$/.test(name) && name !== '.env.example' && name !== '.env.sample') return true;
  return SECRET_NAME.test(name) || keyDataName(name);
}
// A key or credentials file by its name or by where it really leads: a plain name can be a link to
// one, or be in a linked folder of keys (Sol H9). The full path counts too: the working folder can
// itself be in a key folder (Sol H8). file: absolute, or relative to cwd. -> boolean
function secretPath(cwd, file) {
  if (typeof file !== 'string' || !file) return false;
  const abs = path.resolve(cwd || '.', file);
  if (secretFile(abs) || (cwd && secretFile(path.relative(cwd, abs)))) return true;
  const real = realOf(abs);
  return Boolean(real) && real !== abs && secretFile(real);
}

// The real path of p, or of its folder when p doesn't exist yet. -> string | null
function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') {
      if (['EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'].includes(err.code)) return null;
      throw err;
    }
  }
  try {
    return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ELOOP', 'ENAMETOOLONG'].includes(err.code)) return null;
    throw err;
  }
}

// Keys and credentials never leave this computer, and are never read or written for a task.
const SECRET_NAME = /^(id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|.*\.(pem|key|p12|pfx|keystore|jks|gpg|asc|tfvars|token)|\.npmrc|\.pypirc|\.netrc|_netrc|\.htpasswd|\.git-credentials|credentials|credentials.*\.json|.*-credentials\.json|service-account.*\.json|secrets?\..+)$/i;
// Folders that contain only keys and logins (ssh, cloud and container tools).
const SECRET_DIR = new Set(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.gcloud']);

// The project's file list: git's view when it is a git project, else a walk.
function listFiles(dir) {
  const r = spawnSync('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20000 });
  if (!r.error && r.status === 0) return { files: [...new Set(r.stdout.split('\0').filter(Boolean))], git: true };
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch (err) {
      if (err && err.code) return;
      throw err;
    }
    for (const e of entries) {
      if (out.length >= FILES_MAX) return;
      const r2 = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!WALK_SKIP.has(e.name)) walk(r2);
      } else if (e.isFile()) {
        out.push(r2);
      }
    }
  };
  walk('');
  return { files: out, git: false };
}

// A file deleted since the list was made is left out with no note; other read errors are listed.
const GONE = new Set(['ENOENT', 'ENOTDIR']);
// What safepath.openNoLinks refuses that stays on this computer with no note: links, not a file.
const LEFT_HERE = new Set(['link', 'not a file', 'outside', 'replaced']);

// An open file to its end, stopping once it is over max bytes. -> Promise<Buffer>
async function readOpen(fd, max) {
  const parts = [];
  let got = 0;
  for (;;) {
    const buf = Buffer.alloc(64 * 1024);
    const n = await new Promise((resolve, reject) => fs.read(fd, buf, 0, buf.length, got, (err, k) => (err ? reject(err) : resolve(k))));
    if (!n) break;
    parts.push(n < buf.length ? buf.subarray(0, n) : buf);
    got += n;
    if (got > max) break;
  }
  return Buffer.concat(parts, got);
}

// -> Promise<{ bundle: Buffer (gzip), manifest: { rel: sha }, skipped: [{ path, why }], count, bytes }>
// The bundle is { v: 1, files: [{ p, x, d }] } JSON (older versions read it), written one file at
// a time into a gzip stream so only one file's text is in memory at a time.
async function pack(dir) {
  const { files } = listFiles(dir);
  let realDir = dir;
  try {
    realDir = fs.realpathSync(dir);
  } catch (err) {
    if (!err || !err.code) throw err; // then every file is skipped below
  }
  const manifest = Object.create(null);
  const skipped = [];
  const out = [];
  const gz = zlib.createGzip();
  gz.on('data', (c) => out.push(c));
  const done = new Promise((resolve, reject) => {
    gz.on('end', resolve);
    gz.on('error', reject);
  });
  const put = (text) => (gz.write(text) ? null : new Promise((resolve) => gz.once('drain', resolve)));
  let bytes = 0;
  let count = 0;
  let wait = put('{"v":1,"files":[');
  for (const raw of files.slice(0, FILES_MAX)) {
    const rel = cleanRel(raw);
    if (!rel || excluded(rel)) continue;
    // Opened once with no link on any part of the path, and read from that descriptor: a link
    // (l.txt -> ~/.aws/credentials, cfg -> ~/.aws) swapped in after a check is never read (Sol M5).
    const at = safepath.openNoLinks(realDir, rel);
    if (at.error) {
      // Links and other kinds stay here; deleted since the list: no note; other errors are listed.
      if (!LEFT_HERE.has(at.error) && !GONE.has(at.error)) skipped.push({ path: rel, why: `could not be read (${at.error})` });
      continue;
    }
    const st = at.st;
    let data = null;
    try {
      if (st.size > FILE_MAX) skipped.push({ path: rel, why: `larger than ${FILE_MAX / 1024 / 1024} MB` });
      else if (bytes + st.size > TOTAL_MAX) skipped.push({ path: rel, why: 'the project is over 100 MB' });
      else data = await readOpen(at.fd, FILE_MAX);
    } catch (err) {
      if (!err || !err.code) throw err;
      skipped.push({ path: rel, why: `could not be read (${err.code})` });
    } finally {
      fs.closeSync(at.fd);
    }
    if (!data || data.length > FILE_MAX || bytes + data.length > TOTAL_MAX) continue; // grew since the check
    if (wait) await wait;
    bytes += data.length;
    manifest[rel] = sha(data);
    wait = put((count ? ',' : '') + JSON.stringify({ p: rel, x: (st.mode & 0o111) ? 1 : 0, d: data.toString('base64') }));
    count += 1;
  }
  if (files.length > FILES_MAX) skipped.push({ path: '…', why: `more than ${FILES_MAX} files` });
  if (wait) await wait;
  gz.end(']}');
  await done;
  return { bundle: Buffer.concat(out), manifest, skipped, count, bytes };
}

// Reads a bundle's entries one at a time from the gzip stream, so the whole project is never in
// memory. Entries are flat {"p","x","d"} objects, so '},{"p":' only appears between two entries
// (quotes in strings are escaped). Calls and awaits onEntry(entry).
// -> Promise<true> | Promise<false> (not a bundle). Throws zlib's errors (they have a code).
const HEAD = '{"v":1,"files":[';
const SEP = '},{"p":';
async function eachEntry(buf, onEntry) {
  const { StringDecoder } = require('string_decoder');
  const gz = zlib.createGunzip();
  gz.end(buf);
  const dec = new StringDecoder('utf8');
  let pending = '';
  let started = false;
  let raw = 0;
  let from = 0;
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) return null;
      throw err;
    }
  };
  for await (const chunk of gz) {
    raw += chunk.length;
    if (raw > TOTAL_MAX * 2) {
      gz.destroy();
      return false;
    }
    pending += dec.write(chunk);
    if (!started) {
      if (pending.length < HEAD.length) continue;
      if (!pending.startsWith(HEAD)) {
        gz.destroy();
        return false;
      }
      pending = pending.slice(HEAD.length);
      started = true;
    }
    for (;;) {
      const at = pending.indexOf(SEP, from);
      if (at < 0) {
        from = Math.max(0, pending.length - SEP.length);
        break;
      }
      const entry = parse(pending.slice(0, at + 1));
      if (!entry) {
        gz.destroy();
        return false;
      }
      pending = pending.slice(at + 2);
      from = 0;
      await onEntry(entry);
    }
  }
  pending += dec.end();
  if (!started || !pending.endsWith(']}')) return false;
  const last = pending.slice(0, -2);
  if (!last) return true; // no files
  const entry = parse(last);
  if (!entry) return false;
  await onEntry(entry);
  return true;
}

// Writes a bundle into dest (a new folder) without blocking the server: unzipped as a stream and
// written in small batches into dest.part first, so a failure (a full disk) leaves no partial file.
// -> Promise<{ count } | { error }>
const WRITE_BATCH = 32;
async function unpack(buf, dest) {
  const part = `${dest}.part`;
  const unreadable = { error: 'The project bundle could not be read.' };
  let count = 0;
  let seen = 0;
  let batch = [];
  const flush = async () => {
    const now = batch;
    batch = [];
    await Promise.all(now.map(async (f) => {
      await fs.promises.mkdir(path.dirname(f.file), { recursive: true });
      await fs.promises.writeFile(f.file, Buffer.from(f.d, 'base64'), { mode: f.mode });
    }));
  };
  const clear = () => fs.promises.rm(part, { recursive: true, force: true }).catch((e) => {
    // A file system error (it names a syscall) leaves dest.part, which the next try removes first.
    if (!e || typeof e.syscall !== 'string') throw e;
  });
  let readable;
  try {
    await fs.promises.rm(part, { recursive: true, force: true });
    await fs.promises.mkdir(part, { recursive: true, mode: 0o700 });
    readable = await eachEntry(buf, async (f) => {
      seen += 1;
      if (seen > FILES_MAX) return;
      const rel = f && cleanRel(f.p);
      if (!rel || excluded(rel) || typeof f.d !== 'string') return;
      const file = path.join(part, rel);
      if (!within(file, part)) return;
      batch.push({ file, d: f.d, mode: f.x ? 0o755 : 0o644 });
      count += 1;
      if (batch.length >= WRITE_BATCH) await flush();
    }).catch((err) => {
      // Not gzip, or incomplete.
      if (err && typeof err.code === 'string' && err.code.startsWith('Z_')) return false;
      throw err;
    });
    if (readable) {
      await flush();
      await fs.promises.rename(part, dest);
    }
  } catch (err) {
    if (!err || !err.code) throw err;
    await clear();
    return { error: `The project could not be written here (${err.code}).` };
  }
  if (!readable) {
    await clear();
    return unreadable;
  }
  return { count };
}

function within(file, dir) {
  const r = path.relative(dir, file);
  return Boolean(r) && !r.startsWith('..') && !path.isAbsolute(r);
}

// One change from a task's workspace, written into this project when its file is as it was sent.
// change: { path, status: 'added' | 'changed' | 'deleted' }; data: Buffer (not for deleted);
// manifest: { rel: sha } as sent. -> { ok, before (Buffer | null) } | { conflict: why } | { error }
function applyChange(dir, change, data, manifest) {
  const rel = cleanRel(change && change.path);
  if (!rel || excluded(rel)) return { error: 'not a file this can write' };
  if (!within(path.join(dir, rel), dir)) return { error: 'outside the project' };
  // Through links too: the real place must be in the project, and not an excluded file.
  const at = safepath.inside(dir, rel);
  if (at.error) return { error: at.error === 'outside' ? 'outside the project (through a link)' : at.error };
  if (excluded(at.rel)) return { error: 'not a file this can write' };
  const file = at.file;
  let current = null;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { conflict: 'it is not a plain file here' };
    current = fs.readFileSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      if (err && err.code) return { error: err.code };
      throw err;
    }
  }
  const sent = Object.prototype.hasOwnProperty.call(manifest, rel) ? manifest[rel] : null;
  const now = current === null ? null : sha(current);
  if (change.status === 'deleted') {
    if (now === null) return { ok: true, same: true };
    if (now !== sent) return { conflict: 'you changed it here since it was sent' };
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err && err.code) return { error: writeError(err) };
      throw err;
    }
    return { ok: true, before: current };
  }
  if (!Buffer.isBuffer(data)) return { error: 'no content' };
  if (now !== null && now === sha(data)) return { ok: true, same: true };
  if (now !== sent) return { conflict: sent === null ? 'a file with that name was added here meanwhile' : now === null ? 'you deleted it here since it was sent' : 'you changed it here since it was sent' };
  try {
    writeAtomic(file, data, { mkdir: true });
  } catch (err) {
    if (!err || !err.code) throw err;
    return { error: writeError(err) };
  }
  return { ok: true, before: current };
}

// On Windows a file open in a dev server or editor is locked: it is reported and the rest continue.
function writeError(err) {
  return ['EPERM', 'EBUSY', 'EACCES'].includes(err.code) ? `${err.code}: the file is in use or read-only here (close it, then apply again)` : err.code;
}

module.exports = { pack, unpack, applyChange, cleanRel, excluded, secretFile, secretPath, listFiles, sha, FILE_MAX, WALK_SKIP };
