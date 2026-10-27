#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4995';
// The user pointing for Claude, in a running Vite + React app (examples/vite-react), without
// running Claude: Alt+Shift+P, click an element, Shift+click another, drag an area, attach lines
// from the code view, send, read what Claude would receive, and Claude pointing back at #1.
//
//   NODE_PATH=$(npm root -g) node test/point-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');

const [siteUrl, siteDir, outDir = 'point-out'] = process.argv.slice(2);
if (!siteUrl || !siteDir) {
  console.error('usage: point-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 'point-preview', cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  try {
    for (const scheme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: scheme === 'light' ? 2 : 1, colorScheme: scheme });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log('[pageerror]', e.message));
      await page.goto(siteUrl);
      const root = 'document.querySelector("edit-lens").shadowRoot';
      await page.waitForFunction(`${root} && ${root}.querySelector('.status.idle, .status.stopped')`);
      await page.waitForSelector('.stat-card');

      // Hover shows the element and where it is written.
      await page.keyboard.press('Alt+Shift+KeyP');
      const card = await page.locator('.stat-card').nth(1).boundingBox();
      await page.mouse.move(card.x + 20, card.y + 12);
      await page.waitForTimeout(150);
      console.log(scheme, 'hover label:', await page.evaluate(`${root}.querySelector('.ubox.hover .tag').textContent`));
      if (scheme === 'light') await page.screenshot({ path: path.join(outDir, `point-${scheme}-1-hover.png`) });

      // Shift+click two elements, then drag an area.
      await page.keyboard.down('Shift');
      await page.mouse.click(card.x + 20, card.y + 12);
      const title = await page.locator('.page-title').boundingBox();
      await page.mouse.click(title.x + 10, title.y + 10);
      await page.keyboard.up('Shift');
      const panelBox = await page.locator('main .panel').boundingBox();
      await page.mouse.move(panelBox.x - 8, panelBox.y - 8);
      await page.mouse.down();
      await page.mouse.move(panelBox.x + panelBox.width / 2, panelBox.y + panelBox.height / 2, { steps: 5 });
      await page.mouse.move(panelBox.x + panelBox.width + 8, panelBox.y + panelBox.height + 8, { steps: 5 });
      await page.mouse.up();
      console.log(scheme, 'point mode after drag (no Shift):', await page.evaluate(`${root}.querySelector('.catcher').classList.contains('on')`));

      // Lines from the code view.
      await postEvent({ type: 'code', file: path.join(siteDir, 'src', 'App.jsx'), relFile: 'src/App.jsx', content: fs.readFileSync(path.join(siteDir, 'src', 'App.jsx'), 'utf8'), line: 7, endLine: 14, cwd: siteDir, note: null, ts: Date.now() });
      await page.waitForFunction(`${root}.querySelectorAll('.pane .cl').length > 10`, null, { timeout: 8000 });
      await page.waitForTimeout(1500);
      const rows = await page.evaluate(`[...${root}.querySelectorAll('.pane .cl')].slice(6, 14).map((r) => { const b = r.querySelector('.tx').getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2 }; })`);
      await page.mouse.move(rows[0].x + 2, rows[0].y);
      await page.mouse.down();
      await page.mouse.move(rows[7].x + 120, rows[7].y, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction(`${root}.querySelector('.codepick.on')`, null, { timeout: 3000 });
      console.log(scheme, 'code button:', await page.evaluate(`${root}.querySelector('.codepick').textContent`));
      if (scheme === 'light') await page.screenshot({ path: path.join(outDir, `point-${scheme}-2-lines.png`) });
      await page.evaluate(`${root}.querySelector('.codepick').click()`);

      const chips = await page.evaluate(`[...${root}.querySelectorAll('.composer .att')].map((a) => a.textContent.replace('×', ''))`);
      console.log(scheme, 'chips:', JSON.stringify(chips));
      await page.evaluate(`(() => { const t = ${root}.querySelector('.composer textarea'); t.value = 'Make the second card as easy to see as the title'; t.dispatchEvent(new Event('input')); })()`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, `point-${scheme}-3-attached.png`) });
      await page.evaluate(`${root}.querySelector('.send').click()`);
      await page.waitForFunction(`${root}.querySelector('.feed .atts.sent')`);

      const taken = await getJson(`/messages/take?cwd=${encodeURIComponent(siteDir)}&via=prompt`);
      const { formatMessages } = require('../lib/messages');
      if (scheme === 'light') console.log('--- what Claude receives ---\n' + formatMessages(taken.messages));

      // Claude points back at #1 (light) / #5 (dark: numbers keep counting within the tab session).
      const first = taken.messages[0].attachments[0].n;
      const lastPoint = `pp${scheme}${Date.now()}`;
      await postEvent({ type: 'point', pointId: lastPoint, targets: [{ marker: first, note: 'This card: src/App.jsx:9' }], color: 'purple', duration: 0, scroll: true, ts: Date.now() });
      await page.waitForFunction(`${root}.querySelector('.box.point')`, null, { timeout: 5000 });
      const report = await getJson(`/report?id=${lastPoint}`);
      console.log(scheme, "Claude pointing at marker", first, "->", JSON.stringify(report.map((r) => [r.pageId, r.url, r.results])));
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(outDir, `point-${scheme}-4-claude-points-back.png`) });
      await context.close();
    }
  } finally {
    await browser.close();
    await stopServer(); // left running, it would refuse the next run (a new state folder)
  }
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
