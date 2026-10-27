'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5268';
// Sol H4: the laptop's two addresses for a paired computer (its site and its live server) forward
// only for this computer's own user. Another account on a shared computer gets a 403, not the link.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { PairRemotes } = require('../server/pair-remote');
const { otherUser } = require('../lib/peeruid');

// A temporary folder, removed when the file's tests end.
function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function gateways(other) {
  const remotes = new PairRemotes({ stateDir: tmpDir('editlens-gw-user-'), port: 5268, otherUser: () => other });
  let dialed = 0;
  remotes.dial = () => {
    dialed++;
    return Promise.reject(Object.assign(new Error('test: no link'), { code: 'ECONNREFUSED' }));
  };
  remotes.ask = () => new Promise(() => {});
  const h = { id: 'a'.repeat(32), key: 'b'.repeat(64), name: 'vps', host: '203.0.113.5', port: 5269, livePort: 4317, liveGateway: 0, siteGateway: 0, version: '0.24.45' };
  remotes.hosts.push(h);
  remotes.save = () => {};
  await remotes.open(h);
  return { remotes, h, dialed: () => dialed };
}

function get(port, urlPath = '/health', headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

function upgrade(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
    let got = '';
    s.on('data', (c) => { got += c; });
    s.on('close', () => resolve(got));
    s.on('error', () => resolve(got));
    setTimeout(() => s.destroy(), 1500).unref();
  });
}

test('H4: another user on this computer gets 403 at both addresses, and nothing goes through the link', async () => {
  const { remotes, h, dialed } = await gateways(true);
  try {
    const site = await get(h.siteGateway);
    assert.strictEqual(site.status, 403);
    assert.match(site.body, /another user on this computer/);
    const live = await get(h.liveGateway);
    assert.strictEqual(live.status, 403);
    assert.match(await upgrade(h.siteGateway), /^HTTP\/1\.1 403/);
    assert.strictEqual(dialed(), 0, 'no connection was opened to the other computer');
  } finally {
    await remotes.close();
  }
});

test('H4: this computer\'s own user still goes through the link', async () => {
  const { remotes, h, dialed } = await gateways(false);
  try {
    // With this user's key (D11): the site's cookie, and the live key at the start of the path.
    const cookie = `${remotes.cookieName(h)}=${remotes.token('site', h.siteGateway)}`;
    assert.strictEqual((await get(h.siteGateway, '/health', { cookie })).status, 502);
    await get(h.liveGateway, `/gk-${remotes.token('live', h.liveGateway)}/health`).catch((err) => err);
    assert.strictEqual(dialed(), 2);
  } finally {
    await remotes.close();
  }
});

test('H4: otherUser reads the connection\'s owner on Linux and is false when it can\'t be told', () => {
  const proc = tmpDir('editlens-gw-proc-');
  fs.mkdirSync(path.join(proc, 'net'));
  const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
  // Client end: 127.0.0.1:40000 -> 127.0.0.1:5270, owned by uid 1001.
  fs.writeFileSync(path.join(proc, 'net', 'tcp'), head + '   0: 0100007F:9C40 0100007F:1496 01 00000000:00000000 00:00000000 00000000  1001        0 1\n');
  const socket = () => ({ remotePort: 40000, localPort: 5270 });
  assert.strictEqual(otherUser(socket(), { platform: 'linux', procRoot: proc, own: 0 }), true);
  assert.strictEqual(otherUser(socket(), { platform: 'linux', procRoot: proc, own: 1001 }), false);
  assert.strictEqual(otherUser(socket(), { platform: 'win32', procRoot: proc, own: 0 }), false);
  assert.strictEqual(otherUser({ remotePort: 40001, localPort: 5270 }, { platform: 'linux', procRoot: proc, own: 0 }), false);
  assert.strictEqual(otherUser(socket(), { platform: 'linux', procRoot: proc, own: null }), false);
});
