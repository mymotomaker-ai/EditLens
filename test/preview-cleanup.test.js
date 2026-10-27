'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5310';
// Sol M12 and M14 (findings-0.24.43-sol.md): a preview, docs or e2e script that fails early leaves
// no EditLens server or other process running. A stand-in playwright (test/fixtures) fails when
// Chromium starts or at the first page. Each process a script starts gets a mark in its
// environment; after the script ends, a process with that mark is one it left running.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { killPid } = require('./kill');

const ROOT = path.join(__dirname, '..');
const STAND_IN = path.join(__dirname, 'fixtures', 'stand-in-playwright');
const STAND_IN_MAIN = path.join(STAND_IN, 'playwright', 'index.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-preview-cleanup-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const siteDir = path.join(base, 'site');
fs.mkdirSync(siteDir);
const SITE_URL = 'http://127.0.0.1:5311/'; // nothing listens there

// codeview-preview.js is left out: test/sol-mediums-0.24.40.test.js (M18) runs it at the same time.
const SCRIPTS = fs.readdirSync(__dirname)
  .filter((f) => (f.endsWith('-preview.js') && f !== 'codeview-preview.js') || f === 'docs-pairing.js' || f === 'e2e-connect.js')
  .sort();
// Scripts that start their servers with spawn() are also run with a browser that does not start.
const SPAWNS = SCRIPTS.filter((f) => /\bspawn\(/.test(fs.readFileSync(path.join(__dirname, f), 'utf8')));

function argsFor(file, out) {
  const src = fs.readFileSync(path.join(__dirname, file), 'utf8');
  if (file === 'e2e-connect.js') return [siteDir, siteDir, SITE_URL, out];
  if (/\[siteUrl, site(?:Arg|Dir), outDir/.test(src)) return [SITE_URL, siteDir, out];
  return [out];
}

// Pids of processes still running with this mark. Only processes run from this folder or named
// server.js are read.
function marked(mark) {
  if (process.platform !== 'linux') return [];
  const found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    let env;
    try {
      const cmd = fs.readFileSync(`/proc/${name}/cmdline`, 'utf8');
      if (!cmd.includes(ROOT) && !cmd.includes('server.js')) continue;
      env = fs.readFileSync(`/proc/${name}/environ`, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ESRCH' || err.code === 'EACCES') continue;
      throw err;
    }
    if (env.split('\0').includes(`EDITLENS_CLEANUP_MARK=${mark}`)) found.push(Number(name));
  }
  return found;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How a script runs with the stand-in (loaded through preload.js, Sol M14): -> { args, env }.
// `loaded` is the file where the stand-in writes its own path when it is loaded.
function standIn(script, args, mode, loaded, extraEnv = {}) {
  const env = {
    ...process.env,
    PW_STAND_IN: mode,
    PW_STAND_IN_LOADED: loaded,
    ...extraEnv,
  };
  delete env.PW_CHROMIUM;
  return { args: ['--require', path.join(STAND_IN, 'preload.js'), script, ...args], env };
}

test('M14: a script gets the stand-in playwright even when a real one is where Node looks first', () => {
  // A "real" playwright in node_modules next to the script, as in a checkout with playwright installed.
  const probe = path.join(base, 'probe');
  fs.mkdirSync(path.join(probe, 'node_modules', 'playwright'), { recursive: true });
  fs.writeFileSync(path.join(probe, 'node_modules', 'playwright', 'index.js'), "module.exports = { real: true };\n");
  fs.writeFileSync(path.join(probe, 'script.js'), "process.stdout.write(require('playwright').real ? 'real' : 'stand-in');\n");
  const loaded = path.join(base, 'probe.loaded');
  const { args, env } = standIn(path.join(probe, 'script.js'), [], 'page', loaded);
  const r = require('child_process').spawnSync(process.execPath, args, { env, encoding: 'utf8' });
  assert.strictEqual(r.stdout, 'stand-in', r.stderr);
  assert.strictEqual(fs.readFileSync(loaded, 'utf8').trim(), STAND_IN_MAIN);
});

// -> { code, hung, out, left, standIn }: left lists the pids of processes the script left running (now
// stopped); standIn is whether the script loaded the stand-in playwright (a real one writes nothing).
async function run(file, mode) {
  const mark = crypto.randomUUID();
  const out = path.join(base, `${file}-${mode}`);
  const loaded = path.join(base, `${file}-${mode}.loaded`);
  const { args, env } = standIn(path.join(__dirname, file), argsFor(file, out), mode, loaded, { EDITLENS_CLEANUP_MARK: mark });
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let text = '';
  child.stdout.on('data', (c) => { text += c; });
  child.stderr.on('data', (c) => { text += c; });
  // A script that still waits for its own servers after it failed does not end.
  let hung = false;
  const timer = setTimeout(() => { hung = true; killPid(child.pid, 'SIGKILL'); }, 20000);
  const code = await new Promise((resolve) => child.on('exit', (c, signal) => resolve(c === null ? signal : c)));
  clearTimeout(timer);
  let left = marked(mark);
  for (let i = 0; i < 20 && left.length; i++) {
    await sleep(250);
    left = marked(mark);
  }
  for (const pid of left) killPid(pid, 'SIGKILL');
  const loadedStandIn = fs.existsSync(loaded) && fs.readFileSync(loaded, 'utf8').split('\n').includes(STAND_IN_MAIN);
  return { code, hung, out: text, left, standIn: loadedStandIn };
}

for (const [mode, files] of [['page', SCRIPTS], ['no-start', SPAWNS]]) {
  test(`M12/M14: a script whose ${mode === 'page' ? 'first page fails' : 'browser does not start'} leaves nothing running`, {
    skip: process.platform !== 'linux' && 'reads /proc',
  }, async () => {
    const bad = [];
    for (const file of files) {
      const r = await run(file, mode);
      if (r.hung) bad.push(`${file}: did not end in 20 s`);
      if (r.code === 0) bad.push(`${file}: ended without an error: ${r.out.slice(-300)}`);
      if (r.left.length) bad.push(`${file}: left ${r.left.length} running: ${r.out.slice(-300)}`);
      if (!r.standIn) bad.push(`${file}: did not load the stand-in playwright`);
    }
    assert.deepStrictEqual(bad, []);
  });
}
