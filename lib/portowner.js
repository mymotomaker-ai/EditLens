'use strict';
// Which program listens on a local port, and whether it runs from a project folder, so /editlens
// can connect a dev server on a common port (3000, 8080) without asking for its address.
// Linux: /proc. macOS: lsof. Windows: netstat -ano, then the process's command line (Windows
// doesn't show another process's working folder). Each step returns null when it can't tell and
// never throws for a missing tool or access.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { within, tooBroad, normalize } = require('./paths');

const RUN_MS = 4000;
const MAX_PIDS = 4000; // /proc scan limit

function run(cmd, args, timeoutMs = RUN_MS) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      // A missing tool, no access or a timeout: no result from this tool.
      resolve(err ? null : String(stdout || ''));
    });
  });
}

// Linux: inodes of sockets listening on port (any local address), from /proc/net/tcp and tcp6.
function listeningInodes(port, procRoot = '/proc') {
  const hex = port.toString(16).toUpperCase().padStart(4, '0');
  const out = new Set();
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
      if (f.length < 10 || f[3] !== '0A') continue; // 0A: LISTEN
      if (f[1].split(':').pop() !== hex) continue;
      if (/^\d+$/.test(f[9]) && f[9] !== '0') out.add(f[9]);
    }
  }
  return out;
}

async function linuxOwner(port, procRoot = '/proc') {
  const inodes = listeningInodes(port, procRoot);
  if (!inodes.size) return null;
  let pids;
  try {
    pids = (await fs.promises.readdir(procRoot)).filter((n) => /^\d+$/.test(n) && Number.isSafeInteger(Number(n))).slice(0, MAX_PIDS);
  } catch (err) {
    if (err && err.code) return null;
    throw err;
  }
  for (const pid of pids) {
    let fds;
    try {
      fds = await fs.promises.readdir(path.join(procRoot, pid, 'fd'));
    } catch (err) {
      if (err && err.code) continue; // another user's process, or gone
      throw err;
    }
    for (const fd of fds) {
      let link;
      try {
        link = await fs.promises.readlink(path.join(procRoot, pid, 'fd', fd));
      } catch (err) {
        if (err && err.code) continue;
        throw err;
      }
      const m = /^socket:\[(\d+)\]$/.exec(link);
      if (!m || !inodes.has(m[1])) continue;
      return { pid: Number(pid), dir: await readlinkOrNull(path.join(procRoot, pid, 'cwd')), command: cmdline(path.join(procRoot, pid, 'cmdline')) };
    }
  }
  return null;
}

async function readlinkOrNull(p) {
  try {
    return await fs.promises.readlink(p);
  } catch (err) {
    if (err && err.code) return null;
    throw err;
  }
}

function cmdline(p) {
  try {
    return fs.readFileSync(p, 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 4000);
  } catch (err) {
    if (err && err.code) return '';
    throw err;
  }
}

// macOS (and Linux without /proc access).
async function lsofOwner(port) {
  const listing = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp']);
  const m = listing && /^p(\d+)$/m.exec(listing);
  if (!m) return null;
  const pid = Number(m[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  const cwdOut = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const dir = cwdOut && /^n(.+)$/m.exec(cwdOut);
  const ps = await run('ps', ['-o', 'command=', '-p', String(pid)]);
  return { pid, dir: dir ? dir[1] : null, command: (ps || '').trim().slice(0, 4000) };
}

// Windows: the pid listening on port, from `netstat -ano` lines like
//   TCP    127.0.0.1:3000    0.0.0.0:0    LISTENING    1234
function netstatPid(text, port) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || !/^TCP/i.test(f[0]) || !/LISTEN/i.test(f[3])) continue;
    if (f[1].split(':').pop() !== String(port)) continue;
    const pid = Number(f[4]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

async function windowsOwner(port) {
  const pid = netstatPid(await run('netstat', ['-ano', '-p', 'TCP']), port) || netstatPid(await run('netstat', ['-ano', '-p', 'TCPv6']), port);
  if (!pid) return null;
  const ps = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], 5000);
  return { pid, dir: null, command: (ps || '').trim().slice(0, 4000) };
}

// -> { pid, dir, command } for the program listening on port, or null when it can't be told.
async function portOwner(port, { platform = process.platform } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (platform === 'win32') return windowsOwner(port);
  if (platform === 'linux') {
    const found = await linuxOwner(port);
    if (found) return found;
  }
  return lsofOwner(port);
}

// True when that program runs from the project: its working folder is the project or inside it
// (or a monorepo root containing it), or its command line names a path in the project.
function ownsProject(owner, project) {
  if (!owner || !project) return false;
  const raw = String(project);
  const projectDir = /^[a-z]:[\\/]/i.test(raw) ? raw : path.resolve(raw); // a Windows path as it is
  if (tooBroad(projectDir)) return false;
  if (owner.dir && within(owner.dir, projectDir)) return true;
  // A monorepo's root running every app's dev server: the folder has a package.json.
  if (owner.dir && within(projectDir, owner.dir) && !tooBroad(owner.dir) && fs.existsSync(path.join(owner.dir, 'package.json'))) return true;
  const command = normalize(String(owner.command || '')).toLowerCase();
  const dir = normalize(projectDir).toLowerCase();
  if (!command || !dir) return false;
  // The folder followed by a separator, a quote, a space or the end: not just a prefix of a name.
  let i = command.indexOf(dir);
  while (i >= 0) {
    const next = command.charAt(i + dir.length);
    const prev = i > 0 ? command.charAt(i - 1) : ' ';
    if (/[\s"'=]/.test(prev) && (next === '' || /[/\s"']/.test(next))) return true;
    i = command.indexOf(dir, i + 1);
  }
  return false;
}

module.exports = { portOwner, ownsProject, netstatPid, listeningInodes, linuxOwner };
