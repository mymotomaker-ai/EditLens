'use strict';
// Connect/Express middleware: injects the EditLens client into HTML responses.
// Use it in development only:
//
//   if (process.env.NODE_ENV !== 'production') app.use(require('editlens/integrations/middleware')());
//
// Options: { port = 4317, root, panel, settle, nonce }
// nonce: a string, or a function (req) -> string, added to the script tag for a strict
// Content-Security-Policy (docs/connect-your-page.md names the origins it must allow).

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function scriptTag(options, nonce) {
  // Digits only, as lib/config.js reads it ("1e3" and "0x10" don't count); otherwise 4317.
  const raw = options.port ?? process.env.EDITLENS_PORT ?? 4317;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const n = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  const port = n > 0 && n < 65536 ? n : 4317;
  let tag = `<script src="http://127.0.0.1:${port}/live.js"`;
  // The project folder: the app's own folder unless given. A page without one can't chat or open files.
  tag += ` data-root="${escapeAttr(options.root || process.cwd())}"`;
  if (options.panel) tag += ` data-panel="${escapeAttr(options.panel)}"`;
  if (options.settle !== undefined) tag += ` data-settle="${escapeAttr(options.settle)}"`;
  if (typeof nonce === 'string' && nonce) tag += ` nonce="${escapeAttr(nonce)}"`;
  return tag + '></script>';
}

// A header's value from writeHead's headers (an object, a flat [name, value, ...] list or a list of
// pairs), or undefined.
function headerIn(headers, name) {
  if (Array.isArray(headers)) {
    const pairs = headers.every(Array.isArray) ? headers : headers.flatMap((v, i) => (i % 2 ? [] : [[v, headers[i + 1]]]));
    const hit = pairs.filter((p) => String(p[0]).toLowerCase() === name).pop();
    return hit ? hit[1] : undefined;
  }
  if (!headers || typeof headers !== 'object') return undefined;
  const key = Object.keys(headers).filter((k) => k.toLowerCase() === name).pop();
  return key === undefined ? undefined : headers[key];
}

// writeHead's headers without the named ones (lower case), in the same form.
function withoutHeaders(headers, names) {
  const drop = (n) => names.includes(String(n).toLowerCase());
  if (Array.isArray(headers)) {
    if (headers.every(Array.isArray)) return headers.filter((p) => !drop(p[0]));
    return headers.filter((v, i) => !drop(i % 2 ? headers[i - 1] : v));
  }
  if (!headers || typeof headers !== 'object') return headers;
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop(k)));
}

// Only UTF-8 pages are changed: text in another character set would be garbled.
function utf8Html(type) {
  const t = String(type || '');
  if (!/text\/html/i.test(t)) return false;
  const m = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(t);
  return !m || /^utf-?8$/i.test(m[1]);
}

// Larger pages are sent unchanged, as the proxy does: buffering them costs memory, and they get no panel.
const MAX_HTML = 20 * 1024 * 1024;

module.exports = function editlensMiddleware(options = {}) {
  const fixedTag = typeof options.nonce === 'function' ? null : scriptTag(options, options.nonce);
  return function editlens(req, res, next) {
    const accept = String(req.headers.accept || '');
    if (req.method !== 'GET' || !accept.includes('text/html')) return next();
    const tag = fixedTag || scriptTag(options, options.nonce(req));

    const chunks = [];
    let held = 0;
    let passing = false; // past MAX_HTML: write chunks through unchanged
    let head = null; // headers given to writeHead, which getHeader doesn't see
    const write = res.write.bind(res);
    const end = res.end.bind(res);
    const header = (name) => {
      const v = headerIn(head, name);
      return v !== undefined ? v : res.getHeader(name);
    };
    const isHtml = () => utf8Html(header('content-type')) && !header('content-encoding');
    const flush = () => {
      for (const c of chunks.splice(0)) write(c);
    };
    const hold = (chunk, encoding) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
      chunks.push(buf);
      held += buf.length;
      if (held > MAX_HTML) {
        passing = true;
        flush();
      }
    };

    if (typeof res.writeHead === 'function') {
      const writeHead = res.writeHead.bind(res);
      res.writeHead = function (status, message, headers) {
        const named = typeof message === 'string';
        let given = named ? headers : message;
        if (given) head = given;
        // A page that gets the script (no length of its own): ETag and Last-Modified describe it
        // without the script, so they are removed here, before the headers are sent.
        if (!isHtml() || header('content-length') !== undefined) return writeHead.apply(res, arguments);
        res.removeHeader('etag');
        res.removeHeader('last-modified');
        if (given) head = given = withoutHeaders(given, ['etag', 'last-modified']);
        return named ? writeHead(status, message, given) : writeHead(status, given);
      };
    }
    res.write = function (chunk, encoding, cb) {
      // write(chunk, cb) as well as write(chunk, encoding, cb)
      const done = typeof encoding === 'function' ? encoding : cb;
      if (passing || !isHtml()) return write(chunk, encoding, cb);
      if (chunk) hold(chunk, encoding);
      // Called on the next tick once the bytes are held (or written, past MAX_HTML), as Node calls its
      // own: an app that waits for it before its next write or end would otherwise wait forever.
      if (typeof done === 'function') process.nextTick(done);
      return true;
    };
    res.end = function (chunk, encoding, cb) {
      const after = typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : cb;
      // Headers already sent with the app's content-length: a longer body would be truncated, so send it unchanged.
      const fixedLength = res.headersSent && header('content-length') !== undefined;
      if (passing || !isHtml() || fixedLength) {
        flush();
        return end(chunk, encoding, cb);
      }
      if (chunk && typeof chunk !== 'function') {
        hold(chunk, encoding);
        if (passing) return end(undefined, undefined, after);
      }
      let html = Buffer.concat(chunks.splice(0)).toString('utf8');
      // A replacement function, so "$&" in a project path is written as it is.
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, () => `${tag}</body>`) : html + tag;
      if (!res.headersSent) {
        res.setHeader('content-length', Buffer.byteLength(html));
        // They describe the page without the script: "not modified" would keep an old tag.
        res.removeHeader('etag');
        res.removeHeader('last-modified');
      }
      return end(html, 'utf8', after);
    };
    next();
  };
};
module.exports.MAX_HTML = MAX_HTML;
