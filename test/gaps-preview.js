#!/usr/bin/env node
'use strict';
require('./isolate');
// Failures that must not be silent, in the browser: (1) the event stream gets a non-200 response
// (EditLens restarting behind a proxy): the panel says so, retries with longer waits and continues;
// (2) six VPS tasks at the same time and one refused: both pages and the summary show the waiting and refused
// tasks, and the waiting ones run once sessions are free; (3) the VPS stops and starts again while
// the laptop's page is open: its edits arrive again.
//   NODE_PATH=$(npm root -g) node test/gaps-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch } = require('./launch');
const { clientScript } = require('../lib/client-script');

const outDir = require('./out-dir')(process.argv[2] || 'gaps-out', 'node test/gaps-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-gaps-preview-'));
const vpsProject = path.join(base, 'shop');
const laptop = path.join(base, 'laptop-app');
const fake = path.join(base, 'fake');
const home = path.join(base, 'home');
// The laptop never opens its pairing port (it joins), so 4980 is only its setting.
const VPS = { port: 4981, pairPort: 4982, dir: path.join(base, 'vps') };
const LAPTOP = { port: 4983, pairPort: 4980, dir: path.join(base, 'laptop') };
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}
function start(s, extra = {}) {
  fs.mkdirSync(s.dir, { recursive: true });
  s.child = spawn(process.execPath, [SERVER], { env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, ...extra }, stdio: ['ignore', 'ignore', 'inherit'] });
  return waitFor(() => fetch(`http://127.0.0.1:${s.port}/health`).then((r) => r.ok, notRunning(false)));
}
function stop(s) {
  return new Promise((r) => {
    if (!s.child || s.child.exitCode !== null) return r();
    s.child.once('exit', r);
    s.child.kill();
  });
}
const api = (s, method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, {
  method, headers: { 'content-type': 'application/json', 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
const summary = (s, cwd) => fetch(`http://127.0.0.1:${s.port}/summary?cwd=${encodeURIComponent(cwd)}`).then((r) => r.json());

async function openPage(browser, url, errors) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  // Skip the tour; localStorage can throw in private mode.
  await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
  await page.goto(url);
  await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
  await page.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
  await sleep(400);
  const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  return { page, q };
}

// ---------- 1. the event stream, refused and then back ----------
async function streamRetry(browser, errors) {
  const INSTANCE = '0123456789abcdef';
  const hits = [];
  let refuse = 3; // the next requests that get a 503
  let live = null;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><html><head><title>App</title></head><body><h1>App</h1><script src="/live.js" data-root="/tmp/app"></script></body></html>');
    }
    if (u.pathname === '/live.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      return res.end(clientScript());
    }
    if (u.pathname === '/events') {
      hits.push({ at: Date.now(), since: u.searchParams.get('since'), lastEventId: req.headers['last-event-id'] || null });
      if (refuse > 0) {
        refuse--;
        res.writeHead(503, { 'content-type': 'text/plain' });
        return res.end('EditLens is restarting');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('retry: 300\n\n');
      res.write(`event: claude\ndata: ${JSON.stringify({ type: 'hello', version: require('../package.json').version, instance: INSTANCE, via: null, projects: [] })}\n\n`);
      res.write(`id: ${INSTANCE}.5\nevent: claude\ndata: ${JSON.stringify({ type: 'state', seq: 5, state: 'idle', ts: Date.now() })}\n\n`);
      live = res;
      return undefined;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end('{"error":"not found"}');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const { page, q } = await openPage(browser, `http://127.0.0.1:${srv.address().port}/`, errors);
    const status = () => q(`const s = r.querySelector('.status'); return s ? { off: s.classList.contains('offline'), text: s.lastChild.textContent } : null`);
    const note = await waitFor(async () => { const s = await status(); return s && /^Can't connect to EditLens\. Trying again in \d+ s$/.test(s.text) ? s.text : null; }, 8000);
    check('1. a 503 on the event stream: the panel says it can\'t connect and when it tries again', Boolean(note), note || await status());
    const hint = await q(`return r.querySelector('.hint') ? r.querySelector('.hint').textContent : null`);
    await page.screenshot({ path: path.join(outDir, 'gaps-1-cant-connect.png') });
    const back = await waitFor(async () => { const s = await status(); return s && !s.off; }, 20000);
    check('1. it keeps trying and connects once EditLens responds (no reload)', back, { hits: hits.length, status: await status(), hint });
    const gaps = hits.slice(1, 4).map((h, i) => h.at - hits[i].at);
    check('1. longer waits between tries', gaps.length === 3 && gaps[1] > gaps[0] && gaps[2] > gaps[1], gaps);
    // Closed again, now that it has events: it continues after the last one it has.
    refuse = 1;
    live.end();
    const resumed = await waitFor(() => hits.find((h, i) => i > 3 && h.since), 15000);
    check('1. opened again, it continues where it was (since=<instance>.<seq>)', Boolean(resumed) && resumed.since === `${INSTANCE}.5`, resumed);
    check('1. connected again', await waitFor(async () => { const s = await status(); return s && !s.off; }, 15000));
    await page.close();
  } finally {
    srv.closeAllConnections();
    srv.close();
  }
}

(async () => {
  const browser = await launch(chromium);
  const errors = [];
  try {
    await streamRetry(browser, errors);
  } catch (err) {
    check('1. stream retry ran', false, err.stack);
  }

  // ---------- 2 and 3: a VPS and a laptop, paired ----------
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  const exe = path.join(fake, 'bin', 'claude');
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
  fs.mkdirSync(home);
  fs.mkdirSync(vpsProject, { recursive: true });
  git(vpsProject, 'init', '-q', '-b', 'main');
  git(vpsProject, 'config', 'user.email', 't@example.com');
  git(vpsProject, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(vpsProject, 'faq.html'), '<h1>FAQ</h1>\n');
  fs.writeFileSync(path.join(vpsProject, '.gitignore'), '.claude/\n');
  git(vpsProject, 'add', '-A');
  git(vpsProject, 'commit', '-q', '-m', 'start');
  fs.mkdirSync(laptop, { recursive: true });
  fs.writeFileSync(path.join(laptop, 'index.html'), '<h1>Home</h1>\n');
  const vpsEnv = { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state'), HOME: home, USERPROFILE: home };
  await start(VPS, vpsEnv);
  await start(LAPTOP, { HOME: home, USERPROFILE: home });
  const site = (port, root) => http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>${path.basename(root)}</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>${path.basename(root)}</h1>
<script src="http://127.0.0.1:${port}/live.js" data-root="${root}"></script></body></html>`);
  });
  const lapSite = site(LAPTOP.port, laptop);
  const vpsSite = site(VPS.port, vpsProject);
  await new Promise((r) => lapSite.listen(0, '127.0.0.1', r));
  await new Promise((r) => vpsSite.listen(0, '127.0.0.1', r));
  const mod = await import(pathToFileURL(path.join(__dirname, '..', 'hooks', 'mod.mjs')).href);
  const lineText = (s) => mod.bandItems({ s, cols: 220 }).filter((it) => it.parts).map((it) => it.parts.map((p) => p.text).join('')).join(' | ');
  const detailRows = (s) => mod.detailsModel(s, { cols: 160 }).rows.map((r) => `${r.label}: ${r.parts.map((p) => p.text).join('')}`);
  try {
    await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, execPath: exe, ts: Date.now() });
    await api(LAPTOP, 'POST', '/event', { type: 'session', sessionId: 'lap', cwd: laptop, ts: Date.now() });
    const { code } = await api(VPS, 'POST', '/pair', { cwd: vpsProject });
    const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code });
    check('paired', joined.ok, joined);
    const vm = joined.host && joined.host.name;
    const lap = await openPage(browser, `http://127.0.0.1:${lapSite.address().port}/`, errors);
    const vps = await openPage(browser, `http://127.0.0.1:${vpsSite.address().port}/`, errors);
    // A task card (handoff 16.1): its label (the chip), status, why it waits (the Now line) or why it
    // didn't start (the warning), and its title.
    const cards = (t) => t.q(`return [...r.querySelectorAll('.k-task')].map((c) => ({ st: c.className.replace(/.*st-(\\w+).*/, '$1'), tst: (c.querySelector('.tst') || {}).textContent, title: (c.querySelector('.th .achip') || {}).textContent, note: [...c.querySelectorAll('.tnow, .twarn, .tnote')].map((n) => n.textContent).join(' '), prompt: (c.querySelector('.tt') || {}).textContent }))`);

    // ---------- 2. six tasks at the same time, and one refused ----------
    const ask = (prompt) => api(LAPTOP, 'POST', '/remote/task', { op: 'start', prompt, localDir: laptop, startId: crypto.randomBytes(8).toString('hex'), startPrompt: prompt });
    // Each keeps its session 20 s (starts are 3 s apart), so the two stay waiting while they are checked.
    const started = await Promise.all([1, 2, 3, 4, 5, 6].map(() => ask('hold 20000')));
    const states = started.map((x) => x.error || x.state);
    check('2. six at the same time: four start, two wait for a free session', states.filter((s) => s === 'waiting').length === 2 && states.filter((s) => s === 'starting' || s === 'working').length === 4, states);
    const refused = await ask('   ');
    check('2. an empty task is refused (the agent gets the error)', refused.error === 'Give the task: what Claude should do.', refused);
    const WAIT_NOTE = `Waiting · ${vm} is running 4 tasks. It starts when one of them finishes.`;
    // On a card the status already says "Waiting": the Now line is the rest of the note.
    const WAIT_NOW = WAIT_NOTE.replace(/^Waiting · /, '');
    // The summary: the line above the prompt and Details, on both computers.
    const ls = await waitFor(async () => { const s = await summary(LAPTOP, laptop); return s.tasksWaiting === 2 && s.taskNotices.some((n) => n.state === 'refused') ? s : null; }, 10000) || await summary(LAPTOP, laptop);
    check('2. laptop summary: tasksWaiting 2, and the refused start', ls.tasksWaiting === 2 && ls.taskNotices.some((n) => n.state === 'refused' && n.text === 'Didn\'t start · Give the task: what Claude should do.'), { tasksWaiting: ls.tasksWaiting, taskNotices: ls.taskNotices });
    const line = lineText(ls);
    check('2. laptop: the line above the prompt shows it', /(! Task waiting on ◆ \S+|✕ Task on ◆ \S+ didn't start)( · 2 more in Details)?/.test(line), line);
    const rows = detailRows(ls);
    check('2. laptop: Details lists them', rows.some((r) => /^Tasks: /.test(r)) && rows.some((r) => r.includes(WAIT_NOTE)) && rows.some((r) => r.includes('Didn\'t start · Give the task')), rows.filter((r) => /Tasks|Waiting|start/.test(r)));
    const vs = await summary(VPS, vpsProject);
    check('2. VPS summary: tasksWaiting 2, and the refused start', vs.tasksWaiting === 2 && vs.taskNotices.some((n) => n.state === 'refused'), { tasksWaiting: vs.tasksWaiting, taskNotices: vs.taskNotices });
    check('2. VPS: the line above the prompt shows it', /(! Task from ◆ \S+ waiting|✕ Task from ◆ \S+ didn't start)/.test(lineText(vs)), lineText(vs));
    // The pages.
    const lapCards = await waitFor(async () => { const c = await cards(lap); return c.filter((x) => x.st === 'waiting').length === 2 && c.some((x) => x.st === 'refused') ? c : null; }, 15000);
    check('2. laptop page: two "Waiting" cards that say why', Boolean(lapCards) && lapCards.filter((x) => x.st === 'waiting').every((x) => x.tst === 'Waiting' && x.note === WAIT_NOW && x.title === `◆ ${vm} · Task`), lapCards || await cards(lap));
    check('2. laptop page: a "Didn\'t start" card with the reason', Boolean(lapCards) && lapCards.some((x) => x.st === 'refused' && x.tst === 'Didn\'t start' && x.note === 'Give the task: what Claude should do.'), lapCards);
    const vpsCards = await waitFor(async () => { const c = await cards(vps); return c.filter((x) => x.st === 'waiting').length === 2 && c.some((x) => x.st === 'refused') ? c : null; }, 15000);
    check('2. VPS page: the same two waiting tasks and the refused one', Boolean(vpsCards) && vpsCards.filter((x) => x.st === 'waiting').every((x) => x.note === WAIT_NOW) && vpsCards.some((x) => x.st === 'refused' && x.tst === 'Didn\'t start' && /Give the task/.test(x.note)), vpsCards || await cards(vps));
    await lap.page.screenshot({ path: path.join(outDir, 'gaps-2-laptop-waiting.png') });
    await vps.page.screenshot({ path: path.join(outDir, 'gaps-2-vps-waiting.png') });
    // The four finish: the two waiting ones run (the finished ones' sessions close for them).
    const DONE = ['idle', 'ended'];
    const ran = await waitFor(async () => { const c = (await cards(lap)).filter((x) => x.st !== 'refused'); return c.length === 6 && c.every((x) => DONE.includes(x.st)) && c.filter((x) => x.st === 'idle').length >= 2 ? c : null; }, 90000);
    check('2. the waiting ones run once sessions are free; all six finish', Boolean(ran), await cards(lap));
    const after = await summary(LAPTOP, laptop);
    check('2. nothing waits any more (summary)', after.tasksWaiting === 0, after.taskNotices);
    await lap.page.screenshot({ path: path.join(outDir, 'gaps-2-laptop-done.png') });

    // ---------- 3. the VPS stops while the page is open, and starts again ----------
    await stop(VPS);
    const down = await waitFor(async () => { const s = await summary(LAPTOP, laptop); const j = s.paired && s.paired.joined && s.paired.joined[0]; return j && j.state !== 'connected' && typeof j.error === 'string' && j.error ? s : null; }, 45000);
    const j = down && down.paired.joined[0];
    check('3. the summary says the paired computer is not connected, and why', Boolean(down), j || (await summary(LAPTOP, laptop)).paired);
    if (down) {
      check('3. the line says so', new RegExp(`◆ ${vm} · (reconnecting|can't connect)`).test(lineText(down)), lineText(down));
      check('3. Details says so', detailRows(down).some((r) => r.includes(`◆ ${vm}`) && r.includes('is not responding (EditLens there is stopped') && r.endsWith('Trying again.')), detailRows(down).filter((r) => r.includes('◆')));
    }
    // Longer than the old 5 tries (about 30 s) before it starts again.
    await sleep(32000);
    await start(VPS, vpsEnv);
    await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, execPath: exe, ts: Date.now() });
    await api(VPS, 'POST', '/event', { type: 'change', sessionId: 'v1', cwd: vpsProject, file: path.join(vpsProject, 'faq.html'), tool: 'Edit', intent: 'back: rename the FAQ', stats: { added: 1, removed: 1 }, before: '<h1>FAQ</h1>\n', after: '<h1>Help</h1>\n', hunks: [{ oldStart: 1, newStart: 1, lines: ['-<h1>FAQ</h1>', '+<h1>Help</h1>'] }], ts: Date.now() });
    const shown = await waitFor(() => lap.q(`return [...r.querySelectorAll('.k-edit .why')].some((x) => x.textContent === 'back: rename the FAQ')`), 45000);
    check('3. once it is back, its edits show on the page that stayed open', shown);
    const up = await waitFor(async () => { const s = await summary(LAPTOP, laptop); const x = s.paired.joined[0]; return x && x.state === 'connected' && !x.error ? s : null; }, 20000);
    check('3. the line is back to normal', Boolean(up) && !/reconnecting|can't connect/.test(lineText(up)), up ? lineText(up) : null);
    await lap.page.screenshot({ path: path.join(outDir, 'gaps-3-back.png') });
    check('no page errors', !errors.length, errors);
  } finally {
    await browser.close();
    lapSite.close();
    vpsSite.close();
    await stop(VPS);
    await stop(LAPTOP);
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
