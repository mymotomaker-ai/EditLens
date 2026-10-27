#!/usr/bin/env node
'use strict';
require('./isolate');
// Renders the command palette without running Claude: opened with "/", searched, a custom
// command sent to Claude, and a built-in copied. Light and dark.
//
//   NODE_PATH=$(npm root -g) node test/palette-preview.js <out-dir> [prefix]
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launch } = require('./launch');
const { listCommands } = require('../lib/commands');

const [outDir, prefix = 'palette'] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: palette-preview.js <out-dir> [prefix]');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

const LIVE_PORT = 4994;
const PAGE_PORT = 4993;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-palette-'));
// The page is light, so the panel would follow it; data-theme on the script tag sets the panel's theme.
// data-root links the page to the project, so its message box is on.
const PAGE = (theme) => `<!doctype html><html><head><meta charset="utf-8"><title>Trailhead Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:48px 40px}h1{font-size:40px;margin:0}</style>
</head><body><main><h1>New coffee each day</h1></main>
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

(async () => {
  const live = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, EDITLENS_PORT: String(LIVE_PORT), EDITLENS_STATE_DIR: stateDir },
    stdio: 'ignore',
  });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    const theme = new URL(req.url, 'http://x').searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    res.end(PAGE(theme));
  }).listen(PAGE_PORT, '127.0.0.1');
  let browser = null;
  try {
    await waitUp();
    const token = fs.readFileSync(path.join(stateDir, `token-${LIVE_PORT}`), 'utf8').trim();
    const commands = [
      { name: 'ship', description: 'Build and deploy the site to staging', argumentHint: '[env]', source: 'project', kind: 'command', runnable: true },
      { name: 'review', description: 'Review the current diff for bugs and style', argumentHint: '', source: 'user', kind: 'skill', runnable: true },
      ...listCommands({ pluginRoot: path.join(__dirname, '..'), pluginName: 'editlens', claudeDir: path.join(stateDir, 'none') }),
    ];
    await request('POST', '/event', { type: 'session', sessionId: 's1', cwd: '/site', canListen: true, ts: Date.now() }, token);
    await request('POST', '/event', { type: 'commands', sessionId: 's1', cwd: '/site', commands, ts: Date.now() }, token);
    browser = await launch(chromium);
    for (const scheme of ['dark', 'light']) {
      const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'] });
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
      const root = 'document.querySelector("edit-lens").shadowRoot';
      await page.waitForFunction(`${root} && ${root}.querySelector('.status.idle')`);
      // "/" in the empty message box opens the palette.
      await page.evaluate(`${root}.querySelector('.composer textarea').focus()`);
      await page.keyboard.press('/');
      await page.waitForFunction(`${root}.querySelector('.palette.on .pitem')`);
      await page.waitForTimeout(250);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-1-open.png`) });
      // "comp" alone also finds the guide skill by its description, which is listed first.
      await page.keyboard.type('compact');
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-2-search.png`) });
      // A built-in is copied, not sent.
      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const clip = await page.evaluate('navigator.clipboard.readText()');
      console.log(scheme, 'copied:', clip);
      // Ctrl+K, a custom command with arguments: sent to Claude.
      await page.evaluate(`${root}.querySelector('.composer textarea').focus()`);
      await page.keyboard.press('Control+k');
      await page.waitForFunction(`${root}.querySelector('.palette.on')`);
      await page.keyboard.type('ship staging');
      await page.keyboard.press('Enter');
      const sentText = `[...${root}.querySelectorAll('.k-user.cmd .bubble')].map((b) => b.textContent).pop() || ''`;
      await page.waitForFunction(`(${sentText}).startsWith('/ship')`);
      await page.waitForTimeout(300);
      console.log(scheme, 'sent:', await page.evaluate(sentText));
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-3-sent.png`) });
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
