#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4987';
// A long session uses little memory in the page: finished subagents beyond the newest 50 are
// removed (card data and chip), a subagent card or a row of tool steps keeps its newest 200 steps,
// and the panel still works afterwards.
//
//   NODE_PATH=$(npm root -g) node test/memory-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'memory-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: memory-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `memory-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Skip the tour; localStorage can throw in private mode.
  await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: siteDir, ts: Date.now(), backlog: false, ...ev });
  for (let i = 0; i < 80; i++) {
    await chat({ role: 'agent-start', toolUseId: `tu${i}`, agentType: 'Explore', description: `Look ${i}` });
    await chat({ role: 'agent-done', toolUseId: `tu${i}`, status: 'completed', text: 'ok', toolCount: 1 });
  }
  await chat({ role: 'agent-start', toolUseId: 'long', agentType: 'general-purpose', description: 'Long one' });
  for (let i = 0; i < 260; i++) await chat({ role: 'agent-step', toolUseId: 'long', kind: 'tool', tool: 'Read', summary: `file${i}.js` });
  for (let i = 0; i < 260; i++) await chat({ role: 'tool', toolUseId: `t${i}`, tool: 'Grep', summary: `term${i}` });
  await page.waitForTimeout(2500);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const m = await q(`return {
    chips: r.querySelectorAll('.agents .agrow:not([data-key="main"])').length, // the Agents tab's rows, Main left out
    longSteps: [...r.querySelectorAll('.k-agent')].pop().querySelectorAll('.asteps > *').length,
    rowSteps: Math.max(...[...r.querySelectorAll('.k-steps')].map((x) => x.children.length)),
    newestStep: [...r.querySelectorAll('.k-steps')].pop().lastChild.textContent,
  };`);
  check('finished subagents beyond the newest 50 are let go', m.chips <= 51 && m.chips >= 50, m);
  check('a subagent card keeps its newest 200 steps', m.longSteps === 200, m);
  check('a row of tool steps keeps its newest 200', m.rowSteps === 200 && /term259/.test(m.newestStep), m);
  check('the Agents tab still opens', await q(`const b = r.querySelector('.filters button[data-f="agents"]'); if (!b) return false; b.click(); return r.querySelectorAll('.k-agent').length > 0;`));
  check('no page errors', errors.length === 0, errors);
  await page.screenshot({ path: path.join(outDir, 'memory.png') });
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
