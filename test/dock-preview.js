#!/usr/bin/env node
'use strict';
require('./isolate');
// Plays scripted edits into the split-screen code view, without running Claude, and records it:
// a backend edit and a CSS edit typed out line by line, a file Claude opens with show_code, and
// a replay from the list of edits. Screenshots in light and dark, plus a video.
//
//   NODE_PATH=$(npm root -g) node test/dock-preview.js <out-dir> [prefix]
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launch } = require('./launch');

const [outDir, prefix = 'dock'] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: dock-preview.js <out-dir> [prefix]');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

const LIVE_PORT = 4965;
const PAGE_PORT = 4964;
const EXAMPLE = path.join(__dirname, '..', 'examples', 'fullstack');
const SERVER_BEFORE = fs.readFileSync(path.join(EXAMPLE, 'server.js'), 'utf8');
const SERVER_AFTER = SERVER_BEFORE.replace(
  "  { name: 'Filter of the day', price: 3.5 },\n",
  "  { name: 'Filter of the day', price: 3.5 },\n  { name: 'Mocha', price: 4.5 },\n  { name: 'Iced latte', price: 4.75 },\n",
);
const CSS_BEFORE = fs.readFileSync(path.join(EXAMPLE, 'public', 'styles.css'), 'utf8');
const CSS_AFTER = CSS_BEFORE.replace('.price { font-variant-numeric: tabular-nums; }', '.price {\n  font-variant-numeric: tabular-nums;\n  font-weight: 700;\n  color: #7a3e1d;\n}');
if (SERVER_AFTER === SERVER_BEFORE || CSS_AFTER === CSS_BEFORE) throw new Error('example files changed; update the scripted edits');

// The page is light, so the panel would follow it; data-theme on the script tag sets the panel's theme.
const PAGE = (theme) => `<!doctype html><html><head><meta charset="utf-8"><title>Trailhead Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}header{padding:18px 40px;background:#fff;border-bottom:1px solid #e6e3da;font-weight:700}
main{padding:40px;max-width:560px}h1{font-size:40px;line-height:1.1;margin:0 0 12px}.menu{list-style:none;padding:0;margin:24px 0 0}.menu li{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #e6e3da}</style>
</head><body><header>Trailhead Coffee</header><main><h1>New coffee each day</h1><p>Small-batch roasts, brewed slowly, served at the bottom of the hill.</p>
<ul class="menu"><li>Espresso <span class="price">$3.00</span></li><li>Flat white <span class="price">$4.25</span></li><li>Filter of the day <span class="price">$3.50</span></li></ul></main>
<script src="http://127.0.0.1:${LIVE_PORT}/live.js" data-panel="min" data-root="/site" data-theme="${theme}"></script></body></html>`;

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: LIVE_PORT, path: urlPath, method, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'x-editlens-token': token } : {}),
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await request('GET', '/health')).status === 200) return;
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('live server did not start');
}

// One edit as the hooks report it: PreToolUse sends the file before, PostToolUse after.
async function edit(token, { id, file, relFile, kind, before, after, intent, routes, stats }) {
  const common = { sessionId: 's1', toolUseId: id, cwd: '/site', file: `/site/${file}`, relFile, tool: 'Edit', ts: Date.now() };
  await request('POST', '/event', { ...common, type: 'pending', intent, before }, token);
  const res = await request('POST', '/event', { ...common, type: 'change', kind, routes: routes || [], intent, stats, hunks: [], hints: {}, after }, token);
  if (res.status !== 200) throw new Error(`event rejected: ${res.body}`);
}

function inDock(page, src) {
  return page.evaluate((s) => new Function('root', s)(document.querySelector('edit-lens').shadowRoot), src);
}

