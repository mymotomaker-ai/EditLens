'use strict';
// The computer that joins another one (a laptop joining a VPS). For each paired computer it opens
// two local addresses: the site (that computer's dev site, through the pairing link) and its live
// server, so the page and its panel work as if the other computer were this one. The link is
// checked regularly and reopened, with longer waits each time, when it breaks.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { writeAtomic } = require('../lib/atomic');
const tls = require('tls');
const wire = require('../lib/pairwire');
const { startProxy, refused } = require('./proxy');
const { otherUser } = require('../lib/peeruid');
const { gatewayKey, FILE: KEY_FILE } = require('../lib/pagekey');
const { SshTunnel, parseSshTarget } = require('./ssh-tunnel');

const PING_MS = 15000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 20000, 30000];
const DIAL_TIMEOUT_MS = 10000;
const CONTROL_WAIT_MS = 8.5 * 60000;
// Starting a task waits for Claude to start there.
const TASK_WAIT_MS = 2 * 60000;
const RESTORE_WAIT_MS = 30000;
// D11: the two local addresses of a pairing answer only the user who can read the key file.
const KEY_PARAM = 'editlens-key';
const HOP_PARAM = 'editlens-to';
const GATE_REFUSED = 'This address is for the user who paired this computer. In Claude Code on this computer, '
  + '/editlens join lists the paired computers with the address to open.';
const HEAD_MAX = 16 * 1024;

