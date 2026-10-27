'use strict';
require('./isolate');
// D23 B (Sol 0.24.46 M6): Restore and Remove file when no copy of the current file can be kept for
// Undo (over 2 MB here). The card asks first, with "Restore without Undo" / "Remove without Undo";
// a plain request the server refuses (the file grew after the check) turns the card into that
// question; only the "without Undo" button writes. Pictures: light, dark, and 480 px wide.
// usage: NODE_PATH=$(npm root -g) node test/no-undo-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: no-undo-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-no-undo-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5451' });
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

const PAGE = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:40px">
<h1 id="h" data-editlens-src="src/app.js:1:1">Hello</h1>
<script src="http://127.0.0.1:5451/live.js" data-root="${proj}" data-panel="open"></script></body>`;
const OLD = 'const title = "Hello";\n';
const NEW = 'const title = "Hi there";\n';
const BIG = NEW + '// ' + 'x'.repeat(3 * 1024 * 1024) + '\n';

async function edit(name, { created = false } = {}) {
  const file = path.join(proj, 'src', name);
  fs.writeFileSync(file, NEW);
  const hunks = diffText(created ? '' : OLD, NEW);
  await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file, relFile: `src/${name}`, tool: created ? 'Write' : 'Edit', kind: 'frontend', created,
    ...(created ? {} : { before: OLD }), after: NEW, hunks, stats: countStats(hunks), intent: 'Change the title', ts: Date.now() });
  return file;
}

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
    for (const run of [{ name: 'light', width: 1366, scheme: 'light', full: true }, { name: 'dark', width: 1366, scheme: 'dark' }, { name: '480', width: 480, scheme: 'light' }]) {
      const ctx = await browser.newContext({ viewport: { width: run.width, height: 860 }, colorScheme: run.scheme });
      await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
      const errors = [];
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      // When set, the check answers as before the file grew (no noUndo), so the plain request is sent.
      let stale = false;
      await page.route('**/restore', async (route) => {
        const req = route.request();
        if (!stale || req.method() !== 'POST' || !/"check":true/.test(req.postData() || '')) return route.continue();
        return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, exists: true, same: false, readOnly: false }) });
      });
      await page.goto(url);
      await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
      await sleep(800);
      const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
      const card = (name) => `[...r.querySelectorAll('.k-edit')].find((x) => x.textContent.includes(${JSON.stringify(name)}))`;
      const open = (name) => q(`const c = ${card(name)}; c.querySelector('.rst').click(); return true;`);
      const box = (name) => q(`const c = ${card(name)}; const b = c && c.querySelector('.rconf'); if (!b) return null; const go = b.querySelector('.pacts button');
        const rb = b.getBoundingClientRect(); return { text: b.querySelector('.rq').textContent, go: go.textContent, off: go.disabled, checked: b.getAttribute('data-check'), right: rb.right, width: innerWidth };`);
      const press = (name) => q(`${card(name)}.querySelector('.rconf .pacts button').click(); return true;`);
      const shot = async (name, file) => {
        await q(`${card(name)}.scrollIntoView({ block: 'center' }); return true;`);
        await page.screenshot({ path: path.join(outDir, file) });
      };

      // Restore: the check says the current file is over 2 MB, so the card asks first.
      const a = `a-${run.name}.js`;
      const fa = await edit(a);
      await page.waitForFunction(`(() => { const r = ${ROOT}; const c = ${card(a)}; return c && c.querySelector('.rst'); })()`, null, { timeout: 10000 });
      fs.writeFileSync(fa, BIG);
      await open(a);
      await sleep(900);
      let b = await box(a);
      check(`${run.name}: the restore card says why there is no Undo`, b && /is over 2 MB, so its current version can't be kept for Undo/.test(b.text), b && b.text);
      check(`${run.name}: and asks with "Restore without Undo"`, b && b.go === 'Restore without Undo' && !b.off, b);
      if (run.width === 480) check('480: the question fits the width', b && b.right <= b.width, b);
      await shot(a, `no-undo-restore-${run.name}.png`);
      if (!run.full) {
        check(`${run.name}: no page errors`, !errors.length, errors);
        await ctx.close();
        continue;
      }
      await press(a);
      await sleep(900);
      check('Restore without Undo puts the file back', fs.readFileSync(fa, 'utf8') === OLD);

      // The file grew after the check: the plain Restore is refused, and the card asks.
      const g = `grew-${run.name}.js`;
      const fg = await edit(g);
      await page.waitForFunction(`(() => { const r = ${ROOT}; const c = ${card(g)}; return c && c.querySelector('.rst'); })()`, null, { timeout: 10000 });
      fs.writeFileSync(fg, BIG);
      stale = true;
      await open(g);
      await sleep(900);
      b = await box(g);
      check('a check from before the file grew: a plain Restore', b && b.go === 'Restore', b);
      await press(g);
      await sleep(900);
      b = await box(g);
      check('the refused Restore changes nothing', fs.statSync(fg).size === Buffer.byteLength(BIG));
      check('and the card asks "Restore without Undo"', b && b.go === 'Restore without Undo' && /can't be kept for Undo/.test(b.text), b);
      stale = false;
      await press(g);
      await sleep(900);
      check('then it restores', fs.readFileSync(fg, 'utf8') === OLD);

      // Remove file: a file Claude created that is now over 2 MB.
      const c = `made-${run.name}.js`;
      const fc = await edit(c, { created: true });
      await page.waitForFunction(`(() => { const r = ${ROOT}; const x = ${card(c)}; return x && x.querySelector('.rst'); })()`, null, { timeout: 10000 });
      fs.writeFileSync(fc, BIG);
      await open(c);
      await sleep(900);
      b = await box(c);
      check('Remove file asks with "Remove without Undo"', b && b.go === 'Remove without Undo' && /over 2 MB/.test(b.text), b);
      await shot(c, `no-undo-remove-${run.name}.png`);
      await press(c);
      await sleep(900);
      check('Remove without Undo deletes the file', !fs.existsSync(fc));
      check('no page errors', !errors.length, errors);
      await ctx.close();
    }
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
