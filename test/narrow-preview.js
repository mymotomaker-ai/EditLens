#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4990';
// Narrow windows, without Claude: the code view at 480px wide (docked, then popped out) while an
// edit replays and three subagents with long names are followed, and the panel in a 480px-wide
// window. No text may wrap letter by letter (a label made too narrow next to buttons), and no row
// of chips or buttons may run past the edge of its window.
//
//   NODE_PATH=$(npm root -g) node test/narrow-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'narrow-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: narrow-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `narrow-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: siteDir, ts: Date.now(), backlog: false, ...ev });

// Runs in the page: text so narrow that it wraps letter by letter, and elements past their
// window's right edge (inside a scrolling row is fine: that row scrolls).
const AUDIT = `(within) => {
  const r = document.querySelector('edit-lens').shadowRoot;
  const box = r.querySelector(within).getBoundingClientRect();
  const slivers = [];
  const past = [];
  const scrolls = (e) => { for (let p = e.parentElement; p; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll') return true; } return false; };
  r.querySelectorAll(within + ' *').forEach((e) => {
    const b = e.getBoundingClientRect();
    if (!b.width || !b.height || getComputedStyle(e).visibility === 'hidden') return;
    const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join('');
    const lh = [parseFloat(getComputedStyle(e).lineHeight), parseFloat(getComputedStyle(e).fontSize) * 1.4].find((v) => Number.isFinite(v) && v > 0) || 16;
    if (own.length >= 4 && b.height > lh * 3.2 && b.width < lh * 3) slivers.push((e.className || e.tagName) + ' "' + own.slice(0, 30) + '" ' + Math.round(b.width) + 'x' + Math.round(b.height));
    if (b.right > box.right + 1 && !scrolls(e) && e.tagName !== 'svg' && !e.closest('.pane')) past.push((e.className || e.tagName) + ' ' + Math.round(b.right) + '>' + Math.round(box.right));
  });
  return { slivers: slivers.slice(0, 8), past: past.slice(0, 8) };
}`;

