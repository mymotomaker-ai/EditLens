'use strict';
require('./isolate');
// The code view on a real page and server, without Claude: split view (a picked file opens in the
// focused pane, an open file is selected where it is, Claude's edit plays where its file is
// shown); full screen (the panel, Settings, More menu, toasts and confirm boxes are drawn above it and
// take focus); the collapsed bar's buttons; Wrap lines on by default; a Windows path in the header;
// while paused at most 200 edits wait; a snapshot that could not be read is fetched again.
// usage: NODE_PATH=$(npm root -g) node test/codeview-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: codeview-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-cview-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '4961' });
const { ensureServer, stopServer, postEvent, health } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
const WIN_ROOT = 'C:\\Users\\me\\Documents\\my-site';
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (root) => `<!doctype html><title>Code view</title><body style="font:16px system-ui;margin:40px"><h1>Code view</h1>
<script src="http://127.0.0.1:4961/live.js" data-root="${root.replace(/"/g, '&quot;')}" data-panel="open"></script></body>`;

const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
let n = 0;
async function edit(name, extra) {
  const lines = Array.from({ length: 30 }, (_, i) => `const ${name}${i} = ${i};`);
  const file = path.join(proj, 'src', name + '.js');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : lines.join('\n') + '\n';
  const b = before.split('\n');
  const after = b.slice();
  after[2] = `const ${name}2 = ${++n * 100};`;
  fs.writeFileSync(file, after.join('\n'));
  await postEvent(Object.assign({ type: 'change', sessionId: 's1', cwd: proj, file, relFile: 'src/' + name + '.js', tool: 'Edit', kind: 'frontend',
    before, after: after.join('\n'), hunks: [{ oldStart: 3, newStart: 3, lines: ['-' + b[2], '+' + after[2]] }],
    stats: { added: 1, removed: 1 }, ts: Date.now() }, extra || {}));
}
const chat = (ev) => postEvent(Object.assign({ type: 'chat', sessionId: 's1', cwd: proj, ts: Date.now(), backlog: false }, ev));

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), canListen: false });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(req.url.startsWith('/win') ? WIN_ROOT : proj));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const errors = [];
  const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
  // init: localStorage values set once for this context (null: removed).
  async function openPage(init, opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 860 } }, opts || {}));
    await ctx.addInitScript((extra) => {
      try {
        localStorage.setItem('editlens.tourDone', '1');
        if (!sessionStorage.getItem('seeded')) {
          Object.keys(extra || {}).forEach((k) => { if (extra[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, extra[k]); });
          sessionStorage.setItem('seeded', '1');
        }
      } catch (err) {
        if (!err || err.name !== 'SecurityError') throw err; // storage blocked: the defaults are used
      }
    }, init || {});
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(url + ((opts && opts.path) || ''));
    await pg.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    return { ctx, page: pg };
  }
  const qq = (pg, src) => pg.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  // Nothing playing or waiting in the code view; still playing after 30 s fails a check. -> true when idle
  const idle = async (pg) => {
    await sleep(300);
    const done = await pg.waitForFunction(`!${ROOT}.querySelector('.tab.busy') && !${ROOT}.querySelector('.dqueue[data-busy]')`, null, { timeout: 30000 })
      .then(() => true, (err) => {
        if (err.name !== 'TimeoutError') throw err;
        return false;
      });
    if (!done) check('the code view finishes playing within 30 s', false);
    await sleep(400);
    return done;
  };
  // The panes, left to right (or top to bottom).
  const GROUPS = `[...r.querySelectorAll('.pgrp')].filter((g) => g.getClientRects().length).sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0))`;
  // The file shown in each pane.
  const panels = (pg) => qq(pg, `return ${GROUPS}.map((g) => { const p = g.querySelector('.pane.on'); return p ? p.getAttribute('data-path').split('/').pop() : null; });`);
  // Open in a pane's tabs but not shown.
  const hidden = async (pg) => { const p = await panels(pg); const open = await qq(pg, `return [...r.querySelectorAll('.tab .nm')].map((n) => n.textContent);`); return NAMES.map((x) => x + '.js').filter((x) => p.indexOf(x) < 0 && open.indexOf(x) >= 0); };
  // Each pane's tabs.
  const tabsOf = (pg) => qq(pg, `return ${GROUPS}.map((g) => [...g.querySelectorAll('.ptabs .tab .nm')].map((n) => n.textContent));`);
  // A real click at the centre of a node, only when nothing covers it there.
  async function clickNode(pg, find) {
    const at = await qq(pg, `const n = (${find})(r); if (!n) return null; const b = n.getBoundingClientRect(); const x = b.left + b.width / 2; const y = b.top + Math.min(b.height / 2, 60);
      const hit = r.elementFromPoint(x, y); return { x, y, hit: Boolean(hit && (hit === n || n.contains(hit))) };`);
    if (!at || !at.hit) return false;
    await pg.mouse.click(at.x, at.y);
    return true;
  }
  // On top: elementFromPoint at the node's centre is the node or inside it.
  const onTop = (pg, find) => qq(pg, `const n = (${find})(r); if (!n) return 'missing'; const b = n.getBoundingClientRect(); if (!b.width || !b.height) return 'not shown';
    const hit = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return hit && (hit === n || n.contains(hit)) ? true : 'covered by ' + (hit ? hit.className || hit.tagName : 'nothing');`);
  const focusedIn = (pg, find) => qq(pg, `const n = (${find})(r); const a = r.activeElement; return Boolean(n && a && (a === n || n.contains(a)));`);

  try {
    let ctx;
    let pg;
    await section('split view: a picked file opens in the focused pane, an open one where it is', async () => {
      // Docked at the bottom: three panes side by side (the sidebar hidden, so they are wide).
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': JSON.stringify({ dock: { mode: 'bottom' } }), 'editlens.dockLayout': 'split', 'editlens.dockSide': 'off' }));
      for (const name of NAMES) {
        await edit(name);
        await sleep(500);
      }
      await pg.waitForFunction(`${ROOT}.querySelectorAll('.pane').length >= 6`, null, { timeout: 15000 });
      await idle(pg);
      await chat({ role: 'agent-start', toolUseId: 'tuA', description: 'Tidy the helpers', agentType: 'general-purpose', prompt: '' });
      await chat({ role: 'assistant', text: 'Files: `src/` and ' + NAMES.map((x) => '`src/' + x + '.js`').join(', ') });
      await sleep(600);
      const minimize = `[...r.querySelectorAll('button')].find((b) => /^Minimize/.test(b.title)).click(); return true;`;
      const openPanel = `r.querySelector('.pill').click(); return true;`;
      await qq(pg, minimize);
      await sleep(300);
      const start = await panels(pg);
      check('three files side by side', start.length === 3 && (await qq(pg, `return r.querySelector('.panes').getAttribute('data-dir')`)) === 'cols', start);
      await pg.screenshot({ path: path.join(outDir, 'codeview-1-split.png') });
      let step = 0;
      for (const side of ['right', 'left']) {
        const slot = side === 'right' ? 2 : 0;
        const focus = async (at) => {
          await qq(pg, minimize);
          await sleep(200);
          const ok = await clickNode(pg, `(r) => ${GROUPS}[${at === undefined ? slot : at}].querySelector('.pane.on .code')`);
          await sleep(150);
          return ok;
        };
        // A file open in a pane but not shown, closed first: picked again, it is not open.
        const notOpen = async () => {
          const want = (await hidden(pg))[0];
          await qq(pg, `const t = [...r.querySelectorAll('.tab')].find((x) => x.querySelector('.nm').textContent === ${JSON.stringify(want)}); t.querySelector('.x').click(); return true;`);
          await pg.waitForFunction(`![...${ROOT}.querySelectorAll('.tab .nm')].some((n) => n.textContent === ${JSON.stringify(want)})`, null, { timeout: 5000 });
          return want;
        };
        // pick: opens the file a way.
        const picks = [
          ['the file picker (a folder link)', async (want) => {
            await qq(pg, openPanel);
            await qq(pg, `[...r.querySelectorAll('.k-claude a.fref')].find((a) => a.textContent === 'src/').click(); return true;`);
            await pg.waitForFunction(`${ROOT}.querySelector('.picker.on .pitem')`, null, { timeout: 8000 });
            await qq(pg, `[...r.querySelectorAll('.picker.on .pitem')].find((i) => i.textContent.trim() === ${JSON.stringify(want)}).click(); return true;`);
          }],
          ['a Changes row', async (want) => {
            await qq(pg, `const c = r.querySelector('.selbar .chg'); if (c.getAttribute('aria-expanded') !== 'true') c.click(); return true;`);
            await sleep(200);
            await qq(pg, `[...r.querySelectorAll('.chlist .chi')].find((i) => i.querySelector('.f').textContent.replace(/\\u200e/g, '').split(':')[0] === ${JSON.stringify(want)}).click(); return true;`);
            await qq(pg, `const c = r.querySelector('.selbar .chg'); if (c.getAttribute('aria-expanded') === 'true') c.click(); return true;`);
          }],
          ['a Follow jump', async (want) => {
            await chat({ role: 'agent-step', agentId: 'agA', toolUseId: 'tuA', agentType: 'general-purpose', kind: 'tool', tool: 'Read', summary: want, file: path.join(proj, 'src', want), line: 3, end: 3, op: 'read' });
            await sleep(500);
            await qq(pg, `r.querySelector('.dhead .fhead').click(); return true;`);
            await pg.waitForFunction(`${ROOT}.querySelector('.lwrap .follow .fchip.achip')`, null, { timeout: 3000 });
            await qq(pg, `[...r.querySelectorAll('.lwrap .follow .fchip')].find((b) => /Tidy the helpers/.test(b.textContent)).click(); return true;`);
          }],
          ['a file link', async (want) => {
            await qq(pg, openPanel);
            await qq(pg, `[...r.querySelectorAll('.k-claude a.fref')].filter((a) => a.textContent === 'src/' + ${JSON.stringify(want)}).pop().click(); return true;`);
          }],
        ];
        for (const [how, pick] of picks) {
          step++;
          const want = await notOpen();
          const hit = await focus();
          check(`${side}: the ${side} pane can be clicked`, hit);
          const marked = await qq(pg, `return ${GROUPS}.map((g) => g.classList.contains('focus'));`);
          if (step === 1 || step === 5) check(`${side}: the focused pane is marked, the others are not`, marked.length === 3 && marked.every((m, i) => m === (i === slot)), marked);
          const before = await panels(pg);
          await pick(want);
          await idle(pg);
          if (how === 'a Follow jump') {
            await qq(pg, `r.querySelector('.dhead .fhead').click(); return true;`);
            await pg.waitForFunction(`${ROOT}.querySelector('.lwrap .follow [data-mode=all]')`, null, { timeout: 3000 });
            await qq(pg, `r.querySelector('.lwrap .follow [data-mode=all]').click(); return true;`);
          }
          const after = await panels(pg);
          check(`${side} focused, ${how}: ${want} (not open) opens in the ${side} pane`, after[slot] === want, { before, after });
          check(`${side} focused, ${how}: the other panes stay`, after.every((x, i) => i === slot || x === before[i]), { before, after });
          if (step === 1) await pg.screenshot({ path: path.join(outDir, 'codeview-2-picked-right.png') });
        }
        // A tab: the file is open in a pane already, so it is shown there (handoff 15.1). First a
        // file opened in the middle pane, so that pane has a tab not shown.
        const extra = await notOpen();
        await focus(1);
        await picks[3][1](extra);
        await idle(pg);
        await focus();
        const before = await panels(pg);
        const tabs = await tabsOf(pg);
        const other = tabs.findIndex((t, i) => i !== slot && t.some((n) => before.indexOf(n) < 0));
        const want = other >= 0 ? tabs[other].find((n) => before.indexOf(n) < 0) : null;
        await qq(pg, `[...r.querySelectorAll('.tab')].find((t) => t.querySelector('.nm').textContent === ${JSON.stringify(want)}).click(); return true;`);
        await idle(pg);
        const after = await panels(pg);
        check(`${side} focused, a tab of another pane: ${want} is shown in its own pane, the others stay`, other >= 0 && after[other] === want && after.every((x, i) => i === other || x === before[i]), { before, after, other });
      }
      // Claude edits a file shown in another (not focused) pane: it plays where it is.
      await qq(pg, minimize);
      const before = await panels(pg);
      await edit(before[1].replace(/\.js$/, ''));
      await idle(pg);
      const after = await panels(pg);
      check('Claude edits a file in another pane: it plays there, nothing moves', JSON.stringify(after) === JSON.stringify(before), { before, after });
      // Claude edits a file not shown: it takes one pane; the others stay.
      const want = (await hidden(pg))[0];
      await edit(want.replace(/\.js$/, ''));
      await idle(pg);
      const next = await panels(pg);
      const moved = next.filter((x, i) => x !== after[i]).length;
      check('Claude edits a file not shown: it takes one pane, the others stay', next.indexOf(want) >= 0 && moved === 1, { after, next });
      // A file picked that is already in another pane: selected there, nothing changes places (15.1).
      await clickNode(pg, `(r) => ${GROUPS}[0].querySelector('.pane.on .code')`);
      await sleep(150);
      await qq(pg, `[...r.querySelectorAll('.tab')].find((t) => t.querySelector('.nm').textContent === ${JSON.stringify(next[2])}).click(); return true;`);
      await sleep(300);
      const kept = await panels(pg);
      const focusNow = await qq(pg, `return ${GROUPS}.map((g) => g.classList.contains('focus'));`);
      check('picking a file shown in another pane: it stays where it is and that pane gets focus', JSON.stringify(kept) === JSON.stringify(next) && focusNow[2] && !focusNow[0], { next, kept, focusNow });
      await ctx.close();
    });

    await section('full screen: what opens is drawn above it and focused', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': null }));
      await edit('alpha');
      await pg.waitForFunction(`${ROOT}.querySelector('.pane.on')`, null, { timeout: 15000 });
      await idle(pg);
      await qq(pg, `[...r.querySelectorAll('button')].find((b) => /^Minimize/.test(b.title)).click(); return true;`);
      await sleep(300);
      // Full screen is in the View menu.
      await clickNode(pg, `(r) => r.querySelector('.dhead button[aria-label="View"]')`);
      await sleep(300);
      const fullOk = await clickNode(pg, `(r) => r.querySelector('.lwrap .vmenu [data-act=full]')`);
      await sleep(600);
      const covers = await qq(pg, `const b = r.querySelector('.dock').getBoundingClientRect(); return b.left <= 0 && b.top <= 0 && b.width >= innerWidth - 1 && b.height >= innerHeight - 1;`);
      check('the code view is in full screen', fullOk && covers, { fullOk, covers });
      // change in Settings, from the file menu (the file's name in the header).
      await clickNode(pg, `(r) => r.querySelector('.dhead .crumb .fbtn')`);
      await sleep(300);
      const linked = await clickNode(pg, `(r) => [...r.querySelectorAll('.lwrap .fmenu button')].find((b) => b.textContent === 'change in Settings')`);
      await sleep(500);
      check('"change in Settings" can be clicked in full screen', linked);
      const settingsTop = await onTop(pg, `(r) => r.querySelector('.settings.on')`);
      check('Settings are drawn above the full-screen code view', settingsTop === true, settingsTop);
      check('Settings have focus', await focusedIn(pg, `(r) => r.querySelector('.settings.on')`));
      await pg.screenshot({ path: path.join(outDir, 'codeview-3-full-settings.png') });
      // The panel's More menu.
      await qq(pg, `const b = [...r.querySelectorAll('.settings button')].find((x) => /back|close|done/i.test(x.textContent + ' ' + (x.title || '') + ' ' + (x.getAttribute('aria-label') || ''))); if (b) b.click(); return true;`);
      await sleep(300);
      // Settings opened in the code view (handoff 15.1), so the panel is still minimized: open it.
      await qq(pg, `if (!r.querySelector('.panel button[aria-label="More"]').getClientRects().length) r.querySelector('.pill').click(); return true;`);
      await sleep(400);
      const moreOk = await clickNode(pg, `(r) => r.querySelector('.panel button[aria-label="More"]')`);
      await sleep(400);
      check('the panel\'s More button can be clicked in full screen', moreOk);
      const menuTop = await onTop(pg, `(r) => r.querySelector('.lwrap .lmenu')`);
      check('the More menu is drawn above the full-screen code view', menuTop === true, menuTop);
      check('the More menu has focus', await focusedIn(pg, `(r) => r.querySelector('.lwrap .lmenu')`));
      await pg.keyboard.press('Escape');
      await sleep(200);
      // A toast (a link to a file that isn't there): shown above, not focused (a status line).
      await chat({ role: 'assistant', text: 'See `old/gone.js`.' });
      await sleep(600);
      await qq(pg, `[...r.querySelectorAll('.k-claude a.fref')].find((a) => a.textContent === 'old/gone.js').click(); return true;`);
      await pg.waitForFunction(`${ROOT}.querySelector('.toast.on')`, null, { timeout: 5000 });
      await sleep(450);
      const toastTop = await onTop(pg, `(r) => r.querySelector('.toast.on')`);
      check('a toast is drawn above the full-screen code view', toastTop === true, toastTop);
      // A confirm box: Restore… in the file menu, asked at the top of the pane (the panel covers the
      // bottom right).
      await qq(pg, `[...r.querySelectorAll('button')].find((b) => /^Minimize/.test(b.title)).click(); return true;`);
      await sleep(300);
      await clickNode(pg, `(r) => r.querySelector('.dhead .crumb .fbtn')`);
      await sleep(300);
      const rstOk = await clickNode(pg, `(r) => r.querySelector('.lwrap .fmenu [data-act=restore]:not([disabled])')`);
      await sleep(400);
      check('Restore… in the file menu can be clicked', rstOk);
      const boxTop = await onTop(pg, `(r) => r.querySelector('.pane.on .rconf')`);
      check('the restore confirm box is drawn above', boxTop === true, boxTop);
      check('the restore confirm box has focus (on Cancel)', await focusedIn(pg, `(r) => r.querySelector('.pane.on .rconf')`));
      await qq(pg, `const b = r.querySelector('.pane.on .rconf button:last-child'); if (b) b.click(); return true;`);
      // A confirm box in the panel: Restore on the edit card.
      await qq(pg, `r.querySelector('.pill').click(); return true;`);
      await sleep(400);
      const cardOk = await clickNode(pg, `(r) => [...r.querySelectorAll('.panel button.rst')].filter((b) => b.textContent === 'Restore').pop()`);
      await sleep(400);
      const cardTop = await onTop(pg, `(r) => r.querySelector('.panel .rconf')`);
      check('the edit card\'s restore confirm box is drawn above and has focus', cardOk && cardTop === true && await focusedIn(pg, `(r) => r.querySelector('.panel .rconf')`), { cardOk, cardTop });
      await pg.screenshot({ path: path.join(outDir, 'codeview-4-full-confirm.png') });
      await pg.keyboard.press('Escape');
      await sleep(300);
      await qq(pg, `r.querySelector('.dhead button[aria-label="View"]').click(); return true;`);
      await sleep(300);
      await qq(pg, `const b = r.querySelector('.lwrap .vmenu [data-act=full]'); if (b && /^Exit full screen/.test(b.textContent)) b.click(); return true;`);
      await sleep(400);
      check('full screen ends: the code view is back in its place', await qq(pg, `return !r.querySelector('.dock.max') && r.querySelector('.dock').getBoundingClientRect().left > 100;`));
      await ctx.close();
    });

    await section('collapsed code view: Select and Full screen on the narrow bar', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': null, 'editlens.dockCollapsed': null }));
      await edit('beta');
      await pg.waitForFunction(`${ROOT}.querySelector('.pane.on')`, null, { timeout: 15000 });
      await idle(pg);
      await qq(pg, `r.querySelector('.dtab').click(); return true;`);
      await sleep(500);
      check('the code view is collapsed to the narrow bar', await qq(pg, `return r.querySelector('.dock').classList.contains('rail');`));
      const sel = `(r) => [...r.querySelectorAll('.rtools button')].find((b) => /^Select something on the page/.test(b.title))`;
      const full = `(r) => [...r.querySelectorAll('.rtools button')].find((b) => /^Full screen/.test(b.title))`;
      check('Select is on the narrow bar and visible', (await onTop(pg, sel)) === true, await onTop(pg, sel));
      check('Full screen is on the narrow bar and visible', (await onTop(pg, full)) === true, await onTop(pg, full));
      await pg.screenshot({ path: path.join(outDir, 'codeview-5-rail.png') });
      await clickNode(pg, sel);
      await sleep(300);
      check('Select from the bar: pointing at the page is on, the button pressed', await qq(pg, `return r.querySelector('.catcher').classList.contains('on') && (${sel})(r).getAttribute('aria-pressed') === 'true';`));
      await pg.keyboard.press('Escape');
      await sleep(200);
      await qq(pg, `(${sel})(r).focus(); return true;`);
      await pg.keyboard.press('Enter');
      await sleep(300);
      check('Select by keyboard (Enter): pointing is on', await qq(pg, `return r.querySelector('.catcher').classList.contains('on');`));
      await pg.keyboard.press('Escape');
      await sleep(200);
      await qq(pg, `(${full})(r).focus(); return true;`);
      await pg.keyboard.press('Enter');
      await sleep(700);
      check('Full screen by keyboard from the bar: the whole code view fills the screen', await qq(pg, `const d = r.querySelector('.dock'); const b = d.getBoundingClientRect();
        return !d.classList.contains('rail') && b.width >= innerWidth - 1 && b.height >= innerHeight - 1 && Boolean(r.querySelector('.pane.on')) && r.querySelector('.pane.on').getBoundingClientRect().width > 300;`));
      await pg.screenshot({ path: path.join(outDir, 'codeview-6-rail-full.png') });
      await qq(pg, `r.querySelector('.dhead button[aria-label="View"]').click(); return true;`);
      await sleep(300);
      await qq(pg, `[...r.querySelectorAll('.lwrap .vmenu [data-act=full]')].find((b) => /^Exit full screen/.test(b.textContent)).click(); return true;`);
      await sleep(600);
      check('after full screen: the narrow bar is back', await qq(pg, `return r.querySelector('.dock').classList.contains('rail') && r.querySelector('.dock').getBoundingClientRect().width < 60;`));
      await ctx.close();
    });

    await section('Wrap lines: on by default', async () => {
      const cases = [['a new user (nothing stored)', null, true], ['a user who turned it off', 'off', false], ['an old stored value (on)', 'on', true], ['an unknown stored value', 'yes', true]];
      for (const [who, stored, want] of cases) {
        ({ ctx, page: pg } = await openPage({ 'editlens.wrap': stored }));
        await edit('gamma');
        await pg.waitForFunction(`${ROOT}.querySelector('.pane.on')`, null, { timeout: 15000 });
        const on = await qq(pg, `return r.querySelector('.panes').classList.contains('wrapl');`);
        check(`${who}: Wrap lines ${want ? 'on' : 'off'}`, on === want, on);
        if (stored === null) {
          // Turned off from the menu: stays off after a reload.
          // The View menu's Wrap long lines.
          await qq(pg, `r.querySelector('.dhead button[aria-label="View"]').click(); return true;`);
          await sleep(200);
          await qq(pg, `[...r.querySelectorAll('.lwrap [role=menuitemcheckbox]')].find((b) => /Wrap long lines/.test(b.textContent)).click(); return true;`);
          await sleep(200);
          await pg.reload();
          await pg.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panes')`, null, { timeout: 15000 });
          await sleep(300);
          const kept = await pg.evaluate(() => localStorage.getItem('editlens.wrap'));
          check('turned off: off after a reload, stored as off', (await qq(pg, `return r.querySelector('.panes').classList.contains('wrapl');`)) === false && kept === 'off', kept);
        }
        await ctx.close();
      }
    });

    await section('paused: at most 200 edits wait, and the rest are counted', async () => {
      ({ ctx, page: pg } = await openPage({}));
      for (let i = 0; i < 3; i++) await edit('alpha');
      await pg.waitForFunction(`${ROOT}.querySelector('.dqueue[data-busy]')`, null, { timeout: 15000 });
      await qq(pg, `const b = [...r.querySelectorAll('button')].find((x) => x.getAttribute('aria-label') === 'Pause playback'); if (b) b.click(); return Boolean(b);`);
      for (let i = 0; i < 230; i++) await edit(NAMES[i % NAMES.length]);
      await sleep(1500);
      const st = await qq(pg, `const q = r.querySelector('.dqueue'); return q ? q.title : null;`);
      const waiting = Number((/(\d+) more waiting/.exec(st || '') || [])[1]);
      const skipped = Number((/(\d+) skipped/.exec(st || '') || [])[1]);
      check('paused: the waiting edits are limited to 200', /^Paused/.test(st || '') && Number.isInteger(waiting) && waiting <= 200, st);
      check('and says how many were skipped', Number.isInteger(skipped) && skipped > 0 && waiting + skipped >= 230, st);
      await ctx.close();
    });

    await section('a snapshot that could not be read is fetched again', async () => {
      ({ ctx, page: pg } = await openPage({}));
      let asked = 0;
      await pg.route('**/snapshot?*', (rt) => {
        asked++;
        if (asked === 1) return rt.fulfill({ status: 200, contentType: 'application/json', body: '{not json' });
        return rt.continue();
      });
      await edit('zeta', { intent: 'Bad body once' });
      await pg.waitForFunction(`[...${ROOT}.querySelectorAll('.k-edit')].some((c) => /Bad body once/.test(c.textContent))`, null, { timeout: 15000 });
      await idle(pg);
      await qq(pg, `[...r.querySelectorAll('.k-edit')].filter((c) => /Bad body once/.test(c.textContent)).pop().querySelector('.mini.play').click(); return true;`);
      await idle(pg);
      check('Replay asks for it again after a body that could not be read', asked >= 2, asked);
      await ctx.close();
    });

    await section('Sol M7: after a restart, snapshot numbers and the selected edit from the old start are not reused', async () => {
      // Restarted the same way each time, so the numbers repeat: session, page, then one edit.
      const restart = async () => {
        await stopServer();
        await ensureServer();
        await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), canListen: false });
      };
      const connected = async () => {
        for (let i = 0; i < 100; i++) {
          const h = await health();
          if (h && h.clients > 0) return sleep(600);
          await sleep(150);
        }
        throw new Error('the page did not connect again');
      };
      const cardWith = (pg, text) => pg.waitForFunction(`[...${ROOT}.querySelectorAll('.k-edit')].some((c) => c.textContent.includes(${JSON.stringify(text)}))`, null, { timeout: 15000 });
      const asked = [];
      await restart();
      ({ ctx, page: pg } = await openPage({}));
      await pg.route('**/snapshot?*', (rt) => {
        asked.push(new URL(rt.request().url()).searchParams.get('id'));
        return rt.continue();
      });
      await connected();
      await edit('gamma', { intent: 'Before the restart' });
      await cardWith(pg, 'Before the restart');
      await idle(pg);
      await restart();
      await connected();
      await edit('delta', { intent: 'After the restart' });
      await cardWith(pg, 'After the restart');
      await idle(pg);
      const shown = await panels(pg);
      check('the new edit shows its own file, not the old edit with the same number', shown.includes('delta.js'), { shown, asked });
      // The new edit selected; after another restart and a reload, the edit with its number is not selected.
      await qq(pg, `[...r.querySelectorAll('.k-edit')].filter((c) => c.textContent.includes('After the restart')).pop().querySelector('.row').click(); return true;`);
      await sleep(400);
      const saved = await pg.evaluate(() => sessionStorage.getItem('editlens.selectedEdit'));
      await restart();
      await pg.reload();
      await pg.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
      await connected();
      await edit('epsilon', { intent: 'After the second restart' });
      await cardWith(pg, 'After the second restart');
      await sleep(1000);
      const open = await qq(pg, `const c = [...r.querySelectorAll('.k-edit')].filter((x) => x.textContent.includes('After the second restart')).pop(); return c.classList.contains('open');`);
      check('the saved selected edit is not taken for a new edit with the same number', saved && !open, { saved, open });
      await ctx.close();
    });

    await section('a Windows path in the header', async () => {
      // The code view 700 px wide: the long name fits in the header, its folders do not.
      ({ ctx, page: pg } = await openPage({ 'editlens.dockWidth': '700' }, { path: 'win', viewport: { width: 1280, height: 860 } }));
      const file = WIN_ROOT + '\\essays\\week-one\\draft-about-the-long-title-of-this-essay.md';
      const before = '# Draft\n\nOne.\n';
      const after = '# Draft\n\nOne. Two.\n';
      await postEvent({ type: 'change', sessionId: 'w1', cwd: WIN_ROOT, file, relFile: file, tool: 'Edit', kind: 'frontend', before, after,
        hunks: [{ oldStart: 3, newStart: 3, lines: ['-One.', '+One. Two.'] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
      await pg.waitForFunction(`${ROOT}.querySelector('.dhead .crumb .fbtn')`, null, { timeout: 15000 });
      await idle(pg);
      // The header's path: the folder path, then the name, whose button opens the file menu.
      const h = await qq(pg, `const c = r.querySelector('.dhead .crumb'); const b = c.querySelector('.fbtn'); const st = getComputedStyle(c);
        const pn = b.querySelector('b'); const pd = c.querySelector('.cdir');
        return { text: b.getAttribute('aria-label').replace(/: file menu$/, ''), title: b.title, height: c.getBoundingClientRect().height, line: [parseFloat(st.lineHeight), parseFloat(st.fontSize) * 1.3].find((v) => Number.isFinite(v) && v > 0) || null,
          name: pn ? pn.textContent : null, bold: pn ? Number(getComputedStyle(pn).fontWeight) : 0, dir: pd ? [...pd.querySelectorAll('.cs')].map((x) => x.textContent) : null,
          tab: r.querySelector('.tab.on') ? r.querySelector('.tab.on').title : null };`);
      check('the header shows the project-relative path', h.text === 'essays\\week-one\\draft-about-the-long-title-of-this-essay.md', h.text);
      check('the file name is bold, the folders apart', h.name === 'draft-about-the-long-title-of-this-essay.md' && h.bold >= 600 && JSON.stringify(h.dir) === JSON.stringify(['essays', 'week-one']), h);
      check('the full path is in the hover title', h.title.split('\n')[0] === file, h.title);
      check('the tab\'s hover title is the full path', h.tab === file, h.tab);
      check('one line', h.height <= h.line * 1.6, [h.height, h.line]);
      // The folder is cut from the left, the name stays whole.
      const cut = await qq(pg, `const c = r.querySelector('.dhead .crumb'); const pd = c.querySelector('.cdir'); const pn = c.querySelector('.fbtn b');
        return { narrow: r.querySelector('.dock').classList.contains('narrow'), height: c.getBoundingClientRect().height, dirCut: pd ? pd.scrollWidth > pd.clientWidth + 1 : null, nameWhole: pn ? pn.scrollWidth <= pn.clientWidth + 1 : null, dirLeft: pd ? pd.clientWidth : null, dirDir: pd ? getComputedStyle(pd).direction : null };`);
      // The name stays whole while the folder can still be shortened; with wider fonts (CI) the folder
      // can be cut to nothing first, and only then the name.
      check('the folder cut from the left, the name whole', !cut.narrow && cut.height <= h.line * 1.6 && cut.dirCut === true && (cut.nameWhole === true || cut.dirLeft <= 1) && cut.dirDir === 'rtl', cut);
      // A narrow code view (one header row, handoff 15.1): only the name, on one line, read from its
      // start (a name longer than the row ends in "…"); the whole path is in the hover title.
      await pg.setViewportSize({ width: 500, height: 860 });
      await sleep(400);
      const nar = await qq(pg, `const c = r.querySelector('.dhead .crumb'); const pd = c.querySelector('.cdir'); const b = c.querySelector('.fbtn'); const pn = b.querySelector('b'); const st = getComputedStyle(pn);
        return { narrow: r.querySelector('.dock').classList.contains('narrow'), height: c.getBoundingClientRect().height, dirShown: Boolean(pd && pd.getClientRects().length),
          name: pn.textContent, fromStart: st.direction === 'ltr' && (pn.scrollWidth <= pn.clientWidth + 1 || st.textOverflow === 'ellipsis'), title: b.title.split('\\n')[0] };`);
      check('narrow: one line, the name only, from its start; the full path on hover', nar.narrow && nar.height <= h.line * 1.6 && !nar.dirShown && nar.name === 'draft-about-the-long-title-of-this-essay.md' && nar.fromStart && nar.title === file, nar);
      await pg.screenshot({ path: path.join(outDir, 'codeview-7-windows-path.png') });
      await ctx.close();
    });

    await section('numbers in events that are not numbers: no NaN, Infinity or Invalid Date shown', async () => {
      ({ ctx, page: pg } = await openPage({}));
      const from = errors.length;
      await edit('alpha', { ts: '1e400' });
      await pg.waitForFunction(`${ROOT}.querySelector('.pane.on')`, null, { timeout: 15000 });
      await idle(pg);
      // JSON has no Infinity: '1e400' is the string that Number() makes Infinity.
      await chat({ role: 'agent-start', toolUseId: 'tuOdd', description: 'Odd numbers', agentType: 'general-purpose', prompt: '', ts: '1e400' });
      for (const v of ['abc', '1e400', '-1e400', 'NaN', '1.5', '1e400']) {
        await chat({ role: 'agent-step', agentId: 'agOdd', toolUseId: 'tuOdd', agentType: 'general-purpose', kind: 'tool', tool: 'Read', summary: 'alpha.js',
          file: path.join(proj, 'src', 'alpha.js'), line: v, end: v, op: 'read', ts: v });
        await chat({ role: 'tool', tool: 'Read', summary: 'beta.js', file: path.join(proj, 'src', 'beta.js'), line: v, end: '1e400', op: 'read', ts: v });
      }
      // An old notice (its time is not a number) is not shown as new.
      await postEvent({ type: 'pair-notice', sessionId: 's1', cwd: proj, text: 'Old pair notice', at: '1e400' });
      await sleep(1200);
      const shown = await qq(pg, `const out = []; const re = /NaN|Infinity|Invalid Date|undefined/;
        r.querySelectorAll('*').forEach((n) => {
          [...n.childNodes].forEach((c) => { if (c.nodeType === 3 && re.test(c.textContent)) out.push(c.textContent.slice(0, 80)); });
          ['title', 'aria-label', 'data-ts'].forEach((a) => { const v = n.getAttribute(a); if (v && re.test(v)) out.push(a + ': ' + v.slice(0, 80)); });
        });
        const row = [...r.querySelectorAll('.arow')].find((x) => /Odd numbers/.test(x.textContent));
        const toast = r.querySelector('.toast.on');
        return { bad: out, file: row && row.querySelector('.rf') ? row.querySelector('.rf').textContent : null, toast: toast ? toast.textContent : '' };`);
      check('no NaN, Infinity, Invalid Date or undefined in the panel, code view or agents list', shown.bad.length === 0, shown.bad);
      check('the agent\'s file is named without a line that is not a number', typeof shown.file === 'string' && /alpha\.js$/.test(shown.file), shown.file);
      check('a notice whose time is not a number is not shown as new', !/Old pair notice/.test(shown.toast), shown.toast);
      check('bad numbers cause no page errors', errors.length === from, errors.slice(from));
      await ctx.close();
    });

    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    site.close();
    await stopServer();
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
