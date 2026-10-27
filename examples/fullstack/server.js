// Tiny full-stack demo: static frontend in public/ plus a JSON API. No dependencies.
// Run with: node --watch server.js   (restarts when Claude edits this file)
// For local development only: a production server should serve files with a static-file library.
const http = require('http');
const fs = require('fs');
const path = require('path');

// PORT when it is a whole number 1-65535, else 5600.
const envPort = Number(process.env.PORT);
const PORT = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 5600;
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

const menu = [
  { name: 'Espresso', price: 3.0 },
  { name: 'Flat white', price: 4.25 },
  { name: 'Filter of the day', price: 3.5 },
];

// A Host header that is a name or address with an optional port 1-65535 (or none, HTTP/1.0).
function validHost(host) {
  if (host === undefined) return true;
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::(\d{1,5}))?$/i.exec(String(host || ''));
  return Boolean(m) && (m[2] === undefined || (Number(m[2]) >= 1 && Number(m[2]) <= 65535));
}

function sendJson(res, body) {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// The EditLens script tag in index.html gets this folder as its project (data-root), so chat and
// opening files work.
function withRoot(html) {
  const root = __dirname.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return html.replace(/(live\.js") data-root=""/, (m, start) => `${start} data-root="${root}"`);
}

// The request's path. A fixed base, so a bad Host header can't make it fail. -> URL, or null
function requestUrl(req) {
  try {
    return new URL(req.url, 'http://localhost');
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

const server = http.createServer((req, res) => {
  const url = requestUrl(req);
  if (!url || !validHost(req.headers.host)) {
    res.writeHead(400);
    return res.end();
  }
  if (req.method === 'GET' && url.pathname === '/api/menu') return sendJson(res, menu);

  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500);
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(path.extname(file) === '.html' ? withRoot(data.toString('utf8')) : data);
  });
  return undefined;
});

server.listen(PORT, '127.0.0.1', () => console.log(`Trailhead demo on http://127.0.0.1:${PORT}`));
