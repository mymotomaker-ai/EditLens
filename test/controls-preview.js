'use strict';
require('./isolate');
// Controls with edge cases, on a real page and server, without Claude: Follow never learns a link
// that works in a click handler; a message waiting when EditLens restarts can be sent again; Cancel
// clicked twice sends one request; settings without the mod; edits in two places, with no stored
// code, or an emptied file; Replay with EditLens down shows a message.
// usage: NODE_PATH=$(npm root -g) node test/controls-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: controls-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-controls-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '4963' });
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

const PAGE = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:40px">
<h1 data-editlens-src="src/App.jsx:1:1">App</h1>
<div role="tablist"><button role="tab" id="t1">Summary</button><button role="tab" id="t2">Customers</button></div>
<p><a href="#" id="del">Delete</a></p><div id="out"></div>
<script>
document.getElementById('del').addEventListener('click', function () {
  window.deletes = (window.deletes || 0) + 1;
  document.getElementById('out').innerHTML = '<p data-editlens-src="src/Confirm.jsx:3:1">Deleted</p>';
});
document.getElementById('t2').addEventListener('click', function () {
  document.getElementById('out').innerHTML = '<p data-editlens-src="src/Customers.jsx:2:1">Customers</p>';
});
</script>
<script src="http://127.0.0.1:4963/live.js" data-root="${proj}" data-panel="open"></script></body>`;

function change(rel, before, after, hunks, extra) {
  return postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, rel), relFile: rel, tool: 'Edit', kind: 'frontend',
    before, after, hunks, stats: { added: 1, removed: 1 }, ts: Date.now(), ...extra });
}

(async () => {
  await stopServer();
  await ensureServer();
  // Claude Code reported its settings, but no mod runs: the page can't change them there.
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), settings: { text_size: 'Medium', start: 'Connect and turn on page control' } });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    // The page's event streams, so a step can give the page an event the server sends only with pairing.
    await ctx.addInitScript(() => {
      const Real = window.EventSource;
      window.__sources = [];
      // The last settings event the server sent, to give back after a step changed them.
      const keep = (m) => { try { if (JSON.parse(m.data).type === 'settings') window.__settings = m.data; } catch (err) { if (!(err instanceof SyntaxError)) throw err; } };
      window.EventSource = function (u, o) { const s = new Real(u, o); s.addEventListener('claude', keep); window.__sources.push(s); return s; };
      window.EventSource.prototype = Real.prototype;
    });
    const errors = [];
    // A step that throws (a control missing) counts as one failure; the next steps still run.
    const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const ready = () => page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.status.idle, .status.stopped, .status')`);
    await page.goto(url);
    await ready();
    await sleep(800);

    // Follow: what it learned from clicks.
    await section('Follow', async () => {
      await page.click('#del');
      await sleep(1500);
      await page.click('#t2');
      await sleep(1500);
      const map = await page.evaluate(() => JSON.parse(localStorage.getItem('editlens.pageMap') || '{}'));
      check('Follow does not learn the Delete link', map['src/Confirm.jsx'] && !map['src/Confirm.jsx'].via, map['src/Confirm.jsx']);
      check('Follow still learns the tab', map['src/Customers.jsx'] && map['src/Customers.jsx'].via && map['src/Customers.jsx'].via.text === 'Customers', map['src/Customers.jsx']);
    });

    // Hover card › Open in code view: the file as the edit left it (its stored code), not the
    // file as it is now (here the file isn't even on disk).
    await section('Open in code view from the hover card', async () => {
      await change('src/App.jsx', 'export const t = "App";\n', 'export const t = "My app";\n', [{ oldStart: 1, newStart: 1, lines: ['-export const t = "App";', '+export const t = "My app";'] }]);
      await sleep(2500);
      await page.mouse.move(4, 700);
      const h = await page.locator('h1').boundingBox();
      await page.mouse.move(h.x + 10, h.y + h.height / 2, { steps: 3 });
      const card = await page.waitForFunction(`${ROOT}.querySelector('.peek.on')`, null, { timeout: 4000 }).then(() => true, onTimeout(false));
      check('hovering the edited heading shows the code card', card);
      const files = [];
      const onReq = (r) => { if (/\/file\?/.test(r.url())) files.push(r.url()); };
      page.on('request', onReq);
      await q(`[...r.querySelectorAll('.peek.on .pkacts button')].find((b) => b.textContent === 'Open in code view').click(); return true;`);
      const opened = await page.waitForFunction(`[...${ROOT}.querySelectorAll('.pane.on')].some((p) => /App\\.jsx$/.test(p.getAttribute('data-path')) && /My app/.test(p.textContent))`, null, { timeout: 6000 }).then(() => true, onTimeout(false));
      page.off('request', onReq);
      check('Open in code view shows the code the edit left, without reading the file now', opened && files.length === 0, files);
      await page.mouse.move(4, 700);
    });

    // Cancel clicked twice: one request, no error message.
    await section('Cancel clicked twice', async () => {
      await page.evaluate(`(() => { const t = ${ROOT}.querySelector('.composer textarea'); t.focus(); })()`);
      await page.keyboard.type('first message');
      await page.keyboard.press('Enter');
      await page.waitForFunction(`${ROOT}.querySelectorAll('.k-user .state.wait').length === 1`, null, { timeout: 5000 });
      let cancels = 0;
      page.on('request', (r) => { if (r.url().endsWith('/message/cancel')) cancels++; });
      await q(`const b = [...r.querySelectorAll('.k-user .state.wait button')].find((x) => x.textContent === 'Cancel'); b.click(); b.click(); return true;`);
      await sleep(800);
      check('Cancel clicked twice sends one request', cancels === 1, cancels);
      check('the message says it was canceled', /You canceled it/.test(await q(`return r.querySelector('.k-user .state').textContent`)));
      check('no "Could not cancel" message', !/Could not cancel/.test(await q(`const t = r.querySelector('.toast.on'); return t ? t.textContent : ''`)));
    });

    // D27 B: a message that EditLens ended says why, not "You canceled it".
    await section('A message EditLens ended', async () => {
      const posted = page.waitForResponse((r) => r.url().endsWith('/message') && r.request().method() === 'POST');
      await page.evaluate(`(() => { const t = ${ROOT}.querySelector('.composer textarea'); t.focus(); })()`);
      await page.keyboard.type('ended message');
      await page.keyboard.press('Enter');
      const id = (await (await posted).json()).id;
      await page.waitForFunction(`${ROOT}.querySelectorAll('.k-user .state.wait').length === 1`, null, { timeout: 5000 });
      const reason = 'Running Claude from paired computers is turned off on ◆ vps.';
      await page.evaluate(([i, why]) => { const s = window.__sources[window.__sources.length - 1];
        s.dispatchEvent(new MessageEvent('claude', { data: JSON.stringify({ type: 'cancelled', ids: [i], reason: why }) })); }, [id, reason]);
      await sleep(300);
      const said = await q(`return [...r.querySelectorAll('.k-user .state')].pop().textContent`);
      check('the message says why EditLens ended it', said.includes('Not sent. ' + reason) && !/You canceled it/.test(said), said);
    });

    // A message typed on a paired computer's page: labeled with that computer, not "from this page".
    await section('A message from a paired computer', async () => {
      await page.evaluate(() => { const s = window.__sources[window.__sources.length - 1];
        s.dispatchEvent(new MessageEvent('claude', { data: JSON.stringify({ type: 'page-message', id: 'aaaaaaaaaaaa', text: 'from the laptop', pageId: 'p-other', status: 'queued', computer: 'laptop' }) })); });
      await sleep(300);
      const who = await q(`return [...r.querySelectorAll('.k-user .who')].pop().textContent`);
      check('the message says which computer it came from', who === 'You · from ◆ laptop', who);
      // On a paired computer's page (via ◆ vps), a message typed on vps's own page names vps (A49-2).
      const send = (ev) => page.evaluate((e) => { const s = window.__sources[window.__sources.length - 1];
        s.dispatchEvent(new MessageEvent('claude', { data: JSON.stringify(e) })); }, ev);
      await send({ type: 'hello', via: { name: 'vps' } });
      await send({ type: 'page-message', id: 'bbbbbbbbbbbb', text: 'from the vps page', pageId: 'p-vps', status: 'queued', host: 'vps' });
      await send({ type: 'page-message', id: 'cccccccccccc', text: 'from here', pageId: 'p-here', status: 'queued', computer: 'laptop' });
      await sleep(300);
      const whos = await q(`return [...r.querySelectorAll('.k-user .who')].slice(-2).map((w) => w.textContent)`);
      check('on a paired page, the host\'s own page is named; this computer\'s is "this page"',
        whos[0] === 'You · from ◆ vps' && whos[1] === 'You · from this page', whos);
      await send({ type: 'cancelled', ids: ['bbbbbbbbbbbb', 'cccccccccccc'] });
      await send({ type: 'hello' });
      // Ended here, so the next steps start with no message waiting.
      await page.evaluate(() => { const s = window.__sources[window.__sources.length - 1];
        s.dispatchEvent(new MessageEvent('claude', { data: JSON.stringify({ type: 'cancelled', ids: ['aaaaaaaaaaaa'] }) })); });
      await sleep(300);
    });

    // A paired page while vps has "Paired computers can run Claude here" off: the hint says messages
    // from here are not sent, instead of "Claude reads this later".
    await section('A paired page with runs turned off', async () => {
      const send = (ev) => page.evaluate((e) => { const s = window.__sources[window.__sources.length - 1];
        s.dispatchEvent(new MessageEvent('claude', { data: JSON.stringify(e) })); }, ev);
      const real = await page.evaluate(() => window.__settings);
      await send({ type: 'hello', via: { name: 'vps' } });
      await send({ type: 'settings', values: { remote_tasks: false }, fields: [], from: 'claude-code', canChange: false, editable: [], via: 'vps' });
      await sleep(1200);
      const hint = await q(`return r.querySelector('.hint').textContent`);
      check('the hint says messages from here are not sent, and where to turn it on',
        /turned off on ◆ vps/.test(hint) && /not sent/.test(hint) && !/reads this/.test(hint), hint);
      await send({ type: 'hello' });
      await send(JSON.parse(real));
    });

    // A message waiting when EditLens restarts.
    await section('A message waiting when EditLens restarts', async () => {
      await page.keyboard.type('second message');
      await page.keyboard.press('Enter');
      await page.waitForFunction(`${ROOT}.querySelectorAll('.k-user .state.wait').length === 1`, null, { timeout: 5000 });
      await stopServer();
      await ensureServer();
      await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), settings: { text_size: 'Medium', start: 'Connect and turn on page control' } });
      const restarted = await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-user .state')].some((s) => /Not sent: EditLens restarted/.test(s.textContent))`, null, { timeout: 15000 }).then(() => true, onTimeout(false));
      check('after a restart the waiting message says it was not sent', restarted, await q(`return [...r.querySelectorAll('.k-user .state')].map((s) => s.textContent)`));
      await q(`const b = [...r.querySelectorAll('.k-user .state button')].find((x) => x.textContent === 'Send again'); b.click(); return true;`);
      const again = await page.waitForFunction(`${ROOT}.querySelectorAll('.k-user .state.wait').length === 1 && /Sent again below/.test(${ROOT}.textContent)`, null, { timeout: 5000 }).then(() => true, onTimeout(false));
      check('Send again sends it as a new waiting message', again, await q(`return [...r.querySelectorAll('.k-user .state')].map((s) => s.textContent)`));
      const lastBubble = await q(`const b = [...r.querySelectorAll('.k-user .bubble')]; return b[b.length - 1].textContent`);
      check('the new message has the same text', /second message/.test(lastBubble), lastBubble);
    });

    // Settings without the mod: Large stays after a reload; "What /editlens does" is read-only.
    await section('Settings without the mod', async () => {
      await q(`[...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More').click(); return true;`);
      await q(`[...r.querySelectorAll('.lwrap button')].find((b) => /All settings/.test(b.textContent)).click(); return true;`);
      await page.waitForFunction(`${ROOT}.querySelector('.srow')`, null, { timeout: 5000 });
      const startRow = await q(`const row = [...r.querySelectorAll('.srow')].find((x) => /What \\/editlens does/.test(x.textContent)); return row ? Boolean(row.querySelector('.sfixed')) : null`);
      check('"What /editlens does" is read-only without the mod', startRow === true, startRow);
      await q(`const row = [...r.querySelectorAll('.srow')].find((x) => /Panel text size/.test(x.textContent)); [...row.querySelectorAll('button')].find((b) => b.textContent === 'Large').click(); return true;`);
      await sleep(800);
      await page.reload();
      await ready();
      await sleep(1500);
      check('Large text size stays after a reload', (await page.evaluate(() => localStorage.getItem('editlens.size'))) === 'l', await page.evaluate(() => [localStorage.getItem('editlens.size'), localStorage.getItem('editlens.localSettings')]));
    });

    // One edit in two places: only those lines are marked.
    await section('One edit in two places', async () => {
      const lines = Array.from({ length: 40 }, (_, i) => `const v${i + 1} = ${i + 1};`);
      const after = lines.slice();
      after[4] = 'const v5 = 50;';
      after[37] = 'const v38 = 380;';
      await change('src/two.js', lines.join('\n') + '\n', after.join('\n') + '\n', [
        { oldStart: 5, newStart: 5, lines: [`-${lines[4]}`, `+${after[4]}`] },
        { oldStart: 38, newStart: 38, lines: [`-${lines[37]}`, `+${after[37]}`] },
      ]);
      await sleep(2500);
      // Picked from the Changes list: Show marks the edit's lines.
      await q(`const c = [...r.querySelectorAll('.k-edit, .msg')].reverse().find((x) => /two\\.js/.test(x.textContent)); c.click(); return true;`);
      await sleep(500);
      await q(`r.querySelector('.chg').click(); return true;`);
      await sleep(300);
      await q(`[...r.querySelectorAll('.chlist .chi')].find((x) => /two\\.js/.test(x.textContent)).click(); return true;`);
      const marked = await page.waitForFunction(`(() => { const p = ${ROOT}.querySelector('.pane.on'); return p && /two\\.js$/.test(p.getAttribute('data-path')) && p.querySelectorAll('.cl.lmark').length > 0 && !${ROOT}.querySelector('.tab.busy'); })()`, null, { timeout: 10000 }).then(() => true, onTimeout(false));
      const markedRows = await q(`return [...r.querySelectorAll('.pane.on .cl')].map((x, i) => x.classList.contains('lmark') ? i + 1 : 0).filter(Boolean)`);
      check('one edit in two places marks lines 5 and 38 only', marked && JSON.stringify(markedRows) === '[5,38]', markedRows);
    });

    // An edit with no stored code (binary): still listed in Changes.
    await section('An edit with no stored code (binary)', async () => {
      await change('src/logo.png', undefined, undefined, [], { stats: { added: 0, removed: 0 }, binary: true });
      // An emptied file.
      await change('src/Old.jsx', 'export default 1;\n', '', [{ oldStart: 1, newStart: 0, lines: ['-export default 1;'] }], { tool: 'Write' });
      await sleep(2500);
      if (!(await q(`return r.querySelector('.chlist.on')`))) await q(`r.querySelector('.chg').click(); return true;`);
      await sleep(300);
      const list = await q(`return [...r.querySelectorAll('.chlist .chi .f')].map((x) => x.textContent.replace(/\\u200e/g, ''))`);
      check('Changes lists the edit with no stored code', list.some((t) => /logo\.png/.test(t)), list);
      check('the emptied file has no ":0"', list.some((t) => /Old\.jsx$/.test(t)), list);
      const head = await q(`return r.querySelector('.chlist .chh').textContent`);
      // 3 edits here, plus the App.jsx edit from before the restart (listed again: it has an earlier copy).
      check('Changes counts every edit', /4 this session/.test(head), head);
      const diffHead = await q(`const c = [...r.querySelectorAll('.diff')].find((d) => /export default 1/.test(d.textContent)); return c ? c.querySelector('.ln.h').textContent : ''`);
      check('the emptied file\'s diff says start of file', /start of file/.test(diffHead), diffHead);
      await q(`[...r.querySelectorAll('.chlist .chi')].find((x) => /Old\\.jsx/.test(x.textContent)).click(); return true;`);
      const empty = await page.waitForFunction(`[...${ROOT}.querySelectorAll('.pane.on')].some((p) => /Old\\.jsx$/.test(p.getAttribute('data-path')) && /This file is now empty/.test(p.textContent))`, null, { timeout: 8000 }).then(() => true, onTimeout(false));
      check('the code view says the file is now empty', empty, await q(`return [...r.querySelectorAll('.pane')].map((p) => p.className + ' ' + p.textContent.slice(0, 120))`));
    });

    // Alt+Shift+H while typing in the panel's message box.
    await section("Alt+Shift+H while typing in the panel's message box", async () => {
      const hlBefore = await page.evaluate(() => localStorage.getItem('editlens.highlight'));
      await page.evaluate(`${ROOT}.querySelector('.composer textarea').focus()`);
      await page.keyboard.press('Alt+Shift+KeyH');
      await sleep(300);
      const hlAfter = await page.evaluate(() => localStorage.getItem('editlens.highlight'));
      check('Alt+Shift+H works while typing in the message box', hlBefore !== hlAfter, [hlBefore, hlAfter]);
      await page.keyboard.press('Alt+Shift+KeyH');
      await sleep(300);
      const panelState = () => q(`return r.querySelector('.pill').classList.contains('on')`);
      const openBefore = await panelState();
      await page.evaluate(`${ROOT}.querySelector('.composer textarea').focus()`);
      await page.keyboard.press('Alt+Shift+KeyC');
      await sleep(400);
      check('Alt+Shift+C works while typing in the message box', (await panelState()) !== openBefore, [openBefore]);
      await page.keyboard.press('Alt+Shift+KeyC');
      await sleep(400);
    });

    // Full screen panel: the More menu and messages are drawn inside it.
    await section('Full screen panel', async () => {
      const menuSeen = () => q(`const m = r.querySelector('.lwrap .lmenu'); if (!m) return 'no menu'; const b = m.getBoundingClientRect(); const hit = r.elementFromPoint(b.left + b.width / 2, b.top + 20); return Boolean(hit && m.contains(hit)) || 'hidden';`);
      await page.click('edit-lens >> [aria-label="More"]');
      await sleep(200);
      await q(`[...r.querySelectorAll('.lwrap .acts button')].find((b) => /Full screen/.test(b.textContent)).click(); return true;`);
      await sleep(800);
      const full = await q(`return r.fullscreenElement === r.querySelector('.panel') || r.querySelector('.panel').classList.contains('max')`);
      check('the panel is in full screen', full);
      await page.click('edit-lens >> [aria-label="More"]');
      await sleep(300);
      check('in full screen the More menu can be seen', (await menuSeen()) === true, await menuSeen());
      await page.keyboard.press('Escape');
      await sleep(200);
      await page.evaluate(`${ROOT}.querySelector('.composer textarea').blur()`);
      await page.keyboard.press('Alt+Shift+KeyH');
      await sleep(600);
      const toastSeen = await q(`const t = r.querySelector('.toast.on'); if (!t) return 'no toast'; const b = t.getBoundingClientRect(); const hit = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return Boolean(hit && t.contains(hit)) || 'hidden';`);
      check('in full screen a message (toast) can be seen', toastSeen === true, toastSeen);
      await page.keyboard.press('Alt+Shift+KeyH');
      await sleep(300);
      await page.click('edit-lens >> [aria-label="More"]');
      await sleep(300);
      await q(`[...r.querySelectorAll('.lwrap .acts button')].find((b) => /Exit full screen/.test(b.textContent)).click(); return true;`);
      await sleep(800);
      check('Exit full screen from the menu works', !(await q(`return r.fullscreenElement || r.querySelector('.panel').classList.contains('max')`)));
    }).finally(() => q(`r.querySelectorAll('.lwrap').forEach((n) => n.remove()); if (document.fullscreenElement) document.exitFullscreen(); return true;`).then(() => sleep(500)));
    await section('Full screen cleanup', async () => {
    });

    // Code view position menu: Reset in full screen leaves full screen; a new floating window
    // keeps clear of the panel, so its resize grip can be used.
    await section('Code view position menu', async () => {
      // Full screen and the positions are in the code view's View menu.
      await q(`r.querySelector('.dock .dhead button[aria-label="View"]').click(); return true;`);
      await sleep(300);
      await q(`r.querySelector('.lwrap .vmenu [data-act=full]').click(); return true;`);
      await sleep(800);
      check('the code view is in full screen', await q(`return r.fullscreenElement === r.querySelector('.dock') || r.querySelector('.dock').classList.contains('max')`));
      await q(`r.querySelector('.dock .dhead button[aria-label="View"]').click(); return true;`);
      await sleep(300);
      await q(`[...r.querySelectorAll('.lwrap .vmenu button')].find((b) => /Reset/.test(b.textContent)).click(); return true;`);
      await sleep(800);
      check('Reset leaves full screen', !(await q(`return r.fullscreenElement || r.querySelector('.dock').classList.contains('max')`)));
      await q(`r.querySelector('.dock .dhead button[aria-label="View"]').click(); return true;`);
      await sleep(300);
      await q(`[...r.querySelectorAll('.lwrap button')].find((b) => /Floating window/.test(b.textContent + (b.title || '') + (b.getAttribute('aria-label') || ''))).click(); return true;`);
      await sleep(600);
      const rects = await q(`const a = r.querySelector('.dock').getBoundingClientRect(); const b = r.querySelector('.panel').getBoundingClientRect(); return [a.left, a.top, a.right, a.bottom, b.left, b.top, b.right, b.bottom].map(Math.round)`);
      const [al, at, ar, ab, bl, bt, br, bb] = rects;
      check('a new floating code view does not overlap the panel', ar <= bl || al >= br || ab <= bt || at >= bb, rects);
    }).finally(() => q(`r.querySelectorAll('.lwrap').forEach((n) => n.remove()); if (document.fullscreenElement) document.exitFullscreen(); localStorage.removeItem('editlens.layout'); return true;`).then(() => sleep(500)));

    // A phone-sized window: the corner picker says the panel is at the bottom, and Claude's edit
    // doesn't open the code view under the open panel.
    await section('Phone-sized window', async () => {
      const phone = await (await browser.newContext({ viewport: { width: 360, height: 740 } })).newPage();
      // Skip the tour; localStorage can throw in private mode.
      await phone.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
      phone.on('pageerror', (e) => errors.push(e.message));
      const pq = (src) => phone.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
      await phone.goto(url);
      await phone.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
      await sleep(1200);
      await pq(`[...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More').click(); return true;`);
      await sleep(300);
      const menu = await pq(`const m = r.querySelector('.lwrap'); return m ? m.textContent : ''`);
      check('narrow window: the menu says the panel is at the bottom', /In a narrow window the panel is at the bottom/.test(menu) && !/Top left/.test(menu), menu.slice(0, 300));
      await pq(`r.querySelectorAll('.lwrap').forEach((n) => n.remove()); return true;`);
      await change('src/phone.js', 'const p = 1;\n', 'const p = 2;\n', [{ oldStart: 1, newStart: 1, lines: ['-const p = 1;', '+const p = 2;'] }]);
      await sleep(2000);
      check('narrow window: Claude\'s edit does not open the code view under the panel', !(await pq(`return r.querySelector('.dock').classList.contains('on')`)));
      await phone.close();
    });

    // Replay with EditLens stopped: a message, not silence.
    await section('Replay with EditLens stopped', async () => {
      // The code view was closed first, so this edit's code was never loaded and Replay must ask for it.
      await q(`r.querySelector('.dock button.xred').click(); return true;`);
      await sleep(300);
      await change('src/fresh.js', 'const a = 1;\n', 'const a = 2;\n', [{ oldStart: 1, newStart: 1, lines: ['-const a = 1;', '+const a = 2;'] }]);
      await sleep(1500);
      await stopServer();
      await sleep(500);
      await q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => /fresh\.js/.test(x.textContent)); [...c.querySelectorAll('.mini.play')][0].click(); return true;`);
      const down = await page.waitForFunction(`/isn't running/.test((${ROOT}.querySelector('.toast.on') || {}).textContent || '')`, null, { timeout: 8000 }).then(() => true, onTimeout(false));
      check('Replay with EditLens down says EditLens is not running', down, await q(`const t = r.querySelector('.toast'); return t ? t.textContent : ''`));
    });

    await page.screenshot({ path: path.join(outDir, 'controls-end.png') });
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
