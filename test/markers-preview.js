'use strict';
require('./isolate');
// Highlights on the page: an edit's part glows with a thin ring, then keeps a numbered marker in
// the margin (the same number as its edit card). Pointing at a marker opens the code card. The
// switch in the panel header turns rings and markers off, with Undo. Light and dark.
// usage: NODE_PATH=$(npm root -g) node test/markers-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: markers-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-markers-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '4986' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'public'), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Trailhead Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}header{padding:18px 40px;background:#fff;border-bottom:1px solid #e6e3da;font-weight:700}
main{padding:48px 60px;max-width:640px}h1{font-size:44px;line-height:1.1;margin:0 0 12px}.menu{list-style:none;padding:0;margin:28px 0 0}.menu li{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #e6e3da}.price{font-weight:700}
@media (prefers-color-scheme:dark){body{background:#18181a;color:#eee}header{background:#232325;border-color:#38383b}.menu li{border-color:#38383b}}</style>
</head><body><header>Trailhead Coffee</header><main><h1 id="h">Coffee for the longer walk</h1><p>Small-batch roasts, brewed slowly, served at the bottom of the hill.</p>
<ul class="menu"><li>Espresso <span class="price">$3.00</span></li><li>Flat white <span class="price">$4.25</span></li><li id="m">Filter of the day <span class="price">$3.50</span></li></ul></main>
<script src="http://127.0.0.1:4986/live.js" data-root="${proj}" data-panel="open" data-settle="300"></script></body></html>`;

function change(rel, before, after, intent, line) {
  return postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, rel), relFile: rel, tool: 'Edit', kind: 'frontend', intent,
    before, after, hunks: [{ oldStart: line, newStart: line, lines: [`-${before}`, `+${after}`] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
}

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium);
  try {
    for (const scheme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: scheme });
      // Skip the tour; localStorage can throw in private mode.
      await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
      const errors = [];
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url);
      await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
      await sleep(800);
      const q = (js) => page.evaluate(`(() => { const r = ${ROOT}; ${js} })()`);

      await change('public/index.html', '<h1>Coffee for the longer walk</h1>', '<h1>New coffee each day</h1>', 'Changing the main heading.', 19);
      await page.evaluate(() => { document.getElementById('h').textContent = 'New coffee each day'; });
      await page.waitForFunction(`${ROOT}.querySelector('.box')`, null, { timeout: 5000 }).catch(onTimeout(null));
      await sleep(300);
      const ring = await q(`const b = r.querySelector('.box'); if (!b) return null; const s = getComputedStyle(b); return { border: s.borderTopWidth, bg: s.backgroundColor };`);
      check(`${scheme}: the change glows with a thin ring and no fill`, ring && /^1(\.5)?px$/.test(ring.border) && /rgba\(0, 0, 0, 0\)|transparent/.test(ring.bg), ring);
      await page.screenshot({ path: path.join(outDir, `markers-${scheme}-glow.png`) });

      await sleep(2200);
      await change('public/index.html', '<li>Filter of the day <b>$3.50</b>', '<li>Mocha <b>$4.50</b>', 'Adding Mocha to the menu.', 24);
      await page.evaluate(() => { document.getElementById('m').firstChild.textContent = 'Mocha '; document.querySelector('#m .price').textContent = '$4.50'; });
      await sleep(2800);
      check(`${scheme}: the rings settle`, !(await q(`return [...r.querySelectorAll('.box')].some((b) => !b.classList.contains('out'));`)));
      const marks = await q(`return [...r.querySelectorAll('.emark')].filter((m) => m.style.display !== 'none').map((m) => ({ n: m.textContent, seen: m.classList.contains('seen'), x: parseFloat(m.style.left) }));`);
      check(`${scheme}: two numbered markers in the margin, filled`, marks.length === 2 && marks.map((m) => m.n).join() === '1,2' && marks.every((m) => !m.seen && Number.isFinite(m.x) && m.x < 60), marks);
      const cards = await q(`return [...r.querySelectorAll('.k-edit .eno')].map((e) => e.textContent).join();`);
      check(`${scheme}: the edit cards include the same numbers`, cards === '1,2', cards);
      await page.screenshot({ path: path.join(outDir, `markers-${scheme}-settled.png`) });

      // Point at marker 2: the code card opens, and the marker and its card turn to an outline.
      const box = await q(`const m = [...r.querySelectorAll('.emark')].find((x) => x.textContent === '2'); const b = m.getBoundingClientRect(); return { x: b.x + 9, y: b.y + 9 };`);
      await page.mouse.move(box.x, box.y);
      const peekOn = await page.waitForFunction(`${ROOT}.querySelector('.peek.on')`, null, { timeout: 3000 }).then(() => true, onTimeout(false));
      check(`${scheme}: pointing at a marker opens its code card`, peekOn);
      await sleep(400);
      check(`${scheme}: the card stays while the pointer rests on the marker`, await q(`return Boolean(r.querySelector('.peek.on'));`));
      check(`${scheme}: marker 2 and its edit card are now outlined`, await q(`return [...r.querySelectorAll('.emark')].find((x) => x.textContent === '2').classList.contains('seen') && [...r.querySelectorAll('.k-edit .eno')].find((x) => x.textContent === '2').classList.contains('seen');`));
      await page.screenshot({ path: path.join(outDir, `markers-${scheme}-peek.png`) });
      await page.mouse.move(640, 700);
      await sleep(600);

      // The switch: off hides rings and markers and says so, with Undo.
      await q(`r.querySelector('.head .hl').click(); return true;`);
      await sleep(300);
      const off = await q(`return { pressed: r.querySelector('.head .hl').getAttribute('aria-pressed'), layer: getComputedStyle(r.querySelector('.mlayer')).display, toast: r.querySelector('.toast').textContent };`);
      check(`${scheme}: switch off hides the markers and shows the toast`, off.pressed === 'false' && off.layer === 'none' && /Highlights off · edits still show in the panel/.test(off.toast), off);
      await page.screenshot({ path: path.join(outDir, `markers-${scheme}-off.png`) });
      await q(`[...r.querySelectorAll('.toast button')].find((b) => b.textContent === 'Undo').click(); return true;`);
      await sleep(200);
      check(`${scheme}: Undo shows them again`, await q(`return r.querySelector('.head .hl').getAttribute('aria-pressed') === 'true' && getComputedStyle(r.querySelector('.mlayer')).display !== 'none';`));
      await page.keyboard.press('Alt+Shift+H');
      await sleep(200);
      check(`${scheme}: Alt+Shift+H turns them off too`, await q(`return r.querySelector('.head .hl').getAttribute('aria-pressed') === 'false';`));
      await page.keyboard.press('Alt+Shift+H');
      check(`${scheme}: no page errors`, !errors.length, errors);
      await ctx.close();
      await stopServer();
      // A clean start: without the earlier copies, the edits above are not listed again after the restart.
      fs.rmSync(path.join(tmp, 'live', 'backups'), { recursive: true, force: true });
      await ensureServer();
    }
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
