#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5208';
// Signing in for page control, in the panel, without a real login: a stand-in claude (not signed
// in) and SDK in test/fixtures. /editlens control says to sign in; a message typed meanwhile waits;
// the code from "Open the sign-in page" finishes the sign-in, then Claude starts and sends the message.
//
//   NODE_PATH=$(npm root -g) node test/signin-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer } = require('../lib/client');
const { canOpenBrowser } = require('../lib/browser');

const [siteUrl, siteArg, outDir = 'signin-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: signin-preview.js <site-url> <site-dir> <out-dir>');
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-signin-preview-'));
const state = path.join(tmp, 'state');
fs.mkdirSync(state);
const sdk = path.join(tmp, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
fs.mkdirSync(path.join(tmp, 'bin'));
const exe = path.join(tmp, 'bin', 'claude');
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
// The live server is started from here, so it sees the stand-ins.
Object.assign(process.env, { EDITLENS_SDK_DIR: path.join(tmp, 'sdk'), EDITLENS_CLAUDE_PATH: exe, FAKE_CLAUDE_STATE: state, FAKE_CLAUDE_LOGIN_MS: 'never' });

// The steps; the caller stops the browser and the server even when a step fails.
let browser = null;
async function steps() {
  await stopServer();
  await ensureServer();
  browser = await launchOwnPort(chromium);
  const context = await browser.newContext({ viewport: { width: 1366, height: 820 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(siteUrl);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`);
  await page.waitForTimeout(800);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  const box = () => q(`const b = r.querySelector('.signin'); return b && b.classList.contains('on') ? b.innerText : null;`);

  const out = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'drive.js'), 'new'], { cwd: siteDir, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: siteDir } });
  const said = (out.stdout + out.stderr).trim();
  // Since 0.24.18 (bin/drive.js sayControl): steps under "Sign in once", the panel's Sign in first,
  // then an API key as the other way. The second step depends on whether a browser opens on this
  // computer (no screen, or SSH: no); the server started from here sees the same environment.
  const local = canOpenBrowser().ok;
  const next = local ? /Your browser opens\. Claude starts by itself after\./ : /Open the sign-in page it shows, then paste its code in the panel\./;
  check('/editlens control says to sign in in the panel', /Sign in once/.test(said) && /Click Sign in in the panel on your page/.test(said) && next.test(said)
    && /set ANTHROPIC_API_KEY, then \/editlens control/.test(said), said);
  await page.waitForFunction(`${ROOT}.querySelector('.signin.on')`, null, { timeout: 8000 }).catch(onTimeout(null));
  let text = await box();
  check('the panel asks to sign in once', text && /Claude needs you to sign in once/.test(text) && /Recommended: an API key/.test(text) && /Sign in with Anthropic Console/.test(text), text);
  // The panel header's .sub rule (one line, cut at the edge) also matched this line until 0.24.47.
  const rec = await q(`const p = [...r.querySelectorAll('.signin p')].find((x) => /Recommended/.test(x.textContent));
    return p && { wrap: getComputedStyle(p).whiteSpace, over: p.scrollWidth - p.clientWidth, h: p.getBoundingClientRect().height }`);
  check('the API key line is shown whole, on as many lines as it needs', Boolean(rec) && rec.wrap !== 'nowrap' && rec.over <= 1 && rec.h > 20, rec);
  check('the bar says what it waits for', /waiting for you to sign in/.test(await q(`return r.querySelector('.drivebar .t').textContent`)));

  // A message typed now waits.
  await q(`const t = r.querySelector('.composer textarea'); t.value = 'make the title bold'; t.dispatchEvent(new Event('input')); r.querySelector('.send').click(); return true;`);
  await page.waitForTimeout(600);
  text = await box();
  check('the message waits for the sign-in', /Your message is sent as soon as Claude starts/.test(text), text);
  await page.screenshot({ path: path.join(outDir, 'signin-1-ask.png') });

  await q(`[...r.querySelectorAll('.signin button')].find((b) => b.textContent === 'Sign in').click(); return true;`);
  await page.waitForFunction(`${ROOT}.querySelector('.signin a')`, null, { timeout: 8000 }).catch(onTimeout(null));
  text = await box();
  // No browser here (since e659c50): the panel says to sign in on the sign-in page and paste its code.
  if (local) check('says the browser opened, with a link if it did not', /Your browser opened to sign in/.test(text) && /Browser didn't open\? Open the sign-in page/.test(text), text);
  else check('no browser here: says to sign in on the sign-in page and paste its code', /Sign in to Claude on the sign-in page\. Then paste the code it shows below\./.test(text) && /Open the sign-in page/.test(text), text);
  check('the link is the sign-in page', (await q(`return r.querySelector('.signin a').href`)).startsWith('https://example.test/oauth/'));
  const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 5000 }).catch(onTimeout(null)), q(`r.querySelector('.signin a').click(); return true;`)]);
  if (tab) await tab.close();
  await page.waitForTimeout(300);
  check('opening it offers a code field', Boolean(await q(`return r.querySelector('.signin input.code')`)));
  await page.screenshot({ path: path.join(outDir, 'signin-2-waiting.png') });

  await q(`const i = r.querySelector('.signin input.code'); i.value = 'abc123'; [...r.querySelectorAll('.signin button')].find((b) => b.textContent === 'Continue').click(); return true;`);
  const started = await page.waitForFunction(`!${ROOT}.querySelector('.signin.on') && /Page control · new conversation/.test(${ROOT}.querySelector('.drivebar .t').textContent)`, null, { timeout: 10000 }).then(() => true, onTimeout(false));
  check('signed in: Claude starts by itself', started, await q(`return r.querySelector('.drivebar .t').textContent`));
  const answered = path.join(state, 'answered');
  const end = Date.now() + 8000;
  while (!fs.existsSync(answered) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  check('the waiting message was sent', fs.existsSync(answered) && fs.readFileSync(answered, 'utf8') === 'make the title bold\n');
  await page.screenshot({ path: path.join(outDir, 'signin-3-started.png') });

  await q(`r.querySelector('.composer .cfoot .pcoff').click(); return true;`);
  await page.waitForTimeout(800);
}

(async () => {
  try {
    await steps();
  } finally {
    if (browser) await browser.close();
    await stopServer(); // the next server starts without the stand-ins
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
