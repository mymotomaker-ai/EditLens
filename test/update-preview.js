'use strict';
require('./isolate');
// Updates and restarts on a real page and server (stand-in SDK and claude): EditLens replaced by a
// newer copy while page control is on (the page says why it stopped, then that it starts again); a page
// script older than its server (an "Update ready" bar that never reloads over a message being typed);
// a newer EditLens installed than the server (the bar names both versions).
// usage: NODE_PATH=$(npm root -g) node test/update-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: update-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-update-'));
const state = path.join(tmp, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(tmp, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const PORT = 5227;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: String(PORT), EDITLENS_SDK_DIR: path.join(tmp, 'sdk'),
  EDITLENS_PLUGINS_DIR: path.join(tmp, 'plugins'), FAKE_CLAUDE_STATE: state,
});
const { ensureServer, stopServer, postJson, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const config = require('../lib/config');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj);
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:40px"><h1>App</h1>
<script src="http://127.0.0.1:${PORT}/live.js" data-root="${proj}" data-panel="open"></script></body>`;

// The installed update: a copy of this plugin marked 99.0.0 in the plugin cache.
function newerCopy() {
  const root = path.join(tmp, 'plugins', 'cache', 'editlens', 'editlens', '99.0.0');
  for (const d of ['lib', 'server', 'client']) fs.cpSync(path.join(__dirname, '..', d), path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'editlens', version: '99.0.0' }));
  return root;
}

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  let restarted = null;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    // Every toast text, also one the next toast replaced immediately.
    const toastHas = (re) => page.waitForFunction(`(window.__toasts || []).some((t) => ${re}.test(t))`, null, { timeout: 15000 }).then(() => true, onTimeout(false));
    await page.goto(`http://127.0.0.1:${site.address().port}/`);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await q(`window.__toasts = []; new MutationObserver(() => { const t = r.querySelector('.toast'); const s = t ? t.textContent : ''; if (s && window.__toasts[window.__toasts.length - 1] !== s) window.__toasts.push(s); }).observe(r, { subtree: true, childList: true, characterData: true }); return true;`);
    await sleep(800);
    check('no update bar while the page and server match', await q(`return r.querySelector('.updbar').hidden`));

    const g = await postJson('/drive/grant', { cwd: proj, fresh: true, claudePath: path.join(bin, 'claude') }, { timeoutMs: 20000 });
    check('page control on', g.ok, g);
    await page.waitForFunction(`/Page control/.test(${ROOT}.querySelector('.sub').textContent)`, null, { timeout: 10000 }).catch(onTimeout(null));
    await sleep(500);

    // The update: a newer copy is installed; /editlens restart replaces the server.
    newerCopy();
    const out = require('child_process').spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'restart.js')], { env: process.env, encoding: 'utf8' });
    check('/editlens restart uses the newer copy', out.status === 0 && /→ 99\.0\.0/.test(out.stdout), out.stdout + out.stderr);
    check('the page says why page control stopped', await toastHas(/Page control stopped: EditLens was updated and restarted\./), await q('return window.__toasts'));
    check('then that it starts again, in the same conversation', await toastHas(/Page control starts again: EditLens was updated and restarted\. It continues your page conversation\./));
    await page.screenshot({ path: path.join(outDir, 'update-1-back-on.png') });

    // The page's script is now older than its server.
    const bar = () => q(`const b = r.querySelector('.updbar'); return b.hidden ? '' : b.textContent`);
    await page.waitForFunction(`!${ROOT}.querySelector('.updbar').hidden`, null, { timeout: 10000 }).catch(onTimeout(null));
    const text = await bar();
    check('a lasting Update ready bar with both versions and Reload', /^Update ready/.test(text) && text.includes(`EditLens 99.0.0 is running; this page still has ${config.version}. Reload to use it.`) && /Reload$/.test(text), text);
    await sleep(3000);
    check('it stays (not one feed item that scrolls away)', /^Update ready/.test(await bar()));

    // Reload is never done over a message being typed without asking.
    await q(`const t = r.querySelector('.composer textarea'); t.focus(); return true;`);
    await page.keyboard.type('half a message');
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); d.dismiss(); });
    await q(`[...r.querySelectorAll('.updbar button')].find((b) => b.textContent === 'Reload').click(); return true;`);
    await sleep(800);
    check('Reload asks first when a message is being typed, and Cancel keeps it', /message you are typing will be lost/.test(asked) && (await q(`return r.querySelector('.composer textarea').value`)) === 'half a message', asked);

    // A hook of a newer plugin reports its version to this server.
    await postEvent({ type: 'note', sessionId: 's1', cwd: proj, pluginVersion: '99.1.0' });
    await page.waitForFunction(`/99\\.1\\.0 is installed/.test(${ROOT}.querySelector('.updbar').textContent)`, null, { timeout: 8000 }).catch(onTimeout(null));
    check('a newer EditLens installed than the running one is named, with what to do',
      (await bar()).includes('EditLens 99.1.0 is installed, but 99.0.0 is still running. It updates when page control stops, and starts again. To update now, type /editlens restart in Claude Code.'), await bar());
    await page.screenshot({ path: path.join(outDir, 'update-2-bar.png') });
    check('no page errors', errors.length === 0, errors);
    restarted = true;
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed || !restarted ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
