'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5520';
// Settings check SN6 (D21): where pages need the page key, every address /editlens prints for the
// user to open has it, not only the Page line: step 2 of "Open your page from your computer" (no
// browser here) and the EditLens window in /editlens task-user status. Linux only (the stand-ins).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-openkey-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><title>Site</title><p>hi</p>');
const children = new Set();
test.after(async () => {
  await Promise.all([...children].map((c) => new Promise((resolve) => {
    if (c.exitCode !== null) return resolve();
    c.once('exit', resolve);
    return c.kill();
  })));
  fs.rmSync(base, { recursive: true, force: true });
});

function request(port, method, urlPath, { body, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('close', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

async function waitFor(check, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// The environment of a command run on this server: no browser here, every connection's account unknown.
function envFor(port, dir, extra = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: project, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: dir, EDITLENS_TEST_PEER: 'unknown', EDITLENS_NO_BROWSER: '1', ...extra };
  for (const k of ['EDITLENS_SAY', 'CLAUDE_PLUGIN_OPTION_TASK_ACCOUNT']) if (!(k in extra)) delete env[k];
  return env;
}

function run(script, args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [...args.pre || [], path.join(__dirname, '..', 'bin', script), ...args.post || []], { env, timeout: 60000 }, (err, stdout) => resolve(String(stdout)));
  });
}

async function keyOf(port, dir) {
  const token = fs.readFileSync(path.join(dir, `token-${port}`), 'utf8');
  return JSON.parse((await request(port, 'GET', '/page-key', { headers: { 'x-editlens-token': token } })).text).key;
}

test('SN6: with no browser here, step 2 of "Open your page from your computer" has the page key', { skip: process.platform !== 'linux' && 'the account stand-in is Linux only' }, async () => {
  const dir = path.join(base, 'state-5520');
  const out = await run('start.js', {}, envFor(5520, dir, { CLAUDE_PLUGIN_OPTION_START: 'Connect the page', EDITLENS_TYPED: '1' }));
  try {
    const key = await keyOf(5520, dir);
    assert.match(String(key), /^[0-9a-f]{32}$/, out);
    assert.match(out, /Open your page from your computer/, out);
    assert.match(out, new RegExp(`Open http://localhost:\\d+/#editlens-key=${key} there`), out);
    // The same address in the terminal's Details row (the summary's openFrom).
    const token = fs.readFileSync(path.join(dir, 'token-5520'), 'utf8');
    const sum = JSON.parse((await request(5520, 'GET', `/summary?cwd=${encodeURIComponent(project)}`, { headers: { 'x-editlens-token': token } })).text);
    assert.ok(sum.openFrom && sum.openFrom.url, JSON.stringify(sum.openFrom));
    assert.match(sum.openFrom.url, new RegExp(`^http://localhost:\\d+/#editlens-key=${key}$`));
  } finally {
    const token = fs.readFileSync(path.join(dir, 'token-5520'), 'utf8');
    await request(5520, 'POST', '/shutdown', { body: { force: true }, headers: { 'x-editlens-token': token } });
  }
});

test('SN6: /editlens task-user status gives the EditLens window address with the page key', { skip: (process.platform !== 'linux' || process.getuid() !== 0) && 'runs as root on Linux only' }, async () => {
  const dir = path.join(base, 'state-5521');
  fs.mkdirSync(dir, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env: envFor(5521, dir), stdio: 'ignore' });
  children.add(server);
  assert.ok(await waitFor(async () => (await request(5521, 'GET', '/health')).status === 200), 'the server started');
  // A stand-in for the task account (no account is made): found, turned on, not signed in.
  const stub = path.join(base, 'task-account.js');
  fs.writeFileSync(stub, `const t = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'taskuser'))});\n`
    + `t.lookup = () => ({ home: ${JSON.stringify(base)}, uid: 1500, gid: 1500 });\nt.isOff = () => false;\n`);
  const out = await run('taskuser.js', { pre: ['-r', stub], post: ['status'] }, envFor(5521, dir, { CLAUDE_PLUGIN_OPTION_TASK_ACCOUNT: 'Root (unsafe)' }));
  const key = await keyOf(5521, dir);
  assert.match(String(key), /^[0-9a-f]{32}$/, out);
  assert.match(out, new RegExp(`Open http://localhost:5521/gk-${key}/answer there`), out);
});
