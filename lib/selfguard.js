'use strict';
// Claude must not call EditLens's own approval and control endpoints, or read its keys, with a
// command or a fetch: those are only for the user's EditLens window and panel. Checked by the
// PreToolUse hook (Bash, PowerShell, WebFetch) and in page control and tasks. A pattern check only:
// it stops a plain curl or fetch, not a disguised one. The real protection is that Allow needs the
// EditLens window's key (server/answer.js), and Claude Code asks about commands anyway.
const fs = require('fs');
const path = require('path');

// Loopback in any spelling: 127.0.0.1, the short forms 127.1 and 127.0.1, octal 0177.0.0.1,
// hex, decimal, ::1 and the IPv4-mapped ::ffff:127.0.0.1 / ::ffff:7f00:1.
const LOCAL = /(localhost|\b127(\.\d{1,3}){1,3}\b|\b0177(\.0+){0,2}\.0*1\b|0\.0\.0\.0|\[?::1\]?|::ffff:(127\.|7f)|0x7f0{0,6}1\b|\b2130706433\b)/i;
// On an EditLens port only these two may be read: every other route (new ones too) is denied.
const OPEN_PATHS = new Set(['/health', '/live.js']);
// A request that is not a plain GET: curl/wget flags, PowerShell -Method, fetch's method option.
const NOT_GET = /(^|\s)-X\s*(?!GET\b)\S|--request[=\s]+(?!GET\b)|(^|\s)-[dFT](?=\s|\S)|--(data[\w-]*|form[\w-]*|json|upload-file|post-data|post-file|method)\b|-Method\s+(?!Get\b)|\bmethod\s*:\s*(?!GET\b)/i;
// A key file is token-<port>, or gateway-key (the pairing addresses' and pages' keys, D11 and D21).
const KEY_NAME = /token-\d{2,5}(?![\w.])|(^|[^\w-])gateway-key(?![\w.-])/;
const KEY_SAMPLES = ['token-4317', 'token-80', 'token-12345'];
const GLOB = /[*?[{]/;
// Shown in the chat as the reason a tool call was stopped: plain words, no "EditLens:" prefix.
const REASON = 'Claude can\'t call EditLens\'s own approval or control endpoints, or read its keys. Permission questions are answered by the user in the EditLens window or panel.';

// EditLens's ports on this computer: the live server, the pairing port and the local ends of
// paired links (pair-remote.json).
function editlensPorts({ stateDir, port, pairPort }) {
  const ports = new Set([port, pairPort].filter((p) => Number.isInteger(p) && p > 0));
  if (!stateDir) return [...ports];
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(path.join(stateDir, 'pair-remote.json'), 'utf8'));
  } catch (err) {
    if (!(err && (err.code === 'ENOENT' || err instanceof SyntaxError))) throw err;
  }
  for (const h of (data && Array.isArray(data.hosts) ? data.hosts : [])) {
    for (const p of [h && h.liveGateway, h && h.siteGateway]) if (Number.isInteger(p) && p > 0) ports.add(p);
  }
  return [...ports];
}