async function waitDock(page, src, timeout) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await inDock(page, src)) return true;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for: ${src}`);
}

async function run(browser, token, scheme, video) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 860 }, deviceScaleFactor: video ? 1 : 2, colorScheme: scheme,
    ...(video ? { recordVideo: { dir: outDir, size: { width: 1440, height: 860 } } } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  // Skip the first-visit tour; localStorage can throw in private mode.
  await page.addInitScript(() => {
    try {
      localStorage.setItem('editlens.tourDone', '1');
    } catch (err) {
      if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
    }
  });
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/?theme=${scheme}`);
  await waitDock(page, `return root.querySelector('.status.idle')`, 10000);
  const shot = async (name) => {
    if (video) return;
    await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-${name}.png`) });
    console.log('captured', `${prefix}-${scheme}-${name}.png`);
  };

  // 1. Claude opens the API code next to the page.
  await request('POST', '/event', { type: 'code', cwd: '/site', file: '/site/server.js', relFile: 'server.js', content: SERVER_BEFORE, line: 11, endLine: 15, note: 'The menu the page renders comes from here', ts: Date.now() }, token);
  await waitDock(page, `return root.querySelector('.dock.on .cnote')`, 5000);
  await page.waitForTimeout(600);
  await shot('1-show-code');

  // 2. A backend edit and a CSS edit, one right after the other: both play in order, side by side.
  await edit(token, { id: 'e1', file: 'server.js', relFile: 'server.js', kind: 'backend', routes: ['/api/menu'], before: SERVER_BEFORE, after: SERVER_AFTER, intent: 'Adding Mocha and an iced latte to the menu API.', stats: { added: 2, removed: 0 } });
  await edit(token, { id: 'e2', file: 'public/styles.css', relFile: 'public/styles.css', kind: 'frontend', before: CSS_BEFORE, after: CSS_AFTER, intent: 'Making prices bold and brown so they are easy to see.', stats: { added: 4, removed: 1 } });
  await waitDock(page, `return root.querySelector('.cl.cur')`, 5000);
  await page.waitForTimeout(450);
  await shot('2-typing');
  await waitDock(page, `const c = root.querySelector('.tab.busy .nm'); return c && c.textContent === 'styles.css' && root.querySelector('.cl.del')`, 15000);
  await shot('3-second-edit');
  await waitDock(page, `return !root.querySelector('.tab.busy') && !root.querySelector('.dqueue').hasAttribute('data-busy')`, 20000);
  await page.waitForTimeout(400);
  await shot('4-split-done');

  // A backend edit reloads the page: the code view opens again with the same files.
  await page.reload();
  await waitDock(page, `return root.querySelectorAll('.dock.on .tab').length === 2 && root.querySelectorAll('.pane.on .cl').length > 40`, 10000);
  console.log('restored after reload');

  // 3. Replay the backend edit from the list of edits.
  await inDock(page, `root.querySelectorAll('.erow')[0].click(); return true;`);
  await waitDock(page, `return root.querySelector('.cl.cur')`, 5000);
  await page.waitForTimeout(300);
  await shot('5-replay');
  await waitDock(page, `return !root.querySelector('.tab.busy')`, 20000);

  // 4. Tabs layout and the chat panel alongside.
  await inDock(page, `root.querySelector('.pill').click(); root.querySelector('.dhead button[title^="One pane"]').click(); return true;`);
  // The replay outlined server.js on the page; clear that bar and show the server.js tab.
  await inDock(page, `const c = root.querySelector('.selbar.on button[title^="Clear"]'); if (c) c.click(); return true;`);
  await inDock(page, `[...root.querySelectorAll('.dock .tab')].find((t) => t.querySelector('.nm').textContent === 'server.js').click(); return true;`);
  await page.waitForTimeout(500);
  await shot('6-tabs-with-panel');
  await context.close();
}

// A new live server per run, so each run starts with an empty history and timeline.
async function startLive() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-dock-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, EDITLENS_PORT: String(LIVE_PORT), EDITLENS_STATE_DIR: stateDir },
    stdio: 'ignore',
  });
  await waitUp();
  const token = fs.readFileSync(path.join(stateDir, `token-${LIVE_PORT}`), 'utf8').trim();
  const stop = async () => {
    const exited = new Promise((r) => proc.once('exit', r));
    proc.kill();
    await exited;
    fs.rmSync(stateDir, { recursive: true, force: true });
  };
  return { token, stop };
}

(async () => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const theme = new URL(req.url, 'http://x').searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    res.end(PAGE(theme));
  }).listen(PAGE_PORT, '127.0.0.1');
  const browser = await launch(chromium);
  try {
    for (const [scheme, video] of [['dark', false], ['light', false], ['dark', true]]) {
      const live = await startLive();
      try {
        await run(browser, live.token, scheme, video);
      } finally {
        await live.stop();
      }
    }
  } finally {
    await browser.close();
    site.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
