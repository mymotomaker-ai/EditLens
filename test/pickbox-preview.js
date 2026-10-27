'use strict';
require('./isolate');
// The message box next to a pick: it opens below the picked item (above near the bottom, beside a
// dragged area), Add and Enter put "N note" lines in the panel's box and never send, Esc keeps the
// text, Shift+click moves it to the newest pick, the setting turns it off. Light, dark, narrow, phone.
// usage: NODE_PATH=$(npm root -g) node test/pickbox-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium, devices } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: pickbox-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pickbox-'));
// Manual: opening the page starts no page control setup.
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5259', CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
const { ensureServer, stopServer, getJson } = require('../lib/client');
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hill Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:40px 60px;max-width:640px}h1{font-size:40px;line-height:1.1;margin:0 0 12px}
.order{display:inline-block;padding:10px 18px;border:0;border-radius:10px;background:#c4592f;color:#fff;font:600 15px system-ui}.menu{list-style:none;padding:0;margin:40px 0 0;width:260px}
.menu li{display:flex;justify-content:space-between;padding:8px 0}.tall{height:900px}footer{padding:14px 60px;color:#666;font-size:13px}
@media (prefers-color-scheme:dark){body{background:#18181a;color:#eee}}</style>
</head><body><main><h1 id="h">New coffee each day</h1><p id="lede">Small-batch roasts, brewed slowly, served at the bottom of the hill.</p>
<button class="order" id="order">Order now</button>
<ul class="menu" id="menu"><li id="e">Espresso <b>$3.00</b></li><li>Flat white <b>$4.25</b></li><li id="m">Mocha <b>$4.50</b></li></ul><div class="tall"></div></main>
<footer id="foot">© 2026 Hill Coffee · Open 7–5 daily</footer>
<script src="http://127.0.0.1:5259/live.js" data-root="${proj}" data-panel="open" data-settle="300"></script></body></html>`;

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium);
  const take = () => getJson(`/messages/take?cwd=${encodeURIComponent(proj)}&via=prompt`);

  async function open(opts) {
    const ctx = await browser.newContext(opts);
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    const q = (js) => page.evaluate(`(() => { const r = ${ROOT}; ${js} })()`);
    const rect = (sel) => page.evaluate((s) => { const b = document.querySelector(s).getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height }; }, sel);
    const startPick = async () => {
      await q(`r.querySelector('.icon.pt').click(); return true;`);
      await sleep(100);
    };
    // x: how far in from the left (default: the middle)
    const clickOn = async (sel, shift, x) => {
      const b = await rect(sel);
      const at = [x ? b.left + x : b.left + b.width / 2, b.top + b.height / 2];
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.move(at[0], at[1]);
      await page.mouse.click(at[0], at[1]);
      if (shift) await page.keyboard.up('Shift');
      await sleep(250);
    };
    const box = () => q(`const n = r.querySelector('.notebox'); const b = n.getBoundingClientRect();
      return { on: n.classList.contains('on'), side: n.dataset.side, left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width,
        chip: n.querySelector('.nbchip').textContent, badges: n.querySelectorAll('.nbchip i').length, hint: !n.querySelector('.nbhint').hidden,
        addOff: n.querySelector('.nbadd').disabled, focused: r.activeElement === n.querySelector('textarea'), list: n.querySelectorAll('.nbli').length,
        listShown: getComputedStyle(n.querySelector('.nblist')).display !== 'none' };`);
    const panelText = () => q(`return r.querySelector('.composer textarea').value;`);
    return { ctx, page, q, rect, startPick, clickOn, box, panelText, errors };
  }

  try {
    for (const scheme of ['light', 'dark']) {
      // Dark runs as a Mac, for the dictation key in the hint.
      const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
      const t = await open({ viewport: { width: 1280, height: 820 }, colorScheme: scheme, userAgent: scheme === 'dark' ? MAC : undefined });
      const { page, q, rect, startPick, clickOn, box, panelText } = t;

      // The page shows messages sent before (from the other color scheme's run): count only new ones.
      const sentBefore = await q(`return r.querySelectorAll('.k-user').length;`);
      await startPick();
      await clickOn('#h');
      let b = await box();
      const h = await rect('#h');
      check(`${scheme}: a pick opens the box just below it, with a point toward it`, b.on && b.side === 'dn' && b.top >= h.bottom + 8 && b.top <= h.bottom + 14 && Math.abs(b.left - h.left) < 12, { b, h });
      check(`${scheme}: about 380 px wide, inside the window`, Math.round(b.width) === 380 && b.left >= 8 && b.right <= 1272, b);
      check(`${scheme}: the chip has the pick's number and what it is`, b.badges === 1 && b.chip === '1heading “New coffee each…”', b.chip);
      check(`${scheme}: the note field has the focus; Add is grey until something is typed; the hint shows the first time`, b.focused && b.addOff && b.hint, b);
      const speak = await q(`return [...r.querySelectorAll('.notebox .nbhint span')].map((x) => x.textContent);`);
      check(`${scheme}: the hint names the system's dictation key on a Mac, nothing on Linux`, scheme === 'dark' ? speak[2] === 'Fn Fn to speak' : speak.length === 2, speak);
      check(`${scheme}: both boxes say how to speak instead of typing`, await q(`return [r.querySelector('.notebox textarea'), r.querySelector('.composer textarea')].every((x) => /Win\\+H on Windows, Fn twice on a Mac, the mic key on a phone keyboard/.test(x.title));`));
      check(`${scheme}: the arrow points at the item`, await q(`const n = r.querySelector('.notebox'); return parseFloat(n.style.getPropertyValue('--ax')) >= 12;`));
      await page.screenshot({ path: path.join(outDir, `pickbox-${scheme}-open.png`) });

      await page.keyboard.type('Make the heading bolder');
      b = await box();
      check(`${scheme}: Add turns blue once there is text`, !b.addOff, b);
      await page.keyboard.press('Enter');
      await sleep(200);
      b = await box();
      check(`${scheme}: Enter closes the box`, !b.on, b);
      check(`${scheme}: the note is in the panel's box after its number`, (await panelText()) === '1 Make the heading bolder', await panelText());
      check(`${scheme}: the panel's box has the focus, the cursor at the end`, await q(`const t = r.querySelector('.composer textarea'); return r.activeElement === t && t.selectionStart === t.value.length;`));
      check(`${scheme}: a short message says it was added`, await q(`return /Added to your message · Send when ready/.test(r.querySelector('.toast').textContent) && r.querySelector('.toast').classList.contains('on');`));
      check(`${scheme}: the pick is attached in the panel, as with the pointer`, await q(`return [...r.querySelectorAll('.composer .atts .att b')].map((x) => x.textContent).join() === '1';`));
      check(`${scheme}: the pick's number in the panel's box has a round mark behind it`, await q(`const m = r.querySelector('.inmarks .imk'); const t = r.querySelector('.composer textarea').getBoundingClientRect();
        if (!m || m.textContent !== '1') return false; const k = m.getBoundingClientRect(); return k.left - t.left < 3 && k.top - t.top < 8;`));

      await startPick();
      await clickOn('#order');
      b = await box();
      check(`${scheme}: the hint shows only on the first use`, b.on && !b.hint, b);
      await page.keyboard.type('Make it green');
      await page.keyboard.press('Shift+Enter');
      await page.keyboard.type('and a bit larger');
      const tall = await box();
      check(`${scheme}: Shift+Enter starts a new line and the box grows`, tall.on && tall.bottom - tall.top > b.bottom - b.top + 10, { tall, b });
      await page.screenshot({ path: path.join(outDir, `pickbox-${scheme}-typing.png`) });
      const before = await box();
      await page.mouse.wheel(0, 120);
      await sleep(300);
      const after = await box();
      check(`${scheme}: the box moves with the page when it scrolls`, Math.abs(before.top - after.top - 120) < 4, { before: before.top, after: after.top });
      await page.mouse.wheel(0, -120);
      await sleep(200);
      await q(`r.querySelector('.notebox .nbadd').click(); return true;`);
      await sleep(200);
      check(`${scheme}: the panel's box grows to show the lines`, await q(`const t = r.querySelector('.composer textarea'); return t.clientHeight >= t.scrollHeight - 2 && t.clientHeight > 60;`));
      check(`${scheme}: Add puts the second note on its own line`, (await panelText()) === '1 Make the heading bolder\n2 Make it green\nand a bit larger', await panelText());
      await page.screenshot({ path: path.join(outDir, `pickbox-${scheme}-added.png`) });
      check(`${scheme}: nothing was sent by Add or Enter`, (await take()).messages.length === 0 && (await q(`return r.querySelectorAll('.k-user').length;`)) === sentBefore);

      await startPick();
      await clickOn('#m');
      await page.keyboard.type('Draft');
      await page.keyboard.press('Escape');
      await sleep(200);
      b = await box();
      check(`${scheme}: Esc closes the box and keeps the pick and the typed text`, !b.on && (await panelText()).endsWith('\n3 Draft') &&
        (await q(`return r.querySelectorAll('.composer .atts .att').length;`)) === 3, { b, text: await panelText() });
      check(`${scheme}: Esc stopped picking too`, await q(`return !r.querySelector('.catcher').classList.contains('on');`));

      await startPick();
      await clickOn('#lede', true);
      b = await box();
      const lede = await rect('#lede');
      check(`${scheme}: Shift+click opens the box at that pick and picking continues`, b.on && b.top >= lede.bottom + 8 && await q(`return r.querySelector('.catcher').classList.contains('on');`), b);
      await clickOn('#e');
      b = await box();
      const e = await rect('#e');
      check(`${scheme}: a second pick moves the box to the newest one`, b.on && b.top >= e.bottom + 8 && b.top <= e.bottom + 14, { b, e });
      check(`${scheme}: the chip stacks both numbers: "2 picks"`, b.badges === 2 && b.chip === '452 picks', b.chip);
      await q(`r.querySelector('.notebox .nbchip').dispatchEvent(new MouseEvent('mouseenter')); return true;`);
      await sleep(100);
      b = await box();
      check(`${scheme}: pointing at the chip lists them, each with ×`, b.listShown && b.list === 2, b);
      await page.screenshot({ path: path.join(outDir, `pickbox-${scheme}-two.png`) });
      await q(`r.querySelector('.notebox .nbli button').click(); return true;`);
      await sleep(100);
      b = await box();
      check(`${scheme}: × removes that pick (here and in the panel)`, b.on && b.badges === 1 && /^5/.test(b.chip) &&
        !(await q(`return [...r.querySelectorAll('.composer .atts .att b')].some((x) => x.textContent === '4');`)), b);
      await q(`r.querySelector('.notebox textarea').focus(); return true;`);
      await page.keyboard.type('Same font as the heading');
      await page.keyboard.press('Enter');
      await sleep(200);
      check(`${scheme}: the note goes in after the pick's number`, (await panelText()).endsWith('\n5 Same font as the heading'), await panelText());

      // A dragged area: the box opens beside it, not inside it.
      await startPick();
      const menu = await rect('#menu');
      await page.mouse.move(menu.left - 6, menu.top - 6);
      await page.mouse.down();
      await page.mouse.move(menu.left + 120, menu.top + 40, { steps: 4 });
      await page.mouse.move(menu.right + 6, menu.bottom + 6, { steps: 4 });
      await page.mouse.up();
      await sleep(250);
      b = await box();
      check(`${scheme}: a dragged area gets the box beside it`, b.on && b.side === 'lf' && b.left >= menu.right + 14 && b.top >= menu.top - 10 && b.chip === '6area', b);
      await page.screenshot({ path: path.join(outDir, `pickbox-${scheme}-area.png`) });
      await page.keyboard.press('Escape');
      await sleep(150);
      check(`${scheme}: Esc with nothing typed adds no line`, (await panelText()).endsWith('\n5 Same font as the heading') && !(await box()).on);

      // Near the bottom of the window: above.
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(200);
      await startPick();
      await clickOn('#foot', false, 80); // left of the middle, where a message may show
      b = await box();
      const foot = await rect('#foot');
      check(`${scheme}: near the bottom of the window it opens above the pick`, b.on && b.side === 'up' && b.bottom <= foot.top - 8 && b.bottom >= foot.top - 14, { b, foot });
      await page.screenshot({ path: path.join(outDir, `pickbox-${scheme}-above.png`) });
      await page.mouse.click(400, 300);
      await sleep(150);
      check(`${scheme}: a click elsewhere closes it`, !(await box()).on);
      await page.evaluate(() => window.scrollTo(0, 0));

      // P1 (command check of 0.24.40): an item already picked opens the box at it again; nothing new
      // is attached, and Enter adds a line, never sends.
      await startPick();
      await clickOn('#h');
      b = await box();
      check(`${scheme}: clicking an item already picked opens the box at it`, b.on && b.chip.startsWith('1') && b.focused, b);
      check(`${scheme}: nothing new is attached`, (await q(`return r.querySelectorAll('.composer .atts .att').length;`)) === 6);
      await page.keyboard.type('And darker');
      await page.keyboard.press('Enter');
      await sleep(200);
      check(`${scheme}: its note goes in with the same number, not sent`, (await panelText()).endsWith('\n1 And darker') && (await take()).messages.length === 0, await panelText());

      // Send: one message with the notes and the picks.
      await q(`r.querySelector('.composer .send').click(); return true;`);
      await sleep(600);
      const msgs = (await take()).messages;
      const m = msgs[0] || {};
      check(`${scheme}: Send sends the notes with the picks`, msgs.length === 1 && m.text === '1 Make the heading bolder\n2 Make it green\nand a bit larger\n3 Draft\n5 Same font as the heading\n1 And darker' &&
        (m.attachments || []).map((a) => a.n).join() === '1,2,3,5,6,7', m);

      // Off: picking goes straight to the panel's box, as before.
      await q(`r.querySelector('.head button[aria-label="More"]').click(); return true;`);
      await sleep(150);
      const row = 'const b = [...r.querySelectorAll(\'[role="menuitemcheckbox"]\')].find((x) => /Message box next to what you pick/.test(x.textContent));';
      check(`${scheme}: the More menu has the switch, on`, await q(`${row} return Boolean(b) && b.getAttribute('aria-checked') === 'true' && /Off: you type in the panel/.test(b.textContent);`));
      await page.screenshot({ path: path.join(outDir, `pickbox-${scheme}-setting.png`) });
      await q(`${row} b.click(); return true;`);
      await sleep(200);
      await startPick();
      await clickOn('#order');
      check(`${scheme}: turned off: no box, the panel's box has the focus`, !(await box()).on && await q(`return r.activeElement === r.querySelector('.composer textarea');`));
      await q(`r.querySelector('.head button[aria-label="More"]').click(); return true;`);
      await sleep(150);
      check(`${scheme}: the switch shows off`, await q(`${row} return b.getAttribute('aria-checked') === 'false';`));
      await page.keyboard.press('Escape');
      check(`${scheme}: no page errors`, !t.errors.length, t.errors);
      await t.ctx.close();
      await take();
    }

    // P1: at the 12-pick limit no box opens, and the focus does not go to the panel's box, so Enter
    // sends nothing.
    const full = await open({ viewport: { width: 1280, height: 820 } });
    await full.startPick();
    for (let i = 0; i < 12; i++) {
      await full.page.keyboard.down('Shift');
      // One column on the left: the box opens to the right of each area, away from the next one.
      await full.page.mouse.move(100, 440 + i * 30);
      await full.page.mouse.down();
      await full.page.mouse.move(120, 460 + i * 30, { steps: 3 });
      await full.page.mouse.up();
      await full.page.keyboard.up('Shift');
      await sleep(120);
    }
    await full.page.keyboard.press('Escape');
    await sleep(150);
    const twelve = await full.q(`return r.querySelectorAll('.composer .atts .att').length;`);
    await full.q(`const t = r.querySelector('.composer textarea'); t.focus(); return true;`);
    await full.startPick();
    await full.clickOn('#order');
    check('12 picks: one more opens no box and says the limit', twelve === 12 && !(await full.box()).on && await full.q(`return /up to 12/.test(r.querySelector('.toast').textContent);`), twelve);
    check('12 picks: the focus is not in the panel\'s box', await full.q(`return r.activeElement !== r.querySelector('.composer textarea');`));
    await full.page.keyboard.type('x');
    await full.page.keyboard.press('Enter');
    await sleep(300);
    check('12 picks: typing and Enter send nothing', (await take()).messages.length === 0 && (await full.panelText()) === '', await full.panelText());
    check('12 picks: no page errors', !full.errors.length, full.errors);
    await full.ctx.close();

    // Numbers come from the picks still attached (and the ones sent): a removed pick's number is
    // used again, and with nothing attached the next pick is 1 (the user's report, 0.24.45).
    const nums = await open({ viewport: { width: 1280, height: 820 } });
    const area = async (i) => {
      await nums.page.keyboard.down('Shift');
      await nums.page.mouse.move(100, 440 + i * 40);
      await nums.page.mouse.down();
      await nums.page.mouse.move(120, 460 + i * 40, { steps: 3 });
      await nums.page.mouse.up();
      await nums.page.keyboard.up('Shift');
      await sleep(150);
      await nums.page.keyboard.press('Escape');
      await sleep(150);
    };
    const chips = () => nums.q(`return [...r.querySelectorAll('.composer .atts .att b')].map((x) => x.textContent).join();`);
    const remove = (n) => nums.q(`r.querySelector('.composer .atts .att button[aria-label="Remove ${n}"]').click(); return true;`);
    for (let i = 0; i < 4; i++) {
      await nums.startPick();
      await area(i);
    }
    await remove(2);
    await remove(3);
    await remove(4);
    await nums.startPick();
    await area(4);
    check('numbers: after removing 2, 3 and 4, the next pick is 2', (await chips()) === '1,2', await chips());
    await remove(1);
    await remove(2);
    await nums.startPick();
    await area(5);
    check('numbers: with every pick removed, the next one is 1', (await chips()) === '1', await chips());
    await nums.page.reload();
    await nums.page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    await nums.startPick();
    await area(0);
    check('numbers: after a reload with nothing attached, the next pick is 1', (await chips()) === '1', await chips());
    check('numbers: no page errors', !nums.errors.length, nums.errors);
    await nums.ctx.close();

    // A narrow window and a phone: the pick goes to the panel's box, as before.
    const narrow = await open({ viewport: { width: 560, height: 800 } });
    await narrow.startPick();
    await narrow.clickOn('#h', false, 40); // the panel covers the middle of the page here
    check('narrow window (< 600 px): no box, the pick is in the panel', !(await narrow.box()).on && await narrow.q(`return r.querySelectorAll('.composer .atts .att').length === 1;`));
    check('narrow: no page errors', !narrow.errors.length, narrow.errors);
    await narrow.ctx.close();

    const phone = await open({ ...devices['iPhone 13'] });
    await phone.startPick();
    const o = await phone.rect('#h');
    await phone.page.touchscreen.tap(o.left + 40, o.top + o.height / 2);
    await sleep(300);
    check('phone: no box, the pick is in the panel', !(await phone.box()).on && await phone.q(`return r.querySelectorAll('.composer .atts .att').length === 1;`));
    await phone.page.screenshot({ path: path.join(outDir, 'pickbox-phone.png') });
    check('phone: no page errors', !phone.errors.length, phone.errors);
    await phone.ctx.close();
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
