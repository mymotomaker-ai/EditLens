'use strict';
// The computer others pair with (a VPS, for example). `/editlens pair` makes a one-time code and opens the
// pairing port; a computer that joins with the code gets its own pairing key. Its connections are
// then treated like pages on this computer: they connect to this live server (so every check here
// still applies), the project's dev site, and page control.
// The pairing port is open only while a code is waiting or a pairing exists, and only on
// 127.0.0.1 (used through an SSH tunnel) unless `/editlens pair open` allowed direct joins.
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { writeAtomic } = require('../lib/atomic');
const tls = require('tls');
const crypto = require('crypto');
const { spawn } = require('child_process');
const wire = require('../lib/pairwire');
const { plainError } = require('../lib/plainerr');
const { keepsKey, updateText } = require('./pair-remote');

const FAIL_WINDOW_MS = 60000;
const FAIL_LIMIT = 10;
const BLOCK_MS = 10 * 60000;
// Under /editlens's own 10-minute limit on the other computer.
const CONTROL_MS = 8 * 60000;
// The dev site: connecting (as server/pair-remote.js DIAL_TIMEOUT_MS), and the first bytes of its
// response after the page asked (long enough for a slow first build). After that a connection may be
// idle for any length of time: reload sockets and event streams are.
const SITE_DIAL_MS = 10000;
const SITE_FIRST_BYTE_MS = 2 * 60000;

// The origins a paired computer says its gateways have: http://127.0.0.1:<port> or
// http://localhost:<port>, at most four. Anything else is removed.
function linkOrigins(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((o) => typeof o === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}$/.test(o)).map((o) => o.toLowerCase()).slice(0, 4);
}

class PairHost {
  // httpServer: the live server (pairs' page connections are sent to it); siteOf(cwd): the project's
  // dev site address, or null; env: extra environment for bin/drive.js. tasks(pair, body): a task
  // request from a paired computer's Claude (server/tasks.js), or null. onNotice(text, about): a message
  // for the user here; about: { kind: 'paired', name, site, pairing } (the mod shows its own block).
  constructor({ stateDir, port, httpServer, siteOf, version, livePort, log, env, onNotice, tasks, runsAllowed, answersAllowed, onRemoved }) {
    this.tasks = tasks || null;
    // onRemoved(ids): pairings were removed (pair off, join off here, unpair there); true when
    // that ended page control one of them turned on.
    this.onRemoved = onRemoved || (() => false);
    // The "Paired computers can run Claude here" setting: tasks and page control alike.
    this.runsAllowed = runsAllowed || (() => true);
    // The setting "Paired computers can answer questions here", told to them in each ping.
    this.answersAllowed = answersAllowed || (() => false);
    this.file = path.join(stateDir, 'pair-host.json');
    this.port = port;
    this.httpServer = httpServer;
    this.siteOf = siteOf;
    this.version = version;
    this.livePort = livePort;
    this.log = log;
    this.env = env || {};
    this.onNotice = onNotice || (() => {});
    this.name = wire.cleanName(os.hostname().split('.')[0]);
    this.machine = wire.machineId(stateDir);
    this.pending = null; // { id, code, key, cwd, expires }; id names this code in /editlens pair's output
    this.pairs = this.load();
    this.direct = this.loadDirect();
    this.server = null;
    this.failures = new Map(); // "<address>\0<identity>" -> [times]
    this.blocked = new Map(); // "<address>\0<identity>" -> until
    this.live = new Map(); // pair id -> open connections
    this.taskConns = new Map(); // pair id -> task requests not answered yet
    this.siteDialMs = SITE_DIAL_MS;
    this.siteFirstByteMs = SITE_FIRST_BYTE_MS;
    this.siteRefusedAt = new Map(); // pair id -> when a refused site link was last logged
  }

