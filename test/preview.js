#!/usr/bin/env node
'use strict';
require('./isolate');
// Renders the EditLens panel with a realistic session so its design can be checked
// without running Claude: light and dark, at Windows' 100% scale and on a retina screen.
//
//   NODE_PATH=$(npm root -g) node test/preview.js <out-dir> [prefix]
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launch } = require('./launch');

const [outDir, prefix = 'panel'] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: preview.js <out-dir> [prefix]');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

const LIVE_PORT = 4997;
const PAGE_PORT = 4996;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-preview-'));
// The page is light, so the panel would follow it: data-theme on the script tag sets the panel's theme.
// data-root links the page to the project, so its message box is on.
const PAGE = (theme) => `<!doctype html><html><head><meta charset="utf-8"><title>Trailhead Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}header{padding:18px 40px;background:#fff;border-bottom:1px solid #e6e3da;font-weight:700}
main{padding:48px 40px;max-width:640px}h1{font-size:44px;line-height:1.1;margin:0 0 12px}.menu{list-style:none;padding:0;margin:28px 0 0}.menu li{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #e6e3da}.price{font-weight:700}</style>
</head><body><header>Trailhead Coffee</header><main><h1>New coffee each day</h1><p>Small-batch roasts, brewed slowly, served at the bottom of the hill.</p>
<ul class="menu"><li>Espresso <span class="price">$3.00</span></li><li>Flat white <span class="price">$4.25</span></li><li>Mocha <span class="price">$4.50</span></li></ul></main>
<script src="http://127.0.0.1:${LIVE_PORT}/live.js" data-panel="open" data-root="/site" data-theme="${theme}"></script></body></html>`;

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

function session(now) {
  let t = now - 240000;
  const at = (s) => (t += s * 1000);
  const hunk = (start, lines) => ({ oldStart: start, newStart: start, lines });
  return [
    { type: 'prompt', ts: at(0) },
    { type: 'chat', role: 'user', text: 'Add a Mocha to the menu API, make prices bold, and tidy the main heading.', ts: at(1) },
    { type: 'chat', role: 'assistant', text: "I'll start by asking a subagent to review the stylesheet while I look at the API.", ts: at(3) },
    { type: 'chat', role: 'agent-start', toolUseId: 't1', agentType: 'general-purpose', description: 'Review styles.css for one improvement', prompt: 'Read public/styles.css and suggest a single visual improvement.', ts: at(1) },
    { type: 'chat', role: 'agent-step', toolUseId: 't1', agentId: 'a1', kind: 'tool', tool: 'Read', summary: 'public/styles.css', ts: at(2) },
    { type: 'chat', role: 'agent-step', toolUseId: 't1', agentId: 'a1', kind: 'text', text: 'The **price** column is easy to miss; a heavier weight would help it scan.', ts: at(6) },
    { type: 'chat', role: 'agent-done', toolUseId: 't1', agentId: 'a1', status: 'completed', durationMs: 14200, toolCount: 1, text: 'Make `.price` bold (700) so prices are easy to see next to item names.', ts: at(3) },
    { type: 'chat', role: 'tool', tool: 'Read', summary: 'server.js', ts: at(2) },
    { type: 'chat', role: 'tool', tool: 'Grep', summary: '"/api/menu"', ts: at(1) },
    { type: 'change', tool: 'Edit', kind: 'backend', file: '/site/server.js', relFile: 'server.js', routes: ['/api/menu'], intent: 'Adding Mocha at $4.50 to the menu the API returns.', stats: { added: 1, removed: 0 }, hunks: [hunk(8, [" { name: 'Flat white', price: 4.25 },", "+ { name: 'Mocha', price: 4.5 },", ' ];'])], ts: at(4) },
    { type: 'change', tool: 'Edit', kind: 'frontend', file: '/site/public/styles.css', relFile: 'public/styles.css', intent: 'Making prices bold, as the subagent suggested.', stats: { added: 1, removed: 1 }, hunks: [hunk(41, [' .price {', '-  font-weight: 400;', '+  font-weight: 700;', ' }'])], ts: at(5) },
    { type: 'page-message', id: 'm1', text: "Also change the main heading to 'New coffee each day'.", status: 'pending', ts: at(4) },
    { type: 'delivered', ids: ['m1'], via: 'stop', ts: at(9) },
    { type: 'change', tool: 'Edit', kind: 'frontend', file: '/site/public/index.html', relFile: 'public/index.html', intent: 'Changing the main heading, as you asked from the page.', stats: { added: 1, removed: 1 }, hunks: [hunk(19, ['-      <h1 class="hero-title">Coffee for the longer walk</h1>', '+      <h1 class="hero-title">New coffee each day</h1>'])], ts: at(4) },
    { type: 'chat', role: 'assistant', text: 'Done. **Mocha** is on the menu at $4.50, prices are bold, and the headline now reads *New coffee each day*.', ts: at(3) },
    { type: 'idle', ts: at(1) },
    { type: 'page-message', id: 'm2', text: 'Which item is the most expensive? Point at it.', status: 'pending', ts: at(20) },
    { type: 'delivered', ids: ['m2'], via: 'listen', ts: at(1) },
    { type: 'point', pointId: 'p1', color: 'green', targets: [{ text: 'Mocha', note: 'Most expensive: $4.50' }], duration: 0, ts: at(4) },
    { type: 'chat', role: 'assistant', text: "It's the **Mocha** at $4.50, outlined in green. The Flat white is next at $4.25.", ts: at(2) },
    { type: 'idle', ts: at(1) },
  ];
}

