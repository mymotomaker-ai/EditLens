#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4991';
// The floating pieces never cover each other: the pill (minimized panel), the selection bar, its
// Changes list, a message (toast) and the panel, in wide, narrow and phone windows, with the panel
// open or minimized, in a bottom or top corner, and with the code view docked at the bottom. On a
// phone the panel's corner grip sets a size kept for phones only. Runs on examples/vite-router.
//   NODE_PATH=$(npm root -g) node test/overlap-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'overlap-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: overlap-preview.js <site-url> <site-dir> <out-dir>');
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

// Runs in the page: each visible floating piece's box, and the pairs that overlap.
const OVERLAPS = `(() => {
  const r = document.querySelector('edit-lens').shadowRoot;
  const pick = { pill: '.pill.on', bar: '.selbar.on', list: '.chlist.on:not(.nobar)', toast: '.toast.on', panel: '.panel:not(.min):not(.hidden)' };
  const boxes = {};
  for (const k in pick) {
    const n = r.querySelector(pick[k]);
    if (!n || getComputedStyle(n).display === 'none' || getComputedStyle(n).visibility === 'hidden') continue;
    const b = n.getBoundingClientRect();
    if (b.width && b.height) boxes[k] = { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) };
  }
  const keys = Object.keys(boxes);
  const hits = [];
  for (let i = 0; i < keys.length; i++) for (let j = i + 1; j < keys.length; j++) {
    const a = boxes[keys[i]], b = boxes[keys[j]];
    const pair = keys[i] + '×' + keys[j];
    // The list (opened by you) and a message may sit over the panel when there is no other room.
    if (/panel/.test(pair) && /list|toast/.test(pair)) continue;
    if (a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1) hits.push(pair);
  }
  const off = keys.filter((k) => { const b = boxes[k]; return b.l < -1 || b.t < -1 || b.r > innerWidth + 1 || b.b > innerHeight + 1; });
  return { boxes, hits, off };
})()`;

async function edit(session, rel, from, to) {
  const before = fs.readFileSync(path.join(siteDir, rel), 'utf8');
  const lines = before.split('\n');
  const n = lines.findIndex((l) => l.includes(from)) + 1;
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: session, cwd: siteDir, file: path.join(siteDir, rel), relFile: rel, ts: Date.now(),
    before, after: before.replace(from, to), stats: { added: 1, removed: 1 }, hints: {},
    hunks: [{ oldStart: n, newStart: n, lines: ['-' + lines[n - 1], '+' + lines[n - 1].replace(from, to)] }],
  });
}

