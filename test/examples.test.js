'use strict';
require('./isolate');
// The example apps: the full-stack server answers 400 to a bad Host header and keeps running, its
// page names its project folder (data-root), and every EditLens line is between marker comments.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const EXAMPLES = path.join(__dirname, '..', 'examples');

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A raw request, so the Host header is sent as written. -> { status, body }
function raw(port, host, p = '/') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`GET ${p} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
    let text = '';
    sock.on('data', (c) => { text += c; });
    sock.on('end', () => resolve({ status: Number((/^HTTP\/1\.1 (\d+)/.exec(text) || [])[1]), body: text.slice(text.indexOf('\r\n\r\n') + 4) }));
    sock.on('error', reject);
  });
}

async function fullstack(t) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(EXAMPLES, 'fullstack', 'server.js')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => { if (String(c).includes('demo on')) resolve(); });
    child.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { port, child };
}

test('M19: the full-stack example answers 400 to a bad Host header and keeps running', { timeout: 20000 }, async (t) => {
  const { port, child } = await fullstack(t);
  let exited = false;
  child.on('exit', () => { exited = true; });
  for (const host of ['[', 'a b', 'x:99999']) assert.strictEqual((await raw(port, host, '/api/menu')).status, 400, host);
  assert.strictEqual(exited, false, 'still running');
  assert.strictEqual((await raw(port, `127.0.0.1:${port}`, '/api/menu')).status, 200);
});

test('L8: the full-stack page names its project folder; every EditLens line is between markers', { timeout: 20000 }, async (t) => {
  const { port } = await fullstack(t);
  const page = (await raw(port, `127.0.0.1:${port}`)).body;
  const root = path.join(EXAMPLES, 'fullstack').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  assert.match(page, /<!-- editlens:start -->\s*<script src="http:\/\/127\.0\.0\.1:4317\/live\.js" data-root="([^"]*)"><\/script>\s*<!-- editlens:end -->/);
  assert.strictEqual(/data-root="([^"]*)"/.exec(page)[1], root);
  // Each file that loads EditLens has it only between editlens:start and editlens:end.
  const files = ['fullstack/public/index.html', 'static-site/index.html', 'vite-react/vite.config.js', 'vite-router/vite.config.js'];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(EXAMPLES, rel), 'utf8');
    const outside = text.replace(/(<!--|\/\/) editlens:start[\s\S]*?(<!--|\/\/) editlens:end/g, '');
    assert.doesNotMatch(outside, /live\.js|integrations\/vite|editlens\(/, rel);
  }
  // A plain site is served by EditLens (/editlens), which adds the tag with the folder itself: a tag
  // in the file without data-root would stop that.
  assert.doesNotMatch(fs.readFileSync(path.join(EXAMPLES, 'static-site', 'index.html'), 'utf8'), /<script src="http:\/\/127\.0\.0\.1:4317\/live\.js"(?![^>]*data-root)/);
  for (const rel of ['vite-react/vite.config.js', 'vite-router/vite.config.js']) assert.match(fs.readFileSync(path.join(EXAMPLES, rel), 'utf8'), /\/\/ editlens:start\n/, rel);
});
