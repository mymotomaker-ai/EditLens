#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5200';
// Selected stylesheet edits and full text, without Claude: an edit inside a CSS rule outlines the
// elements that rule styles (also inside @media and in a selector list); a rule for elements not
// on the page turns Show into "Open code", which opens the stylesheet at that line; long step text
// wraps instead of being clipped, and nothing in the panel uses an ellipsis.
//
//   NODE_PATH=$(npm root -g) node test/select-css-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'select-css-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: select-css-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `css-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

const cssFile = path.join(siteDir, 'src', 'app.css');
const before = fs.readFileSync(cssFile, 'utf8').replace(/\n*$/, '\n');
const added = [
  '/* card { not a rule } */',
  '.stat-card {',
  '  outline: 0;',
  '}',
  '@media (min-width: 1px) {',
  '  .missing-thing,',
  '  .stat-value {',
  '    color: inherit;',
  '  }',
  '}',
  '.nowhere-on-this-page {',
  '  color: blue;',
  '}',
];
const after = before + added.join('\n') + '\n';
const base = before.split('\n').length - 1; // lines before the added block
const lineOf = (text) => base + added.indexOf(text) + 1;

async function cssEdit(line, text) {
  await postEvent({
    type: 'change', kind: 'frontend', tool: 'Edit', sessionId: SESSION, cwd: siteDir, file: cssFile, relFile: 'src/app.css', ts: Date.now(),
    before, after, stats: { added: 1, removed: 0 }, hints: {}, hunks: [{ oldStart: line, newStart: line, lines: ['+' + text] }],
  });
}

(async () => {
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  const page = await (await browser.newContext({ viewport: { width: 1366, height: 768 } })).newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const open = async (i) => {
    await q(`const c = [...r.querySelectorAll('.k-edit')][${i}]; c.click(); return true;`);
    await page.waitForTimeout(900);
    return q(`return { n: r.querySelectorAll('.box.sel').length, bar: r.querySelector('.selbar .st').textContent, show: r.querySelector('.selbar .mini').textContent, disabled: r.querySelector('.selbar .mini').disabled }`);
  };

  await cssEdit(lineOf('  outline: 0;'), '  outline: 0;');
  await cssEdit(lineOf('    color: inherit;'), '    color: inherit;');
  await cssEdit(lineOf('.nowhere-on-this-page {'), '.nowhere-on-this-page {');
  await page.waitForFunction(`${ROOT}.querySelectorAll('.k-edit').length >= 3`);
  await page.waitForTimeout(5000);

  let s = await open(0);
  check('a property inside .stat-card outlines the three cards', s.n === 3 && s.show === 'Show', s);
  s = await open(1);
  check('inside @media, a selector list: the stat values', s.n === 3, s);
  s = await open(2);
  check('a rule for nothing on the page: Show becomes Open code', s.n === 0 && s.show === 'Open code' && !s.disabled, s);
  await q(`r.querySelector('.selbar .mini').click(); return true;`);
  await page.waitForFunction(`[...${ROOT}.querySelectorAll('.pane.on .cl.lmark')].some((x) => x.textContent.includes('nowhere-on-this-page'))`, null, { timeout: 8000 })
    .then(() => true, onTimeout(false)).then((ok) => check('Open code shows that rule in the code view', ok));
  await page.screenshot({ path: path.join(outDir, 'select-css-open-code.png') });

  // Long text wraps instead of being clipped.
  const long = "I'm also tidying the CSV code: removing a redundant step in how rows are parsed, so blank lines and quoted commas no longer produce empty records, and the totals at the bottom of the report match the source file again.";
  await postEvent({ type: 'chat', role: 'assistant', text: long, sessionId: SESSION, cwd: siteDir, ts: Date.now(), backlog: false });
  await page.waitForTimeout(600);
  const now = await q(`const t = r.querySelector('.now .t'); return t ? { text: t.textContent, cut: t.scrollWidth > t.clientWidth + 1 } : null;`);
  check('the step line shows the whole text', now && now.text === long && !now.cut, now);
  const ellipsis = await q(`return [...r.querySelectorAll('*')].filter((e) => getComputedStyle(e).textOverflow === 'ellipsis').map((e) => e.className).slice(0, 10);`);
  check('nothing in the panel or code view is shortened with an ellipsis', ellipsis.length === 0, ellipsis);
  await page.screenshot({ path: path.join(outDir, 'select-css-full-text.png') });
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  if (failed) process.exitCode = 1;
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
