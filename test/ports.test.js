'use strict';
require('./isolate');
// Test files run at the same time (node --test) and next to the user's own EditLens: each file has
// its own fixed ports, none in 4400-4899 (the steady proxy ports) or 4317/4318 (the user's server
// and pairing port), and every file that loads lib/config.js sets its own port and state folder first.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
// This file is left out: its own checks below have example ports and requires in strings.
const SKIP = ['isolate.js', 'run.js', 'ports.test.js'];
const scripts = () => fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !SKIP.includes(f)).sort();
const isTest = (f) => /(\.test|-preview)\.js$|^(preview|docs-pairing|e2e-[\w-]+)\.js$/.test(f);

// Where a number is a port something listens on or connects to.
const PORT_FORMS = [
  /\bEDITLENS_(?:PAIR_)?PORT\s*[:=]\s*(?:String\()?['"]?(\d{2,5})(?![\w.])/g,
  /\b(?:[A-Z][A-Z_]*_)?PORT\s*=\s*['"]?(\d{2,5})(?![\w.])/g,
  /\b(?:port|pairPort)\s*[:=]\s*['"]?(\d{2,5})(?![\w.])/g,
  /\.listen\(\s*(\d{2,5})(?![\w.])/g,
];
// Ports in addresses and URLs (http://127.0.0.1:4362/x, localhost:4362, [::1]:4362). Most are only
// text, so such a port is a problem only when another file listens on it (Sol M11).
const ADDRESS = /(?:\/\/[\w.-]+|\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0)|\[::1?\]):(\d{2,5})(?![\w.])/g;
// Numbers in those forms that are only values to check: nothing listens on them.
const VALUES_ONLY = {
  'connect.test.js': [4400], // the port written into a Vite config
  'gateway-key.test.js': [4999], // the address in the other computer's page, rewritten by the gateway
  'low-fixes.test.js': [4317], // the address in the page script tag
  'no-browser.test.js': [4317], // addresses in advice text
  'pairing.test.js': [4318, 9000], // addresses parsed
  'portowner.test.js': [4100], // a port read from a .env file
  'selfguard.test.js': [4317, 4318], // ports the check refuses
  'settings.test.js': [4100], // a port read from package.json
  'terminal-controls.test.js': [4318], // a port the connector refuses
};

function portsIn(name, src, forms = PORT_FORMS) {
  const out = new Set();
  for (const re of forms) {
    for (const m of src.matchAll(re)) {
      const port = Number(m[1]);
      if (Number.isSafeInteger(port) && port >= 1024 && port <= 65535 && !(VALUES_ONLY[name] || []).includes(port)) out.add(port);
    }
  }
  return [...out];
}

// Problems with the ports of these files: { name: source text }.
function portProblems(files) {
  const owner = new Map();
  const problems = [];
  for (const [name, src] of Object.entries(files)) {
    for (const port of portsIn(name, src)) {
      if (port >= 4400 && port <= 4899) problems.push(`${name}: ${port} is a steady proxy port (4400-4899)`);
      if (port === 4317 || port === 4318) problems.push(`${name}: ${port} is the user's own EditLens port`);
      if (owner.has(port)) problems.push(`${name}: ${port} is also used by ${owner.get(port)}`);
      else owner.set(port, name);
    }
  }
  for (const [name, src] of Object.entries(files)) {
    for (const port of portsIn(name, src, [ADDRESS])) {
      if (owner.has(port) && owner.get(port) !== name) problems.push(`${name}: ${port} (in an address) is used by ${owner.get(port)}`);
    }
  }
  return problems;
}

test('each test file has its own ports, outside the steady proxy ports and the user\'s server', () => {
  const files = {};
  for (const f of scripts()) files[f] = fs.readFileSync(path.join(__dirname, f), 'utf8');
  assert.deepStrictEqual(portProblems(files), []);
  // The check itself finds what it is for.
  assert.deepStrictEqual(portProblems({
    'a.test.js': "process.env.EDITLENS_PORT = '4362';\nconst HOST = { port: 4317, pairPort: 4318 };",
    'b.test.js': "const PORT = 4362;\nserver.listen(4450, '127.0.0.1');",
    'c.test.js': "join({ address: '127.0.0.1:4362' });\nawait fetch('http://localhost:4450/x');\nconst u = `ws://[::1]:4362`;",
    'd.test.js': "const a = 'http://127.0.0.1:5173/';\nconst b = 'https://vps.example.com:4317/x';",
    'e.test.js': "const a = 'http://127.0.0.1:5173/';",
  }), [
    "a.test.js: 4317 is the user's own EditLens port",
    "a.test.js: 4318 is the user's own EditLens port",
    'b.test.js: 4362 is also used by a.test.js',
    'b.test.js: 4450 is a steady proxy port (4400-4899)',
    'c.test.js: 4362 (in an address) is used by a.test.js',
    'c.test.js: 4450 (in an address) is used by b.test.js',
    'd.test.js: 4317 (in an address) is used by a.test.js',
  ]);
  for (const [name, list] of Object.entries(VALUES_ONLY)) {
    const src = fs.readFileSync(path.join(__dirname, name), 'utf8');
    for (const port of list) assert.ok(new RegExp(`\\b${port}\\b`).test(src), `${name} no longer has ${port}: remove it from VALUES_ONLY`);
  }
});

// --- Own port and state folder -------------------------------------------------------------------

function resolveRel(from, rel) {
  const p = path.resolve(path.dirname(from), rel);
  return [p, p + '.js', p + '.mjs'].find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) || null;
}
const CONFIG = path.join(ROOT, 'lib', 'config.js');
const loaders = new Map();
// Whether loading this file loads lib/config.js, through relative requires (also ones inside functions).
function loadsConfig(file, seen = new Set()) {
  if (file === CONFIG) return true;
  if (loaders.has(file)) return loaders.get(file);
  if (seen.has(file)) return false;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  const yes = [...src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].some((m) => {
    const dep = resolveRel(file, m[1]);
    return dep !== null && loadsConfig(dep, seen);
  });
  loaders.set(file, yes);
  return yes;
}

const SETS_PORT = /process\.env\.EDITLENS_PORT\s*=|Object\.assign\(\s*process\.env\s*,\s*\{[^}]*\bEDITLENS_PORT\b/;
// test/isolate.js, loaded before anything else from this project: a state folder set by the file itself
// leaves Claude Code's settings, the claude program, the task account and git hooks real (Sol M15).
const ISOLATE_REQ = /require\(\s*['"]\.\/isolate['"]\s*\)/;
const SCRIPT = /['"](server|bin|hooks|mcp)['"]\s*,\s*['"]([\w.-]+\.m?js)['"]|['"](?:\.\.\/)?(server|bin|hooks|mcp)\/([\w.-]+\.m?js)['"]/g;

// What is missing before this file (`file`, text `src`) loads lib/config.js or runs a script that does.
function isolationProblems(file, src) {
  const name = path.basename(file);
  const problems = [];
  const iso = ISOLATE_REQ.exec(src);
  const local = [...src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].find((m) => m[1] !== './isolate');
  if (!iso) problems.push(`${name}: does not load test/isolate.js`);
  else if (local && local.index < iso.index) problems.push(`${name}: loads test/isolate.js after require('${local[1]}')`);
  const first = [...src.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)].find((m) => {
    const dep = resolveRel(file, m[1]);
    return dep !== null && loadsConfig(dep);
  });
  if (first) {
    const before = src.slice(0, first.index);
    if (!SETS_PORT.test(before)) problems.push(`${name}: sets no EDITLENS_PORT before require('${first[1]}')`);
  }
  const child = [...src.matchAll(SCRIPT)].map((m) => path.join(ROOT, m[1] || m[3], m[2] || m[4]))
    .find((p) => fs.existsSync(p) && loadsConfig(p));
  if (child && !/\bEDITLENS_PORT\b/.test(src)) problems.push(`${name}: runs ${path.relative(ROOT, child)} without an EDITLENS_PORT`);
  return problems;
}

test('every test, preview and e2e script loads test/isolate.js first and sets its own port before it loads lib/config.js', () => {
  const problems = [];
  for (const f of scripts().filter(isTest)) problems.push(...isolationProblems(path.join(__dirname, f), fs.readFileSync(path.join(__dirname, f), 'utf8')));
  assert.deepStrictEqual(problems, []);
  // The check itself finds what it is for.
  const at = path.join(__dirname, 'x-preview.js');
  assert.deepStrictEqual(isolationProblems(at, "'use strict';\nconst { ensureServer } = require('../lib/client');\n"), [
    'x-preview.js: does not load test/isolate.js',
    "x-preview.js: sets no EDITLENS_PORT before require('../lib/client')",
  ]);
  // Its own state folder is not enough, and isolate after another module of this project is too late.
  assert.deepStrictEqual(isolationProblems(at, "process.env.EDITLENS_PORT = '1';\nprocess.env.EDITLENS_STATE_DIR = '/tmp/x';\nrequire('../lib/client');\n"),
    ['x-preview.js: does not load test/isolate.js']);
  assert.deepStrictEqual(isolationProblems(at, "process.env.EDITLENS_PORT = '1';\nrequire('../lib/taskuser');\nrequire('./isolate');\n"),
    ["x-preview.js: loads test/isolate.js after require('../lib/taskuser')"]);
  assert.deepStrictEqual(isolationProblems(at, "'use strict';\nrequire('./isolate');\nconst c = require('./answer-helper');\nprocess.env.EDITLENS_PORT = '1';\n"),
    ["x-preview.js: sets no EDITLENS_PORT before require('./answer-helper')"]);
  assert.deepStrictEqual(isolationProblems(at, "require('./isolate');\nspawn(process.execPath, [path.join(ROOT, 'server', 'server.js')]);\n"),
    ['x-preview.js: runs server/server.js without an EDITLENS_PORT']);
  assert.deepStrictEqual(isolationProblems(at, "require('./isolate');\nprocess.env.EDITLENS_PORT = '1';\nrequire('../lib/client');\n"), []);
});

test('test/isolate.js gives each test file its own new state folder, and keeps one already set in the run\'s folder', () => {
  const env = { ...process.env };
  delete env.EDITLENS_STATE_DIR;
  const show = "require('./test/isolate'); process.stdout.write(process.env.EDITLENS_STATE_DIR)";
  const a = spawnSync(process.execPath, ['-e', show], { cwd: ROOT, env, encoding: 'utf8' });
  const b = spawnSync(process.execPath, ['-e', show], { cwd: ROOT, env, encoding: 'utf8' });
  assert.ok(a.stdout.startsWith(os.tmpdir() + path.sep) && b.stdout.startsWith(os.tmpdir() + path.sep), a.stdout + a.stderr);
  assert.notStrictEqual(a.stdout, b.stdout);
  assert.strictEqual(fs.existsSync(a.stdout), false, 'removed when the file ends');
  // Kept only in the run's private folder (Sol M14).
  const own = require('./isolate').tempInRun('editlens-kept-');
  const kept = spawnSync(process.execPath, ['-e', show], { cwd: ROOT, env: { ...env, EDITLENS_STATE_DIR: own }, encoding: 'utf8' });
  fs.rmSync(own, { recursive: true, force: true });
  assert.strictEqual(kept.stdout, own);
  // Anywhere else (the real ~/.claude/editlens) is replaced (Sol M16).
  const real = spawnSync(process.execPath, ['-e', show], { cwd: ROOT, env: { ...env, EDITLENS_STATE_DIR: '/kept' }, encoding: 'utf8' });
  assert.ok(real.stdout.startsWith(os.tmpdir() + path.sep), real.stdout);
  // npm test (test/run.js) does not pass its own folders on: files running at the same time don't share them.
  assert.match(fs.readFileSync(path.join(__dirname, 'run.js'), 'utf8'), /for \(const name of ISOLATE_PATHS\) delete env\[name\];/);
  assert.ok(require('./isolate').ISOLATE_PATHS.includes('EDITLENS_STATE_DIR'));
});
