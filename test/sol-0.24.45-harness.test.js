'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5362';
// Sol M9, M10, M12, M13, L15, L16 (findings-0.24.45-sol.md): the test harness keeps tests away from
// this computer's real setup and from each other, and its scripts end and clean up when a step fails.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { ISOLATE_PATHS, tempInRun } = require('./isolate');

const ISOLATE = path.join(__dirname, 'isolate.js');
// In the run's private folder: a child that loads test/isolate.js keeps paths made here (Sol M14).
const base = tempInRun('editlens-harness-');
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

// The paths test/isolate.js chooses in a child started with `env`.
const SHOW = `require(${JSON.stringify(ISOLATE)}); process.stdout.write(JSON.stringify(process.env))`;
function chosen(env) {
  const r = spawnSync(process.execPath, ['-e', SHOW], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('M9: a path set before isolate is not kept when its last link leads to the real setup', () => {
  // Links this run made to real files and folders, only named: isolate reads and writes nothing there.
  const links = path.join(base, 'links');
  fs.mkdirSync(path.join(links, 'bin'), { recursive: true });
  fs.symlinkSync('/etc/passwd', path.join(links, 'passwd'));
  fs.symlinkSync(path.join(os.homedir(), '.claude'), path.join(links, 'claude-config'));
  fs.symlinkSync(path.join(os.homedir(), '.claude', 'editlens'), path.join(links, 'state'));
  fs.symlinkSync(process.execPath, path.join(links, 'bin', 'claude'));
  const given = {
    EDITLENS_TEST_PASSWD: path.join(links, 'passwd'),
    CLAUDE_CONFIG_DIR: path.join(links, 'claude-config'),
    EDITLENS_STATE_DIR: path.join(links, 'state'),
    EDITLENS_CLAUDE_PATH: path.join(links, 'bin', 'claude'),
  };
  const out = chosen({ ...process.env, ...given });
  for (const [k, p] of Object.entries(given)) {
    assert.notStrictEqual(out[k], p, k);
    assert.ok(out[k].includes('editlens-isolate-'), `${k}: ${out[k]}`);
  }
  // The same paths as plain files and folders this run made are kept.
  const own = path.join(base, 'own');
  fs.mkdirSync(path.join(own, 'claude-config'), { recursive: true });
  fs.writeFileSync(path.join(own, 'passwd'), 'root:x:0:0:root:/root:/bin/bash\n');
  const plain = { EDITLENS_TEST_PASSWD: path.join(own, 'passwd'), CLAUDE_CONFIG_DIR: path.join(own, 'claude-config') };
  const kept = chosen({ ...process.env, ...plain });
  for (const [k, p] of Object.entries(plain)) assert.strictEqual(kept[k], p, k);
});

test('M9: a temporary folder made before the test run started, or set outside any run, is not kept', () => {
  const before = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-before-run-'));
  try {
    // A new run (no EDITLENS_ISOLATE_RUN): its first process starts another with `before` and with a
    // folder it made itself in the run's private folder.
    const env = { ...process.env };
    delete env.EDITLENS_ISOLATE_RUN;
    for (const k of ISOLATE_PATHS) delete env[k];
    const first = `const { tempInRun } = require(${JSON.stringify(ISOLATE)});
      const fs = require('fs');
      const made = tempInRun('editlens-in-run-');
      const r = require('child_process').spawnSync(process.execPath, ['-e', ${JSON.stringify(SHOW)}],
        { env: { ...process.env, CLAUDE_CONFIG_DIR: ${JSON.stringify(before)}, EDITLENS_STATE_DIR: made }, encoding: 'utf8' });
      fs.rmSync(made, { recursive: true, force: true });
      process.stdout.write(JSON.stringify({ made, child: r.stdout ? JSON.parse(r.stdout) : r.stderr }));`;
    const r = spawnSync(process.execPath, ['-e', first], { env, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, r.stderr);
    const { made, child } = JSON.parse(r.stdout);
    assert.ok(child.CLAUDE_CONFIG_DIR.includes('editlens-isolate-'), `made before the run: ${child.CLAUDE_CONFIG_DIR}`);
    assert.strictEqual(child.EDITLENS_STATE_DIR, made, 'made in the run');
    // Set outside a test run (from a shell): replaced although it is in the temporary folder.
    const outside = chosen({ ...env, CLAUDE_CONFIG_DIR: before });
    assert.ok(outside.CLAUDE_CONFIG_DIR.includes('editlens-isolate-'), outside.CLAUDE_CONFIG_DIR);
  } finally {
    fs.rmSync(before, { recursive: true, force: true });
  }
});

test('M10: npm test (test/run.js) gives each test file its own passwd file, Claude Code settings and state', () => {
  // A copy of the runner with two test files that write down the paths they got.
  const tree = path.join(base, 'runner', 'test');
  fs.mkdirSync(tree, { recursive: true });
  for (const f of ['run.js', 'isolate.js']) fs.copyFileSync(path.join(__dirname, f), path.join(tree, f));
  for (const name of ['a', 'b']) {
    fs.writeFileSync(path.join(tree, `${name}.test.js`), `'use strict';\nrequire('./isolate');\n`
      + `require('fs').writeFileSync(require('path').join(__dirname, '${name}.json'), JSON.stringify(process.env));\n`);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT; // set by this file's own runner: the copy runs its files as a new runner
  const r = spawnSync(process.execPath, [path.join(tree, 'run.js')], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const [a, b] = ['a', 'b'].map((name) => JSON.parse(fs.readFileSync(path.join(tree, `${name}.json`), 'utf8')));
  for (const k of ISOLATE_PATHS) {
    assert.ok(a[k] && b[k], k);
    assert.notStrictEqual(a[k], b[k], `${k} is shared: ${a[k]}`);
    assert.notStrictEqual(a[k], process.env[k], `${k} is this file's`);
  }
});

// The text of each `finally { ... }` block in `src`.
function finallyBlocks(src) {
  const out = [];
  for (const m of src.matchAll(/\bfinally\s*\{/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) break;
    }
    out.push(src.slice(m.index, i + 1));
  }
  return out;
}
const SCRIPTS = fs.readdirSync(__dirname).filter((f) => /(-preview|^e2e-[\w-]+|^preview|^docs-pairing)\.js$/.test(f)).sort();

test('M12: each server a browser script starts is closed in a finally block, so the script ends after a failed step', () => {
  const open = [];
  for (const f of SCRIPTS) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    const blocks = finallyBlocks(src).join('\n');
    for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*(?:http|https|net)\.createServer\(/g)) {
      // A server a helper function returns is closed by the name its caller gives it.
      const returned = new RegExp(`\\br\\(${m[1]}\\)|return ${m[1]}\\b`).test(src);
      if (!returned && !new RegExp(`\\b${m[1]}\\.close\\(`).test(blocks)) open.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepStrictEqual(open, []);
  // CI stops a browser script that does not end, so the scripts after it still run.
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');
  assert.match(workflow, /timeout [\w -]*\d+[sm]? node test\/\$t\.js/);
});

test('M13: an e2e script whose claude program is missing fails through its finally block instead of crashing', async () => {
  const { spawned } = require('./child-stop');
  const { spawn } = require('child_process');
  // A missing program: an error the script catches, not an "error" event with no listener.
  const missing = spawn(path.join(base, 'no-such-claude'), [], { stdio: 'ignore' });
  await assert.rejects(spawned(missing), { code: 'ENOENT' });
  const node = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await spawned(node);
  await new Promise((r) => node.on('exit', r));
  // Each e2e script waits for its claude to start, in the try block whose finally stops the server.
  for (const f of SCRIPTS.filter((name) => /\bspawn\('claude'/.test(fs.readFileSync(path.join(__dirname, name), 'utf8')))) {
    assert.match(fs.readFileSync(path.join(__dirname, f), 'utf8'), /claude = spawn\('claude', [\s\S]*?\}\);\n\s*await spawned\(claude\);/, f);
  }
});

test('L15: e2e-demo.js counts and opens the edit cards the panel makes now (.k-edit)', () => {
  const page = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', '2-page.js'), 'utf8');
  assert.match(page, /el\('li', \{ class: 'k-edit'/, 'the panel\'s edit card');
  const demo = fs.readFileSync(path.join(__dirname, 'e2e-demo.js'), 'utf8');
  assert.doesNotMatch(demo, /querySelector(?:All)?\(['"`][^'"`]*\.item\b/, 'the old feed item');
  assert.match(demo, /querySelectorAll\('\.k-edit'\)/);
});

test('L18: the stand-in SDK keeps the numbers in its commands finite and within a limit', async () => {
  const state = path.join(base, 'sdk-state');
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
  const was = process.env.FAKE_CLAUDE_STATE;
  process.env.FAKE_CLAUDE_STATE = state;
  try {
    const { query } = await import(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'));
    // "long" with a number too big for a string (1e400 is Infinity): a capped text, not a RangeError.
    async function* prompt() { yield { message: { content: `long ${'9'.repeat(400)}` } }; }
    const out = [];
    for await (const m of query({ prompt: prompt(), options: { cwd: base } })) out.push(m);
    const text = out.find((m) => m.type === 'assistant').message.content[0].text;
    assert.ok(text.length > 0 && text.length <= 1e6, String(text.length));
  } finally {
    if (was === undefined) delete process.env.FAKE_CLAUDE_STATE;
    else process.env.FAKE_CLAUDE_STATE = was;
  }
});

test('L19: browser scripts ignore only a wait that ran out, not every error', () => {
  // A rejection handler that drops any error: .catch(() => null), .then(..., () => false).
  const DROPS = /\.catch\(\(\w*\) => (?:null|false|true|undefined|\{\s*\})\)|, \(\w*\) => (?:null|false)\)/g;
  const found = [];
  for (const f of [...SCRIPTS, 'paired-page.js', 'launch.js', 'site-port.js']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
    for (const m of src.matchAll(DROPS)) found.push(`${f}:${src.slice(0, m.index).split('\n').length}`);
  }
  assert.deepStrictEqual(found, []);
  const { onTimeout, notRunning } = require('./timeout');
  const timeout = Object.assign(new Error('Timeout 10ms exceeded.'), { name: 'TimeoutError' });
  assert.strictEqual(onTimeout(false)(timeout), false);
  assert.throws(() => onTimeout(false)(new Error('Target page, context or browser has been closed')), /closed/);
  const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
  assert.strictEqual(notRunning(false)(refused), false);
  assert.throws(() => notRunning(false)(new SyntaxError('Unexpected token')), SyntaxError);
});
