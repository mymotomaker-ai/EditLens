'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5411';
// A paired computer opens the project's dev site through the link (server/pair-host.js toSite).
// A site that never connects, or connects and never responds, gets the page a plain 504 instead of
// a connection held open; a site that responded once may then stay quiet (reload sockets).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { PairHost } = require('../server/pair-host');

const SITE_PORT = 4928;
const FRONT_PORT = 4929;

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// A host with its site on SITE_PORT; connections to FRONT_PORT go through toSite, as a paired
// page's do.
async function setup(t, onSite) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-site-'));
  const host = new PairHost({ stateDir: dir, port: 0, httpServer: null, siteOf: () => `http://127.0.0.1:${SITE_PORT}`, version: 'x', livePort: 1, log: () => {} });
  host.siteDialMs = 300;
  host.siteFirstByteMs = 300;
  const siteSockets = [];
  const site = await listen(net.createServer((s) => {
    siteSockets.push(s);
    onSite(s);
  }), SITE_PORT);
  const front = await listen(net.createServer((s) => {
    s.pause();
    host.toSite(s, { id: 'p1', name: 'laptop', cwd: dir }, { t: 'site', version: require('../lib/config').version });
  }), FRONT_PORT);
  t.after(() => {
    for (const s of siteSockets) s.destroy();
    site.close();
    front.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return host;
}

// Sends one request; -> { text, closed, ms } once the page's connection closes or after waitMs.
function ask(waitMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const c = net.connect(FRONT_PORT, '127.0.0.1');
    let text = '';
    let settled = false;
    const finish = (closed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      c.destroy();
      resolve({ text, closed, ms: Date.now() - started });
    };
    const timer = setTimeout(() => finish(false), waitMs);
    c.on('data', (d) => (text += d));
    c.on('close', () => finish(true));
    c.on('error', () => finish(true));
    c.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n');
  });
}

test('a site that accepts the connection and never responds: the page gets a 504', async (t) => {
  await setup(t, () => {});
  const r = await ask(3000);
  assert.ok(r.closed, 'the connection is closed, not held open');
  assert.match(r.text, /^HTTP\/1\.1 504 /);
  assert.match(r.text, /The dev site on .* is not responding .*Check that it is running there, then reload this page\./);
});

test('a site that responds once may stay quiet afterwards', async (t) => {
  await setup(t, (s) => setTimeout(() => s.write('HTTP/1.1 101 Switching Protocols\r\n\r\n'), 100));
  const r = await ask(1200);
  assert.strictEqual(r.closed, false, 'still open long after the first-response time');
  assert.match(r.text, /^HTTP\/1\.1 101 /);
});

test('a site that never connects: the page gets a 504 after the dial time', async (t) => {
  const host = await setup(t, () => {});
  // A socket that never connects, as for an address that ignores the connection attempt.
  const connect = net.connect;
  net.connect = (to, ...rest) => ((to && typeof to === 'object' ? to.port : to) === SITE_PORT ? new net.Socket() : connect.call(net, to, ...rest));
  t.after(() => {
    net.connect = connect;
  });
  host.siteFirstByteMs = 60000;
  const r = await ask(3000);
  net.connect = connect;
  assert.ok(r.closed && r.ms < 2500, JSON.stringify(r));
  assert.match(r.text, /^HTTP\/1\.1 504 /);
});
