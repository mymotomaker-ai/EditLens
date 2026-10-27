'use strict';
// Tasks from a paired computer as a normal (non-root) account. When Claude Code runs as root on
// Linux and an "editlens" account exists, a sent project's task works in that account's home with
// its own Claude Code install and login. Normal Unix permissions limit what its commands can change
// (files that other accounts can write are not protected).
// Setup and undo: docs/pairing.md, "Tasks as a normal account".

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const NAME = 'editlens';
// Inside the account's home: the task workspaces, and the hooks' own folder (their key).
const WORKSPACES = 'editlens-workspaces';
const TASK_STATE = '.editlens-task';
// In the account's home when /editlens task-user made the account: "off" removes only such an account.
const MARKER = '.editlens-account';
const MADE_TEXT = 'Made by /editlens task-user.';
// In EditLens's state folder: "off" was used on an account made manually, which is kept but not used.
const OFF_FILE = 'task-user-off';

// Tests set EDITLENS_TEST_PASSWD (test/isolate.js) so they never use this computer's real account.
const PASSWD = process.env.EDITLENS_TEST_PASSWD || '/etc/passwd';

// The account's line in /etc/passwd -> { name, uid, gid, home, shell } | null
function lookup(name = NAME, passwd = PASSWD) {
  let text;
  try {
    text = fs.readFileSync(passwd, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'EACCES') return null;
    throw err;
  }
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f.length < 7 || f[0] !== name) continue;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    // Never root or a system account by another name.
    if (!Number.isSafeInteger(uid) || !Number.isSafeInteger(gid) || uid < 1000 || gid < 1) return null;
    if (!f[5] || !path.isAbsolute(f[5])) return null;
    return { name, uid, gid, home: f[5], shell: f[6] };
  }
  return null;
}

// Whether /editlens task-user made this account: its mark says so (an older version also marked
// an account made manually, with other words). Only a plain file counts, never a link.
function madeByEditLens(a) {
  const file = path.join(a.home, MARKER);
  try {
    if (!fs.lstatSync(file).isFile()) return false;
    return fs.readFileSync(file, 'utf8').startsWith(MADE_TEXT);
  } catch (err) {
    if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(err.code)) return false;
    throw err;
  }
}

function isOff(stateDir) {
  return typeof stateDir === 'string' && stateDir !== '' && fs.existsSync(path.join(stateDir, OFF_FILE));
}

// The account tasks run as, or null (run as this process's own user).
// -> { name, uid, gid, home, claude, workspaces, stateDir } | { error } | null
// An account that exists but isn't ready is an error, never a reason to run as root instead.
// stateDir: EditLens's state folder, where "off" for an account made manually is kept.
function account({ setting = 'Auto', platform = process.platform, uid = process.getuid ? process.getuid() : -1, passwd, stateDir } = {}) {
  // 'root': the user allowed Root (unsafe) in the EditLens window.
  if (setting === 'root' || platform !== 'linux' || uid !== 0 || isOff(stateDir)) return null;
  const a = lookup(NAME, passwd);
  if (!a) return null;
  const claude = path.join(a.home, '.local', 'bin', 'claude');
  if (!fs.existsSync(claude)) {
    return { error: `The ${NAME} account has no Claude Code yet. Install it as that account: runuser -l ${NAME} -c 'curl -fsSL https://claude.ai/install.sh | bash'` };
  }
  return { ...a, claude, workspaces: path.join(a.home, WORKSPACES), stateDir: path.join(a.home, TASK_STATE) };
}

// The only route the hooks' key may use: reporting a task's edits. Never Restore, /edits/* or
// anything else that writes files as the normal account.
function keyAllows(route) {
  return route === 'POST /event';
}

