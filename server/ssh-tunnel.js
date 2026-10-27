'use strict';
// Pairing through SSH, for a computer whose pairing port is closed in its firewall: `ssh -N -L` forwards
// a local port to the pairing port there. The pairing link inside stays encrypted with its own key,
// so SSH only transports it. ssh runs in the background, so it must log in with a key (no prompts).
const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const READY_MS = 20000;

// "root@203.0.113.10" -> { user, host } or null. Nothing that ssh could read as an option.
function parseSshTarget(text) {
  const m = /^([a-z_][a-z0-9_.-]{0,31})@([A-Za-z0-9][A-Za-z0-9.-]{0,252}|\[[0-9a-fA-F:.]+\])$/.exec(String(text || '').trim());
  return m ? { user: m[1], host: m[2].replace(/^\[|\]$/g, '') } : null;
}

// The ssh program: EDITLENS_SSH, else ssh on PATH (Windows 10 and later include it).
function sshProgram(env = process.env, platform = process.platform) {
  if (env.EDITLENS_SSH) return env.EDITLENS_SSH;
  if (platform === 'win32') {
    const sys = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(sys)) return sys;
  }
  return 'ssh';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

class SshTunnel {
  // ssh: { user, host, sshPort, key, remotePort, localPort }
  constructor(ssh, log) {
    this.ssh = ssh;
    this.log = log || (() => {});
    this.child = null;
    this.ready = null;
    this.starting = false; // this.ready has not settled yet
    this.closed = false;
    // A tunnel an earlier EditLens left running on the saved port (it crashed or was killed, so it
    // couldn't stop its ssh): used rather than a second ssh on a new port. The pairing link's own
    // key proves it connects to the right computer; if it doesn't, distrust() stops using it.
    this.adopted = false;
    this.adoptTried = false;
  }

  get port() {
    return this.ssh.localPort;
  }

  alive() {
    return this.adopted || Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  // A connection through the tunnel failed: an adopted tunnel from before is not used again.
  distrust() {
    if (!this.adopted) return;
    this.adopted = false;
    this.ready = null;
    this.log(`the old ssh tunnel on 127.0.0.1:${this.ssh.localPort} did not work; opening a new one`);
  }

  // Starts ssh if it isn't running. -> Promise<local port>; rejects with a plain message.
  ensure() {
    if (this.closed) return Promise.reject(new Error('closed'));
    // A start that has not finished yet is shared: a second call starts no second ssh.
    if (this.ready && (this.starting || this.alive())) return this.ready;
    const ready = this.start();
    this.ready = ready;
    this.starting = true;
    // A failed start is not kept, so the next ensure() tries again; its callers get the error
    // from the promise itself.
    ready.then(() => {
      if (this.ready === ready) this.starting = false;
    }, (err) => {
      if (this.ready !== ready) return;
      this.ready = null;
      this.starting = false;
      this.log(`ssh tunnel: ${err.message}`);
    });
    return ready;
  }

  async start() {
    const s = this.ssh;
    if (s.localPort && !this.adoptTried) {
      this.adoptTried = true;
      if (!(await isFree(s.localPort)) && (await canConnect(s.localPort))) {
        this.adopted = true;
        this.log(`using the ssh tunnel still open on 127.0.0.1:${s.localPort}`);
        return s.localPort;
      }
    }
    if (!s.localPort || !(await isFree(s.localPort))) s.localPort = await freePort();
    const args = [
      '-N', '-T',
      '-L', `127.0.0.1:${s.localPort}:127.0.0.1:${s.remotePort}`,
      '-o', 'BatchMode=yes',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=3',
      // First visit: remember the computer's host key; after that ssh checks it as usual.
      '-o', 'StrictHostKeyChecking=accept-new',
    ];
    if (this.closed) throw new Error('closed');
    if (s.sshPort) args.push('-p', String(s.sshPort));
    if (s.key) args.push('-i', s.key);
    args.push(`${s.user}@${s.host}`);
    const child = spawn(sshProgram(), args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.child = child;
    let err = '';
    child.stderr.on('data', (c) => { err = (err + c).slice(-2000); });
    const exited = new Promise((resolve) => {
      child.once('error', (e) => resolve(e.code === 'ENOENT' ? 'ssh is not installed on this computer (on Windows: Settings > Apps > Optional features > OpenSSH Client).' : e.message));
      child.once('exit', (code) => resolve(sshError(err, code)));
    });
    child.once('exit', () => {
      if (this.child === child) this.child = null;
    });
    const end = Date.now() + READY_MS;
    for (;;) {
      const done = await Promise.race([exited, sleep(200).then(() => null)]);
      if (done !== null) throw new Error(this.closed ? 'closed' : done);
      if (await canConnect(s.localPort)) {
        if (this.closed) {
          child.kill();
          throw new Error('closed');
        }
        this.log(`ssh tunnel to ${s.user}@${s.host} open on 127.0.0.1:${s.localPort}`);
        return s.localPort;
      }
      if (Date.now() > end) {
        child.kill();
        throw new Error(`ssh to ${s.host} did not open the tunnel within ${READY_MS / 1000} s`);
      }
    }
  }

  // An adopted tunnel has no ssh of ours to stop: it is only no longer used.
  close() {
    this.closed = true;
    this.adopted = false;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) this.child.kill();
  }
}

function isFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ssh's own error text, in plain words.
function sshError(stderr, code) {
  const t = String(stderr || '');
  if (/permission denied/i.test(t)) return 'ssh could not log in with a key. EditLens runs ssh in the background, so it can\'t type a password: set up a key login (ssh-copy-id, or add your public key to ~/.ssh/authorized_keys there), or add --key "ENTER YOUR KEY LOCATION HERE" to the /editlens join line, with the path of your key file.';
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(t)) return 'ssh refused: that computer\'s host key changed since you last connected. Check it with a plain ssh login first.';
  if (/could not resolve hostname/i.test(t)) return 'ssh could not find that computer\'s name.';
  if (/connection refused|connection timed out|no route to host|network is unreachable/i.test(t)) return 'ssh could not connect to that computer (check the address and that SSH is running there).';
  if (/forwarding failed|address already in use|cannot listen/i.test(t)) return 'ssh could not open the local port for the tunnel.';
  const last = t.trim().split(/\r?\n/).pop();
  return last ? `ssh stopped: ${last}` : `ssh stopped (exit ${code})`;
}

module.exports = { SshTunnel, parseSshTarget, sshProgram, sshError };
