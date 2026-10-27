'use strict';
// Opening an EditLens page (a local address only) in the user's default browser, knowing first
// whether this computer can (a VPS you connect to through SSH can't), and what to tell the user then.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { related } = require('./paths');
const { plainError } = require('./plainerr');
const { keyPath, knownKey } = require('./pairwire');

// A program on PATH (an executable file). -> its path or null
function onPath(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? ['', ...String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';')] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        fs.accessSync(file, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch (err) {
        if (!['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG'].includes(err.code)) throw err;
      }
    }
  }
  return null;
}

function isWsl(env, platform) {
  if (platform !== 'linux') return false;
  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) return true;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
  } catch (err) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(err.code)) return false;
    throw err;
  }
}

// Can a page be opened in a browser on this computer's screen?
// -> { ok, why: null | 'off' | 'ssh' | 'no-display' | 'no-opener', cmd: [program, ...args before the url] }
function canOpenBrowser({ env = process.env, platform = process.platform, which = (n) => onPath(n, env, platform), wsl } = {}) {
  if (env.EDITLENS_NO_BROWSER === '1') return { ok: false, why: 'off', cmd: null };
  // Through SSH a browser started here opens on this computer (or runs slowly through X
  // forwarding), not on the user's screen, so the page is opened from their computer instead.
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return { ok: false, why: 'ssh', cmd: null };
  if (platform === 'win32') return { ok: true, why: null, cmd: ['cmd.exe', '/d', '/c', 'start', '""'] };
  if (platform === 'darwin') return { ok: true, why: null, cmd: ['open'] };
  if (wsl === undefined ? isWsl(env, platform) : wsl) {
    // WSL opens the page in Windows: no DISPLAY needed.
    if (which('wslview')) return { ok: true, why: null, cmd: ['wslview'] };
    if (which('explorer.exe')) return { ok: true, why: null, cmd: ['explorer.exe'] };
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return { ok: false, why: 'no-display', cmd: null };
  if (!which('xdg-open')) return { ok: false, why: 'no-opener', cmd: null };
  return { ok: true, why: null, cmd: ['xdg-open'] };
}

// Why no browser opens, in words for the user.
function noBrowserText(why) {
  if (why === 'ssh') return 'no browser here: you use this computer through SSH';
  if (why === 'no-display') return 'no browser here: this computer has no screen';
  if (why === 'no-opener') return 'no browser here: xdg-open is not installed';
  if (why === 'off') return 'no browser here: EDITLENS_NO_BROWSER=1';
  return 'no browser here';
}

// -> true when the browser was asked to open url. Never prints a raw system error.
function openBrowser(url, opts) {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):\d{2,5}\/[^\s"'&|^<>%]*$/.test(String(url))) return false;
  const can = canOpenBrowser(opts);
  if (!can.ok) return false;
  const [cmd, ...args] = can.cmd;
  try {
    const child = spawn(cmd, [...args, url], { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', (err) => process.stderr.write(`(couldn't open the browser: ${plainError(err)}; open the address yourself)\n`));
    child.unref();
    return true;
  } catch (err) {
    if (!err || !err.code) throw err;
    process.stderr.write(`(couldn't open the browser: ${plainError(err)}; open the address yourself)\n`);
    return false;
  }
}

// Two /editlens at the same time (the skill has no lock) would open two tabs: the first to open an address
// leaves a note in the state folder, and another within 15 s opens nothing. -> true when opened
const OPEN_AGAIN_MS = 15000;
function openOnce(url, stateDir, opts) {
  const ms = Number(process.env.EDITLENS_OPEN_AGAIN_MS); // tests use less
  const again = Number.isFinite(ms) && ms >= 0 ? ms : OPEN_AGAIN_MS;
  const note = path.join(stateDir, `opened-${require('crypto').createHash('sha1').update(String(url)).digest('hex').slice(0, 12)}`);
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(note, String(Date.now()), { flag: 'wx' });
      return openBrowser(url, opts);
    } catch (err) {
      if (!err || !err.code) throw err;
      if (err.code !== 'EEXIST') break; // no note can be written: open it anyway
    }
    let at = NaN;
    try {
      at = fs.statSync(note).mtimeMs;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (Number.isFinite(at) && Date.now() - at < again) return true; // the other one opened it
    fs.rmSync(note, { force: true });
  }
  return openBrowser(url, opts);
}

// http://127.0.0.1:4493/ -> http://localhost:4493/: the one address shown. Claude Code makes only
// localhost links clickable, and it is what the user opens through an SSH tunnel.
function shownUrl(url) {
  return typeof url === 'string' ? url.replace(/^http:\/\/(127\.0\.0\.1|\[::1\])(?=[:/]|$)/i, 'http://localhost') : url;
}

function portOf(url) {
  const m = /^https?:\/\/[^/]+:(\d{1,5})(?:\/|$)/.exec(String(url || ''));
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}

// What the user types in place of a key file EditLens doesn't know (their own words).
const KEY_PLACEHOLDER = '<path of your key file>';

// A key file's path as it can go inside double quotes on a line to copy, else the placeholder:
// a path that isn't one, or one with a quote or a character a shell would expand ($ ` %).
function shownKey(file) {
  const p = keyPath(file);
  return p && !/["$`%]/.test(p) ? p : KEY_PLACEHOLDER;
}

// The SSH line that opens this computer's page on the user's computer: forwards the page's port and
// the live server's (the panel loads from there). Never includes a key's contents.
// host: from SSH_CONNECTION, else this computer's address. key: omitted for the plain line; a key
// file's path, or null for the placeholder, for the line with -i "<key file>".
function sshLine({ ports, env = process.env, user, addresses = [], key }) {
  const parts = String(env.SSH_CONNECTION || '').trim().split(/\s+/);
  const viaSsh = parts.length === 4 ? parts[2] : '';
  const host = /^[0-9a-f.:]+$/i.test(viaSsh) ? viaSsh : addresses[0] || 'THIS-COMPUTER';
  const sshPort = parts.length === 4 ? Number(parts[3]) : NaN;
  // 'PORT': a port the user fills in (a dev server EditLens didn't start).
  const list = [...new Set(ports.filter((p) => p === 'PORT' || (Number.isInteger(p) && p > 0 && p < 65536)))];
  const fwd = list.map((p) => `-L ${p}:127.0.0.1:${p}`).join(' ');
  const portOpt = Number.isInteger(sshPort) && sshPort > 0 && sshPort !== 22 ? ` -p ${sshPort}` : '';
  const keyOpt = key === undefined ? '' : `-i "${shownKey(key)}" `;
  return `ssh ${keyOpt}${fwd}${portOpt} ${user || 'USER'}@${host}`;
}

// The EditLens window's address and, with no browser here, the two SSH lines that open it on the
// user's computer (plain, and with a key file). -> { url, ssh: null | line, sshKey: null | line }
function answerOpen({ port, browser = canOpenBrowser(), user, addresses, env, key = null }) {
  const url = `http://localhost:${port}/answer`;
  if (browser.ok) return { url, ssh: null, sshKey: null };
  const line = (k) => sshLine({ ports: [port], env, user, addresses, ...(k === undefined ? {} : { key: k }) });
  return { url, ssh: line(undefined), sshKey: line(key) };
}

// The EditLens window's address in one sentence, with both SSH lines when no browser opens here.
function answerAddress(opts) {
  const a = answerOpen(opts);
  return a.ssh ? `${a.url} (on your computer, after: ${a.ssh}, or with a key file: ${a.sshKey})` : a.url;
}

// How the user opens this folder's page when no browser opens here. -> null (a browser opens here)
// | { why, paired: { name, url, folder } } (the paired computer opens it)
// | { why, ssh, sshKey, url, other: { name, folder } | null }
// pairs: { name, cwd, url, connected, keyPath }[]. sshKey uses pairwire.js knownKey or the placeholder.
function openAdvice({ browser, cwd, pairs = [], pageUrl, livePort, env = process.env, user, addresses }) {
  if (!browser || browser.ok) return null;
  const mine = (pairs || []).find((p) => p && typeof p.cwd === 'string' && related(p.cwd, cwd));
  if (mine) return { why: browser.why, paired: { name: String(mine.name || ''), url: typeof mine.url === 'string' ? shownUrl(mine.url) : null, folder: path.basename(mine.cwd) } };
  // No address known (the app loads EditLens itself): the user fills in their dev server's port.
  const port = portOf(pageUrl) || 'PORT';
  const other = (pairs || []).find((p) => p && typeof p.cwd === 'string');
  const line = { ports: [port, livePort], env, user, addresses };
  return {
    why: browser.why,
    ssh: sshLine(line),
    sshKey: sshLine({ ...line, key: knownKey(pairs) }),
    url: `http://localhost:${port}/`,
    other: other ? { name: String(other.name || ''), folder: path.basename(other.cwd) } : null,
  };
}

module.exports = { answerAddress, answerOpen, canOpenBrowser, openBrowser, openOnce, noBrowserText, shownUrl, sshLine, shownKey, KEY_PLACEHOLDER, openAdvice, onPath, portOf };