// A new file in the account's home, never through a link it made there (wx fails on any name that
// exists, a link included). -> true when written
function writeNew(file, text) {
  try {
    fs.writeFileSync(file, text, { mode: 0o644, flag: 'wx' });
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

// Runs a command as the account (runuser). Root never writes in the account's folders itself: the
// account could leave a link there that leads to a file of root's. As the account, a link leads
// only where the account can write anyway. A failure throws an error with code EACCOUNT.
function runAsSync(a, args, { input, run = spawnSync } = {}) {
  const r = run('runuser', ['-u', a.name, '--', ...args], { input, env: baseEnv(a, process.env), timeout: 120000, maxBuffer: 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw Object.assign(new Error(`${args[0]} as ${a.name}: ${String(r.stderr || '').trim().slice(0, 300)}`), { code: 'EACCOUNT' });
  return r;
}

// The same, without blocking the server. from: a stream piped to the command's input (tar -c's
// output). A command still running after timeoutMs is stopped. -> Promise<{ ok, out, err }>
const RUN_AS_MS = 15 * 60 * 1000;
function runAs(a, args, { input, from, timeoutMs = RUN_AS_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn('runuser', ['-u', a.name, '--', ...args], { env: baseEnv(a, process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, out: '', err: `${args[0]} as ${a.name} did not end in ${timeoutMs / 1000} s` });
    }, timeoutMs);
    deadline.unref();
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { if (out.length < 65536) out += c; });
    child.stderr.on('data', (c) => { if (err.length < 4096) err += c; });
    // EPIPE: the command ended before reading all of it; its exit code says why.
    child.stdin.on('error', (e) => { if (e.code !== 'EPIPE' && err.length < 4096) err += e.message; });
    child.on('error', (e) => {
      clearTimeout(deadline);
      resolve({ ok: false, out, err: e.code || e.message });
    });
    child.on('close', (code) => {
      clearTimeout(deadline);
      resolve({ ok: code === 0, out, err: err.trim().slice(0, 300) });
    });
    if (from) from.pipe(child.stdin);
    else child.stdin.end(input);
  });
}

// Copies the folder `from` (root's own) into the new folder `to` as the account: packed with tar
// as root, unpacked as the account. -> Promise<{ ok, err }> (runAs through module.exports, so a
// test that is not root can record it).
async function copyInAs(a, from, to) {
  const made = await module.exports.runAs(a, ['mkdir', '-m', '700', '--', to]);
  if (!made.ok) return made;
  const packed = spawn('tar', ['-c', '-C', from, '.'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const packErr = new Promise((resolve) => {
    packed.on('error', (e) => resolve(e.code || e.message));
    packed.on('close', (code) => resolve(code === 0 ? null : `tar exited with ${code}`));
  });
  const unpacked = await module.exports.runAs(a, ['tar', '-x', '--no-same-owner', '-C', to, '-f', '-'], { from: packed.stdout });
  const why = await packErr;
  if (why) return { ok: false, err: why };
  return unpacked;
}

// The folders tasks need, a copy of this plugin for the account's Claude (so the task's edits are
// reported), and the hooks' key, which can only report a task's edits (the server checks it),
// never the server's own key. Each is written as the account. -> { token, plugin }
const SKIP = ['node_modules', '.git', 'test'];
function prepare(a, { port, token, pluginRoot, run = spawnSync }) {
  runAsSync(a, ['mkdir', '-p', '-m', '700', '--', a.workspaces, a.stateDir], { run });
  const key = token || crypto.randomBytes(24).toString('hex');
  runAsSync(a, ['sh', '-c', 'umask 077 && cat > "$1"', 'sh', path.join(a.stateDir, `token-${port}`)], { input: key, run });
  const plugin = path.join(a.stateDir, 'plugin');
  runAsSync(a, ['rm', '-rf', '--', plugin], { run });
  if (pluginRoot) {
    // Packed as root (the account can't read root's copy), unpacked as the account.
    const packed = run('tar', ['-c', ...SKIP.map((n) => `--exclude=${n}`), '-C', pluginRoot, '.'], { maxBuffer: 512 * 1024 * 1024 });
    if (packed.error) throw packed.error;
    if (packed.status !== 0) throw Object.assign(new Error(`tar: ${String(packed.stderr || '').trim().slice(0, 300)}`), { code: 'EACCOUNT' });
    runAsSync(a, ['mkdir', '-m', '755', '--', plugin], { run });
    runAsSync(a, ['tar', '-x', '--no-same-owner', '-C', plugin, '-f', '-'], { input: packed.stdout, run });
  }
  return { token: key, plugin };
}

// What the account's processes may inherit from root's environment: what programs need to run,
// never a key, token or login of root's (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, GITHUB_TOKEN,
// cloud and database variables...). The account signs in to Claude with its own login.
const KEEP_ENV = /^(PATH|LANG|LANGUAGE|LC_[A-Z]+|TERM|COLORTERM|TZ|NO_COLOR|FORCE_COLOR|EDITLENS_[A-Z0-9_]+|CLAUDE_CODE_ENTRYPOINT|CLAUDE_AGENT_SDK_VERSION|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;
function keptEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (KEEP_ENV.test(k) && typeof v === 'string') out[k] = v;
  return out;
}

// The account's environment, built from that list (as the account would log in), plus its own
// HOME and names. extra: variables EditLens itself sets for one command (GIT_INDEX_FILE).
function baseEnv(a, env, extra) {
  return { ...keptEnv(env), HOME: a.home, USER: a.name, LOGNAME: a.name, SHELL: a.shell || '/bin/bash', ...(extra || {}) };
}

// What a task's Claude (and its hooks) gets in its environment as the account.
function envFor(a, env, port) {
  return {
    ...baseEnv(a, env),
    EDITLENS_STATE_DIR: a.stateDir, EDITLENS_PORT: String(port), EDITLENS_NO_START: '1', EDITLENS_TASK_ACCOUNT: '1',
  };
}

// For the Agent SDK's spawnClaudeCodeProcess: the task's Claude Code runs as the account.
function spawner(a, port, spawnFn = spawn) {
  return ({ command, args, cwd, env, signal }) => spawnFn('runuser', ['-u', a.name, '--', command, ...(args || [])], {
    cwd, env: envFor(a, env || {}, port), signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

module.exports = { NAME, WORKSPACES, TASK_STATE, MARKER, MADE_TEXT, OFF_FILE, madeByEditLens, isOff, keyAllows, lookup, account, writeNew, runAsSync, runAs, copyInAs, prepare, keptEnv, baseEnv, envFor, spawner };
