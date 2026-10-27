#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4954';
// The selection bar's Changes list, without Claude: every change this session, newest first; a pick
// outlines it on the page and opens its code with the lines marked, and the mark stays while another
// file is edited. Show opens the code the same way; in a narrow window a pick stays on the page.
// Runs on examples/vite-router (the same site as hover-preview.js).
//   NODE_PATH=$(npm root -g) node test/changes-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'changes-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: changes-preview.js <site-url> <site-dir> <out-dir>');
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

// A made-up edit (the file on disk stays as it is): replace `from` with `to` on its line.
async function edit(session, rel, from, to, intent) {
  const before = fs.readFileSync(path.join(siteDir, rel), 'utf8');
  const lines = before.split('\n');
  const n = lines.findIndex((l) => l.includes(from)) + 1;
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: session, cwd: siteDir, file: path.join(siteDir, rel), relFile: rel, ts: Date.now(), intent,
    before, after: before.replace(from, to), stats: { added: 1, removed: 1 }, hints: {},
    hunks: [{ oldStart: n, newStart: n, lines: ['-' + lines[n - 1], '+' + lines[n - 1].replace(from, to)] }],
  });
}

(async () => {
  await stopServer();
  await ensureServer();
  const browser = await launchOwnPort(chromium);
  const errors = [];
  for (const [w, h] of [[1440, 820], [700, 820]]) {
    const SESSION = `changes-${w}-${Date.now()}`;
    await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
    // Skip the tour; localStorage can throw in private mode.
    await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await page.goto(siteUrl);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    await page.click('nav a:has-text("Reports")');
    await page.click('button:has-text("Customers")');
    await page.waitForTimeout(300);
    await edit(SESSION, 'src/pages/Customers.jsx', '<td>Acme</td>', '<td>Acme Corp</td>', 'Rename Acme');
    await page.waitForTimeout(700);
    await edit(SESSION, 'src/pages/Overview.jsx', 'Welcome back.', 'Welcome back, team.', 'Friendlier welcome');
    await page.waitForTimeout(1200);
    // Start from the page: code view closed, panel open.
    await q(`const d = r.querySelector('.dock'); if (d.classList.contains('on')) d.querySelector('.dhead button[title^="Close"]').click(); return true;`);
    // Select the newest edit from its card, then open the list.
    await q(`[...r.querySelectorAll('.feed .k-edit')].pop().click(); return true;`);
    await page.waitForTimeout(400);
    const btn = await q(`const b = r.querySelector('.selbar .chg'); return b ? { text: b.textContent, shown: getComputedStyle(b).display !== 'none' } : null;`);
    // The server keeps earlier test sessions' changes too, so at least these two.
    check(`${w}px: the selection bar has Changes (n)`, btn && btn.shown && Number((/Changes \((\d+)\)/.exec(btn.text) || [])[1]) >= 2, btn);
    await q(`r.querySelector('.selbar .chg').click(); return true;`);
    await page.waitForTimeout(300);
    const list = await q(`const l = r.querySelector('.chlist'); const b = l.getBoundingClientRect(); return { on: l.classList.contains('on'), items: [...l.querySelectorAll('.chi .f')].map((n) => n.textContent.replace(/\\u200e/g, '')), inside: b.top >= 0 && b.right <= innerWidth + 1 };`);
    check(`${w}px: the list shows every change, newest first, on screen`, list.on && list.items.length >= 2 && /Overview\.jsx/.test(list.items[0]) && /Customers\.jsx:5$/.test(list.items[1]) && list.inside, list);
    await page.screenshot({ path: path.join(outDir, `changes-${w}-list.png`) });

    // Pick the Customers change.
    await q(`[...r.querySelectorAll('.chlist .chi')][1].click(); return true;`);
    await page.waitForTimeout(1500);
    const picked = await q(`const d = r.querySelector('.dock'); const db = d.getBoundingClientRect();
      const top = d.classList.contains('on') ? r.elementFromPoint(db.left + db.width / 2, db.top + db.height / 2) : null;
      return { bar: r.querySelector('.selbar .st').textContent, boxes: r.querySelectorAll('.selection .box, .sel-layer .box, .box.sel').length,
        dock: d.classList.contains('on'), front: !!(top && top.closest('.dock')), marked: d.querySelectorAll('.lmark').length,
        tab: (d.querySelector('.tab.on') || {}).textContent || null, active: (r.querySelector('.chlist .chi.on .f') || {}).textContent || null,
        code: (() => { const c = [...r.querySelectorAll('.selbar button')].find((x) => x.textContent === 'Code'); return c ? getComputedStyle(c).display !== 'none' : false; })() };`);
    check(`${w}px: picking it outlines it on the page`, /Customers\.jsx:5/.test(picked.bar) && /1 element on this page/.test(picked.bar), picked);
    check(`${w}px: the picked item is marked in the list`, /Customers\.jsx:5/.test(picked.active || ''), picked);
    if (w > 760) {
      check('wide: picking opens its code, in front, lines marked', picked.dock && picked.front && picked.marked >= 1 && /Customers/.test(picked.tab || ''), picked);
      // Another file edited: the Customers mark stays.
      await edit(SESSION, 'src/pages/Settings.jsx', 'Settings', 'Your settings', 'Clearer title');
      await page.waitForTimeout(2200);
      await q(`const t = [...r.querySelectorAll('.dock .tab')].find((x) => /Customers/.test(x.textContent)); if (t) t.click(); return true;`);
      await page.waitForTimeout(300);
      const kept = await q(`return r.querySelectorAll('.dock .lmark').length`);
      check('wide: the mark stays after another file is edited', kept >= 1, kept);
      // Show opens the code with the mark again after the code view was closed.
      await q(`r.querySelector('.dock .dhead button[title^="Close"]').click(); return true;`);
      await q(`[...r.querySelectorAll('.selbar button')].find((x) => x.textContent === 'Show').click(); return true;`);
      await page.waitForTimeout(1500);
      const shown = await q(`const d = r.querySelector('.dock'); return { on: d.classList.contains('on'), marked: d.querySelectorAll('.lmark').length, tab: (d.querySelector('.tab.on') || {}).textContent || null };`);
      check('wide: Show opens the code with its lines marked', shown.on && shown.marked >= 1 && /Customers/.test(shown.tab || ''), shown);
    } else {
      check('narrow: picking stays on the page and offers Code', !picked.dock && picked.code, picked);
      await q(`[...r.querySelectorAll('.selbar button')].find((x) => x.textContent === 'Code').click(); return true;`);
      await page.waitForTimeout(1500);
      const d = await q(`const d = r.querySelector('.dock'); const b = d.getBoundingClientRect(); const top = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { on: d.classList.contains('on'), front: !!(top && top.closest('.dock')), marked: d.querySelectorAll('.lmark').length };`);
      check('narrow: Code opens it in front, lines marked', d.on && d.front && d.marked >= 1, d);
    }
    await page.screenshot({ path: path.join(outDir, `changes-${w}-picked.png`) });
    await ctx.close();
  }
  check('no page errors', errors.length === 0, errors);
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
