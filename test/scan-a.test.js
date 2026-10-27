'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4920';
// Fixes from the 0.24.30 scan (findings-0.24.30.md), worker A: M1 (a hook-key report can't make
// the safety settings less strict by itself), approach 3 (reports only from this user's processes),
// L1 and approach 5 (413 is sent to the client; expected refusals log one line), L7 (page-control
// runs keyed by the normalized folder), L8 (the failure line names the step), L9 (only a missing
// pid file is quiet), L11 (wording).
const test = require('node:test');
const assert = require('node:assert');
const { killServer } = require('./kill');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { windowKey } = require('./answer-helper');
const settings = require('../lib/settings');

const ROOT = path.join(__dirname, '..');
const PORT = 4917;
const base = `http://127.0.0.1:${PORT}`;
const LINUX_ROOT = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;

async function waitFor(fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

// The environment without this machine's own plugin settings. CLAUDE_CONFIG_DIR stays test/isolate.js's
// empty folder, so no test reads the real settings.
function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('CLAUDE_PLUGIN_OPTION_')) env[k] = v;
  return { ...env, ...extra };
}

test('less strict settings are not taken from a report alone (M1, approach 3, L1)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-scan-a-'));
  const state = path.join(dir, 'state');
  const cfg = path.join(dir, 'claude');
  fs.mkdirSync(cfg);
  const settingsFile = path.join(cfg, 'settings.json');
  fs.writeFileSync(settingsFile, '{}');
  let out = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    env: cleanEnv({
      EDITLENS_PORT: String(PORT), EDITLENS_PAIR_PORT: String(PORT + 1), EDITLENS_STATE_DIR: state, CLAUDE_CONFIG_DIR: cfg,
      CLAUDE_PLUGIN_OPTION_REMOTE_TASKS: 'false', CLAUDE_PLUGIN_OPTION_SAFETY_CHECK: 'true', CLAUDE_PLUGIN_OPTION_PERMISSION_MODE: 'Ask',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const sleepers = [];
  t.after(() => {
    child.kill();
    for (const s of sleepers) s.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(await waitFor(async () => (await fetch(`${base}/health`)).ok), 'server up');
  const token = await waitFor(async () => fs.readFileSync(path.join(state, `token-${PORT}`), 'utf8').trim());
  const hook = { 'content-type': 'application/json', 'x-editlens-token': token };
  const report = (values, extra = {}) => fetch(`${base}/settings/report`, { method: 'POST', headers: hook, body: JSON.stringify({ values, pid: process.pid, ...extra }) });
  const now = async () => (await (await fetch(`${base}/settings`)).json()).values;
  const questions = async () => {
    const key = await windowKey(base);
    const headers = { 'content-type': 'application/json', 'x-editlens-answer': key, 'sec-fetch-site': 'same-origin' };
    return { headers, qs: (await (await fetch(`${base}/answer/list`, { headers })).json()).questions.filter((q) => q.kind === 'setting') };
  };

  // The scan's repro: the hook key alone tried to turn paired computers on and the safety check off.
  const loose = { remote_tasks: true, safety_check: false, permission_mode: "Don't ask" };
  assert.strictEqual((await report(loose)).status, 200);
  let v = await now();
  assert.strictEqual(v.remote_tasks, false, 'paired computers stay off');
  assert.strictEqual(v.safety_check, true, 'the safety check stays on');
  assert.strictEqual(v.permission_mode, 'Ask', 'the mode stays');
  let w = await questions();
  assert.deepStrictEqual(w.qs.map((q) => q.title).sort(), ['Let paired computers run Claude here', "Page control: use Don't ask", 'Turn off the safety check']);
  assert.ok(w.qs.every((q) => /not in Claude Code's saved settings/.test(q.note)));
  const summary = await (await fetch(`${base}/summary`)).json();
  assert.ok(summary.pairing.some((n) => /needs your answer/.test(n.text) && n.text.includes(`${base.replace('127.0.0.1', 'localhost')}/answer`)), 'a notice in Claude Code and on the page (the localhost address)');
  // The same report again (every prompt's hook sends one): no second request.
  await report(loose);
  assert.strictEqual((await questions()).qs.length, 3);
  // The page can't answer it: no window key.
  const sq = w.qs.find((q) => q.title === 'Turn off the safety check');
  assert.strictEqual((await fetch(`${base}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'setting', id: sq.id, decision: 'allow' }) })).status, 403);

  // Keep the current setting: stays off, not asked again for the same report. Allow: in effect.
  const rq = w.qs.find((q) => q.title === 'Let paired computers run Claude here');
  assert.strictEqual((await fetch(`${base}/answer`, { method: 'POST', headers: w.headers, body: JSON.stringify({ kind: 'setting', id: rq.id, decision: 'deny' }) })).status, 200);
  assert.strictEqual((await fetch(`${base}/answer`, { method: 'POST', headers: w.headers, body: JSON.stringify({ kind: 'setting', id: sq.id, decision: 'allow' }) })).status, 200);
  await report(loose);
  v = await now();
  assert.strictEqual(v.remote_tasks, false);
  assert.strictEqual(v.safety_check, false, 'allowed in the EditLens window');
  w = await questions();
  assert.deepStrictEqual(w.qs.map((q) => q.title), ["Page control: use Don't ask"]);

  // Saved in Claude Code's settings (what /config and the Settings pane do): in effect without a question.
  fs.writeFileSync(settingsFile, JSON.stringify({ pluginConfigs: { 'editlens@test': { options: { permission_mode: "Don't ask" } } } }));
  assert.ok(await waitFor(async () => (await now()).permission_mode === "Don't ask"), 'a held value saved in Claude Code takes effect');
  assert.strictEqual((await questions()).qs.length, 0);

  // Stricter values take effect immediately.
  await report({ remote_tasks: false, safety_check: true, permission_mode: 'Plan' });
  v = await now();
  assert.deepStrictEqual([v.remote_tasks, v.safety_check, v.permission_mode], [false, true, 'Plan']);
  fs.writeFileSync(settingsFile, JSON.stringify({ pluginConfigs: { 'editlens@test': { options: { remote_tasks: true, safety_check: 'false' } } } }));
  await report({ remote_tasks: true, safety_check: false, permission_mode: 'Plan' });
  v = await now();
  assert.deepStrictEqual([v.remote_tasks, v.safety_check], [true, false], 'saved values count immediately');
  assert.strictEqual((await questions()).qs.length, 0);
  // A hook's session or prompt event goes through the same check.
  await report({ remote_tasks: false, safety_check: true, permission_mode: 'Plan' });
  fs.writeFileSync(settingsFile, '{}');
  await fetch(`${base}/event`, { method: 'POST', headers: hook, body: JSON.stringify({ type: 'prompt', sessionId: 's1', cwd: dir, text: 'hi', settings: { remote_tasks: true, safety_check: true, permission_mode: 'Auto' } }) });
  v = await now();
  assert.deepStrictEqual([v.remote_tasks, v.permission_mode], [false, 'Plan'], 'not saved, so held (the default proves nothing)');

  // Approach 3: the reporting process must be this user's.
  assert.strictEqual((await report({ safety_check: true }, { pid: 'x' })).status, 400);
  assert.strictEqual((await report({ safety_check: true }, { pid: 0 })).status, 400);
  if (process.platform === 'linux') assert.strictEqual((await report({ safety_check: true }, { pid: 2 ** 30 })).status, 403, 'no such process');
  if (LINUX_ROOT) {
    const other = spawn('sleep', ['30'], { uid: 65534, gid: 65534, stdio: 'ignore' });
    sleepers.push(other);
    const res = await report({ safety_check: true }, { pid: other.pid });
    assert.strictEqual(res.status, 403);
    assert.match((await res.json()).error, /not running as this server's user/);
    // A connection from another user with the key is refused before the route.
    const r = spawnSync(process.execPath, ['-e', `fetch(${JSON.stringify(base + '/settings/report')}, { method: 'POST', headers: ${JSON.stringify(hook)}, body: '{"values":{}}' }).then((r) => console.log(r.status))`],
      { uid: 65534, gid: 65534, cwd: '/', encoding: 'utf8' });
    // That user may not be allowed to run this node (its folder is closed to others): no check then.
    if (r.error && ['EACCES', 'EPERM', 'ENOENT'].includes(r.error.code)) t.diagnostic(`another user can't run ${process.execPath}: ${r.error.code}`);
    else if (r.status !== 0 && /EACCES|permission denied/i.test(r.stderr || '')) t.diagnostic(`another user can't run ${process.execPath}: ${r.stderr.trim().split('\n')[0]}`);
    else {
      assert.ok(!r.error, r.error && r.error.message);
      assert.strictEqual((r.stdout || '').trim(), '403', r.stderr);
    }
  }

  // L1 and approach 5: a body over the limit gets its 413, and the log has one line, no stack.
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${base}/event`, { method: 'POST', headers: hook }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end(Buffer.alloc(7 * 1024 * 1024, 'a'));
  });
  assert.strictEqual(status, 413);
  await waitFor(async () => out.includes('request refused (413)'));
  assert.match(out, /request refused \(413\): POST \/event The request is too large\./);
  assert.ok(!/request failed/.test(out), 'no stack trace');
  assert.ok(!/\n\s+at /.test(out), 'no stack trace');
});

test('lessStrict and the saved settings (M1)', () => {
  assert.ok(settings.lessStrict('safety_check', true, false));
  assert.ok(!settings.lessStrict('safety_check', false, true));
  assert.ok(settings.lessStrict('remote_tasks', false, true));
  assert.ok(settings.lessStrict('task_account', 'Auto', 'Root (unsafe)'));
  assert.ok(settings.lessStrict('permission_mode', 'Ask', 'Auto'));
  assert.ok(settings.lessStrict('permission_mode', 'Auto', "Don't ask"));
  assert.ok(!settings.lessStrict('permission_mode', 'Auto', 'Plan'));
  assert.ok(!settings.lessStrict('theme', 'Auto', 'Dark'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-saved-'));
  try {
    assert.strictEqual(settings.savedOptions({ CLAUDE_CONFIG_DIR: dir }), null, 'no file');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ pluginConfigs: { 'editlens@a': { options: { safety_check: false, port: 'x' } }, 'other@a': { options: { remote_tasks: false } } } }));
    const saved = settings.savedOptions({ CLAUDE_CONFIG_DIR: dir });
    assert.deepStrictEqual(saved, { safety_check: [false] });
    assert.ok(settings.savedAs('safety_check', false, saved));
    assert.ok(!settings.savedAs('remote_tasks', true, saved), 'not saved: the default proves nothing');
    assert.ok(!settings.savedAs('permission_mode', "Don't ask", saved));
    assert.ok(!settings.savedAs('safety_check', false, null));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('page-control runs are kept per folder however it is spelled (L7)', () => {
  const pageRuns = require('../lib/pageruns');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-runs-'));
  const file = path.join(dir, 'page-control-last.json');
  try {
    // An entry an older version saved under the raw spelling.
    fs.writeFileSync(file, JSON.stringify({ 'C:\\Proj\\': { sessionId: 'a', at: 1 } }));
    assert.strictEqual(pageRuns.find(file, 'c:/proj').sessionId, 'a');
    pageRuns.remember(file, 'C:\\Proj', 'b', 2);
    pageRuns.remember(file, 'c:/proj/', 'c', 3);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepStrictEqual(Object.keys(data), ['c:/proj']);
    assert.strictEqual(pageRuns.find(file, 'C:\\PROJ').sessionId, 'c');
    assert.strictEqual(pageRuns.find(file, '/other'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/editlens stop remove names the step that failed (L8)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-l8-'));
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), '<body>\n<!-- editlens:start -->\n<script src="http://127.0.0.1:4317/live.js"></script>\n<!-- editlens:end -->\n</body>\n');
    const state = path.join(dir, 'state');
    fs.mkdirSync(state);
    fs.writeFileSync(path.join(state, 'backups'), 'not a folder'); // the copy before the change can't be kept
    const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'connect.js'), ...args], {
      cwd: dir, encoding: 'utf8', env: cleanEnv({ CLAUDE_PROJECT_DIR: dir, EDITLENS_STATE_DIR: state, EDITLENS_PORT: '4919' }),
    });
    const r = run('stop', 'remove');
    assert.strictEqual(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /Couldn't remove the EditLens lines/);
    assert.ok(!/Couldn't connect/.test(r.stdout + r.stderr));
    // The same for /editlens manual (bin/drive.js).
    const { failText } = require('../bin/drive');
    assert.strictEqual(failText('manual'), 'Couldn\'t switch to Manual');
    assert.strictEqual(failText(''), 'Couldn\'t start page control');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Manual says when the old auto-control.pid could not be removed (L9)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-l9-'));
  try {
    fs.mkdirSync(path.join(dir, 'auto-control.pid')); // a folder: unlink fails with EISDIR (EPERM on macOS)
    const run = () => spawnSync(process.execPath, ['-e', "require(process.argv[1]).cancelAutoControl().then(() => console.log('done'))", path.join(ROOT, 'bin', 'drive.js')], {
      encoding: 'utf8', env: cleanEnv({ EDITLENS_STATE_DIR: dir, EDITLENS_PORT: '4919' }),
    });
    let r = run();
    assert.match(r.stdout, /done/, r.stderr);
    assert.match(r.stderr, /could not remove the old .*auto-control\.pid: (EISDIR|EPERM)/);
    fs.rmdirSync(path.join(dir, 'auto-control.pid'));
    r = run();
    assert.match(r.stdout, /done/);
    assert.ok(!/auto-control\.pid/.test(r.stderr), 'a missing file is the usual case');
  } finally {
    // postJson started a server for this state folder: stopped by its pid.
    const h = await fetch('http://127.0.0.1:4919/health').then((res) => res.json(), () => null);
    if (h && Number.isInteger(h.pid)) killServer(h.pid, dir);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an incomplete pairing code says what a code is (L11)', async () => {
  const { PairRemotes } = require('../server/pair-remote');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-l11-'));
  try {
    const r = await new PairRemotes({ stateDir: dir, port: 4918 }).join('127.0.0.1:4918', 'wrong-code');
    assert.strictEqual(r.error, 'That code is not complete. A code has 28 letters and digits in groups of four. Copy the whole line /editlens pair printed.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('same pattern: pairing failures name the step; a version cache that cannot be written is not fatal', () => {
  const { failText } = require('../bin/pair');
  assert.strictEqual(failText(['pair']), "Couldn't start pairing");
  assert.strictEqual(failText(['pair', 'off']), "Couldn't turn pairing off");
  assert.strictEqual(failText(['join', 'root@host', 'CODE']), "Couldn't join");
  assert.strictEqual(failText(['join', 'off']), "Couldn't leave the paired computer");
  assert.strictEqual(failText(['join']), "Couldn't list the paired computers");
  assert.strictEqual(failText(['manual', 'vps']), "Couldn't switch to Manual");
  assert.strictEqual(failText(['control', 'vps']), "Couldn't start page control");

  const { claudeVersion } = require('../lib/versions');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'el-ver-'));
  try {
    // The state folder is a file: the cache write fails with a known code and the version is still returned.
    const notDir = path.join(dir, 'state');
    fs.writeFileSync(notDir, 'x');
    assert.strictEqual(claudeVersion(process.execPath, notDir), process.versions.node);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
