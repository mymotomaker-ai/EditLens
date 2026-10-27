#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4985';
// Moving the panels, without running Claude: the code view is dragged away from its dock, moved to the left
// edge, docked at the bottom; the EditLens panel floats, moves to a corner and is resized; the
// layout is kept after a reload and in a smaller window; both pop out into their own windows and
// keep working there; Reset layout puts everything back.
//
//   NODE_PATH=$(npm root -g) node test/layout-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'layout-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: layout-preview.js <site-url> <site-dir> <out-dir>');
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
const appFile = path.join(siteDir, 'src', 'App.jsx');

(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 'layout-preview', cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const context = await browser.newContext({ viewport: { width: 1440, height: 860 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const box = (sel) => q(`const b = r.querySelector('${sel}').getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height), r: Math.round(b.right), b: Math.round(b.bottom) };`);
  const html = () => page.evaluate(`({ mr: document.documentElement.style.marginRight, ml: document.documentElement.style.marginLeft, pb: document.documentElement.style.paddingBottom })`);
  // Where a drag starts: an empty part of the title bar (the code view's gap between the file name and
  // the Follow chip, at the header's middle height; the panel's title and status). A drag that starts
  // on a button moves nothing.
  const HANDLE = { dock: ['.dock .dhead .dgap', '.dock .dhead'], panel: ['.panel .head .titles', '.panel .head .titles'] };
  async function grab(which) {
    const b = await box(HANDLE[which][0]);
    const bar = await box(HANDLE[which][1]);
    const at = { x: Math.round(b.x + b.w / 2), y: Math.round(bar.y + bar.h / 2) };
    const hit = await q(`const e = r.elementFromPoint(${at.x}, ${at.y}); return Boolean(e) && !e.closest('button,a,input') && e.closest('.dhead, .head') !== null;`);
    check(`the ${which} drag starts on its title bar, not on a button`, b.w >= 8 && hit, { b, at });
    return at;
  }
  // Lets go of the mouse at toX, toY; with opts.left and opts.top, where the window's top-left corner goes.
  async function drag(which, toX, toY, opts = {}) {
    const { x: sx, y: sy } = await grab(which);
    if (Number.isFinite(opts.left) && Number.isFinite(opts.top)) {
      const n = await box(which === 'dock' ? '.dock' : '.panel');
      toX = sx + opts.left - n.x;
      toY = sy + opts.top - n.y;
    }
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 10, sy + 10, { steps: 2 });
    await page.mouse.move(toX, toY, { steps: 12 });
    if (opts.shot) await page.screenshot({ path: path.join(outDir, opts.shot) });
    await page.mouse.up();
    await page.waitForTimeout(250);
  }
  // Opens a menu and clicks the entry with this name. A missing button opens no menu, so the name is
  // not found and the check fails. The name of an entry: its label without the small line under it
  // (View menu, ⋯ menu rows), its text (the ⋯ menu's tiles), or its aria-label (a spot in Panel position).
  const NAME = `(b) => { const l = b.querySelector('.lbl'); return l ? l.firstChild.nodeValue : b.textContent.trim() || b.getAttribute('aria-label'); }`;
  async function menu(button, label) {
    await q(`const b = r.querySelector('${button}'); if (b) b.click(); return Boolean(b);`);
    await page.waitForTimeout(150);
    return q(`const b = [...r.querySelectorAll('.lmenu button')].find((x) => (${NAME})(x) === ${JSON.stringify(label)}); if (b) b.click(); return Boolean(b);`);
  }

  await postEvent({ type: 'code', file: appFile, relFile: 'src/App.jsx', content: fs.readFileSync(appFile, 'utf8'), line: 7, endLine: 14, cwd: siteDir, note: null, ts: Date.now() });
  await page.waitForFunction(`${ROOT}.querySelectorAll('.pane .cl').length > 10`, null, { timeout: 8000 });
  let d = await box('.dock');
  check('code view docked right, page shifted', d.r === 1440 && (await html()).mr === d.w + 'px', { d, html: await html() });

  // Drag the code view away from its dock, then to the left edge.
  await drag('dock', 500, 300);
  d = await box('.dock');
  check('dragged away from its dock: floating, page not shifted', (await q(`return r.querySelector('.dock').classList.contains('float')`)) && (await html()).mr === '', d);
  await drag('dock', 4, 400, { shot: 'layout-1-snap-left.png' });
  d = await box('.dock');
  check('dropped at the left edge: docked left', d.x === 0 && (await html()).ml === d.w + 'px', { d, html: await html() });

  // The code view's View menu (⋯): Position, At the bottom.
  check('View menu: At the bottom', await menu('.dhead .dview', 'At the bottom'));
  await page.waitForTimeout(200);
  d = await box('.dock');
  const p1 = await box('.panel');
  check('docked at the bottom, panel above it', d.b === 860 && d.w === 1440 && p1.b <= d.y && (await html()).pb === d.h + 'px', { d, p1 });
  await page.screenshot({ path: path.join(outDir, 'layout-2-bottom.png') });

  // The panel: float it, then drop it in the top-left corner.
  await drag('panel', 700, 120);
  check('panel floats', await q(`return r.querySelector('.panel').classList.contains('float')`));
  await drag('panel', 30, 30, { shot: 'layout-3-snap-corner.png' });
  const p2 = await box('.panel');
  check('panel moved to the top-left corner', (await q(`return r.querySelector('.panel').getAttribute('data-corner')`)) === 'tl' && p2.x === 20 && p2.y === 20, p2);

  // Resize from the grip (inner corner: bottom-right for top-left).
  const g = await box('.panel > .grip');
  await page.mouse.move(g.x + 9, g.y + 9);
  await page.mouse.down();
  await page.mouse.move(g.x + 9 + 120, g.y + 9 - 150, { steps: 8 });
  await page.mouse.up();
  const p3 = await box('.panel');
  check('panel resized', p3.w === g.x + 9 + 120 - p2.x && p3.h === g.y + 9 - 150 - p2.y, { before: p2, after: p3 });

  // Remembered after a reload; kept on screen in a small window.
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  await page.waitForTimeout(600); // the panel's opening animation
  const p4 = await box('.panel');
  check('layout remembered after reload', p4.x === 20 && p4.y === 20 && p4.w === p3.w, p4);
  // The ⋯ menu has no Floating window entry now (only the four corners): dragging the panel out of
  // its corner floats it. Let go at x 700, y 250, away from the corners, so it stays there and floats.
  await drag('panel', null, null, { left: 700, top: 250 });
  const pf = await box('.panel');
  check('dragged out of its corner: panel floats where the mouse let go', (await q(`return r.querySelector('.panel').classList.contains('float')`)) && pf.x === 700 && pf.y === 250, pf);
  await page.setViewportSize({ width: 1024, height: 640 });
  await page.waitForTimeout(300);
  const p5 = await box('.panel');
  check('floating panel stays on screen after the window shrinks', pf.r > 1024 && p5.x >= 0 && p5.y >= 0 && p5.r <= 1024 && p5.b <= 640, p5);
  await page.screenshot({ path: path.join(outDir, 'layout-4-small-window.png') });

  // Pop out the panel: a pop-up (or Picture-in-Picture) window with the same, working panel.
  await page.setViewportSize({ width: 1440, height: 860 });
  // The ⋯ menu's tile "Open in new window".
  const [popup, poppedPanel] = await Promise.all([
    context.waitForEvent('page', { timeout: 5000 }),
    menu('.panel .head .icon[aria-haspopup]', 'Open in new window'),
  ]);
  check('⋯ menu: Open in new window', poppedPanel);
  await page.waitForTimeout(500);
  const P = 'document.querySelector("edit-lens").shadowRoot';
  check('panel moved to its own window', (await popup.evaluate(`Boolean(${P}.querySelector('.panel.popped'))`)) && !(await q(`return r.querySelector('.panel')`)), await popup.title());
  await popup.evaluate(`(() => { const t = ${P}.querySelector('.composer textarea'); t.value = 'hello from the popped-out panel'; t.dispatchEvent(new Event('input')); ${P}.querySelector('.send').click(); })()`);
  await page.waitForTimeout(800);
  const msgs = await getJson(`/messages/take?cwd=${encodeURIComponent(siteDir)}&via=prompt`);
  check('messages sent from the popped-out panel are sent to Claude', (msgs.messages || []).some((m) => /popped-out/.test(m.text)), (msgs.messages || []).map((m) => m.text));
  await popup.setViewportSize({ width: 460, height: 700 });
  await popup.screenshot({ path: path.join(outDir, 'layout-5-popped-panel.png') });

  // Pop out the code view too (View menu: In its own window): edits play there.
  const [popup2, poppedCode] = await Promise.all([
    context.waitForEvent('page', { timeout: 5000 }),
    menu('.dhead .dview', 'In its own window'),
  ]);
  check('View menu: In its own window', poppedCode);
  await page.waitForTimeout(400);
  const before = fs.readFileSync(appFile, 'utf8');
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: 'layout-preview', cwd: siteDir, file: appFile, relFile: 'src/App.jsx', ts: Date.now(),
    before, after: before.replace("'312'", "'314'"), stats: { added: 1, removed: 1 }, hints: {},
    hunks: [{ oldStart: 3, newStart: 3, lines: ['-' + before.split('\n')[2], '+' + before.split('\n')[2].replace("'312'", "'314'")] }],
  });
  await popup2.waitForFunction(`[...${P}.querySelectorAll('.dock .cl')].some((r) => r.textContent.includes("'314'"))`, null, { timeout: 15000 }).then(() => true, onTimeout(false)).then((ok) => check('an edit plays in the popped-out code view', ok));
  check('page not shifted while the code view is popped out', (await html()).pb === '' && (await html()).mr === '');
  await popup2.setViewportSize({ width: 620, height: 640 });
  await popup2.screenshot({ path: path.join(outDir, 'layout-6-popped-code.png') });

  // Closing the windows puts both back in the page.
  await popup.close();
  await popup2.close();
  await page.waitForTimeout(400);
  check('closing the windows shows the panels again', Boolean(await q(`return r.querySelector('.panel:not(.popped)') && r.querySelector('.dock:not(.popped)')`)));

  // Reset: the ⋯ menu's tile (Reset layout before 0.24.21).
  check('⋯ menu: Reset', await menu('.panel .head .icon[aria-haspopup]', 'Reset'));
  await page.waitForTimeout(300);
  const p6 = await box('.panel');
  d = await box('.dock');
  const corner = await q(`return r.querySelector('.panel').getAttribute('data-corner')`);
  check('reset: panel bottom right, code view right', corner === 'br' && p6.r === 1440 - d.w - 20 && p6.b === 840 && d.r === 1440, { corner, p6, d });
  await page.screenshot({ path: path.join(outDir, 'layout-7-reset.png') });
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