class PairRemotes {
  constructor({ stateDir, port, log, onChange, otherUser: other }) {
    this.file = path.join(stateDir, 'pair-remote.json');
    this.defaultPort = port;
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});
    // Both local addresses allow actions through this pairing: only this computer's own user may use them.
    this.otherUser = other || ((socket) => otherUser(socket));
    this.keyFile = path.join(stateDir, KEY_FILE);
    this.gwKey = null;
    this.name = wire.cleanName(os.hostname().split('.')[0]);
    this.machine = wire.machineId(stateDir);
    this.hosts = this.load();
    this.links = new Map(); // id -> { live, site, timer, fails, state, error }
    this.tunnels = new WeakMap(); // host (or a join attempt) -> SshTunnel, for pairing through SSH
  }

  get size() {
    return this.hosts.length;
  }

  load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      if (err instanceof SyntaxError) {
        this.log('paired computers file unreadable, starting without them');
        return [];
      }
      if (['EACCES', 'EPERM', 'EBUSY', 'EISDIR', 'ENOTDIR', 'EIO'].includes(err.code)) {
        this.log(`paired computers file can't be read (${err.code}): starting without them, the file is left as it is`);
        this.readOnly = true;
        return [];
      }
      throw err;
    }
    const list = data && Array.isArray(data.hosts) ? data.hosts : [];
    // Saved ports are used only when they are whole numbers 1-65535: else the join's default (live)
    // or a new one. A file without livePort keeps none, as before.
    const port = (v) => Number.isInteger(v) && v >= 1 && v <= 65535;
    return list.filter((h) => h && /^[0-9a-f]{32}$/.test(h.id) && /^[0-9a-f]{64}$/.test(h.key) && typeof h.host === 'string' && Number.isInteger(h.port) && typeof h.name === 'string'
      && (!h.ssh || (typeof h.ssh.user === 'string' && typeof h.ssh.host === 'string' && Number.isInteger(h.ssh.remotePort))))
      .map((h) => ({ ...h, livePort: port(h.livePort) || h.livePort === undefined ? h.livePort : 4317, liveGateway: port(h.liveGateway) ? h.liveGateway : 0, siteGateway: port(h.siteGateway) ? h.siteGateway : 0 }));
  }

  save() {
    if (this.readOnly) return this.log('paired computers file not saved: it could not be read at start');
    if (!this.hosts.length) {
      fs.rmSync(this.file, { force: true });
      return;
    }
    writeAtomic(this.file, JSON.stringify({ hosts: this.hosts }, null, 2), { mode: 0o600 });
  }

  // Opens every saved computer's addresses and starts checking its link.
  async start() {
    for (const h of this.hosts) await this.open(h);
  }

  find(name) {
    const n = String(name || '').toLowerCase();
    return this.hosts.find((h) => h.name === n) || null;
  }

  // Where to connect: the computer itself, or the local end of its SSH tunnel.
  async target(h) {
    if (!h.ssh) return { host: h.host, port: h.port };
    let t = this.tunnels.get(h);
    if (!t) {
      t = new SshTunnel(h.ssh, this.log);
      this.tunnels.set(h, t);
    }
    return { host: '127.0.0.1', port: await t.ensure() };
  }

  // One TLS connection to the paired computer, for one purpose. -> Promise<socket>
  async dial(h, header, { key = Buffer.from(h.key, 'hex'), identity = h.id } = {}) {
    const to = await this.target(h);
    const tunnel = h.ssh ? this.tunnels.get(h) : null;
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        ...wire.TLS,
        host: to.host,
        port: to.port,
        // "localhost" can resolve to ::1 first (Node 18) while the other end listens on IPv4: try both.
        autoSelectFamily: true,
        // The link is authenticated by the pairing key, not a certificate.
        checkServerIdentity: () => undefined,
        pskCallback: () => ({ psk: key, identity }),
      });
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error('no answer'), { code: 'ETIMEDOUT' })), DIAL_TIMEOUT_MS);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        wire.writeLine(socket, header);
        resolve(socket);
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        if (tunnel) tunnel.distrust();
        reject(err);
      });
    });
  }

  // A one-line request and its one-line response.
  async ask(h, header, opts, timeoutMs = DIAL_TIMEOUT_MS) {
    const socket = await this.dial(h, header, opts);
    try {
      return await wire.readHeader(socket, timeoutMs);
    } finally {
      socket.destroy();
    }
  }

  // `/editlens join <address> <code>`; `user@address` pairs through an SSH tunnel (opts: key,
  // sshPort). -> { ok, host } | { error }
  async join(addressText, codeText, opts = {}) {
    const text = String(addressText || '').trim();
    const at = text.lastIndexOf('@');
    const sshTarget = at > 0 ? parseSshTarget(text.replace(/:(\d{1,5})$/, '')) : null;
    if (at > 0 && !sshTarget) return { error: `"${text}" isn't an SSH login. Give it like root@203.0.113.5.` };
    const address = wire.parseAddress(at > 0 ? text.slice(at + 1) : text, this.defaultPort);
    if (!address) return { error: `"${text}" isn't an address. Give it like 203.0.113.5:${this.defaultPort}.` };
    const code = wire.normalizeCode(codeText);
    if (!code) return { error: 'That code is not complete. A code has 28 letters and digits in groups of four. Copy the whole line /editlens pair printed.' };
    let ssh = null;
    if (sshTarget) {
      const sshPort = opts.sshPort === undefined || opts.sshPort === null ? null : Number(opts.sshPort);
      if (sshPort !== null && !(Number.isInteger(sshPort) && sshPort > 0 && sshPort < 65536)) return { error: `"${opts.sshPort}" isn't a port.` };
      if (opts.key && !isFile(opts.key)) return { error: `The key file ${opts.key} doesn't exist.` };
      // Pairing the same login again: the key and SSH port given last time still apply.
      const before = this.hosts.find((x) => x.ssh && x.ssh.user === sshTarget.user && x.ssh.host === sshTarget.host);
      const key = opts.key || (before && before.ssh.key && isFile(before.ssh.key) ? before.ssh.key : null);
      ssh = { user: sshTarget.user, host: sshTarget.host, sshPort: sshPort === null && before ? before.ssh.sshPort || null : sshPort, key, remotePort: address.port, localPort: 0 };
    }
    const probe = { host: address.host, port: address.port, ssh };
    let answer;
    try {
      // keyPath: the key file's path (never its contents), so the other computer can fill it in
      // the ssh lines it prints for this computer.
      const keyPath = ssh ? wire.keyPath(ssh.key) : null;
      answer = await this.ask(probe, { t: 'join', protocol: wire.PROTOCOL, name: this.name, ...(this.machine ? { machine: this.machine } : {}), ...(keyPath ? { keyPath } : {}) }, { key: wire.codeKey(code), identity: wire.JOIN_ID });
    } catch (err) {
      const t = this.tunnels.get(probe);
      if (t) t.close();
      // Through SSH a closed pairing port there looks the same as a refused code.
      if (ssh && !isKeyRefused(err) && (err.code === 'ECONNRESET' || /disconnected|socket hang up/i.test(err.message))) {
        return { error: `the code was refused, or nothing listens on port ${address.port} on ${address.host} (run /editlens pair there; the code works for 10 minutes).` };
      }
      return { error: dialError(err, address, true) };
    }
    const fail = (error) => {
      const t = this.tunnels.get(probe);
      if (t) t.close();
      return { error };
    };
    if (!answer.ok) return fail(answer.error || 'the other computer refused');
    if (!/^[0-9a-f]{32}$/.test(answer.id) || !/^[0-9a-f]{64}$/.test(answer.key)) return fail('the other computer sent a pairing this version cannot read. Update EditLens on both.');
    // Pairing the same computer again replaces the old pairing; that computer is told, so it
    // doesn't keep listing a pairing (maybe for another project) that no longer connects. The same
    // computer: the same address, or (0.24.33 and later) the same id given at another address.
    const machine = typeof answer.machine === 'string' && /^[0-9a-f]{32}$/.test(answer.machine) ? answer.machine : null;
    for (const old of this.hosts.filter((x) => (x.host === address.host && x.port === address.port) || (machine && x.machine === machine))) {
      if (old.id !== answer.id && old.cwd !== answer.cwd) {
        try {
          await this.ask(old, { t: 'unpair' });
        } catch (err) {
          if (!(err instanceof Error)) throw err;
          this.log(`could not tell ${old.name} to remove the old pairing: ${err.message}`);
        }
      }
      await this.drop(old);
    }
    const h = {
      id: answer.id, key: answer.key, host: address.host, port: address.port,
      name: this.freeName(wire.cleanName(answer.name)), cwd: typeof answer.cwd === 'string' ? answer.cwd : '',
      livePort: Number.isInteger(answer.livePort) ? answer.livePort : 4317, version: String(answer.version || ''),
      created: Date.now(), liveGateway: 0, siteGateway: 0, ...(ssh ? { ssh } : {}), ...(machine ? { machine } : {}),
    };
    // The tunnel used for the join is used for the pairing.
    if (this.tunnels.has(probe)) this.tunnels.set(h, this.tunnels.get(probe));
    this.hosts.push(h);
    await this.open(h);
    this.save();
    this.log(`paired with ${h.name} (${h.host}:${h.port})`);
    return { ok: true, host: this.describe(h, { withKey: true }) };
  }

  // A key for one local address (kind 'site' or 'live', and its port), from this user's key file.
  token(kind, port) {
    if (!this.gwKey) this.gwKey = gatewayKey(this.keyFile);
    return crypto.createHmac('sha256', this.gwKey).update(`${kind}:${port}`).digest('hex').slice(0, 32);
  }

  // The cookie a browser keeps for one pairing's site address (cookies don't tell ports apart).
  cookieName(h) {
    return `editlens-gw-${h.siteGateway}`;
  }

  // A site request: null passes it; a first visit with the key sets the cookie (on both local
  // names, 127.0.0.1 and localhost, one after the other) and opens the address without the key.
  siteGate(h, req) {
    const want = this.token('site', h.siteGateway);
    const u = new URL(req.url, 'http://127.0.0.1');
    const given = u.searchParams.get(KEY_PARAM);
    if (given === null) {
      if (!sameKey(cookieOf(req, this.cookieName(h)), want)) return denied();
      return keepsKey(h.version) ? null : this.refusedOld(h, denied(oldText(h)));
    }
    if (!sameKey(given, want)) return denied();
    const here = /^localhost(:|$)/i.test(String(req.headers.host || '')) ? 'localhost' : '127.0.0.1';
    const to = u.searchParams.get(HOP_PARAM);
    u.searchParams.delete(KEY_PARAM);
    u.searchParams.delete(HOP_PARAM);
    const clean = u.pathname + u.search;
    let location;
    if (to === 'localhost' || to === '127.0.0.1') location = `http://${to}:${h.siteGateway}${clean}`;
    else location = `http://${here === 'localhost' ? '127.0.0.1' : 'localhost'}:${h.siteGateway}${clean}${clean.includes('?') ? '&' : '?'}${KEY_PARAM}=${want}&${HOP_PARAM}=${here}`;
    const cookie = `${this.cookieName(h)}=${want}; Path=/; HttpOnly; SameSite=Strict; Max-Age=34560000`;
    return { status: 302, headers: { location, 'set-cookie': cookie, 'cache-control': 'no-store', 'content-length': '0' } };
  }

  // A page request refused because the other computer runs EditLens older than 0.24.45: logged at
  // most once a minute for each pairing (a page sends many). -> answer, as given
  refusedOld(h, answer) {
    const now = Date.now();
    if (!this.oldLogged) this.oldLogged = new Map();
    if (now - (this.oldLogged.get(h.id) || 0) > 60000) {
      this.oldLogged.set(h.id, now);
      this.log(`refused a page request for ◆ ${h.name}: ${h.version ? `it runs EditLens ${h.version}` : 'its EditLens version is not known yet'}; it needs 0.24.45 or later`);
    }
    return answer;
  }

  // The page script's address through this pairing, with the live key in its path (the other
  // computer removes it there; an older one is refused in toLive).
  liveSrc(h) {
    return `127.0.0.1:${h.liveGateway}/gk-${this.token('live', h.liveGateway)}/live.js`;
  }

  freeName(base) {
    let name = base;
    for (let i = 2; this.find(name); i++) name = `${base}-${i}`;
    return name;
  }

  // The local addresses for one paired computer, on the same ports as last time when they're free
  // (so the page keeps its panel settings).
  async open(h) {
    const link = { live: null, site: null, timer: null, fails: 0, state: 'connecting', error: null, sockets: new Set() };
    this.links.set(h.id, link);
    link.live = await listenOn(h.liveGateway, net.createServer((local) => this.toLive(h, link, local)));
    const site = await startProxySafe({
      target: 'http://127.0.0.1:80', port: h.siteGateway, livePort: link.live.address().port, remoteLivePort: h.livePort,
      // version: the computer joined refuses a site link that names none, or an older one (D14).
      connect: () => this.dial(h, { t: 'site', version: require('../lib/config').version }), refuse: (s) => this.otherUser(s),
      gate: (req) => this.siteGate(h, req), liveSrc: () => this.liveSrc(h),
    });
    link.site = site;
    const changed = h.liveGateway !== link.live.address().port || h.siteGateway !== site.port;
    h.liveGateway = link.live.address().port;
    h.siteGateway = site.port;
    if (changed) this.save();
    this.check(h, link);
  }

  toLive(h, link, local) {
    if (this.otherUser(local)) return refused(local);
    link.sockets.add(local);
    local.on('close', () => link.sockets.delete(local));
    local.on('error', () => local.destroy());
    // The first request names the live key in its path (the page's requests), or comes with the
    // site cookie (a window this user opens, such as the answer window): it is sent to its address
    // with the key. Anything else is refused here; the other computer never gets it. The key is
    // needed whatever version the other computer runs: one older than 0.24.45 is refused (D14).
    return firstHead(local).then((head) => {
      if (!head) return refused(local, GATE_REFUSED);
      const text = head.toString('latin1');
      const line = /^([A-Z]+) (\/\S*) HTTP\/1\.[01]\r\n/.exec(text);
      const gk = `/gk-${this.token('live', h.liveGateway)}`;
      const keyed = Boolean(line && line[2].startsWith(gk + '/'));
      const cookie = sameKey(cookieOf({ headers: { cookie: headerOf(text, 'cookie') } }, this.cookieName(h)), this.token('site', h.siteGateway));
      if ((keyed || cookie) && !keepsKey(h.version)) return this.refusedOld(h, refused(local, oldText(h)));
      if (keyed) return this.passLive(h, link, local, head);
      if (line && cookie && line[1] === 'GET') {
        local.end(`HTTP/1.1 302 Found\r\nLocation: ${gk}${line[2]}\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        return undefined;
      }
      return refused(local, GATE_REFUSED);
    }).catch((err) => {
      // A request that can't be checked is refused, with a fixed line in the log (no request text).
      if (!(err instanceof Error)) throw err;
      this.log(`live address check failed (${err.code || err.name}); the connection was refused`);
      if (!local.destroyed) refused(local, GATE_REFUSED);
    });
  }

  passLive(h, link, local, head) {
    // The other computer accepts page requests only from this computer's two addresses for it.
    const origins = [h.siteGateway, h.liveGateway].filter((p) => p > 0).flatMap((p) => [`http://127.0.0.1:${p}`, `http://localhost:${p}`]);
    this.dial(h, { t: 'live', origins, version: require('../lib/config').version }).then((up) => {
      if (local.destroyed) return up.destroy();
      link.sockets.add(up);
      up.on('close', () => {
        link.sockets.delete(up);
        local.destroy();
      });
      up.on('error', () => up.destroy());
      local.on('close', () => up.destroy());
      if (head) up.write(head);
      up.pipe(local);
      local.pipe(up);
      local.resume();
      return undefined;
    }, (err) => {
      local.destroy();
      this.failed(h, link, err);
    });
  }

  // The health check: every 15 s while the computers are connected; after a failure, 1 s growing to 30 s.
  check(h, link) {
    clearTimeout(link.timer);
    if (this.links.get(h.id) !== link) return;
    // The site's address here, so the other computer can tell its user where the page opens.
    this.ask(h, { t: 'ping', ...(h.siteGateway ? { site: `http://localhost:${h.siteGateway}/` } : {}) }).then((a) => {
      if (!a.ok) throw new Error(a.error || 'refused');
      const version = String(a.version || h.version || '').slice(0, 40);
      // Kept for the next start, so an updated computer is not refused until its first check.
      if (version !== h.version) {
        h.version = version;
        this.save();
        if (!keepsKey(version)) this.log(`◆ ${h.name} runs EditLens ${version || '(version unknown)'}: its page addresses here are refused until it is updated`);
      }
      h.site = Boolean(a.site);
      // Whether that computer lets this one answer its permission questions (its setting).
      const answers = a.answers === true;
      const changed = answers !== (h.answers === true);
      h.answers = answers;
      h.lastSeen = Date.now();
      link.fails = 0;
      link.error = null;
      this.setState(h, link, 'connected');
      if (changed) this.onChange(this.describe(h), 'answers');
      link.timer = setTimeout(() => this.check(h, link), PING_MS);
      link.timer.unref();
    }, (err) => {
      this.failed(h, link, err);
    });
  }

  failed(h, link, err) {
    if (this.links.get(h.id) !== link) return;
    link.fails++;
    link.error = dialError(err, h, false);
    // The other computer no longer has this pairing (unpaired there, or its files were reset).
    const refused = isKeyRefused(err);
    this.setState(h, link, refused && link.fails >= 3 ? 'refused' : 'reconnecting');
    clearTimeout(link.timer);
    if (link.state === 'refused') {
      link.timer = setTimeout(() => this.check(h, link), 60000);
    } else {
      link.timer = setTimeout(() => this.check(h, link), BACKOFF_MS[Math.min(link.fails - 1, BACKOFF_MS.length - 1)]);
    }
    link.timer.unref();
  }

  setState(h, link, state) {
    if (link.state === state) return;
    link.state = state;
    this.log(`pairing link to ${h.name}: ${state}${link.error ? ` (${link.error})` : ''}`);
    this.onChange(this.describe(h));
  }

  // withKey: also the site address with this user's key (keyUrl), for the commands this user runs;
  // never in what pages or the line above the prompt get.
  describe(h, { withKey = false } = {}) {
    const link = this.links.get(h.id) || {};
    return {
      ...(withKey && h.siteGateway ? { keyUrl: `http://127.0.0.1:${h.siteGateway}/?${KEY_PARAM}=${this.token('site', h.siteGateway)}` } : {}),
      name: h.name, address: h.ssh ? `${h.ssh.user}@${h.host} (through SSH)` : `${h.host}:${h.port}`, cwd: h.cwd, version: h.version || null,
      // How people name it in the agent details card: the SSH login, or the address it was joined at.
      login: h.ssh ? `${h.ssh.user}@${h.host}` : String(h.host || ''),
      state: link.state || 'off', error: link.error || null, lastSeen: h.lastSeen || null,
      url: h.siteGateway ? `http://127.0.0.1:${h.siteGateway}/` : null, site: h.site !== false, answers: h.answers === true,
      // Its EditLens window through the link, when it lets this computer answer its questions.
      answerUrl: h.answers === true && h.liveGateway ? `http://127.0.0.1:${h.liveGateway}/answer` : null,
    };
  }

  status(opts) {
    return { name: this.name, hosts: this.hosts.map((h) => this.describe(h, opts)) };
  }

  async closeLink(h) {
    const link = this.links.get(h.id);
    if (!link) return;
    this.links.delete(h.id);
    clearTimeout(link.timer);
    for (const s of link.sockets) s.destroy();
    if (link.live) await new Promise((r) => link.live.close(() => r()));
    if (link.site) await link.site.close();
    const t = this.tunnels.get(h);
    if (t) t.close();
    this.tunnels.delete(h);
  }

  async drop(h) {
    await this.closeLink(h);
    this.hosts = this.hosts.filter((x) => x !== h);
    this.save();
  }

  // `/editlens join off [name]`: tells the other computer too, when it can connect to it.
  async off(name) {
    const list = name ? [this.find(name)].filter(Boolean) : [...this.hosts];
    if (name && !list.length) return { error: `No paired computer is called "${name}".` };
    const out = [];
    for (const h of list) {
      let told = false;
      try {
        told = (await this.ask(h, { t: 'unpair' })).ok === true;
      } catch (err) {
        if (!(err instanceof Error)) throw err;
      }
      await this.drop(h);
      out.push({ name: h.name, told });
    }
    return { removed: out };
  }

  // The paired computer's tasks, for this computer's Claude (the live-page MCP tools).
  // body: { op: 'start' | 'check' | 'list' | 'send' | 'stop' | 'merge', ... } -> its response | { error }
  async task(name, body) {
    const h = name ? this.find(name) : this.hosts.length === 1 ? this.hosts[0] : null;
    if (!h) return { error: this.hosts.length ? `Name the computer: ${this.hosts.map((x) => x.name).join(', ')}.` : 'This computer is not paired with another one. On the other computer run /editlens pair, then type the line it prints here.' };
    try {
      const socket = await this.dial(h, { t: 'task' });
      try {
        wire.writeLine(socket, body);
        return await wire.readHeader(socket, TASK_WAIT_MS, wire.BODY_MAX);
      } finally {
        socket.destroy();
      }
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (err.message === 'closed') {
        // Mostly EditLens there restarting (an update, or Claude Code restarted); only a version
        // known to differ is named as the cause.
        const mine = require('../lib/config').version;
        return { error: h.version && h.version !== mine
          ? `${h.name} closed the connection. It runs EditLens ${h.version} and this computer ${mine}: update both to the same version, then try again.`
          : `${h.name} closed the connection: EditLens there was probably restarting (an update or a restart of Claude Code there). Try again in a moment.` };
      }
      return { error: `Can't connect to ${h.name}: ${dialError(err, h, false)}` };
    }
  }

  // Restore or undo an edit made on that computer (server/remote-restore.js), on the task channel.
  // -> { answer } | { down: true } (not connected) | { old: true } (its EditLens has no such request)
  async editRestore(name, body) {
    const h = name ? this.find(name) : this.hosts.length === 1 ? this.hosts[0] : null;
    const link = h ? this.links.get(h.id) : null;
    // Known to be down: say so immediately instead of after a connection timeout.
    if (!h || !link || link.state === 'reconnecting' || link.state === 'refused') return { down: true };
    let answer;
    try {
      const socket = await this.dial(h, { t: 'task' });
      try {
        wire.writeLine(socket, body);
        answer = await wire.readHeader(socket, RESTORE_WAIT_MS, wire.BODY_MAX);
      } finally {
        socket.destroy();
      }
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      this.log(`restore on ${h.name}: ${dialError(err, h, false)}`);
      return { down: true };
    }
    if (answer && typeof answer.error === 'string' && /^Unknown op/.test(answer.error)) return { old: true };
    return { answer };
  }

  // `/editlens control <name> [new]` and `/editlens manual <name>`: run on that computer.
  async control(name, args) {
    const h = this.find(name);
    if (!h) return { error: `No paired computer is called "${name}". /editlens join lists them.` };
    try {
      const a = await this.ask(h, { t: 'control', args }, undefined, CONTROL_WAIT_MS);
      return { ok: a.ok === true, text: String(a.text || '') };
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      return { error: dialError(err, h, false) };
    }
  }

  async close() {
    for (const h of this.hosts) await this.closeLink(h);
  }
}

// 0.24.45 and later remove the live key from the addresses that come through the link (server.js).
// A part too large to be a whole number is not a version.
function keepsKey(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version || ''));
  if (!m) return false;
  const [a, b, c] = m.slice(1).map(Number);
  if (![a, b, c].every(Number.isSafeInteger)) return false;
  return a > 0 || b > 24 || (b === 24 && c >= 45);
}

// Two keys compared in constant time. The byte lengths are compared first: a character outside
// ASCII has more bytes than one, and timingSafeEqual throws for buffers of different lengths.
function sameKey(sent, want) {
  if (typeof sent !== 'string' || typeof want !== 'string') return false;
  const a = Buffer.from(sent);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function denied(text = GATE_REFUSED) {
  return { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }, body: text };
}

// What this user sees at a paired computer's addresses when it runs EditLens older than 0.24.45
// (or a version that can't be read): it has no gateway key, so its page is refused here (D14).
function oldText(h) {
  return updateText(h && h.name);
}

// The update line for a computer that runs EditLens older than 0.24.45, by its name when known.
function updateText(name) {
  return `Update EditLens on ${name ? '◆ ' + name : 'the other computer'} (0.24.45 or later), then reload this page.`;
}

// One cookie's value from a request's Cookie header, or null.
function cookieOf(req, name) {
  for (const part of String((req.headers && req.headers.cookie) || '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

// A header's value from raw request text (its first line and headers), or ''.
function headerOf(text, name) {
  const m = new RegExp(`\r\n${name}:[ \t]*([^\r\n]*)`, 'i').exec(text);
  return m ? m[1] : '';
}

// A connection's first request line and headers (up to the empty line), or null when they don't
// arrive in 10 s or are larger than HEAD_MAX. The connection is paused after them.
function firstHead(socket) {
  return new Promise((resolve) => {
    const parts = [];
    let size = 0;
    const finish = (value) => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('close', onClose);
      socket.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      parts.push(chunk);
      size += chunk.length;
      const all = Buffer.concat(parts, size);
      if (all.indexOf('\r\n\r\n') >= 0) return finish(all);
      if (size > HEAD_MAX) return finish(null);
      return undefined;
    };
    const onClose = () => finish(null);
    const timer = setTimeout(() => finish(null), 10000);
    socket.on('data', onData);
    socket.on('close', onClose);
    socket.resume();
  });
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(err.code)) return false;
    throw err;
  }
}

function listenOn(port, server) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && p !== 0) return tryPort(0);
        return reject(err);
      });
      server.listen(p, '127.0.0.1', () => {
        server.removeAllListeners('error');
        resolve(server);
      });
    };
    tryPort(Number.isInteger(port) && port > 0 ? port : 0);
  });
}

