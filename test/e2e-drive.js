#!/usr/bin/env node
'use strict';
require('./isolate');
// End-to-end check of drive mode: bin/drive.js starts Claude in the live server, the page gets
// the key, a message typed on the page starts Claude immediately, a permission question is
// answered in the panel, and Manual ends it. Runs real Claude through the Agent SDK.
//
//   EDITLENS_E2E_REAL_CLAUDE=1 EDITLENS_SDK_DIR=<dir with the SDK installed> NODE_PATH=$(npm root -g) \
//     node test/e2e-drive.js <site-dir> <site-url> <out-dir>
const { needRealClaude } = require('./isolate');
needRealClaude();
const fs = require('fs');
const path = require('path');
// Its own port and isolate's state folder: the EditLens server the user runs is never used or stopped.
process.env.EDITLENS_PORT = '5231';
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer } = require('../lib/client');
const { answerAll } = require('./answer-helper');

const [siteDir, siteUrl, outDir] = process.argv.slice(2);
if (!siteDir || !siteUrl || !outDir) {
  console.error('usage: e2e-drive.js <site-dir> <site-url> <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const MESSAGE = "In public/styles.css make .price bold (font-weight: 700). Then run `node -e \"console.log('drive ok')\"` with Bash and tell me what it printed, in one sentence.";

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
  try {
    await stopServer(); // a new server that sees EDITLENS_SDK_DIR
    await ensureServer();
    browser = await launchOwnPort(chromium);
    const page = await (await browser.newContext({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 })).newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    await page.goto(siteUrl);
    if (!(await waitFor(page, `return root.querySelector('.panel')`, 10000, 'panel'))) throw new Error('no panel');
    await page.waitForTimeout(800);

    // A session id as a 4th argument: continue a copy of it; otherwise a new conversation.
    const started = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'drive.js'), process.argv[5] || 'new'], { cwd: siteDir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: siteDir } });
    console.log('drive.js:', (started.stdout + started.stderr).trim());
    check('drive.js exited with 0', started.status === 0, started.status);
    check('Claude is ready in page control', await waitFor(page, `return root.querySelector('.drivebar.on') && !/Starting/.test(root.querySelector('.drivebar .t').textContent)`, 60000, 'Claude ready'));
    console.log('bar:', await evaluate(page, `return root.querySelector('.drivebar .t').textContent`));

    await evaluate(page, `const t = root.querySelector('.composer textarea'); t.value = ${JSON.stringify(MESSAGE)}; t.dispatchEvent(new Event('input')); root.querySelector('.send').click(); return true;`);
    const sentAt = Date.now();
    check('a message from the page starts Claude', await waitFor(page, `return root.querySelector('.status.working')`, 20000, 'working'));
    console.log(`working after ${Date.now() - sentAt} ms`);

    // Answer every permission question with Allow until Claude is done.
    let asked = 0;
    let sawBusy = false;
    let done = false;
    const until = Date.now() + 240000;
    while (Date.now() < until) {
      const open = await evaluate(page, `const c = [...root.querySelectorAll('.k-perm:not(.done)')]; return c.map((x) => x.querySelector('.pbody b').textContent + ': ' + (x.querySelector('.pdetail') ? x.querySelector('.pdetail').textContent.slice(0, 80) : ''));`);
      if (open && open.length) {
        asked += open.length;
        console.log('permission asked:', JSON.stringify(open));
        if (asked === open.length) await page.screenshot({ path: path.join(outDir, 'drive-1-permission.png') });
        // Allow is given in the EditLens window, never on the page (server/answer.js).
        console.log('allowed in the EditLens window:', JSON.stringify(await answerAll({ kinds: ['drive'] })));
      }
      const busy = await evaluate(page, `return Boolean(root.querySelector('.drivebar.busy'))`);
      if (busy) sawBusy = true;
      else if (sawBusy) {
        done = true;
        break;
      }
      await page.waitForTimeout(500);
    }
    check('Claude finished the turn', done);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(outDir, 'drive-2-done.png') });
    const reply = await evaluate(page, `const r = [...root.querySelectorAll('.k-claude')]; return r.length ? r[r.length - 1].textContent.slice(0, 300) : null;`);
    console.log('permission questions:', asked);
    console.log('last reply:', reply);
    check('the Bash command needed a permission answer', asked > 0, asked);
    check('the reply says what the command printed', /drive ok/.test(reply || ''), reply);
    check('styles.css: .price is bold', /font-weight:\s*700/.test(fs.readFileSync(path.join(siteDir, 'public', 'styles.css'), 'utf8').split('.price')[1] || ''));

    await evaluate(page, `root.querySelector('.composer .cfoot .pcoff').click(); return true;`);
    check('Manual ends page control', await waitFor(page, `return !root.querySelector('.drivebar.on')`, 15000, 'return to Manual'));
    check('after Manual, the panel is not in page control', (await evaluate(page, `return root.querySelector('.panel').classList.contains('driving')`)) === false);
  } finally {
    if (browser) await browser.close();
    await stopServer(); // ends Claude too: page control runs it in the server
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
