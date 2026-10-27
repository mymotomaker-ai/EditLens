#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4989';
// Permission modes in the panel, without a real Claude (test/fixtures stand-ins): in Manual, Claude
// Code's mode is shown read-only (per subagent too); in page control the mode button and Alt+M
// switch it, Accept edits and Bypass permissions only once confirmed in the EditLens window, a
// subagent can have its own mode, and the menu fits a 480px window.
//
//   NODE_PATH=$(npm root -g) node test/modes-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { answerAll } = require('./answer-helper');

const [siteUrl, siteArg, outDir = 'modes-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: modes-preview.js <site-url> <site-dir> <out-dir>');
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
// A wait that runs out is checked by the next check; any other error stops the run.
function notYet(err) {
  if (!err || err.name !== 'TimeoutError') throw err;
  return null;
}

const tmp =fs.mkdtempSync(path.join(os.tmpdir(), 'editlenss-preview-'));
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
const modesSent = () => (fs.existsSync(path.join(state, 'modes')) ? fs.readFileSync(path.join(state, 'modes'), 'utf8').trim().split('\n') : []);

// The steps; the caller stops the browser and the server even when a step fails.
let browser = null;
async function steps() {
  await stopServer();
  await ensureServer();
  browser = await launchOwnPort(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 820 } })).newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  await page.waitForTimeout(800);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const chip = () => q(`const b = r.querySelector('.pmode'); return b.classList.contains('on') ? { text: b.textContent, ro: b.classList.contains('ro'), mode: b.dataset.mode } : null;`);
  const settle = () => page.waitForTimeout(400);

  // ----- Manual: read-only, from the hooks -----
  check('no mode shown before Claude Code reports one', (await chip()) === null);
  await postEvent({ type: 'mode-ping', sessionId: 'manual-1', cwd: siteDir, permissionMode: 'acceptEdits' });
  await postEvent({ type: 'chat', role: 'agent-start', toolUseId: 'toolu_M1', agentId: 'aM1', agentType: 'general-purpose', description: 'Check the header', cwd: siteDir, ts: Date.now() });
  await postEvent({ type: 'mode-ping', sessionId: 'manual-1', agentId: 'aM1', cwd: siteDir, permissionMode: 'plan' });
  await settle();
  let c = await chip();
  check('Manual: Claude Code\'s mode is shown, read-only', c && c.text === 'Accept edits' && c.ro, c);
  check('Manual: the title says where to change it', /Shift\+Tab; a page can't change/.test(await q(`return r.querySelector('.pmode').title`)));
  const card = () => q(`const b = [...r.querySelectorAll('.k-agent')].pop().querySelector('.amode'); return { text: b.textContent, own: b.classList.contains('own'), ro: b.classList.contains('ro'), shown: b.style.display !== 'none' };`);
  let a = await card();
  check('Manual: a subagent in its own mode says so on its card', a.shown && a.text === 'Plan' && a.own && a.ro, a);
  check('Manual: its Follow chip shows the mode too', (await q(`if (!r.querySelector('.lwrap .follow')) { const h = r.querySelector('.dock .dhead .fhead'); if (h) h.click(); } return [...r.querySelectorAll('.lwrap .follow .fm')].map((x) => x.textContent)`)).includes('Plan'));
  await q(`r.querySelector('.pmode').click(); return true;`);
  check('Manual: clicking the mode explains it, no menu', !(await q(`return r.querySelector('.mwrap')`)) && /Shift\+Tab/.test(await q(`return r.querySelector('.toast').textContent`)));
  await page.screenshot({ path: path.join(outDir, 'modes-1-manual.png') });

  // ----- Page control -----
  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'drive.js'), 'new'], { cwd: siteDir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: siteDir } });
  if (out.status !== 0) console.log((out.stdout + out.stderr).trim());
  await page.waitForFunction(`${ROOT}.querySelector('.pmode.on:not(.ro)')`, null, { timeout: 15000 }).catch(notYet);
  c = await chip();
  check('page control: Claude\'s mode, switchable', c && c.mode === 'default' && /^Ask· Alt\+M$/.test(c.text) && !c.ro, c);
  await q(`r.querySelector('.composer textarea').focus(); return true;`);
  await page.keyboard.press('Alt+KeyM');
  await settle();
  c = await chip();
  check('Alt+M switches to the next mode (Plan; Accept edits needs the window)', c.mode === 'plan' && modesSent().pop() === 'plan', [c, modesSent()]);
  check('focus stays in the message box', await q(`return r.activeElement === r.querySelector('.composer textarea')`));

  await q(`r.querySelector('.pmode').click(); return true;`);
  await settle();
  const items = await q(`return [...r.querySelectorAll('.mwrap .lmenu button')].map((b) => b.querySelector('.mt span').textContent + (b.classList.contains('on') ? ' *' : ''))`);
  check('the menu lists every mode, current one marked', JSON.stringify(items) === JSON.stringify(['Ask', 'Accept edits', 'Plan *', 'Auto', "Don't ask", 'Bypass permissions']), items);
  await page.screenshot({ path: path.join(outDir, 'modes-2-menu.png') });
  // Accept edits from the menu: waits for the EditLens window; Deny there leaves the mode alone.
  await q(`[...r.querySelectorAll('.mwrap .lmenu button')].find((b) => b.textContent.startsWith('Accept edits')).click(); return true;`);
  await settle();
  check('Accept edits waits for the EditLens window', (await chip()).mode === 'plan' && !modesSent().includes('acceptEdits'));
  check('Deny in the window leaves the mode alone', (await answerAll({ kinds: ['mode'], decision: 'deny' })).length === 1 && (await chip()).mode === 'plan');
  await q(`r.querySelector('.pmode').click(); return true;`);
  await settle();
  await q(`[...r.querySelectorAll('.mwrap .lmenu button')].pop().click(); return true;`);
  await settle();
  check('Bypass waits for the EditLens window', (await chip()).mode === 'plan' && !modesSent().includes('bypassPermissions'));
  await answerAll({ kinds: ['mode'] });
  await settle();
  c = await chip();
  // Claude Code refuses Bypass permissions as root (a VPS, this container): the mode stays.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (asRoot) {
    check('as root: Bypass permissions is refused and the mode stays', c.mode === 'plan' && !modesSent().includes('bypassPermissions'), c);
  } else {
    check('confirmed: Bypass permissions is on, in red', c.mode === 'bypassPermissions' && modesSent().pop() === 'bypassPermissions' &&
      (await q(`return getComputedStyle(r.querySelector('.pmode')).color`)) !== (await q(`return getComputedStyle(r.querySelector('.hint')).color`)), c);
  }
  await page.screenshot({ path: path.join(outDir, 'modes-4-bypass-on.png') });
  await q(`r.querySelector('.composer textarea').focus(); return true;`);
  await page.keyboard.press('Alt+KeyM');
  await settle();
  check(asRoot ? 'Alt+M goes from Plan to Auto' : 'Alt+M leaves Bypass for Ask', (await chip()).mode === (asRoot ? 'auto' : 'default'));
  for (let i = 0; i < 3; i++) await page.keyboard.press('Alt+KeyM'), await settle();
  const CYCLE = ['default', 'plan', 'auto'];
  const last = modesSent().slice(-4);
  check('Alt+M cycles Ask, Plan, Auto and never into Accept edits or Bypass', last.length === 4 && last.every((m, i) => i === 0 || CYCLE[(CYCLE.indexOf(last[i - 1]) + 1) % 3] === m), modesSent());
  // Back to Ask for what follows.
  for (let i = 0; i < 3 && (await chip()).mode !== 'default'; i++) await page.keyboard.press('Alt+KeyM'), await settle();

  // A subagent with its own mode.
  await q(`const t = r.querySelector('.composer textarea'); t.value = 'spawn a77 toolu_P1'; t.dispatchEvent(new Event('input')); r.querySelector('.send').click(); return true;`);
  await postEvent({ type: 'chat', role: 'agent-start', toolUseId: 'toolu_P1', agentId: 'a77', agentType: 'general-purpose', description: 'Restyle the cards', cwd: siteDir, ts: Date.now() });
  await settle();
  a = await card();
  check('page control: the card shows the same mode as Claude, changeable', a.shown && a.text === 'Ask' && !a.own && !a.ro, a);
  await q(`[...r.querySelectorAll('.k-agent')].pop().querySelector('.amode').click(); return true;`);
  await settle();
  const agentItems = await q(`return [...r.querySelectorAll('.mwrap .lmenu button')].map((b) => b.querySelector('.mt span').textContent)`);
  check('the card menu offers Same as Claude plus Ask, Accept edits, Plan, Bypass', JSON.stringify(agentItems) === JSON.stringify(['Same as Claude (Ask)', 'Ask', 'Accept edits', 'Plan', 'Bypass permissions']), agentItems);
  check('it names the subagent', /Mode for Restyle the cards/.test(await q(`return r.querySelector('.mwrap .lh').textContent`)));
  await q(`[...r.querySelectorAll('.mwrap .lmenu button')].find((b) => b.textContent.startsWith('Plan')).click(); return true;`);
  await settle();
  a = await card();
  check('the subagent is in Plan, Claude still in Ask', a.text === 'Plan' && a.own && (await chip()).mode === 'default', a);
  check('its Follow chip says Plan', (await q(`if (!r.querySelector('.lwrap .follow')) { const h = r.querySelector('.dock .dhead .fhead'); if (h) h.click(); } return [...r.querySelectorAll('.lwrap .follow .fm')].map((x) => x.textContent)`)).includes('Plan'));
  await page.screenshot({ path: path.join(outDir, 'modes-5-agent.png') });

  // Narrow window: the menu fits.
  await page.setViewportSize({ width: 480, height: 760 });
  await settle();
  await q(`r.querySelector('.pmode').click(); return true;`);
  await settle();
  const fit = await q(`const m = r.querySelector('.mwrap .lmenu').getBoundingClientRect(); return { l: m.left, r: m.right, t: m.top, b: m.bottom, w: innerWidth, h: innerHeight };`);
  check('480px: the mode menu fits the window', fit.l >= 0 && fit.r <= fit.w && fit.t >= 0 && fit.b <= fit.h, fit);
  await page.screenshot({ path: path.join(outDir, 'modes-6-narrow.png') });
  await page.keyboard.press('Escape');
  await settle();
  check('Esc closes the menu', !(await q(`return r.querySelector('.mwrap')`)));

  // While Claude works, Send turns into Stop (Esc too); typing turns it back into Send.
  await page.setViewportSize({ width: 1366, height: 820 });
  await q(`const t = r.querySelector('.composer textarea'); t.value = 'ask echo hi'; t.dispatchEvent(new Event('input')); r.querySelector('.send').click(); return true;`);
  await page.waitForFunction(`${ROOT}.querySelector('.composer .send.stop')`, null, { timeout: 8000 }).catch(notYet);
  await settle();
  const stopBtn = await q(`const b = r.querySelector('.composer .send'); return { stop: b.classList.contains('stop'), title: b.title, disabled: b.disabled, bg: getComputedStyle(b).backgroundColor };`);
  check('working: Send is Stop', stopBtn.stop && !stopBtn.disabled && /^Stop Claude/.test(stopBtn.title), stopBtn);
  const manual = await q(`const b = r.querySelector('.composer .cfoot .pcoff'); return b ? { text: b.textContent, shown: b.offsetParent !== null } : null;`);
  check('Manual sits in the message box footer', manual && manual.text === 'Manual' && manual.shown, manual);
  check('no Stop or Manual in the page control bar', !(await q(`return [...r.querySelectorAll('.drivebar button')].length`)));
  await page.screenshot({ path: path.join(outDir, 'modes-7-stop.png') });
  await q(`const t = r.querySelector('.composer textarea'); t.value = 'next'; t.dispatchEvent(new Event('input')); return true;`);
  check('typing: Stop turns back into Send', !(await q(`return r.querySelector('.composer .send').classList.contains('stop')`)));
  await q(`const t = r.querySelector('.composer textarea'); t.value = ''; t.dispatchEvent(new Event('input')); return true;`);
  await answerAll({ kinds: ['tool', 'drive'] });
  await page.waitForFunction(`!${ROOT}.querySelector('.composer .send.stop')`, null, { timeout: 8000 }).catch(notYet);

  // The key is never stored on the page; after a reload the server gives it back to this tab only.
  check('page control: the key is not in storage', await page.evaluate(() => !sessionStorage.getItem('editlens.driveKey') && !Object.values(localStorage).some((v) => /^[0-9a-f]{48}$/.test(v))));
  check('page control: a page that was not given the key is refused', (await fetch(`${require('../lib/config').baseUrl}/drive/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'x'.repeat(48), pageId: 'someone-else' }) })).status === 403);
  await page.reload();
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.drivebar.on')`, null, { timeout: 8000 }).catch(notYet);
  check('page control: still on after a reload', await q(`return Boolean(r.querySelector('.drivebar.on')) && !r.querySelector('.drivebar').textContent.includes('another tab')`));

  // Manual again: back to Claude Code's mode, read-only.
  await q(`r.querySelector('.composer .cfoot .pcoff').click(); return true;`);
  await page.waitForFunction(`!${ROOT}.querySelector('.drivebar.on')`, null, { timeout: 8000 }).catch(notYet);
  await settle();
  c = await chip();
  check('Manual again: Claude Code\'s mode, read-only', c && c.text === 'Accept edits' && c.ro, c);
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
