'use strict';
require('./isolate');
// The check that runs when the Restore question opens (Sol 0.24.43 L8): Restore stays off until
// the check answers, and when the check fails (not "copy no longer kept") the error is shown and
// Restore stays off.
// usage: NODE_PATH=$(npm root -g) node test/restore-check-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: restore-check-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-restore-check-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5301' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const { diffText, countStats } = require('../lib/diff');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:60px">
<h1 id="h" data-editlens-src="src/app.js:1:1">Hello</h1>
<script src="http://127.0.0.1:5301/live.js" data-root="${proj}" data-panel="open"></script></body>`;

const APP = path.join(proj, 'src', 'app.js');
const OLD = 'const title = "Hello";\n';
const NEW = 'const title = "Hi there";\n';

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    // How the check answers: 'fail' (500), 'slow' (after 1.5 s), or the real answer.
    let mode = 'fail';
    await page.route('**/restore', async (route) => {
      const req = route.request();
      if (req.method() !== 'POST' || !/"check":true/.test(req.postData() || '')) return route.continue();
      if (mode === 'fail') return route.fulfill({ status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: 'the disk is busy' }) });
      if (mode === 'slow') await sleep(1500);
      return route.continue();
    });
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    fs.writeFileSync(APP, NEW);
    const hunks = diffText(OLD, NEW);
    await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: APP, relFile: 'src/app.js', tool: 'Edit', kind: 'frontend',
      before: OLD, after: NEW, hunks, stats: countStats(hunks), intent: 'Change the title', ts: Date.now() });
    await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-edit')].some((x) => /app\\.js/.test(x.textContent) && x.querySelector('.rst'))`, null, { timeout: 10000 });
    const ask = () => q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => /app\\.js/.test(x.textContent)); c.querySelector('.rst').click(); return true;`);
    const box = () => q(`const b = r.querySelector('.k-edit .rconf'); return b ? { off: b.querySelector('.allow').disabled, text: b.querySelector('.rq').textContent } : null;`);
    const close = () => q(`const b = r.querySelector('.k-edit .rconf'); if (b) [...b.querySelectorAll('button')].find((x) => x.textContent === 'Cancel').click(); return true;`);

    await ask();
    await sleep(800);
    let b = await box();
    check('a failed check: Restore is off', b && b.off === true, b);
    check('a failed check: the error is shown', b && /the disk is busy/.test(b.text), b);
    await page.screenshot({ path: path.join(outDir, 'restore-check-failed.png') });
    await q(`r.querySelector('.k-edit .rconf .allow').click(); return true;`);
    await sleep(500);
    check('a click on it does nothing', fs.readFileSync(APP, 'utf8') === NEW);
    await close();

    mode = 'slow';
    await ask();
    await sleep(300);
    b = await box();
    check('while the check runs: Restore is off', b && b.off === true, b);
    await sleep(2000);
    b = await box();
    check('after the check answers: Restore is on', b && b.off === false, b);
    await q(`r.querySelector('.k-edit .rconf .allow').click(); return true;`);
    await sleep(800);
    check('and Restore works', fs.readFileSync(APP, 'utf8') === OLD, fs.readFileSync(APP, 'utf8'));
    check('no page errors', !errors.length, errors);
  } finally {
    await browser.close();
    site.close();
    await stopServer();
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
