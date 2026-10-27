'use strict';
require('./isolate');
// The Settings card on a real page and server (settings check S1, S4, S13-S15, S17, S18): the
// order of its rows, the stepper's ends, a change refused because the mod just stopped, the header
// button, the note without the mod, reduced motion, and a page through a pairing link (read-only).
// usage: NODE_PATH=$(npm root -g) node test/settings-card-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: settings-card-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-card-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5319' });
const config = require('../lib/config');
const { ensureServer, stopServer, postEvent, postJson } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = 'http://127.0.0.1:5319';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tag = `<script src="${SERVER}/live.js" data-root="${proj}" data-panel="open"></script>`;
const PAGE = `<!doctype html><title>Site</title><body style="margin:40px"><h1>Site</h1>${tag}</body>`;

// The mod stand-in: its poll makes the page able to change settings (for 8 seconds after each).
let modTimer = null;
const modPoll = () => fetch(`${SERVER}/summary?cwd=${encodeURIComponent(proj)}&mod=1`, { headers: { 'x-editlens-token': fs.readFileSync(config.tokenFile, 'utf8').trim() } }).then((r) => r.json());
function modOn() {
  modTimer = setInterval(() => modPoll().catch((err) => console.log('mod poll: ' + err.message)), 2000);
  return modPoll();
}
function modOff() {
  clearInterval(modTimer);
  modTimer = null;
}

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), settings: { theme: 'Auto' } });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${site.address().port}`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const errors = [];
  async function open(options = {}) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: options.reducedMotion || 'no-preference' });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    if (options.route) await options.route(page);
    await page.goto(base + '/');
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(400);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    return { ctx, page, q };
  }
  async function openSettings(page, q) {
    await q(`[...r.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'More').click(); return true;`);
    await q(`[...r.querySelectorAll('.lwrap button')].find((b) => /All settings/.test(b.textContent)).click(); return true;`);
    await page.waitForFunction(`${ROOT}.querySelector('.srow')`, null, { timeout: 5000 });
  }
  const note = (q) => q(`const n = r.querySelector('.settings .snote'); return n ? n.textContent : ''`);
  const rowSwitch = (q, title) => q(`const row = [...r.querySelectorAll('.srow')].find((x) => x.querySelector('.stitle').textContent === ${JSON.stringify(title)}); const b = row && row.querySelector('.sw'); return b ? b.getAttribute('aria-checked') : null`);
  const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
  try {
    await section('with the mod: order, stepper, a refused change', async () => {
      await modOn();
      const { ctx, page, q } = await open();
      await openSettings(page, q);
      await page.waitForFunction(`/Saved in Claude Code/.test(${ROOT}.querySelector('.settings .snote').textContent)`, null, { timeout: 5000 });
      // S15: one group heading, right above the one row it is about, at the end.
      const order = await q(`const g = r.querySelector('.settings .sgroup'); return [...g.children].map((c) => c.classList.contains('sghead') ? '# ' + c.textContent : c.querySelector('.stitle').textContent)`);
      check('Tasks at once is last, under "Other computers"', order.slice(-2).join('|') === '# Other computers|Tasks at once' && order.filter((x) => x.startsWith('# ')).length === 1, order);
      check('the page and panel settings come before it, with no heading about other computers', order.indexOf('Highlight when Claude waits for you') < order.indexOf('# Other computers'), order);
      await page.screenshot({ path: path.join(outDir, 'settings-card-mod.png') });

      // S17: the ends of the range.
      const stepLabels = () => q(`return [...r.querySelectorAll('.stepper[data-key="tasks_at_once"] button')].map((b) => [b.getAttribute('aria-label'), b.disabled])`);
      await postJson('/settings/report', { values: { tasks_at_once: 1 }, from: 'mod' });
      await page.waitForFunction(`${ROOT}.querySelector('.stepper[data-key="tasks_at_once"] b').textContent === '1'`, null, { timeout: 5000 });
      let labels = await stepLabels();
      check('at 1: "Fewer (lowest is 1)", off', JSON.stringify(labels) === JSON.stringify([['Fewer (lowest is 1)', true], ['More: 2', false]]), labels);
      await postJson('/settings/report', { values: { tasks_at_once: 8 }, from: 'mod' });
      await page.waitForFunction(`${ROOT}.querySelector('.stepper[data-key="tasks_at_once"] b').textContent === '8'`, null, { timeout: 5000 });
      labels = await stepLabels();
      check('at 8: "More (highest is 8)", off', JSON.stringify(labels) === JSON.stringify([['Fewer: 7', false], ['More (highest is 8)', true]]), labels);
      await postJson('/settings/report', { values: {}, from: 'mod' });

      // S4: the mod stops between the last settings and a change; the server says so (409).
      await page.route(`${SERVER}/settings`, (route) => (route.request().method() === 'POST'
        ? route.fulfill({ status: 409, contentType: 'application/json', headers: { 'access-control-allow-origin': base }, body: JSON.stringify({ error: 'local', message: 'Saved on this page only. To change it everywhere, use /config in Claude Code (search "editlens").' }) })
        : route.fallback()));
      check('before: Highlight changes is on', (await rowSwitch(q, 'Highlight changes on the page')) === 'true');
      await q(`const row = [...r.querySelectorAll('.srow')].find((x) => x.querySelector('.stitle').textContent === 'Highlight changes on the page'); row.querySelector('.sw').click(); return true;`);
      await sleep(600);
      const local = await page.evaluate(() => localStorage.getItem('editlens.localSettings'));
      check('the refused change is kept on this page', /"highlight":false/.test(String(local)), local);
      check('the card says changes stay on this page', /stay on this page/.test(await note(q)), await note(q));
      check('the switch shows the change', (await rowSwitch(q, 'Highlight changes on the page')) === 'false');
      await page.unroute(`${SERVER}/settings`);
      await ctx.close();
      modOff();
    });

    await section('without the mod: the note and the header button', async () => {
      // The mod polls no more: pages hear it within a few seconds of the 8 the server waits.
      await sleep(9500);
      const { ctx, page, q } = await open();
      await openSettings(page, q);
      const text = await note(q);
      check('S18: says Claude Code isn\'t connected, no version', /^Claude Code isn't connected right now, so changes here stay on this page\./.test(text) && !/2\.1\.287/.test(text), text);
      const before = await rowSwitch(q, 'Highlight changes on the page');
      await q(`r.querySelector('button.hl').click(); return true;`);
      await sleep(300);
      const after = await rowSwitch(q, 'Highlight changes on the page');
      check('S14: the header Highlights button updates the card immediately', before !== null && after !== before, [before, after]);
      await ctx.close();
    });

    await section('reduced motion: the permissions button keeps a ring', async () => {
      const { ctx, q } = await open({ reducedMotion: 'reduce' });
      const shadows = await q(`const b = r.querySelector('.pqb'); b.className = 'pqb on'; const plain = getComputedStyle(b).boxShadow;
        b.className = 'pqb on still'; const still = getComputedStyle(b).boxShadow; b.className = 'pqb on glow';
        return { plain, still, glow: getComputedStyle(b).boxShadow, animation: getComputedStyle(b).animationName }`);
      check('S13: no animation', shadows.animation === 'none', shadows);
      check('S13: "Highlight when waiting" On has a ring, wider than Off\'s', shadows.glow !== shadows.plain && /4px/.test(shadows.glow) && /3px/.test(shadows.still), shadows);
      await ctx.close();
    });

    await section('through a pairing link: read-only, nothing sent', async () => {
      // A stand-in for the stream through a pairing link: the hello and settings name the other computer.
      const real = await (await fetch(`${SERVER}/settings`)).json();
      const via = { ...real, canChange: false, editable: [], via: 'vps', fields: real.fields.map((f) => ({ ...f, pageEditable: false })) };
      let posts = 0;
      const route = async (page) => {
        await page.route(`${SERVER}/events*`, (r) => r.fulfill({ status: 200, contentType: 'text/event-stream', headers: { 'access-control-allow-origin': base },
          body: `retry: 600000\n\nevent: claude\ndata: ${JSON.stringify({ type: 'hello', version: config.version, instance: 'x', via: { name: 'vps' }, projects: [] })}\n\n`
            + `event: claude\ndata: ${JSON.stringify(via)}\n\n` }));
        await page.route(`${SERVER}/settings`, (r) => {
          if (r.request().method() === 'POST') posts++;
          return r.fallback();
        });
      };
      const { ctx, page, q } = await open({ route });
      await openSettings(page, q);
      const text = await note(q);
      check('S1: the note names the other computer', /^These are the settings of ◆ vps, where this page runs\./.test(text), text);
      const rows = await q(`return [...r.querySelectorAll('.srow')].map((x) => [x.querySelector('.stitle').textContent, Boolean(x.querySelector('.sfixed')), x.querySelector('.sfixed') ? x.querySelector('.sfixed span').textContent : ''])`);
      check('S1: every row is read-only and says where it is set', rows.length > 10 && rows.every((x) => x[1] && x[2] === 'set on ◆ vps'), rows.slice(0, 3));
      check('S1: no Reset', !(await q(`return Boolean(r.querySelector('.settings .sfoot'))`)));
      await page.screenshot({ path: path.join(outDir, 'settings-card-paired.png') });
      await q(`r.querySelector('button.hl').click(); return true;`);
      await sleep(500);
      check('S1: the header Highlights button sends no change to the other computer', posts === 0, posts);
      await ctx.close();
    });
    check('no page errors', !errors.length, errors);
  } finally {
    modOff();
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
