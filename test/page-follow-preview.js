#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4992';
// Following an agent moves the page, without Claude, on examples/vite-router (/, /reports with tabs
// Summary | Customers marked role="tab", and /settings, not linked): pages found from the routes, a
// component learned from a tab click, scrolling to the lines read, stylesheets outlined in place,
// Main, "Page follows" paused, Show on another page, and buttons that do something never pressed again.
// It changes no files: the edits it sends are made up.
//   NODE_PATH=$(npm root -g) node test/page-follow-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'page-follow-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: page-follow-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `pagefollow-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const file = (rel) => path.join(siteDir, rel);
const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: siteDir, ts: Date.now(), backlog: false, ...ev });
const read = (rel, line, end) => chat({ role: 'agent-step', agentId: 'agA', toolUseId: 'tuA', agentType: 'general-purpose', kind: 'tool', tool: 'Read', summary: rel, file: file(rel), line, end, op: 'read' });
async function edit(rel, from, to, agentId, sessionId) {
  const before = fs.readFileSync(file(rel), 'utf8');
  const lines = before.split('\n');
  const n = lines.findIndex((l) => l.includes(from)) + 1;
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: sessionId || SESSION, cwd: siteDir, file: file(rel), relFile: rel, ts: Date.now(),
    agentId: agentId || null, agentType: agentId ? 'general-purpose' : null, before, after: before.replace(from, to), stats: { added: 1, removed: 1 }, hints: {},
    hunks: [{ oldStart: n, newStart: n, lines: ['-' + lines[n - 1], '+' + lines[n - 1].replace(from, to)] }],
  });
}

