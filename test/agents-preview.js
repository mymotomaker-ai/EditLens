#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4952';
// The Agents switcher, without Claude: scripted subagents and, for Stop and the mode, page control
// with a stand-in claude and SDK (test/fixtures). Checks the rows, switching, actions, keyboard, drag
// and moving to the edge, the position when the panel is popped out, and a 480px window.
//
//   NODE_PATH=$(npm root -g) node test/agents-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'agents-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: agents-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-agents-preview-'));
const state = path.join(tmp, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(tmp, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
fs.mkdirSync(path.join(tmp, 'bin'));
const exe = path.join(tmp, 'bin', 'claude');
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
Object.assign(process.env, { EDITLENS_SDK_DIR: path.join(tmp, 'sdk'), EDITLENS_CLAUDE_PATH: exe, FAKE_CLAUDE_STATE: state });

const app = fs.existsSync(path.join(siteDir, 'src', 'App.jsx')) ? path.join(siteDir, 'src', 'App.jsx') : path.join(siteDir, 'index.html');
const chat = (role, extra) => postEvent({ type: 'chat', role, cwd: siteDir, ts: Date.now(), ...extra });

// Text that wraps one letter per line, or anything past the window's right edge.
const AUDIT = `
  const out = { slivers: [], past: [] };
  const vw = r.host ? innerWidth : innerWidth;
  r.querySelectorAll('.asw *').forEach((n) => {
    const b = n.getBoundingClientRect();
    if (!b.width || !b.height) return;
    const cs = getComputedStyle(n);
    if (cs.visibility === 'hidden' || cs.display === 'none') return;
    const own = [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join('').trim();
    const lh = [parseFloat(cs.lineHeight), parseFloat(cs.fontSize) * 1.3].find((v) => Number.isFinite(v) && v > 0) || 16;
    if (own.length >= 4 && b.width < lh * 3 && b.height > lh * 3.2) out.slivers.push([own.slice(0, 20), Math.round(b.width), Math.round(b.height)]);
    if (b.right > vw + 1 || b.left < -1) out.past.push([n.className || n.tagName, Math.round(b.left), Math.round(b.right)]);
  });
  return out;`;

// The steps; the caller stops the browser and the server even when a step fails.
let browser = null;
async function steps() {
  await stopServer();
  await ensureServer();
  browser = await launchOwnPort(chromium);
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 }, permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.evaluate(() => { localStorage.removeItem('editlens.layout'); localStorage.removeItem('editlens.agentsOpen'); });
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  await page.waitForTimeout(800);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const settle = (ms = 450) => page.waitForTimeout(ms);
  const sw = () => q(`const s = r.querySelector('.asw'); const b = s.getBoundingClientRect(); return { on: s.classList.contains('on'), open: s.classList.contains('open'), l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom), count: s.querySelector('.swn').textContent, rows: [...s.querySelectorAll('.arow')].map((x) => x.querySelector('b').textContent) };`);
  const panelBox = () => q(`const b = r.querySelector('.panel').getBoundingClientRect(); return { l: Math.round(b.left), r: Math.round(b.right), t: Math.round(b.top), b: Math.round(b.bottom) };`);

  check('hidden while there are no subagents', !(await sw()).on);

  // Two subagents at work.
  await chat('agent-start', { toolUseId: 'toolu_A', agentType: 'general-purpose', description: 'Restyle the stat cards', prompt: 'Make the stat cards use the brand colors.' });
  await chat('agent-start', { toolUseId: 'toolu_B', agentType: 'Explore', description: 'Find the chart code', prompt: 'Where is the chart drawn?' });
  await chat('agent-step', { agentId: 'aaaa1111', toolUseId: 'toolu_A', kind: 'tool', tool: 'Read', summary: 'src/App.jsx', file: app, line: 3 });
  await chat('agent-step', { agentId: 'bbbb2222', toolUseId: 'toolu_B', kind: 'tool', tool: 'Grep', summary: 'chart' });
  await settle(900);
  let s = await sw();
  const p = await panelBox();
  check('appears with two subagents, open, Main first', s.on && s.open && JSON.stringify(s.rows) === JSON.stringify(['Main', 'Restyle the stat cards', 'Find the chart code']), s);
  check('sits beside the panel, bottoms lined up', s.r <= p.l - 6 && s.r >= p.l - 20 && Math.abs(s.b - p.b) <= 2, [s, p]);
  check('counts the running subagents', s.count === '2', s.count);
  const row = await q(`const x = [...r.querySelectorAll('.arow')][1]; return { step: x.querySelector('.rs').textContent, file: x.querySelector('.rf') && x.querySelector('.rf').textContent, time: x.querySelector('.swtime').textContent, run: x.classList.contains('run') };`);
  check('a row shows its step, file and time', /Read/.test(row.step) && /App\.jsx:3$/.test(row.file || '') && /^\d+s$/.test(row.time) && row.run, row);
  await page.screenshot({ path: path.join(outDir, 'agents-1-open.png') });

  // Details: model and tokens from the subagent's transcript, its edits, its claims.
  await chat('agent-step', { agentId: 'aaaa1111', toolUseId: 'toolu_A', kind: 'text', text: 'The cards now use the brand colors.', model: 'claude-sonnet-5-5', msgId: 'msg_1', ctx: 34000, out: 1200 });
  await postEvent({ type: 'change', agentId: 'aaaa1111', toolUseId: 'toolu_edit1', file: app, relFile: path.relative(siteDir, app), cwd: siteDir, kind: 'frontend', tool: 'Edit', stats: { added: 2, removed: 1 }, hunks: [], ts: Date.now() });
  await settle(700);
  const meta = await q(`return [...r.querySelectorAll('.arow')].map((x) => x.querySelector('.rmeta').textContent)`);
  check('each row has a status line; a subagent adds model, tool calls and files changed', /^(Idle|Working)$/.test(meta[0]) && /^Working · Sonnet 5\.5 · 1 tool call · 1 file changed$/.test(meta[1]), meta);
  await q(`[...r.querySelectorAll('.arow')][1].click(); return true;`);
  await settle();
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Details').click(); return true;`);
  await settle();
  const det = await q(`const d = r.querySelector('.arow.act .rdet'); if (!d) return null; const o = {}; const dts = d.querySelectorAll('dt'); d.querySelectorAll('dd').forEach((x, i) => { o[dts[i].textContent] = x.textContent; }); return o;`);
  check('Details lists everything', det && det.Status === 'Working' && det.Type === 'general-purpose' && det.Model === 'Sonnet 5.5' && /^Ask|^—/.test(det['Permission mode']) && /^\d+s$/.test(det['Running for']) &&
    /App\.jsx:3$/.test(det['Current file']) && det['Tool calls'] === '1' && /App\.jsx  ×1$/.test(det['Files changed']) && det.Tokens === 'context 34K · 1.2K written' &&
    det['Team claims'] === '—' && det.Task === 'Make the stat cards use the brand colors.' && det['Last message'] === 'The cards now use the brand colors.', det);
  check('never NaN, undefined or blank', det && Object.values(det).every((v) => v && !/NaN|undefined|null/.test(v)), det);
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Hide details').click(); return true;`);
  await settle();
  await q(`r.querySelector('.arow').click(); return true;`);
  await settle();
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Details').click(); return true;`);
  await settle();
  const mdet = await q(`const d = r.querySelector('.arow.act .rdet'); return d ? [...d.querySelectorAll('dd')].map((x) => x.textContent) : null;`);
  check('Main has details too, with — where nothing is known', mdet && mdet.length >= 9 && mdet.every((v) => v && !/NaN|undefined|null/.test(v)) && mdet.includes('—'), mdet);
  await page.screenshot({ path: path.join(outDir, 'agents-1b-details.png') });
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Hide details').click(); return true;`);
  await settle();

  // Switch by clicking a row.
  await q(`[...r.querySelectorAll('.arow')][1].click(); return true;`);
  await settle(700);
  const followed = await q(`return { on: [...r.querySelectorAll('.arow.on')].map((x) => x.querySelector('b').textContent), chip: [...r.querySelectorAll('.follow .fchip.on')].map((x) => x.textContent), dock: r.querySelector('.dock').classList.contains('on'), acts: [...r.querySelectorAll('.arow.act .ra button')].map((b) => b.textContent) };`);
  check('a click switches to it: followed in the code view', JSON.stringify(followed.on) === '["Restyle the stat cards"]' && followed.chip.some((t) => /Restyle/.test(t)) && followed.dock, followed);
  check('its actions show', JSON.stringify(followed.acts) === JSON.stringify(['Details', 'Open file', 'Show on page', 'Only this', 'Team posts', 'Mode', 'Pin', 'Copy summary']), followed.acts);
  await page.screenshot({ path: path.join(outDir, 'agents-2-switched.png') });

  // Only this: the feed shows that agent's card only.
  await chat('assistant', { text: 'Main agent says hello.' });
  await settle();
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Only this').click(); return true;`);
  await settle();
  const only = await q(`return { bar: r.querySelector('.ofbar').textContent, shown: [...r.querySelectorAll('.feed > li:not(.oh)')].map((li) => li.className.split(' ')[0]), hidden: r.querySelectorAll('.feed > li.oh').length };`);
  check('Only this: just its card and its edit, the rest hidden, a bar says so', /Showing only Restyle the stat cards/.test(only.bar) && JSON.stringify(only.shown) === '["k-agent","k-edit"]' && only.hidden >= 2, only);
  await q(`r.querySelector('.ofbar button').click(); return true;`);
  await settle();
  check('Show everyone shows everything again', (await q(`return r.querySelectorAll('.feed > li.oh').length`)) === 0);

  // Pin, then it stays listed and moves up.
  await q(`[...r.querySelectorAll('.arow')][2].click(); return true;`);
  await settle();
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Pin').click(); return true;`);
  await settle();
  s = await sw();
  check('Pin moves it to the top, under Main', s.rows[1] === 'Find the chart code', s.rows);
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Copy summary').click(); return true;`);
  await settle();
  const copied = await page.evaluate(() => navigator.clipboard.readText()).catch(() => '');
  check('Copy summary copies its task and status', /^Find the chart code \(Explore\)\nStatus: running/.test(copied) && /Task: Where is the chart drawn\?/.test(copied), copied);
  await chat('agent-done', { toolUseId: 'toolu_B', agentId: 'bbbb2222', status: 'completed', text: 'The chart is in src/Chart.jsx.', toolCount: 3, durationMs: 4000 });
  await settle();
  s = await sw();
  check('a finished, pinned agent stays; the count decreases', s.rows.includes('Find the chart code') && s.count === '1', s);

  // Keyboard.
  await page.keyboard.press('Alt+Shift+]');
  await settle();
  const kb1 = await q(`return [...r.querySelectorAll('.arow.on')].map((x) => x.querySelector('b').textContent)`);
  await page.keyboard.press('Alt+Shift+[');
  await settle();
  const kb2 = await q(`return [...r.querySelectorAll('.arow.on')].map((x) => x.querySelector('b').textContent)`);
  check('Alt+Shift+] and [ switch to the next and previous agent', kb1.length === 1 && kb2.length === 1 && kb1[0] !== kb2[0], [kb1, kb2]);
  await q(`r.querySelector('.arow').focus(); return true;`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await settle();
  check('arrows and Enter switch from the list', (await q(`return r.activeElement && r.activeElement.closest('.arow') && r.activeElement.closest('.arow').classList.contains('on')`)) === true);
  await page.keyboard.press('Escape');
  await settle();
  s = await sw();
  check('Esc collapses it to a pill with the count', s.on && !s.open && s.count === '1' && s.b - s.t < 60, s);
  await page.screenshot({ path: path.join(outDir, 'agents-3-collapsed.png') });
  await page.keyboard.press('Alt+Shift+A');
  await settle();
  check('Alt+Shift+A opens it again', (await sw()).open);

  // Drag, move to the edge, saved, Reset.
  const head = await q(`const b = r.querySelector('.swhead').getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 };`);
  await page.mouse.move(head.x, head.y);
  await page.mouse.down();
  await page.mouse.move(head.x - 200, head.y - 100, { steps: 6 });
  await page.mouse.move(14, 805, { steps: 8 });
  await page.mouse.up();
  await settle();
  s = await sw();
  check('dragged to the bottom-left, it moves to the edges', s.l === 20 && 820 - s.b === 20 && s.open, s);
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('editlens.layout') || '{}').agents);
  check('the position is saved with the layout', saved && saved.x === 20 && saved.b === 20, saved);
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.asw.on')`, null, { timeout: 8000 }).catch(onTimeout(null));
  await settle(700);
  s = await sw();
  check('after a reload it is where it was', s.on && s.l === 20 && 820 - s.b === 20, s);
  await q(`r.querySelector('.panel .head button[aria-haspopup=menu]').click(); return true;`);
  await settle();
  await q(`[...r.querySelectorAll('.lmenu button')].find((b) => b.textContent === 'Reset layout').click(); return true;`);
  await settle();
  s = await sw();
  const p2 = await panelBox();
  check('Reset layout puts it back beside the panel', Math.abs(s.b - p2.b) <= 2 && s.r < p2.l, [s, p2]);

  // Panel minimized: bottom-left of the page.
  await q(`r.querySelector('.panel .head button[title^="Minimize"]').click(); return true;`);
  await settle();
  s = await sw();
  check("panel minimized: it moves to the page's bottom-left corner", s.l <= 24 && 820 - s.b <= 24, s);
  await q(`r.querySelector('.pill').click(); return true;`);
  await settle();

  // Page control: Mode and Stop.
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'drive.js'), 'new'], { cwd: siteDir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: siteDir } });
  if (out.status !== 0) console.log((out.stdout + out.stderr).trim());
  await page.waitForFunction(`${ROOT}.querySelector('.pmode.on:not(.ro)')`, null, { timeout: 15000 }).catch(onTimeout(null));
  await q(`const t = r.querySelector('.composer textarea'); t.value = 'spawn cccc3333 toolu_C'; t.dispatchEvent(new Event('input')); r.querySelector('.send').click(); return true;`);
  await chat('agent-start', { toolUseId: 'toolu_C', agentId: 'cccc3333', agentType: 'general-purpose', description: 'Write the tests' });
  await settle(900);
  await q(`[...r.querySelectorAll('.arow')].find((x) => x.querySelector('b').textContent === 'Write the tests').click(); return true;`);
  await settle();
  const acts = await q(`return [...r.querySelectorAll('.arow.act .ra button')].map((b) => b.textContent)`);
  check('page control adds Stop', acts.includes('Stop') && acts.includes('Mode') && acts[0] === 'Details', acts);
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Mode').click(); return true;`);
  await settle();
  check('Mode opens the mode menu for that subagent', /Mode for Write the tests/.test(await q(`const h = r.querySelector('.mwrap .lh'); return h ? h.textContent : ''`)));
  await page.keyboard.press('Escape');
  await settle();
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Stop').click(); return true;`);
  await settle();
  check('Stop asks for a second click first', (await q(`return [...r.querySelectorAll('.arow.act .ra button')].map((b) => b.textContent)`)).includes('Stop it?') && !fs.existsSync(path.join(state, 'stopped')));
  await page.screenshot({ path: path.join(outDir, 'agents-4-stop.png') });
  await q(`[...r.querySelectorAll('.arow.act .ra button')].find((b) => b.textContent === 'Stop it?').click(); return true;`);
  await settle(800);
  check('the second click stops that subagent only', fs.existsSync(path.join(state, 'stopped')) && fs.readFileSync(path.join(state, 'stopped'), 'utf8') === 'cccc3333\n');

  // Narrow window.
  await page.setViewportSize({ width: 480, height: 820 });
  await settle(700);
  let audit = await q(AUDIT);
  s = await sw();
  const p3 = await panelBox();
  check('480px: above the panel, inside the window', s.b <= p3.t && s.l >= 0 && s.r <= 480, [s, p3]);
  check('480px: no letter-by-letter text, nothing past the edge', !audit.slivers.length && !audit.past.length, audit);
  await page.screenshot({ path: path.join(outDir, 'agents-5-narrow.png') });
  await page.keyboard.press('Alt+Shift+A');
  await settle();
  audit = await q(AUDIT);
  s = await sw();
  check('480px collapsed: fine too', !s.open && !audit.slivers.length && !audit.past.length, audit);
}

(async () => {
  try {
    await steps();
  } finally {
    if (browser) await browser.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
