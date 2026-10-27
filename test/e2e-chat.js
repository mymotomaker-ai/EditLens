#!/usr/bin/env node
'use strict';
require('./isolate');
// End-to-end check of the v0.2 features: live replies, subagents, backend edits, messages
// typed on the page (during a turn and while Claude listens), and Claude pointing at the page.
//
//   EDITLENS_E2E_REAL_CLAUDE=1 NODE_PATH=$(npm root -g) node test/e2e-chat.js <site-dir> <site-url> <out-dir>
// The README pictures run Claude with Haiku: ANTHROPIC_MODEL=claude-haiku-5-5.
const { needRealClaude } = require('./isolate');
needRealClaude();
const fs = require('fs');
const path = require('path');
// Its own port and isolate's state folder: the EditLens server the user runs is never used or stopped.
process.env.EDITLENS_PORT = '5228';
// This run checks Wait (page messages wait for Claude in the terminal), so page control stays off:
// "What /editlens does" is "Connect the page", and "Wait for page messages" is on (it is off by
// default, and the page takes Claude Code's value when Claude connects), for the server and claude.
process.env.CLAUDE_PLUGIN_OPTION_START = 'Connect the page';
process.env.CLAUDE_PLUGIN_OPTION_WAIT = 'true';
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { stopChild, spawned } = require('./child-stop');
const { ensureServer, stopServer } = require('../lib/client');

const [siteDir, siteUrl, outDir] = process.argv.slice(2);
if (!siteDir || !siteUrl || !outDir) {
  console.error('usage: e2e-chat.js <site-dir> <site-url> <out-dir>');
  process.exit(2);
}
const pluginDir = path.resolve(__dirname, '..');
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

const PROMPT = [
  'This folder is a small full-stack site: server.js serves public/ and the JSON API GET /api/menu, and public/app.js renders the menu from it.',
  'Do these steps in order, and before each edit say in one short sentence what you are changing:',
  '1) Start one general-purpose subagent to read public/styles.css and suggest a single visual improvement in two sentences. It must not edit any files.',
  "2) Use show_code to open server.js at the menu array, then in server.js add { name: 'Mocha', price: 4.5 } to the menu.",
  '3) In public/styles.css make .price bold (font-weight: 700).',
  'Keep your final summary to two sentences.',
].join('\n');
const MCP = 'mcp__plugin_editlens_live-page__';

function shadow(page, fn, arg) {
  return evaluate(page, fn, arg).catch((err) => {
    // The page reloads on its own after backend edits; try again on the next poll.
    if (/Execution context was destroyed|navigation/i.test(err.message)) return null;
    throw err;
  });
}

function evaluate(page, fn, arg) {
  return page.evaluate(
    ([src, a]) => {
      const root = document.querySelector('edit-lens')?.shadowRoot;
      // eslint-disable-next-line no-new-func
      return root ? new Function('root', 'arg', src)(root, a) : null;
    },
    [fn, arg],
  );
}

async function waitShadow(page, src, timeout, label) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await shadow(page, src)) return true;
    await page.waitForTimeout(200);
  }
  console.log(`timed out waiting for: ${label}`);
  return false;
}

async function snap(page, name) {
  await page.waitForTimeout(600);
  // A short note on the page shows for 2.6 s; the picture waits until it goes, so it covers nothing.
  await page.waitForFunction(() => !document.querySelector('edit-lens')?.shadowRoot?.querySelector('.toast.on'), null, { timeout: 3000 })
    .catch((err) => { if (err.name === 'TimeoutError') console.log('a note still shows in', name); else throw err; });
  await page.screenshot({ path: path.join(outDir, name) });
  console.log('captured', name);
}

