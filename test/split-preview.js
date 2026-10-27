'use strict';
require('./isolate');
// Resizing in the code view and the panel, on a real page and server, without Claude: the split
// view divider (drag, arrow keys, Home/End, double-click reset, touch; sizes kept after a reload;
// minimum sizes; bad saved sizes ignored; popped out and narrow), the page / code view divider, and
// the resize grips.
// usage: NODE_PATH=$(npm root -g) node test/split-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: split-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-split-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5210' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, d = 3) => Math.abs(a - b) <= d;

const PAGE = `<!doctype html><title>Split</title><body style="font:16px system-ui;margin:40px"><h1>Split</h1>
<script src="http://127.0.0.1:5210/live.js" data-root="${proj}" data-panel="open"></script></body>`;

let n = 0;
async function edit(name) {
  const lines = Array.from({ length: 30 }, (_, i) => `const ${name}${i} = ${i};`);
  const after = lines.slice();
  after[2] = `const ${name}2 = ${++n * 100};`;
  const file = path.join(proj, 'src', name + '.js');
  fs.writeFileSync(file, after.join('\n') + '\n');
  await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file, relFile: 'src/' + name + '.js', tool: 'Edit', kind: 'frontend',
    before: lines.join('\n') + '\n', after: after.join('\n') + '\n', hunks: [{ oldStart: 3, newStart: 3, lines: ['-' + lines[2], '+' + after[2]] }],
    stats: { added: 1, removed: 1 }, ts: Date.now() });
}

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now() });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const errors = [];
  const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
  // Panes (each with its tab row) and dividers as boxes, in the given window.
  const state = (pg) => pg.evaluate(`(() => {
    const r = ${ROOT};
    const box = (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
    const panes = [...r.querySelectorAll('.pgrp')].filter((g) => g.getClientRects().length).sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0)).map(box);
    const divs = [...r.querySelectorAll('.psplit.on')].map((d) => Object.assign(box(d), { now: d.getAttribute('aria-valuenow'), role: d.getAttribute('role'), tab: d.tabIndex, cursor: getComputedStyle(d).cursor, touch: getComputedStyle(d).touchAction }));
    return { dir: r.querySelector('.panes').getAttribute('data-dir'), panes, divs, saved: localStorage.getItem('editlens.splitSizes') };
  })()`);
  async function openPage(ctxOpts, init) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 860 } }, ctxOpts));
    await ctx.addInitScript((extra) => {
      try {
        localStorage.setItem('editlens.tourDone', '1');
        Object.keys(extra || {}).forEach((k) => { if (!sessionStorage.getItem('seeded.' + k)) { localStorage.setItem(k, extra[k]); sessionStorage.setItem('seeded.' + k, '1'); } });
      } catch (err) {
        // Private mode or a full store: the page starts without these.
        if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
      }
    }, init || {});
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    return { ctx, page };
  }
  async function threeFiles(page) {
    await edit('alpha');
    await sleep(400);
    await edit('beta');
    await sleep(400);
    await edit('gamma');
    await page.waitForFunction(`${ROOT}.querySelectorAll('.pane').length >= 3 && ${ROOT}.querySelector('.psplit.on')`, null, { timeout: 15000 });
    // The panel would cover the code view's grip and dividers in some layouts.
    await page.evaluate(`[...${ROOT}.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Minimize') && [...${ROOT}.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Minimize').click()`);
    await sleep(2500);
  }
  async function drag(pg, d, dx, dy) {
    const cx = d.x + d.w / 2;
    const cy = d.y + d.h / 2;
    await pg.mouse.move(cx, cy);
    await pg.mouse.down();
    await pg.mouse.move(cx + dx / 2, cy + dy / 2);
    await pg.mouse.move(cx + dx, cy + dy);
    await pg.mouse.up();
    await sleep(150);
  }
  try {
    let ctx;
    let page;
    await section('stacked split: drag, limits, keyboard, double-click, reload', async () => {
      ({ ctx, page } = await openPage());
      await threeFiles(page);
      let s = await state(page);
      check('docked right: files stacked with dividers between them', s.dir === 'rows' && s.panes.length >= 2 && s.divs.length === s.panes.length - 1, s);
      const d0 = s.divs[0];
      check('divider: role separator, focusable, row-resize cursor, no touch scrolling', d0.role === 'separator' && d0.tab === 0 && d0.cursor === 'row-resize' && d0.touch === 'none', d0);
      // The drag area is wider than the 1px line.
      const hit = await page.evaluate(`(() => { const r = ${ROOT}; const d = r.querySelector('.psplit.on'); const b = d.getBoundingClientRect(); const at = r.elementFromPoint(b.left + b.width / 2, b.top + 4); return at === d; })()`);
      check('the divider can be dragged from 4px away from its line', hit);
      await page.screenshot({ path: path.join(outDir, 'split-1-stacked.png') });
      const h0 = s.panes[0].h;
      await drag(page, d0, 0, 60);
      s = await state(page);
      check('drag down 60px: the first file is 60px taller', near(s.panes[0].h, h0 + 60, 4), [h0, s.panes[0].h]);
      check('sizes saved', /rows/.test(s.saved || ''), s.saved);
      await drag(page, s.divs[0], 0, 2000);
      s = await state(page);
      const minH = Math.min.apply(null, s.panes.map((p) => p.h));
      check('dragged far: no file goes under its minimum', minH >= 80, s.panes.map((p) => p.h));
      await drag(page, s.divs[0], 0, -2000);
      s = await state(page);
      check('dragged far the other way: still at the minimum or more', Math.min.apply(null, s.panes.map((p) => p.h)) >= 80, s.panes.map((p) => p.h));
      // Keyboard.
      await page.evaluate(`${ROOT}.querySelector('.psplit.on').focus()`);
      s = await state(page);
      const before = s.panes[0].h;
      const nowBefore = s.divs[0].now;
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      s = await state(page);
      check('ArrowDown twice: 32px taller', near(s.panes[0].h, before + 32, 3), [before, s.panes[0].h]);
      check('aria-valuenow follows', s.divs[0].now !== nowBefore, [nowBefore, s.divs[0].now]);
      await page.keyboard.press('End');
      s = await state(page);
      const minEnd = s.panes[1].h;
      await page.keyboard.press('Home');
      s = await state(page);
      check('End then Home: each file at the minimum on its side', minEnd >= 80 && minEnd < 140 && s.panes[0].h >= 80 && s.panes[0].h < 140, [minEnd, s.panes[0].h]);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      s = await state(page);
      const kept = s.panes.map((p) => Math.round(p.h));
      await page.reload();
      await page.waitForFunction(`${ROOT}.querySelectorAll('.pgrp:not(.empty)').length >= 2 && ${ROOT}.querySelector('.psplit.on')`, null, { timeout: 15000 });
      await sleep(800);
      s = await state(page);
      check('sizes stay after a reload', s.panes.length === kept.length && s.panes.every((p, i) => near(p.h, kept[i], 3)), [kept, s.panes.map((p) => Math.round(p.h))]);
      await page.mouse.dblclick(s.divs[0].x + s.divs[0].w / 2, s.divs[0].y + s.divs[0].h / 2);
      await sleep(150);
      s = await state(page);
      check('double-click: all files the same size again', s.panes.every((p) => near(p.h, s.panes[0].h, 2)) && !/rows3/.test(s.saved || ''), [s.panes.map((p) => p.h), s.saved]);
    });

    await section('page/code view divider', async () => {
      const width = () => page.evaluate(`${ROOT}.querySelector('.dock').getBoundingClientRect().width`);
      const w0 = await width();
      const rz = await page.evaluate(`(() => { const d = ${ROOT}.querySelector('.resizer'); d.focus(); return [d.getAttribute('role'), d.tabIndex, getComputedStyle(d).touchAction]; })()`);
      check('page divider: separator, focusable, no touch scrolling', rz[0] === 'separator' && rz[1] === 0 && rz[2] === 'none', rz);
      await page.keyboard.press('ArrowLeft');
      check('ArrowLeft on the page divider: code view 16px wider', near(await width(), w0 + 16, 2), [w0, await width()]);
      check('the width is remembered', (await page.evaluate(() => localStorage.getItem('editlens.dockWidth'))) === String(Math.round(w0 + 16)), await page.evaluate(() => localStorage.getItem('editlens.dockWidth')));
      await page.keyboard.press('End');
      check('End: the code view at its minimum (320px)', near(await width(), 320, 1), await width());
      const r = await page.evaluate(`(() => { const b = ${ROOT}.querySelector('.resizer').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 200 }; })()`);
      await page.mouse.dblclick(r.x, r.y);
      await sleep(200);
      // The default: 42% of the window, at least 640 px (room for the sidebar beside the code).
      check('double-click: the default width again', near(await width(), Math.max(640, Math.round(1280 * 0.42)), 2) && (await page.evaluate(() => localStorage.getItem('editlens.dockWidth'))) === null, await width());
      await page.screenshot({ path: path.join(outDir, 'split-2-after-divider.png') });
    });

    await section('bad saved sizes are ignored', async () => {
      await page.evaluate(() => localStorage.setItem('editlens.splitSizes', '{"rows3":[-1,"x",null],"rows2":"no","__proto__":[1]}'));
      await page.reload();
      await page.waitForFunction(`${ROOT}.querySelectorAll('.pgrp:not(.empty)').length >= 2 && ${ROOT}.querySelector('.psplit.on')`, null, { timeout: 15000 });
      await sleep(600);
      const s = await state(page);
      check('junk in storage: even sizes', s.panes.every((p) => near(p.h, s.panes[0].h, 2)), s.panes.map((p) => p.h));
      await page.evaluate(() => localStorage.setItem('editlens.splitSizes', '{not json'));
      await page.reload();
      await page.waitForFunction(`${ROOT}.querySelector('.psplit.on')`, null, { timeout: 15000 });
      check('unreadable storage: still opens', true);
    });

    await section('popped-out code window', async () => {
      await page.evaluate(`${ROOT}.querySelector('.dhead button[aria-label="View"]').click()`);
      const [win] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 5000 }),
        page.evaluate(`${ROOT}.querySelector('.lmenu [data-act=popout]').click()`),
      ]);
      await win.setViewportSize({ width: 560, height: 820 });
      await sleep(700);
      let s = await state(win);
      check('popped-out window: dividers there too', s.divs.length >= 1, s);
      const h0 = s.panes[0].h;
      await drag(win, s.divs[0], 0, 50);
      s = await state(win);
      check('drag in the popped-out window: 50px taller', near(s.panes[0].h, h0 + 50, 4), [h0, s.panes[0].h]);
      await win.evaluate(`${ROOT}.querySelector('.psplit.on').focus()`);
      await win.keyboard.press('ArrowUp');
      const s2 = await state(win);
      check('arrow key in the popped-out window', near(s2.panes[0].h, s.panes[0].h - 16, 3), [s.panes[0].h, s2.panes[0].h]);
      await win.setViewportSize({ width: 1200, height: 520 });
      await sleep(500);
      s = await state(win);
      check('a wide popped-out window: files side by side', s.dir === 'cols' && s.divs.length >= 1 && s.divs[0].cursor === 'col-resize', s.dir);
      await win.screenshot({ path: path.join(outDir, 'split-3-popped-wide.png') });
      await win.close();
      await sleep(400);
    });
    await ctx.close();

    await section('side by side (docked at the bottom), narrow window, touch', async () => {
      ({ ctx, page } = await openPage({ hasTouch: true }, { 'editlens.layout': JSON.stringify({ dock: { mode: 'bottom' } }) }));
      await threeFiles(page);
      let s = await state(page);
      check('docked at the bottom: files side by side, col-resize', s.dir === 'cols' && s.divs.length === s.panes.length - 1 && s.divs[0].cursor === 'col-resize', s);
      await page.screenshot({ path: path.join(outDir, 'split-4-side-by-side.png') });
      const w0 = s.panes[0].w;
      await drag(page, s.divs[0], 80, 0);
      s = await state(page);
      check('drag right 80px: the first file 80px wider', near(s.panes[0].w, w0 + 80, 4), [w0, s.panes[0].w]);
      await page.evaluate(`${ROOT}.querySelector('.psplit.on').focus()`);
      await page.keyboard.press('ArrowLeft');
      const s2 = await state(page);
      check('ArrowLeft: 16px narrower', near(s2.panes[0].w, s.panes[0].w - 16, 3), [s.panes[0].w, s2.panes[0].w]);
      await page.keyboard.press('Home');
      const s3 = await state(page);
      check('Home: the first file at 220px', near(s3.panes[0].w, 220, 2), s3.panes[0].w);
      // Touch: a finger drags the divider (real touch events from the browser).
      const cdp = await ctx.newCDPSession(page);
      const d = s3.divs[0];
      const x = d.x + d.w / 2;
      const y = d.y + d.h / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= 5; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + i * 20, y }] });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await sleep(200);
      const s4 = await state(page);
      check('touch drag 100px: the first file 100px wider', near(s4.panes[0].w, s3.panes[0].w + 100, 6), [s3.panes[0].w, s4.panes[0].w]);
      // Narrow window: fewer files side by side, none under 220px.
      for (const w of [700, 520, 380]) {
        await page.setViewportSize({ width: w, height: 760 });
        await sleep(400);
        s = await state(page);
        const ok = s.dir === 'rows' ? s.panes.every((p) => p.h >= 80) : s.panes.every((p) => p.w >= 219);
        check(`${w}px wide: ${s.panes.length} file(s) shown ${s.dir === 'cols' ? 'side by side' : 'stacked'}, none under the minimum`, ok && s.panes.length >= 1, s.panes);
      }
      await page.screenshot({ path: path.join(outDir, 'split-5-narrow.png') });
      await ctx.close();
    });

    await section('floating code view and panel grips', async () => {
      ({ ctx, page } = await openPage({}, { 'editlens.layout': JSON.stringify({ dock: { mode: 'float' } }) }));
      await threeFiles(page);
      const dockBox = () => page.evaluate(`(() => { const b = ${ROOT}.querySelector('.dock').getBoundingClientRect(); return { w: b.width, h: b.height }; })()`);
      const b0 = await dockBox();
      const g = await page.evaluate(`(() => { const g = ${ROOT}.querySelector('.dock > .grip'); g.focus(); return [g.getAttribute('role'), g.tabIndex, ${ROOT}.activeElement === g]; })()`);
      check('code view grip: focusable', g[1] === 0 && g[2], g);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      const b1 = await dockBox();
      check('grip arrows: 20px wider and taller', near(b1.w, b0.w + 20, 2) && near(b1.h, b0.h + 20, 2), [b0, b1]);
      const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('editlens.layout')).dock);
      check('grip size remembered', near(saved.w, b1.w, 1) && near(saved.h, b1.h, 1), saved);
      await page.evaluate(`${ROOT}.querySelector('.dock > .grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await sleep(150);
      const b2 = await dockBox();
      check('grip double-click: the default size (560 wide)', near(b2.w, 560, 2), b2);
      // The panel's grip (open the panel again first).
      await page.evaluate(`(() => { const p = ${ROOT}.querySelector('.pill'); if (p && getComputedStyle(p).display !== 'none') p.click(); })()`);
      await sleep(600);
      const pw = () => page.evaluate(`${ROOT}.querySelector('.panel').getBoundingClientRect().width`);
      const p0 = await pw();
      await page.evaluate(`${ROOT}.querySelector('.panel > .grip').focus()`);
      await page.keyboard.press('ArrowLeft');
      const p1 = await pw();
      check('panel grip ArrowLeft: 20px narrower', near(p1, p0 - 20, 2), [p0, p1]);
      await page.keyboard.press('Shift+ArrowLeft');
      check('Shift+ArrowLeft: 60px more', near(await pw(), p1 - 60, 2), [p1, await pw()]);
      await page.evaluate(`${ROOT}.querySelector('.panel > .grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
      await sleep(150);
      check('panel grip double-click: the default width', near(await pw(), p0, 2) && JSON.parse(await page.evaluate(() => localStorage.getItem('editlens.layout'))).panel.w === null, [p0, await pw()]);
      await ctx.close();
    });
    check('no page errors', !errors.length, errors);
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
