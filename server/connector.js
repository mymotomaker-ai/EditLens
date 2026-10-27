'use strict';
// Connects a project's page without changing its files: Vite runs with a wrapper config
// (lib/connect.js); anything else gets a proxy (server/proxy.js). What it starts stops on
// disconnect, when the connecting session ends, or with the server.

const dns = require('dns');
const fs = require('fs');
const net = require('net');
const { plainError } = require('../lib/plainerr');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { detect, writeViteWrapper, rememberApp, rememberTarget, probe, runCommand } = require('../lib/connect');
const { normalize } = require('../lib/paths');
const { startProxy } = require('./proxy');
const { nearbyApps, noAppText } = require('../lib/starter');

// C:\proj, c:\proj and C:/proj are one project: one connection.
function keyOf(dir) {
  return normalize(path.resolve(dir));
}

const START_TIMEOUT_MS = 60000;
const LOG_LINES = 40;

function stripAnsi(s) {
  return String(s).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

// Waits up to ms while something still listens on the port, at 127.0.0.1 or at any loopback
// address of localhost (Vite listens on localhost, which is ::1 first on many computers).
async function portFree(port, ms) {
  const hosts = await loopbackHosts();
  const end = Date.now() + ms;
  while (Date.now() < end && (await Promise.all(hosts.map((h) => listening(h, port, 300)))).some(Boolean)) {
    await new Promise((r) => setTimeout(r, 200));
  }
}

// Lookup errors that mean only "no address for this name".
const DNS_FAILED = new Set(['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'EAI_FAIL', 'ESERVFAIL', 'ETIMEOUT', 'ECONNREFUSED', 'EREFUSED']);

// 127.0.0.1 and the loopback addresses localhost has on this computer.
async function loopbackHosts() {
  const hosts = new Set(['127.0.0.1']);
  try {
    for (const a of await dns.promises.lookup('localhost', { all: true })) {
      if (a.address === '::1' || a.address.startsWith('127.')) hosts.add(a.address);
    }
  } catch (err) {
    // localhost has no address here (no DNS answer): 127.0.0.1 alone.
    if (!err || !DNS_FAILED.has(err.code)) throw err;
  }
  return [...hosts];
}

// True when a connection to host:port opens within ms.
function listening(host, port, ms) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (yes) => {
      s.destroy();
      resolve(yes);
    };
    s.setTimeout(ms, () => done(false));
    s.on('connect', () => done(true));
    s.on('error', () => done(false));
  });
}

// "Local:   http://localhost:5174/" in Vite's output.
function localUrl(text) {
  const m = /Local:\s+(https?:\/\/[^\s]+)/.exec(stripAnsi(text));
  return m ? m[1] : null;
}

// A dev server's address as given ("3000" is not one: bin/start.js makes it http://localhost:3000).
// -> { url } with localhost as 127.0.0.1, or { error }
function parseTarget(target) {
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(target) ? target : `http://${target}`);
  } catch (err) {
    if (err instanceof TypeError) return { error: `"${target}" is not an address. Give it like http://localhost:3000.` };
    throw err;
  }
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(url.hostname)) return { error: 'Only a dev server on this computer (localhost) can be connected.' };
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return { url };
}

// The project's own proxy port, 4400-4899, from its folder.
function steadyPort(dir) {
  return 4400 + (parseInt(crypto.createHash('sha1').update(keyOf(dir)).digest('hex').slice(0, 6), 16) % 500);
}
function steadyPorts() {
  return process.env.EDITLENS_STEADY_PORTS !== 'off';
}
function portOf(url) {
  return Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
}

class Connector {
  constructor({ stateDir, livePort, pairPort, log, emit }) {
    this.stateDir = stateDir;
    this.livePort = livePort;
    // EditLens's other port: connecting to it would make EditLens a proxy for itself.
    this.pairPort = Number.isInteger(pairPort) ? pairPort : require('../lib/config').pairPort;
    this.log = log || (() => {});
    this.emit = emit || (() => {});
    this.items = new Map(); // project folder -> connection
  }

