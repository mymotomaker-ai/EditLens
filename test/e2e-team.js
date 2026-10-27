#!/usr/bin/env node
'use strict';
require('./isolate');
// End-to-end check of the team board: Claude splits a task between two subagents that run at the
// same time, they claim their parts, share findings and post notes, and the Team tab shows it
// all with each agent in its own color. Runs real Claude Code with this plugin.
//
//   EDITLENS_E2E_REAL_CLAUDE=1 NODE_PATH=$(npm root -g) node test/e2e-team.js <site-dir> <site-url> <out-dir>
const { needRealClaude } = require('./isolate');
needRealClaude();
const fs = require('fs');
const path = require('path');
// Its own port and isolate's state folder: the EditLens server the user runs is never used or stopped.
process.env.EDITLENS_PORT = '5234';
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer } = require('../lib/client');
const { stopChild, spawned } = require('./child-stop');

const [siteDir, siteUrl, outDir] = process.argv.slice(2);
if (!siteDir || !siteUrl || !outDir) {
  console.error('usage: e2e-team.js <site-dir> <site-url> <out-dir>');
  process.exit(2);
}
const pluginDir = path.resolve(__dirname, '..');
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

const PROMPT = [
  'This folder is a small full-stack site: server.js serves public/ and the JSON API GET /api/menu, and public/app.js renders the menu.',
  'Use the team-board skill. Start two general-purpose subagents at the same time (in one message), with distinct parts:',
  "A) Backend: add { name: 'Cortado', price: 3.75 } to the menu in server.js.",
  'B) Frontend: in public/styles.css make .price bold (font-weight: 700), and check how public/app.js renders prices.',
  'Each must use the team board as it was told when it started, and must only touch its own files.',
  'When both are done, read the board and give me a two-sentence summary.',
].join('\n');
const MCP = 'mcp__plugin_editlens_live-page__';
const BOARD = ['read_board', 'post_note', 'claim_task', 'complete_task', 'share_finding'].map((t) => MCP + t).join(',');

function evaluate(page, src) {
  return page.evaluate((code) => {
    const root = document.querySelector('edit-lens')?.shadowRoot;
    // eslint-disable-next-line no-new-func
    return root ? new Function('root', code)(root) : null;
  }, src).catch((err) => {
    if (/Execution context was destroyed|navigation/i.test(err.message)) return null;
    throw err;
  });
}

async function waitFor(page, src, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await evaluate(page, src)) return true;
    await page.waitForTimeout(300);
  }
  console.log(`timed out waiting for: ${label}`);
  return false;
}

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

(async () => {
  let browser = null;
  let claude = null;
  try {
    // The page loads live.js from the server, so it must be up before the page opens.
    await ensureServer();
    browser = await launchOwnPort(chromium);
    const context = await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(siteUrl);
    if (!(await waitFor(page, `return root.querySelector('.panel')`, 10000, 'panel'))) throw new Error('the panel did not load');

    claude = spawn('claude', [
      '-p', PROMPT,
      '--plugin-dir', pluginDir,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', `Read,Edit,Write,MultiEdit,Glob,Grep,Agent,Task,Skill,${BOARD}`,
    ], { cwd: siteDir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    await spawned(claude);
    let output = '';
    claude.stdout.on('data', (d) => { output += d; });
    claude.stderr.on('data', (d) => { output += d; });
    const exited = new Promise((resolve) => claude.on('exit', resolve));

    await evaluate(page, `root.querySelector('.filters [data-f=team]').click(); return true;`);
    check('the team board gets posts', await waitFor(page, `return root.querySelectorAll('.tfeed .post:not(.quiet)').length >= 2`, 300000, 'board posts'));
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, 'team-1-working.png') });
    let timer = null;
    const code = await Promise.race([exited, new Promise((r) => { timer = setTimeout(() => r('timeout'), 480000); })]);
    clearTimeout(timer);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, 'team-2-done.png') });

    const summary = await evaluate(page, `
      const posts = [...root.querySelectorAll('.tfeed .post')].map((p) => p.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160));
      const mates = [...root.querySelectorAll('.roster .mate')].map((m) => m.textContent + (m.classList.contains('left') ? ' (finished)' : ''));
      const colors = new Set([...root.querySelectorAll('.roster .mate')].map((m) => m.getAttribute('style')));
      return { mates, colors: colors.size, claimsOpen: root.querySelectorAll('.claims .claim').length, posts };`);
    console.log(JSON.stringify(summary, null, 2));
    check('two agents, each in its own color', Boolean(summary) && summary.mates.length >= 2 && summary.colors === summary.mates.length, summary && summary.mates);

    // A finding opens its lines in the code view.
    const opened = await evaluate(page, `const a = root.querySelector('.tfeed .post .loc a.fref'); if (!a) return false; a.click(); return a.textContent;`);
    if (opened) {
      check('a finding opens its lines in the code view', await waitFor(page, `return root.querySelectorAll('.pane .cl').length > 0`, 8000, 'code view'), opened);
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(outDir, 'team-3-finding-open.png') });
    } else console.log('no finding to open');

    check('claude exited with 0', code === 0, code);
    console.log('--- claude output ---\n' + output.slice(-1200));
  } finally {
    await stopChild(claude);
    if (browser) await browser.close();
    await stopServer();
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
