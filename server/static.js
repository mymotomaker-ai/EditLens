'use strict';
// A plain site (index.html, no dev server): EditLens serves the folder itself, so there is no
// separate server to start or to lose when a session ends. Read-only, on 127.0.0.1 only, never
// cached (an edit shows on the next load), and never hidden files (.git, .env), key files
// (id_ed25519, *.pem) or anything outside the folder.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { localHost } = require('../lib/localhost');
const { secretFile } = require('../lib/sendproject');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.wasm': 'application/wasm',
};
const MAX_HTML = 20 * 1024 * 1024;

function plain(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

// The file a request names, or null when it is outside the folder or hidden. Follows symlinks only
// when they stay inside the folder. Async, so a large folder or a slow disk doesn't slow down the
// EditLens server.
async function resolveFile(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(String(urlPath || '/').split('?')[0].split('#')[0]);
  } catch (err) {
    if (err instanceof URIError) return null;
    throw err;
  }
  if (rel.includes('\0')) return null;
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  if (parts.some((p) => p === '..' || p.startsWith('.')) || secretFile(parts.join('/'))) return null;
  const realRoot = await fsp.realpath(root);
  // The real place (links resolved) must be in the site folder and not hidden: a public name
  // can't lead to .env or outside. -> the real path, null when refused, '' when missing.
  const real = async (p) => {
    try {
      p = await fsp.realpath(p);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return '';
      throw err;
    }
    if (p === realRoot) return p;
    if (!p.startsWith(realRoot + path.sep)) return null;
    const rel = path.relative(realRoot, p);
    return rel.split(path.sep).some((x) => x.startsWith('.')) || secretFile(rel) ? null : p;
  };
  const file = await real(path.join(realRoot, ...parts));
  if (file === '') return { missing: true };
  if (file === null) return null;
  const st = await fsp.stat(file);
  if (st.isDirectory()) {
    const index = await real(path.join(file, 'index.html'));
    if (index === null) return null;
    let ist = null;
    try {
      ist = index ? await fsp.stat(index) : null;
    } catch (err) {
      // Removed since realpath: missing. Any other error goes to the handler.
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) throw err;
    }
    if (!ist || !ist.isFile()) return { missing: true };
    return { file: index, size: ist.size, dir: !rel.endsWith('/') && parts.length > 0 };
  }
  return st.isFile() ? { file, size: st.size } : null;
}

// "bytes=a-b" for a file of size bytes -> { start, end } (inclusive), 'bad' when it can't be met,
// or null for the whole file (no header, or one this server doesn't do: several ranges).
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]); // the last n bytes
    if (!Number.isSafeInteger(n) || n <= 0) return 'bad';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return 'bad';
  return { start, end };
}

// -> (req, res) handler. rewrite(html) adds the EditLens script.
function staticHandler(root, rewrite) {
  return (req, res) => {
    serve(root, rewrite, req, res).catch((err) => {
      // A file that was removed or can't be read between the checks: a plain 404, never a crash.
      if (!res.headersSent) plain(res, 404, err && err.code ? 'Not found.' : 'Could not read the file.');
      else res.destroy();
    });
  };
}

async function serve(root, rewrite, req, res) {
  // Only this computer's own names: a website can't read the folder through DNS rebinding.
  if (!localHost(req.headers.host)) return plain(res, 403, 'host not allowed');
  if (req.method !== 'GET' && req.method !== 'HEAD') return plain(res, 405, 'EditLens serves this folder read-only.');
  const urlPath = String(req.url || '/');
  const found = await resolveFile(root, urlPath);
  if (!found) return plain(res, 404, 'Not found.');
  if (found.missing) return plain(res, 404, `Not found: ${urlPath.split('?')[0]}`);
  // /about -> /about/ so the page's relative links work.
  if (found.dir) {
    res.writeHead(301, { location: urlPath.split('?')[0] + '/', 'cache-control': 'no-store' });
    return res.end();
  }
  const type = TYPES[path.extname(found.file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
  if (/^text\/html/.test(type) && found.size <= MAX_HTML) {
    const body = Buffer.from(rewrite(await fsp.readFile(found.file, 'utf8')), 'utf8');
    res.writeHead(200, { ...headers, 'content-length': String(body.length) });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  // Other files stream; a Range request (video and audio seeking) gets just that part.
  const size = found.size;
  const range = parseRange(req.headers.range, size);
  if (range === 'bad') {
    res.writeHead(416, { ...headers, 'content-range': `bytes */${size}` });
    return res.end();
  }
  const part = range ? { start: range.start, end: range.end } : {};
  const length = range ? range.end - range.start + 1 : size;
  const status = range ? 206 : 200;
  const head = { ...headers, 'accept-ranges': 'bytes', 'content-length': String(length) };
  if (range) head['content-range'] = `bytes ${range.start}-${range.end}/${size}`;
  if (req.method === 'HEAD' || length === 0) {
    res.writeHead(status, head);
    return res.end();
  }
  const stream = fs.createReadStream(found.file, part);
  await new Promise((resolve, reject) => {
    // The browser left before the end (a video seek, a closed tab): the file is closed too (Sol M7).
    res.on('close', () => {
      if (!res.writableFinished) stream.destroy();
      resolve();
    });
    stream.on('open', () => {
      res.writeHead(status, head);
      stream.pipe(res);
      resolve();
    });
    stream.on('error', (err) => {
      if (!res.headersSent) reject(err);
      else res.destroy();
    });
  });
  return undefined;
}

module.exports = { staticHandler, resolveFile, parseRange };
