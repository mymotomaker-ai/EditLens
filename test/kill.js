'use strict';
// Signals one process a test started, by its pid. Never -1 (every process the user owns), 0 (the
// process group), 1, or the test itself. -> true when signalled, false when it was gone already
const fs = require('fs');
const path = require('path');

function killPid(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error(`not a pid to signal: ${pid}`);
  try {
    process.kill(pid, signal);
    return true;
  } catch (err) {
    if (err.code !== 'ESRCH') throw err;
    return false;
  }
}

function readProc(pid, name) {
  try {
    return fs.readFileSync(`/proc/${pid}/${name}`, 'utf8').split('\0');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ESRCH' || err.code === 'EACCES') return null;
    throw err;
  }
}

// For a pid from a server's /health answer: signals it only when that process runs a server.js
// with EDITLENS_STATE_DIR set to this test's state folder (read from /proc, so Linux only).
function killServer(pid, stateDir, signal) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error(`not a pid to signal: ${pid}`);
  const env = readProc(pid, 'environ');
  const args = readProc(pid, 'cmdline');
  if (!env || !args) return false;
  const want = path.resolve(stateDir);
  const ok = env.includes(`EDITLENS_STATE_DIR=${want}`) && args.some((a) => path.basename(a) === 'server.js');
  if (!ok) throw new Error(`pid ${pid} is not the EditLens server of ${want}`);
  return killPid(pid, signal);
}

module.exports = { killPid, killServer };
