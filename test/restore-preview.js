#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4999';
// "Restore" on an edit card: asks inline, puts the file back as it was before that edit, and the
// toast's Undo puts it forward again. A file Claude created has Remove file instead. Fits a 480px window.
//
//   NODE_PATH=$(npm root -g) node test/restore-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'restore-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: restore-preview.js <site-url> <site-dir> <out-dir>');
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
const file = path.join(siteDir, 'restore-preview-demo.txt');
const OLD = 'the first version\nline two\n';
const NEW = 'started over\n';
// A file of that name the project already has is put back as it was at the end.
const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
function putBack() {
  if (saved === null) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, saved);
}

(async () => {
  await stopServer();
  await ensureServer();
  let browser = null;
  try {
    fs.writeFileSync(file, NEW);
    browser = await launchOwnPort(chromium);
    const page = await (await browser.newContext({ viewport: { width: 1366, height: 820 } })).newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(siteUrl);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
    await page.waitForTimeout(800);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const settle = (ms = 400) => page.waitForTimeout(ms);

    await postEvent({ type: 'change', sessionId: 'rp1', cwd: siteDir, tool: 'Write', file, relFile: 'restore-preview-demo.txt', before: OLD, after: NEW, kind: 'other', stats: { added: 1, removed: 2 }, intent: 'Start the file over', ts: Date.now() });
    await postEvent({ type: 'change', sessionId: 'rp1', cwd: siteDir, tool: 'Write', file: path.join(siteDir, 'restore-preview-new.txt'), relFile: 'restore-preview-new.txt', created: true, before: '', after: 'x', kind: 'other', stats: { added: 1, removed: 0 }, ts: Date.now() });
    await settle();
    // The button labels: a new file has "Remove file" (the same .rst class) instead of Restore.
    const RESTORE = `[...r.querySelectorAll('.k-edit:not(.restore)')].slice(-2)[0].querySelector('button.rst')`;
    const cards = await q(`return [...r.querySelectorAll('.k-edit:not(.restore)')].slice(-2).map((c) => [...c.querySelectorAll('button.rst')].map((b) => b.textContent))`);
    check('Restore for a changed file, Remove file for a new one', JSON.stringify(cards) === JSON.stringify([['Restore'], ['Remove file']]), cards);

    await q(`${RESTORE}.click(); return true;`);
    await settle(200);
    const ask = await q(`const b = r.querySelector('.rconf'); return b && b.textContent;`);
    check('it asks first, naming the file', /Put restore-preview-demo\.txt back as it was before this edit\?/.test(ask || ''), ask);
    check('the card did not open or close from that click', await q(`return !r.querySelector('.rconf').closest('.k-edit').classList.contains('open')`));
    await page.screenshot({ path: path.join(outDir, 'restore-1-ask.png') });
    check('nothing changed yet', fs.readFileSync(file, 'utf8') === NEW);

    await q(`r.querySelector('.rconf .allow').click(); return true;`);
    await settle(600);
    check('Restore puts the file back', fs.readFileSync(file, 'utf8') === OLD);
    check('the question closes', !(await q(`return r.querySelector('.rconf')`)));
    const toast = await q(`const t = r.querySelector('.toast'); return { text: t.textContent, on: t.classList.contains('on'), undo: Boolean(t.querySelector('button')) };`);
    check('the toast says so, with Undo', toast.on && /Restored restore-preview-demo\.txt/.test(toast.text) && toast.undo, toast);
    await page.screenshot({ path: path.join(outDir, 'restore-2-done.png') });
    await q(`r.querySelector('.toast button').click(); return true;`);
    await settle(600);
    check('Undo puts the newer text back', fs.readFileSync(file, 'utf8') === NEW);

    // Cancel, and a 480px window.
    await page.setViewportSize({ width: 480, height: 760 });
    await settle();
    await q(`${RESTORE}.click(); return true;`);
    await settle(200);
    const fit = await q(`const b = r.querySelector('.rconf'); const card = b.closest('.k-edit').getBoundingClientRect(); const box = b.getBoundingClientRect();
      return { inside: box.right <= card.right + 1 && box.left >= card.left - 1, buttons: [...b.querySelectorAll('button')].every((x) => x.getBoundingClientRect().right <= card.right + 1) };`);
    check('480px: the question fits inside the card', fit.inside && fit.buttons, fit);
    await page.screenshot({ path: path.join(outDir, 'restore-3-narrow.png') });
    await q(`[...r.querySelectorAll('.rconf button')].find((b) => b.textContent === 'Cancel').click(); return true;`);
    await settle(200);
    check('Cancel closes it and changes nothing', !(await q(`return r.querySelector('.rconf')`)) && fs.readFileSync(file, 'utf8') === NEW);
  } finally {
    if (browser) await browser.close();
    putBack();
    await stopServer();
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
