#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4979';
// Following one agent in the code view, and the split layout at small sizes, without running
// Claude: two subagents read and edit files; following one plays only its work; "Follow latest"
// jumps to whoever touched a file last; split view never pushes the replay strip off screen.
//
//   NODE_PATH=$(npm root -g) node test/follow-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'follow-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: follow-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `follow-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: siteDir, ts: Date.now(), backlog: false, ...ev });
const file = (rel) => path.join(siteDir, rel);
const text = (rel) => fs.readFileSync(file(rel), 'utf8');

async function edit(rel, agentId, from, to) {
  const before = text(rel);
  const after = before.replace(from, to);
  const lines = before.split('\n');
  const n = lines.findIndex((l) => l.includes(from)) + 1;
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file: file(rel), relFile: rel, ts: Date.now(),
    agentId, agentType: agentId ? 'general-purpose' : null, before, after, stats: { added: 1, removed: 1 }, hints: {},
    hunks: [{ oldStart: n, newStart: n, lines: ['-' + lines[n - 1], '+' + lines[n - 1].replace(from, to)] }],
  });
}

(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1536, height: 735 }, deviceScaleFactor: 1.25 })).newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const shown = () => q(`return [...r.querySelectorAll('.pane.on')].map((p) => p.querySelector('.path').textContent.replace(/\\u200e/g, '') + (p.querySelector('.who.on') ? ' @' + (p.querySelector('.who .achip') || p.querySelector('.who span')).textContent : ''))`);
  const playing = async () => { await page.waitForTimeout(400); await page.waitForFunction(`!${ROOT}.querySelector('.tab.busy')`, null, { timeout: 30000 }); await page.waitForTimeout(300); };

  await chat({ role: 'agent-start', toolUseId: 'tuA', description: 'Restyle the stat cards', agentType: 'general-purpose', prompt: '' });
  await chat({ role: 'agent-start', toolUseId: 'tuB', description: 'Tidy the entry file', agentType: 'general-purpose', prompt: '' });
  await chat({ role: 'agent-step', agentId: 'agA', toolUseId: 'tuA', agentType: 'general-purpose', kind: 'tool', tool: 'Read', summary: 'App.jsx', file: file('src/App.jsx'), line: 7, end: 14, op: 'read' });
  await chat({ role: 'agent-step', agentId: 'agB', toolUseId: 'tuB', agentType: 'general-purpose', kind: 'tool', tool: 'Read', summary: 'main.jsx', file: file('src/main.jsx'), line: null, end: null, op: 'read' });
  await page.waitForTimeout(800);
  // The Follow menu (drawn when opened from the Follow chip) has a row for each agent.
  await q(`r.querySelector('.fhead').click(); return true;`);
  await page.waitForFunction(`${ROOT}.querySelector('.lwrap .follow')`, null, { timeout: 3000 });
  const rows = await q(`return [...r.querySelectorAll('.lwrap .follow .fchip.achip')].map((b) => b.textContent)`);
  await page.keyboard.press('Escape');
  check('the Follow menu lists the agents', ['Restyle the stat cards', 'Tidy the entry file'].every((a) => rows.some((t) => t.includes(a))), rows);

  // Agents tab: Follow code on agent A opens what A is reading.
  await q(`[...r.querySelectorAll('.k-agent')].find((c) => c.textContent.includes('Restyle')).querySelector('.afollow').click(); return true;`);
  await playing();
  let panes = await shown();
  check('following A shows the file A reads', panes.some((p) => p.startsWith('src/App.jsx') && p.includes('@Restyle')), panes);
  check('A\'s lines are marked', (await q(`return r.querySelectorAll('.pane.on .cl.lmark').length`)) === 8);

  // B edits a file: not shown while following A.
  await edit('src/app.css', 'agB', 'body', 'body');
  await page.waitForTimeout(1500);
  panes = await shown();
  check('B\'s edit does not play while following A', !panes.some((p) => p.includes('app.css')), panes);
  check('B\'s edit is still in the replay strip', (await q(`return [...r.querySelectorAll('.tchip .f')].map((x) => x.textContent)`)).includes('app.css'));

  // A edits: plays, labelled A.
  await edit('src/App.jsx', 'agA', "'312'", "'313'");
  await playing();
  panes = await shown();
  check('A\'s edit plays', panes[panes.length - 1].startsWith('src/App.jsx'), panes);
  await page.screenshot({ path: path.join(outDir, 'follow-1-agent.png') });

  // Follow latest: B reads, the view jumps to it.
  await q(`[...r.querySelectorAll('.fchip')].find((b) => b.textContent === 'Follow latest').click(); return true;`);
  await chat({ role: 'agent-step', agentId: 'agB', toolUseId: 'tuB', agentType: 'general-purpose', kind: 'tool', tool: 'Read', summary: 'index.html', file: file('index.html'), line: 1, end: 3, op: 'read' });
  await playing();
  panes = await shown();
  check('Follow latest jumps to B', panes.some((p) => p.startsWith('index.html') && p.includes('@Tidy')), panes);
  await q(`[...r.querySelectorAll('.fchip')].find((b) => b.textContent === 'All agents').click(); return true;`);

  // Layout: split view at Windows-like sizes, normal and large text.
  for (const [w, h] of [[1536, 735], [1280, 600], [1100, 460]]) {
    await page.setViewportSize({ width: w, height: h });
    for (const size of ['m', 'l']) {
      await q(`r.querySelector('.dock').setAttribute('data-size', '${size}'); window.dispatchEvent(new Event('resize')); return true;`);
      if ((await q(`return r.querySelector('.panes').getAttribute('data-layout')`)) !== 'split') await q(`r.querySelector('.dhead .icon').click(); return true;`);
      await page.waitForTimeout(300);
      const m = await q(`const t = r.querySelector('.timeline').getBoundingClientRect(); const panes = [...r.querySelectorAll('.pane.on')].map((p) => Math.round(p.getBoundingClientRect().height)); return { bottom: Math.round(t.bottom), vh: innerHeight, panes };`);
      check(`${w}x${h} text ${size}: replay strip visible, panes readable`, m.bottom <= m.vh && m.panes.every((x) => x >= 150), m);
    }
    await page.screenshot({ path: path.join(outDir, `follow-split-${w}x${h}.png`) });
  }
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
