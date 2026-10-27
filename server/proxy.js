'use strict';
// A local proxy for a dev server that is already running (Next.js, Express, anything):
// every HTML page it passes on gets the EditLens script, so the project's files never change.
// Everything else, hot-reload websockets included, passes through unchanged.

const http = require('http');
const net = require('net');
const { staticHandler } = require('./static');
const { localHost } = require('../lib/localhost');

const MAX_HTML = 20 * 1024 * 1024;

// The script tag, placed first in <head> so it sees the page's own API calls.
function inject(html, tag, src) {
  // The page loads EditLens already (from its own files): leave it.
  if (src && html.includes(src)) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const body = /<body[^>]*>/i.exec(html);
  if (body) return html.slice(0, body.index) + tag + html.slice(body.index);
  return /<html[\s>]/i.test(html) || /^\s*<!doctype html/i.test(html) ? tag + html : html;
}

// A page's Content-Security-Policy with what the EditLens script needs: loading from and connecting
// to the live server, and its panel's own styles. -> the policy, or null when it can't allow that
// without weakening it in ways a host list can't express ('strict-dynamic' scripts, or nonce/hash
// styles, where 'unsafe-inline' is ignored): then the proxy removes the header.
function allowLive(policy, origin) {
  if (!policy) return null;
  const text = Array.isArray(policy) ? policy.join(', ') : String(policy);
  // Several policies in one header (comma separated) all apply; patch each.
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const dirs = new Map();
    for (const d of p.split(';').map((x) => x.trim()).filter(Boolean)) {
      const [name, ...values] = d.split(/\s+/);
      if (!dirs.has(name.toLowerCase())) dirs.set(name.toLowerCase(), values);
    }
    const fallback = dirs.get('default-src');
    // A directive the policy doesn't set uses default-src; with neither, all is allowed.
    const add = (name, extra) => {
      const values = dirs.get(name) || (fallback ? [...fallback] : null);
      if (!values) return;
      const kept = values.filter((v) => v !== "'none'");
      for (const v of extra) if (!kept.includes(v)) kept.push(v);
      dirs.set(name, kept);
    };
    const scripts = dirs.get('script-src') || fallback || [];
    if (scripts.some((v) => v.toLowerCase() === "'strict-dynamic'")) return null;
    const styles = dirs.get('style-src') || fallback || [];
    if (styles.some((v) => /^'(nonce|sha(256|384|512))-/i.test(v))) return null;
    add('script-src', [origin]);
    if (dirs.has('script-src-elem')) add('script-src-elem', [origin]);
    add('connect-src', [origin]);
    add('style-src', ["'unsafe-inline'"]);
    if (dirs.has('style-src-elem')) add('style-src-elem', ["'unsafe-inline'"]);
    out.push([...dirs].map(([k, v]) => [k, ...v].join(' ')).join('; '));
  }
  return out.join(', ');
}

function escapeAttr(v) {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// refuse(socket) true: that connection gets a 403 and nothing else (another user's, on a pairing link).
const REFUSED = 'This address belongs to another user on this computer.';

// target: "http://127.0.0.1:3000"; staticRoot: a plain site's folder, served when there is no target or
// nothing responds there (a server started manually that stopped). -> Promise<{ server, port, url, close }>
// A paired computer's site: connect() opens each connection through the pairing link, and the script
// address of remoteLivePort (its live server) in its pages becomes livePort here; no script is added.
function startProxy({ target, port = 0, livePort, root, connect, remoteLivePort, staticRoot, onFallback, refuse, gate, liveSrc }) {
  // gate(req): null to pass the request, else the { status, headers, body } to answer instead; liveSrc():
  // the script's address at the time of a page (it can change), in place of 127.0.0.1:livePort/live.js.
  const t = target ? new URL(target) : null;
  // [::1] in an address is ::1 for a connection.
  const targetHost = t ? t.hostname.replace(/^\[(.*)\]$/, '$1') : null;
  if (t && t.protocol !== 'http:') throw new Error('Only http dev servers can be connected this way.');
  if (!t && !staticRoot) throw new Error('nothing to serve');
  const src = `127.0.0.1:${livePort}/live.js`;
  const tag = `<script src="http://${src}" data-editlens-proxy="1"${root ? ` data-root="${escapeAttr(root)}"` : ''}></script>`;
  const remoteSrc = remoteLivePort ? new RegExp(`(127\\.0\\.0\\.1|localhost):${Number(remoteLivePort)}/live\\.js`, 'g') : null;
  const rewrite = (html) => (remoteSrc ? html.replace(remoteSrc, () => (liveSrc ? liveSrc() : src)) : inject(html, tag, src));
  const targetPort = t ? Number(t.port) || 80 : 0;
  const serveStatic = staticRoot ? staticHandler(staticRoot, rewrite) : null;
  let fellBack = false;
  const sockets = new Set();
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });
  if (connect) {
    agent.createConnection = (opts, done) => {
      connect().then((s) => done(null, s), (err) => done(err));
      return undefined;
    };
  }
  let self = null;

  const server = http.createServer((req, res) => {
    if (refuse && refuse(req.socket)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close' });
      return res.end(REFUSED);
    }
    // Only this computer's own names: a website rebinding its name to 127.0.0.1 can't read the
    // app through the proxy (which would otherwise send the dev server its own Host).
    if (!localHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('host not allowed');
    }
    let answer = null;
    try {
      answer = gate ? gate(req) : null;
    } catch (err) {
      // A request the gate can't check is refused with a fixed message: no request text in the log.
      if (!(err instanceof Error)) throw err;
      console.error(`[editlens] the address check failed (${err.code || err.name}); the request was refused`);
      answer = { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, body: 'EditLens could not check this request.' };
    }
    if (answer) {
      res.writeHead(answer.status, answer.headers || {});
      return res.end(answer.body || '');
    }
    if (!t) return serveStatic(req, res);
    const headers = { ...req.headers, host: t.host, 'accept-encoding': 'identity' };
    const up = http.request({ hostname: targetHost, port: targetPort, method: req.method, path: req.url, headers, agent }, (r) => {
      const out = { ...r.headers };
      // Redirects to the dev server's own address stay on the proxy.
      if (typeof out.location === 'string' && self && out.location.startsWith(t.origin)) out.location = self + out.location.slice(t.origin.length);
      const html = /text\/html/i.test(String(r.headers['content-type'] || '')) && !r.headers['content-encoding'] && req.method === 'GET';
      if (!html) {
        res.writeHead(r.statusCode || 502, out);
        r.pipe(res);
        return;
      }
      const chunks = [];
      let size = 0;
      let over = false;
      r.on('data', (c) => {
        if (over) return res.write(c);
        size += c.length;
        if (size > MAX_HTML) {
          // Too big to rewrite: send it as it is.
          over = true;
          delete out['content-length'];
          res.writeHead(r.statusCode || 200, out);
          for (const x of chunks) res.write(x);
          res.write(c);
          return undefined;
        }
        chunks.push(c);
        return undefined;
      });
      r.on('end', () => {
        if (over) return res.end();
        const body = Buffer.from(rewrite(Buffer.concat(chunks).toString('utf8')), 'utf8');
        delete out['content-length'];
        delete out['transfer-encoding'];
        out['content-length'] = String(body.length);
        // They describe the page without the script: "not modified" would keep an old tag.
        delete out.etag;
        delete out['last-modified'];
        // The injected script loads from the live server: the page's own policy is kept, with the
        // live server added where the script needs it (or removed when it can't be, see allowLive).
        const csp = allowLive(out['content-security-policy'], `http://127.0.0.1:${livePort}`);
        if (csp) out['content-security-policy'] = csp;
        else delete out['content-security-policy'];
        res.writeHead(r.statusCode || 200, out);
        return res.end(body);
      });
      r.on('error', () => res.destroy());
    });
    up.on('error', (err) => {
      // The site's own server stopped: serve its folder instead.
      if (serveStatic && !res.headersSent && err.code === 'ECONNREFUSED' && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!fellBack && onFallback) onFallback();
        fellBack = true;
        return serveStatic(req, res);
      }
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(connect ? `EditLens: the other computer did not respond (${err.code || err.message}). EditLens keeps trying to connect to it; reload in a moment.` : `EditLens: the dev server at ${t.origin} did not respond (${err.code || err.message}). Is it running?`);
    });
    // The browser closed the connection: stop reading (and buffering) the dev server's response.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    req.pipe(up);
    return undefined;
  });

  // Websockets (hot reload): the raw connection goes through.
  server.on('upgrade', (req, socket, head) => {
    if (refuse && refuse(socket)) return refused(socket);
    if (!t || !localHost(req.headers.host)) return socket.destroy();
    const no = gate ? gate(req) : null;
    if (no) return refused(socket, no.body);
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      lines.push(`${name}: ${/^host$/i.test(name) ? t.host : req.rawHeaders[i + 1]}`);
    }
    const pipeTo = (up) => {
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head && head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    };
    let up = null;
    const done = () => {
      if (up) up.destroy();
      socket.destroy();
    };
    socket.on('error', done);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const track = (s) => {
      up = s;
      s.on('error', done);
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      if (socket.destroyed) s.destroy();
    };
    if (connect) {
      connect().then((s) => {
        track(s);
        if (!s.destroyed) pipeTo(s);
      }, done);
    } else {
      track(net.connect(targetPort, targetHost, () => pipeTo(up)));
    }
    return undefined;
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const p = server.address().port;
      self = `http://127.0.0.1:${p}`;
      resolve({
        server, port: p, url: self + '/',
        close: () => new Promise((r) => {
          for (const s of sockets) s.destroy();
          agent.destroy();
          server.close(() => r());
        }),
      });
    });
  });
}

// A raw 403, for a connection that is not handled as an http request (an upgrade, a piped link).
// The rest of what the client sends is read and ignored, so the connection can close.
function refused(s, text = REFUSED) {
  s.on('error', () => s.destroy());
  s.setTimeout(5000, () => s.destroy());
  s.resume();
  s.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`);
}

module.exports = { allowLive, startProxy, inject, refused };
