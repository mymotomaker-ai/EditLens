#!/usr/bin/env node
'use strict';
require('./isolate');
// Claude on a paired computer, in the browser: the host's panel shows the task card, a permission
// question with Allow / Deny (answered here, never by the asking agent), the reply, and Stop. The
// permissions button lists it with Claude Code's own questions (shown, not answered). Light and
// dark, wide and narrow. Stand-in SDK and claude (test/fixtures).
//
//   NODE_PATH=$(npm root -g) node test/tasks-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'tasks-out', 'node test/tasks-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-tasks-preview-'));
const project = path.join(base, 'shop');
const fake = path.join(base, 'fake');
const HOST = { port: 4376, pairPort: 4377, dir: path.join(base, 'host') };
const REMOTE = { port: 4378, pairPort: 4379, dir: path.join(base, 'remote') };
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
const task = (body) => api(REMOTE, 'POST', '/remote/task', body);

(async () => {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@example.com');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'src', 'App.jsx'), 'export const App = () => <h1>Shop</h1>;\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.claude/\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'start');

  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Shop</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Shop</h1><p>Prices from $12</p>
<script src="http://127.0.0.1:${HOST.port}/live.js" data-root="${project}"></script></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  let browser = null;
  let lsite = null;
  try {
    await start(HOST, { EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state') });
    await start(REMOTE);
    browser = await launch(chromium, {}, [HOST.child, REMOTE.child]);
    await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'h1', cwd: project, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
    const { code } = await api(HOST, 'POST', '/pair', { cwd: project });
    const joined = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code });
    check('paired', joined.ok, joined);

    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await page.goto(`http://127.0.0.1:${site.address().port}/`);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await page.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
    await sleep(800);

    const started = await task({ op: 'start', prompt: 'Make the price on the home page bold' });
    check('task started', Boolean(started.task), started);
    await waitFor(async () => (await task({ op: 'check', task: started.task })).state === 'idle');
    await task({ op: 'send', task: started.task, text: 'ask npm test' });
    const asks = await waitFor(() => page.evaluate(`${ROOT}.querySelector('.k-task.asks .tq') !== null`));
    check('the card asks the user', asks);
    // Claude Code itself asks too, for Claude and for a subagent.
    const hookEnv = { ...process.env, EDITLENS_PORT: String(HOST.port), EDITLENS_STATE_DIR: HOST.dir };
    const ask = (extra) => spawnSync(process.execPath, [HOOK, 'ask'], { encoding: 'utf8', env: hookEnv, input: JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'h1', cwd: project, ...extra }) });
    ask({ tool_name: 'WebFetch', tool_input: { url: 'https://registry.npmjs.org/react' } });
    ask({ tool_name: 'Bash', agent_id: 'a7f3', agent_type: 'general-purpose', tool_input: { command: 'npm install --save-dev vitest', description: 'Add the test runner' } });
    const three = await waitFor(() => page.evaluate(`(() => { const b = ${ROOT}.querySelector('.pqb.on.glow'); return b && b.textContent === '3'; })()`));
    check('the floating button shows 3 and glows', three);
    for (const [scheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 860 });
      await sleep(400);
      await page.evaluate(`${ROOT}.querySelector('.k-task').scrollIntoView({ block: 'center' })`);
      await page.screenshot({ path: path.join(outDir, `task-asks-${scheme}-${width}.png`) });
    }
    for (const [scheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 860 });
      await sleep(300);
      await page.evaluate(`${ROOT}.querySelector('.pqb').click()`);
      await sleep(400);
      await page.screenshot({ path: path.join(outDir, `permissions-${scheme}-${width}.png`) });
      await page.keyboard.press('Escape');
      await sleep(200);
    }
    const items = await page.evaluate(`(() => { ${ROOT}.querySelector('.pqb').click(); return [...${ROOT}.querySelectorAll('.pqi')].map((i) => ({ text: i.textContent, buttons: [...i.querySelectorAll('button')].map((b) => b.textContent) })); })()`);
    check('three questions, oldest first', items.length === 3 && /Task from/.test(items[0].text), items.map((i) => i.text.slice(0, 60)));
    check('Claude Code\'s own questions can\'t be answered here', items.slice(1).every((i) => /Answer this in Claude Code/.test(i.text) && !i.buttons.some((b) => /Allow|Deny/.test(b))), items);
    check('the task\'s question has Allow… and Deny', ['Allow…', 'Deny'].every((b) => items[0].buttons.includes(b)), items[0].buttons);
    check('the list does not focus an answer', await page.evaluate(`${ROOT}.activeElement && ${ROOT}.activeElement.getAttribute('aria-label') === 'Close'`));
    // Page code clicking Allow (what an agent could add to the site) approves nothing.
    await page.evaluate(`(() => { window.open = () => null; [...${ROOT}.querySelectorAll('.pqi')][0].querySelector('.allow').click(); })()`);
    await sleep(800);
    check('a click by page code approves nothing', await page.evaluate(`${ROOT}.querySelector('.pqb').textContent === '3'`));
    await page.reload();
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.pqb.on')`, null, { timeout: 15000 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.locator('.pqb').click();
    await sleep(300);
    // The person clicks Allow…: the EditLens window opens on the live server's own origin.
    const [win] = await Promise.all([page.waitForEvent('popup'), page.locator('.pqi .allow').first().click()]);
    await win.waitForLoadState();
    await win.setViewportSize({ width: 460, height: 640 });
    check('the window is on the live server\'s origin', new URL(win.url()).port === String(HOST.port), win.url());
    await win.waitForSelector('.q button.allow');
    await win.emulateMedia({ colorScheme: 'light' });
    await sleep(700);
    await win.screenshot({ path: path.join(outDir, 'answer-window-light.png') });
    await win.emulateMedia({ colorScheme: 'dark' });
    await sleep(200);
    await win.screenshot({ path: path.join(outDir, 'answer-window-dark.png') });
    const winText = await win.textContent('main');
    check('the window lists the task first and Claude Code\'s questions as read-only', /Task from ◆ \S/.test(winText) && /Answer this in Claude Code/.test(winText), winText.slice(0, 200));
    await win.locator('.q.focus button.allow').click();
    const two = await waitFor(() => page.evaluate(`${ROOT}.querySelector('.pqb').textContent === '2'`));
    check('Allow in the window answers the task; 2 left', two);
    // A finished card folds once something newer is below it (handoff 16.1): opened here to read it.
    const openTask = `(() => { const c = ${ROOT}.querySelector('.k-task'); if (c && c.classList.contains('folded')) c.click(); })()`;
    const ran = await waitFor(() => page.evaluate(`(() => { ${openTask}; const r = ${ROOT}.querySelector('.k-task .trep p'); return r && /Ran: npm test/.test(r.textContent) && !${ROOT}.querySelector('.k-task.asks'); })()`));
    check('Allow: Claude continues and the reply shows', ran);
    await api(HOST, 'POST', '/event', { type: 'idle', sessionId: 'h1', cwd: project, ts: Date.now() });
    const gone = await waitFor(() => page.evaluate(`!${ROOT}.querySelector('.pqb.on')`));
    check('Claude stops: nothing waits, the button goes', gone);
    await page.evaluate(`${ROOT}.querySelector('.k-task').scrollIntoView({ block: 'center' })`);
    await page.screenshot({ path: path.join(outDir, 'task-replied.png') });
    await page.evaluate(`(() => { ${openTask}; [...${ROOT}.querySelectorAll('.k-task .tft [data-act="stop"]')].find((b) => b.textContent === 'Stop').click(); })()`);
    const stopped = await waitFor(async () => (await task({ op: 'check', task: started.task })).state === 'stopped');
    check('Stop on the card stops it', stopped);
    await sleep(300);
    await page.screenshot({ path: path.join(outDir, 'task-stopped.png') });
    check('no page errors', !errors.length, errors);

    // The laptop's own page: a task on the VPS that works on a copy of the laptop's project is
    // followed live there, and its applied files show as edits.
    const remotework = require('../lib/remotework');
    const laptop = path.join(base, 'laptop-app');
    fs.mkdirSync(path.join(laptop, 'src'), { recursive: true });
    fs.writeFileSync(path.join(laptop, 'src', 'App.jsx'), 'export const App = () => <h1>Orbit</h1>;\n');
    lsite = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><head><title>Orbit</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Orbit</h1>
