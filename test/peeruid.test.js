'use strict';
require('./isolate');
// Who opened a loopback connection: the client end's row in /proc/net/tcp names its uid.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { uidOf, peerUid } = require('../lib/peeruid');

const HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
function proc(tcp, tcp6 = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-proc-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'net'));
  fs.writeFileSync(path.join(dir, 'net', 'tcp'), HEAD + tcp);
  fs.writeFileSync(path.join(dir, 'net', 'tcp6'), HEAD + tcp6);
  return dir;
}

test('the client end of a loopback connection names its user', () => {
  // 127.0.0.1:50000 -> 127.0.0.1:4317 owned by 1000; the server's own end (owned by 0) is not it.
  const dir = proc([
    '   0: 0100007F:10DD 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 11 1',
    '   1: 0100007F:C350 0100007F:10DD 01 00000000:00000000 00:00000000 00000000  1000        0 12 1',
    '   2: 0100007F:10DD 0100007F:C350 01 00000000:00000000 00:00000000 00000000     0        0 13 1',
  ].join('\n') + '\n');
  assert.strictEqual(uidOf(50000, 4317, dir), 1000);
  assert.strictEqual(uidOf(50001, 4317, dir), null, 'no such connection');
  assert.strictEqual(uidOf(NaN, 4317, dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a connection from another computer\'s address is not a loopback peer', () => {
  const dir = proc('   1: 0A00000A:C350 0100007F:10DD 01 00000000:00000000 00:00000000 00000000  1000        0 12 1\n',
    '   1: 0000000000000000FFFF00000100007F:C351 0000000000000000FFFF00000100007F:10DD 01 00000000:00000000 00:00000000 00000000  1001        0 14 1\n');
  assert.strictEqual(uidOf(50000, 4317, dir), null);
  assert.strictEqual(uidOf(50001, 4317, dir), 1001, 'an IPv4-mapped loopback address counts');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a real connection: read once and kept on the socket', { skip: process.platform !== 'linux' && 'Linux only' }, async () => {
  // The server ends the connection immediately, which the client may see as ECONNRESET; any other
  // error fails the test.
  const clientErrors = [];
  const seen = await new Promise((resolve) => {
    const server = net.createServer((c) => {
      const first = peerUid(c);
      resolve({ first, cached: c.editlensPeerUid });
      c.destroy();
      server.close();
    }).listen(0, '127.0.0.1', () => net.connect(server.address().port, '127.0.0.1').on('error', (err) => {
      if (err.code !== 'ECONNRESET') clientErrors.push(err);
    }));
  });
  assert.deepStrictEqual(clientErrors, []);
  assert.strictEqual(seen.first, process.getuid());
  assert.strictEqual(seen.cached, seen.first);
  assert.strictEqual(peerUid({ remotePort: 1, localPort: 2 }, { platform: 'darwin' }), null);
});