// One path part with * ? [...] {a,b} -> a RegExp for whole names, or null when it has none.
function globRe(part) {
  if (!GLOB.test(part)) return null;
  let out = '';
  for (let i = 0; i < part.length; i++) {
    const c = part[i];
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else if (c === '[') {
      const end = part.indexOf(']', i + 2);
      if (end < 0) out += '\\[';
      else {
        out += '[' + part.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else if (c === '{') {
      const end = part.indexOf('}', i);
      if (end < 0) out += '\\{';
      else {
        out += '(' + part.slice(i + 1, end).split(',').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*').replace(/\\\?/g, '.')).join('|') + ')';
        i = end;
      }
    } else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp('^' + out + '$');
  } catch (err) {
    if (err instanceof SyntaxError) return /^.*$/; // a pattern this can't parse counts as matching
    throw err;
  }
}

function globMatchesKey(part) {
  const re = globRe(part);
  return Boolean(re && KEY_SAMPLES.some((s) => re.test(s)));
}

// A path part that is, or may expand to, a key file name. Anywhere in a command a glob counts only
// with "tok" in it ("token-*", not "*.json").
function keyPart(part) {
  return KEY_NAME.test(part) || (/tok/i.test(part) && globMatchesKey(part));
}

// A word (a path, maybe with globs) that reads a key file: token-<port>, a token-* glob, or a glob
// under ~/.claude (or the state folder) that matches editlens/token-<port>.
function readsKey(word, stateDir) {
  const parts = word.split(/[\\/]+/);
  if (parts.some(keyPart)) return true;
  const after = (i) => parts.slice(i);
  // What follows a folder that may be editlens/: nothing (the folder itself, as for grep -r), or a
  // name or glob that may be a key file.
  const below = (rest) => !rest.length || rest[0] === '' || keyPart(rest[0]) || globMatchesKey(rest[0]);
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== '.claude') continue;
    const dir = parts[i + 1];
    if (dir === undefined || dir === '') continue;
    const re = globRe(dir);
    if (re && re.test('editlens') && below(after(i + 2))) return true;
    if (dir === 'editlens' && parts[i + 2] && below(after(i + 2))) return true;
  }
  if (stateDir) {
    const flat = word.replace(/\\/g, '/');
    const root = stateDir.replace(/\\/g, '/').replace(/\/+$/, '');
    if (flat.startsWith(root + '/')) {
      const rest = flat.slice(root.length + 1).split('/');
      if (rest[0] && below(rest)) return true;
    }
  }
  return false;
}

// True when the text calls an EditLens port on this computer for anything but GET /health or
// GET /live.js. "127.0.0.1:4318" alone (no scheme, no path) is an argument, as in /editlens join.
function callsPort(text, ports, webFetch) {
  if (!LOCAL.test(text)) return false;
  const flat = text.replace(/["'`]|\\(?=\S)/g, '');
  // Each simple command on its own: "tar -T list && curl …/health" is not a POST to /health.
  for (const part of flat.split(/&&|\|\||[;|\n]/)) {
    let open = false;
    for (const p of ports) {
      const re = new RegExp(`(://[^\\s/]*)?:${p}(?!\\d)([^\\s;|&)<>]*)`, 'g');
      let m;
      while ((m = re.exec(part))) {
        const url = m[2].split(/[?#]/)[0];
        if (!url && !m[1]) continue;
        if (!OPEN_PATHS.has(url)) return true;
        open = true;
      }
    }
    if (open && !webFetch && NOT_GET.test(part)) return true;
  }
  return false;
}

// -> reason | null. ports: editlensPorts(); a request to another port (the user's own app, which
// may have a /settings page) is allowed.
function selfCall(tool, input, { stateDir, ports = [] } = {}) {
  const i = input && typeof input === 'object' ? input : {};
  let text;
  if (tool === 'Bash' || tool === 'PowerShell') text = String(i.command || '');
  else if (tool === 'WebFetch') text = String(i.url || '');
  else return null;
  const words = text.split(/[\s"'`=;|&()<>]+/).filter(Boolean);
  if (words.some((w) => readsKey(w, stateDir))) return REASON;
  return callsPort(text, ports, tool === 'WebFetch') ? REASON : null;
}

// /editlens new makes a file in the user's folder, so only the user may run it. Detects a command
// that runs EditLens's start.js (or the launcher) with "new". -> true for Bash and PowerShell
const NEW_REASON = 'Only the user can make an EditLens starter page. If they want one, tell them to type /editlens new themselves.';
function startsNew(tool, input) {
  if (tool !== 'Bash' && tool !== 'PowerShell') return false;
  const flat = String((input && input.command) || '').replace(/["'`]/g, ' ');
  return /\bstart\.js\s+new(?![\w.-])/i.test(flat) || /\bnode\s+(\S*[\\/])?start\s+new(?![\w.-])/i.test(flat);
}

module.exports = { selfCall, editlensPorts, startsNew, REASON, NEW_REASON };
