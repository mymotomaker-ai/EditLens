#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4984';
// Code on hover, on examples/vite-router (the same site as page-follow-preview.js): an edited part
// shows old → new with the changed words marked, file:line, who and when; a stepper for two edits;
// stylesheet rules; "New" for new code; a dashed outline for a removed part; the card on screen and
// never under the code view; the "Show code on hover" setting.
//   NODE_PATH=$(npm root -g) node test/hover-preview.js <site-url> <site-dir> <out-dir>
// The removal test edits src/pages/Overview.jsx for real and puts it back afterwards.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'hover-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: hover-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `hover-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const file = (rel) => path.join(siteDir, rel);
// A made-up edit (the file on disk stays as it is): replace `from` with `to` on its line.
async function edit(rel, from, to, opts = {}) {
  const before = fs.readFileSync(file(rel), 'utf8');
  const lines = before.split('\n');
  const n = lines.findIndex((l) => l.includes(from)) + 1;
  const hunk = opts.addOnly
    ? { oldStart: n, newStart: n, lines: ['+' + to, ' ' + lines[n - 1]] }
    : { oldStart: n, newStart: n, lines: ['-' + lines[n - 1], '+' + lines[n - 1].replace(from, to)] };
  const after = opts.addOnly ? before.replace(lines[n - 1], to + '\n' + lines[n - 1]) : before.replace(from, to);
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file: file(rel), relFile: rel, ts: Date.now(),
    agentId: opts.agentId || null, agentType: opts.agentId ? 'general-purpose' : null, before, after,
    stats: { added: 1, removed: opts.addOnly ? 0 : 1 }, hints: {}, hunks: [hunk],
  });
}

