'use strict';
// Which user opened a loopback connection to this server. On Linux the client's end is a row in
// /proc/net/tcp (or tcp6) with local port = the socket's remote port and remote port = our port;
// its eighth column is the owner's uid. Used so the task account (lib/taskuser.js) doesn't get
// root's rights on root's server. On macOS and Windows there is no task account: null.
const fs = require('fs');
const path = require('path');

const OWN = typeof process.getuid === 'function' ? process.getuid() : null;
const LOOPBACK4 = /^[0-9A-F]{6}7F$/; // 127.x.x.x, as /proc writes it (little-endian)
const LOOPBACK6 = /^(0{16}FFFF0000[0-9A-F]{6}7F|0{24}01000000)$/; // ::ffff:127.x.x.x or ::1

function hexPort(n) {
  return n.toString(16).toUpperCase().padStart(4, '0');
}

// -> the uid (a number) owning the client end of the connection from clientPort to serverPort, or
// null when it can't be told.
function uidOf(clientPort, serverPort, procRoot = '/proc') {
  if (!Number.isInteger(clientPort) || !Number.isInteger(serverPort)) return null;
  const local = hexPort(clientPort);
  const remote = hexPort(serverPort);
  for (const file of ['tcp', 'tcp6']) {
    let text;
    try {
      text = fs.readFileSync(path.join(procRoot, 'net', file), 'utf8');
    } catch (err) {
      if (err && err.code) continue;
      throw err;
    }
    for (const line of text.split('\n').slice(1)) {
      const f = line.trim().split(/\s+/);
      // sl local_address rem_address st tx:rx tr:when retrnsmt uid timeout inode
      if (f.length < 8) continue;
      const [la, lp] = f[1].split(':');
      const [ra, rp] = f[2].split(':');
      if (lp !== local || rp !== remote) continue;
      const loop = file === 'tcp' ? LOOPBACK4.test(la) && LOOPBACK4.test(ra) : LOOPBACK6.test(la) && LOOPBACK6.test(ra);
      if (!loop) continue;
      const uid = Number(f[7]);
      if (Number.isSafeInteger(uid) && uid >= 0) return uid;
    }
  }
  return null;
}

// Tests only: EDITLENS_TEST_PEER=unknown makes every connection's account unknown (as on macOS and
// Windows), a uid makes it that account. Set by whoever starts the server, so it can't help another user.
function testPeer(env = process.env) {
  const v = env.EDITLENS_TEST_PEER;
  if (v === 'unknown') return null;
  return /^\d{1,9}$/.test(String(v || '')) ? Number(v) : undefined;
}

// Whether this system can tell which account opened a connection (Linux with /proc, not a test
// that says it can't).
function canTell({ platform = process.platform, env = process.env } = {}) {
  return platform === 'linux' && testPeer(env) !== null;
}

// The uid of an http request's socket, read once per connection (keep-alive and event
// streams reuse it). -> number | null
function peerUid(socket, { platform = process.platform, procRoot = '/proc' } = {}) {
  const stand = testPeer();
  if (stand !== undefined) return socket ? stand : null;
  if (!socket || platform !== 'linux') return null;
  if (socket.editlensPeerUid !== undefined) return socket.editlensPeerUid;
  const uid = uidOf(socket.remotePort, socket.localPort, procRoot);
  socket.editlensPeerUid = uid;
  return uid;
}

// The uid that owns process `pid` (its /proc entry), on Linux. -> number | null when it can't be
// told (another system, or no such process: the caller decides what that means).
function pidUid(pid, { platform = process.platform, procRoot = '/proc' } = {}) {
  if (platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const uid = fs.statSync(path.join(procRoot, String(pid))).uid;
    return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
  } catch (err) {
    if (err && ['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR'].includes(err.code)) return null;
    throw err;
  }
}

// True when the connection's owner is known and is another user than `own` (this process's user by
// default). Unknown (another system, or no row found) -> false.
function otherUser(socket, { platform = process.platform, procRoot = '/proc', own = OWN } = {}) {
  if (own === null || own === undefined) return false;
  const uid = peerUid(socket, { platform, procRoot });
  return uid !== null && uid !== own;
}

module.exports = { peerUid, uidOf, pidUid, otherUser, canTell };
