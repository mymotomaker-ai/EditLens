'use strict';
require('./isolate');
// The Attach button in the panel's message box (decision D17): a quiet icon button right after the mode
// (handoff section 19) that opens the file picker for PNG, JPEG or WebP. Picked files are added as pasted
// screenshots are: the same cards, limit of 3 files and 5 MB, and error line. Reachable by Tab, opened by
// Enter or Space, off with its reason on a page that can't message Claude. The mic and Send stay together
// on the right edge, also when the row wraps. Light, dark, a floating panel, a narrow window, a phone.
// usage: NODE_PATH=$(npm root -g) node test/attach-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium, devices } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: attach-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-attach-'));
// Manual: opening the page starts no page control setup.
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5430', CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
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

const page = (root) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hill Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:40px 60px}h1{font-size:40px;margin:0 0 12px}
@media (prefers-color-scheme:dark){body{background:#18181a;color:#eee}}</style>
</head><body><main><h1>New coffee each day</h1><p>Small-batch roasts, brewed slowly, served at the bottom of the hill.</p></main>
<script src="http://127.0.0.1:5430/live.js"${root ? ` data-root="${proj}"` : ''} data-panel="open" data-settle="300"></script></body></html>`;

const REFUSED = "That file can't be added: only PNG, JPEG or WebP up to 5 MB.";
const TOO_MANY = 'You can add up to 3 screenshots to one message.';

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now() });
  for (const text of ['It\'s the **Mocha** at $4.50.', 'Done. The Mocha row now has a soft orange background.', 'The prices line up on the right.']) {
    await postEvent({ type: 'chat', role: 'assistant', sessionId: 's1', cwd: proj, text, ts: Date.now() });
  }
  await postEvent({ type: 'mode-ping', sessionId: 's1', cwd: proj, permissionMode: 'acceptEdits' });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page(!req.url.startsWith('/noroot')));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium);
  let PNG = null;
  let JPEG = null;
  const png = (name) => ({ name, mimeType: 'image/png', buffer: PNG });

  async function open(opts, extra = {}) {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    if (extra.float) {
      await ctx.addInitScript(() => {
        const layout = { panel: { mode: 'float', corner: 'br', x: 120, y: 60, w: 380, h: 600 }, dock: { mode: 'right', bh: null, x: null, y: null, w: null, h: null }, agents: { x: null, b: null } };
        try { localStorage.setItem('editlens.layout', JSON.stringify(layout)); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; }
      });
    }
    const errors = [];
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    // File pickers are caught from the start: Playwright turns this on asynchronously when the first
    // listener is added, and a picker opened before that is missed.
    p.on('filechooser', () => {});
    await p.goto(base + (extra.noRoot ? 'noroot' : ''));
    await p.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel textarea')`);
    await sleep(900);
    const q = (js) => p.evaluate(`(() => { const r = ${ROOT}; ${js} })()`);
    return { ctx, page: p, q, errors };
  }
  // Where the Attach button is: in the box's bottom row right after the mode control (and its effort
  // chip), on the mode's line, before Commands, the mic and Send, the mic's size, inside the box.
  const placeQ = `const f = r.querySelector('.composer .field'), bar = f && f.querySelector('.cbar'), a = r.querySelector('.composer .attach');
    if (!a) return null;
    const m = r.querySelector('.composer .mic'), s = r.querySelector('.composer .send'), mic = m && m.offsetParent ? m : null;
    const R = (n) => n.getBoundingClientRect(), ab = R(a), fb = R(f), mode = r.querySelector('.composer .pmode'), mb = R(mode);
    const shown = [...bar.querySelectorAll('button, .nlines')].filter((x) => x.offsetParent);
    const at = shown.indexOf(a), pm = shown.filter((x) => x.classList.contains('pmode')).pop();
    const after = (sel) => { const x = bar.querySelector(sel); return !x || shown.indexOf(x) < 0 || shown.indexOf(x) > at; };
    return { inBar: bar.contains(a), order: shown.map((x) => x.className.split(' ')[0]), afterMode: at > 0 && shown[at - 1] === pm,
      beforeRest: after('.slash') && after('.mic') && after('.send'),
      shown: Boolean(a.offsetParent), label: a.getAttribute('aria-label'), title: a.title, type: a.type, svg: Boolean(a.querySelector('svg')),
      row: Math.abs(ab.top + ab.height / 2 - mb.top - mb.height / 2) < 3,
      inside: ab.left >= fb.left - 0.5 && ab.right <= fb.right + 0.5 && ab.top >= fb.top - 0.5 && ab.bottom <= fb.bottom + 0.5,
      size: mic ? [Math.round(ab.width), Math.round(ab.height), Math.round(R(mic).width), Math.round(R(mic).height)] : null,
      color: getComputedStyle(a).color, micColor: m ? getComputedStyle(m).color : null };`;
  const placed = (label, p) => {
    check(`${label}: an Attach button in the box's bottom row`, p && p.inBar && p.shown && p.type === 'button' && p.svg, p);
    check(`${label}: right after the mode control, on its line, before Commands, the mic and Send, inside the box`, p && p.afterMode && p.beforeRest && p.row && p.inside, p);
    check(`${label}: the mic's size and color`, p && (!p.size || (Math.abs(p.size[0] - p.size[2]) <= 1 && Math.abs(p.size[1] - p.size[3]) <= 1)) && p.color === p.micColor, p);
  };

  // Send ends within 24 px of the box's inner right edge, and the mic is on Send's line, just before it.
  const rightQ = `const f = r.querySelector('.composer .field'), s = r.querySelector('.composer .send'), m = r.querySelector('.composer .mic');
    const fb = f.getBoundingClientRect(), sb = s.getBoundingClientRect(), mic = m && m.offsetParent ? m.getBoundingClientRect() : null;
    const inner = fb.right - parseFloat(getComputedStyle(f).paddingRight);
    return { gap: inner - sb.right, mic: Boolean(mic), micLine: !mic || (Math.abs(mic.top + mic.height / 2 - sb.top - sb.height / 2) < 3 && mic.right <= sb.left + 0.5) };`;
  const onRight = (label, g) => check(`${label}: Send at the box's right edge, the mic on its line`, g && g.gap >= -0.5 && g.gap <= 24 && g.micLine, g);

  // No bottom-row control has its text cut short ("…" or text past its edge): with no room, controls
  // move to the next line instead.
  const clipQ = `const bar = r.querySelector('.composer .cbar');
    return [...bar.querySelectorAll('*')].filter((x) => x.offsetParent && x.textContent.trim() && x.clientWidth > 0).filter((x) => {
      const cs = getComputedStyle(x);
      return x.scrollWidth > x.clientWidth + 1 || (cs.textOverflow === 'ellipsis' && cs.overflow !== 'visible' && x.scrollWidth > x.clientWidth);
    }).map((x) => x.className + ': ' + x.textContent.trim() + ' (' + x.scrollWidth + ' > ' + x.clientWidth + ')');`;
  const noClip = async (label, q) => {
    const c = await q(clipQ);
    check(`${label}: no bottom-row control is cut short`, Array.isArray(c) && !c.length, c);
  };

  const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
  try {
    // Real PNG and JPEG bytes (the server reads the first bytes), from a page of their own.
    const maker = await browser.newPage({ viewport: { width: 200, height: 200 } });
    await maker.setContent('<body style="margin:0;background:#3b82f6"></body>');
    PNG = await maker.screenshot({ clip: { x: 0, y: 0, width: 40, height: 30 } });
    JPEG = await maker.screenshot({ type: 'jpeg', clip: { x: 0, y: 0, width: 24, height: 24 } });
    await maker.close();
    for (const scheme of ['light', 'dark']) await section(scheme, async () => {
      const t = await open({ viewport: { width: 1280, height: 820 }, colorScheme: scheme });
      const { page: p, q } = t;
      const pl = await q(placeQ);
      placed(scheme, pl);
      check(`${scheme}: it is named and says what it takes`, pl && pl.label === 'Attach images' && /^Attach images \(PNG, JPEG or WebP, up to 3 files, 5 MB each\)$/.test(pl.title), pl);
      const accept = await q(`const i = r.querySelector('.composer input[type=file]'); return i ? { accept: i.accept, multiple: i.multiple, hidden: !i.offsetParent, tab: i.tabIndex } : null;`);
      check(`${scheme}: a hidden file input for PNG, JPEG or WebP, several at a time, not in the Tab order`, accept && accept.accept === 'image/png,image/jpeg,image/webp'
        && accept.multiple && accept.hidden, accept);
      onRight(scheme, await q(rightQ));
      await noClip(scheme, q);
      if (scheme === 'dark') {
        await q(`r.querySelector('.composer textarea').focus(); return true;`);
        await sleep(250);
        await p.screenshot({ path: path.join(outDir, 'attach-dark.png') });
        check(`${scheme}: no page errors`, !t.errors.length, t.errors);
        await t.ctx.close();
        return;
      }


      // ----- keyboard: Tab from the mode control gets to it; Enter and Space open the picker -----
      await q(`[...r.querySelectorAll('.composer .pmode')].filter((x) => x.offsetParent).pop().focus(); return true;`);
      await p.keyboard.press('Tab');
      check('Tab from the mode control moves to Attach', await q(`return r.activeElement === r.querySelector('.composer .attach');`), await q(`return r.activeElement && r.activeElement.className;`));
      // A key on the focused Attach button: the file picker that opens, or null (with what had the focus).
      const pickWith = (key) => Promise.all([p.waitForEvent('filechooser', { timeout: 8000 }), p.keyboard.press(key)]).then(([c]) => c, async (err) => {
        if (err.name !== 'TimeoutError') throw err;
        console.log(`no file picker after ${key}; focus: ` + await q(`return r.activeElement ? r.activeElement.className : document.activeElement.tagName;`));
        return null;
      });
      let chooser = await pickWith('Enter');
      check('Enter opens the file picker, several files allowed', chooser && chooser.isMultiple(), null);
      await chooser.setFiles([png('one.png')]);
      await p.waitForFunction(`${ROOT}.querySelector('.composer .shot:not(.up)')`, null, { timeout: 5000 });
      const card = await q(`const c = r.querySelector('.composer .shot'); return c ? c.textContent : null;`);
      check('a picked PNG is added as a screenshot card', /^Screenshot40 × 30 · \d+ KB✕$/.test(card), card);
      await q(`r.querySelector('.composer .attach').focus(); return true;`);
      chooser = await pickWith('Space');
      check('Space opens it too', Boolean(chooser));
      await chooser.setFiles([{ name: 'two.jpg', mimeType: 'image/jpeg', buffer: JPEG }]);
      await p.waitForFunction(`${ROOT}.querySelectorAll('.composer .shot:not(.up)').length === 2`, null, { timeout: 5000 });
      check('a picked JPEG is added too', (await q(`return r.querySelectorAll('.composer .shot').length;`)) === 2);

      // ----- the limits: the same error line as a paste -----
      const fileInput = p.locator('edit-lens .composer input[type=file]');
      const errLine = () => q(`const e = r.querySelector('.composer .shoterr'); return e.hidden ? null : e.textContent;`);
      const paste = (files) => p.evaluate(async ([files, root]) => {
        const dt = new DataTransfer();
        for (const f of files) dt.items.add(new File([f.size ? new Uint8Array(f.size) : f.text], f.name, { type: f.type }));
        eval(root).querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
        return true;
      }, [files, ROOT]);
      await fileInput.setInputFiles([png('three.png'), png('four.png')]);
      await sleep(800);
      const picked4 = await errLine();
      check('a 4th picked file is not added, with the paste\'s error line', (await q(`return r.querySelectorAll('.composer .shot').length;`)) === 3 && picked4 === TOO_MANY, picked4);
      await paste([{ size: 10, name: 'x.png', type: 'image/png' }]);
      check('the same line as a 4th pasted file', (await errLine()) === picked4, await errLine());
      await q(`[...r.querySelectorAll('.composer .shot .sx')].forEach((b) => b.click()); return true;`);
      await fileInput.setInputFiles([{ name: 'big.png', mimeType: 'image/png', buffer: Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]) }]);
      await sleep(300);
      const bigPick = await errLine();
      check('a picked file over 5 MB is refused with the paste\'s line', bigPick === REFUSED && (await q(`return r.querySelectorAll('.composer .shot').length;`)) === 0, bigPick);
      await q(`r.querySelector('.composer .shoterr').hidden = true; return true;`);
      await paste([{ size: 5 * 1024 * 1024 + 1, name: 'big.png', type: 'image/png' }]);
      check('the same line as a pasted file over 5 MB', (await errLine()) === bigPick, await errLine());
      for (const f of [{ name: 'a.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') }, { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }]) {
        await q(`r.querySelector('.composer .shoterr').hidden = true; return true;`);
        await fileInput.setInputFiles([f]);
        await sleep(300);
        check(`a picked ${path.extname(f.name)} is refused plainly`, (await errLine()) === REFUSED && (await q(`return r.querySelectorAll('.composer .shot').length;`)) === 0, await errLine());
      }
      // The same file picked twice, one after another, is added both times.
      await fileInput.setInputFiles([png('same.png')]);
      await fileInput.setInputFiles([png('same.png')]);
      await p.waitForFunction(`${ROOT}.querySelectorAll('.composer .shot:not(.up)').length === 2`, null, { timeout: 5000 });
      check('a good file after a refused one clears the error line', (await errLine()) === null, await errLine());
      check('the focus is back in the message box after picking', await q(`return r.activeElement === r.querySelector('.composer textarea');`));
      await q(`r.querySelector('.composer textarea').focus(); return true;`);
      await p.keyboard.insertText('This looks wrong');
      await sleep(250);
      await p.screenshot({ path: path.join(outDir, 'attach-light.png') });
      await p.keyboard.press('Enter');
      await p.waitForFunction(`[...${ROOT}.querySelectorAll('.k-user .bshot img')].filter((i) => i.complete && i.naturalWidth === 40).length === 2`, null, { timeout: 5000 })
        .then(() => check('sent: the bubble shows the picked pictures', true), (err) => check('sent: the bubble shows the picked pictures', false, err.message.split('\n')[0]));
      check(`${scheme}: no page errors`, !t.errors.length, t.errors);
      await t.ctx.close();
    });

    // ----- floating panel, narrow window, phone -----
    for (const [label, opts, extra] of [['floating panel', { viewport: { width: 1280, height: 820 } }, { float: true }], ['narrow window (560 px)', { viewport: { width: 560, height: 800 } }],
      ['narrow window (480 px)', { viewport: { width: 480, height: 800 } }],
      ['phone', { ...devices['iPhone 13'] }], ['phone, dark', { ...devices['iPhone 13'], colorScheme: 'dark' }]]) await section(label, async () => {
      const t = await open(opts, extra);
      if (extra) check(`${label}: the panel floats`, await t.q(`return r.querySelector('.panel').classList.contains('float');`));
      await t.q(`r.querySelector('.composer textarea').focus(); return true;`);
      await sleep(300);
      placed(label, await t.q(placeQ));
      onRight(label, await t.q(rightQ));
      await noClip(label, t.q);
      if (label.startsWith('phone')) await t.page.screenshot({ path: path.join(outDir, `attach-${label === 'phone' ? 'phone' : 'phone-dark'}-empty.png`) });
      await t.page.keyboard.insertText('One\nTwo\nThree\nFour\nFive');
      await sleep(300);
      onRight(`${label}, with "5 lines"`, await t.q(rightQ));
      await noClip(`${label}, with "5 lines"`, t.q);
      await t.page.locator('edit-lens .composer input[type=file]').setInputFiles([png('p.png')]);
      await t.page.waitForFunction(`${ROOT}.querySelector('.composer .shot:not(.up)')`, null, { timeout: 5000 })
        .then(() => check(`${label}: a picked file is added`, true), (err) => check(`${label}: a picked file is added`, false, err.message.split('\n')[0]));
      if (label.startsWith('phone')) await t.page.screenshot({ path: path.join(outDir, `attach-${label === 'phone' ? 'phone' : 'phone-dark'}.png`) });
      check(`${label}: no page errors`, !t.errors.length, t.errors);
      await t.ctx.close();
    });

    // ----- a page that can't message Claude: off, with the reason -----
    await section('no project', async () => {
      const t = await open({ viewport: { width: 1280, height: 820 } }, { noRoot: true });
      await t.page.waitForFunction(`${ROOT}.querySelector('.composer textarea').disabled`, null, { timeout: 5000 });
      const a = await t.q(`const a = r.querySelector('.composer .attach'); return a ? { disabled: a.disabled, title: a.title } : null;`);
      check('a page that can\'t message Claude: Attach is off and says why', a && a.disabled && a.title === 'Images can\'t be attached: this page can\'t message Claude.', a);
      check('no project: no page errors', !t.errors.length, t.errors);
      await t.ctx.close();
    });
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
