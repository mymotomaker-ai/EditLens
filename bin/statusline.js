#!/usr/bin/env node
'use strict';
// Optional status line that sends context/cost/limit numbers to EditLens (Claude Code only gives
// them to a status line, which a plugin can't set). SessionStart copies it to ~/.claude/editlens/
// because the plugin folder moves on update. Node built-ins only.
// `--then <cmd>` keeps an existing status line: its output is shown instead.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const POST_TIMEOUT_MS = 400;

// A port written only with digits, 1-65535, as lib/config.js strictInt reads it ("4705x",
// "1e3" don't count). -> the port or null
function strictPort(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,9}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= 65535 ? n : null;
}

const stateDir = process.env.EDITLENS_STATE_DIR || path.join(os.homedir(), '.claude', 'editlens');
// The status line runs from settings.json without the plugin's settings, so the Port setting
// comes from the file the plugin writes next to this script.
function savedPort() {
  try {
    return strictPort(fs.readFileSync(path.join(stateDir, 'port'), 'utf8')) || 4317;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') return 4317;
    throw err;
  }
}
// The port this Claude Code session started with (lib/config.js keptPort), so a Port setting
// changed since applies after a restart, as for the hooks. -> the port or null
function sessionPort(id) {
  if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id)) return null;
  try {
    return strictPort(fs.readFileSync(path.join(stateDir, 'session-ports', id), 'utf8'));
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM'].includes(err.code)) return null;
    throw err;
  }
}
let port = strictPort(process.env.EDITLENS_PORT) || savedPort();

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function token() {
  try {
    return fs.readFileSync(path.join(stateDir, `token-${port}`), 'utf8').trim();
  } catch (err) {
    if (err.code === 'ENOENT') return '';
    throw err;
  }
}

// Print the status line even if EditLens does not answer (or is not running).
function forward(raw) {
  return new Promise((resolve) => {
    // An incomplete response or one that never ends: false, so the line still prints (Sol M8).
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), POST_TIMEOUT_MS * 3);
    const req = http.request({
      host: '127.0.0.1', port, path: '/status', method: 'POST', timeout: POST_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw), 'x-editlens-token': token() },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => resolve(false));
      res.on('close', () => { if (!res.complete) resolve(false); });
      // -> 'page' (a page of this project listens), 'on' (EditLens runs) or false.
      res.on('end', () => {
        clearTimeout(deadline);
        if (res.statusCode !== 200) return resolve(false);
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          return resolve(j && Number.isInteger(j.pages) && j.pages > 0 ? 'page' : 'on');
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          return resolve('on');
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    // No server answers: report false so the status line still prints.
    req.on('error', () => {
      clearTimeout(deadline);
      resolve(false);
    });
    req.end(raw);
  });
}

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// Text from Claude Code shown on one line: no escape codes or line breaks, at most 60 characters.
function plainText(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').trim().slice(0, 60);
}

// Basic 16-colour ANSI only, so the line follows the terminal's own light or dark palette.
const C = { dim: '\u001b[2m', green: '\u001b[32m', yellow: '\u001b[33m', red: '\u001b[31m', claude: '\u001b[33m', off: '\u001b[0m' };
const paint = (color, text) => `${C[color]}${text}${C.off}`;

// "Opus 5.5  context ━━━━────── 41%  ·  5h 23%  ·  ✦ live". live: 'page', 'on' or false.
function line(data, live) {
  const parts = [];
  const model = data.model && typeof data.model === 'object' ? plainText(data.model.display_name) || null : null;
  const cw = data.context_window && typeof data.context_window === 'object' ? data.context_window : {};
  const used = finite(cw.used_percentage);
  if (used !== null) {
    const pct = Math.max(0, Math.min(100, Math.round(used)));
    const on = Math.round(pct / 10);
    const color = pct >= 80 ? 'red' : pct >= 50 ? 'yellow' : 'green';
    parts.push(`${paint('dim', 'context')} ${paint(color, '━'.repeat(on))}${paint('dim', '─'.repeat(10 - on))} ${pct}%`);
  }
  const rawFive = data.rate_limits && data.rate_limits.five_hour ? finite(data.rate_limits.five_hour.used_percentage) : null;
  const five = rawFive === null ? null : Math.max(0, Math.min(100, rawFive));
  if (five !== null) parts.push(`${paint('dim', '5h')} ${Math.round(five)}%`);
  // A negative or very large cost is invalid and not shown.
  const rawCost = data.cost ? finite(data.cost.total_cost_usd) : null;
  const cost = rawCost !== null && rawCost >= 0 && rawCost < 1e9 ? rawCost : null;
  if (cost !== null && five === null) parts.push(`$${cost.toFixed(2)}`);
  parts.push(live === 'page' ? `${paint('claude', '✦')} ${paint('green', 'live')}` : paint('dim', '✦ live'));
  return (model ? model + '  ' : '') + parts.join(paint('dim', '  ·  '));
}

// The status line after --then. One word: a quoted command line, run by the shell. Several words:
// the shell already split them, so they run as they are; on Windows a .cmd needs the shell, with
// each word quoted again.
function runThen(words, input) {
  const opts = { input, encoding: 'utf8', timeout: 5000, windowsHide: true };
  if (words.length === 1) return spawnSync(words[0], { ...opts, shell: true });
  const direct = spawnSync(words[0], words.slice(1), opts);
  if (!(direct.error && direct.error.code === 'ENOENT' && process.platform === 'win32')) return direct;
  return spawnSync(words.map((w) => (/[\s"]/.test(w) ? `"${w.replace(/"/g, '\\"')}"` : w)).join(' '), { ...opts, shell: true });
}

async function main() {
  const raw = await readStdin();
  let data = {};
  try {
    data = JSON.parse(raw);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
  }
  // null, a number or a list is not a status: treated as an empty one.
  if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
  if (!strictPort(process.env.EDITLENS_PORT)) port = sessionPort(data.session_id) || port;
  const live = raw.trim() ? await forward(raw) : false;
  const at = process.argv.indexOf('--then');
  if (at >= 0 && process.argv.length > at + 1) {
    const other = runThen(process.argv.slice(at + 1), raw);
    // EPIPE: the command ended without reading the status Claude Code sent (echo, or a missing command
    // run by the shell): its output and exit code below say how it went.
    const error = other.error && other.error.code !== 'EPIPE' ? other.error : null;
    const why = { ENOENT: 'the command was not found', ETIMEDOUT: 'it took more than 5 s', EACCES: 'it is not allowed to run' };
    if (error) process.stdout.write(`${line(data, live)} (status line after --then failed: ${why[error.code] || 'it stopped'})\n`);
    // A missing command run by the shell exits 127 with nothing printed: say so instead of a blank line.
    else if (other.status !== 0 && !String(other.stdout || '').trim()) process.stdout.write(`${line(data, live)} (status line after --then failed: exit ${other.status === null ? other.signal || 'unknown' : other.status})\n`);
    else process.stdout.write(other.stdout || '');
    return;
  }
  process.stdout.write(`${line(data, live)}\n`);
}

main().catch((err) => {
  // One line in place of the status line, saying what went wrong. This file runs as a standalone
  // copy, so it can't load lib/plainerr.js.
  const why = String((err && err.message) || err || '').split('\n')[0].replace(/^\w*Error:\s*/, '').trim();
  process.stdout.write(`✦ ✕ EditLens status line: ${why || 'it stopped'}\n`);
});
