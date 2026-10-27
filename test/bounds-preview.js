#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4953';
// Every movable window keeps its header on screen, so it can always be moved or closed: the Agents
// switcher opened near the top or bottom edge, a smaller window, a saved position off screen, floating
// panels in a window smaller than their minimum, the code view collapsed to its bar, the bottom bars.
//
//   NODE_PATH=$(npm root -g) node test/bounds-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'bounds-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: bounds-preview.js <site-url> <site-dir> <out-dir>');
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
const chat = (role, extra) => postEvent({ type: 'chat', role, cwd: siteDir, ts: Date.now(), ...extra });

(async () => {
  await stopServer();
  await ensureServer();
  const browser = await launchOwnPort(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 820 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  // Skip the tour; localStorage can throw in private mode.
  await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
  await page.goto(siteUrl);
  await page.evaluate(() => { localStorage.removeItem('editlens.layout'); localStorage.removeItem('editlens.agentsOpen'); });
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  await page.waitForTimeout(600);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const box = (sel) => q(`const n = r.querySelector(${JSON.stringify(sel)}); if (!n) return null; const b = n.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), w: innerWidth, h: innerHeight };`);
  const inside = (b) => b && b.l >= -1 && b.t >= -1 && b.r <= b.w + 1 && b.b <= b.h + 1;
  const headIn = (b) => b && b.t >= -1 && b.b <= b.h + 1 && b.l >= -1 && b.r <= b.w + 1;

  // Many subagents, so the open list is long.
  for (let i = 0; i < 12; i++) {
    await chat('agent-start', { toolUseId: `toolu_${i}`, agentType: 'general-purpose', description: `Subagent number ${i + 1}`, prompt: 'Work.' });
  }
  await page.waitForTimeout(900);
  const isOpen = () => q(`return r.querySelector('.asw').classList.contains('open')`);
  async function setOpen(on) {
    if ((await isOpen()) !== on) await q(`r.querySelector('.swhead').click(); return true;`);
    await page.waitForTimeout(450);
  }
  async function drag(toX, toY) {
    const h = await box('.swhead');
    await page.mouse.move(h.l + 30, h.t + 10);
    await page.mouse.down();
    await page.mouse.move(h.l + 40, h.t + 25, { steps: 2 });
    await page.mouse.move(toX, toY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(450);
  }

  // 1. Dragged to the top, then opened: grows downward, all of it on screen.
  await setOpen(false);
  await drag(400, 12);
  await setOpen(true);
  let s = await box('.asw');
  let h = await box('.swhead');
  check('top: header on screen after opening', headIn(h), h);
  check('top: grows downward, whole switcher inside the window', inside(s) && h.t - s.t <= 2, s);
  const scrolls = await q(`const l = r.querySelector('.swlist'); return l.scrollHeight > l.clientHeight + 2 || l.getBoundingClientRect().bottom <= innerHeight;`);
  check('top: the list scrolls inside it', scrolls);
  await page.screenshot({ path: path.join(outDir, 'bounds-1-top.png') });

  // 2. Dragged by the header to the bottom while open: grows upward, still inside.
  await drag(400, 800);
  s = await box('.asw');
  h = await box('.swhead');
  check('bottom: header on screen', headIn(h), h);
  check('bottom: whole switcher inside the window', inside(s), s);
  await page.screenshot({ path: path.join(outDir, 'bounds-2-bottom.png') });

  // 3. The window shrinks: pulled back in.
  await drag(1200, 30);
  await page.setViewportSize({ width: 480, height: 360 });
  await page.waitForTimeout(600);
  h = await box('.swhead');
  s = await box('.asw');
  check('window shrinks to 480×360: header on screen', headIn(h), h);
  check('window shrinks: whole switcher inside', inside(s), s);
  await page.screenshot({ path: path.join(outDir, 'bounds-3-shrunk.png') });
  await page.setViewportSize({ width: 1366, height: 820 });
  await page.waitForTimeout(400);

  // 4. A saved position far off screen: pulled back in on load. Esc still works from its list.
  await page.evaluate(() => localStorage.setItem('editlens.layout', JSON.stringify({ agents: { x: 9000, b: 9000 } })));
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  for (let i = 0; i < 12; i++) await chat('agent-start', { toolUseId: `toolu_r${i}`, agentType: 'general-purpose', description: `Again ${i + 1}`, prompt: 'Work.' });
  await page.waitForTimeout(900);
  await setOpen(true);
  h = await box('.swhead');
  s = await box('.asw');
  check('saved off-screen position: header on screen', headIn(h), h);
  check('saved off-screen position: whole switcher inside', inside(s), s);

  // 5. Floating panel and floating code view in a window smaller than their minimum size.
  await page.evaluate(() => localStorage.setItem('editlens.layout', JSON.stringify({ panel: { mode: 'float', x: 5000, y: 5000, w: 900, h: 900 }, dock: { mode: 'float', x: -400, y: 3000, w: 2000, h: 2000 } })));
  await page.setViewportSize({ width: 320, height: 300 });
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  await page.waitForTimeout(700);
  await q(`[...r.querySelectorAll('button')].find((b) => /^Split screen/.test(b.title || '')).click(); return true;`);
  await page.waitForTimeout(500);
  const ph = await box('.panel .head');
  check('320×300: the panel header is on screen', headIn(ph), ph);
  const dh = await box('.dock .dhead');
  check('320×300: the floating code view header is on screen', headIn(dh), dh);
  check('320×300: the floating code view is inside the window', inside(await box('.dock')), await box('.dock'));
  await page.screenshot({ path: path.join(outDir, 'bounds-4-tiny.png') });
  await page.setViewportSize({ width: 1366, height: 260 });
  await page.waitForTimeout(500);
  const ph2 = await box('.panel .head');
  check('a short window (260px): the panel header is on screen', headIn(ph2), ph2);

  // 6. The code view collapsed to a narrow bar.
  await page.evaluate(() => localStorage.removeItem('editlens.layout'));
  await page.setViewportSize({ width: 1366, height: 820 });
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  await page.waitForTimeout(600);
  const openDock = () => q(`const b = [...r.querySelectorAll('button')].find((x) => /^Split screen/.test(x.title || '')); if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true;`);
  const dockW = () => q(`const d = r.querySelector('.dock'); const b = d.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom), rail: d.classList.contains('rail'), shift: getComputedStyle(document.documentElement).marginRight, shiftL: getComputedStyle(document.documentElement).marginLeft, pad: getComputedStyle(document.documentElement).paddingBottom, vw: innerWidth, vh: innerHeight };`);
  await openDock();
  await page.waitForTimeout(500);
  await q(`r.querySelector('.dock .dtab').click(); return true;`);
  await page.waitForTimeout(400);
  let d = await dockW();
  check('collapse: a 30px bar on the right, and the page keeps the rest', d.rail && d.w === 30 && d.r === d.vw && d.shift === '30px', d);
  const pb = await box('.panel');
  check('collapse: the panel moves over next to the bar', pb && pb.r <= d.l - 10 && pb.r >= d.l - 30, { panel: pb, bar: d.l });
  await page.screenshot({ path: path.join(outDir, 'bounds-5-rail.png') });
  await q(`r.querySelector('.dock .drail').click(); return true;`);
  await page.waitForTimeout(400);
  d = await dockW();
  check('clicking the bar expands it', !d.rail && d.w > 300, d);
  await page.keyboard.press('Alt+Shift+D');
  await page.waitForTimeout(400);
  check('Alt+Shift+D collapses it', (await dockW()).rail);
  // A new request, then its first edit: open again.
  const app = fs.existsSync(path.join(siteDir, 'src', 'App.jsx')) ? path.join(siteDir, 'src', 'App.jsx') : path.join(siteDir, 'index.html');
  const text = fs.readFileSync(app, 'utf8');
  const first = text.split('\n')[0];
  await postEvent({ type: 'prompt', cwd: siteDir, ts: Date.now(), text: 'change the title' });
  await page.waitForTimeout(200);
  await postEvent({ type: 'change', kind: 'frontend', tool: 'Edit', cwd: siteDir, file: app, relFile: path.relative(siteDir, app), ts: Date.now(),
    before: text, after: text.replace(first, first + ' '), stats: { added: 1, removed: 1 }, hints: {}, hunks: [{ oldStart: 1, newStart: 1, lines: ['-' + first, '+' + first + ' '] }] });
  check('the first edit of a new request expands it', await page.waitForFunction(`!${ROOT}.querySelector('.dock').classList.contains('rail')`, null, { timeout: 4000 }).then(() => true, onTimeout(false)));
  await page.keyboard.press('Alt+Shift+D');
  await page.waitForTimeout(300);
  await postEvent({ type: 'change', kind: 'frontend', tool: 'Edit', cwd: siteDir, file: app, relFile: path.relative(siteDir, app), ts: Date.now(),
    before: text, after: text.replace(first, first + '  '), stats: { added: 1, removed: 1 }, hints: {}, hunks: [{ oldStart: 1, newStart: 1, lines: ['-' + first, '+' + first + '  '] }] });
  await page.waitForTimeout(900);
  d = await dockW();
  const count = await q(`return r.querySelector('.drail .rn').textContent`);
  check('collapsed again in the same request: stays collapsed and counts the edit', d.rail && count === '1', { d, count });
  // Narrow window: still a 30px bar inside the window.
  await page.setViewportSize({ width: 480, height: 700 });
  await page.waitForTimeout(400);
  d = await dockW();
  check('480px: the bar stays 30px on the right edge', d.rail && d.w === 30 && d.r === 480 && d.l === 450, d);
  await page.setViewportSize({ width: 1366, height: 820 });
  // Docked left and bottom.
  for (const mode of ['left', 'bottom']) {
    await page.evaluate((m) => localStorage.setItem('editlens.layout', JSON.stringify({ dock: { mode: m } })), mode);
    await page.reload();
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
    await page.waitForTimeout(500);
    await openDock();
    await page.waitForTimeout(500);
    d = await dockW();
    const ok = mode === 'left' ? d.rail && d.w === 30 && d.l === 0 && d.shiftL === '30px' : d.rail && d.h === 30 && d.b === d.vh && d.pad === '30px';
    check(`docked ${mode}, remembered as collapsed: a 30px bar at the ${mode} edge`, ok, d);
    await page.screenshot({ path: path.join(outDir, `bounds-6-rail-${mode}.png`) });
  }
  await page.keyboard.press('Alt+Shift+D');
  await page.waitForTimeout(400);
  check('Alt+Shift+D expands it again', !(await dockW()).rail);
  await page.evaluate(() => localStorage.removeItem('editlens.dockCollapsed'));

  // 7. The bars at the bottom (the code view's Recent edits, the panel's message box) stay on
  // screen at every dock position and window size, and folding Recent edits leaves its bar.
  const shown = (sel) => q(`const n = r.querySelector(${JSON.stringify(sel)}); return !!n && getComputedStyle(n).display !== 'none';`);
  for (const mode of ['right', 'bottom', 'float']) {
    for (const [w, h] of [[1280, 800], [1280, 420], [900, 320]]) {
      await page.setViewportSize({ width: w, height: h });
      await page.evaluate((m) => { localStorage.setItem('editlens.layout', JSON.stringify({ dock: { mode: m } })); localStorage.setItem('editlens.timeline', 'on'); }, mode);
      await page.reload();
      await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
      await page.waitForTimeout(400);
      await openDock();
      await page.waitForTimeout(400);
      if ((await dockW()).rail) { await page.keyboard.press('Alt+Shift+D'); await page.waitForTimeout(300); }
      const tl = await box('.timeline');
      check(`${mode} ${w}×${h}: Recent edits on screen`, (await shown('.timeline')) && inside(tl), tl);
      const comp = await box('.panel .composer');
      check(`${mode} ${w}×${h}: the panel's message box on screen`, inside(comp), comp);
      const ph = await box('.panel .head');
      check(`${mode} ${w}×${h}: the panel header on screen`, headIn(ph), ph);
      if (h < 800) await page.screenshot({ path: path.join(outDir, `bounds-7-${mode}-${w}x${h}.png`) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await q(`r.querySelector('.tlfold').click(); return true;`);
  await page.waitForTimeout(200);
  const folded = await q(`const t = r.querySelector('.timeline'); return { off: t.classList.contains('off'), shown: getComputedStyle(t).display !== 'none', fold: r.querySelector('.tlfold').textContent, title: t.querySelector('.tlhead b').textContent };`);
  check('Hide folds Recent edits to a bar that stays, with Show', folded.off && folded.shown && folded.fold === 'Show' && /^Recent edits/.test(folded.title), folded);
  await page.screenshot({ path: path.join(outDir, 'bounds-7-folded.png') });
  await q(`r.querySelector('.tlfold').click(); return true;`);
  check('Show opens it again', !(await q(`return r.querySelector('.timeline').classList.contains('off')`)));
  await page.evaluate(() => localStorage.removeItem('editlens.timeline'));

  check('no page errors', errors.length === 0, errors);
  await page.evaluate(() => localStorage.removeItem('editlens.layout'));
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