  load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      if (err instanceof SyntaxError) {
        this.log('pairing file unreadable, starting without pairings');
        return [];
      }
      // Locked or not readable: start without pairings, and never write over the file meanwhile.
      if (['EACCES', 'EPERM', 'EBUSY', 'EISDIR', 'ENOTDIR', 'EIO'].includes(err.code)) {
        this.log(`pairing file can't be read (${err.code}): starting without pairings, the file is left as it is`);
        this.readOnly = true;
        return [];
      }
      throw err;
    }
    const list = data && Array.isArray(data.pairs) ? data.pairs : [];
    return list.filter((p) => p && /^[0-9a-f]{32}$/.test(p.id) && /^[0-9a-f]{64}$/.test(p.key) && typeof p.cwd === 'string');
  }

  loadDirect() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')).direct === true;
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError || err instanceof TypeError || ['EACCES', 'EPERM', 'EBUSY', 'EISDIR', 'ENOTDIR', 'EIO'].includes(err.code)) return false;
      throw err;
    }
  }

  save() {
    if (this.readOnly) return this.log('pairing file not saved: it could not be read at start');
    if (!this.pairs.length) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    writeAtomic(this.file, JSON.stringify({ direct: this.direct, pairs: this.pairs }, null, 2), { mode: 0o600 });
  }

  active() {
    return this.pairs.length > 0 || (this.pending !== null && this.pending.expires > Date.now());
  }

  // Opens the port when there is something to pair with. -> Promise<null | error message>
  async sync() {
    if (this.active() && !this.server) return this.listen();
    if (!this.active() && this.server) this.close();
    return null;
  }

  listen() {
    const server = tls.createServer({
      ...wire.TLS,
      pskCallback: (socket, identity) => {
        socket.editlensTried = identity;
        if (this.isBlocked(socket.remoteAddress, identity)) return null;
        const psk = this.keyFor(identity);
        if (psk) socket.editlensIdentity = identity;
        // A join is for this code (its folder and its time), not for a newer one made meanwhile.
        if (psk && identity === wire.JOIN_ID) socket.editlensCode = this.pending;
        return psk;
      },
    });
    server.on('tlsClientError', (err, socket) => this.failed(socket && socket.remoteAddress, socket && socket.editlensTried));
    server.on('secureConnection', (socket) => {
      this.serve(socket).catch((err) => {
        this.log('pairing connection failed:', err.message);
        socket.destroy();
      });
    });
    return new Promise((resolve) => {
      server.once('error', (err) => {
        resolve(err.code === 'EADDRINUSE' ? `port ${this.port} is in use on this computer (set EDITLENS_PAIR_PORT to another one)` : `cannot open port ${this.port}: ${err.code || err.message}`);
      });
      server.listen(this.port, this.direct ? undefined : '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', (err) => this.log('pairing port error:', err.message));
        this.server = server;
        this.log(`pairing port open on ${this.direct ? '' : '127.0.0.1:'}${this.port}`);
        resolve(null);
      });
    });
  }

  close() {
    if (!this.server) return;
    this.server.close();
    this.server = null;
    for (const id of new Set([...this.live.keys(), ...this.taskConns.keys()])) this.closeConns(id);
    this.log('pairing port closed');
  }

  // Closes a pairing's page connections and its unanswered task requests.
  closeConns(id) {
    for (const s of this.live.get(id) || []) s.destroy();
    for (const s of this.taskConns.get(id) || []) s.destroy();
    this.live.delete(id);
    this.taskConns.delete(id);
  }

  keyFor(identity) {
    if (identity === wire.JOIN_ID) return this.pending && this.pending.expires > Date.now() ? this.pending.key : null;
    const pair = this.pairs.find((p) => p.id === identity);
    return pair ? Buffer.from(pair.key, 'hex') : null;
  }

  // Wrong keys count per address and per pairing (or per code): a mistyped code never blocks a
  // computer that is already paired. Through an SSH tunnel every connection comes from
  // 127.0.0.1, and only someone with SSH (or on this computer) can connect there: never blocked.
  blockKey(address, identity) {
    return `${address}\0${String(identity || '').slice(0, 64)}`;
  }

  isBlocked(address, identity) {
    const now = Date.now();
    for (const [k, until] of this.blocked) if (until <= now) this.blocked.delete(k);
    return this.blocked.has(this.blockKey(address, identity));
  }

  failed(address, identity) {
    if (!address) return;
    if (!this.direct && /^(127\.|::1$|::ffff:127\.)/.test(address)) return;
    const key = this.blockKey(address, identity);
    const now = Date.now();
    const recent = (this.failures.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    recent.push(now);
    this.failures.delete(key);
    this.failures.set(key, recent);
    if (this.failures.size > 1000) this.failures.delete(this.failures.keys().next().value);
    if (recent.length >= FAIL_LIMIT) {
      this.blocked.set(key, now + BLOCK_MS);
      this.failures.delete(key);
      if (this.blocked.size > 1000) this.blocked.delete(this.blocked.keys().next().value);
      this.log(`pairing: too many wrong keys from ${address}, blocked for 10 minutes`);
    }
  }

  // `/editlens pair` in a project; direct: also accept joins from the network, not only through
  // SSH. -> Promise<{ code, port, addresses, name, minutes, direct } | { error }>
  async newCode(cwd, { direct = false } = {}) {
    const code = wire.newCode();
    this.pending = { id: crypto.randomBytes(6).toString('hex'), code: wire.normalizeCode(code), key: wire.codeKey(code), cwd, expires: Date.now() + wire.CODE_MINUTES * 60000 };
    if (Boolean(direct) !== this.direct) {
      // Listening somewhere else: open the port again.
      this.direct = Boolean(direct);
      this.close();
      if (this.pairs.length) this.save();
    }
    const err = await this.sync();
    if (err) {
      this.pending = null;
      return { error: err };
    }
    setTimeout(() => this.sync(), wire.CODE_MINUTES * 60000 + 1000).unref();
    return { code, id: this.pending.id, port: this.port, addresses: addresses(), name: this.name, minutes: wire.CODE_MINUTES, user: loginName(), sshPort: sshPort(), direct: this.direct, keyPath: wire.knownKey(this.pairs) };
  }

  // `/editlens join off <name>` here: removes the pairing that computer made with this one. It is
  // not told; its link is refused, and it shows Re-pair. -> [{ name }] removed
  remove(name) {
    const n = String(name || '').toLowerCase();
    const gone = this.pairs.filter((p) => p.name === n);
    if (!gone.length) return [];
    for (const p of gone) this.closeConns(p.id);
    this.pairs = this.pairs.filter((p) => !gone.includes(p));
    this.save();
    this.onRemoved(gone.map((p) => p.id));
    this.sync().then((err) => err && this.log(`pairing: ${err}`), (err) => this.log(`pairing: ${err.message}`));
    this.log(`pairing with ${n} removed here`);
    return [{ name: n }];
  }

  off() {
    const ids = this.pairs.map((p) => p.id);
    this.pairs = [];
    this.pending = null;
    this.save();
    this.close();
    const ended = ids.length > 0 && this.onRemoved(ids) === true;
    return { removed: ids.length, ...(ended ? { controlEnded: true } : {}) };
  }

  status() {
    return {
      name: this.name,
      port: this.server ? this.port : null,
      direct: this.direct,
      waiting: this.pending && this.pending.expires > Date.now() ? { minutesLeft: Math.ceil((this.pending.expires - Date.now()) / 60000), cwd: this.pending.cwd, id: this.pending.id } : null,
      // url: the address the paired computer opens this project's page at (it says so in its pings).
      pairs: this.pairs.map((p) => ({ name: p.name, cwd: p.cwd, url: p.siteUrl || null, lastSeen: p.lastSeen || null, connected: (this.live.get(p.id) || new Set()).size > 0, keyPath: wire.keyPath(p.keyPath) })),
    };
  }

  // A pairing that still exists (a page connection's requests are checked against it).
  has(id) {
    return this.pairs.some((p) => p.id === id);
  }

  // Which computer a page connection came through, for the page (shown in its panel), or null.
  via(socket) {
    return socket && socket.editlensPair ? { name: this.name, ...(socket.editlensPair.peerVersion ? { peerVersion: socket.editlensPair.peerVersion } : {}) } : null;
  }

  async serve(socket) {
    const identity = socket.editlensIdentity;
    const head = await wire.readHeader(socket);
    if (identity === wire.JOIN_ID) return this.join(socket, head);
    const pair = this.pairs.find((p) => p.id === identity);
    if (!pair) return socket.destroy();
    pair.lastSeen = Date.now();
    // Kept across restarts, saved at most once a minute.
    if (pair.lastSeen - (this.seenSavedAt || 0) > 60000) {
      this.seenSavedAt = pair.lastSeen;
      try {
        this.save();
      } catch (err) {
        if (!err.code) throw err;
        this.log(`pairing file not saved (${err.code})`);
      }
    }
    if (head.t === 'ping') {
      // Where the paired computer opens this project's page (0.24.33 and later say it).
      if (typeof head.site === 'string' && /^http:\/\/(127\.0\.0\.1|localhost):\d{1,5}\/$/.test(head.site)) pair.siteUrl = head.site;
      wire.writeLine(socket, { ok: true, protocol: wire.PROTOCOL, version: this.version, name: this.name, site: Boolean(this.siteOf(pair.cwd)), answers: this.answersAllowed() === true });
      return socket.end();
    }
    if (head.t === 'live') return this.toLiveServer(socket, pair, head);
    if (head.t === 'site') return this.toSite(socket, pair, head);
    if (head.t === 'control') return this.control(socket, pair, head);
    if (head.t === 'task') return this.task(socket, pair);
    if (head.t === 'unpair') {
      // Its page connections and task requests close now, as with remove().
      this.closeConns(pair.id);
      this.pairs = this.pairs.filter((p) => p !== pair);
      this.save();
      this.onRemoved([pair.id]);
      wire.writeLine(socket, { ok: true });
      socket.end();
      this.log(`pairing with ${pair.name} removed by ${pair.name}`);
      this.onNotice(`◆ ${pair.name} unpaired from this computer`);
      return this.sync();
    }
    return socket.destroy();
  }

  join(socket, head) {
    const pending = this.pending;
    if (!pending || head.t !== 'join' || socket.editlensCode !== pending || pending.expires <= Date.now()) return socket.destroy();
    // One computer per code: the next one needs a new code.
    this.pending = null;
    if (head.protocol !== wire.PROTOCOL) {
      wire.writeLine(socket, { ok: false, error: `the two computers run different EditLens versions (this one: ${this.version}). Update both, then pair again.` });
      return socket.end();
    }
    const machine = typeof head.machine === 'string' && /^[0-9a-f]{32}$/.test(head.machine) ? head.machine : null;
    // keyPath: the key file that computer joined with through SSH (its path only), for the ssh lines.
    const keyPath = wire.keyPath(head.keyPath);
    const pair = { id: crypto.randomBytes(16).toString('hex'), key: crypto.randomBytes(32).toString('hex'), name: wire.cleanName(head.name), cwd: pending.cwd, created: Date.now(), ...(machine ? { machine } : {}), ...(keyPath ? { keyPath } : {}) };
    // The same computer pairing again replaces its earlier pairing, in any folder: it keeps one
    // pairing per computer, so an old one here would only be listed ("2 computers paired") and
    // never connect again.
    const again = this.pairs.filter((p) => sameComputer(p, pair));
    for (const old of again) this.closeConns(old.id);
    this.pairs = this.pairs.filter((p) => !again.includes(p)).concat(pair);
    this.save();
    this.log(`paired with ${pair.name}${again.length ? ` (replaces its earlier pairing${again.some((p) => p.cwd !== pair.cwd) ? ` for ${[...new Set(again.map((p) => path.basename(p.cwd)))].join(', ')}` : ''})` : ''}`);
    const site = Boolean(this.siteOf(pair.cwd));
    this.onNotice(`Paired with ◆ ${pair.name} · it can open this project's page${site ? '' : ' (connect it here with /editlens)'} and give Claude here tasks; you answer their permission questions`,
      { kind: 'paired', name: pair.name, site, answers: this.answersAllowed() === true, pairing: pending.id || null });
    wire.writeLine(socket, { ok: true, protocol: wire.PROTOCOL, id: pair.id, key: pair.key, name: this.name, cwd: pair.cwd, version: this.version, livePort: this.livePort, ...(this.machine ? { machine: this.machine } : {}) });
    return socket.end();
  }

  track(socket, pair) {
    if (!this.live.has(pair.id)) this.live.set(pair.id, new Set());
    const set = this.live.get(pair.id);
    set.add(socket);
    socket.on('close', () => set.delete(socket));
  }

  // The page's requests (the script, its event stream, files, messages) go to this live server as
  // if the page were on this computer; the server identifies them by socket.editlensPair, allows only
  // the paired project (cwd), and accepts page requests only from the two addresses the paired
  // computer opened for it (origins: its site and its end of the link).
  toLiveServer(socket, pair, head) {
    // version: the EditLens the other computer runs, so its page can say when the two differ.
    const peerVersion = head && typeof head.version === 'string' && /^\d+\.\d+\.\d+$/.test(head.version) ? head.version : null;
    socket.editlensPair = { id: pair.id, name: pair.name, cwd: pair.cwd, origins: linkOrigins(head && head.origins), peerVersion };
    // Kept with the pairing for its site link: 0.24.45 and 0.24.46 name their version only here.
    if (peerVersion && pair.peerVersion !== peerVersion) {
      pair.peerVersion = peerVersion;
      try {
        this.save();
      } catch (err) {
        if (!err.code) throw err;
        this.log(`pairing file not saved (${err.code})`);
      }
    }
    this.track(socket, pair);
    this.httpServer.emit('connection', socket);
    socket.resume();
  }

  toSite(socket, pair, head) {
    // A computer that joined with EditLens older than 0.24.45 has no key at its own site address for
    // this link, so another account there could use it: refused (D14). 0.24.45 and 0.24.46 name no
    // version here: the one their live link named is used; none known yet is refused too.
    const named = head && typeof head.version === 'string' ? head.version : '';
    const version = named || (typeof pair.peerVersion === 'string' ? pair.peerVersion : '');
    if (!keepsKey(version)) {
      // Logged at most once a minute for each pairing (a page opens many connections).
      const now = Date.now();
      if (now - (this.siteRefusedAt.get(pair.id) || 0) > 60000) {
        this.siteRefusedAt.set(pair.id, now);
        this.log(`refused the site link from ◆ ${pair.name}: ${version ? `it runs EditLens ${version.slice(0, 40)}` : 'its EditLens version is not known yet'}; it needs 0.24.45 or later`);
      }
      const body = updateText(pair.name);
      socket.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const site = this.siteOf(pair.cwd);
    if (!site) {
      const body = `No dev site is connected on ${this.name} for this project. Run /editlens there, then reload this page.`;
      socket.end(`HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return;
    }
    const u = new URL(site);
    // autoSelectFamily: a dev server on "localhost" may listen on ::1 or on 127.0.0.1 only.
    const up = net.connect({ port: Number(u.port) || 80, host: u.hostname, autoSelectFamily: true });
    this.track(socket, pair);
    let answered = false;
    let timer = null;
    const done = () => {
      clearTimeout(timer);
      up.destroy();
      socket.destroy();
    };
    // A site that never responds: the page gets a plain error instead of a connection left open.
    const notResponding = () => {
      clearTimeout(timer);
      up.destroy();
      if (answered || socket.destroyed) return done();
      const body = `The dev site on ${this.name} is not responding (${site}). Check that it is running there, then reload this page.`;
      socket.end(`HTTP/1.1 504 Gateway Timeout\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
      return undefined;
    };
    timer = setTimeout(notResponding, this.siteDialMs);
    up.on('connect', () => {
      clearTimeout(timer);
      timer = null;
      up.once('data', () => {
        answered = true;
        clearTimeout(timer);
      });
      // Timed from the page's first request, not the connection: a browser may open one early.
      socket.once('data', () => {
        if (!answered) timer = setTimeout(notResponding, this.siteFirstByteMs);
      });
      up.pipe(socket);
      socket.pipe(up);
      socket.resume();
    });
    up.on('error', done);
    socket.on('error', done);
    socket.on('close', () => {
      clearTimeout(timer);
      up.destroy();
    });
  }

  // A request from the paired computer's Claude: start, check, message or stop a task here.
  async task(socket, pair) {
    if (!this.taskConns.has(pair.id)) this.taskConns.set(pair.id, new Set());
    const open = this.taskConns.get(pair.id);
    open.add(socket);
    let out;
    try {
      // A part of a sent project can take a while.
      const body = await wire.readHeader(socket, 30000, wire.BODY_MAX);
      open.delete(socket);
      // The pairing can be removed while the request is sent.
      if (!this.has(pair.id) || socket.destroyed) out = { error: `${pair.name} is no longer paired with ${this.name}.` };
      else out = this.tasks ? await this.tasks(pair, body) : { error: `${this.name} can't run tasks.` };
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      out = { error: err.message };
    } finally {
      open.delete(socket);
      if (!open.size && this.taskConns.get(pair.id) === open) this.taskConns.delete(pair.id);
    }
    if (socket.destroyed) return;
    wire.writeLine(socket, out);
    socket.end();
  }

  // `/editlens control <name>` on the other computer: page control here, through bin/drive.js
  // (it sets up the Claude Agent SDK if needed and asks this server to start). `take` there moves
  // page control here from another project, as /editlens control take does here.
  control(socket, pair, head) {
    const args = wire.controlArgs(head.args);
    // Back to manual always works; starting Claude here needs the setting on.
    if (args[0] !== 'manual' && !this.runsAllowed()) {
      wire.writeLine(socket, { ok: false, text: `Running Claude from paired computers is turned off on ◆ ${this.name} ("Paired computers can run Claude here" in /config on ◆ ${this.name}).` });
      return socket.end();
    }
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'drive.js'), ...args], {
      // EDITLENS_PAIRED_BY: page control it turns on ends when this pairing is removed. EDITLENS_NO_START:
      // it never starts a server after this one stopped (as auto page control's setup).
      cwd: pair.cwd, windowsHide: true, env: { ...process.env, ...this.env, CLAUDE_PROJECT_DIR: pair.cwd, EDITLENS_PAIRED_BY: pair.id, EDITLENS_NO_START: '1' },
    });
    let out = '';
    const add = (c) => { out = (out + c).slice(-8000); };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const timer = setTimeout(() => child.kill(), CONTROL_MS);
    child.on('error', (err) => add(`could not run: ${plainError(err)}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      wire.writeLine(socket, { ok: code === 0, text: out.trim() });
      socket.end();
    });
  }
}

// Two pairings from one computer: the same id when both have one (0.24.33 and later), else the
// same name (pairings saved before ids existed).
function sameComputer(a, b) {
  return a.machine && b.machine ? a.machine === b.machine : a.name === b.name;
}

// The key file the computers that joined this one used (wire.knownKey), read from the saved
// pairings, for a script that has no server object. null when there is none or no file to read.
function savedKey(stateDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(stateDir, 'pair-host.json'), 'utf8'));
    return wire.knownKey(data && data.pairs);
  } catch (err) {
    if (err instanceof SyntaxError || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(err.code)) return null;
    throw err;
  }
}

// The user this server runs as, for the SSH join line (`root@...`), or null.
function loginName() {
  try {
    const name = os.userInfo().username;
    return /^[a-z_][a-z0-9_.-]{0,31}$/i.test(name) ? name : null;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ERR_SYSTEM_ERROR' || err.code === 'EACCES')) return null;
    throw err;
  }
}

// This computer's SSH port when it isn't 22 (from sshd_config), else null.
function sshPort(file = '/etc/ssh/sshd_config') {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(err.code)) return null;
    throw err;
  }
  const m = /^\s*Port\s+(\d{1,5})\s*$/im.exec(text);
  const n = m ? Number(m[1]) : 22;
  return Number.isInteger(n) && n > 0 && n < 65536 && n !== 22 ? n : null;
}

// This computer's network addresses, public ones first, for the join line.
function addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (!a.internal && (a.family === 'IPv4' || a.family === 4)) out.push(a.address);
  }
  return out.sort((a, b) => Number(isPrivate(a)) - Number(isPrivate(b)));
}

function isPrivate(ip) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip);
}

module.exports = { linkOrigins, PairHost, addresses, isPrivate, loginName, sshPort, sameComputer, savedKey };