(async () => {
  const overview = file('src/pages/Overview.jsx');
  const original = fs.readFileSync(overview, 'utf8');
  await stopServer(); // this server version knows the hover_code setting
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 820 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('[pageerror]', e.message); });
  // Skip the tour; localStorage can throw in private mode.
  await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const card = () => q(`const c = r.querySelector('.peek'); if (!c || !c.classList.contains('on')) return null;
    const b = c.getBoundingClientRect();
    return { text: c.innerText, badge: (c.querySelector('.pkbadge') || {}).textContent, file: (c.querySelector('.pkfile') || {}).textContent,
      marks: [...c.querySelectorAll('mark')].map((m) => m.textContent), pinned: c.classList.contains('pinned'),
      box: { left: b.left, top: b.top, right: b.right, bottom: b.bottom } }`);
  const waitCard = (ms = 3000) => page.waitForFunction(`${ROOT}.querySelector('.peek.on')`, null, { timeout: ms }).then(() => true, onTimeout(false));
  // Away first (a blank spot at the bottom), so the card from before is gone.
  async function hover(selector) {
    const vp = page.viewportSize();
    await page.mouse.move(4, vp.height - 4);
    await page.waitForFunction(`!${ROOT}.querySelector('.peek.on')`, null, { timeout: 2000 }).catch((err) => {
      if (err.name !== 'TimeoutError') throw err;
    });
    const b = await page.locator(selector).first().boundingBox();
    await page.mouse.move(b.x + Math.min(10, b.width / 2), b.y + b.height / 2, { steps: 3 });
  }
  const panelOff = () => q(`const p = r.querySelector('.panel'); if (p) p.style.visibility = 'hidden'; return true;`);
  await panelOff();

  // 1. Source lines edited: old → new beside the cell, with the changed word marked.
  await page.click('nav a:has-text("Reports")');
  await page.click('button:has-text("Customers")');
  await page.waitForTimeout(400);
  await edit('src/pages/Customers.jsx', '<td>Acme</td>', '<td>Acme Corp</td>');
  await page.waitForTimeout(800);
  await hover('td:has-text("Acme")');
  check('hovering the edited row shows the card', await waitCard(), await card());
  let c = await card();
  check('card: Text badge, file:line, the new word marked', c && c.badge === 'Text' && /Customers\.jsx:5$/.test(c.file) && c.marks.includes('Corp'), c);
  check('card: who made it and when', c && /Main/.test(c.text) && /now|s\b/.test(c.text), c && c.text);
  const tdBox = await page.locator('td:has-text("Acme")').first().boundingBox();
  check('card sits beside the part, not over it', c && (c.box.left >= tdBox.x + tdBox.width || c.box.right <= tdBox.x || c.box.top >= tdBox.y + tdBox.height || c.box.bottom <= tdBox.y), { card: c && c.box, td: tdBox });
  await page.screenshot({ path: path.join(outDir, 'hover-1-text.png') });

  // 2. A second edit to the same part: a stepper. Click to keep it open; Esc closes it.
  await edit('src/pages/Customers.jsx', '<td>12</td>', '<td>14</td>', { agentId: 'agH' });
  await page.waitForTimeout(800);
  await hover('td:has-text("Acme")');
  await waitCard();
  c = await card();
  check('two edits here: 1 of 2', c && /1 of 2/.test(c.text), c && c.text);
  await q(`r.querySelector('.peek .pkstep button:last-child').click(); return true;`);
  c = await card();
  check('stepper goes to the other edit', c && /2 of 2/.test(c.text), c && c.text);
  await q(`r.querySelector('.peek').click(); return true;`);
  c = await card();
  check('a click keeps it open', c && c.pinned, c);
  await page.mouse.move(700, 700);
  await page.waitForTimeout(700);
  check('pinned: stays while the pointer is away', Boolean(await card()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc closes it', !(await card()));

  // 3. A stylesheet: the rule, and how many elements it affects here.
  await edit('src/app.css', 'gap:12px', 'gap:16px');
  await page.waitForTimeout(1200);
  await hover('nav.nav');
  check('hovering the nav shows the stylesheet change', await waitCard(), await card());
  c = await card();
  check('card: Style badge, the rule, elements affected', c && c.badge === 'Style' && /Rule \.nav · affects 1 element on this page/.test(c.text), c && c.text);
  await page.screenshot({ path: path.join(outDir, 'hover-2-css.png') });

  // 4. Code that is new: "New".
  await page.click('nav a:has-text("Overview")');
  await page.waitForTimeout(500);
  await edit('src/pages/Overview.jsx', '<h1>Overview</h1>', '      <span className="badge">Beta</span>', { addOnly: true });
  await page.waitForTimeout(800);
  await hover('h1');
  check('hovering the new part shows the card', await waitCard(), await card());
  c = await card();
  check('card: New badge with only the added code', c && c.badge === 'New' && /\+\s+<span className="badge">Beta<\/span>/.test(c.text) && !/^-/m.test(c.text), c && c.text);

  // 5. A real edit that removes a part: a dashed outline where it was, with the removed code.
  await page.mouse.move(2, 2);
  const lines = original.split('\n');
  const at = lines.findIndex((l) => l.includes('className="lead"')) + 1;
  // Put back even when a step below fails.
  try {
    fs.writeFileSync(overview, original.replace(lines[at - 1] + '\n', ''));
    await postEvent({
      type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file: overview, relFile: 'src/pages/Overview.jsx', ts: Date.now(),
      before: original, after: original.replace(lines[at - 1] + '\n', ''), stats: { added: 0, removed: 1 }, hints: {},
      hunks: [{ oldStart: at, newStart: at, lines: ['-' + lines[at - 1]] }],
    });
    const ghost = await page.waitForFunction(`${ROOT}.querySelector('.ghost')`, null, { timeout: 6000 }).then(() => true, (err) => {
      if (err.name !== 'TimeoutError') throw err;
      return false;
    });
    check('a removed part leaves a dashed outline', ghost);
    if (ghost) {
      const g = await q(`const b = r.querySelector('.ghost').getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 };`);
      await page.mouse.move(4, 800);
      await page.waitForFunction(`!${ROOT}.querySelector('.peek.on')`, null, { timeout: 2000 }).catch((err) => {
        if (err.name !== 'TimeoutError') throw err;
      });
      await page.mouse.move(g.x, g.y, { steps: 3 });
      check('hovering the dashed outline shows the card', await waitCard(), await card());
      c = await card();
      check('card: Removed badge with the removed code', c && c.badge === 'Removed' && /Welcome back\./.test(c.text), c && c.text);
      await page.screenshot({ path: path.join(outDir, 'hover-3-removed.png') });
    }
  } finally {
    fs.writeFileSync(overview, original);
  }
  await page.waitForTimeout(800);

  // 6. Narrow window: the card stays fully on screen. Wide with the code view open: never under it.
  await page.mouse.move(4, 700);
  await page.keyboard.press('Escape');
  await page.click('nav a:has-text("Reports")');
  await page.click('button:has-text("Customers")');
  await q(`const b = r.querySelector('.dhead [title^="Close the code view"]'); if (b && b.offsetParent) b.click(); return true;`);
  await page.setViewportSize({ width: 480, height: 760 });
  await page.waitForTimeout(400);
  await hover('td:has-text("Acme")');
  await waitCard();
  c = await card();
  check('480px: the card is fully on screen', c && c.box.left >= 0 && c.box.right <= 480 && c.box.top >= 0 && c.box.bottom <= 760, c && c.box);
  await page.screenshot({ path: path.join(outDir, 'hover-4-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 820 });
  await q(`[...r.querySelectorAll('button')].find((b) => /^Split screen/.test(b.title || '')).click(); return true;`);
  await page.waitForTimeout(600);
  await hover('td:has-text("Acme")');
  await waitCard();
  c = await card();
  const dockLeft = await q(`const d = r.querySelector('.dock'); return d && getComputedStyle(d).display !== 'none' ? d.getBoundingClientRect().left : null;`);
  check('wide, code view open: the card stays left of it', c && dockLeft !== null && c.box.right <= dockLeft + 1, { card: c && c.box, dockLeft });
  await page.screenshot({ path: path.join(outDir, 'hover-5-dock.png') });

  // 7. The setting: off means no card.
  await q(`const p = r.querySelector('.panel'); p.style.visibility = ''; return true;`);
  await q(`[...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More' || b.title === 'More').click(); return true;`);
  await page.waitForTimeout(200);
  await q(`[...r.querySelectorAll('.lmenu button, .lmenu [role=menuitem]')].find((b) => /Settings/.test(b.textContent)).click(); return true;`);
  await page.waitForTimeout(800);
  const sw = await q(`const s = r.querySelector('[role=switch][aria-label="Show code on hover"]'); return s ? s.getAttribute('aria-checked') : null;`);
  check('settings: "Show code on hover" is there and on', sw === 'true', sw);
  await q(`r.querySelector('[role=switch][aria-label="Show code on hover"]').click(); return true;`);
  await page.waitForTimeout(300);
  await panelOff();
  await hover('td:has-text("Acme")');
  await page.waitForTimeout(900);
  check('turned off: no card', !(await card()));
  check('no page errors', errors.length === 0, errors);
  await page.evaluate(() => localStorage.removeItem('editlens.hoverCode'));
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