(async () => {
  await stopServer(); // this server version has /pages
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 820 } })).newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const where = () => page.evaluate('location.pathname');
  const outlined = () => q(`return [...r.querySelectorAll('.box.sel')].map((b) => ({ tag: (b.querySelector('.tag') || {}).textContent || '', color: b.style.getPropertyValue('--c'), fol: b.classList.contains('fol') }))`);
  const note = () => q(`return r.querySelector('.fpnote').textContent`);
  const waitPath = (p, ms = 8000) => page.waitForFunction(`location.pathname === ${JSON.stringify(p)}`, null, { timeout: ms }).then(() => true, onTimeout(false));
  const waitOutline = (ms = 6000) => page.waitForFunction(`${ROOT}.querySelectorAll('.box.sel').length > 0`, null, { timeout: ms }).then(() => true, onTimeout(false));

  await chat({ role: 'agent-start', toolUseId: 'tuA', description: 'Polish the settings', agentType: 'general-purpose', prompt: '' });
  await page.waitForTimeout(600);
  await q(`[...r.querySelectorAll('.fchip')].find((b) => b.textContent === 'Polish the settings').click(); return true;`);
  await page.waitForTimeout(300);
  check('following shows the page control', (await q(`return [...r.querySelectorAll('.fchip.page')].map((b) => b.textContent)`)).join() === 'Page follows');
  check('Page follows sits in the code view header', await q(`return Boolean(r.querySelector('.dock .dhead .dpf .fchip.page'))`));

  // 1. A page nobody opened: found from the project's routes (not linked: history API).
  await read('src/pages/Settings.jsx', 4, 4);
  check('goes to /settings, read from the routes', await waitPath('/settings'));
  check('outlines the read line in the agent color', await waitOutline(), await outlined());
  const o1 = await outlined();
  check('outline is the agent\'s, labelled', o1.length >= 1 && o1[0].fol && /Polish the settings · Settings\.jsx:4/.test(o1[0].tag) && o1[0].color !== '#0891b2', o1);
  await page.screenshot({ path: path.join(outDir, 'page-follow-1-route.png') });

  // 2. Learned from a click: open Reports, click the Customers tab, return to Overview.
  await page.click('nav a:has-text("Reports")');
  await page.waitForTimeout(500);
  await page.click('button:has-text("Customers")');
  await page.waitForTimeout(1200);
  await page.click('nav a:has-text("Overview")');
  await page.waitForTimeout(1200);
  const learned = await page.evaluate(`JSON.parse(localStorage.getItem('editlens.pageMap') || '{}')['src/pages/Customers.jsx']`);
  check('learned: Customers shows on /reports after clicking Customers', learned && learned.route === '/reports' && learned.via && learned.via.text === 'Customers', learned);
  const t0 = Date.now();
  await edit('src/pages/Customers.jsx', '<td>Acme</td>', '<td>Acme Corp</td>', 'agA');
  await page.waitForTimeout(1000);
  check('waits while you use the page', (await where()) === '/' && /Waiting until you stop scrolling or typing/.test(await note()), { path: await where(), note: await note() });
  check('then goes to /reports', await waitPath('/reports', 9000), Date.now() - t0);
  check('clicks Customers and outlines the table', await page.waitForFunction(`document.querySelector('table.customers') && ${ROOT}.querySelector('.box.sel .tag') && ${ROOT}.querySelector('.box.sel .tag').textContent.includes('Customers.jsx')`, null, { timeout: 6000 }).then(() => true, onTimeout(false)), await outlined());
  await page.screenshot({ path: path.join(outDir, 'page-follow-2-tab.png') });

  // 3. Scrolls to the lines read.
  await read('src/pages/Overview.jsx', 8, 11);
  check('goes to / and scrolls to the section read', await waitPath('/'));
  await page.waitForTimeout(1500);
  const inView = await page.evaluate(`(() => { const b = document.querySelector('.footer-card').getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; })()`);
  check('the section is on screen', inView, await page.evaluate('scrollY'));
  await page.screenshot({ path: path.join(outDir, 'page-follow-3-scroll.png') });

  // 4. A file no page shows.
  await read('src/pages/Orphan.jsx', 1, 3);
  await page.waitForTimeout(2500);
  check('says plainly when no page is known', /Orphan\.jsx isn't on this page\. Open the page that shows it once/.test(await note()), await note());

  // 5. Paused: the page stays.
  await q(`r.querySelector('.fchip.page').click(); return true;`);
  check('pause button', (await q(`return r.querySelector('.fchip.page').textContent`)) === 'Page paused');
  await read('src/pages/Settings.jsx', 3, 6);
  await page.waitForTimeout(2500);
  check('paused: the page stays', (await where()) === '/');
  await q(`r.querySelector('.fchip.page').click(); return true;`);
  check('resuming goes to the latest file', await waitPath('/settings'));
  check('and outlines it', await page.waitForFunction(`[...${ROOT}.querySelectorAll('.box.sel .tag')].some((t) => t.textContent.endsWith('Settings.jsx:3–6'))`, null, { timeout: 5000 }).then(() => true, onTimeout(false)), await outlined());
  await page.screenshot({ path: path.join(outDir, 'page-follow-4-controls.png') });

  // 6. Show on an edit that is on another page: "Go to page".
  await q(`[...r.querySelectorAll('.fchip')].find((b) => b.textContent === 'All agents').click(); return true;`);
  await page.click('nav a:has-text("Overview")');
  await page.waitForTimeout(600);
  await edit('src/pages/Settings.jsx', 'Dark theme', 'Dark mode', null);
  await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-edit')].length >= 2`);
  await page.waitForTimeout(4500);
  await q(`const c = [...r.querySelectorAll('.k-edit')].pop(); c.click(); return true;`);
  await page.waitForTimeout(500);
  check('still on the page you chose', (await where()) === '/');
  const bar = await q(`return { show: r.querySelector('.selbar .mini').textContent, title: r.querySelector('.selbar .mini').title }`);
  check('Show reads "Go to page" for code on another page', bar.show === 'Go to page' && /\/settings/.test(bar.title), bar);
  await q(`r.querySelector('.selbar .mini').click(); return true;`);
  check('Go to page opens /settings', await waitPath('/settings'));
  check('and outlines it in the selection color', await waitOutline(), await outlined());
  await page.screenshot({ path: path.join(outDir, 'page-follow-5-show.png') });

  // 7. A global stylesheet: the page stays and the elements its changed rules style are outlined.
  await q(`[...r.querySelectorAll('.fchip')].find((b) => b.textContent === 'Main').click(); return true;`);
  await page.waitForTimeout(600);
  await edit('src/app.css', 'gap:12px', 'gap:16px', null);
  await page.waitForTimeout(3500);
  check('app.css: the page stays where it is', (await where()) === '/settings', await where());
  check('app.css: the nav its rule styles is outlined', await page.waitForFunction(`[...${ROOT}.querySelectorAll('.box.sel .tag')].some((t) => t.textContent.includes('app.css'))`, null, { timeout: 6000 }).then(() => true, onTimeout(false)), await outlined());
  check('never "can\'t tell" for a stylesheet', !/Can't tell/.test(await note()), await note());
  await page.screenshot({ path: path.join(outDir, 'page-follow-6-css.png') });
  await q(`r.querySelector('.selbar .x, .selbar [aria-label="Clear"]') && r.querySelector('.selbar .x, .selbar [aria-label="Clear"]').click(); return true;`);
  // A rule nothing on this page uses: a quiet note, the page stays.
  const css = fs.readFileSync(file('src/app.css'), 'utf8');
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file: file('src/app.css'), relFile: 'src/app.css', ts: Date.now(),
    before: css, after: css + '.toast{color:red}\n', stats: { added: 1, removed: 0 }, hints: {},
    hunks: [{ oldStart: 4, newStart: 4, lines: ['+.toast{color:red}'] }],
  });
  await page.waitForTimeout(3500);
  check('unused rule: says nothing here uses it', /This CSS change in app\.css doesn't affect anything on this page \(it changes \.toast\)/.test(await note()), await note());
  check('unused rule: the page stays', (await where()) === '/settings');
  // Clicking Main again: back to what Main did last.
  await q(`[...r.querySelectorAll('.fchip')].find((b) => b.textContent === 'All agents').click(); return true;`);
  await q(`[...r.querySelectorAll('.fchip')].find((b) => b.textContent === 'Main').click(); return true;`);
  await page.waitForTimeout(2500);
  const mainNote = await note();
  const toastText = await q(`return (r.querySelector('.toast.on') || {}).textContent || ''`);
  check('clicking Main: no "can\'t tell"', !/Can't tell/.test(mainNote + toastText), { mainNote, toastText });

  // 8. The code view, closed, opens again with the next request.
  await q(`const b = r.querySelector('.dock [title^="Close the code view"]') || [...r.querySelectorAll('button')].find((x) => /^Close the code view/.test(x.title)); b.click(); return true;`);
  await page.waitForTimeout(300);
  check('code view closed', !(await q(`return r.querySelector('.dock') && r.querySelector('.dock').classList.contains('open')`)) || (await page.evaluate("localStorage.getItem('editlens.dock')")) === 'closed', await page.evaluate("localStorage.getItem('editlens.dock')"));
  await edit('src/pages/Settings.jsx', 'Dark theme', 'Dark look', null);
  await page.waitForTimeout(1200);
  check('closed: an edit in the same request leaves it closed', (await page.evaluate("sessionStorage.getItem('editlens.dockOpen')")) !== '1');
  await postEvent({ type: 'prompt', sessionId: SESSION, cwd: siteDir, ts: Date.now(), text: 'edit the customers page' });
  await page.waitForTimeout(300);
  check('a new request forgets the close', (await page.evaluate("localStorage.getItem('editlens.dock')")) === null);
  await edit('src/pages/Customers.jsx', '<td>Acme</td>', '<td>Acme Inc</td>', null);
  check('the next edit opens the code view', await page.waitForFunction("sessionStorage.getItem('editlens.dockOpen') === '1'", null, { timeout: 5000 }).then(() => true, onTimeout(false)));

  // 9. Edits from a second session say which session made them.
  await edit('src/pages/Settings.jsx', 'Dark theme', 'Night theme', null, 'second-session-abcd');
  await page.waitForTimeout(800);
  const tags = await q(`return [...r.querySelectorAll('.k-edit .sess.on')].map((t) => t.textContent)`);
  check('edits are labelled by session', tags.length >= 2 && tags.includes('From Session seco') && tags.includes('From Session ' + SESSION.slice(0, 4)), tags);
  await page.screenshot({ path: path.join(outDir, 'page-follow-7-sessions.png') });

  // 10. Follow never learns (so never presses again) a button that does something.
  await page.evaluate(() => {
    const bar = document.createElement('div');
    bar.innerHTML = '<button type="button" id="del">Delete</button><button type="button">Keep</button>';
    bar.querySelector('#del').addEventListener('click', () => {
      const p = document.createElement('p');
      p.setAttribute('data-editlens-src', 'src/pages/Danger.jsx:3:1');
      p.textContent = 'Deleted';
      document.body.appendChild(p);
      history.pushState(null, '', location.pathname); // the page learns on route changes
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    document.body.appendChild(bar);
  });
  await page.click('#del');
  await page.waitForTimeout(1500);
  const danger = await page.evaluate(`JSON.parse(localStorage.getItem('editlens.pageMap') || '{}')['src/pages/Danger.jsx'] || null`);
  check('a Delete button is never learned as the way to a file', !danger || !danger.via, danger);
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