async function sendFromPage(page, text) {
  await shadow(page, `const t = root.querySelector('.composer textarea'); t.value = arg; t.dispatchEvent(new Event('input')); return true;`, text);
  await shadow(page, `root.querySelector('.send').click(); return true;`);
  console.log('sent from page:', text);
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
    // The server first: the page connects to it before Claude (whose hook would start it) runs.
    await ensureServer();
    browser = await launchOwnPort(chromium);
    const context = await browser.newContext({
      viewport: { width: 1440, height: 860 },
      deviceScaleFactor: 2,
      recordVideo: { dir: outDir, size: { width: 1440, height: 860 } },
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
    // The README pictures skip the first-visit tour; localStorage can throw in private mode.
    await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await page.goto(siteUrl);
    if (!(await waitShadow(page, `return root.querySelector('.status.idle')`, 10000, 'connected'))) throw new Error('the panel did not connect');
    // Wait shows as off until Claude connects; it is turned on here as well, as a user would.
    await shadow(page, `const b = root.querySelector('.listen'); if (b.getAttribute('aria-pressed') !== 'true') b.click(); return true;`);

    claude = spawn('claude', [
      '-p', PROMPT,
      '--plugin-dir', pluginDir,
      '--permission-mode', 'acceptEdits',
      '--allowedTools', `Read,Edit,Write,MultiEdit,Glob,Grep,Agent,Task,${MCP}highlight_on_page,${MCP}clear_page_highlights,${MCP}list_live_pages,${MCP}show_code`,
    ], { cwd: siteDir, env: { ...process.env, EDITLENS_WAIT_MINUTES: '4', EDITLENS_WAIT_ANYWHERE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    await spawned(claude);
    let output = '';
    claude.stdout.on('data', (d) => { output += d; });
    claude.stderr.on('data', (d) => { output += d; });
    let exitCode = null;
    const exited = new Promise((resolve) => claude.on('exit', (code) => { exitCode = code; resolve(); }));

    // 1. Subagent card appears; the picture is taken immediately, while the subagent still runs.
    check('a subagent card appears', await waitShadow(page, `return root.querySelector('.k-agent')`, 180000, 'subagent'));
    await snap(page, '01-subagent.png');

    // 2. The backend edit card; the message is sent immediately, while Claude still works on the turn.
    check('a backend edit card appears', await waitShadow(page, `return root.querySelector('.k-edit.backend')`, 180000, 'backend edit'));
    await sendFromPage(page, "Also change the main heading in public/index.html to 'New coffee each day'.");
    await snap(page, '02-backend-edit-and-message.png');
    // Steps and the code view stay on the page, so they are checked after the pictures above.
    check('the subagent card shows its steps', await waitShadow(page, `return root.querySelectorAll('.k-agent .asteps > *').length >= 1`, 60000, 'subagent steps'));
    check('the code view opens', await waitShadow(page, `return root.querySelector('.dock.on .pane.on .cl')`, 180000, 'code view'));
    check('the edit plays line by line', await waitShadow(page, `return root.querySelector('.cl.cur, .cl.add, .cl.del')`, 120000, 'edit playing'));
    await snap(page, '01b-code-playing.png');

    // 3. Claude finishes the turn, takes the message at Stop, then listens.
    check('Claude listens after the turn', await waitShadow(page, `return root.querySelector('.status.listening')`, 300000, 'listening'));
    await snap(page, '03-listening.png');

    // 4. A question typed while Claude listens; Claude answers and points at the page.
    await sendFromPage(page, 'Which menu item is the most expensive? Point at it on the page with highlight_on_page.');
    check('Claude points at the page', await waitShadow(page, `return root.querySelector('.k-point')`, 240000, 'point'));
    await snap(page, '04-claude-points.png');
    check('Claude listens again', await waitShadow(page, `return root.querySelector('.status.listening')`, 240000, 'listening again'));
    await snap(page, '05-answer.png');

    // 5. Turning Listen off lets the session end.
    await shadow(page, `root.querySelector('.listen').click(); return true;`);
    await Promise.race([exited, page.waitForTimeout(60000)]);
    await shadow(page, `root.querySelector('.filters [data-f=edits]').click(); return true;`);
    await snap(page, '06-edits-filter.png');
    const stats = await shadow(page, `return {
      replies: root.querySelectorAll('.k-claude').length,
      pageMessages: root.querySelectorAll('.k-user.page').length,
      delivered: [...root.querySelectorAll('.k-user.page .state')].map((n) => n.textContent),
      agents: root.querySelectorAll('.k-agent').length,
      edits: root.querySelectorAll('.k-edit').length,
      backend: root.querySelectorAll('.k-edit.backend').length,
      points: root.querySelectorAll('.k-point').length,
      codeFiles: [...root.querySelectorAll('.tab .nm')].map((n) => n.textContent),
      replayable: root.querySelectorAll('.tchip').length,
    }`);
    await context.close();
    console.log('panel:', JSON.stringify(stats));
    check('claude exited with 0', exitCode === 0, exitCode);
    console.log('--- claude output ---\n' + output.slice(-1500));
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
