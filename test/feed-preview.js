#!/usr/bin/env node
'use strict';
require('./isolate');
// The laptop's page while its main agent works and the paired VPS runs two of its tasks ("mine" on
// a copy of the laptop's project, "theirs" on the VPS's own): every edit appears live in the edit
// list and code view, Follow "Everyone" follows all three, each task has its own Agents row, the
// computer is named once per label, and the notes say where each edit is. Stand-in SDK (test/fixtures).
//
//   NODE_PATH=$(npm root -g) node test/feed-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'feed-out', 'node test/feed-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-feed-preview-'));
const vpsProject = path.join(base, 'shop');
const laptop = path.join(base, 'laptop-app');
const fake = path.join(base, 'fake');
const VPS = { port: 4974, pairPort: 4975, dir: path.join(base, 'vps') };
const LAPTOP = { port: 4976, pairPort: 4977, dir: path.join(base, 'laptop') };
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A task id (12 or more hex characters, as server/tasks.js makes them) in a label. The computer's
// name is left out first: a host name like vps-123456 has hex digits in it.
const hasId = (text, host, ids) => ids.some((id) => id && text.includes(id)) || /[0-9a-f]{12,}/.test(text.split(host || '\u0000').join(''));
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
  s.child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, ...extra }, stdio: 'ignore',
  });
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
// The laptop's Claude asks the VPS (the live-page MCP tools do this).
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
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
  // The VPS's own project (a git project: its tasks work in a copy of it).
  fs.mkdirSync(vpsProject, { recursive: true });
  git(vpsProject, 'init', '-q', '-b', 'main');
  git(vpsProject, 'config', 'user.email', 't@example.com');
  git(vpsProject, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(vpsProject, 'faq.html'), '<h1>FAQ</h1>\n');
  fs.writeFileSync(path.join(vpsProject, '.gitignore'), '.claude/\n');
  git(vpsProject, 'add', '-A');
  git(vpsProject, 'commit', '-q', '-m', 'start');
  // The laptop's project: the main agent's, with its own page.
  fs.mkdirSync(laptop, { recursive: true });
  fs.writeFileSync(path.join(laptop, 'index.html'), '<h1>Home</h1>\n');
  fs.writeFileSync(path.join(laptop, 'contact.html'), '<h1>Contact</h1>\n');

  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Home</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Home</h1>
