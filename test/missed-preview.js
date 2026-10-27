'use strict';
require('./isolate');
// Edits made while the page was closed: when it opens again, a notice says how many and from where,
// and Play plays them in order in the code view. Edits the page already played are not counted.
// usage: node test/missed-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: missed-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-missed-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '4988' });
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
let n = 0;
function edit(name) {
  n++;
  const before = `export const v${n} = 0;\n`;
  const after = `export const v${n} = 1;\n`;
  return postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, 'src', name), relFile: `src/${name}`, tool: 'Edit', intent: `Change ${name}`,
    before, after, hunks: [{ oldStart: 1, newStart: 1, lines: [`-${before.trim()}`, `+${after.trim()}`] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
}

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>App</title><body style="font:16px system-ui;margin:40px"><h1>App</h1>
<script src="http://127.0.0.1:4988/live.js" data-root="${proj}" data-panel="open"></script></body>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const errors = [];
    let page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    await edit('Seen.jsx'); // played live
    await sleep(1500);
    check('no notice for an edit played live', !(await page.evaluate(`${ROOT}.querySelector('.k-missed')`)));
    await page.close();

    for (const f of ['A.jsx', 'B.jsx', 'C.jsx']) await edit(f);
    page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.k-missed')`, null, { timeout: 10000 });
    const text = await page.evaluate(`${ROOT}.querySelector('.k-missed').textContent`);
    check('the notice counts the 3 missed edits and names them', /3 edits from Claude here while this page was closed/.test(text) && /src\/A\.jsx, src\/B\.jsx, src\/C\.jsx/.test(text) && !/Seen/.test(text), text);
    await page.screenshot({ path: path.join(outDir, 'missed-notice.png') });
    await page.evaluate(`${ROOT}.querySelector('.k-missed .play').click()`);
    const playing = await page.waitForFunction(`(() => { const t = ${ROOT}.textContent; return /Playing A\\.jsx/.test(t) && /2 more waiting/.test(t); })()`, null, { timeout: 8000 }).then(() => true, onTimeout(false));
    check('Play plays them in order in the code view', playing, await page.evaluate(`${ROOT}.querySelector('.dock') && ${ROOT}.querySelector('.dock').textContent.slice(0, 200)`));
    check('the notice goes', !(await page.evaluate(`${ROOT}.querySelector('.k-missed')`)));
    const dot = await page.evaluate(`(() => { const d = ${ROOT}.querySelector('.dqueue .qdot'); return d ? getComputedStyle(d).animationName : null; })()`);
    check('a dot pulses next to the label while the edit plays', dot === 'qpulse', dot);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const still = await page.evaluate(`(() => { const d = ${ROOT}.querySelector('.dqueue .qdot'); return d ? getComputedStyle(d).animationName : null; })()`);
    check('no pulse when the computer asks for less motion', still === 'none', still);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.evaluate(`${ROOT}.querySelector('.dock .capsule button[aria-label="Pause playback"]').click()`);
    await sleep(150);
    check('Pause stops the pulse', await page.evaluate(`!${ROOT}.querySelector('.dqueue .qdot') && /Paused/.test(${ROOT}.querySelector('.dqueue').textContent)`));
    await page.evaluate(`${ROOT}.querySelector('.dock .capsule button[aria-label*="playback"]').click()`);
    await sleep(600);
    await page.screenshot({ path: path.join(outDir, 'missed-playing.png') });
    await page.close();

    page = await ctx.newPage();
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(1500);
    check('opened again with nothing new: no notice', !(await page.evaluate(`${ROOT}.querySelector('.k-missed')`)));

    // The spinner on the line under the status turns only while Claude works.
    const spinning = () => page.evaluate(`(() => { const s = ${ROOT}.querySelector('.now .spin'); return Boolean(s) && getComputedStyle(s).display !== 'none'; })()`);
    await postEvent({ type: 'prompt', sessionId: 's1', cwd: proj, text: 'go', ts: Date.now() });
    await postEvent({ type: 'pending', sessionId: 's1', cwd: proj, toolUseId: 'tu1', file: path.join(proj, 'src', 'D.jsx'), relFile: 'src/D.jsx', tool: 'Edit', intent: 'Now the stylesheet', ts: Date.now() });
    check('working: the line spins', await page.waitForFunction(`(() => { const s = ${ROOT}.querySelector('.now .spin'); return s && getComputedStyle(s).display !== 'none'; })()`, null, { timeout: 5000 }).then(() => true, onTimeout(false)));
    await postEvent({ type: 'idle', sessionId: 's1', cwd: proj, ts: Date.now() });
    await sleep(1200);
    check('done: the line stops spinning', !(await spinning()), await page.evaluate(`${ROOT}.querySelector('.now').outerHTML`));
    // The line set while working, then Claude's state goes idle another way (no new line): no spin.
    await postEvent({ type: 'prompt', sessionId: 's1', cwd: proj, text: 'again', ts: Date.now() });
    await postEvent({ type: 'pending', sessionId: 's1', cwd: proj, toolUseId: 'tu2', file: path.join(proj, 'src', 'E.jsx'), relFile: 'src/E.jsx', tool: 'Edit', intent: 'done', ts: Date.now() });
    await sleep(600);
    await postEvent({ type: 'end', sessionId: 's1', cwd: proj, reason: 'other', ts: Date.now() });
    await sleep(1500);
    check('Claude Code closed while working: no spin', !(await spinning()), await page.evaluate(`${ROOT}.querySelector('.now').outerHTML + ' ' + ${ROOT}.querySelector('.status').textContent`));
    check('no page errors', !errors.length, errors);
  } finally {
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
