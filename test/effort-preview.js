#!/usr/bin/env node
'use strict';
require('./isolate');
// Effort in the browser (handoff 11.1), with the stand-in SDK and claude (test/fixtures): Manual
// shows Claude Code's level read-only; in page control the chip's menu changes Claude's level live;
// an organization limit greys out higher levels; a paired computer's task card has its own chip; a
// model without effort says so; the Effort setting; a phone-wide window; a tab given the key later.
//   NODE_PATH=$(npm root -g) node test/effort-preview.js <out-dir>   (ports 4505-4508)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning, onTimeout } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'effort-out', 'node test/effort-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const DRIVE = path.join(__dirname, '..', 'bin', 'drive.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-effort-preview-'));
const project = path.join(base, 'shop');
const laptop = path.join(base, 'laptop-app');
const fake = path.join(base, 'fake');
// Run the same inside a Claude Code session as on CI: no CLAUDE*/ANTHROPIC_* from this shell.
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
// The computer tasks run on: its organization allows up to Extra high.
const HOST = { port: 4970, pairPort: 4971, dir: path.join(base, 'host'), state: path.join(fake, 'state-host') };
// The computer that asks: its model doesn't use effort.
const REMOTE = { port: 4972, pairPort: 4973, dir: path.join(base, 'remote'), state: path.join(fake, 'state-remote') };
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}
function start(s, extra) {
  fs.mkdirSync(s.dir, { recursive: true });
  fs.mkdirSync(s.state, { recursive: true });
  fs.writeFileSync(path.join(s.state, 'signed-in'), 'yes');
  s.child = spawn(process.execPath, [SERVER], {
    env: { ...ownEnv, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_NO_BROWSER: '1',
      EDITLENS_SDK_DIR: path.join(fake, 'sdk'), EDITLENS_CLAUDE_PATH: path.join(fake, 'bin', 'claude'), FAKE_CLAUDE_STATE: s.state, ...extra },
    stdio: 'ignore',
  });
  return waitFor(() => fetch(`http://127.0.0.1:${s.port}/health`).then((r) => r.ok, notRunning(false)));
}
function stop(s) {
  return new Promise((r) => {
    if (!s.child || s.child.exitCode !== null) return r();
    s.child.once('exit', r);
    s.child.kill();
  });
}
const api = (s, method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, {
  method, headers: { 'content-type': 'application/json', 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const lines = (s, name) => {
  const f = path.join(s.state, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
// Page control on that computer, as /editlens control new does it.
function control(s, dir) {
  const out = spawnSync(process.execPath, [DRIVE, 'new'], { cwd: dir, encoding: 'utf8', timeout: 60000,
    // The stand-in SDK and claude, as the server has: without them drive.js would set up the real SDK.
    env: { ...ownEnv, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, CLAUDE_PROJECT_DIR: dir,
      EDITLENS_SDK_DIR: path.join(fake, 'sdk'), EDITLENS_CLAUDE_PATH: path.join(fake, 'bin', 'claude') } });
  if (out.status !== 0) console.log((out.stdout + out.stderr).trim());
}
function site(port, root) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Shop</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Shop</h1><p>Prices from $12</p>
<script src="http://127.0.0.1:${port}/live.js" data-root="${root}" data-panel="open"></script></body></html>`);
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  for (const dir of [project, laptop]) {
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, 'src', 'App.jsx'), 'export const App = () => <h1>Shop</h1>;\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'start');
  }
  const siteA = await site(HOST.port, project);
  const siteB = await site(REMOTE.port, laptop);
  let browser = null;
  const errors = [];
  try {
    await start(HOST, { FAKE_EFFORT_CAP: 'xhigh' });
    await start(REMOTE, { FAKE_MODEL_EFFORT: 'none' });
    browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}, [HOST.child, REMOTE.child]);
    await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'h1', cwd: project, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
    const { code } = await api(HOST, 'POST', '/pair', { cwd: project });
    const joined = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code });
    check('paired', joined.ok, joined);

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${siteA.address().port}/`);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(800);
    const q = (p, src) => p.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    // The composer chip: null while hidden.
    const chip = (p) => q(p, `const b = r.querySelector('.composer .pmode.ef'); return b && !b.classList.contains('hide') ? { text: b.textContent, l: b.querySelector('.lv').dataset.l, ro: b.classList.contains('ro'), off: b.classList.contains('off'), title: b.title, chevron: Boolean(b.querySelector('svg')), afterMode: b.previousElementSibling === r.querySelector('.composer .pmode:not(.ef)') } : null`);
    const menu = (p) => q(p, `const m = r.querySelector('.efwrap .efmenu'); if (!m) return null; return { title: m.querySelector('.lh').textContent,
      rows: [...m.querySelectorAll('button.li')].map((b) => ({ level: b.dataset.level, name: b.querySelector('.lbl').firstChild.nodeValue, note: (b.querySelector('small') || {}).textContent || '', on: b.classList.contains('on'), marks: [b, b.querySelector('.lbl')].filter((n) => getComputedStyle(n, '::after').content.includes('✓')).length, cap: b.classList.contains('cap'), opacity: getComputedStyle(b).opacity, l: b.querySelector('.lv').dataset.l })),
      foot: m.querySelector('.efoot').textContent }`);
    const pick = (p, level, where = '.composer .pmode.ef') => q(p, `r.querySelector(${JSON.stringify(where)}).click(); const b = r.querySelector('.efwrap button[data-level="${level}"]'); if (!b) return false; b.click(); return true;`);
    const toast = (p) => q(p, `const t = r.querySelector('.toast'); return t ? t.textContent : ''`);

    // ----- Manual: the terminal's own level, read only -----
    check('no chip before anything reports a level', (await chip(page)) === null);
    await api(HOST, 'POST', '/event', { type: 'mode-ping', sessionId: 'm1', cwd: project, permissionMode: 'default', effort: 'xhigh' });
    let c = await waitFor(() => chip(page));
    check('Manual: "<Level> · set in Claude Code", read only, after the mode chip', c && c.text === 'Extra high · set in Claude Code' && c.ro && c.l === '4' && !c.chevron && c.afterMode, c);
    check('Manual: the tooltip says where to change it', c && c.title === 'Set in Claude Code: type /effort', c);
    await q(page, `r.querySelector('.composer .pmode.ef').click(); return true;`);
    await sleep(200);
    check('Manual: a click says to type /effort in Claude Code, and opens no menu', !(await menu(page)) && /type \/effort there/.test(await toast(page)), await toast(page));
    await page.screenshot({ path: path.join(outDir, 'effort-1-manual.png') });
    // Sol L7: in Manual, Main's details card shows the terminal's level.
    const manualFile = path.join(project, 'effort-manual.txt');
    fs.writeFileSync(manualFile, 'b\n');
    await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'm1', cwd: project, file: manualFile, tool: 'Edit', intent: 'A manual note', stats: { added: 1, removed: 1 }, before: 'a\n', after: 'b\n',
      hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }], relFile: 'effort-manual.txt', ts: Date.now() });
    await waitFor(() => q(page, `return Boolean(r.querySelector('.achip[data-key="main"]'))`));
    const manualCard = await q(page, `const b = r.querySelector('.achip[data-key="main"]'); if (!b) return 'no main chip'; b.click();
      const c = r.querySelector('.acard'); if (!c) return 'no card'; const t = c.textContent; b.click(); return t;`);
    check('Sol L7: Manual: Main\'s details card: Effort is the terminal\'s level (Extra high)', /Effort\s*Extra high/.test(manualCard || ''), manualCard);
    // The card stays open after a second click on its chip: Esc closes it, so the menu checks below get Esc.
    await page.keyboard.press('Escape');
    await sleep(100);

    // ----- Page control: the setting's level, changed live -----
    control(HOST, project);
    c = await waitFor(async () => {
      const x = await chip(page);
      return x && !x.ro && x.text === 'High' ? x : null;
    }, 20000);
    check('page control: the chip shows the Effort setting (High), with a meter and a chevron', c && c.l === '3' && c.chevron, c || (await chip(page)));
    check('page control: the tooltip says it is page control\'s effort', c && c.title === 'Page control effort: High. Click to change it.', c && c.title);
    // Auto with nothing in Claude Code's settings: none is sent, and Claude's own level (High here) is shown.
    check('page control: Auto sends no level; Claude\'s own is shown', lines(HOST, 'queries').map((x) => x.effort).pop() === null, lines(HOST, 'queries'));
    await q(page, `r.querySelector('.composer .pmode.ef').click(); return true;`);
    await sleep(200);
    let m = await menu(page);
    check('the menu: title, five levels in order, each with its meter', m && m.title === 'Effort' && m.rows.map((x) => x.name).join('|') === 'Low|Medium|High|Extra high|Max' && m.rows.map((x) => x.l).join('') === '12345', m);
    check('the menu: the notes under Low, High and Max', m && m.rows.map((x) => x.note).join('|') === 'Fastest, for small changes||Default||Most reasoning · this session only', m && m.rows.map((x) => x.note));
    check('the menu: a check on the current level only', m && m.rows.filter((x) => x.on).map((x) => x.level).join() === 'high', m);
    // The current level shows one check, not one after its name and one at the row's end.
    check('the menu: one check mark on the current level', m && m.rows.map((x) => x.marks).join('') === '00100', m && m.rows.map((x) => x.marks));
    // The code view's View menu marks its row without .on: that row keeps its one check.
    const viewMarks = await q(page, `const m = r.querySelector('.efwrap .efmenu'); const b = document.createElement('button'); b.className = 'li'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', 'true'); b.innerHTML = '<span class="lbl">Side</span>'; m.appendChild(b); const n = [b, b.firstChild].filter((x) => getComputedStyle(x, '::after').content.includes('✓')).length; b.remove(); return n;`);
    check('a View menu row keeps its one check mark', viewMarks === 1, viewMarks);
    // D25 B: the page's label changes this page control session only; the menu says tasks use the setting.
    const FOOT = 'Applies to this page control session from Claude\'s next step. New tasks use the Effort setting.';
    check('the menu: it applies to this session; new tasks use the Effort setting', m && m.foot === FOOT, m && m.foot);
    await page.screenshot({ path: path.join(outDir, 'effort-2-menu.png') });
    await page.keyboard.press('Escape');
    check('Esc closes the menu', !(await menu(page)));
    const queries = lines(HOST, 'queries').length;
    await pick(page, 'medium');
    c = await waitFor(async () => ((await chip(page)) || {}).text === 'Medium' && chip(page));
    check('a pick changes Claude live, with no restart', c && c.l === '2' && JSON.stringify(lines(HOST, 'flags').pop()) === '{"effortLevel":"medium"}' && lines(HOST, 'queries').length === queries, [c, lines(HOST, 'flags')]);
    // Sol L5: Main's details card shows page control's level, not the terminal's.
    const file = path.join(project, 'effort-note.txt');
    fs.writeFileSync(file, 'b\n');
    await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'm1', cwd: project, file, tool: 'Edit', intent: 'A note', stats: { added: 1, removed: 1 }, before: 'a\n', after: 'b\n',
      hunks: [{ oldStart: 1, newStart: 1, lines: ['-a', '+b'] }], relFile: 'effort-note.txt', ts: Date.now() });
    await waitFor(() => q(page, `return Boolean(r.querySelector('.achip[data-key="main"]'))`));
    const mainCard = await q(page, `const b = r.querySelector('.achip[data-key="main"]'); if (!b) return 'no main chip'; b.click();
      const c = r.querySelector('.acard'); if (!c) return 'no card'; const t = c.textContent; b.click(); return t;`);
    check('Main\'s details card: Effort is page control\'s level (Medium)', /Effort\s*Medium/.test(mainCard || ''), mainCard);

    // ----- The organization's limit -----
    await pick(page, 'max');
    c = await waitFor(async () => ((await chip(page)) || {}).text === 'Extra high' && chip(page));
    check('Max above the limit: the chip shows the level used (Extra high)', c && c.l === '4' && JSON.stringify(lines(HOST, 'flags').pop()) === '{"effortLevel":"max"}', [c, lines(HOST, 'flags')]);
    check('a toast says the limit', /Effort set to Extra high, the highest your organization allows\./.test(await toast(page)), await toast(page));
    await q(page, `r.querySelector('.composer .pmode.ef').click(); return true;`);
    await sleep(200);
    m = await menu(page);
    const maxRow = m && m.rows.find((x) => x.level === 'max');
    check('above the limit: greyed out (opacity .4)', maxRow && maxRow.cap && maxRow.opacity === '0.4' && m.rows.filter((x) => x.cap).length === 1, m);
    check('the menu says why', m && m.foot === 'Your organization\'s settings allow up to Extra high.', m && m.foot);
    check('the check is on the level used', m && m.rows.filter((x) => x.on).map((x) => x.level).join() === 'xhigh', m);
    await page.screenshot({ path: path.join(outDir, 'effort-3-cap.png') });
    const flags = lines(HOST, 'flags').length;
    await q(page, `r.querySelector('.efwrap button[data-level="max"]').click(); return true;`);
    await sleep(300);
    check('a greyed level can\'t be picked', lines(HOST, 'flags').length === flags && Boolean(await menu(page)));
    await page.keyboard.press('Escape');

    // ----- A second tab gets page control's key: its chip can be changed from then on -----
    const page2 = await ctx.newPage();
    page2.on('pageerror', (e) => errors.push(e.message));
    await page2.goto(`http://127.0.0.1:${siteA.address().port}/`);
    await page2.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    c = await waitFor(async () => { const x = await chip(page2); return x && /change it there/.test(x.title) ? x : null; });
    check('another tab: page control\'s chip, read only', c && c.title === 'Page control effort: Extra high (Max asked for). Page control runs from another tab or page: change it there.', c || (await chip(page2)));
    control(HOST, project);
    c = await waitFor(async () => { const x = await chip(page2); return x && /Click to change it/.test(x.title) ? x : null; }, 15000);
    check('after the key is given to it, the chip can be changed', c && c.title === 'Page control effort: Extra high (Max asked for). Click to change it.', c || (await chip(page2)));
    await q(page2, `r.querySelector('.composer .pmode.ef').click(); return true;`);
    await sleep(200);
    check('and opens the menu', Boolean(await menu(page2)));
    await page2.keyboard.press('Escape');
    await page2.close();

    // ----- A task from the paired computer -----
    const started = await api(REMOTE, 'POST', '/remote/task', { op: 'start', prompt: 'Make the price on the home page bold', effort: 'low', localDir: laptop });
    check('a task started at Low', started.task && started.effort && started.effort.level === 'low', started);
    check('its Claude started with Low', await waitFor(() => lines(HOST, 'queries').some((x) => x.effort === 'low')), lines(HOST, 'queries'));
    // A finished task card folds once something newer is below it (handoff 16.1): opened to read it.
    const card = (p) => q(p, `r.querySelectorAll('.k-task.folded').forEach((x) => x.click()); const b = r.querySelector('.k-task .tft .pmode.ef'); return b ? { text: b.textContent, l: b.querySelector('.lv').dataset.l } : null`);
    c = await waitFor(async () => ((await card(page)) || {}).text === 'Low' && card(page));
    check('the task card on this computer has the chip, at Low', c && c.l === '1', await card(page));
    await waitFor(async () => (await api(REMOTE, 'POST', '/remote/task', { op: 'check', task: started.task })).state === 'idle');
    await card(page);
    await pick(page, 'high', '.k-task .tft .pmode.ef');
    c = await waitFor(async () => ((await card(page)) || {}).text === 'High' && card(page));
    check('changed from its card here: the task\'s Claude gets it live', c && JSON.stringify(lines(HOST, 'flags').pop()) === '{"effortLevel":"high"}', [await card(page), lines(HOST, 'flags').slice(-2)]);
    await page.evaluate(`${ROOT}.querySelector('.k-task').scrollIntoView({ block: 'center' })`);
    await page.screenshot({ path: path.join(outDir, 'effort-4-task-host.png') });

    // ----- The computer that asked: its card, and a model without effort -----
    const lpage = await ctx.newPage();
    lpage.on('pageerror', (e) => errors.push(e.message));
    await lpage.goto(`http://127.0.0.1:${siteB.address().port}/`);
    await lpage.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    c = await waitFor(async () => ((await card(lpage)) || {}).text === 'High' && card(lpage), 20000);
    check('the asking computer\'s card shows the task\'s level', Boolean(c), await card(lpage));
    await card(lpage);
    await pick(lpage, 'medium', '.k-task .tft .pmode.ef');
    c = await waitFor(async () => ((await card(lpage)) || {}).text === 'Medium' && card(lpage));
    check('changed from there: sent to the computer it runs on', c && JSON.stringify(lines(HOST, 'flags').pop()) === '{"effortLevel":"medium"}', [await card(lpage), lines(HOST, 'flags').slice(-2)]);
    check('and that computer\'s card follows', await waitFor(async () => ((await card(page)) || {}).text === 'Medium'), await card(page));
    control(REMOTE, laptop);
    c = await waitFor(async () => {
      const x = await chip(lpage);
      return x && x.off ? x : null;
    }, 20000);
    check('a model without effort: grey "Effort not used", the tooltip names the model', c && c.text === 'Effort not used' && c.l === '0' && c.title === 'fake-model doesn\'t use effort.', c || (await chip(lpage)));
    await q(lpage, `r.querySelector('.composer .pmode.ef').click(); return true;`);
    await sleep(200);
    check('a model without effort: no menu', !(await menu(lpage)));
    await lpage.evaluate(`${ROOT}.querySelector('.k-task').scrollIntoView({ block: 'center' })`);
    await lpage.screenshot({ path: path.join(outDir, 'effort-5-asker.png') });

    // ----- The setting in the page's Settings -----
    await q(page, `[...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More').click(); return true;`);
    await q(page, `[...r.querySelectorAll('.lwrap button')].find((b) => /All settings/.test(b.textContent)).click(); return true;`);
    await page.waitForFunction(`${ROOT}.querySelector('.srow')`, null, { timeout: 5000 }).catch(onTimeout(null));
    const row = await q(page, `const row = [...r.querySelectorAll('.srow')].find((x) => x.querySelector('.stitle') && x.querySelector('.stitle').textContent === 'Effort'); return row ? row.textContent : null`);
    check('the page\'s Settings have Effort, with its levels', row && /How much effort Claude puts into each answer/.test(row) && /Auto/.test(row), row);
    await page.screenshot({ path: path.join(outDir, 'effort-6-settings.png') });
    await q(page, `const b = [...r.querySelectorAll('button')].find((x) => x.textContent === 'Done'); if (b) b.click(); return true;`);

    // ----- Phone-wide, light and dark -----
    for (const scheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 390, height: 800 });
      await sleep(400);
      await q(page, `r.querySelector('.composer .pmode.ef').click(); return true;`);
      await sleep(200);
      const fit = await q(page, `const m = r.querySelector('.efwrap .efmenu').getBoundingClientRect(); const b = r.querySelector('.composer .pmode.ef').getBoundingClientRect(); return { m: [m.left, m.right, m.top, m.bottom], b: [b.left, b.right], w: innerWidth, h: innerHeight }`);
      check(`390 px, ${scheme}: the chip and the menu fit the window`, fit.m[0] >= 0 && fit.m[1] <= fit.w && fit.m[2] >= 0 && fit.m[3] <= fit.h && fit.b[1] <= fit.w, fit);
      await page.screenshot({ path: path.join(outDir, `effort-7-narrow-${scheme}.png`) });
      await page.keyboard.press('Escape');
    }
    check('no page errors', !errors.length, errors);
  } finally {
    if (browser) await browser.close();
    siteA.close();
    siteB.close();
    await stop(HOST);
    await stop(REMOTE);
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
