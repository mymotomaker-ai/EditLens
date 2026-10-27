'use strict';
require('./isolate');
// Settings check SN4: a value saved in Claude Code that is not valid (Effort "Max" after D24 A,
// Panel colors "Purple") shows a note under its row in the page's Settings card, with the words the
// terminal uses: "Max" is not a valid value, so the default is used. The note goes once it is fixed.
// usage: NODE_PATH=$(npm root -g) node test/settings-invalid-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: settings-invalid-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-invalid-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5522' });
const { ensureServer, stopServer, postEvent, postJson } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = 'http://127.0.0.1:5522';
// Claude Code's saved settings (isolate.js points CLAUDE_CONFIG_DIR at an empty folder of this run).
const SAVED = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const save = (options) => fs.writeFileSync(SAVED, JSON.stringify({ pluginConfigs: { 'editlens@local': { options } } }));

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = `<script src="${SERVER}/live.js" data-root="${proj}" data-panel="open"></script>`;
const PAGE = `<!doctype html><title>Site</title><body style="margin:40px"><h1>Site</h1>${tag}</body>`;

(async () => {
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  save({ effort: 'Max', theme: 'Purple', highlight: true });
  await stopServer();
  await ensureServer();
  // What a hook reports: the values in use (Effort and Panel colors at their defaults).
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), settings: { highlight: true } });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const errors = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + '/');
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(400);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    await q(`[...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More').click(); return true;`);
    await q(`[...r.querySelectorAll('.lwrap button')].find((b) => /All settings/.test(b.textContent)).click(); return true;`);
    await page.waitForFunction(`${ROOT}.querySelector('.srow')`, null, { timeout: 5000 });
    // Each row's title and its note about a value that is not valid ('' for none).
    const notes = () => q(`return [...r.querySelectorAll('.srow')].map((x) => [x.querySelector('.stitle').textContent, (x.querySelector('.sinvalid') || { textContent: '' }).textContent])`);
    let rows = await notes();
    const of = (title) => (rows.find((x) => x[0] === title) || [])[1];
    check('Effort: the note under its row', of('Effort') === '"Max" is not a valid value, so the default is used.', rows);
    check('Panel colors: the note under its row', of('Panel colors') === '"Purple" is not a valid value, so the default is used.', rows);
    check('no other row has a note', rows.filter((x) => x[1]).length === 2, rows.filter((x) => x[1]));
    await q(`const n = r.querySelector('.sinvalid'); if (n) n.scrollIntoView({ block: 'center' }); return true;`);
    await sleep(800);
    await page.screenshot({ path: path.join(outDir, 'settings-invalid.png') });

    // Fixed in Claude Code: the next report has the new value, and the note goes.
    save({ effort: 'High', theme: 'Purple', highlight: true });
    await postJson('/settings/report', { values: { effort: 'High', highlight: true }, from: 'mod' });
    await page.waitForFunction(`[...${ROOT}.querySelectorAll('.srow')].some((x) => x.querySelector('.stitle').textContent === 'Effort' && !x.querySelector('.sinvalid'))`, null, { timeout: 5000 })
      .catch((err) => { if (!(err instanceof Error)) throw err; });
    rows = await notes();
    check('Effort: no note once a valid value is saved', of('Effort') === '', rows);
    check('Panel colors: its note stays', /^"Purple" is not a valid value/.test(of('Panel colors')), rows);
    await ctx.close();
    check('no page errors', !errors.length, errors);
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