  list() {
    return [...this.items.values()].map((c) => this.describe(c));
  }

  describe(c) {
    return { cwd: c.cwd, kind: c.kind, url: c.url, target: c.target || null, sessionId: c.sessionId || null, startedAt: c.startedAt, state: c.state };
  }

  get(cwd) {
    return this.items.get(keyOf(cwd)) || null;
  }

  // -> { ok, kind, url, already } | { error, log }
  // port: the address's port before a restart (/editlens restart), tried first, so open pages keep it.
  async connect({ cwd, target, sessionId, port }) {
    const dir = path.resolve(cwd);
    const have = this.items.get(keyOf(dir));
    let asked = null;
    if (target) {
      const t = parseTarget(target);
      if (t.error) return { error: t.error };
      asked = t.url;
      const port = portOf(asked);
      if (port === this.livePort || port === this.pairPort) return { error: `Port ${port} is EditLens's own port, not your dev server. Give your dev server's port, like /editlens 5173.` };
      const own = [...this.items.values()].find((c) => c.url && /^https?:\/\//.test(c.url) && portOf(new URL(c.url)) === port && c.kind !== 'vite');
      if (own) return { error: `Port ${port} is the address EditLens gives your page (${own.url}), not your dev server. Give your dev server's port, like /editlens 5173.` };
    }
    // A different address from the one connected: the old connection stops and the new one starts.
    const sameTarget = !asked || (have && have.target === asked.origin);
    if (have && have.state === 'running' && sameTarget) return { ok: true, already: true, ...this.describe(have) };
    // Still starting (asked twice): wait for that start instead of starting over.
    if (have && have.state === 'starting' && have.ready && sameTarget) return have.ready.then((out) => (out.ok ? { ...out, already: true } : out));
    if (have) await this.disconnect(dir, 'replaced');
    const want = Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== this.livePort && port !== this.pairPort ? port : null;
    if (target) return this.startProxyFor(dir, target, sessionId, want);
    const found = detect(dir);
    if (found.kind === 'vite') return this.vite(dir, found, sessionId, want);
    if (found.kind === 'static') return this.startProxyFor(dir, null, sessionId, want);
    if (found.kind === 'none') {
      // Other options: an app in a nearby folder, or a starter page here (/editlens new, typed by the user).
      const apps = nearbyApps(dir, { stateDir: this.stateDir });
      return { error: noAppText(dir, apps), code: 'no-app', apps };
    }
    return { error: 'needs-url', kind: found.kind, framework: found.framework || null, devScript: found.devScript, command: runCommand(dir, found) };
  }

  // want: the port Vite had before a restart. Vite closing takes a moment, so its port is waited for
  // (up to 5 s); Vite takes the next port when it is still in use.
  vite(dir, found, sessionId, want = null) {
    if (!found.bin) return { error: 'Vite is not installed in this project yet. Run npm install (or your package manager) first.' };
    const config = writeViteWrapper(dir, this.stateDir, { port: this.livePort });
    const c = { cwd: dir, kind: 'vite', url: null, sessionId: sessionId || null, startedAt: Date.now(), state: 'starting', output: [], child: null };
    this.items.set(keyOf(dir), c);
    c.ready = (want ? portFree(want, 5000) : Promise.resolve()).then(() => {
      if (this.items.get(keyOf(dir)) !== c) return { error: 'Vite was stopped before it started.' };
      return this.viteStart(dir, found, c, config, want);
    });
    return c.ready;
  }

  viteStart(dir, found, c, config, want) {
    const child = spawn(process.execPath, [found.bin, '--config', config, ...(want ? ['--port', String(want)] : [])], {
      cwd: dir, env: { ...process.env, FORCE_COLOR: '0', EDITLENS_PORT: String(this.livePort) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    c.child = child;
    this.log(`connect: started Vite in ${dir} (pid ${child.pid})`);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (out) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(out);
      };
      const onData = (buf) => {
        const text = stripAnsi(buf.toString('utf8'));
        for (const line of text.split(/\r?\n/)) if (line.trim()) c.output.push(line);
        if (c.output.length > LOG_LINES) c.output.splice(0, c.output.length - LOG_LINES);
        const url = c.url || localUrl(text);
        if (url && !c.url) {
          c.url = url;
          c.state = 'running';
          this.emit({ type: 'connect', ...this.describe(c) });
          this.remember(dir);
          finish({ ok: true, ...this.describe(c) });
        }
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.on('error', (err) => {
        this.items.delete(keyOf(dir));
        finish({ error: `Vite could not start: ${plainError(err)}`, log: c.output.slice(-15) });
      });
      child.on('exit', (code, signal) => {
        const was = c.state;
        c.state = 'stopped';
        if (this.items.get(keyOf(dir)) === c) this.items.delete(keyOf(dir));
        this.log(`connect: Vite in ${dir} exited (${code === null ? signal : code})`);
        if (was === 'running') this.emit({ type: 'connect', ...this.describe(c) });
        finish({ error: `Vite stopped (exit ${code === null ? signal : code}).`, log: c.output.slice(-15) });
      });
      const timer = setTimeout(() => {
        this.disconnect(dir, 'timeout');
        finish({ error: 'Vite did not show its address within a minute.', log: c.output.slice(-15) });
      }, START_TIMEOUT_MS);
    });
  }

  // A dev server's address (target), or none for a plain site: then EditLens serves the folder.
  // A folder with an index.html is also served whenever nothing responds at the target.
  // Reserves the project's entry while its proxy starts, so a second /connect waits for this one
  // instead of starting a second proxy.
  startProxyFor(dir, target, sessionId, want = null) {
    const t = target ? parseTarget(target) : null;
    const slot = { cwd: dir, kind: target ? 'proxy' : 'static', url: null, target: t && t.url ? t.url.origin : null, sessionId: sessionId || null, startedAt: Date.now(), state: 'starting' };
    this.items.set(keyOf(dir), slot);
    slot.ready = this.proxy(dir, target, sessionId, slot, want).then((out) => {
      // Still the reserved entry (a started proxy replaces it): the start failed, so remove it.
      if (this.items.get(keyOf(dir)) === slot) this.items.delete(keyOf(dir));
      return out;
    }, (err) => {
      if (this.items.get(keyOf(dir)) === slot) this.items.delete(keyOf(dir));
      throw err;
    });
    return slot.ready;
  }

  async proxy(dir, target, sessionId, slot = null, want = null) {
    let url = null;
    const canServe = fs.existsSync(path.join(dir, 'index.html'));
    let fallback = false;
    let seen = null;
    if (target) {
      const t = parseTarget(target);
      if (t.error) return { error: t.error };
      url = t.url;
      seen = await probe(Number(url.port) || 80, 1500);
      // The check itself failed (a firewall rule, no permission): report that error.
      if (!seen.ok && seen.error) return { error: `Could not connect to ${url.origin}: ${seen.error}` };
      // Given as localhost (127.0.0.1 here) and found at ::1: the proxy goes there.
      if (seen.ok && seen.host === '::1' && url.hostname === '127.0.0.1') url.hostname = '[::1]';
      if (!seen.ok) {
        if (!canServe) return { error: 'nothing-answers', target: url.origin, command: runCommand(dir) };
        fallback = true;
      }
    }
    // The same address for a project each time (so the page keeps its panel settings), unless
    // that port is taken. EDITLENS_STEADY_PORTS=off: any free port (tests, which use fixed ports
    // in this range).
    let p = null;
    for (const port of [...(want ? [want] : []), ...(steadyPorts() && steadyPort(dir) !== want ? [steadyPort(dir)] : []), 0]) {
      try {
        p = await startProxy({
          target: url ? url.origin : null, port, livePort: this.livePort, root: dir, staticRoot: canServe ? dir : null,
          onFallback: () => this.log(`connect: no server is running at ${url.origin}; serving ${dir} itself`),
        });
        break;
      } catch (err) {
        if (!(err && err.code)) throw err;
        if (port === 0 || err.code !== 'EADDRINUSE') return { error: `The proxy could not start: ${err.code}` };
      }
    }
    // Disconnected while it started: stop this proxy too.
    if (slot && slot.state === 'stopped') {
      await p.close();
      return { error: 'The connection was stopped while it started.' };
    }
    const c = { cwd: dir, kind: url ? 'proxy' : 'static', url: p.url.replace(/\/$/, '') + ((url && url.pathname) || '/'), target: url ? url.origin : null, sessionId: sessionId || null, startedAt: Date.now(), state: 'running', proxy: p };
    this.items.set(keyOf(dir), c);
    this.log(url ? `connect: proxy ${p.url} -> ${url.origin} for ${dir}${fallback ? ' (no server is running there yet: serving the folder until one is)' : ''}` : `connect: serving ${dir} at ${p.url}`);
    this.emit({ type: 'connect', ...this.describe(c) });
    this.remember(dir);
    if (url && !fallback) this.keepTarget(dir, url.origin, seen.title);
    return { ok: true, fallback, ...this.describe(c) };
  }

  keepTarget(dir, origin, title) {
    try {
      rememberTarget(this.stateDir, dir, origin, { title });
    } catch (err) {
      if (!['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EBUSY'].includes(err.code)) throw err;
      this.log(`connect: could not save ${origin} for ${dir} (${err.code})`);
    }
  }

  // So a choice of apps (/editlens in a folder that has several) starts with this one.
  remember(dir) {
    try {
      rememberApp(this.stateDir, dir);
    } catch (err) {
      if (!['EACCES', 'EPERM', 'ENOSPC', 'EROFS', 'EBUSY'].includes(err.code)) throw err;
      this.log(`connect: could not save ${dir} as used last (${err.code})`);
    }
  }

  // -> { ok, stopped: n }
  async disconnect(cwd, why) {
    const dir = path.resolve(cwd);
    const c = this.items.get(keyOf(dir));
    if (!c) return { ok: true, stopped: 0 };
    this.items.delete(keyOf(dir));
    c.state = 'stopped';
    if (c.child && c.child.exitCode === null) c.child.kill();
    if (c.proxy) await c.proxy.close();
    this.log(`connect: disconnected ${dir} (${why || 'asked'})`);
    this.emit({ type: 'connect', ...this.describe(c) });
    return { ok: true, stopped: 1 };
  }

  // A Claude Code session ended: stop what it connected.
  async sessionEnded(sessionId) {
    let n = 0;
    for (const c of [...this.items.values()]) if (sessionId && c.sessionId === sessionId) n += (await this.disconnect(c.cwd, 'session ended')).stopped;
    return n;
  }

  async stopAll() {
    for (const c of [...this.items.values()]) await this.disconnect(c.cwd, 'server stopping');
  }

  // For an exit that can't wait.
  killAll() {
    for (const c of this.items.values()) if (c.child && c.child.exitCode === null) c.child.kill();
  }
}

// The wrapper configs are in the state folder; remove old ones (projects moved or deleted).
function cleanWrappers(stateDir, maxAgeMs = 30 * 86400000) {
  const dir = path.join(stateDir, 'connect');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const n of names) {
    if (!/^vite\.config\.[0-9a-f]{12}\.mjs$/.test(n)) continue;
    const f = path.join(dir, n);
    try {
      if (Date.now() - fs.statSync(f).mtimeMs > maxAgeMs) fs.unlinkSync(f);
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) throw err;
    }
  }
}

module.exports = { Connector, steadyPort, localUrl, stripAnsi, cleanWrappers, parseTarget };
