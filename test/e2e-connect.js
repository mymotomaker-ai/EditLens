#!/usr/bin/env node
'use strict';
require('./isolate');
// /editlens end to end, with nothing changed in the projects: (1) a Vite project runs with EditLens
// added, the page shows the panel and source lines, Disconnect stops it; (2) another running dev server
// gets an EditLens address that is a proxy for it, its API calls still work, the session ending stops it.
//   NODE_PATH=$(npm root -g) node test/e2e-connect.js \
//     <vite-project-dir> <other-project-dir> <other-url> <out-dir>
const fs = require('fs');
const path = require('path');
// Its own port and isolate's state folder: the EditLens server the user runs is never used or stopped.
process.env.EDITLENS_PORT = '5229';
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');
const { launch } = require('./launch');

const [viteDir, otherDir, otherUrl, outDir = 'connect-out'] = process.argv.slice(2);
if (!viteDir || !otherDir || !otherUrl) {
  console.error('usage: e2e-connect.js <vite-project-dir> <other-project-dir> <other-url> <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const CLI = path.join(__dirname, '..', 'bin', 'connect.js');
const run = (dir, ...args) => execFileSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: path.resolve(dir) }, timeout: 90000 });
// Every file and folder of a project, and of each subfolder but node_modules: path -> hash, link
// target or "dir". -> { 'src/a.js': '<sha256>', ... }
function snapshot(dir, rel = '', out = {}) {
  for (const n of fs.readdirSync(path.join(dir, rel)).sort()) {
    if (n === 'node_modules') continue;
    const r = rel ? rel + '/' + n : n;
    const f = path.join(dir, r);
    const st = fs.lstatSync(f);
    if (st.isSymbolicLink()) out[r] = 'link:' + fs.readlinkSync(f);
    else if (st.isDirectory()) {
      out[r] = 'dir';
      snapshot(dir, r, out);
    } else out[r] = st.isFile() ? require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'other';
  }
  return out;
}
// The paths added, removed or changed between two snapshots.
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);
const ROOT = 'document.querySelector("edit-lens") && document.querySelector("edit-lens").shadowRoot';

(async () => {
  await stopServer();
  await ensureServer();
  const browser = await launch(chromium);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // 1. Vite
  const before = snapshot(viteDir);
  let out = run(viteDir);
  const url = (/open (http:\/\/\S+)/.exec(out) || [])[1];
  check('Vite: connected, with an address', Boolean(url), out);
  await page.goto(url);
  check('Vite: the panel is on the page', Boolean(await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 }).catch(onTimeout(null))));
  check('Vite: source lines are on the elements', (await page.$$('[data-editlens-src]')).length > 0);
  await page.screenshot({ path: path.join(outDir, 'connect-1-vite.png') });
  const changedVite = changed(before, snapshot(viteDir));
  check('Vite: no project file changed', changedVite.length === 0, changedVite);
  out = run(viteDir, 'stop');
  check('Vite: disconnect stops it', /Disconnected/.test(out), out);
  check('Vite: the address is gone', await fetch(url).then(() => false, () => true));

  // 2. Any other dev server, through an EditLens address
  const before2 = snapshot(otherDir);
  out = run(otherDir, otherUrl);
  const url2 = (/open (http:\/\/\S+)/.exec(out) || [])[1];
  check('proxy: connected, with an address', Boolean(url2), out);
  const apiCalls = [];
  page.on('response', (r) => { if (/\/api\//.test(r.url())) apiCalls.push(r.status()); });
  await page.goto(url2);
  check('proxy: the panel is on the page', Boolean(await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 }).catch(onTimeout(null))));
  await page.waitForTimeout(800);
  check('proxy: the page\'s API calls still work', apiCalls.length > 0 && apiCalls.every((s) => s < 400), apiCalls);
  await page.screenshot({ path: path.join(outDir, 'connect-2-proxy.png') });
  const changedOther = changed(before2, snapshot(otherDir));
  check('proxy: no project file changed', changedOther.length === 0, changedOther);
  const conns = await getJson('/connections');
  const mine = conns.find((c) => path.resolve(c.cwd) === path.resolve(otherDir));
  check('proxy: listed as connected', Boolean(mine), conns);
  // The Claude Code session that connected it ends: it stops.
  await postEvent({ type: 'end', sessionId: mine && mine.sessionId ? mine.sessionId : 'e2e-session', cwd: path.resolve(otherDir), reason: 'prompt_input_exit' });
  await new Promise((r) => setTimeout(r, 500));
  const left = (await getJson('/connections')).filter((c) => path.resolve(c.cwd) === path.resolve(otherDir));
  if (mine && mine.sessionId) check('proxy: stops when its session ends', left.length === 0, left);
  else {
    console.log('note: no Claude Code session was known, so the session-end stop is not checked here');
    run(otherDir, 'stop');
  }
  await browser.close();
  await stopServer();
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
