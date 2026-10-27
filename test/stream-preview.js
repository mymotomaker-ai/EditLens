#!/usr/bin/env node
'use strict';
require('./isolate');
// Every edit streams live to the laptop's page, as in real use: page control from the page, a
// subagent, and the paired VPS running a "mine" and a "theirs" task with Follow on "Everyone"; then
// the laptop's server is replaced (an update), the VPS's restarts and a second page opens: edits
// keep arriving live, in order, without a reload. Stand-in SDK (test/fixtures/fake-sdk.mjs).
//   NODE_PATH=$(npm root -g) node test/stream-preview.js <out-dir>
//   STREAM_VIA=ssh: pair through an SSH tunnel (test/fixtures/fake-ssh.js), not the pairing port.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'stream-out', 'node test/stream-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const PLUGIN = path.join(__dirname, '..');
const SERVER = path.join(PLUGIN, 'server', 'server.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-stream-preview-'));
const vpsProject = path.join(base, 'shop');
const laptop = path.join(base, 'laptop-app');
const fake = path.join(base, 'fake');
const home = path.join(base, 'home'); // no installed plugin here: page control passes this copy
const VPS = { port: 5211, pairPort: 5212, dir: path.join(base, 'vps') };
const LAPTOP = { port: 5213, pairPort: 5214, dir: path.join(base, 'laptop') };
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
const env = (s) => ({ EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir });
// The environment without a surrounding Claude Code session's (run from one, its claude would be
// reported and used in place of the stand-in), so it runs as on CI.
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
function start(s, extra = {}) {
  fs.mkdirSync(s.dir, { recursive: true });
  s.child = spawn(process.execPath, [SERVER], { env: { ...ownEnv, ...env(s), ...extra }, stdio: ['ignore', 'ignore', 'inherit'] });
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
const task = (body) => api(LAPTOP, 'POST', '/remote/task', { localDir: laptop, ...body });
// One file edit reported by Claude Code's hook on that server.
function edit(s, sessionId, cwd, file, from, to, intent) {
  return api(s, 'POST', '/event', { type: 'change', sessionId, cwd, file, tool: 'Edit', intent, stats: { added: 1, removed: 1 }, before: from, after: to,
    hunks: [{ oldStart: 1, newStart: 1, lines: ['-' + from.trimEnd(), '+' + to.trimEnd()] }], ts: Date.now() });
}

(async () => {
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

  // Its tasks' Claude runs the plugin's hooks too (FAKE_SDK_HOOKS), as Claude Code would.
  const vpsEnv = { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state'), FAKE_SDK_HOOKS: '1', HOME: home, USERPROFILE: home };
  // The laptop: page control with the stand-in SDK, whose writes run this plugin's hooks.
  const viaSsh = process.env.STREAM_VIA === 'ssh';
  const lapEnv = { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), EDITLENS_CLAUDE_PATH: exe, FAKE_CLAUDE_STATE: path.join(fake, 'state'), FAKE_SDK_HOOKS: '1', HOME: home, USERPROFILE: home,
    ...(viaSsh ? { EDITLENS_SSH: path.join(__dirname, 'fixtures', 'fake-ssh.js') } : {}) };
  // The laptop's app, with EditLens added by the middleware (integrations/middleware.js).
  const mw = require('../integrations/middleware')({ port: LAPTOP.port, root: laptop });
  const site = http.createServer((req, res) => mw(req, res, () => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><html><head><title>Home</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Home</h1></body></html>');
  }));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const siteUrl = `http://127.0.0.1:${site.address().port}/`;
  let browser = null;
  const errors = [];
  const openPage = async () => {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await page.goto(siteUrl);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await page.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
    await sleep(600);
    return page;
  };
  const tools = (page) => {
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    return {
      q,
      // The edit cards' captions, top to bottom.
      captions: () => q(`return [...r.querySelectorAll('.k-edit .why')].map((x) => x.textContent)`),
      has: (intent) => q(`return [...r.querySelectorAll('.k-edit .why')].some((x) => x.textContent === ${JSON.stringify(intent)})`),
      // The files shown now, and whose edit each is (the path never names the paired computer: the
      // pane's agent chip does, handoff 15.1).
      panes: () => q(`return [...r.querySelectorAll('.pane.on')].map((p) => { const w = p.closest('.pgrp') && p.closest('.pgrp').querySelector('.pinfo .who.on .achip'); return { path: p.getAttribute('data-path'), who: w ? w.textContent : '' }; })`),
      // Every file open in the code view: Follow opens each edit as a tab in the following pane (15.1).
      opened: () => q(`return [...r.querySelectorAll('.dock .pgrp .ptabs .tab')].map((x) => x.title)`),
      rows: () => q(`const h = r.querySelector('.swhead'); if (h && h.getAttribute('aria-expanded') !== 'true') h.click(); return [...r.querySelectorAll('.arow .rt b')].map((b) => b.textContent)`),
      follow: () => q(`const h = r.querySelector('.dock .dhead .fhead'); return h ? h.textContent : null;`),
      // The followed agent's key (names have no task ids).
      followKey: () => q(`const h = r.querySelector('.dock .dhead .fhead'); return h ? h.getAttribute('data-key') : null;`),
      rowKeys: () => q(`const h = r.querySelector('.swhead'); if (h && h.getAttribute('aria-expanded') !== 'true') h.click(); return [...r.querySelectorAll('.arow')].map((x) => x.getAttribute('data-key'))`),
      connected: () => q(`const s = r.querySelector('.status'); return s && !s.classList.contains('offline')`),
    };
  };
  // How long an edit takes to show on the page: ms, or null when it never does.
  const shows = async (t, intent, ms = 8000) => {
    const at = Date.now();
    return (await waitFor(() => t.has(intent), ms)) ? Date.now() - at : null;
  };
  const sendFromPage = (t, text) => t.q(`const x = r.querySelector('.composer textarea'); x.value = ${JSON.stringify(text)}; x.dispatchEvent(new Event('input')); r.querySelector('.send').click(); return true;`);
  const pageControl = async (t) => {
    // The claude the laptop's server runs: with none found (CI has no claude), drive.js would
    // download the real SDK over the stand-in, and page control and the tasks would fail.
    const out = spawnSync(process.execPath, [path.join(PLUGIN, 'bin', 'drive.js'), 'new'], { cwd: laptop, encoding: 'utf8',
      env: { ...ownEnv, ...env(LAPTOP), EDITLENS_SDK_DIR: path.join(fake, 'sdk'), EDITLENS_CLAUDE_PATH: exe, CLAUDE_PROJECT_DIR: laptop } });
    const ready = await waitFor(() => t.q(`const b = r.querySelector('.drivebar.on'); return Boolean(b) && !/Starting/.test(b.querySelector('.t').textContent)`), 20000);
    return { ready, out: (out.stdout + out.stderr).trim().slice(0, 300) };
  };
  try {
    await start(VPS, vpsEnv);
    await start(LAPTOP, lapEnv);
    browser = await launch(chromium, {}, [VPS.child, LAPTOP.child]);
    await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, execPath: exe, ts: Date.now() });
    await api(LAPTOP, 'POST', '/event', { type: 'session', sessionId: 'lap', cwd: laptop, ts: Date.now() });
    const { code } = await api(VPS, 'POST', '/pair', { cwd: vpsProject });
    const key = path.join(base, 'id_test');
    fs.writeFileSync(key, 'not a real key');
    const joined = await api(LAPTOP, 'POST', '/join', viaSsh ? { address: `tester@127.0.0.1:${VPS.pairPort}`, code, key } : { address: `127.0.0.1:${VPS.pairPort}`, code });
    check(viaSsh ? 'paired through SSH' : 'paired', joined.ok && (!viaSsh || /through SSH/.test(joined.host.address)), joined);
    const vm = joined.host && joined.host.name;

    const page = await openPage();
    const t = tools(page);
    const pc = await pageControl(t);
    check('page control is on (the stand-in SDK)', pc.ready, pc.out);

    // Both VPS tasks start while Claude works from the page.
    const remotework = require('../lib/remotework');
    const sent = await remotework.sendAndStart((op, extra) => task({ op, ...extra }), { dir: laptop, prompt: 'Add an about page', stateDir: LAPTOP.dir });
    const ws = sent.workspace && sent.workspace.folder;
    const theirs = await task({ op: 'start', prompt: 'Tidy the FAQ' });
    const tws = theirs.workspace && theirs.workspace.folder;
    check('"mine" and "theirs" tasks started on the VPS', Boolean(ws && tws), { sent: Boolean(ws), theirs: Boolean(tws) });
    // Every step below edits in these tasks' folders.
    if (!ws || !tws) throw new Error(`the VPS tasks did not start, so the rest can't run: ${JSON.stringify({ sent: sent.error || null, theirs: theirs.error || null })}`);

    // (1) Everything at the same time: Claude from the page, its subagent, and both tasks, interleaved.
    const expected = [];
    const timing = {};
    const step = async (label, intent, act) => {
      expected.push(intent);
      await act();
      timing[label] = await shows(t, intent);
    };
    await step('page control: main 1', 'Writing about.html: <h1>About</h1>', () => sendFromPage(t, 'write about.html <h1>About</h1>'));
    await step('VPS "mine" 1', 'mine: link the about page', () => edit(VPS, 'mine-s', ws, path.join(ws, 'index.html'), '<h1>Home</h1>\n', '<h1>Home</h1><a href="about.html">About</a>\n', 'mine: link the about page'));
    await step('page control: subagent', 'Writing styles.css: h1{color:teal}', () => sendFromPage(t, 'agent a1b2c3 write styles.css h1{color:teal}'));
    await step('VPS "theirs" 1', 'theirs: rename the FAQ', () => edit(VPS, 'theirs-s', tws, path.join(tws, 'faq.html'), '<h1>FAQ</h1>\n', '<h1>Questions</h1>\n', 'theirs: rename the FAQ'));
    await step('page control: main 2', 'Writing about.html: <h1>About us</h1>', () => sendFromPage(t, 'write about.html <h1>About us</h1>'));
    for (const [label, ms] of Object.entries(timing)) check(`live: ${label}`, ms !== null, ms);
    const order = (await t.captions()).filter((c) => expected.includes(c));
    check('in the order they were made', JSON.stringify(order) === JSON.stringify(expected), order);
    check('the driven Claude\'s edits came from the plugin\'s hooks in its session', !fs.existsSync(path.join(fake, 'state', 'nohooks')));
    const panes = await waitFor(async () => { const p = await t.panes(); return p.some((x) => /about\.html$/.test(x.path) && !x.who.includes('◆')) ? p : null; }, 5000);
    check('the code view shows the main agent\'s edit (Follow "Everyone")', Boolean(panes) && /^Following everyone$/.test(String(await t.follow())), { panes, follow: await t.follow() });
    const rows = await t.rows();
    check('Agents switcher: a row per VPS task', rows.filter((x) => x.startsWith(`◆ ${vm}`)).length >= 2, rows);
    await page.screenshot({ path: path.join(outDir, 'stream-1-all.png') });

    // (1b) Three tasks of each kind started at the same time (the laptop's Claude asking for them together),
    // each Claude editing through the plugin's hooks on the VPS: every one streams live.
    const many = async (kind) => {
      const prompts = [1, 2, 3].map((i) => `write ${kind}${i}.html <h1>${kind} ${i}</h1>`);
      const started = await Promise.all(prompts.map((prompt) => (kind === 'mine'
        ? remotework.sendAndStart((op, extra) => task({ op, ...extra }), { dir: laptop, prompt, stateDir: LAPTOP.dir })
        : task({ op: 'start', prompt }))));
      check(`three "${kind}" tasks started together`, started.every((x) => x && x.task), started.map((x) => x && (x.task || x.error)));
      const missing = [];
      for (const i of [1, 2, 3]) if ((await shows(t, `Writing ${kind}${i}.html: <h1>${kind} ${i}</h1>`, 30000)) === null) missing.push(i);
      check(`all three "${kind}" tasks' edits stream live`, !missing.length, { missing, captions: (await t.captions()).filter((c) => c.includes(kind)) });
      const ids = started.map((x) => x && x.task).filter(Boolean);
      // A row can follow its task's first edit by a moment: wait for it (up to 5 s).
      const r = (await waitFor(async () => { const k = await t.rowKeys(); return ids.every((id) => k.includes(`r:${vm}:${id}`)) ? k : null; }, 5000)) || await t.rowKeys();
      check(`a row per "${kind}" task in the Agents switcher`, ids.every((id) => r.includes(`r:${vm}:${id}`)), r);
      const p = await waitFor(async () => { const all = await t.opened(); const on = await t.panes(); return [1, 2, 3].every((i) => all.some((x) => x.endsWith(`${kind}${i}.html`))) && on.some((x) => x.who.includes(`◆ ${vm}`)) ? { all, on } : null; }, 3000);
      check(`the code view (Everyone) has each "${kind}" task's file`, Boolean(p), { opened: await t.opened(), shown: await t.panes() });
      return started;
    };
    const three = await many('theirs');
    await many('mine');
    // Following one task (its row) while another edits: both cards still come live; the code
    // view shows the followed one's edit.
    const [a1, a2] = three.map((x) => x && x.task).filter(Boolean);
    if (a1 && a2) {
      await t.q(`const row = r.querySelector('.arow[data-key="r:${vm}:${a1}"]'); if (row) row.click(); return Boolean(row);`);
      await sleep(300);
      check('Follow is on the clicked task', (await t.followKey()) === `r:${vm}:${a1}`, await t.followKey());
      await task({ op: 'send', task: a2, text: 'write other.html <h1>Other</h1>' });
      await task({ op: 'send', task: a1, text: 'write followed.html <h1>Followed</h1>' });
      check('following one task: the other task\'s edit still streams to the list', (await shows(t, 'Writing other.html: <h1>Other</h1>', 15000)) !== null);
      check('following one task: its own edit streams to the list', (await shows(t, 'Writing followed.html: <h1>Followed</h1>', 15000)) !== null);
      const fp = await waitFor(async () => { const all = await t.panes(); return all.some((x) => x.path.endsWith('followed.html') && x.who.includes(`◆ ${vm}`)) ? all : null; }, 5000);
      check('following one task: the code view shows its edit', Boolean(fp), await t.panes());
      // Everyone is in the Follow menu (the chip next to the file name opens it).
      await t.q(`r.querySelector('.dock .dhead .fhead').click(); return true;`);
      await waitFor(() => t.q(`return Boolean(r.querySelector('.lwrap .follow .fchip[data-mode="all"]'))`), 3000);
      await t.q(`const c = r.querySelector('.lwrap .follow .fchip[data-mode="all"]'); if (c) c.click(); return Boolean(c);`);
      await waitFor(async () => /^Following everyone$/.test(String(await t.follow())), 3000);
      check('back on "Everyone"', /^Following everyone$/.test(String(await t.follow())), await t.follow());
    }
    await page.screenshot({ path: path.join(outDir, 'stream-1b-three-tasks.png') });

    // (2) The laptop's server is replaced (an update) while the page stays open.
    const oldSeqs = new Set((await api(LAPTOP, 'GET', '/history')).filter((e) => e.type === 'change').map((e) => e.seq));
    await stop(LAPTOP);
    await start(LAPTOP, lapEnv);
    const back = await waitFor(() => t.connected(), 15000);
    check('the page reconnects to the new server by itself', back);
    // Claude in a terminal (hooks) on the laptop, after the restart.
    await api(LAPTOP, 'POST', '/event', { type: 'session', sessionId: 'lap', cwd: laptop, ts: Date.now() });
    const after1 = { 'laptop hook': null, 'VPS "mine"': null, 'VPS "theirs"': null };
    await edit(LAPTOP, 'lap', laptop, path.join(laptop, 'index.html'), '<h1>Home</h1>\n', '<h1>Welcome</h1>\n', 'laptop: after the restart');
    after1['laptop hook'] = await shows(t, 'laptop: after the restart');
    await edit(VPS, 'mine-s', ws, path.join(ws, 'index.html'), '<h1>Home</h1>\n', '<h1>Hi</h1>\n', 'mine: after the laptop restart');
    after1['VPS "mine"'] = await shows(t, 'mine: after the laptop restart');
    await edit(VPS, 'theirs-s', tws, path.join(tws, 'faq.html'), '<h1>Questions</h1>\n', '<h1>Q&A</h1>\n', 'theirs: after the laptop restart');
    after1['VPS "theirs"'] = await shows(t, 'theirs: after the laptop restart');
    for (const [label, ms] of Object.entries(after1)) check(`after the laptop's server restarts: ${label} live (no reload)`, ms !== null, ms);
    const link = await api(LAPTOP, 'GET', '/pair').catch((err) => ({ error: err.message }));
    const linkUp = await waitFor(async () => { const p = await api(LAPTOP, 'GET', '/pair'); return p.remotes && p.remotes.hosts.some((h) => h.name === vm && h.state === 'connected') ? p : null; }, 10000);
    check('the computers connect again automatically', Boolean(linkUp), link);
    // Page control on the new server, from the same page.
    const pc2 = await pageControl(t);
    check('page control again after the restart', pc2.ready, pc2.out);
    if (pc2.ready) {
      await sendFromPage(t, 'write contact.html <h1>Contact</h1>');
      check('after the restart: page control edits live', (await shows(t, 'Writing contact.html: <h1>Contact</h1>')) !== null);
    }
    const dupes = (await t.captions()).filter((c, i, all) => all.indexOf(c) !== i);
    check('no edit shown twice after the restart', !dupes.length, dupes);
    // Edits on the new server until one has the number an edit on the old one had.
    for (let i = 0; i < 40; i++) {
      const h = await api(LAPTOP, 'GET', '/history');
      if (h.some((e) => e.type === 'change' && oldSeqs.has(e.seq) && !e.earlier)) break;
      await edit(LAPTOP, 'lap', laptop, path.join(laptop, 'index.html'), '<h1>Welcome</h1>\n', '<h1>Welcome</h1>\n', `laptop: number ${i}`);
    }
    await sleep(800);
    const nos = await t.q(`return [...r.querySelectorAll('.k-edit .eno')].map((x) => x.textContent)`);
    check('each edit keeps its own number after the restart (the new server counts from 1 again)', new Set(nos).size === nos.length, nos);
    await page.screenshot({ path: path.join(outDir, 'stream-2-laptop-restart.png') });

    // (3) The VPS's server restarts.
    await stop(VPS);
    await start(VPS, vpsEnv);
    await edit(VPS, 'theirs-s', tws, path.join(tws, 'faq.html'), '<h1>Q&A</h1>\n', '<h1>Help</h1>\n', 'theirs: after the VPS restart');
    check('after the VPS\'s server restarts: its edits live', (await shows(t, 'theirs: after the VPS restart', 45000)) !== null);

    // (4) A second page: both show the next edits.
    const page2 = await openPage();
    const t2 = tools(page2);
    await edit(LAPTOP, 'lap', laptop, path.join(laptop, 'index.html'), '<h1>Welcome</h1>\n', '<h1>Hello</h1>\n', 'laptop: two pages');
    await edit(VPS, 'theirs-s', tws, path.join(tws, 'faq.html'), '<h1>Help</h1>\n', '<h1>Support</h1>\n', 'theirs: two pages');
    for (const [n, x] of [['first', t], ['second', t2]]) {
      check(`two pages: the ${n} shows the laptop's edit`, (await shows(x, 'laptop: two pages')) !== null);
      check(`two pages: the ${n} shows the VPS's edit`, (await shows(x, 'theirs: two pages')) !== null);
    }
    check('no page errors', !errors.length, errors);
  } finally {
    if (browser) await browser.close();
    site.close();
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
