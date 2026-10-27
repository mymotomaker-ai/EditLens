#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4959';
// Asking to see code always shows it: "Open in code view" and "Replay" on the hover card, and Code
// in the selection bar, open the code view where it can be seen and mark the lines, in every layout
// (collapsed, closed, panel full screen or minimized, narrow and phone-sized windows).
// Runs on examples/vite-router (the same site as hover-preview.js).
//   NODE_PATH=$(npm root -g) node test/code-open-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'code-open-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: code-open-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `open-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const REL = 'src/pages/Customers.jsx';

async function edit() {
  const before = fs.readFileSync(path.join(siteDir, REL), 'utf8');
  const lines = before.split('\n');
  const n = lines.findIndex((l) => l.includes('<td>Acme</td>')) + 1;
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file: path.join(siteDir, REL), relFile: REL, ts: Date.now(),
    before, after: before.replace('<td>Acme</td>', '<td>Acme Corp</td>'), stats: { added: 1, removed: 1 }, hints: {},
    hunks: [{ oldStart: n, newStart: n, lines: ['-' + lines[n - 1], '+' + lines[n - 1].replace('<td>Acme</td>', '<td>Acme Corp</td>')] }],
  });
}

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const errors = [];

  // setup: localStorage before load; then what to do on the page before asking for the code.
  const cases = [
    { name: 'collapsed to its bar', w: 1440, h: 820, store: { 'editlens.dockCollapsed': '1' }, open: true },
    { name: 'closed earlier', w: 1440, h: 820, store: { 'editlens.dock': 'closed' } },
    { name: 'panel full screen', w: 1440, h: 820, before: `r.querySelector('.panel .head .tools button[title*="ull screen"]').click();`, via: 'feed' },
    { name: 'panel minimized', w: 1440, h: 820, store: { 'editlens.panel': 'min' } },
    { name: 'narrow (700px)', w: 700, h: 820 },
    { name: 'phone (400px)', w: 400, h: 760 },
    { name: 'phone, Replay', w: 400, h: 760, button: 'Replay' },
  ];
  for (const c of cases) {
    const ctx = await browser.newContext({ viewport: { width: c.w, height: c.h } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
    await page.addInitScript((store) => {
      try {
        localStorage.setItem('editlens.tourDone', '1');
        Object.keys(store).forEach((k) => localStorage.setItem(k, store[k]));
      } catch (err) {
        // Private mode or a full store: the page starts without these.
        if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
      }
    }, c.store || {});
    await page.goto(siteUrl);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    if (c.open) await q(`r.querySelector('.panel .head .tools button[title^="Split screen"]').click(); return true;`);
    await page.click('nav a:has-text("Reports")');
    await page.click('button:has-text("Customers")');
    await page.waitForTimeout(300);
    await edit();
    await page.waitForTimeout(900);
    // Claude's own edit may have opened the code view; start each case from the layout it names.
    if (c.store && c.store['editlens.dock'] === 'closed') await q(`const d = r.querySelector('.dock'); const x = d.querySelector('.dhead button[title^="Close"]'); if (d.classList.contains('on') && x) x.click(); return true;`);
    // In a narrow window Claude's edit opened the code view over the page: close it to see the page.
    if (c.w <= 760) await q(`const d = r.querySelector('.dock'); if (d.classList.contains('on')) d.querySelector('.dhead button[title^="Close"]').click(); return true;`);
    if (c.before) await q(c.before + ' return true;');
    await page.waitForTimeout(300);
    const label = c.via === 'feed' ? 'Replay (edit card)' : c.button || 'Open in code view';
    if (c.via === 'feed') {
      // The page is under the full-screen panel: the edit card's Replay in the panel.
      await q(`[...r.querySelectorAll('.feed .k-edit button')].find((b) => b.textContent === 'Replay').click(); return true;`);
    } else {
      const td = await page.locator('td:has-text("Acme")').first().boundingBox();
      await page.mouse.move(4, c.h - 4);
      await page.mouse.move(td.x + 6, td.y + td.height / 2, { steps: 3 });
      const shown = await page.waitForFunction(`${ROOT}.querySelector('.peek.on')`, null, { timeout: 3000 }).then(() => true, onTimeout(false));
      check(`${c.name}: hover card shows`, shown);
      await q(`[...r.querySelectorAll('.peek .pkacts button')].find((b) => b.textContent === ${JSON.stringify(label)}).click(); return true;`);
    }
    await page.waitForTimeout(1600);
    const seen = await q(`const d = r.querySelector('.dock');
      const b = d.getBoundingClientRect();
      const x = Math.min(innerWidth - 2, Math.max(1, b.left + b.width / 2)), y = Math.min(innerHeight - 2, Math.max(1, b.top + b.height / 2));
      const top = r.elementFromPoint(x, y);
      const marked = [...d.querySelectorAll('.lmark, .cl.recent, .cl.mark-on')].filter((n) => { const nb = n.getBoundingClientRect(); return nb.height && nb.top >= b.top && nb.bottom <= b.bottom; }).length;
      return { on: d.classList.contains('on'), rail: d.classList.contains('rail'), w: Math.round(b.width), front: !!(top && top.closest('.dock')), marked, pill: r.querySelector('.pill').classList.contains('on'), tabs: [...d.querySelectorAll('.tab')].map((t) => t.textContent) };`);
    check(`${c.name}: ${label} shows the code view, in front, with the lines in view`, seen.on && !seen.rail && seen.w > 200 && seen.front && seen.marked > 0 && seen.tabs.some((t) => /Customers/.test(t)), seen);
    await page.screenshot({ path: path.join(outDir, `open-${c.name.replace(/[^a-z0-9]+/gi, '-')}.png`) });

    if (c.w <= 760 && !c.button) {
      // The selection bar's Code button (narrow only: Show stays on the page there).
      await q(`const x = r.querySelector('.dock .dhead button[title^="Close"]'); if (x) x.click(); r.querySelector('.pill').click(); return true;`);
      await page.waitForTimeout(300);
      await q(`const c = r.querySelector('.feed .k-edit'); if (c) c.click(); return true;`);
      await page.waitForTimeout(500);
      const bar = await q(`const b = [...r.querySelectorAll('.selbar button')].find((x) => x.textContent === 'Code'); return b ? getComputedStyle(b).display !== 'none' : null;`);
      if (bar) {
        await q(`[...r.querySelectorAll('.selbar button')].find((x) => x.textContent === 'Code').click(); return true;`);
        await page.waitForTimeout(1200);
        const d = await q(`const d = r.querySelector('.dock'); const b = d.getBoundingClientRect(); const top = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return { on: d.classList.contains('on'), front: !!(top && top.closest('.dock')), marked: d.querySelectorAll('.lmark').length };`);
        check(`${c.name}: the selection bar's Code opens it in front`, d.on && d.front && d.marked > 0, d);
      } else {
        check(`${c.name}: the selection bar offers Code`, bar === true, bar);
      }
    }
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
