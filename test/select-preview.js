#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5201';
// A selected code block keeps its page elements outlined, in their own color, until deselected.
// Runs against the Vite + React sample (examples/vite-react) without Claude: an edit card is opened,
// the outline stays after the edit glow, follows a re-render and a scroll, Esc clears it, and lines
// selected in the code view outline the elements written on them.
//
//   NODE_PATH=$(npm root -g) node test/select-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteDir, outDir = 'select-out'] = process.argv.slice(2);
if (!siteUrl || !siteDir) {
  console.error('usage: select-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 'select-preview', cwd: siteDir, ts: Date.now(), canListen: false });
  const appFile = path.join(siteDir, 'src', 'App.jsx');
  const source = fs.readFileSync(appFile, 'utf8');
  const cardLine = source.split('\n').findIndex((l) => l.includes('className="stat-card"')) + 1;
  const browser = await launchOwnPort(chromium);
  try {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: scheme === 'light' ? 2 : 1, colorScheme: scheme });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log('[pageerror]', e.message));
      await page.goto(siteUrl);
      await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
      await page.waitForSelector('.stat-card');
      const count = () => page.evaluate(`${ROOT}.querySelectorAll('.box.sel').length`);

      await postEvent({
        type: 'change', kind: 'frontend', tool: 'Edit', file: appFile, relFile: 'src/App.jsx', cwd: siteDir, ts: Date.now(),
        stats: { added: 1, removed: 1 }, hints: { classes: ['stat-card'] },
        hunks: [{ oldStart: cardLine, newStart: cardLine, lines: ['-' + source.split('\n')[cardLine - 1], '+' + source.split('\n')[cardLine - 1]] }],
      });
      await page.waitForFunction(`${ROOT}.querySelector('.k-edit')`);
      await page.waitForTimeout(5200); // the orange edit glow is gone by now
      await page.evaluate(`${ROOT}.querySelector('.k-edit').click()`);
      await page.waitForTimeout(300);
      const first = await count();
      check(`${scheme}: opening the card outlines the three stat cards`, first === 3, first);
      const bar = await page.evaluate(`(${ROOT}.querySelector('.selbar.on .st') || {}).textContent`);
      check(`${scheme}: selection bar names the three elements`, / · 3 elements on this page$/.test(bar || ''), bar);
      check(`${scheme}: card marked selected`, await page.evaluate(`${ROOT}.querySelector('.k-edit').classList.contains('sel')`));
      await page.waitForTimeout(5000);
      check(`${scheme}: still outlined after 5 s`, (await count()) === 3);
      await page.screenshot({ path: path.join(outDir, `select-${scheme}-1-card.png`) });

      // A new live edit glows orange on top, and the selection stays.
      await postEvent({ type: 'change', kind: 'frontend', tool: 'Edit', file: appFile, relFile: 'src/App.jsx', cwd: siteDir, ts: Date.now(), stats: { added: 1, removed: 0 }, hints: { classes: ['page-title'] }, hunks: [] });
      await page.waitForTimeout(900);
      const both = await page.evaluate(`[${ROOT}.querySelectorAll('.box.sel').length, ${ROOT}.querySelectorAll('.layer .box:not(.sel):not(.point)').length]`);
      check(`${scheme}: edit glow and selection together`, both[0] === 3 && both[1] >= 1, both);
      if (scheme === 'light') await page.screenshot({ path: path.join(outDir, `select-${scheme}-2-with-edit.png`) });

      // The app re-renders the cards with new elements: the outline moves to them.
      await page.evaluate(`(() => { const s = document.querySelector('.stats'); s.replaceWith(s.cloneNode(true)); })()`);
      await page.waitForTimeout(600);
      const reattached = await page.evaluate(`[...${ROOT}.querySelectorAll('.box.sel')].length === 3 && document.querySelectorAll('.stat-card').length === 3`);
      check(`${scheme}: re-attached after re-render`, reattached);

      // Scrolling: the outline follows its element.
      await page.evaluate(`document.body.style.minHeight = '2400px'; window.scrollTo(0, 120)`);
      await page.waitForTimeout(300);
      const offset = await page.evaluate(`(() => { const b = ${ROOT}.querySelector('.box.sel').getBoundingClientRect(); const t = document.querySelector('.stat-card').getBoundingClientRect(); return Math.round(t.top - b.top); })()`);
      check(`${scheme}: follows scrolling`, offset === 4, offset);
      await page.evaluate(`window.scrollTo(0, 0)`);

      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
      check(`${scheme}: Esc clears it`, (await count()) === 0 && !(await page.evaluate(`${ROOT}.querySelector('.selbar.on')`)));

      // Lines selected in the code view outline the elements written there.
      await postEvent({ type: 'code', file: appFile, relFile: 'src/App.jsx', content: source, line: 14, endLine: 22, cwd: siteDir, note: null, ts: Date.now() });
      await page.waitForFunction(`${ROOT}.querySelectorAll('.pane .cl').length > 10`, null, { timeout: 8000 });
      await page.waitForTimeout(1500);
      const rows = await page.evaluate(`[...${ROOT}.querySelectorAll('.pane .cl')].slice(14, 22).map((r) => { const b = r.querySelector('.tx').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; })`);
      await page.mouse.move(rows[0].x + 2, rows[0].y);
      await page.mouse.down();
      await page.mouse.move(rows[7].x + 120, rows[7].y, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const codeSel = await page.evaluate(`[${ROOT}.querySelectorAll('.box.sel').length, ${ROOT}.querySelector('.selbar .st').textContent]`);
      check(`${scheme}: code lines outline their elements`, codeSel[0] >= 1, codeSel);
      await page.screenshot({ path: path.join(outDir, `select-${scheme}-3-lines.png`) });
      await page.evaluate(`${ROOT}.querySelector('.selbar .mini:last-child').click()`);
      check(`${scheme}: Clear button`, (await count()) === 0);
      await context.close();
    }
  } finally {
    await browser.close();
    await stopServer(); // left running, it would refuse the next run (a new state folder)
  }
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
