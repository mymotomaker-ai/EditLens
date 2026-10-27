'use strict';
require('./isolate');
// integrations/middleware.js and vite.mjs: write callbacks, pages that are not UTF-8, headers given
// to writeHead, project paths with "$&" in them, and a nonce for a strict Content-Security-Policy.
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const middleware = require('../integrations/middleware');

function serve(t, options, handler) {
  const mw = middleware({ port: 5247, root: '/proj', ...options });
  const app = http.createServer((req, res) => mw(req, res, () => handler(req, res)));
  t.after(() => app.close());
  return new Promise((resolve) => app.listen(0, '127.0.0.1', () => resolve(app.address().port)));
}

async function get(port, p = '/', headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { accept: 'text/html', ...headers } });
  return { status: r.status, body: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') };
}

test('M14: res.write calls its callback in both forms, after the bytes are passed on', { timeout: 10000 }, async (t) => {
  const called = [];
  const port = await serve(t, {}, (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.write('<html><body>', () => {
      called.push('two');
      res.write('hi', 'utf8', () => {
        called.push('three');
        res.end('</body></html>');
      });
    });
  });
  const { body } = await get(port);
  assert.deepStrictEqual(called, ['two', 'three']);
  assert.match(body.toString(), /^<html><body>hi<script src="http:\/\/127\.0\.0\.1:5247\/live\.js"[^>]*><\/script><\/body><\/html>$/);
});

test('M15: a page in another character set is sent unchanged', { timeout: 10000 }, async (t) => {
  const latin1 = Buffer.from('<html><body>caf\xe9</body></html>', 'latin1');
  const port = await serve(t, {}, (req, res) => {
    res.setHeader('content-type', req.url === '/utf8' ? 'text/html; charset="UTF-8"' : 'text/html; charset=ISO-8859-1');
    res.end(req.url === '/utf8' ? '<html><body>café</body></html>' : latin1);
  });
  assert.deepStrictEqual((await get(port, '/latin1')).body, latin1);
  assert.match((await get(port, '/utf8')).body.toString(), /café<script src=/);
});

test('M16: a Content-Type given only to writeHead is seen (object and array forms)', { timeout: 10000 }, async (t) => {
  const page = '<html><body>hi</body></html>';
  const port = await serve(t, {}, (req, res) => {
    if (req.url === '/object') res.writeHead(200, { 'Content-Type': 'text/html' });
    else if (req.url === '/message') res.writeHead(200, 'OK', { 'content-type': 'text/html; charset=utf-8' });
    else if (req.url === '/flat') res.writeHead(200, ['Content-Type', 'text/html']);
    else if (req.url === '/latin1') res.writeHead(200, { 'Content-Type': 'text/html; charset=iso-8859-1' });
    else if (req.url === '/length') res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': Buffer.byteLength(page) });
    else if (req.url === '/gzip') res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'identity-ish' });
    res.end(page);
  });
  for (const p of ['/object', '/message', '/flat']) assert.match((await get(port, p)).body.toString(), /hi<script src=/, p);
  for (const p of ['/latin1', '/length']) assert.strictEqual((await get(port, p)).body.toString(), page, p);
  // A body in an encoding the middleware can't read is sent unchanged (fetch can't decode it).
  // 127.0.0.1, not localhost: Node 18 tries ::1 first.
  const raw = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/gzip', headers: { accept: 'text/html' } }, (res) => {
    let s = '';
    res.on('data', (c) => { s += c; });
    res.on('end', () => resolve(s));
  }).on('error', reject));
  assert.strictEqual(raw, page);
});

test('L12: a project path with $& or $\' in it is written as it is', { timeout: 10000 }, async (t) => {
  const root = "/home/me/a$&b$'c$`d$1";
  const port = await serve(t, { root }, (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<html><body>hi</body></html>');
  });
  const { body } = await get(port);
  assert.ok(body.toString().includes(`data-root="${root.replace(/&/g, '&amp;')}"`), body.toString());
  assert.match(body.toString(), /<\/script><\/body><\/html>$/);
});

test('M20: a nonce for a strict Content-Security-Policy, given or computed per request', { timeout: 10000 }, async (t) => {
  const page = '<html><body>hi</body></html>';
  const fixed = await serve(t, { nonce: 'abc123' }, (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  assert.match((await get(fixed)).body.toString(), /<script src="http:\/\/127\.0\.0\.1:5247\/live\.js" data-root="\/proj" nonce="abc123"><\/script>/);
  const perRequest = await serve(t, { nonce: (req) => req.headers['x-test-nonce'] }, (req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  assert.match((await get(perRequest, '/', { 'x-test-nonce': 'r1"x' })).body.toString(), / nonce="r1&quot;x"><\/script>/);
  assert.doesNotMatch((await get(perRequest)).body.toString(), /nonce=/, 'no nonce for this request: none added');
  const vite = (await import('../integrations/vite.mjs')).default;
  assert.strictEqual(vite({ root: '/proj', nonce: 'abc123' }).transformIndexHtml()[0].attrs.nonce, 'abc123');
  assert.strictEqual(vite({ root: '/proj' }).transformIndexHtml()[0].attrs.nonce, undefined);
});