<script src="http://127.0.0.1:${LAPTOP.port}/live.js" data-root="${laptop}"></script></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const vpsSite = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Shop</title></head><body><h1>FAQ</h1>
<script src="http://127.0.0.1:${VPS.port}/live.js" data-root="${vpsProject}"></script></body></html>`);
  });
  await new Promise((r) => vpsSite.listen(0, '127.0.0.1', r));
  let browser = null;
  const errors = [];
  try {
    await start(VPS, { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state') });
    await start(LAPTOP);
    browser = await launch(chromium, {}, [VPS.child, LAPTOP.child]);
    await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
    await api(LAPTOP, 'POST', '/event', { type: 'session', sessionId: 'lap', cwd: laptop, ts: Date.now() });
    const { code } = await api(VPS, 'POST', '/pair', { cwd: vpsProject });
    const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code });
    check('paired', joined.ok, joined);
    const vm = joined.host && joined.host.name;

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await page.goto(`http://127.0.0.1:${site.address().port}/`);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await page.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
    await sleep(800);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const card = (intent) => q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => x.querySelector('.why') && x.querySelector('.why').textContent === ${JSON.stringify(intent)});
      return c ? { note: [...c.querySelectorAll('.enote')].map((n) => n.textContent).join(' | '), file: c.querySelector('.file').textContent.replace(/\\u200e/g, ''),
        who: c.querySelector('.ewho .achip') ? c.querySelector('.ewho .achip').textContent : '', text: c.textContent } : null;`);
    // The panes the code view shows (split: several) and whose edit each is. The path never names
    // the paired computer (handoff 15.1): the pane's agent chip does.
    const panes = () => q(`return [...r.querySelectorAll('.pane.on')].map((p) => { const w = p.closest('.pgrp') && p.closest('.pgrp').querySelector('.pinfo .who.on .achip'); return { path: p.getAttribute('data-path'), who: w ? w.textContent : '' }; });`);
    const pane = async (re, onVm) => (await panes()).find((p) => re.test(p.path) && (onVm ? p.who.includes(`◆ ${vm}`) : !p.who.includes('◆'))) || null;
    const follow = () => q(`const h = r.querySelector('.dock .dhead .fhead'); return h ? h.textContent : null;`);
    // The Follow menu's rows (it is drawn when opened).
    const followRows = async () => {
      await q(`r.querySelector('.dock .dhead .fhead').click(); return true;`);
      const rows = await waitFor(() => q(`const m = r.querySelector('.lwrap .follow'); return m ? [...m.querySelectorAll('.fchip')].map((b) => b.textContent) : null;`), 3000);
      await page.keyboard.press('Escape');
      return rows || [];
    };

    // (a) The laptop's own Claude edits its project.
    const lapAt = Date.now();
    await edit(LAPTOP, 'lap', laptop, path.join(laptop, 'contact.html'), '<h1>Contact</h1>\n', '<h1>Contact us</h1>\n', 'Laptop: contact heading');
    const own = await waitFor(() => card('Laptop: contact heading'), 5000);
    check('(a) the laptop\'s own edit shows live in the edit list', Boolean(own), { own, ms: Date.now() - lapAt });
    // The code view shows the path inside the project.
    const ownPane = await waitFor(() => pane(/^contact\.html$/), 8000);
    check('(a) and in the code view', Boolean(ownPane), ownPane);
    check('Follow is on "Everyone"', /^Following everyone$/.test(String(await follow())), await follow());

    // (b) "mine": a task on a copy of the laptop's project, sent to the VPS.
    const remotework = require('../lib/remotework');
    const sent = await remotework.sendAndStart((op, extra) => task({ op, ...extra }), { dir: laptop, prompt: 'Add an about page', stateDir: LAPTOP.dir });
    check('"mine" task started on the VPS', Boolean(sent.task), sent);
    const ws = sent.workspace.folder;
    const mineAt = Date.now();
    await edit(VPS, 'mine-s', ws, path.join(ws, 'index.html'), '<h1>Home</h1>\n', '<h1>Home</h1><a href="about.html">About</a>\n', 'VPS mine: link the about page');
    const mine = await waitFor(() => card('VPS mine: link the about page'), 8000);
    check('(b) the "mine" task\'s edit shows live on the laptop page', Boolean(mine), { mine, ms: Date.now() - mineAt });
    const minePane = await waitFor(() => pane(/^index\.html$/, true), 8000);
    check('(b) and in the code view, Follow "Everyone"', Boolean(minePane), minePane);

    // (b) "theirs": a task on a copy of the VPS's own project.
    const theirs = await task({ op: 'start', prompt: 'Tidy the FAQ' });
    check('"theirs" task started on the VPS', Boolean(theirs.task), theirs);
    const tws = theirs.workspace && theirs.workspace.folder;
    const theirsAt = Date.now();
    await edit(VPS, 'theirs-s', tws, path.join(tws, 'faq.html'), '<h1>FAQ</h1>\n', '<h1>Questions</h1>\n', 'VPS theirs: rename the FAQ');
    const their = await waitFor(() => card('VPS theirs: rename the FAQ'), 8000);
    check('(b) the "theirs" task\'s edit shows live on the laptop page', Boolean(their), { their, ms: Date.now() - theirsAt });
    const theirPane = await waitFor(() => pane(/^faq\.html$/, true), 8000);
    check('(b) and in the code view', Boolean(theirPane), theirPane);

    // Plain notes; the agent label names the computer, once on each card (handoff 12.1, 14).
    check('"mine" note: in a copy of this project, not in your files yet', Boolean(mine) && mine.note === 'In a copy of this project. Not in your files yet: Claude adds it when the task is done.', mine && mine.note);
    check('"theirs" note: in a copy of its project, merged when done', Boolean(their) && their.note === 'In a copy of its project. Not in its project yet: Claude merges it when the task is done.', their && their.note);
    check('edit cards: the label "◆ vm · Task", the computer named once, no id', [mine, their].every((c) => c && c.who === `◆ ${vm} · Task` && c.text.split(`◆ ${vm}`).length === 2 && !c.text.includes(sent.task.slice(0, 6)) && !c.text.includes(theirs.task.slice(0, 6))), [mine, their]);
    check('code view header names the computer once (in the chip), no id', Boolean(minePane) && (minePane.path + ' ' + minePane.who).split(`◆ ${vm}`).length === 2 && minePane.who === `◆ ${vm} · Task`, minePane);

    // A task card's files say where they are in one short line; the full sentence is its ⓘ (hover,
    // tap, and its accessible name), handoff 16.1. A finished card folds once something newer is
    // below it: opened here to read it.
    const taskNotes = await waitFor(() => q(`r.querySelectorAll('.k-task.folded').forEach((c) => c.click()); const n = [...r.querySelectorAll('.k-task .twhere')].map((x) => x.getAttribute('aria-label') || '').filter((t) => t.includes('◆'));
      return n.length >= 2 ? n : null;`), 8000);
    check('task cards: the same plain notes', Boolean(taskNotes) && taskNotes.some((t) => t.includes(`On ◆ ${vm}, in a copy of this project. Not in your files yet: Claude adds them when the task is done.`))
      && taskNotes.some((t) => t.includes(`On ◆ ${vm}, in a copy of its project. Not in its project yet: Claude merges them`)), taskNotes);

    // The Agents switcher: each task is its own row, the computer named once.
    await q(`const h = r.querySelector('.swhead'); if (h && h.getAttribute('aria-expanded') !== 'true') h.click(); return true;`);
    await sleep(400);
    const rows = await q(`return [...r.querySelectorAll('.arow .rt b')].map((b) => b.textContent)`);
    const taskRows = rows.filter((x) => x.startsWith(`◆ ${vm}`));
    const rowKeys = await q(`return [...r.querySelectorAll('.arow')].map((x) => x.getAttribute('data-key'))`);
    check('the Agents switcher has a row per VPS task, no ids in the names', rowKeys.includes(`r:${vm}:${sent.task}`) && rowKeys.includes(`r:${vm}:${theirs.task}`) && !rows.some((x) => hasId(x, vm, [sent.task, theirs.task])), { rows, rowKeys });
    check('each row names the computer once', taskRows.length >= 2 && taskRows.every((x) => x.split('◆').length === 2), taskRows);
    const chips = await followRows();
    check('Follow lists both tasks', chips.filter((x) => x.includes(`◆ ${vm}`)).length >= 2, chips);
    const agentCards = await q(`return [...r.querySelectorAll('.k-agent')].map((c) => c.querySelector('.adesc').textContent + ' / ' + c.querySelector('.atype').textContent)`);
    const agentChips = await q(`return [...r.querySelectorAll('.agents .agrow .achip')].map((c) => c.textContent).filter((t) => t.includes('◆'))`);
    check('agent labels name the computer once', agentChips.length >= 2 && agentChips.every((x) => x.split('◆').length === 2), agentChips);
    const remoteCards = agentCards.filter((x) => x.includes('◆'));
    check('agent cards name the computer once', remoteCards.length >= 2 && remoteCards.every((x) => x.split('◆').length === 2), agentCards);
    await page.screenshot({ path: path.join(outDir, 'laptop-switcher.png') });

    // Following one task: the page can't show a file from a copy on the VPS, and says so.
    await q(`const row = r.querySelector('.arow[data-key="r:${vm}:${sent.task}"]'); row.click(); return true;`);
    await sleep(300);
    await edit(VPS, 'mine-s', ws, path.join(ws, 'about.html'), '', '<h1>About</h1>\n', 'VPS mine: the about page');
    const note = await waitFor(() => q(`const n = r.querySelector('.fpnote'); return n && n.textContent ? n.textContent : null;`), 8000);
    const toasts = await q(`return [...r.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
    check('Follow on a task: no "isn\'t on this page. Open the page…" for a file in a copy on the VPS', !/Open the page that shows it/.test(String(note) + toasts), { note, toasts });
    check('Follow on a task: no "outside this project" error (its code comes with the edit)', !/outside this project/.test(toasts), toasts);
    check('Follow on a task: says the file is in a copy on the VPS', /in a copy/.test(String(note)) && String(note).includes(`◆ ${vm}`), note);
    const aboutPane = await waitFor(() => pane(/^about\.html$/, true), 8000);
    check('Follow on a task: the code view shows its edit there', Boolean(aboutPane), aboutPane);
    await page.screenshot({ path: path.join(outDir, 'laptop-follow-task.png') });

    // A file over 60 KB there: its card comes with the changed lines; the whole text is not sent.
    const big = 'x'.repeat(70 * 1024) + '\n';
    await edit(VPS, 'mine-s', ws, path.join(ws, 'big.css'), big, big + 'a{}\n', 'VPS mine: a big stylesheet');
    const bigCard = await waitFor(() => q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => x.textContent.includes('VPS mine: a big stylesheet')); return c ? { diff: c.querySelectorAll('.diff .ln').length, replay: Boolean(c.querySelector('.play')) } : null;`), 8000);
    check('a file over 60 KB: its card shows live with its changed lines (no whole-file replay)', Boolean(bigCard) && bigCard.diff > 0, bigCard);

    // A page opened afterwards shows them all (the laptop's server keeps them).
    const later = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    later.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await later.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await later.goto(`http://127.0.0.1:${site.address().port}/`);
    await later.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    const all = await waitFor(() => later.evaluate(`['Laptop: contact heading', 'VPS mine: link the about page', 'VPS theirs: rename the FAQ'].every((w) => [...${ROOT}.querySelectorAll('.k-edit .why')].some((x) => x.textContent === w))`), 8000);
    check('a page opened later lists all three', all);
    await later.close();

    // The VPS page: the "mine" task's edit, with the same pattern of note.
    const vpage = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    vpage.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await vpage.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await vpage.goto(`http://127.0.0.1:${vpsSite.address().port}/`);
    await vpage.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await vpage.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
    const vnote = await waitFor(() => vpage.evaluate(`(() => { const c = [...${ROOT}.querySelectorAll('.k-edit')].find((x) => x.textContent.includes('VPS mine: link the about page')); return c ? c.querySelector('.enote').textContent : null; })()`), 8000);
    const by = joined.host && sent.workspace.sentFrom;
    check('VPS page note: a task from the laptop, shows there as it happens', vnote === `A task from ◆ ${by}, in a copy of its project. It shows on that computer's page as it happens.`, vnote);
    await vpage.screenshot({ path: path.join(outDir, 'vps-page.png') });
    check('no page errors', !errors.length, errors);
  } finally {
    if (browser) await browser.close();
    site.close();
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
