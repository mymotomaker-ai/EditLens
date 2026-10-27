'use strict';
require('./isolate');
// Panel colors = Auto follows the site's theme, on a real page and server, without Claude: a dark
// site on a light computer gets the dark panel and the reverse; class="dark" (or data-bs-theme)
// changes at runtime are followed; a page that says nothing follows the computer; Light and Dark in
// Settings win over the site; the popped-out code window's background follows the theme.
// usage: NODE_PATH=$(npm root -g) node test/theme-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: theme-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-theme-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5221' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const DARK_BG = '#242426';
const LIGHT_BG = '#fbfbfa';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = `<script src="http://127.0.0.1:5221/live.js" data-root="${proj}" data-panel="open"></script>`;
const PAGES = {
  // Dark the way most sites do it: a class and attribute on <html>, a dark body.
  '/dark': `<!doctype html><html class="dark" data-theme="dark"><title>Dark</title><body style="background:#111;color:#eee;margin:40px"><h1>Dark site</h1>${tag}</body></html>`,
  '/light': `<!doctype html><html data-theme="light"><title>Light</title><body style="background:#fff;color:#111;margin:40px"><h1>Light site</h1>${tag}</body></html>`,
  // Says nothing: no marker, no color-scheme, no background.
  '/plain': `<!doctype html><title>Plain</title><body style="margin:40px"><h1>Plain</h1>${tag}</body>`,
  // Switches by a class on <html>, which also changes its colors.
  '/toggle': `<!doctype html><title>Toggle</title><style>html.dark body{background:#0d1117;color:#eee}</style><body style="margin:40px"><h1>Toggle</h1>${tag}</body>`,
  '/meta': `<!doctype html><meta name="color-scheme" content="dark"><title>Meta</title><body style="margin:40px"><h1>Meta</h1>${tag}</body>`,
  '/bgonly': `<!doctype html><title>Bg</title><body style="background:rgb(20,24,30);margin:40px"><h1>Background only</h1>${tag}</body>`,
};

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), settings: { theme: 'Auto' } });
  const site = http.createServer((req, res) => {
    res.writeHead(PAGES[req.url] ? 200 : 404, { 'content-type': 'text/html' });
    res.end(PAGES[req.url] || 'not found');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const errors = [];
  async function open(url, scheme) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, colorScheme: scheme });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(base + url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(300);
    return { ctx, page };
  }
  // The panel's background token, as the panel, confirm boxes and toasts use it.
  const bg = (page) => page.evaluate(`getComputedStyle(${ROOT}.querySelector('.panel')).getPropertyValue('--bg').trim()`);
  const waitBg = (page, want) => page.waitForFunction(`getComputedStyle(${ROOT}.querySelector('.panel')).getPropertyValue('--bg').trim() === '${want}'`, null, { timeout: 3000 }).then(() => true, onTimeout(false));
  const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
  try {
    await section('dark site, light computer', async () => {
      const { ctx, page } = await open('/dark', 'light');
      check('dark site on a light computer: dark panel', (await bg(page)) === DARK_BG, await bg(page));
      await page.screenshot({ path: path.join(outDir, 'theme-dark-site-light-os.png') });
      await ctx.close();
    });
    await section('light site, dark computer', async () => {
      const { ctx, page } = await open('/light', 'dark');
      check('light site on a dark computer: light panel', (await bg(page)) === LIGHT_BG, await bg(page));
      // A toast follows too.
      await page.evaluate(`${ROOT}.querySelector('.toast') && ${ROOT}.querySelector('.toast').classList.add('on')`);
      check('the toast uses the light colors', await page.evaluate(`(() => { const t = ${ROOT}.querySelector('.toast'); return !t || getComputedStyle(t).getPropertyValue('--bg').trim() === '${LIGHT_BG}'; })()`));
      await ctx.close();
    });
    await section('meta color-scheme and background only', async () => {
      let { ctx, page } = await open('/meta', 'light');
      check('<meta name="color-scheme" content="dark">: dark panel', (await bg(page)) === DARK_BG, await bg(page));
      await ctx.close();
      ({ ctx, page } = await open('/bgonly', 'light'));
      check('a dark body background alone: dark panel', (await bg(page)) === DARK_BG, await bg(page));
      await ctx.close();
    });
    await section('site that toggles class="dark"', async () => {
      const { ctx, page } = await open('/toggle', 'light');
      check('before the toggle: light', (await bg(page)) === LIGHT_BG, await bg(page));
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      check('html.classList.add("dark") at runtime: dark', await waitBg(page, DARK_BG), await bg(page));
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
      check('class removed again: light', await waitBg(page, LIGHT_BG), await bg(page));
      await page.evaluate(() => document.body.setAttribute('data-bs-theme', 'dark'));
      check('data-bs-theme="dark" on body at runtime: dark', await waitBg(page, DARK_BG), await bg(page));
      await ctx.close();
    });
    await section('page that says nothing', async () => {
      const { ctx, page } = await open('/plain', 'dark');
      check('silent page, dark computer: dark', (await bg(page)) === DARK_BG, await bg(page));
      await page.emulateMedia({ colorScheme: 'light' });
      check('computer switches to light: light', await waitBg(page, LIGHT_BG), await bg(page));
      // EditLens's own element (which has data-theme) is not read as the page's theme.
      check('host says light, not its own earlier value', (await page.evaluate(() => document.querySelector('edit-lens').getAttribute('data-theme'))) === 'light');
      await ctx.close();
    });
    await section('Light and Dark settings win', async () => {
      const { ctx, page } = await open('/dark', 'light');
      const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
      await q(`[...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More').click(); return true;`);
      await q(`[...r.querySelectorAll('.lwrap button')].find((b) => /All settings/.test(b.textContent)).click(); return true;`);
      await page.waitForFunction(`[...${ROOT}.querySelectorAll('.srow')].some((x) => /Panel colors/.test(x.textContent))`, null, { timeout: 5000 });
      const pick = (o) => q(`const row = [...r.querySelectorAll('.srow')].find((x) => /Panel colors/.test(x.textContent)); [...row.querySelectorAll('button')].find((b) => b.textContent === '${o}').click(); return true;`);
      await pick('Light');
      check('Light on a dark site: light', await waitBg(page, LIGHT_BG), await bg(page));
      await page.evaluate(() => document.documentElement.classList.add('dark', 'x'));
      await sleep(300);
      check('Light stays while the site changes its classes', (await bg(page)) === LIGHT_BG, await bg(page));
      await pick('Auto');
      check('Auto again: the site\'s dark', await waitBg(page, DARK_BG), await bg(page));
      await page.evaluate(() => { document.documentElement.className = 'light'; document.documentElement.setAttribute('data-theme', 'light'); document.body.style.background = '#fff'; });
      check('Auto: site switches to light', await waitBg(page, LIGHT_BG), await bg(page));
      await pick('Dark');
      check('Dark on a light site: dark', await waitBg(page, DARK_BG), await bg(page));
      await pick('Auto');
      await ctx.close();
    });
    await section('popped-out code window', async () => {
      const { ctx, page } = await open('/toggle', 'light');
      const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
      const file = path.join(proj, 'src', 'app.js');
      fs.writeFileSync(file, 'const a = 2;\n');
      await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file, relFile: 'src/app.js', tool: 'Edit', kind: 'frontend',
        before: 'const a = 1;\n', after: 'const a = 2;\n', hunks: [{ oldStart: 1, newStart: 1, lines: ['-const a = 1;', '+const a = 2;'] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
      await page.waitForFunction(`${ROOT}.querySelector('.k-edit')`, null, { timeout: 8000 });
      await q(`const c = r.querySelector('.k-edit'); c.click(); return true;`);
      await page.waitForFunction(`${ROOT}.querySelector('.dock.on .dhead')`, null, { timeout: 8000 });
      // The code view's View menu › In its own window.
      await q(`r.querySelector('.dhead button[aria-label="View"]').click(); return true;`);
      const [win] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 5000 }),
        q(`r.querySelector('.lmenu [data-act=popout]').click(); return true;`),
      ]);
      await sleep(500);
      const winBg = () => win.evaluate(() => [getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).backgroundColor, document.querySelector('edit-lens').getAttribute('data-theme')]);
      let b = await winBg();
      check('popped-out window, light theme: light background, not dark', b[0] === 'rgb(251, 251, 250)' && b[1] === 'rgb(251, 251, 250)' && b[2] === 'light', b);
      await page.evaluate(() => document.documentElement.classList.add('dark'));
      await sleep(400);
      b = await winBg();
      check('site turns dark: the popped-out window follows', b[0] === 'rgb(36, 36, 38)' && b[2] === 'dark', b);
      await win.screenshot({ path: path.join(outDir, 'theme-popped-dark.png') });
      await win.close();
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
