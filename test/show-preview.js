#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5207';
// Show in the selection bar always does something visible: it scrolls to an outlined element off
// screen and makes its outline pulse, with several elements each click goes to the next ("showing
// 2 of 3"), an element under the panel shows through it, and Show also opens the code in the code
// view. The site is the Vite demo with StatCard on src/App.jsx line 9 (three cards).
//
//   NODE_PATH=$(npm root -g) node test/show-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'show-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: show-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

async function run(browser, tall) {
  const SESSION = `show-${tall ? 'tall' : 'short'}-${Date.now()}`;
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  if (tall) await page.addStyleTag({ content: '.stats{margin-top:1800px;margin-bottom:1800px}' });
  const file = path.join(siteDir, 'src', 'App.jsx');
  const text = fs.readFileSync(file, 'utf8');
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file, relFile: 'src/App.jsx', ts: Date.now(),
    before: text, after: text, stats: { added: 1, removed: 0 }, hints: {}, hunks: [{ oldStart: 9, newStart: 9, lines: ['+    <div className="stat-card">'] }],
  });
  await page.waitForFunction(`${ROOT}.querySelectorAll('.k-edit').length >= 1`);
  await page.waitForTimeout(1200);
  await page.evaluate(`${ROOT}.querySelector('.k-edit').click()`);
  await page.waitForTimeout(1200);
  const st = () => page.evaluate(`(() => { const r = ${ROOT}; return { y: Math.round(scrollY), bar: r.querySelector('.selbar .st').textContent, show: r.querySelector('.selbar .mini').textContent, hit: [...r.querySelectorAll('.box.sel')].findIndex((b) => b.classList.contains('hit')) }; })()`);
  const show = async () => {
    await page.locator('edit-lens').locator('.selbar .mini').first().click();
    await page.waitForTimeout(tall ? 1200 : 300);
    return st();
  };
  const name = tall ? 'long page' : 'short page';
  if (!tall) {
    // Show also opens the code: close the code view first, then Show opens it at App.jsx.
    await page.evaluate(`${ROOT}.querySelector('.dock .dhead button.xred').click()`);
    await page.waitForTimeout(400);
  }
  if (tall) {
    await page.evaluate('scrollTo(0, 0)');
    await page.waitForTimeout(400);
  }
  let s = await show();
  check(`${name}: Show outlines the first one and says which`, s.hit === 0 && /3 elements on this page \(showing 1 of 3\)$/.test(s.bar) && s.show === 'Show', s);
  if (tall) check(`${name}: Show scrolled to it`, s.y > 1000, s);
  if (!tall) {
    await page.waitForTimeout(1200);
    const code = await page.evaluate(`(() => { const r = ${ROOT}; return { open: r.querySelector('.dock').classList.contains('on'), tabs: [...r.querySelectorAll('.dock .tab')].map((t) => t.textContent), marked: [...r.querySelectorAll('.dock .lmark')].length }; })()`);
    check(`${name}: Show opened the code in the code view`, code.open && code.tabs.some((t) => /App\.jsx/.test(t)), code);
    // The whole StatCard <div> (lines 9-12), not just its first line.
    check(`${name}: the code view marks the whole part`, code.marked === 4, code);
  }
  await page.screenshot({ path: path.join(outDir, `show-${tall ? 'long' : 'short'}.png`) });
  s = await show();
  check(`${name}: the next click goes to the next one`, s.hit === 1 && /showing 2 of 3/.test(s.bar), s);
  if (!tall) {
    const thru = await page.evaluate(`(() => { const r = ${ROOT}; const p = r.querySelector('.panel').getBoundingClientRect(); const c = document.querySelectorAll('.stat-card')[1].getBoundingClientRect(); return { under: c.right > p.left && c.left < p.right && c.bottom > p.top && c.top < p.bottom, thru: r.querySelector('.panel').classList.contains('thru') }; })()`);
    check(`${name}: an element under the panel shows through it`, !thru.under || thru.thru, thru);
    await page.screenshot({ path: path.join(outDir, 'show-under-panel.png') });
  }
  if (tall) {
    await page.evaluate('scrollTo(0, 0)');
    await page.waitForTimeout(400);
    s = await show();
    check(`${name}: after scrolling away, Show returns to the one it showed`, s.hit === 1 && s.y > 1000 && /showing 2 of 3/.test(s.bar), s);
  }
  await page.context().close();
}

(async () => {
  await stopServer();
  await ensureServer();
  const browser = await launchOwnPort(chromium);
  try {
    await run(browser, false);
    await run(browser, true);
  } finally {
    await browser.close();
    await stopServer(); // left running, it would refuse the next run (a new state folder)
  }
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exitCode = failed ? 1 : 0;
})();