async function startProxySafe(opts) {
  try {
    return await startProxy(opts);
  } catch (err) {
    if (err.code !== 'EADDRINUSE' || !opts.port) throw err;
    return startProxy({ ...opts, port: 0 });
  }
}

function isKeyRefused(err) {
  const m = String((err && (err.code || '')) + ' ' + (err && err.message)).toLowerCase();
  return /decrypt|handshake|unknown_psk|bad_record_mac|alert/.test(m);
}

// Plain words for why this computer can't connect to the other one.
function dialError(err, address, joining) {
  const where = `${address.host}:${address.port}`;
  const code = err && err.code;
  if (code === 'ECONNREFUSED') return joining ? `no server is running at ${where}. Run /editlens pair there first (the code works for 10 minutes).` : `${where} is not responding (EditLens there is stopped, or its pairing port is closed).`;
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `Can't connect to ${where}. Check the address, and that port ${address.port} is open in its firewall.`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `the name ${address.host} can't be found.`;
  if (code === 'ECONNRESET' && joining) return 'the code was refused: it was wrong, already used or expired. Run /editlens pair there for a new one.';
  if (isKeyRefused(err)) return joining ? 'the code was refused: it was wrong, already used or expired. Run /editlens pair there for a new one.' : 'the other computer no longer accepts this pairing. Pair again: /editlens pair there, then the join line here.';
  return (err && (err.code || err.message)) || 'unknown error';
}

module.exports = { PairRemotes, dialError, isKeyRefused, keepsKey, sameKey, updateText };
