#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5209';
// Reading space and full screen, without Claude: with subagents, a team board claim and long status
// text, the panel leaves most of its height to the conversation; the header buttons fit; agent chips
// only in the Agents tab; a claim appears once; the code view header wraps "Replaying…"; both panels
// go full screen and back, also popped out.
//
//   NODE_PATH=$(npm root -g) node test/space-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent, postJson } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'space-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: space-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `space-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: siteDir, ts: Date.now(), backlog: false, ...ev });

(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, colorScheme: 'dark' });
  const page = await context.newPage();
  // The quick tour shows once, the first time; this measures the panel after it.
  await context.addInitScript(() => localStorage.setItem('editlens.tourDone', '1'));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);

  for (const [id, d] of [['t1', 'Subagent'], ['t2', 'Build Integrations page'], ['t3', 'Build Help page']]) {
    await chat({ role: 'agent-start', toolUseId: id, description: d, agentType: 'general-purpose', prompt: '' });
  }
  await chat({ role: 'assistant', text: 'Working on the Integrations and Help pages with two subagents.' });
  await postEvent({ type: 'state', state: 'working', sessionId: SESSION, cwd: siteDir, ts: Date.now() });
  await chat({ role: 'tool', kind: 'tool', tool: 'Edit', summary: 'src\\pages\\Help.jsx', intent: 'Editing src\\pages\\Help.jsx' });
  await postJson('/board', { tool: 'claim_task', projectDir: siteDir, args: { task: 'Create src/pages/Integrations.jsx with integration list, state management, and segmented filter', files: ['src/pages/Integrations.jsx'] } });
  await page.waitForTimeout(800);

  const m = await q(`
    const p = r.querySelector('.panel').getBoundingClientRect();
    const f = r.querySelector('.feed').getBoundingClientRect();
    const tools = [...r.querySelectorAll('.head .tools button')].map((b) => b.getBoundingClientRect().right);
    return { panel: Math.round(p.height), feed: Math.round(f.height), right: Math.round(p.right), toolsRight: Math.round(Math.max(...tools)),
      title: r.querySelector('.head .title').getBoundingClientRect().height, chipsShown: r.querySelector('.agents').offsetHeight > 0,
      badge: r.querySelector('.filters [data-f=agents] .nb').textContent };`);
  check('the conversation gets most of the panel', m.feed / m.panel > 0.62, m);
  check('header buttons fit inside the panel', m.toolsRight <= m.right, m);
  check('agent chips stay in the Agents tab; the tab counts running agents', !m.chipsShown && m.badge === '3', m);
  await page.screenshot({ path: path.join(outDir, 'space-1-all.png') });
  await q(`r.querySelector('.filters [data-f=agents]').click(); return true;`);
  await page.waitForTimeout(200);
  check('Agents tab shows the chips', await q(`return r.querySelector('.agents').offsetHeight > 0`));

  await q(`r.querySelector('.filters [data-f=team]').click(); return true;`);
  await page.waitForTimeout(400);
  const team = await q(`return { chips: [...r.querySelectorAll('.claims .claim')].map((c) => c.textContent), inList: [...r.querySelectorAll('.tfeed .post')].filter((p) => p.textContent.includes('segmented filter')).length, chipText: r.querySelector('.claims').textContent.includes('segmented filter') };`);
  check('a claim shows once: a chip on top, full text in the list', team.chips.length === 1 && team.inList === 1 && !team.chipText, team);
  await page.screenshot({ path: path.join(outDir, 'space-2-team.png') });
  await q(`r.querySelector('.filters [data-f=all]').click(); return true;`);

  // The menu has text size and highlights.
  await q(`r.querySelector('.head .tools [aria-haspopup]').click(); return true;`);
  const items = await q(`return [...r.querySelectorAll('.lmenu button')].map((b) => b.textContent)`);
  check('menu: text size, highlights, full screen', ['Small text', 'Medium text', 'Large text', 'Highlight changes on the page', 'Full screen'].every((x) => items.includes(x)), items);
  await q(`[...r.querySelectorAll('.lmenu button')].find((b) => b.textContent === 'Large text').click(); return true;`);
  check('Large text applies', (await q(`return r.querySelector('.panel').getAttribute('data-size')`)) === 'l');
  await q(`r.querySelector('.head .tools [aria-haspopup]').click(); [...r.querySelectorAll('.lmenu button')].find((b) => b.textContent === 'Medium text').click(); return true;`);

  // Full screen: the panel, then the code view.
  await q(`r.querySelector('.head .tools [title="Full screen"]').click(); return true;`);
  await page.waitForTimeout(500);
  let fs1 = await q(`const p = r.querySelector('.panel').getBoundingClientRect(); return { el: r.fullscreenElement ? r.fullscreenElement.className : null, w: Math.round(p.width), h: Math.round(p.height), vw: innerWidth, vh: innerHeight };`);
  check('panel full screen', fs1.el && fs1.el.includes('panel') && fs1.w === fs1.vw && fs1.h === fs1.vh, fs1);
  await page.screenshot({ path: path.join(outDir, 'space-3-full.png') });
  await q(`r.querySelector('.head .tools [aria-pressed=true][title^="Exit full screen"]').click(); return true;`);
  await page.waitForTimeout(400);
  check('and back', !(await q(`return r.fullscreenElement`)));

  const appFile = path.join(siteDir, 'src', 'App.jsx');
  await postEvent({ type: 'code', file: appFile, relFile: 'src/App.jsx', content: fs.readFileSync(appFile, 'utf8'), line: 1, endLine: 5, cwd: siteDir, note: null, ts: Date.now() });
  await page.waitForFunction(`${ROOT}.querySelectorAll('.pane .cl').length > 3`, null, { timeout: 8000 });
  // A narrow code view with "Replaying…" text: the text wraps under the title.
  await q(`const d = r.querySelector('.dock'); d.style.width = '484px'; r.querySelector('.dqueue').textContent = 'Replaying Help.jsx'; return true;`);
  await page.waitForTimeout(300);
  const dq = await q(`const b = r.querySelector('.dqueue').getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) };`);
  check('code view header: "Replaying…" stays readable when narrow', dq.w > 100 && dq.h < 40, dq);
  await page.screenshot({ path: path.join(outDir, 'space-4-dock-narrow.png') });
  await q(`r.querySelector('.dhead [title="Full screen"]').click(); return true;`);
  await page.waitForTimeout(500);
  fs1 = await q(`const p = r.querySelector('.dock').getBoundingClientRect(); return { el: r.fullscreenElement ? r.fullscreenElement.className : null, w: Math.round(p.width), vw: innerWidth };`);
  check('code view full screen', fs1.el && fs1.el.includes('dock') && fs1.w === fs1.vw, fs1);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate('document.exitFullscreen && document.fullscreenElement && document.exitFullscreen()');
  await page.waitForTimeout(300);

  // Popped out: the button is there and works in that window.
  await q(`r.querySelector('.head .tools [aria-haspopup]').click(); return true;`);
  const [popup] = await Promise.all([
    context.waitForEvent('page', { timeout: 5000 }),
    q(`[...r.querySelectorAll('.lmenu button')].find((x) => x.textContent === 'Open in new window').click(); return true;`),
  ]);
  await page.waitForTimeout(500);
  const P = 'document.querySelector("edit-lens").shadowRoot';
  await popup.evaluate(`${P}.querySelector('.head .tools [title="Full screen"]').click()`);
  await popup.waitForTimeout(600);
  // Full screen where the window allows it, else the window grows to the whole screen (this
  // headless browser allows neither for pop-ups, so only the button's state is checked here).
  const pf = await popup.evaluate(`(() => { const r = ${P}; const b = r.querySelector('.head .tools [title^="Exit full screen"]'); return { el: r.fullscreenElement ? r.fullscreenElement.className : null, pressed: b ? b.getAttribute('aria-pressed') : null }; })()`);
  check('popped-out panel: full screen (or whole-screen window)', pf.pressed === 'true', pf);
  await popup.evaluate(`${P}.querySelector('.head .tools [title^="Exit full screen"]').click()`);
  check('and back', await popup.evaluate(`Boolean(${P}.querySelector('.head .tools [title="Full screen"]'))`));
  await popup.close();
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
