'use strict';
require('./isolate');
// The selection bar ("App.jsx:3 · not on this page") never covers the Agents switcher. In a 480px-wide
// window with the panel open there is no room beside the panel, so the bar moves above it; before
// 0.24.47 it went onto the switcher's bottom row, whose buttons could not be clicked (command check 0.24.46).
// usage: NODE_PATH=$(npm root -g) node test/selbar-switcher-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: selbar-switcher-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-selbar-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5380', CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Orbit</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:40px}</style></head>
<body><main><h1>Overview</h1><p>Active users 12,480</p></main>
<script src="http://127.0.0.1:5380/live.js" data-root="${proj}" data-panel="open" data-settle="300"></script></body></html>`;

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), canListen: false });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const browser = await launch(chromium);
  // Each case: the window it opens at, the width it is narrowed to (or null), and whether the code view
  // is opened first from a subagent's row. Closing it at 480px left the bar on the switcher (check 0.24.47).
  const cases = [['opens at 480px', 480, null], ['opens at 1366px', 1366, null], ['narrowed from 1366px to 480px', 1366, 480],
    ['480px, code view opened then closed', 480, null, true]];
  let n = 0;
  try {
    for (const [label, width, narrowTo, openCode] of cases) {
      n++;
      const ctx = await browser.newContext({ viewport: { width, height: 760 } });
      await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(`http://127.0.0.1:${site.address().port}/`);
      await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.status.idle, .status.stopped, .status.working')`);
      const q = (js) => page.evaluate(`(() => { const r = ${ROOT}; ${js} })()`);
      // Two subagents (the switcher shows), then an edit of a file this page does not show.
      for (const [id, d] of [[`a${n}`, 'Build Integrations page with the segmented filter'], [`b${n}`, 'Build Help page with FAQ search']]) {
        await postEvent({ type: 'chat', role: 'agent-start', sessionId: 's1', cwd: proj, ts: Date.now(), backlog: false, toolUseId: id, description: d, agentType: 'general-purpose', prompt: '' });
      }
      const file = path.join(proj, 'src', 'App.jsx');
      const before = `export default function App() {\n  return <p>Signups ${300 + n}</p>;\n}\n`;
      await postEvent({ type: 'change', kind: 'frontend', tool: 'Edit', sessionId: 's1', cwd: proj, file, relFile: 'src/App.jsx', ts: Date.now(), agentId: 'ag1',
        agentType: 'general-purpose', before, after: before.replace(String(300 + n), String(400 + n)), stats: { added: 1, removed: 1 }, hints: {},
        hunks: [{ oldStart: 2, newStart: 2, lines: [`-  return <p>Signups ${300 + n}</p>;`, `+  return <p>Signups ${400 + n}</p>;`] }] });
      // Opening the edit's card selects it: its code is not on this page, so the bar says so.
      await page.waitForFunction(`${ROOT}.querySelectorAll('.k-edit').length >= ${n}`, null, { timeout: 10000 });
      await q(`const c = [...r.querySelectorAll('.k-edit')].pop(); c.click(); return true;`);
      await sleep(500);
      if (openCode) {
        // As in the command check: a click on a subagent's row opens the code view.
        await page.waitForFunction(`${ROOT}.querySelector('.asw.on .arow[data-key="a${n}"]')`, null, { timeout: 10000 });
        await q(`r.querySelector('.asw .arow[data-key="a${n}"]').click(); return true;`);
        await page.waitForFunction(`${ROOT}.querySelector('[aria-label="Close the code view"]')?.offsetParent`, null, { timeout: 10000 });
        await sleep(400);
      }
      // The code view this opens on a wide window is closed, as in the command check.
      await q(`const b = r.querySelector('[aria-label="Close the code view"]'); if (b && b.offsetParent) b.click(); return true;`);
      if (narrowTo) {
        await page.setViewportSize({ width: narrowTo, height: 760 });
        await sleep(400);
      }
      const shown = await page.waitForFunction(`${ROOT}.querySelector('.asw.on') && ${ROOT}.querySelector('.selbar.on')`, null, { timeout: 10000 }).then(() => true, (err) => {
        if (err.name !== 'TimeoutError') throw err;
        return false;
      });
      check(`${label}: the Agents switcher and the selection bar both show`, shown);
      await sleep(600);
      const g = await q(`const box = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
        const sw = r.querySelector('.asw'), bar = r.querySelector('.selbar'), panel = r.querySelector('.panel'), body = sw.querySelector('.swbody').getBoundingClientRect();
        // What a click at the middle of each agent row and switcher button (the visible ones) would click.
        const hits = [...sw.querySelectorAll('.arow, button')].filter((b) => b.offsetParent).map((b) => { const x = b.getBoundingClientRect();
          const cy = x.top + x.height / 2; if (b.closest('.swbody') && (cy < body.top || cy > body.bottom)) return null;
          const at = r.elementFromPoint(x.left + x.width / 2, cy); return { label: (b.textContent || b.title || '').trim().slice(0, 30), ok: Boolean(at && sw.contains(at)) }; }).filter(Boolean);
        return { sw: box(sw), bar: box(bar), panel: box(panel), hits, vh: innerHeight, vw: innerWidth };`);
      const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
      check(`${label}: the selection bar is not over the Agents switcher`, apart(g.bar, g.sw), { bar: g.bar, switcher: g.sw });
      check(`${label}: every agent row and switcher button can be clicked`, g.hits.length > 1 && g.hits.every((h) => h.ok), g.hits);
      check(`${label}: the selection bar is not over the panel and stays in the window`, apart(g.bar, g.panel) && g.bar.top >= 0 && g.bar.bottom <= g.vh && g.bar.left >= 0 && g.bar.right <= g.vw,
        { bar: g.bar, panel: g.panel });
      await page.screenshot({ path: path.join(outDir, `selbar-${n}.png`) });
      if (openCode) {
        // Its list closed, then opened again: the bar follows the switcher's height each time.
        for (const state of ['closed', 'open']) {
          await q(`r.querySelector('.asw .swhead').click(); return true;`);
          await sleep(700);
          const k = await q(`const box = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; };
            return { sw: box(r.querySelector('.asw')), bar: box(r.querySelector('.selbar')), open: r.querySelector('.asw').classList.contains('open') };`);
          check(`${label}: list ${state}, the selection bar is not over the Agents switcher`, k.open === (state === 'open') && apart(k.bar, k.sw), k);
        }
      }
      check(`${label}: no page errors`, errors.length === 0, errors);
      await ctx.close();
    }
  } finally {
    await browser.close();
    await new Promise((r) => site.close(r));
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
  else console.log('all ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
