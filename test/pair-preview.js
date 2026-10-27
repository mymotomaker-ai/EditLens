#!/usr/bin/env node
'use strict';
require('./isolate');
// A page from a paired computer, in the browser: two servers on this machine stand in for a VPS
// and a laptop. The panel shows the VPS's name in its colour, says "Reconnecting to …" while the
// VPS is down, and reconnects by itself. Light and dark, wide and narrow.
//
//   NODE_PATH=$(npm root -g) node test/pair-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launch } = require('./launch');

const [outArg = 'pair-out'] = process.argv.slice(2);
const outDir = require('./out-dir')(outArg);
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pair-preview-'));
const project = path.join(base, 'project');
fs.mkdirSync(project);
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 4365, pairPort: 4366, dir: path.join(base, 'host') };
const REMOTE = { port: 4367, pairPort: 4368, dir: path.join(base, 'remote') };

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, json: null, error: err.code }));
    if (data) req.write(data);
    req.end();
  });
}
const api = (s, method, p, body) => request(s.port, method, p, body, { 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') }).then((r) => r.json);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) return false;
    await sleep(150);
  }
  return true;
}
async function start(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  s.child = spawn(process.execPath, [SERVER], { env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir }, stdio: 'ignore' });
  await waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}
function stop(s) {
  return new Promise((resolve) => {
    if (!s.child || s.child.exitCode !== null) return resolve();
    s.child.once('exit', resolve);
    s.child.kill();
  });
}

(async () => {
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><head><title>Shop</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Shop on the VPS</h1><p>This page is served by the paired computer.</p></body></html>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  let browser = null;
  try {
    await start(HOST);
    await start(REMOTE);
    browser = await launch(chromium, {}, [HOST.child, REMOTE.child]);
    await api(HOST, 'POST', '/connect', { cwd: project, target: `http://127.0.0.1:${site.address().port}` });
    const { code } = await api(HOST, 'POST', '/pair', { cwd: project });
    const joined = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code });
    check('joined', !!(joined && joined.ok), joined);
    const name = joined.host.name;

    for (const [scheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]]) {
      const page = await browser.newPage({ viewport: { width, height: 760 }, colorScheme: scheme });
      // The address with this user's key (D11): the browser keeps the site's cookie it sets.
      await page.goto(joined.host.keyUrl);
      await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.host.on')`, null, { timeout: 15000 });
      const chip = await page.evaluate(`(() => { const c = ${ROOT}.querySelector('.host'); const r = c.getBoundingClientRect(); return { text: c.textContent, w: r.width, h: r.height, color: getComputedStyle(c).color }; })()`);
      check(`${scheme} ${width}: host chip shows the paired computer`, chip.text === '◆ ' + name && chip.w > 20 && chip.h > 8, chip);
      await page.screenshot({ path: path.join(outDir, `pair-${scheme}-${width}.png`) });
      await page.close();
    }

    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    const refused = [];
    page.on('response', (r) => { if (/\/sessions\?/.test(r.url()) && r.status() === 403) refused.push(r.url()); });
    await page.goto(joined.host.keyUrl);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.host.on')`, null, { timeout: 15000 });
    await sleep(1500);
    check('a paired page does not ask for the Sessions list (the server there refuses it)', !refused.length, refused);
    await page.evaluate(`${ROOT}.querySelector('.panel button.icon[aria-label="More"]').click()`);
    await sleep(300);
    await page.evaluate(`${ROOT}.querySelector('.lmenu [data-act="sessions"]').click()`);
    const noteText = () => page.evaluate(`(() => { const n = ${ROOT}.querySelector('.usage.sessions.on .ssnone'); return n ? n.textContent : null; })()`);
    await waitFor(noteText, 8000);
    const note = await noteText();
    check('its Sessions sheet says where the list is', note === `This page runs on ◆ ${name}. Open the Sessions list on that computer's own page.`, note);
    check('and no request was refused', !refused.length, refused);
    await stop(HOST);
    const label = () => page.evaluate(`${ROOT}.querySelector('.status .label').textContent`);
    const down = await waitFor(async () => (await label()) === `Reconnecting to ${name}…`);
    check('the panel says it is reconnecting to the paired computer', down, await label());
    await page.screenshot({ path: path.join(outDir, 'pair-reconnecting.png') });
    await start(HOST);
    const conn = await api(HOST, 'POST', '/connect', { cwd: project, target: `http://127.0.0.1:${site.address().port}` });
    const back = await waitFor(async () => !/Reconnecting/.test(await label()), 45000);
    check('the panel appears again automatically', back, await label());
    check('and still shows the host', await page.evaluate(`${ROOT}.querySelector('.host.on') !== null`));
    await page.screenshot({ path: path.join(outDir, 'pair-back.png') });

    const local = await browser.newPage();
    // The project's page on the host itself (the address /connect gave), not through pairing.
    await local.goto(conn.url);
    await local.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await sleep(800);
    check('a page on the same computer has no host chip', await local.evaluate(`${ROOT}.querySelector('.host.on') === null`));
  } finally {
    if (browser) await browser.close();
    await stop(HOST);
    await stop(REMOTE);
    site.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