(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const audit = (p, within) => p.evaluate(`(${AUDIT})(${JSON.stringify(within)})`);
  let a;

  const names = ['Build Integrations page with the segmented filter', 'Build Help page with FAQ search', 'Haiku: Customers page and CSV download'];
  for (let i = 0; i < names.length; i++) await chat({ role: 'agent-start', toolUseId: 'tu' + i, description: names[i], agentType: 'general-purpose', prompt: '' });
  const appFile = path.join(siteDir, 'src', 'App.jsx');
  const before = fs.readFileSync(appFile, 'utf8');
  const lines = before.split('\n');
  const n = lines.findIndex((l) => l.includes("'312'")) + 1;
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file: appFile, relFile: 'src/App.jsx', ts: Date.now(), agentId: 'ag1', agentType: 'general-purpose',
    before, after: before.replace("'312'", "'313'"), stats: { added: 1, removed: 1 }, hints: {}, hunks: [{ oldStart: n, newStart: n, lines: ['-' + lines[n - 1], '+' + lines[n - 1].replace("'312'", "'313'")] }],
  });
  await page.waitForFunction(`${ROOT}.querySelectorAll('.pane .cl').length > 3`, null, { timeout: 10000 });
  await page.waitForTimeout(2500);

  // Replays the first edit: the timeline under the code, Home key (the timeline's edit chips, .tchip,
  // were replaced by this track in the code view redesign). The capsule then says "Replaying App.jsx".
  async function replayFirst(p) {
    await p.evaluate(`document.querySelector('edit-lens').shadowRoot.querySelector('.dock .timeline .track').focus()`);
    await p.keyboard.press('Home');
    return p.waitForFunction(`/^Replaying /.test(document.querySelector('edit-lens').shadowRoot.querySelector('.dock .dqueue').title)`, null, { timeout: 3000 })
      .then(() => true, onTimeout(false));
  }
  // The edit count in the capsule. Under 560px wide it is the short "1/1" form (the full "Edit 1 of 1"
  // is its title): on one line, inside the code view.
  const COUNT = `const d = r.querySelector('.dock').getBoundingClientRect(), s = r.querySelector('.dqueue .sh'), b = s.getBoundingClientRect();
    return { text: s.textContent, shown: getComputedStyle(s).display !== 'none', w: Math.round(b.width), h: Math.round(b.height), inside: b.right <= d.right + 1, title: r.querySelector('.dqueue').title };`;
  const countOk = (c) => c.shown && /^(\d+|–)\/\d+$/.test(c.text) && c.w > 0 && c.h < 30 && c.inside;

  // Docked, 480px wide, replaying, following an agent.
  // Its width set the way a user does: dragging the divider between the page and the code view (a width
  // set on its style is replaced as soon as the code view is placed again).
  const rz = await q(`const b = r.querySelector('.dock .resizer').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
  await page.mouse.move(rz.x, rz.y);
  await page.mouse.down();
  await page.mouse.move(1280 - 480, rz.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const dw = await q(`const d = r.querySelector('.dock'); return { w: Math.round(d.getBoundingClientRect().width), narrow: d.classList.contains('narrow') };`);
  check('the docked code view is 480px wide, in its narrow layout', dw.w === 480 && dw.narrow, dw);
  // The agents are in the Follow menu now (the Follow chip in the header opens it), no longer in a
  // Follow row in the code view: the long names must fit there too.
  await q(`r.querySelector('.dock .dhead .fhead').click(); return true;`);
  await page.waitForTimeout(250);
  a = await audit(page, '.lwrap .follow');
  check('Follow menu at 480px: no letter-by-letter text, nothing past its edge', a.slivers.length === 0 && a.past.length === 0, a);
  check('Follow menu inside the window', await q(`const b = r.querySelector('.lwrap .follow').getBoundingClientRect(); return b.left >= 0 && b.right <= innerWidth;`));
  await q(`[...r.querySelectorAll('.lwrap .follow .fchip.achip')].find((b) => b.textContent.startsWith('Build Integrations')).click(); return true;`);
  check('following the agent: the Follow chip says so', /^Following Build Integrations/.test(await q(`return r.querySelector('.dock .dhead .fhead').textContent`)),
    await q(`return r.querySelector('.dock .dhead .fhead').textContent`));
  check('docked code view: the replay starts', await replayFirst(page));
  a = await audit(page, '.dock');
  check('docked code view, replaying: no letter-by-letter text', a.slivers.length === 0, a.slivers);
  check('docked code view: nothing runs past the edge', a.past.length === 0, a.past);
  const count = await q(COUNT);
  check('the edit count is on screen and readable', countOk(count), count);
  await page.screenshot({ path: path.join(outDir, 'narrow-1-docked.png'), clip: { x: 1280 - 480, y: 0, width: 480, height: 800 } });

  // Popped out at 480px wide: the View menu (⋯), In its own window.
  await q(`r.querySelector('.dhead .dview').click(); return true;`);
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 5000 }),
    q(`r.querySelector('.lmenu [data-act=popout]').click(); return true;`),
  ]);
  await popup.setViewportSize({ width: 480, height: 760 });
  await page.waitForTimeout(300);
  check('popped-out code view: the replay starts', await replayFirst(popup));
  a = await audit(popup, '.dock');
  check('popped-out code view at 480px, replaying: no letter-by-letter text', a.slivers.length === 0, a.slivers);
  check('popped-out code view: nothing runs past the edge', a.past.length === 0, a.past);
  const popCount = await popup.evaluate(`(() => { const r = document.querySelector('edit-lens').shadowRoot; ${COUNT} })()`);
  check('popped-out code view: the edit count is on screen and readable', countOk(popCount), popCount);
  await popup.screenshot({ path: path.join(outDir, 'narrow-2-popped.png') });
  await popup.close();
  await page.waitForTimeout(300);

  // The panel in a 480px-wide window, every tab.
  await page.setViewportSize({ width: 480, height: 760 });
  await q(`r.querySelector('.dhead [title^="Close the code view"]').click(); return true;`);
  for (const f of ['all', 'agents', 'team']) {
    await q(`r.querySelector('.filters [data-f=${f}]').click(); return true;`);
    await page.waitForTimeout(250);
    a = await audit(page, '.panel');
    check(`panel at 480px, ${f} tab: no letter-by-letter text, nothing past the edge`, a.slivers.length === 0 && a.past.length === 0, a);
  }
  await page.screenshot({ path: path.join(outDir, 'narrow-3-panel.png') });
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
