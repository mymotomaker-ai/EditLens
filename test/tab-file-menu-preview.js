'use strict';
require('./isolate');
// Small features on a real page and server, without Claude: the browser tab's title ("● Done ·
// <title>", "(N) Needs your answer · <title>") only while the tab is not looked at, put back after;
// Wrap lines on by default and remembered; the file menu (Open in VS Code or Cursor at the edit's
// line, Copy path, Copy code, the Editor setting, paired-computer files, never "NaN").
// usage: NODE_PATH=$(npm root -g) node test/tab-file-menu-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: tab-file-menu-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-qolb-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5215' });
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

// window.__away: the test says whether the tab is looked at (hidden, or another window in front).
const PAGE = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:40px">
<h1 data-editlens-src="src/App.jsx:1:1">App</h1>
<script>
window.__away = false;
Object.defineProperty(document, 'visibilityState', { configurable: true, get: function () { return window.__away ? 'hidden' : 'visible'; } });
document.hasFocus = function () { return !window.__away; };
window.setAway = function (on) { window.__away = on; document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event(on ? 'blur' : 'focus')); };
</script>
<script src="http://127.0.0.1:5215/live.js" data-root="${proj}" data-panel="open"></script></body>`;

const LONG = 'export const cls = "' + 'flex items-center justify-between gap-4 px-6 py-3 rounded-xl '.repeat(5) + '";';
const settings = (editor) => postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), settings: { editor } });

(async () => {
  await stopServer();
  await ensureServer();
  await settings('VS Code');
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url.replace(/\/$/, '') });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const errors = [];
    const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const title = () => page.evaluate(() => document.title);
    const ready = () => page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    const clip = () => page.evaluate(() => navigator.clipboard.readText());
    await page.goto(url);
    await ready();
    await sleep(800);

    await section('Tab title', async () => {
      await postEvent({ type: 'prompt', sessionId: 's1', cwd: proj, ts: Date.now(), prompt: 'one' });
      await postEvent({ type: 'idle', sessionId: 's1', cwd: proj, ts: Date.now() });
      await sleep(600);
      check('Claude finished while the tab was looked at: the title stays', (await title()) === 'App', await title());

      await page.evaluate(() => window.setAway(true));
      await sleep(200);
      check('the tab is left with nothing new: the title stays', (await title()) === 'App', await title());
      await postEvent({ type: 'prompt', sessionId: 's1', cwd: proj, ts: Date.now(), prompt: 'two' });
      await postEvent({ type: 'ask', sessionId: 's1', cwd: proj, tool: 'Bash', input: { command: 'npm test' } });
      await postEvent({ type: 'ask', sessionId: 's1', cwd: proj, tool: 'Bash', input: { command: 'npm run build' } });
      await sleep(700);
      check('two questions wait: "(2) Needs your answer · App"', (await title()) === '(2) Needs your answer · App', await title());
      await postEvent({ type: 'ask-done', sessionId: 's1', cwd: proj, tool: 'Bash', input: { command: 'npm test' } });
      await sleep(600);
      check('one answered: "(1) Needs your answer · App"', (await title()) === '(1) Needs your answer · App', await title());
      await postEvent({ type: 'idle', sessionId: 's1', cwd: proj, ts: Date.now() });
      await sleep(700);
      check('Claude finished while away: "● Done · App"', (await title()) === '● Done · App', await title());
      // The page changes its own title (a new route): kept, with the words before it.
      await page.evaluate(() => { document.title = 'Orders · App'; });
      await sleep(300);
      check('the page\'s own title change is kept: "● Done · Orders · App"', (await title()) === '● Done · Orders · App', await title());
      await page.evaluate(() => window.setAway(false));
      await sleep(200);
      check('the tab is seen again: the page\'s own title is back', (await title()) === 'Orders · App', await title());
      await page.evaluate(() => window.setAway(true));
      await sleep(200);
      check('Done was seen: leaving the tab again does not say it again', (await title()) === 'Orders · App', await title());
      await page.evaluate(() => window.setAway(false));
      await page.evaluate(() => { document.title = 'App'; });
    });

    // An edit with a long line opens the code view.
    await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, 'src', 'App.jsx'), relFile: 'src/App.jsx', tool: 'Edit', kind: 'frontend',
      before: 'line 1\nline 2\nconst a = 1;\n', after: 'line 1\nline 2\n' + LONG + '\n', hunks: [{ oldStart: 3, newStart: 3, lines: ['-const a = 1;', '+' + LONG] }],
      stats: { added: 1, removed: 1 }, ts: Date.now() });
    await page.waitForFunction(`[...${ROOT}.querySelectorAll('.pane.on')].some((p) => /App\\.jsx$/.test(p.getAttribute('data-path')) && /rounded-xl/.test(p.textContent))`, null, { timeout: 8000 });
    await sleep(2500);

    await section('Wrap lines', async () => {
      const over = `const c = [...r.querySelectorAll('.pane.on .code')].find((x) => /rounded-xl/.test(x.textContent)); return c.scrollWidth - c.clientWidth`;
      const wrapped = `return r.querySelector('.panes').classList.contains('wrapl')`;
      check('Wrap lines is on by default: the long line wraps inside the pane', (await q(wrapped)) === true && (await q(over)) <= 1, await q(over));
      // The code view's View menu.
      const openMenu = `r.querySelector('.dock .dhead button[aria-label="View"]').click(); return true;`;
      await q(openMenu);
      await sleep(200);
      const row = `return [...r.querySelectorAll('.lwrap [role=menuitemcheckbox]')].find((b) => /Wrap long lines/.test(b.textContent))`;
      check('the View menu has Wrap long lines, on', (await q(`const b = (() => { ${row} })(); return b ? b.getAttribute('aria-checked') : null`)) === 'true');
      await q(`(() => { ${row} })().click(); return true;`);
      await sleep(300);
      check('without Wrap lines the long line goes past the right edge', (await q(over)) > 20, await q(over));
      await page.reload();
      await ready();
      await page.waitForFunction(`[...${ROOT}.querySelectorAll('.pane.on')].some((p) => /rounded-xl/.test(p.textContent))`, null, { timeout: 8000 });
      await sleep(800);
      check('Wrap lines off is remembered after a reload', (await q(wrapped)) === false && (await q(over)) > 20, await q(over));
      await q(openMenu);
      await sleep(200);
      check('the menu shows Wrap lines off', (await q(`const b = (() => { ${row} })(); return b ? b.getAttribute('aria-checked') : null`)) === 'false');
      await q(`(() => { ${row} })().click(); return true;`);
      await sleep(300);
      check('turned on again, the long line wraps', (await q(over)) <= 1, await q(over));
    });

    const menuText = () => q(`const m = r.querySelector('.lwrap .fmenu'); return m ? m.textContent : null`);
    const openHref = () => q(`const a = r.querySelector('.lwrap .fmenu a.fopen'); return a ? a.getAttribute('href') : null`);
    const closeMenus = () => q(`r.querySelectorAll('.lwrap').forEach((n) => n.remove()); return true;`);
    // The file's name in the code view's header (the focused pane's file).
    const paneButton = (re) => `[...r.querySelectorAll('.dock .dhead .crumb .fbtn')].find((b) => ${re}.test(b.getAttribute('aria-label')))`;
    const fileUrl = (scheme, rel) => scheme + '://file' + (path.join(proj, rel).split(path.sep).join('/').replace(/^(?=[A-Za-z]:)/, '/'));

    await section('File menu from the code view', async () => {
      await q(`${paneButton('/App\\.jsx/')}.click(); return true;`);
      await sleep(250);
      const text = await menuText();
      check('the file name opens the file menu', Boolean(text), text);
      check('Open in VS Code at line 3', /Open in VS Code/.test(text) && /At line 3/.test(text), text);
      check('the Open link is vscode://file/<full path>:3', (await openHref()) === fileUrl('vscode', 'src/App.jsx') + ':3', [await openHref(), fileUrl('vscode', 'src/App.jsx') + ':3']);
      check('Copy path shows src/App.jsx:3', /Copy path\s*src\/App\.jsx:3/.test(text), text);
      check('the footer names the editor and where to change it', /Editor: VS Code · change in Settings/.test(text), text);
      await q(`[...r.querySelectorAll('.lwrap .fmenu button.li')].find((b) => /Copy path/.test(b.textContent)).click(); return true;`);
      await sleep(200);
      check('Copy path copies path:line', (await clip()) === 'src/App.jsx:3', await clip());
      const copied = await q(`const b = r.querySelector('.lwrap .fmenu button.copied'); return b ? b.textContent : null`);
      check('the row says Copied with a check', /Copied/.test(copied || '') && (await q(`return Boolean(r.querySelector('.lwrap .fmenu button.copied .fic svg'))`)), copied);
      await sleep(1100);
      check('about a second later the row is back', (await q(`return !r.querySelector('.lwrap .fmenu button.copied') && /Copy path/.test(r.querySelector('.lwrap .fmenu').textContent)`)) === true);
      await q(`[...r.querySelectorAll('.lwrap .fmenu button.li')].find((b) => /Copy code/.test(b.textContent)).click(); return true;`);
      await sleep(400);
      check('Copy code copies the file\'s code', (await clip()) === 'line 1\nline 2\n' + LONG + '\n', (await clip()).slice(0, 80));
      await page.keyboard.press('Escape');
      await sleep(150);
      check('Escape closes the menu', (await menuText()) === null);
    });

    await section('File menu from an edit card', async () => {
      await q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => /App\\.jsx/.test(x.textContent)); c.querySelector('.fmore').click(); return true;`);
      await sleep(250);
      const text = await menuText();
      check('More on an edit card opens the file menu', /Open in VS Code/.test(text || '') && /At line 3/.test(text || ''), text);
      check('the edit card does not open or close from that click', (await q(`return [...r.querySelectorAll('.k-edit')].find((x) => /App\\.jsx/.test(x.textContent)).classList.contains('open')`)) === false);
      await q(`[...r.querySelectorAll('.lwrap .fmenu button.li')].find((b) => /Copy code/.test(b.textContent)).click(); return true;`);
      await sleep(500);
      check('Copy code from the edit card copies the code the edit left', (await clip()) === 'line 1\nline 2\n' + LONG + '\n', (await clip()).slice(0, 80));
      await closeMenus();
    });

    await section('Editor setting', async () => {
      await settings('Cursor');
      await sleep(600);
      await q(`${paneButton('/App\\.jsx/')}.click(); return true;`);
      await sleep(250);
      check('Editor Cursor: Open in Cursor with a cursor://file/ link', /Open in Cursor/.test(await menuText()) && (await openHref()) === fileUrl('cursor', 'src/App.jsx') + ':3', [await menuText(), await openHref()]);
      await closeMenus();
      await settings('None');
      await sleep(600);
      await q(`${paneButton('/App\\.jsx/')}.click(); return true;`);
      await sleep(250);
      const text = await menuText();
      // ("Open in a split" is the code view's own row, not an editor.)
      check('Editor None: no Open row, both Copy rows', !/Open in (VS Code|Cursor)/.test(text) && !(await q(`return Boolean(r.querySelector('.lwrap .fmenu .fopen'))`)) && (await openHref()) === null && /Copy path/.test(text) && /Copy code/.test(text), text);
      check('Editor None: the footer says None', /Editor: None · change in Settings/.test(text), text);
      // "change in Settings" opens the Settings card, which has the Editor choices.
      await q(`[...r.querySelectorAll('.lwrap .ffoot button')][0].click(); return true;`);
      await page.waitForFunction(`${ROOT}.querySelector('.srow')`, null, { timeout: 5000 });
      const row = await q(`const row = [...r.querySelectorAll('.srow')].find((x) => x.querySelector('.stitle') && x.querySelector('.stitle').textContent === 'Editor'); return row ? [...row.querySelectorAll('[role=radio]')].map((b) => b.textContent + (b.getAttribute('aria-checked') === 'true' ? '*' : '')) : null`);
      check('the Settings card has Editor: VS Code / Cursor / None', JSON.stringify(row) === JSON.stringify(['VS Code', 'Cursor', 'None*']), row);
      await q(`[...r.querySelectorAll('.srow')].find((x) => x.querySelector('.stitle') && x.querySelector('.stitle').textContent === 'Editor').querySelector('[role=radio]').click(); return true;`);
      await sleep(300);
      await q(`[...r.querySelectorAll('button.sback')][0].click(); return true;`);
      await sleep(200);
      await q(`${paneButton('/App\\.jsx/')}.click(); return true;`);
      await sleep(250);
      check('picked VS Code in the Settings card: Open in VS Code again', /Open in VS Code/.test(await menuText()), await menuText());
      await closeMenus();
    });

    await section('A file on a paired computer, and a bad line number', async () => {
      await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, 'src', 'far.js'), relFile: '◆ laptop-1: src/far.js', tool: 'Edit', kind: 'frontend',
        before: 'a\n', after: 'b\n', hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
      await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-edit')].some((x) => /far\\.js/.test(x.textContent))`, null, { timeout: 6000 });
      await sleep(300);
      await q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => /far\\.js/.test(x.textContent)); c.querySelector('.fmore').click(); return true;`);
      await sleep(250);
      const text = await menuText();
      const open = await q(`const o = r.querySelector('.lwrap .fmenu .fopen'); return o ? { tag: o.tagName, disabled: o.disabled, href: o.getAttribute('href') } : null`);
      check('a file on a paired computer: Open is greyed out', open && open.tag === 'BUTTON' && open.disabled === true && !open.href, open);
      check('it says "File is on laptop-1"', /File is on laptop-1/.test(text || ''), text);
      check('Copy path still works, without the computer name', /Copy path\s*src\/far\.js:1/.test(text || ''), text);
      await q(`[...r.querySelectorAll('.lwrap .fmenu button.li')].find((b) => /Copy path/.test(b.textContent)).click(); return true;`);
      await sleep(200);
      check('Copy path copies it', (await clip()) === 'src/far.js:1', await clip());
      await closeMenus();

      await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, 'src', 'bad.js'), relFile: 'src/bad.js', tool: 'Edit', kind: 'frontend',
        before: 'a\n', after: 'b\n', hunks: [{ oldStart: 'x', newStart: 'NaN', lines: ['-a', '+b'] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
      await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-edit')].some((x) => /bad\\.js/.test(x.textContent))`, null, { timeout: 6000 });
      await sleep(300);
      await q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => /bad\\.js/.test(x.textContent)); c.querySelector('.fmore').click(); return true;`);
      await sleep(250);
      const bad = await menuText();
      const href = await openHref();
      check('a bad line number: no "NaN" anywhere, and no line in the link', !/NaN|undefined/.test(bad || '') && href === fileUrl('vscode', 'src/bad.js') && !/At line/.test(bad || ''), [bad, href]);
      await closeMenus();
    });

    await page.screenshot({ path: path.join(outDir, 'tab-file-menu-end.png') });
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
