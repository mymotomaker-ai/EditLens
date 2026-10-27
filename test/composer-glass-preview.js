'use strict';
require('./isolate');
// The panel's message box as frosted glass over the bottom of the chat (handoff section 19, look A):
// 12 px in from the panel's edges, 1 line when empty, one more per typed line up to half the panel,
// then the text scrolls inside; pick chips at its top; "N lines" over 3 lines; 1 line with "…" out of
// focus. Light, dark, solid when there is no blur or less transparency is asked, no animation with
// reduced motion, pick-number marks aligned with the text. Also a floating panel, a narrow window, a phone.
// usage: NODE_PATH=$(npm root -g) node test/composer-glass-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium, devices } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: composer-glass-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-glass-'));
// Manual: opening the page starts no page control setup.
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5370', CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const near = (a, b, d = 1.5) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= d;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hill Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:40px 60px;max-width:640px}h1{font-size:40px;line-height:1.1;margin:0 0 12px}
.order{display:inline-block;padding:10px 18px;border:0;border-radius:10px;background:#c4592f;color:#fff;font:600 15px system-ui}.menu{list-style:none;padding:0;margin:40px 0 0;width:260px}
.menu li{display:flex;justify-content:space-between;padding:8px 0}
@media (prefers-color-scheme:dark){body{background:#18181a;color:#eee}}</style>
</head><body><main><h1 id="h">New coffee each day</h1><p id="lede">Small-batch roasts, brewed slowly, served at the bottom of the hill.</p>
<button class="order" id="order">Order now</button>
<ul class="menu" id="menu"><li id="e">Espresso <b>$3.00</b></li><li>Flat white <b>$4.25</b></li><li id="m">Mocha <b>$4.50</b></li></ul></main>
<script src="http://127.0.0.1:5370/live.js" data-root="${proj}" data-panel="open" data-settle="300"></script></body></html>`;

const LONG = 'Make the contact heading match the menu heading: same font, same size, and 24 px space under it. '
  + 'In the first area, line up the two prices on the right and make them bold.';

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now() });
  // Cards in the chat, so the box has something behind it.
  const replies = ['It\'s the **Mocha** at $4.50. The Flat white is next at $4.25.', 'Done. The Mocha row now has a soft orange background and a bold price.',
    'I kept the other rows as they were, and the header is unchanged.', 'The menu now lists three drinks; the prices line up on the right.',
    'Next I can shorten the note under the menu so it fits on one line on phones.'];
  for (const text of replies) await postEvent({ type: 'chat', role: 'assistant', sessionId: 's1', cwd: proj, text, ts: Date.now() });
  await postEvent({ type: 'mode-ping', sessionId: 's1', cwd: proj, permissionMode: 'acceptEdits' });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium);

  // opts.noBlur: the browser says it has no backdrop-filter (the solid box is used).
  async function open(opts, extra = {}) {
    const ctx = await browser.newContext(opts);
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    if (extra.float) {
      await ctx.addInitScript(() => {
        const layout = { panel: { mode: 'float', corner: 'br', x: 120, y: 60, w: 380, h: 600 }, dock: { mode: 'right', bh: null, x: null, y: null, w: null, h: null }, agents: { x: null, b: null } };
        try { localStorage.setItem('editlens.layout', JSON.stringify(layout)); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; }
      });
    }
    if (extra.noBlur) {
      await ctx.addInitScript(() => {
        const own = CSS.supports.bind(CSS);
        CSS.supports = function (a, b) { return /backdrop-filter/.test(String(a)) ? false : own.apply(null, arguments); };
      });
    }
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    if (extra.reducedTransparency) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    }
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel textarea')`);
    await sleep(900);
    const q = (js) => page.evaluate(`(() => { const r = ${ROOT}; ${js} })()`);
    const R = (n) => `(() => { const b = (${n}).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; })()`;
    // Everything the checks read, in one call.
    const geoNow = () => q(`const p = r.querySelector('.panel'), c = r.querySelector('.composer'), f = c && c.querySelector('.field'), t = r.querySelector('.composer textarea');
      const fe = r.querySelector('.feed'), a = f && f.querySelector('.atts'), bar = f && f.querySelector('.cbar'), nl = r.querySelector('.nlines'), one = r.querySelector('.inone');
      const cs = getComputedStyle(t), lh = parseFloat(cs.lineHeight), pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      return { panel: ${R('p')}, field: f ? ${R('f')} : null, text: ${R('t')}, feed: ${R('fe')}, atts: a && a.offsetParent ? ${R('a')} : null, bar: bar ? ${R('bar')} : null,
        pos: c ? getComputedStyle(c).position : '', feedPad: parseFloat(getComputedStyle(fe).paddingBottom), fontSize: cs.fontSize, lh, pad,
        lines: Math.round((t.clientHeight - pad) / lh), scrolls: t.scrollHeight > t.clientHeight + 1, nlines: nl ? nl.textContent : null,
        nlinesShown: Boolean(nl && nl.offsetParent && nl.textContent), shut: Boolean(f && f.classList.contains('shut')),
        one: one && one.offsetParent ? { text: one.textContent, ell: getComputedStyle(one).textOverflow, over: one.scrollWidth > one.clientWidth, ws: getComputedStyle(one).whiteSpace } : null,
        focused: r.activeElement === t, attsInField: Boolean(a && f.contains(a)) };`);
    // Read once the box stops changing size (its height animates; a slow computer takes longer), at most 3 s.
    const geo = async () => {
      let a = await geoNow();
      for (let i = 0; i < 30; i++) {
        await sleep(100);
        const b = await geoNow();
        const same = (x, y) => (x === null) === (y === null) && (!x || (Math.abs(x.top - y.top) < 0.5 && Math.abs(x.height - y.height) < 0.5));
        if (same(a.text, b.text) && same(a.field, b.field)) return b;
        a = b;
      }
      return a;
    };
    const type = async (s) => {
      const parts = s.split('\n');
      for (let i = 0; i < parts.length; i++) {
        if (i) await page.keyboard.press('Shift+Enter');
        if (parts[i]) await page.keyboard.insertText(parts[i]);
      }
    };
    const clear = () => q(`const t = r.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input')); t.focus(); return true;`);
    const focusBox = () => q(`r.querySelector('.composer textarea').focus(); return true;`);
    // Focus leaves the panel: a click on the page.
    const leave = async () => {
      await page.mouse.click(30, 30);
      await sleep(350);
    };
    return { ctx, page, q, geo, type, clear, focusBox, leave, errors };
  }

  // A step that throws counts as one failure; the next part still runs.
  const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
  try {
    for (const scheme of ['light', 'dark']) await section(scheme, async () => {
      const t = await open({ viewport: { width: 1280, height: 820 }, colorScheme: scheme });
      const { page, q, geo, type, clear, focusBox, leave } = t;

      // ----- placement and growth -----
      await focusBox();
      await sleep(300);
      let g = await geo();
      check(`${scheme}: the box is absolute over the feed, 12 px in from the left, right and bottom`, g.pos === 'absolute' && g.field
        && near(g.field.left, g.panel.left + 12) && near(g.field.right, g.panel.right - 12) && near(g.field.bottom, g.panel.bottom - 12)
        && g.feed.bottom >= g.field.bottom - 1 && g.feed.top < g.field.top, g);
      check(`${scheme}: 13 px text, line height 1.5`, g.fontSize === '13px' && near(g.lh, 19.5, 0.1), { fontSize: g.fontSize, lh: g.lh });
      check(`${scheme}: 1 line when empty`, g.lines === 1 && near(g.text.height, g.lh + g.pad), g.text);
      const empty = g;
      await type('First line\nSecond line\nThird line');
      await sleep(300);
      g = await geo();
      check(`${scheme}: 3 typed lines make it 3 lines high`, g.lines === 3 && !g.scrolls, { lines: g.lines });
      check(`${scheme}: it grows upward: the bottom stays, the top moves up 2 lines`, g.field && near(g.field.bottom, empty.field.bottom) && near(empty.field.top - g.field.top, 2 * g.lh, 2), { before: empty.field, after: g.field });
      check(`${scheme}: no "N lines" at 3 lines`, !g.nlinesShown, g.nlines);
      await type('\nFourth line');
      await sleep(300);
      g = await geo();
      check(`${scheme}: "4 lines" shows, dim, right-aligned before the mic and Send`, g.nlinesShown && g.nlines === '4 lines'
        && await q(`const n = r.querySelector('.nlines'), s = r.querySelector('.composer .send'), m = r.querySelector('.composer .mic');
          const nb = n.getBoundingClientRect(); const right = (m && m.offsetParent ? m : s).getBoundingClientRect();
          return nb.right <= right.left + 1 && Math.abs(nb.top + nb.height / 2 - right.top - right.height / 2) < 4 && n.parentElement === s.parentElement;`), g.nlines);

      // ----- pick chips inside the top of the box -----
      await q(`r.querySelector('.icon.pt').click(); return true;`);
      await sleep(150);
      for (const sel of ['#h', '#order']) {
        const b = await page.evaluate((s) => { const x = document.querySelector(s).getBoundingClientRect(); return [x.left + 30, x.top + x.height / 2]; }, sel);
        await page.mouse.click(b[0], b[1]);
        await sleep(300);
        await page.keyboard.press('Escape');
        await sleep(200);
        if (await q(`return r.querySelector('.icon.pt').getAttribute('aria-pressed') !== 'true';`) && sel === '#h') {
          await q(`r.querySelector('.icon.pt').click(); return true;`);
          await sleep(150);
        }
      }
      if (await q(`return r.querySelector('.icon.pt').getAttribute('aria-pressed') === 'true';`)) await q(`r.querySelector('.icon.pt').click(); return true;`);
      await focusBox();
      await q(`const t = r.querySelector('.composer textarea'); t.setSelectionRange(0, 0); return true;`);
      await page.keyboard.insertText('1 ');
      await sleep(300);
      g = await geo();
      const chipCount = await q(`return r.querySelectorAll('.composer .atts .att').length;`);
      check(`${scheme}: the pick chips are inside the box, at its top (9 px in), 6 px above the text`, chipCount === 2 && g.attsInField && g.atts
        && near(g.atts.top, g.field.top + 9) && near(g.text.top - g.atts.bottom, 6, 2.5), { chipCount, atts: g.atts, field: g.field, text: g.text });
      const mk = () => q(`const m = r.querySelector('.inmarks .imk'), t = r.querySelector('.composer textarea'); if (!m) return null;
        const k = m.getBoundingClientRect(), b = t.getBoundingClientRect(), cs = getComputedStyle(t);
        return { dx: k.left + parseFloat(getComputedStyle(m).paddingLeft) - b.left - parseFloat(cs.paddingLeft), dy: k.top + k.height / 2 - (b.top + parseFloat(cs.paddingTop) + parseFloat(cs.lineHeight) / 2) + t.scrollTop, text: m.textContent };`);
      let m = await mk();
      check(`${scheme}: the pick number at the start of the text has its round mark, on the number`, m && m.text === '1' && Math.abs(m.dx) < 4 && Math.abs(m.dy) < 3, m);
      await page.screenshot({ path: path.join(outDir, `glass-${scheme}.png`) });

      // ----- capped at half the panel; then the text scrolls inside -----
      await q(`const t = r.querySelector('.composer textarea'); t.setSelectionRange(t.value.length, t.value.length); return true;`);
      for (let i = 0; i < 6; i++) await type('\n' + LONG);
      await sleep(350);
      g = await geo();
      check(`${scheme}: the box is at most half the panel's height`, g.field.height <= g.panel.height / 2 + 1 && g.field.height >= g.panel.height / 2 - 30, { field: g.field.height, half: g.panel.height / 2 });
      check(`${scheme}: then the text scrolls inside the box`, g.scrolls);
      check(`${scheme}: never over the panel's header or tabs`, await q(`const f = r.querySelector('.composer .field').getBoundingClientRect(); const tabs = r.querySelector('.filters').getBoundingClientRect(); return f.top >= tabs.bottom;`));
      const before = g;
      await q(`const t = r.querySelector('.composer textarea'); t.scrollTop = 0; t.dispatchEvent(new Event('scroll')); return true;`);
      await sleep(100);
      g = await geo();
      check(`${scheme}: scrolling the text leaves the chips and the bottom row in place`, g.atts && before.atts && near(g.atts.top, before.atts.top, 0.5) && near(g.bar.bottom, before.bar.bottom, 0.5)
        && near(g.bar.bottom, g.field.bottom - 7, 1.5), { atts: [before.atts, g.atts], bar: [before.bar.bottom, g.bar.bottom], field: g.field.bottom });
      m = await mk();
      check(`${scheme}: the mark stays on the number while the text scrolls`, m && Math.abs(m.dx) < 4 && Math.abs(m.dy) < 3, m);
      check(`${scheme}: "N lines" counts the lines on screen`, /^\d+ lines$/.test(g.nlines) && parseInt(g.nlines, 10) > 12, g.nlines);
      await q(`const t = r.querySelector('.composer textarea'); t.scrollTop = t.scrollHeight; return true;`);
      await page.screenshot({ path: path.join(outDir, `glass-${scheme}-grown.png`) });
      const grownH = g.text.height;
      const dbg = () => q(`const f = r.querySelector('.composer .field'), t = r.querySelector('.composer textarea'); return { rest: f.offsetHeight - t.offsetHeight, kids: [...f.children].map((x) => x.className + ':' + x.offsetHeight) };`);
      const d1 = await dbg();

      // ----- out of focus: 1 line with "…", chips stay; back to full height on focus -----
      await leave();
      g = await geo();
      check(`${scheme}: focus leaves: 1 line`, !g.focused && g.shut && g.lines === 1 && near(g.text.height, g.lh + g.pad), { lines: g.lines, h: g.text.height });
      check(`${scheme}: with an ellipsis`, g.one && g.one.ell === 'ellipsis' && g.one.over && g.one.ws === 'nowrap' && g.one.text.startsWith('1 First line'), g.one);
      check(`${scheme}: the chips stay`, g.atts && g.attsInField, g.atts);
      check(`${scheme}: no "N lines" while collapsed`, !g.nlinesShown, g.nlines);
      check(`${scheme}: the feed's bottom padding is the collapsed box's height + 12 px`, near(g.feedPad, g.field.height + 12, 1), { pad: g.feedPad, box: g.field.height });
      check(`${scheme}: the collapsed box keeps its bottom 12 px above the panel's`, near(g.field.bottom, g.panel.bottom - 12), g.field);
      const cm = await q(`const m = r.querySelector('.inone .imk'), t = r.querySelector('.composer textarea'); if (!m) return null; const k = m.getBoundingClientRect(), b = t.getBoundingClientRect(); return { dx: k.left + parseFloat(getComputedStyle(m).paddingLeft) - b.left, dy: k.top - b.top, text: m.textContent };`);
      check(`${scheme}: the collapsed line keeps the pick number's mark, aligned`, cm && cm.text === '1' && Math.abs(cm.dx) < 4 && cm.dy > -3 && cm.dy < 6, cm);
      await page.screenshot({ path: path.join(outDir, `glass-${scheme}-collapsed.png`) });
      await focusBox();
      await sleep(350);
      g = await geo();
      check(`${scheme}: focus returns: full height again`, g.focused && !g.shut && near(g.text.height, grownH, 2) && !g.one, { h: g.text.height, grownH, d1, d2: await dbg() });

      // ----- surfaces (out of focus; in focus a thin accent ring is added) -----
      const ring = await q(`return getComputedStyle(r.querySelector('.composer .field')).boxShadow;`);
      check(`${scheme}: in focus, a thin accent ring and the same upward shadow`, / 0px 0px 0px 1px/.test(ring) && ring.includes('rgba(0, 0, 0, 0.28) 0px -10px 30px -12px'), ring);
      await leave();
      const surf = await q(`const f = r.querySelector('.composer .field'), t = r.querySelector('.composer textarea'), cs = getComputedStyle(f);
        return { bg: cs.backgroundColor, bf: cs.backdropFilter || cs.webkitBackdropFilter, sh: cs.boxShadow, radius: cs.borderRadius, padding: cs.padding,
          color: getComputedStyle(r.querySelector('.inone')).color, ph: getComputedStyle(t, '::placeholder').color, dir: cs.flexDirection };`);
      const L = scheme === 'light';
      check(`${scheme}: ${L ? 'white' : '#2c2c2e'} at 78%`, surf.bg === (L ? 'rgba(255, 255, 255, 0.78)' : 'rgba(44, 44, 46, 0.78)'), surf.bg);
      check(`${scheme}: blur 14 px, saturate 1.5`, surf.bf === 'blur(14px) saturate(1.5)', surf.bf);
      check(`${scheme}: thin border and upward shadow`, surf.sh.includes(L ? 'rgba(0, 0, 0, 0.08) 0px 0px 0px 0.5px' : 'rgba(255, 255, 255, 0.09) 0px 0px 0px 0.5px') && surf.sh.includes('rgba(0, 0, 0, 0.28) 0px -10px 30px -12px'), surf.sh);
      check(`${scheme}: radius 14 px, padding 9 10 7 12, a column`, surf.radius === '14px' && surf.padding === '9px 10px 7px 12px' && surf.dir === 'column', surf);
      const anim = await q(`const cs = getComputedStyle(r.querySelector('.composer textarea')); return { p: cs.transitionProperty, d: cs.transitionDuration, f: cs.transitionTimingFunction };`);
      await focusBox();
      surf.color2 = await q(`return getComputedStyle(r.querySelector('.composer textarea')).color;`);
      check(`${scheme}: full-contrast text, ${L ? '#a1a1a6' : '#636366'} placeholder`, surf.color === (L ? 'rgb(29, 29, 31)' : 'rgb(245, 245, 247)') && surf.color2 === surf.color
        && surf.ph === (L ? 'rgb(161, 161, 166)' : 'rgb(99, 99, 102)'), surf);
      check(`${scheme}: height animates 160 ms ease-out`, /height/.test(anim.p) && anim.d.split(', ')[anim.p.split(', ').indexOf('height')] === '0.16s' && /ease-out/.test(anim.f), anim);

      // ----- Enter sends; the box is 1 line again -----
      const sentBefore = await q(`return r.querySelectorAll('.k-user').length;`);
      await clear();
      await type('Short note\nand a second line');
      await page.keyboard.press('Enter');
      await page.waitForFunction(`${ROOT}.querySelectorAll('.k-user').length > ${sentBefore}`, null, { timeout: 5000 }).catch((err) => { if (err.name !== 'TimeoutError') throw err; });
      await page.waitForFunction(`${ROOT}.querySelector('.composer textarea').value === ''`, null, { timeout: 5000 }).catch((err) => { if (err.name !== 'TimeoutError') throw err; });
      await sleep(300);
      g = await geo();
      check(`${scheme}: Shift+Enter makes new lines, Enter sends, and the box is 1 line again`, (await q(`return r.querySelectorAll('.k-user').length;`)) > sentBefore && g.lines === 1, { lines: g.lines });
      check(`${scheme}: no page errors`, !t.errors.length, t.errors);
      await t.ctx.close();
    });

    // ----- solid box: no backdrop-filter, or less transparency asked -----
    for (const [label, extra, scheme, bg] of [['no backdrop-filter', { noBlur: true }, 'light', 'rgb(255, 255, 255)'], ['reduced transparency', { reducedTransparency: true }, 'light', 'rgb(255, 255, 255)'],
      ['reduced transparency', { reducedTransparency: true }, 'dark', 'rgb(44, 44, 46)']]) {
      const t = await open({ viewport: { width: 1280, height: 820 }, colorScheme: scheme }, extra);
      const s = await t.q(`const cs = getComputedStyle(r.querySelector('.composer .field')); return { bg: cs.backgroundColor, bf: cs.backdropFilter, sh: cs.boxShadow };`);
      check(`${label} (${scheme}): a solid box with the same thin border and shadow`, s.bg === bg && (s.bf === 'none' || !s.bf) && s.sh.includes('0px 0px 0px 0.5px') && s.sh.includes('rgba(0, 0, 0, 0.28) 0px -10px 30px -12px'), s);
      if (label === 'no backdrop-filter') await t.page.screenshot({ path: path.join(outDir, 'glass-solid.png') });
      await t.ctx.close();
    }

    // ----- reduced motion: no animation -----
    {
      const t = await open({ viewport: { width: 1280, height: 820 }, reducedMotion: 'reduce' });
      const d = await t.q(`const cs = getComputedStyle(r.querySelector('.composer textarea')); return cs.transitionDuration.split(', ').every((x) => x === '0s') || cs.transitionProperty === 'none';`);
      check('reduced motion: the box does not animate', d);
      await t.ctx.close();
    }

    // ----- narrow window, phone, floating panel -----
    for (const [label, opts, extra] of [['floating panel', { viewport: { width: 1280, height: 820 } }, { float: true }], ['narrow window (560 px)', { viewport: { width: 560, height: 800 } }], ['phone', { ...devices['iPhone 13'] }]]) {
      const t = await open(opts, extra);
      if (extra) check(`${label}: the panel floats`, await t.q(`return r.querySelector('.panel').classList.contains('float');`));
      await t.focusBox();
      await sleep(250);
      let g = await t.geo();
      check(`${label}: the box is 12 px in from the panel's sides and bottom, 1 line`, g.field && near(g.field.left, g.panel.left + 12) && near(g.field.right, g.panel.right - 12)
        && near(g.field.bottom, g.panel.bottom - 12) && g.lines === 1, { field: g.field, panel: g.panel, lines: g.lines });
      const fits = await t.q(`const f = r.querySelector('.composer .field').getBoundingClientRect(); return [...r.querySelectorAll('.composer .cbar > *')].filter((x) => x.offsetParent).every((x) => { const b = x.getBoundingClientRect(); return b.left >= f.left - 0.5 && b.right <= f.right + 0.5; });`);
      check(`${label}: the bottom row fits inside the box`, fits);
      await t.type('One\nTwo\nThree\nFour\nFive');
      await sleep(300);
      g = await t.geo();
      // All 5 lines, or (wider fonts, a short panel) as many as fit at the cap of half the panel,
      // with the rest scrolling.
      const capped = g.scrolls && g.lines >= 3 && g.field.height >= g.panel.height / 2 - 2;
      check(`${label}: it grows upward with the lines`, (g.lines === 5 || capped) && near(g.field.bottom, g.panel.bottom - 12) && g.nlines === '5 lines',
        { lines: g.lines, capped, field: g.field.height, panel: g.panel.height, nlines: g.nlines });
      if (label === 'phone') await t.page.screenshot({ path: path.join(outDir, 'glass-phone.png') });
      check(`${label}: no page errors`, !t.errors.length, t.errors);
      await t.ctx.close();
    }
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