(async () => {
  await stopServer();
  await ensureServer();
  const browser = await launchOwnPort(chromium);
  const errors = [];
  const cases = [
    { w: 1280, h: 800, panel: 'min' },
    { w: 1280, h: 800, panel: 'open', corner: 'bl' },
    { w: 1280, h: 800, panel: 'min', corner: 'bl' },
    { w: 1280, h: 800, panel: 'min', dock: 'bottom' },
    { w: 700, h: 700, panel: 'min' },
    { w: 700, h: 700, panel: 'open' },
    { w: 400, h: 760, panel: 'min' },
    { w: 400, h: 760, panel: 'open' },
    { w: 360, h: 640, panel: 'min', corner: 'bl' },
  ];
  for (const c of cases) {
    const name = `${c.w}×${c.h} panel ${c.panel}${c.corner ? ' ' + c.corner : ''}${c.dock ? ' dock ' + c.dock : ''}`;
    const SESSION = `overlap-${Date.now()}`;
    await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
    await page.addInitScript((cfg) => {
      try {
        localStorage.setItem('editlens.tourDone', '1');
        localStorage.setItem('editlens.layout', JSON.stringify({ panel: { mode: 'corner', corner: cfg.corner || 'br' }, dock: { mode: cfg.dock || 'right' } }));
        localStorage.setItem('editlens.dock', 'closed');
      } catch (err) {
        // Private mode or a full store: the page starts without these.
        if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
      }
    }, c);
    await page.goto(siteUrl);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    await page.click('nav a:has-text("Reports")');
    await page.click('button:has-text("Customers")');
    await edit(SESSION, 'src/pages/Customers.jsx', '<td>Acme</td>', '<td>Acme Corp</td>');
    await page.waitForTimeout(1000);
    if (c.dock) await q(`r.querySelector('.panel .head .tools button[title^="Split screen"]').click(); return true;`);
    else await q(`const d = r.querySelector('.dock'); if (d.classList.contains('on')) d.querySelector('.dhead button[title^="Close"]').click(); return true;`);
    // A selection (the bar), the Changes list open, then the panel state and a message.
    await q(`[...r.querySelectorAll('.feed .k-edit')].pop().click(); return true;`);
    await page.waitForTimeout(300);
    await q(`const b = r.querySelector('.selbar .chg'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); return true;`);
    if (c.panel === 'min') await q(`r.querySelector('.panel .head .tools button[title*="inimize"], .panel .head .tools button[aria-label*="inimize"]') ? r.querySelector('.panel .head .tools button[title*="inimize"], .panel .head .tools button[aria-label*="inimize"]').click() : null; return true;`);
    await page.waitForTimeout(300);
    // Two clicks place the bar again after the panel moved.
    await q(`r.querySelector('.selbar .chg').click(); r.querySelector('.selbar .chg').click(); return true;`);
    // A message, placed as one would be (the size changes with its text).
    await page.evaluate(`(() => { const r = ${ROOT}; const t = r.querySelector('.toast'); t.textContent = 'Copied. Paste it into Claude Code.'; t.classList.add('on'); return true; })()`);
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(600);
    const o = await page.evaluate(OVERLAPS);
    const expect = ['bar', c.panel === 'min' ? 'pill' : 'panel'];
    check(`${name}: bar and ${expect[1]} shown`, expect.every((k) => o.boxes[k]), o.boxes);
    check(`${name}: nothing covers anything`, o.hits.length === 0, o);
    check(`${name}: all inside the window`, o.off.length === 0, o);
    await page.screenshot({ path: path.join(outDir, `overlap-${c.w}x${c.h}-${c.panel}${c.corner ? '-' + c.corner : ''}${c.dock ? '-dock' : ''}.png`) });
    await ctx.close();
  }

  // Phone: resize the panel with its corner grip; kept after reload, and the wide size is untouched.
  const ctx = await browser.newContext({ viewport: { width: 400, height: 760 }, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  // Skip the tour; localStorage can throw in private mode.
  await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  await page.waitForTimeout(400);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const grip = await q(`const g = r.querySelector('.panel > .grip'); const b = g.getBoundingClientRect(); return getComputedStyle(g).display !== 'none' && b.width >= 24 ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;`);
  check('phone: the panel has a resize grip', Boolean(grip), grip);
  if (grip) {
    const before = await q(`const b = r.querySelector('.panel').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) };`);
    await page.mouse.move(grip.x, grip.y);
    await page.mouse.down();
    await page.mouse.move(grip.x + 60, grip.y + 160, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const after = await q(`const b = r.querySelector('.panel').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), l: Math.round(b.left), r: Math.round(b.right), b: Math.round(b.bottom) };`);
    check('phone: dragging the grip makes it narrower and shorter, still inside', after.w < before.w - 40 && after.h < before.h - 120 && after.l >= 0 && after.r <= 400 && after.b <= 760, { before, after });
    await page.reload();
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
    await page.waitForTimeout(400);
    const kept = await q(`const b = r.querySelector('.panel').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) };`);
    check('phone: the size is kept after reload', Math.abs(kept.w - after.w) <= 2 && Math.abs(kept.h - after.h) <= 2, { after, kept });
    const L = await page.evaluate(() => JSON.parse(localStorage.getItem('editlens.layout') || '{}').panel || {});
    check('phone: kept apart from the wide-window size', Number.isFinite(L.pw) && Number.isFinite(L.ph) && L.w == null && L.h == null, L);
    // Nothing in the narrower panel wraps letter by letter.
    const slivers = await q(`const out = []; r.querySelectorAll('.panel *').forEach((e) => {
      const b = e.getBoundingClientRect(); if (!b.width || !b.height) return;
      const own = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue.trim()).join('');
      const lh = [parseFloat(getComputedStyle(e).lineHeight), parseFloat(getComputedStyle(e).fontSize) * 1.4].find((v) => Number.isFinite(v) && v > 0) || 16;
      if (own.length >= 4 && b.height > lh * 3.2 && b.width < lh * 3) out.push((e.className || e.tagName) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    }); return out.slice(0, 6);`);
    check('phone, narrower panel: no text squeezed to a sliver', slivers.length === 0, slivers);
    await page.screenshot({ path: path.join(outDir, 'overlap-phone-resized.png') });
  }
  await ctx.close();
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
