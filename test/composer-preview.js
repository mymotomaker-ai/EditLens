'use strict';
require('./isolate');
// The message box and Claude's replies, on a real page and server, without Claude: a typed message
// is kept after a reload and cleared by Send; Up in an empty box shows the last message sent; replies
// keep lists, tables, headings and quotes, with Copy buttons, and text is never read as HTML; pasted
// screenshots appear as cards, refused files get one line.
// usage: NODE_PATH=$(npm root -g) node test/composer-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: composer-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-composer-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '4962' });
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

const PAGE = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:40px">
<h1>App</h1>
<script src="http://127.0.0.1:4962/live.js" data-root="${proj}" data-panel="open"></script></body>`;

const REPLY = [
  '## What I changed',
  'The header is blue now.',
  '',
  '1. Open the file',
  '2. Change the color',
  '   - nested one',
  '   - nested two',
  '3. Save it',
  '',
  '```bash',
  'npm run dev',
  '```',
  '',
  '4. Reload the page',
  '',
  '| File | Change |',
  '| --- | :---: |',
  '| src/App.jsx | color \\| size |',
  '| src/b.css | font |',
  '',
  '> Note: <img src=x onerror="window.hacked=1"> stays text.',
].join('\n');

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
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url.replace(/\/$/, '') });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const errors = [];
    const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const ready = () => page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel textarea')`);
    const box = () => q(`return r.querySelector('.composer textarea').value;`);
    const focusBox = () => q(`r.querySelector('.composer textarea').focus(); return true;`);
    await page.goto(url);
    await ready();
    await sleep(800);

    await section('Draft kept on reload', async () => {
      check('the box says a screenshot can be pasted', (await q(`return r.querySelector('.composer textarea').placeholder;`)) === 'Message Claude, or paste a screenshot…');
      await focusBox();
      await page.keyboard.type('Make the header blue');
      await page.reload();
      await ready();
      await sleep(500);
      check('a typed message is still in the box after a reload', (await box()) === 'Make the header blue', await box());
      await focusBox();
      await page.keyboard.press('Enter');
      await page.waitForFunction(`${ROOT}.querySelectorAll('.k-user').length === 1`, null, { timeout: 5000 });
      // The card can arrive (by the event stream) before the send's own answer empties the box.
      await page.waitForFunction(`${ROOT}.querySelector('.composer textarea').value === ''`, null, { timeout: 5000 }).catch((err) => { if (err.name !== 'TimeoutError') throw err; });
      check('Send empties the box', (await box()) === '', await box());
      await page.reload();
      await ready();
      await sleep(500);
      check('after Send, a reload leaves the box empty', (await box()) === '', await box());
    });

    await section('Up shows the last message again', async () => {
      await focusBox();
      await page.keyboard.press('ArrowUp');
      check('Up in the empty box shows the last message sent from this page again', (await box()) === 'Make the header blue', await box());
      await page.keyboard.type(' now');
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowUp');
      check('Up in a box with text only moves the cursor', (await box()) === 'Make the header blue now', await box());
      await q(`const t = r.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input')); return true;`);
      const other = await ctx.newPage();
      await other.goto(url);
      await other.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel textarea')`);
      await other.evaluate(`${ROOT}.querySelector('.composer textarea').focus()`);
      await other.keyboard.press('ArrowUp');
      check('another tab (another page id) has its own last message', (await other.evaluate(`${ROOT}.querySelector('.composer textarea').value`)) === '');
      await other.close();
    });

    await section('Markdown in replies', async () => {
      await postEvent({ type: 'chat', role: 'assistant', sessionId: 's1', cwd: proj, text: REPLY, ts: Date.now() });
      await page.waitForFunction(`${ROOT}.querySelectorAll('.k-claude .md').length >= 1`, null, { timeout: 5000 });
      const md = await q(`const m = [...r.querySelectorAll('.k-claude .md')].pop();
        const ols = [...m.querySelectorAll(':scope > ol')];
        return {
          h: [...m.querySelectorAll('.h')].map((x) => x.textContent),
          afterHead: m.querySelector('.h') && m.querySelector('.h').nextElementSibling && m.querySelector('.h').nextElementSibling.textContent,
          ol: ols.map((o) => ({ start: o.getAttribute('start'), items: [...o.children].map((li) => li.firstChild.textContent) })),
          nested: [...m.querySelectorAll('ol > li > ul > li')].map((li) => li.textContent),
          th: [...m.querySelectorAll('th')].map((x) => x.textContent),
          td: [...m.querySelectorAll('td')].map((x) => x.textContent),
          align: m.querySelector('th:nth-child(2)') && m.querySelector('th:nth-child(2)').style.textAlign,
          quote: m.querySelector('blockquote') && m.querySelector('blockquote').textContent,
          pre: [...m.querySelectorAll('pre')].map((p) => p.textContent),
          raw: /\\| ---|^##|^> /m.test(m.innerText),
          imgs: m.querySelectorAll('img').length,
          codeCopy: m.querySelectorAll('.cblock .ccopy').length,
          replyCopy: m.closest('.k-claude').querySelectorAll('.who .rcopy').length,
        };`);
      check('a heading with text under it shows without the ##', md.h[0] === 'What I changed' && md.afterHead === 'The header is blue now.', md);
      check('numbered lists stay numbered, and keep their number after a code block', md.ol.length === 2 && md.ol[0].start === null && md.ol[0].items.join('|') === 'Open the file|Change the color|Save it' && md.ol[1].start === '4', md.ol);
      check('nested items stay nested under their item', md.nested.join('|') === 'nested one|nested two', md.nested);
      check('a table shows as a table', md.th.join('|') === 'File|Change' && md.td.join('|') === 'src/App.jsx|color | size|src/b.css|font' && md.align === 'center', md);
      check('a quote shows without the >', md.quote === 'Note: <img src=x onerror="window.hacked=1"> stays text.', md.quote);
      check('text is never read as HTML', md.imgs === 0 && !(await page.evaluate('window.hacked')));
      check('no raw markdown marks', !md.raw);
      check('a Copy button on the reply and on the code block', md.replyCopy === 1 && md.codeCopy === 1, md);
      await q(`[...r.querySelectorAll('.k-claude .cblock .ccopy')].pop().click(); return true;`);
      await sleep(300);
      check('Copy on a code block copies the code', (await page.evaluate('navigator.clipboard.readText()')) === 'npm run dev');
      check('the button says Copied', /Copied/.test(await q(`return [...r.querySelectorAll('.k-claude .cblock .ccopy')].pop().textContent;`)));
      await sleep(1300);
      check('and shows Copy again', (await q(`return [...r.querySelectorAll('.k-claude .cblock .ccopy')].pop().textContent;`)) === 'Copy');
      await q(`[...r.querySelectorAll('.k-claude .rcopy')].pop().click(); return true;`);
      await sleep(300);
      check('Copy on a reply copies the whole reply', (await page.evaluate('navigator.clipboard.readText()')) === REPLY);
      await page.screenshot({ path: path.join(outDir, 'composer-markdown.png') });
    });

    // A paste of the given files into the message box (made in the page: a canvas PNG, or bytes).
    const paste = (files) => page.evaluate(async ([files, root]) => {
      const dt = new DataTransfer();
      for (const f of files) {
        let blob;
        if (f.canvas) {
          const c = document.createElement('canvas');
          c.width = f.canvas[0];
          c.height = f.canvas[1];
          const g = c.getContext('2d');
          g.fillStyle = '#3b82f6';
          g.fillRect(0, 0, c.width, c.height);
          blob = await new Promise((r) => c.toBlob(r, 'image/png'));
        } else blob = new Blob([f.text]);
        dt.items.add(new File([blob], f.name, { type: f.type }));
      }
      const t = eval(root).querySelector('.composer textarea');
      t.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    }, [files, ROOT]);
    const errLine = () => q(`const e = r.querySelector('.shoterr'); return e.hidden ? null : e.textContent;`);
    const REFUSED = "That file can't be added: only PNG, JPEG or WebP up to 5 MB.";

    await section('Pasted screenshot', async () => {
      await focusBox();
      await page.keyboard.type('This looks wrong');
      await paste([{ canvas: [440, 300], name: 'evil<b>.png', type: 'image/png' }]);
      await page.waitForFunction(`${ROOT}.querySelector('.shot:not(.up)')`, null, { timeout: 5000 });
      const card = await q(`const c = r.querySelector('.shot'); const i = c.querySelector('img'); return { text: c.textContent, w: i.getBoundingClientRect().width, h: i.getBoundingClientRect().height };`);
      check('a pasted PNG shows as a card: Screenshot, W × H · size', /^Screenshot440 × 300 · \d+ KB✕$/.test(card.text), card.text);
      check('the card picture is 44×30', Math.round(card.w) === 44 && Math.round(card.h) === 30, card);
      await paste([{ text: 'GIF89a', name: 'a.gif', type: 'image/gif' }]);
      check('a GIF is refused with one line', (await errLine()) === REFUSED, await errLine());
      check('the typed text stays', (await box()) === 'This looks wrong');
      // Says PNG, is not: the server reads the first bytes and refuses it.
      await paste([{ text: 'not really an image', name: 'b.png', type: 'image/png' }]);
      await page.waitForFunction(`${ROOT}.querySelectorAll('.shot').length === 1`, null, { timeout: 5000 });
      check('a file that only says PNG is refused by the server', (await errLine()) === REFUSED, await errLine());
      await paste([{ canvas: [20, 20], name: 'c.png', type: 'image/png' }, { canvas: [20, 20], name: 'd.png', type: 'image/png' }, { canvas: [20, 20], name: 'e.png', type: 'image/png' }]);
      await sleep(800);
      check('at most 3 screenshots in one message', (await q(`return r.querySelectorAll('.shot').length;`)) === 3 && /up to 3/.test(await errLine()), await errLine());
      await q(`[...r.querySelectorAll('.shot .sx')].pop().click(); [...r.querySelectorAll('.shot .sx')].pop().click(); return true;`);
      check('✕ removes a screenshot', (await q(`return r.querySelectorAll('.shot').length;`)) === 1);
      await page.screenshot({ path: path.join(outDir, 'composer-paste.png') });
      await focusBox();
      await page.keyboard.press('Enter');
      await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-user .bshot img')].some((i) => i.complete && i.naturalWidth === 440)`, null, { timeout: 5000 });
      const bubble = await q(`const b = [...r.querySelectorAll('.k-user .bubble')].pop(); const img = b.querySelector('.bshot img'); return { first: b.firstElementChild.className, text: b.textContent, w: img.getBoundingClientRect().width, bw: b.getBoundingClientRect().width, href: b.querySelector('.bshot').href };`);
      check('the sent bubble shows the picture at its top', bubble.first === 'bshots n1' && bubble.text === 'This looks wrong' && bubble.w >= bubble.bw - 2, bubble);
      await page.waitForFunction(`${ROOT}.querySelector('.composer textarea').value === ''`, null, { timeout: 5000 }).catch((err) => { if (err.name !== 'TimeoutError') throw err; });
      check('the box is empty again, without cards or the error line', (await box()) === '' && (await q(`return r.querySelectorAll('.shot').length;`)) === 0 && (await errLine()) === null);
      const [full] = await Promise.all([ctx.waitForEvent('page'), q(`[...r.querySelectorAll('.k-user .bshot')].pop().click(); return true;`)]);
      await full.waitForLoadState();
      const shown = await full.evaluate(() => { const i = document.querySelector('img'); return i ? i.naturalWidth : 0; });
      check('clicking the picture opens it full size', shown === 440 && /\/shot\?id=[0-9a-f]{24}&page=/.test(full.url()), full.url());
      await full.close();
      // Only a screenshot, no text.
      await paste([{ canvas: [30, 30], name: 'x.png', type: 'image/png' }]);
      await page.waitForFunction(`${ROOT}.querySelector('.shot:not(.up)')`, null, { timeout: 5000 });
      await focusBox();
      await page.keyboard.press('Enter');
      await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-user .bubble')].pop().textContent === 'Look at this.'`, null, { timeout: 5000 });
      check('a screenshot alone is sent as "Look at this."', true);
      await page.screenshot({ path: path.join(outDir, 'composer-sent.png') });
      await page.reload();
      await ready();
      await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-user .bshot img')].some((i) => i.complete && i.naturalWidth === 440)`, null, { timeout: 5000 }).then(() => check('after a reload the bubble still shows the picture', true), () => check('after a reload the bubble still shows the picture', false));
    });

    check('no page errors', errors.length === 0, errors);
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
