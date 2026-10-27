#!/usr/bin/env node
'use strict';
require('./isolate');
// End-to-end demo: opens a page with the EditLens client, has Claude Code (with this
// plugin loaded) edit the page's files, and screenshots every highlighted change.
//
//   EDITLENS_E2E_REAL_CLAUDE=1 NODE_PATH=$(npm root -g) \
//     node test/e2e-demo.js <site-dir> <site-url> <out-dir> "<prompt>"
// The README pictures run Claude with Haiku: ANTHROPIC_MODEL=claude-haiku-5-5.
const { needRealClaude } = require('./isolate');
needRealClaude();
const fs = require('fs');
const path = require('path');
// Its own port and isolate's state folder: the EditLens server the user runs is never used or stopped.
process.env.EDITLENS_PORT = '5230';
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { stopChild, spawned } = require('./child-stop');
const { ensureServer, stopServer } = require('../lib/client');

const [siteDir, siteUrl, outDir, prompt] = process.argv.slice(2);
if (!siteDir || !siteUrl || !outDir || !prompt) {
  console.error('usage: e2e-demo.js <site-dir> <site-url> <out-dir> "<prompt>"');
  process.exit(2);
}
const pluginDir = path.resolve(__dirname, '..');
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

function liveState(page) {
  return page.evaluate(() => {
    const root = document.querySelector('edit-lens')?.shadowRoot;
    if (!root) return { boxes: 0, items: 0, status: 'missing' };
    return {
      boxes: root.querySelectorAll('.box:not(.out)').length,
      items: root.querySelectorAll('.k-edit').length,
      status: root.querySelector('.status')?.textContent || '',
      tag: root.querySelector('.tag')?.textContent || '',
    };
  });
}

// A short note (such as "Claude now runs from this page") shows for 2.6 s; the picture waits until it
// goes, so it covers nothing. The change's highlight stays 4.2 s. A longer note is left in the picture.
async function toastGone(page) {
  await page.waitForFunction(() => !document.querySelector('edit-lens')?.shadowRoot?.querySelector('.toast.on'), null, { timeout: 3000 })
    .catch((err) => { if (err.name === 'TimeoutError') console.log('a note still shows in the picture'); else throw err; });
}

(async () => {
  let browser = null;
  let claude = null;
  let ok = false;
  try {
    // The server first: the page connects to it before Claude (whose hook would start it) runs.
    await ensureServer();
    browser = await launchOwnPort(chromium);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      recordVideo: { dir: outDir, size: { width: 1280, height: 800 } },
    });
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    // The README pictures skip the first-visit tour; localStorage can throw in private mode.
    await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await page.goto(siteUrl);
    await page.waitForFunction(() => document.querySelector('edit-lens')?.shadowRoot?.querySelector('.status.idle'));
    // EDITLENS_E2E_PANEL=min: the panel is made small (its Minimize key), so it covers less of a narrow page.
    if (process.env.EDITLENS_E2E_PANEL === 'min') await page.keyboard.press('Alt+Shift+KeyC');
    await page.screenshot({ path: path.join(outDir, '00-before.png') });

    claude = spawn('claude', [
      '-p', prompt,
      '--plugin-dir', pluginDir,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,MultiEdit,Glob,Grep',
    ], { cwd: siteDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    await spawned(claude);
    let output = '';
    claude.stdout.on('data', (d) => { output += d; });
    claude.stderr.on('data', (d) => { output += d; });
    const done = new Promise((resolve) => claude.on('exit', resolve));

    let finished = false;
    let exitCode = null;
    done.then((code) => { finished = true; exitCode = code; });
    let shots = 0;
    let lastItems = (await liveState(page)).items; // replayed history from earlier runs
    const started = Date.now();
    while (!finished && Date.now() - started < 300000) {
      const s = await liveState(page);
      if (s.items > lastItems) {
        lastItems = s.items;
        // Wait for the highlight that belongs to this change (its tag names the newest file; the newest
        // edit card is the last one).
        const shown = await page.waitForFunction(() => {
          const root = document.querySelector('edit-lens').shadowRoot;
          const file = [...root.querySelectorAll('.k-edit .file')].pop()?.textContent.replace(/‎/g, '').split('/').pop();
          const tag = root.querySelector('.box:not(.out) .tag')?.textContent || '';
          return file && tag.startsWith(file) && root.querySelectorAll('.box:not(.out)').length > 0;
        }, null, { timeout: 4000 }).then(() => true, (err) => {
          if (err.name === 'TimeoutError') return false;
          throw err;
        });
        if (!shown) { console.log('no highlight for change', s.items); continue; }
        await page.waitForTimeout(700); // let the pop-in animation finish
        await toastGone(page);
        Object.assign(s, await liveState(page));
        shots++;
        const file = path.join(outDir, `${String(shots).padStart(2, '0')}-change.png`);
        await page.screenshot({ path: file });
        console.log(`captured ${path.basename(file)}: ${s.tag} (${s.boxes} highlighted)`);
      }
      await page.waitForTimeout(150);
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, '99-done.png') });
    // Expanded diff of the newest change, for the README.
    await page.evaluate(() => [...document.querySelector('edit-lens').shadowRoot.querySelectorAll('.k-edit')].pop()?.click());
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, '98-diff.png') });
    const final = await liveState(page);
    await context.close();
    console.log(`claude exited ${finished ? exitCode : 'no (timed out)'}; feed items: ${final.items}; screenshots: ${shots}`);
    console.log('--- claude output ---\n' + output.slice(-2000));
    ok = finished && exitCode === 0 && shots > 0;
  } finally {
    await stopChild(claude);
    if (browser) await browser.close();
    await stopServer();
  }
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
