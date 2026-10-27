'use strict';
require('./isolate');
// D21 on a real page and server that can't tell which account connects (EDITLENS_TEST_PEER=unknown,
// as on macOS and Windows). A page opened without the key says to open it once from Claude Code and
// sends nothing; the address /editlens opens (key after #) connects, the key leaves the address bar,
// and the first tab connects too. A reload keeps it; page control and the EditLens window work with it;
// a kept key that is no longer this computer's is removed and the page asks again.
// usage: NODE_PATH=$(npm root -g) node test/page-key-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: page-key-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pagekey-'));
const state = path.join(tmp, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(tmp, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(tmp, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const PORT = 5447;
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: String(PORT), EDITLENS_SDK_DIR: path.join(tmp, 'sdk'),
  EDITLENS_PLUGINS_DIR: path.join(tmp, 'plugins'), FAKE_CLAUDE_STATE: state, EDITLENS_TEST_PEER: 'unknown',
});
const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');
const { launch } = require('./launch');
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
const pagesOpen = async () => ((await getJson('/summary')).pages || []).length;

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const app = `http://localhost:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  let done = false;
  try {
    const { needed, key } = await getJson('/page-key');
    check('the server says page addresses need the key', needed === true && /^[0-9a-f]{32}$/.test(key), { needed, key });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 } });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const errors = [];
    const unkeyed = [];
    const watch = (page) => {
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => {
        const u = new URL(r.url());
        if (u.port === String(PORT) && u.pathname !== '/live.js' && u.pathname !== '/health' && !u.pathname.startsWith(`/gk-${key}/`)) unkeyed.push(u.pathname);
      });
      return page;
    };
    const q = (page, src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const notice = (page) => q(page, `const n = r.querySelector('.noroot'); return n && !n.hidden ? n.textContent : ''`);

    // 1. Opened without the key: it says what to do, and nothing connects.
    const first = watch(await ctx.newPage());
    await first.goto(app);
    await first.waitForFunction(`document.querySelector("edit-lens") && !${ROOT}.querySelector('.noroot').hidden`, null, { timeout: 10000 }).catch(onTimeout(null));
    check('without the key the panel says to open the page once from Claude Code', (await notice(first)).includes('Open this page once from Claude Code: /editlens'), await notice(first));
    check('no page is connected', (await pagesOpen()) === 0);
    await first.screenshot({ path: path.join(outDir, 'page-key-1-ask.png') });

    // 2. The address /editlens opens: the key after #.
    const second = watch(await ctx.newPage());
    await second.goto(`${app}#editlens-key=${key}`);
    await second.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    check('the key leaves the address bar', !/editlens-key/.test(second.url()), second.url());
    check('it connects', await (async () => {
      for (let i = 0; i < 40 && (await pagesOpen()) < 1; i++) await sleep(250);
      return (await pagesOpen()) >= 1;
    })());

    // 3. The first tab gets the key from this one and connects too; a reload keeps it.
    const both = async () => {
      for (let i = 0; i < 40 && (await pagesOpen()) < 2; i++) await sleep(250);
      return (await pagesOpen()) === 2;
    };
    check('the tab opened first connects once the key arrives', await both(), await pagesOpen());
    check('its notice is gone', (await notice(first)) === '', await notice(first));
    await first.reload();
    await first.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(1500);
    check('after a reload it still connects', await both(), await pagesOpen());

    // 4. Page control from the page: a message goes through with the key.
    const g = await postJson('/drive/grant', { cwd: proj, fresh: true, claudePath: path.join(bin, 'claude') }, { timeoutMs: 20000 });
    check('page control on', g.ok, g);
    await second.waitForFunction(`/Page control/.test(${ROOT}.querySelector('.sub').textContent)`, null, { timeout: 10000 }).catch(onTimeout(null));
    const sent = second.waitForResponse((r) => /\/drive\/message$/.test(new URL(r.url()).pathname), { timeout: 10000 }).catch(onTimeout(null));
    await q(second, `const t = r.querySelector('.composer textarea'); t.focus(); return true;`);
    await second.keyboard.type('hello from the page');
    await second.keyboard.press('Enter');
    const resp = await sent;
    check('a page control message is accepted', resp && resp.status() === 200, resp && resp.status());
    await second.screenshot({ path: path.join(outDir, 'page-key-2-control.png') });

    // 5. The EditLens window: with the key it lists questions; without it, it says where to open it.
    const win = watch(await ctx.newPage());
    await win.goto(`http://127.0.0.1:${PORT}/gk-${key}/answer`);
    await win.waitForFunction('document.getElementById("list") && !/Loading/.test(document.getElementById("list").textContent)', null, { timeout: 10000 }).catch(onTimeout(null));
    const listed = await win.evaluate('document.getElementById("list").textContent');
    check('the window opened with the key loads its list', !/Loading|forbidden|can't/i.test(listed), listed);
    const bare = await ctx.newPage();
    const r = await bare.goto(`http://127.0.0.1:${PORT}/answer`);
    check('without the key the window is refused and says where to open it', r.status() === 403 && /from your page's panel/.test(await bare.textContent('body')), r.status());
    await bare.close();
    check('every request from the pages includes the key', unkeyed.length === 0, [...new Set(unkeyed)]);

    // 6. A kept key that isn't this computer's: removed, and the page asks again.
    const other = await browser.newContext();
    const stale = `http://127.0.0.1:${site.address().port}/`;
    await other.addInitScript(([k]) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem(k, '0'.repeat(32)); } }, [`editlens.key:http://127.0.0.1:${PORT}`]);
    const third = await other.newPage();
    third.on('pageerror', (e) => errors.push(e.message));
    await third.goto(stale);
    await third.waitForFunction(`document.querySelector("edit-lens") && !${ROOT}.querySelector('.noroot').hidden`, null, { timeout: 10000 }).catch(onTimeout(null));
    check('a wrong kept key: the page asks for the key again', (await notice(third)).includes('Open this page once from Claude Code'), await notice(third));
    check('and the wrong key is no longer kept', (await third.evaluate(`localStorage.getItem('editlens.key:http://127.0.0.1:${PORT}')`)) === null);
    await other.close();
    check('no page errors', errors.length === 0, errors);
    done = true;
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed || !done ? `${failed} failed` : 'all ok');
  process.exitCode = failed || !done ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