(async () => {
  const live = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, EDITLENS_PORT: String(LIVE_PORT), EDITLENS_STATE_DIR: stateDir },
    stdio: 'ignore',
  });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE(new URL(req.url, 'http://x').searchParams.get('theme') === 'dark' ? 'dark' : 'light'));
  }).listen(PAGE_PORT, '127.0.0.1');
  let browser = null;
  try {
    await waitUp();
    const token = fs.readFileSync(path.join(stateDir, `token-${LIVE_PORT}`), 'utf8').trim();
    await request('POST', '/event', { type: 'session', sessionId: 's1', cwd: '/site', canListen: true, ts: Date.now() }, token);
    for (const ev of session(Date.now())) await request('POST', '/event', ev, token);

    browser = await launch(chromium);
    const shots = [
      { scheme: 'dark', scale: 1, name: 'dark-100' },
      { scheme: 'light', scale: 1, name: 'light-100' },
      { scheme: 'dark', scale: 2, name: 'dark' },
      { scheme: 'light', scale: 2, name: 'light' },
    ];
    for (const s of shots) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: s.scale, colorScheme: s.scheme });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log('[pageerror]', e.message));
      // README pictures (scale 2) skip the first-visit tour; localStorage can throw in private mode.
      if (s.scale === 2) {
        await page.addInitScript(() => {
          try {
            localStorage.setItem('editlens.tourDone', '1');
          } catch (err) {
            if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
          }
        });
      }
      await page.goto(`http://127.0.0.1:${PAGE_PORT}/?theme=${s.scheme}`);
      await page.waitForFunction(() => {
        const root = document.querySelector('edit-lens')?.shadowRoot;
        return root && root.querySelectorAll('.k-edit').length >= 3;
      });
      await request('POST', '/event', { type: 'listen', active: true, until: Date.now() + 9 * 60000 + 41000, ts: Date.now() }, token);
      await page.evaluate(() => {
        const root = document.querySelector('edit-lens').shadowRoot;
        root.querySelector('.k-edit').classList.add('open');
        const feed = root.querySelector('.feed');
        feed.scrollTop = feed.scrollHeight;
      });
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${s.name}.png`) });
      console.log('captured', `${prefix}-${s.name}.png`);
      if (s.scale === 1) {
        // The tour skipped, the feed at the subagent and the edit cards.
        await page.evaluate(() => {
          const root = document.querySelector('edit-lens').shadowRoot;
          const skip = [...root.querySelectorAll('.tour button')].find((b) => b.textContent === 'Skip');
          if (skip) skip.click();
          root.querySelector('.k-edit').classList.remove('open');
          root.querySelector('.k-agent').scrollIntoView({ block: 'start' });
        });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(outDir, `${prefix}-${s.name}-cards.png`) });
        await page.evaluate(() => document.querySelector('edit-lens').shadowRoot.querySelector('.head .tools [aria-haspopup]').click());
        await page.waitForTimeout(200);
        await page.screenshot({ path: path.join(outDir, `${prefix}-${s.name}-menu.png`) });
        await page.keyboard.press('Escape');
      }
      if (s.name === 'dark-100') {
        // Large text, then the minimized pill.
        const menuPick = (label) => page.evaluate((l) => {
          const root = document.querySelector('edit-lens').shadowRoot;
          root.querySelector('.head .tools [aria-haspopup]').click();
          [...root.querySelectorAll('.lmenu button')].find((x) => x.getAttribute('aria-label') === l).click();
        }, label);
        await menuPick('Large text');
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(outDir, `${prefix}-${s.name}-large.png`) });
        await menuPick('Medium text');
        await page.evaluate(() => document.querySelector('edit-lens').shadowRoot.querySelector('.head .tools button:last-child').click());
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(outDir, `${prefix}-${s.name}-pill.png`) });
      }
      if (s.scale === 2) {
        await page.evaluate(() => {
          const root = document.querySelector('edit-lens').shadowRoot;
          root.querySelector('.k-agent').classList.add('open');
          root.querySelector('.feed').scrollTop = 0;
        });
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(outDir, `${prefix}-${s.name}-top.png`) });
      }
      await context.close();
    }
  } finally {
    if (browser) await browser.close();
    site.close();
    live.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