<script src="http://127.0.0.1:${REMOTE.port}/live.js" data-root="${laptop}"></script></body></html>`);
    });
    await new Promise((r) => lsite.listen(0, '127.0.0.1', r));
    const lpage = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    lpage.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await lpage.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await lpage.goto(`http://127.0.0.1:${lsite.address().port}/`);
    await lpage.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await lpage.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
    const call = (op, extra) => task({ op, ...extra, localDir: laptop });
    const sent = await remotework.sendAndStart(call, { dir: laptop, prompt: 'write src/Admin.jsx export const Admin = () => <h1>Admin</h1>;', stateDir: REMOTE.dir });
    check('a task on the laptop\'s project started', Boolean(sent.task), sent);
    await waitFor(async () => (await task({ op: 'check', task: sent.task })).state === 'idle');
    await task({ op: 'send', task: sent.task, text: 'write src/App.jsx export const App = () => <h1>Orbit admin</h1>;', localDir: laptop });
    const ws = sent.workspace.folder;
    await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'x', cwd: ws, file: path.join(ws, 'src', 'Admin.jsx'), tool: 'Write', intent: 'Add the admin page', created: true, stats: { added: 1, removed: 0 },
      before: '', after: 'export const Admin = () => <h1>Admin</h1>;\n', hunks: [{ oldStart: 0, newStart: 1, lines: ['+export const Admin = () => <h1>Admin</h1>;'] }], ts: Date.now() });
    await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'x', cwd: ws, file: path.join(ws, 'src', 'App.jsx'), tool: 'Edit', intent: 'Link the admin page', stats: { added: 1, removed: 1 },
      before: 'export const App = () => <h1>Orbit</h1>;\n', after: 'export const App = () => <h1>Orbit admin</h1>;\n',
      hunks: [{ oldStart: 1, newStart: 1, lines: ['-export const App = () => <h1>Orbit</h1>;', '+export const App = () => <h1>Orbit admin</h1>;'] }], ts: Date.now() });
    // Claude in the VPS's own session edits the VPS's project meanwhile.
    await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'vps-own', cwd: project, file: path.join(project, 'src', 'App.jsx'), tool: 'Edit', intent: 'Shop heading on the VPS', stats: { added: 1, removed: 1 },
      before: 'export const App = () => <h1>Shop</h1>;\n', after: 'export const App = () => <h1>Shop VPS</h1>;\n',
      hunks: [{ oldStart: 1, newStart: 1, lines: ['-export const App = () => <h1>Shop</h1>;', '+export const App = () => <h1>Shop VPS</h1>;'] }], ts: Date.now() });
    // The task card is named as its chip: "◆ <computer> · Task" (handoff 12); its files are Changes
    // rows (file name, folder; handoff 16.1). Each edit's reason is on its edit card (checked below).
    // A finished card folds once something newer is below it: opened here to read its files.
    const followed = await waitFor(() => lpage.evaluate(`${ROOT}.querySelectorAll('.k-task.folded').forEach((c) => c.click()) || [...${ROOT}.querySelectorAll('.k-task')].some((c) => c.querySelector('.th .achip') && /^◆ .+ · Task$/.test(c.querySelector('.th .achip').textContent)
      && ['Admin.jsx', 'App.jsx'].every((f) => [...c.querySelectorAll('.tfiles li')].some((li) => li.querySelector('.f').textContent === f && li.querySelector('.cf').textContent === 'src/')))`));
    check('the laptop\'s panel follows the VPS task\'s edits live', followed);
    // Every edit there is a full edit card here too, labelled by where it was made, with its code.
    // The VPS session's edit has Restore (done on the VPS, test/undo-remote-preview.js); the task's has none.
    const cards = await waitFor(() => lpage.evaluate(`(() => { const c = [...${ROOT}.querySelectorAll('.k-edit.incopy')];
      // Who made it: the agent chip ("◆ <computer> · Task" for the task, "◆ <computer>" for its own session).
      const who = (x) => { const a = x.querySelector('.ewho .achip'); return a ? a.textContent : ''; };
      const t = c.find((x) => x.textContent.includes('Link the admin page') && / · Task$/.test(who(x)));
      const s = c.find((x) => x.textContent.includes('Shop heading on the VPS') && /^◆ \\S+$/.test(who(x)));
      return Boolean(t && s && t.querySelector('.play') && !t.querySelector('.rst') && s.querySelector('.rst') && s.querySelector('.rst').textContent === 'Restore'); })()`));
    check('VPS task and VPS session edits are full cards on the laptop (Replay; Restore only on the session\'s)', cards, cards ? undefined : await lpage.evaluate(`[...${ROOT}.querySelectorAll('.k-edit')].map((x) => ({ cls: x.className, who: (x.querySelector('.ewho .achip') || {}).textContent, play: Boolean(x.querySelector('.play')), rst: (x.querySelector('.rst') || {}).textContent || null, text: x.textContent.slice(0, 120) }))`));
    const rows = await lpage.evaluate(`[...${ROOT}.querySelectorAll('.k-agent .atype')].map((x) => x.textContent)`);
    check('each source has its own agent row', rows.filter((r) => r.startsWith('◆ ')).length >= 2, rows);
    const glowed = await lpage.evaluate(`document.querySelectorAll('[data-editlens-hl], .editlens-hl').length`);
    check('nothing glows on the laptop page for them', glowed === 0, glowed);
    await lpage.evaluate(`[...${ROOT}.querySelectorAll('.k-edit.incopy')].pop().scrollIntoView({ block: 'center' })`);
    await sleep(400);
    await lpage.screenshot({ path: path.join(outDir, 'vps-edits-on-laptop.png') });
    await lpage.evaluate(`[...${ROOT}.querySelectorAll('.k-edit.incopy')].find((x) => x.textContent.includes('Link the admin page')).click()`);
    await sleep(1500);
    await lpage.screenshot({ path: path.join(outDir, 'vps-edit-code-view.png') });
    // The VPS's own page shows them too, as edits in a copy of the laptop's project (no glow, no Restore).
    const onVps = await waitFor(() => page.evaluate(`[...${ROOT}.querySelectorAll('.k-edit.incopy')].some((c) => c.textContent.includes('Link the admin page') && c.textContent.includes('A task from ◆') && c.textContent.includes('in a copy of its project') && !c.querySelector('.rst'))`));
    check('the VPS page shows the task\'s edits, marked as the laptop\'s project', onVps);
    await page.evaluate(`[...${ROOT}.querySelectorAll('.k-edit.incopy')].pop().scrollIntoView({ block: 'center' })`);
    await page.screenshot({ path: path.join(outDir, 'task-edits-on-vps.png') });
    await waitFor(async () => (await task({ op: 'check', task: sent.task })).state === 'idle');
    await lpage.evaluate(`[...${ROOT}.querySelectorAll('.k-task')].pop().scrollIntoView({ block: 'center' })`);
    await lpage.screenshot({ path: path.join(outDir, 'task-followed-on-laptop.png') });
    const onApplied = (f) => api(REMOTE, 'POST', '/remote/applied', { task: sent.task, computer: 'vm', dir: laptop, path: f.path, status: f.status, intent: f.intent,
      before: f.before ? f.before.toString('utf8') : '', after: f.after ? f.after.toString('utf8') : '' });
    const applied = await remotework.applyTask(call, { task: sent.task, stateDir: REMOTE.dir, onApplied });
    check('applied on the laptop', applied.applied && applied.applied.length === 2, applied);
    const edits = await waitFor(() => lpage.evaluate(`${ROOT}.textContent.includes('Link the admin page (from vm)') && ${ROOT}.textContent.includes('Add the admin page (from vm)')`));
    check('applied files show as edits from the VPS', edits);
    await sleep(500);
    await lpage.screenshot({ path: path.join(outDir, 'task-applied-on-laptop.png') });
    check('no page errors on the laptop', !errors.length, errors);
  } finally {
    if (browser) await browser.close();
    site.close();
    if (lsite) lsite.close();
    await stop(HOST);
    await stop(REMOTE);
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
