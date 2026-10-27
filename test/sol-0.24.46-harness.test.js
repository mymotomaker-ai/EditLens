'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5410';
// Sol M13, M14, M15 (findings-0.24.46-sol-part1.md): test cleanup signals only a server the test
// started, test/isolate.js keeps an inherited path only when it is inside the run's own private folder,
// and the e2e scripts are isolated too (the real signed-in Claude only with EDITLENS_E2E_REAL_CLAUDE=1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ISOLATE_PATHS } = require('./isolate');

const ISOLATE = path.join(__dirname, 'isolate.js');
// The paths test/isolate.js chooses in a child, printed as JSON.
const SHOW = `require(${JSON.stringify(ISOLATE)}); process.stdout.write(JSON.stringify(process.env))`;

test('M13: no test script signals a pid itself; it uses test/kill.js, which checks whose process it is', () => {
  const problems = [];
  for (const f of fs.readdirSync(__dirname).filter((n) => n.endsWith('.js') && n !== 'kill.js').sort()) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    // process.kill(pid, 0) only asks whether the process is there.
    for (const m of src.matchAll(/\bprocess\.kill\(([^,()]+(?:\([^()]*\))?)(?:,\s*([^)]+))?\)/g)) {
      if ((m[2] || '').trim() !== '0') problems.push(`${f}:${src.slice(0, m.index).split('\n').length}: ${m[0]}`);
    }
  }
  assert.deepStrictEqual(problems, []);
  // The server test/session-port.test.js starts is stopped only when it started it, and by killServer.
  const src = fs.readFileSync(path.join(__dirname, 'session-port.test.js'), 'utf8');
  assert.match(src, /if \(r\.started === true && Number\.isInteger\(r\.pid\)\) killServer\(r\.pid, f\.state\)/);
});

test('M14: a folder of this user made in the temporary folder after the run started is not kept', () => {
  // A new run whose first process starts a child with a folder another program made meanwhile.
  const env = { ...process.env };
  delete env.EDITLENS_ISOLATE_RUN;
  for (const k of ISOLATE_PATHS) delete env[k];
  const first = `require(${JSON.stringify(ISOLATE)});
    const fs = require('fs'), os = require('os'), path = require('path');
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-other-program-'));
    fs.mkdirSync(path.join(other, 'state'));
    const r = require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(SHOW)}],
      { env: { ...process.env, CLAUDE_CONFIG_DIR: other, EDITLENS_STATE_DIR: path.join(other, 'state') }, encoding: 'utf8' });
    fs.rmSync(other, { recursive: true, force: true });
    process.stdout.write(JSON.stringify({ other, child: r.stdout ? JSON.parse(r.stdout) : r.stderr }));`;
  const r = spawnSync(process.execPath, ['-e', first], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const { other, child } = JSON.parse(r.stdout);
  assert.notStrictEqual(child.CLAUDE_CONFIG_DIR, other, 'another program\'s Claude settings folder');
  assert.ok(child.CLAUDE_CONFIG_DIR.includes('editlens-isolate-'), child.CLAUDE_CONFIG_DIR);
  assert.notStrictEqual(child.EDITLENS_STATE_DIR, path.join(other, 'state'));
});

test('M14: a folder made inside the run\'s private folder (isolate\'s tempInRun) is kept', () => {
  const { tempInRun } = require('./isolate');
  const own = tempInRun('editlens-m14-');
  const run = process.env.EDITLENS_ISOLATE_RUN;
  assert.ok(path.relative(run, own) && !path.relative(run, own).startsWith('..'), `${own} is in ${run}`);
  fs.mkdirSync(path.join(own, 'state'));
  try {
    const r = spawnSync(process.execPath, ['-e', SHOW], { env: { ...process.env, CLAUDE_CONFIG_DIR: own, EDITLENS_STATE_DIR: path.join(own, 'state') }, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const child = JSON.parse(r.stdout);
    assert.strictEqual(child.CLAUDE_CONFIG_DIR, own);
    assert.strictEqual(child.EDITLENS_STATE_DIR, path.join(own, 'state'));
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
  // The run folder is private: a run folder others can open is not used.
  const st = fs.statSync(run);
  assert.strictEqual(st.mode & 0o077, 0, (st.mode & 0o777).toString(8));
});

const E2E = fs.readdirSync(__dirname).filter((f) => /^e2e-[\w-]+\.js$/.test(f)).sort();
// The e2e scripts that run the real signed-in Claude (the others use none).
const REAL = ['e2e-chat.js', 'e2e-demo.js', 'e2e-drive.js', 'e2e-guard.js', 'e2e-modes.js', 'e2e-team.js'];

test('M15: every e2e script loads test/isolate.js first', () => {
  assert.deepStrictEqual(E2E, ['e2e-chat.js', 'e2e-connect.js', 'e2e-demo.js', 'e2e-drive.js', 'e2e-guard.js', 'e2e-modes.js', 'e2e-team.js']);
  const missing = E2E.filter((f) => !/^#!\/usr\/bin\/env node\n'use strict';\nrequire\('\.\/isolate'\);\n/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));
  assert.deepStrictEqual(missing, []);
});

test('M15: an e2e script that runs the real Claude refuses to start without EDITLENS_E2E_REAL_CLAUDE=1', () => {
  const asks = (f) => /\nconst \{ needRealClaude \} = require\('\.\/isolate'\);\nneedRealClaude\(\);\n/.test(fs.readFileSync(path.join(__dirname, f), 'utf8'));
  assert.deepStrictEqual(REAL.filter((f) => !asks(f)), [], 'each calls needRealClaude() before anything else');
  assert.strictEqual(asks('e2e-connect.js'), false, 'e2e-connect.js runs no Claude');
  const env = { ...process.env };
  delete env.EDITLENS_E2E_REAL_CLAUDE;
  for (const f of REAL) {
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], { env, encoding: 'utf8', timeout: 20000 });
    assert.strictEqual(r.status, 2, `${f}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /EDITLENS_E2E_REAL_CLAUDE=1/, f);
  }
});

test('M15: EDITLENS_E2E_REAL_CLAUDE=1 keeps the real Claude settings and program only for a test/e2e-*.js script', () => {
  const { realClaudeAllowed } = require('./isolate');
  const on = { EDITLENS_E2E_REAL_CLAUDE: '1' };
  assert.strictEqual(realClaudeAllowed(on, path.join(__dirname, 'e2e-guard.js')), true);
  assert.strictEqual(realClaudeAllowed({}, path.join(__dirname, 'e2e-guard.js')), false);
  assert.strictEqual(realClaudeAllowed({ EDITLENS_E2E_REAL_CLAUDE: 'yes' }, path.join(__dirname, 'e2e-guard.js')), false);
  assert.strictEqual(realClaudeAllowed(on, path.join(__dirname, 'ports.test.js')), false);
  assert.strictEqual(realClaudeAllowed(on, path.join(os.tmpdir(), 'e2e-guard.js')), false, 'only this folder\'s scripts');
  assert.strictEqual(realClaudeAllowed(on, undefined), false, 'node -e');
  // Any other test started with the opt-in in its environment is still isolated.
  const real = path.join(os.homedir(), '.claude');
  const r = spawnSync(process.execPath, ['-e', SHOW], { env: { ...process.env, ...on, CLAUDE_CONFIG_DIR: real }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).CLAUDE_CONFIG_DIR.includes('editlens-isolate-'));
});
