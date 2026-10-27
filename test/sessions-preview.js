#!/usr/bin/env node
'use strict';
require('./isolate');
// The Sessions sheet and Tasks at once (handoff 13), with two servers and the stand-in SDK and
// claude: the laptop runs page control and gives the paired VPS (one task at a time) two tasks,
// "mine" and "theirs". Checks the sheet's groups and rows, Open, Continue in terminal, Rename, Stop,
// and the VPS's Tasks at once stepper. The sheet never starts a session or answers a question.
// A name being typed stays through the 2 s refresh; nothing is fetched before the first hello.
//   NODE_PATH=$(npm root -g) node test/sessions-preview.js <out-dir>   (ports 4520-4524)
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'sessions-out', 'node test/sessions-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const DRIVE = path.join(__dirname, '..', 'bin', 'drive.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sessions-preview-'));
const vpsProject = path.join(base, 'shop');
const laptop = path.join(base, 'laptop-app');
const fake = path.join(base, 'fake');
const home = path.join(base, 'home');
// Run the same inside a Claude Code session as on CI: no CLAUDE*/ANTHROPIC_* from this shell.
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
const VPS = { port: 5202, pairPort: 5203, dir: path.join(base, 'vps'), state: path.join(fake, 'state-vps') };
const LAPTOP = { port: 5204, pairPort: 5205, dir: path.join(base, 'laptop'), state: path.join(fake, 'state-laptop') };
const SITE_PORT = 5206;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
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
// The stand-in SDK and claude, as every drive.js call and server here has: no claude on PATH needed.
// FAKE_SDK_SESSION_HOOK: each Claude runs the SessionStart hook too (a task's must not turn on page control).
const fakeEnv = (s) => ({ EDITLENS_SDK_DIR: path.join(fake, 'sdk'), EDITLENS_CLAUDE_PATH: path.join(fake, 'bin', 'claude'), FAKE_CLAUDE_STATE: s.state, FAKE_SDK_HOOKS: '1', FAKE_SDK_SESSION_HOOK: '1', HOME: home, USERPROFILE: home });
function start(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  fs.mkdirSync(s.state, { recursive: true });
  fs.writeFileSync(path.join(s.state, 'signed-in'), 'yes');
  s.child = spawn(process.execPath, [SERVER], {
    env: { ...ownEnv, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_NO_BROWSER: '1', ...fakeEnv(s) },
    stdio: 'ignore',
  });
  // /health can answer before the token file is written; the calls below need both.
  return waitFor(() => fs.existsSync(path.join(s.dir, `token-${s.port}`)) && fetch(`http://127.0.0.1:${s.port}/health`).then((r) => r.ok, notRunning(false)));
}
// Stops a server this script started, by its own pid.
function stop(s) {
  return new Promise((r) => {
    if (!s.child || s.child.exitCode !== null) return r();
    s.child.once('exit', r);
    s.child.kill();
  });
}
const call = (s, method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, {
  method, headers: { 'content-type': 'application/json', 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json() }));
const api = (s, method, p, body) => call(s, method, p, body).then((r) => r.json);
const task = (body) => api(LAPTOP, 'POST', '/remote/task', { localDir: laptop, ...body });
const lines = (s, name) => {
  const f = path.join(s.state, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
// Page control on the laptop, as /editlens control new does it.
function control(s, dir) {
  const out = spawnSync(process.execPath, [DRIVE, 'new'], { cwd: dir, encoding: 'utf8', timeout: 60000,
    env: { ...ownEnv, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, CLAUDE_PROJECT_DIR: dir, ...fakeEnv(s) } });
  if (out.status !== 0) console.log((out.stdout + out.stderr).trim());
}
// The mod on the VPS: it reports the settings Claude Code has (Tasks at once 1), and a change the
// page asked for once it has made it, as hooks/mod.mjs does through $.config.set.
const vpsSettings = { tasks_at_once: 1 };
async function modReport() {
  const { values } = await api(VPS, 'GET', '/settings');
  const asked = await api(VPS, 'GET', '/summary?cwd=' + encodeURIComponent(vpsProject));
  for (const p of (asked && asked.settingsPending) || []) if (p.key === 'tasks_at_once') vpsSettings.tasks_at_once = p.value;
  return api(VPS, 'POST', '/settings/report', { from: 'mod', values: { ...values, ...vpsSettings } });
}
function site(port, serverPort, root, title) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>${title}</h1>
<script src="http://127.0.0.1:${serverPort}/live.js" data-root="${root}" data-panel="open"></script></body></html>`);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

(async () => {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(home, { recursive: true });
  for (const [dir, file, text] of [[vpsProject, 'faq.html', '<h1>FAQ</h1>\n'], [laptop, 'index.html', '<h1>Home</h1>\n']]) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(dir, file), text);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.claude/\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'start');
  }

  const errors = [];
  let modTimer = null;
  let lapSite = null;
  let vpsSite = null;
  let browser = null;
  try {
    // A server that doesn't start (its port taken) fails here, and is stopped below all the same.
    if (!(await start(VPS)) || !(await start(LAPTOP))) throw new Error(`a server did not start: are ports ${VPS.port}-${SITE_PORT} free?`);
    lapSite = await site(SITE_PORT, LAPTOP.port, laptop, 'Home');
    vpsSite = await site(0, VPS.port, vpsProject, 'Shop');
    browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    await modReport();
    modTimer = setInterval(() => { modReport().catch((err) => errors.push('mod report: ' + err.message)); }, 2500);
    await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
    await api(LAPTOP, 'POST', '/event', { type: 'session', sessionId: 'lap', cwd: laptop, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
    const { code } = await api(VPS, 'POST', '/pair', { cwd: vpsProject });
    const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code });
    check('paired', joined.ok, joined);
    const vm = joined.host && joined.host.name;

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${SITE_PORT}/`);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(800);
    const q = (p, src) => p.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);

    // ---------- page control on the laptop: one message names it, then a subagent ----------
    control(LAPTOP, laptop);
    const driving = await waitFor(() => q(page, `return r.querySelector('.panel').classList.contains('driving')`), 20000);
    check('page control runs from the laptop\'s page', driving);
    const send = (text) => q(page, `const x = r.querySelector('.composer textarea'); x.value = ${JSON.stringify(text)}; x.dispatchEvent(new Event('input')); r.querySelector('.send').click(); return true;`);
    await send('Make the header blue');
    await waitFor(() => lines(LAPTOP, 'messages').length >= 1, 10000);
    await send('spawn agent-sub-1 toolu_sub1');
    // Conversations started and messages sent, on both: the sheet must add neither.
    const quiet = () => ['queries', 'messages'].map((f) => lines(LAPTOP, f).length + lines(VPS, f).length).join('/');

    // ---------- two tasks on the VPS, which runs one at a time ----------
    const remotework = require('../lib/remotework');
    const sent = await remotework.sendAndStart((op, extra) => task({ op, ...extra }), { dir: laptop, prompt: 'hold 60000', stateDir: LAPTOP.dir });
    check('"mine" started on the VPS', sent.state === 'working', sent);
    // Its first line names it; the stand-in SDK keeps its turn going (hold, on the last line).
    const theirs = await task({ op: 'start', prompt: 'Tidy the FAQ\nhold 60000' });
    check('"theirs" waits for a session: the VPS runs 1 task at a time', theirs.state === 'waiting' && /is running 1 task\./.test(theirs.note || ''), theirs);
    const mineKey = `r:${vm}:${sent.task}`;
    const theirsKey = `r:${vm}:${theirs.task}`;

    // ---------- task cards: "1 of 1 running", "Waiting", Sessions ----------
    const cardOf = (p, id) => q(p, `const c = [...r.querySelectorAll('.k-task')].find((x) => x.querySelector('.achip[data-key$=":${id}"], .achip[data-key="task:${id}"]')); if (!c) return null;
      return { status: c.querySelector('.tst').textContent, slots: (c.querySelector('.tslots') || {}).textContent || '', buttons: [...c.querySelectorAll('.tft .tb')].map((b) => b.textContent) }`);
    let mineCard = await waitFor(async () => { const c = await cardOf(page, sent.task); return c && c.slots ? c : null; }, 20000);
    const theirsCard = await waitFor(async () => { const c = await cardOf(page, theirs.task); return c && c.slots ? c : null; }, 20000);
    check('the laptop\'s card of the running task: "1 of 1 running", Sessions and Stop', Boolean(mineCard) && mineCard.slots === '1 of 1 running' && mineCard.buttons.join('|') === 'Sessions|Stop', mineCard);
    check('the waiting one: "Waiting" and "1 of 1 running"', Boolean(theirsCard) && theirsCard.status === 'Waiting' && theirsCard.slots === '1 of 1 running', theirsCard);
    await page.locator(`.k-task:has(.achip[data-key="${mineKey}"])`).scrollIntoViewIfNeeded();
    await page.locator(`.k-task:has(.achip[data-key="${mineKey}"])`).screenshot({ path: path.join(outDir, 'sessions-task-card.png') });

    // ---------- the sheet from ⋯ → Sessions ----------
    await waitFor(() => lines(LAPTOP, 'messages').length >= 2, 10000);
    const before = quiet();
    await q(page, `r.querySelector('.panel button.icon[aria-label="More"]').click(); return true;`);
    await sleep(300);
    const menuItem = await q(page, `const b = r.querySelector('.lmenu [data-act="sessions"]'); return b ? b.textContent : null`);
    check('⋯ has Sessions', menuItem === 'SessionsOpen, continue in terminal, rename or stop', menuItem);
    await q(page, `r.querySelector('.lmenu [data-act="sessions"]').click(); return true;`);
    const SHEET = `const s = r.querySelector('.usage.sessions.on'); if (!s) return null;
      return { count: s.querySelector('.sct').textContent, groups: [...s.querySelectorAll('.ssg')].map((g) => g.textContent),
        rows: [...s.querySelectorAll('.ssr')].map((x) => ({ key: x.getAttribute('data-key'), on: x.classList.contains('on'), name: (x.querySelector('.ssn') || {}).textContent || null, status: (x.querySelector('.sss') || {}).textContent || null,
          line: x.querySelector('.ssm').textContent, mark: x.querySelector('.ssd').className.replace('ssd', '').trim(), acts: [...x.querySelectorAll('.ssa > button, .ssa .ssmore')].map((b) => b.getAttribute('data-act') + (b.disabled ? ':off' : '')) })),
        foot: s.querySelector('.ssfoot').textContent, hidden: getComputedStyle(r.querySelector('.feed')).display === 'none' }`;
    const sheet = await waitFor(async () => {
      const s = await q(page, SHEET);
      return s && s.rows.length >= 3 && s.rows.some((x) => x.key === theirsKey) ? s : null;
    }, 15000);
    const row = (s, k) => ((s && s.rows) || []).find((x) => x.key === k || (k === 'page' && /^pc:/.test(x.key))) || {};
    check('the sheet takes the panel (the feed is hidden), its count', Boolean(sheet) && sheet.hidden && sheet.count === '3 · 2 running · 1 waiting', sheet && sheet.count);
    check('groups: This computer, then ◆ the VPS', Boolean(sheet) && sheet.groups.join('|') === `This computer|◆ ${vm}`, sheet && sheet.groups);
    const pc = row(sheet, 'page');
    check('page control\'s row: named by its first message, its status, how it started · model · mode · time', pc.name === 'Make the header blue' && /^(Working|Idle)$/.test(pc.status)
      && /^Page control · .*\d{1,2}:\d{2}/.test(pc.line), pc);
    check('the subagent is not a session (only page control and tasks are listed)', Boolean(sheet) && sheet.rows.length === 3, sheet && sheet.rows.map((x) => x.name));
    check('"mine": working, "Task · copy of this project"', row(sheet, mineKey).name === 'hold 60000' && row(sheet, mineKey).status === 'Working' && /^Task · copy of this project/.test(row(sheet, mineKey).line), row(sheet, mineKey));
    check('"theirs": waiting, "Task · 1 of 1 already running"', row(sheet, theirsKey).name === 'Tidy the FAQ' && row(sheet, theirsKey).status === 'Waiting' && row(sheet, theirsKey).line === 'Task · 1 of 1 already running' && row(sheet, theirsKey).mark === 'wait', row(sheet, theirsKey));
    check('the first running row is picked, with Open, Continue in terminal, Stop and ⋯', pc.on && pc.acts.join('|') === 'open|continue|stop|more', pc);
    check('the footer', Boolean(sheet) && sheet.foot === 'Continue in terminal copies a command. The desktop app may not list these.', sheet && sheet.foot);
    await page.locator('.usage.sessions').screenshot({ path: path.join(outDir, 'sessions-sheet.png') });

    // Continue in terminal: copies the command (the page never runs it).
    const clip = () => page.evaluate(() => navigator.clipboard.readText());
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await q(page, `r.querySelector('.ssr.on [data-act="continue"]').click(); return true;`);
    const copied = await waitFor(async () => (await clip()) || null, 3000);
    const pcId = (pc.key || '').slice(3);
    check('Continue in terminal copies cd "<project>" && claude --resume <id>', copied === `cd "${laptop}" && claude --resume ${pcId}`, copied);
    const toast = await q(page, `return r.querySelector('.toast').textContent`);
    check('and says where to run it', toast === 'Copied. Run it in a terminal to continue this session in Claude Code.', toast);

    // ↓ picks the next row (newest first: the waiting one, which has no conversation to continue
    // yet), then "mine": a VPS task's command is to run there.
    await page.keyboard.press('ArrowDown');
    let s2 = await q(page, SHEET);
    check('↓ picks the next row: the waiting one (no conversation to continue yet; Stop takes it off the queue)', Boolean(s2) && s2.rows[1].on && s2.rows[1].key === theirsKey && row(s2, theirsKey).acts.join('|') === 'open|continue:off|stop|more', s2 && s2.rows.map((x) => [x.on, x.acts.join('|')]));
    await page.keyboard.press('ArrowDown');
    s2 = await q(page, SHEET);
    check('↓ again: "mine"', row(s2, mineKey).on, s2 && s2.rows.map((x) => x.on));
    await q(page, `r.querySelector('.ssr.on [data-act="continue"]').click(); return true;`);
    const there = await waitFor(async () => { const c = await clip(); return c && c !== copied ? c : null; }, 3000);
    check('a VPS task\'s command: cd "<its folder there>" && claude --resume <its id>', /^cd "[^"]+workspaces[^"]+" && claude --resume [0-9a-f]{8}-/.test(there || ''), there);

    // ⋯ → Rename: Esc cancels, Enter saves; the name is used on the chips and in the terminal.
    await q(page, `r.querySelector('.ssr[data-key^="pc:"]').click(); return true;`);
    await q(page, `r.querySelector('.ssr.on .ssmore').click(); return true;`);
    await q(page, `r.querySelector('.ssr.on [data-act="rename"]').click(); return true;`);
    const field = await q(page, `const i = r.querySelector('.ssren input'); return i ? { value: i.value, focused: r.activeElement === i, hint: r.querySelector('.ssr.on .ssm').textContent } : null`);
    check('Rename: an inline field with the name, focused, and its hint', Boolean(field) && field.value === 'Make the header blue' && field.focused && /^Enter saves, Esc cancels\./.test(field.hint), field);
    await page.keyboard.type(' now'); // the name is selected: this replaces it
    // The list is fetched again every 2 s: the name being typed, and the cursor, stay.
    await sleep(4500);
    await page.keyboard.type('!');
    const typed = await q(page, `const i = r.querySelector('.ssren input'); return i ? { value: i.value, focused: r.activeElement === i } : null`);
    check('Rename: what you type stays while the list is fetched again', Boolean(typed) && typed.value === ' now!' && typed.focused, typed);
    await page.locator('.usage.sessions').screenshot({ path: path.join(outDir, 'sessions-rename.png') });
    await page.keyboard.press('Escape');
    s2 = await q(page, SHEET);
    check('Esc cancels: the name is as it was, the sheet stays open', Boolean(s2) && row(s2, 'page').name === 'Make the header blue', s2 && row(s2, 'page'));
    await q(page, `r.querySelector('.ssr.on .ssmore').click(); return true;`);
    await q(page, `r.querySelector('.ssr.on [data-act="rename"]').click(); return true;`);
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Blue header');
    await page.keyboard.press('Enter');
    s2 = await waitFor(async () => { const s = await q(page, SHEET); return s && row(s, 'page').name === 'Blue header' ? s : null; }, 5000);
    check('Enter saves: the row has the new name', Boolean(s2), await q(page, SHEET));
    const terminal = await api(LAPTOP, 'GET', '/sessions?cwd=' + encodeURIComponent(laptop));
    const tRow = terminal.groups[0].rows.find((x) => x.kind === 'page');
    check('the terminal\'s list (GET /sessions) has the name, and its own name', tRow && tRow.name === 'Blue header' && tRow.ownName === 'Make the header blue' && tRow.renamed, tRow);
    const summary = await api(LAPTOP, 'GET', `/summary?cwd=${encodeURIComponent(laptop)}&session=lap`);
    check('Details\' Main uses it (summary mainName)', summary.mainName === 'Blue header', summary.mainName);
    // A name from the terminal shows on the page.
    const renamed = await call(LAPTOP, 'POST', '/sessions/rename', { cwd: laptop, key: mineKey, name: 'Link the about page' });
    check('a rename from the terminal (POST /sessions/rename)', renamed.status === 200 && renamed.json.name === 'Link the about page', renamed);
    const bad = await call(LAPTOP, 'POST', '/sessions/rename', { cwd: laptop, key: 'r:nowhere:abcdefabcdef', name: 'x' });
    check('a session not in the list is refused', bad.status === 404, bad);
    s2 = await waitFor(async () => { const s = await q(page, SHEET); return s && row(s, mineKey).name === 'Link the about page' ? s : null; }, 6000);
    check('and the sheet has it', Boolean(s2));

    // Open: the sheet closes and the panel follows it.
    await q(page, `r.querySelector('.ssr[data-key="${mineKey}"]').click(); return true;`);
    await q(page, `r.querySelector('.ssr.on [data-act="open"]').click(); return true;`);
    await sleep(400);
    // The followed agent shows in the code view's Follow chip.
    const opened = await q(page, `const h = r.querySelector('.dock .dhead .fhead.on'); return { sheet: Boolean(r.querySelector('.usage.sessions.on')), follow: h ? h.getAttribute('data-key') : null }`);
    check('Open: the sheet closes, the panel follows that task', !opened.sheet && opened.follow === mineKey, opened);
    // The chips use the names (in the Follow menu, which that chip opens).
    const chips = await waitFor(async () => {
      const c = await q(page, `if (!r.querySelector('.lwrap .follow')) r.querySelector('.dock .dhead .fhead').click(); return [...r.querySelectorAll('.lwrap .follow .fchip.achip')].map((b) => ({ key: b.getAttribute('data-key'), text: b.textContent }))`);
      const m = c.find((x) => x.key === 'main');
      return m && m.text === 'Blue header' ? c : null;
    }, 6000);
    const chip = (k) => ((chips || []).find((x) => x.key === k) || {}).text;
    check('the chips use the names: Main and the VPS task (with ◆ the computer as its word)', chip('main') === 'Blue header' && chip(mineKey) === `Link the about page · ◆ ${vm}`, chips);
    await page.locator(`.lwrap .follow .fchip.achip[data-key="${mineKey}"]`).hover();
    const cardTitle = await waitFor(() => q(page, `const c = r.querySelector('.acard'); return c ? { title: c.querySelector('.ah b').textContent, doing: (c.querySelector('.akv .av[data-row="Doing"]') || {}).textContent || null } : null`), 3000);
    check('its details card: the name as title, what it does under Doing', Boolean(cardTitle) && cardTitle.title === 'Link the about page' && cardTitle.doing === 'hold 60000', cardTitle);
    await page.mouse.move(400, 600);
    for (let i = 0; i < 3 && await q(page, `return Boolean(r.querySelector('.lwrap'))`); i++) { await page.keyboard.press('Escape'); await sleep(100); }

    // The Agents tab's "All sessions", and "Sessions" on a VPS task card (at that computer's group).
    await q(page, `r.querySelector('.filters button[data-f="agents"]').click(); return true;`);
    const all = await waitFor(() => q(page, `const b = r.querySelector('.agents [data-act="all-sessions"]'); return b && b.offsetParent ? b.textContent : null`), 5000);
    check('the Agents tab has All sessions', all === 'All sessions', all);
    await q(page, `r.querySelector('.agents [data-act="all-sessions"]').click(); return true;`);
    check('All sessions opens the sheet', Boolean(await waitFor(() => q(page, SHEET), 3000)));
    await q(page, `r.querySelector('.usage.sessions .sback').click(); return true;`);
    await q(page, `r.querySelector('.filters button[data-f="all"]') && r.querySelector('.filters button[data-f="all"]').click(); return true;`);
    await sleep(200);
    await q(page, `[...r.querySelectorAll('.k-task')].find((x) => x.querySelector('.achip[data-key="${theirsKey}"]')).querySelector('[data-act="sessions"]').click(); return true;`);
    const atGroup = await waitFor(() => q(page, `const s = r.querySelector('.usage.sessions.on'); if (!s) return null; const g = s.querySelector('.ssg[data-group="r:${vm}"]'); if (!g) return null;
      const a = g.getBoundingClientRect(); const b = s.getBoundingClientRect(); return { top: Math.round(a.top - b.top), scrolled: s.scrollTop, height: s.clientHeight }`), 5000);
    check('"Sessions" on a VPS task card opens the sheet at that computer\'s group', Boolean(atGroup) && atGroup.top >= 0 && atGroup.top < atGroup.height, atGroup);
    await q(page, `r.querySelector('.usage.sessions .sback').click(); return true;`);

    // ---------- the VPS's page: Tasks at once in Settings › Other computers ----------
    const vpage = await ctx.newPage();
    vpage.on('pageerror', (e) => errors.push(e.message));
    await vpage.goto(`http://127.0.0.1:${vpsSite.address().port}/`);
    await vpage.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(800);
    const hereCard = await waitFor(async () => { const c = await cardOf(vpage, theirs.task); return c && c.slots ? c : null; }, 15000);
    check('the VPS\'s own card of the waiting task: "Waiting", "1 of 1 running"', Boolean(hereCard) && hereCard.status === 'Waiting' && hereCard.slots === '1 of 1 running', hereCard);
    await q(vpage, `r.querySelector('.panel button.icon[aria-label="More"]').click(); return true;`);
    await sleep(200);
    await q(vpage, `[...r.querySelectorAll('.lmenu button')].find((b) => b.textContent === 'All settings ›').click(); return true;`);
    const STEP = `const st = r.querySelector('.stepper[data-key="tasks_at_once"]'); if (!st) return null; const row = st.closest('.srow');
      const head = [...r.querySelectorAll('.settings .sghead')].map((h) => h.textContent);
      return { value: st.querySelector('b').textContent, minus: st.querySelector('[data-step="-1"]').disabled, plus: st.querySelector('[data-step="1"]').disabled, title: row.querySelector('.stitle').textContent,
        desc: row.querySelector('.sdesc').textContent, head, before: row.previousElementSibling && row.previousElementSibling.textContent }`;
    let step = await waitFor(async () => { const x = await q(vpage, STEP); return x && x.value === '1' ? x : null; }, 10000);
    check('Settings › Other computers: Tasks at once, a stepper at 1 (− off at the lowest)', Boolean(step) && step.title === 'Tasks at once' && step.minus && !step.plus && step.head.join() === 'Other computers' && step.before === 'Other computers', step || await q(vpage, STEP));
    check('it says what each task costs', Boolean(step) && /^Each running task adds about 0\.3–0\.5 GB of memory and uses your plan's limits in parallel\./.test(step.desc), step && step.desc);
    await vpage.locator('.stepper[data-key="tasks_at_once"]').scrollIntoViewIfNeeded();
    await vpage.locator('.stepper[data-key="tasks_at_once"]').evaluate((n) => n.closest('.srow').scrollIntoView({ block: 'center' }));
    await vpage.screenshot({ path: path.join(outDir, 'sessions-settings-stepper.png') });
    check('the sheet started nothing and sent nothing (Open, Copy, Rename)', quiet() === before, { now: quiet(), before });
    await q(vpage, `r.querySelector('.stepper[data-key="tasks_at_once"] [data-step="1"]').click(); return true;`);
    step = await waitFor(async () => { const x = await q(vpage, STEP); return x && x.value === '2' ? x : null; }, 8000);
    check('+ makes it 2 (made in Claude Code by the mod)', Boolean(step) && !step.minus, step || await q(vpage, STEP));
    const startedNow = await waitFor(async () => { const c = await cardOf(page, theirs.task); return c && c.status === 'Working' ? c : null; }, 15000);
    check('the waiting task starts now; the laptop\'s cards say "2 of 2 running"', Boolean(startedNow) && startedNow.slots === '2 of 2 running', startedNow || await cardOf(page, theirs.task));
    // "theirs" started in its copy with the VPS's page open: its SessionStart hook ran there, and
    // page control on the VPS stays off (nobody asked for it).
    await waitFor(() => lines(VPS, 'session-hooks').some((l) => /editlens-task-/.test(l)), 10000);
    await sleep(1500);
    const vpsControl = (await api(VPS, 'GET', `/summary?cwd=${encodeURIComponent(vpsProject)}`)).control;
    check('a task\'s Claude in its copy does not turn page control on, on the computer that runs it', lines(VPS, 'session-hooks').some((l) => /editlens-task-/.test(l)) && vpsControl !== 'page',
      { hooks: lines(VPS, 'session-hooks'), control: vpsControl });
    const after = quiet();
    mineCard = await cardOf(page, sent.task);
    check('the running task kept running', Boolean(mineCard) && mineCard.status === 'Working' && mineCard.slots === '2 of 2 running', mineCard);

    // ---------- Stop: running ones only; a stopped one stays listed ----------
    await q(page, `r.querySelector('.panel button.icon[aria-label="More"]').click(); return true;`);
    await sleep(200);
    await q(page, `r.querySelector('.lmenu [data-act="sessions"]').click(); return true;`);
    await waitFor(async () => { const s = await q(page, SHEET); return s && row(s, theirsKey).status === 'Working'; }, 8000);
    await q(page, `r.querySelector('.ssr[data-key="${theirsKey}"]').click(); return true;`);
    await q(page, `r.querySelector('.ssr.on [data-act="stop"]').click(); return true;`);
    s2 = await waitFor(async () => { const s = await q(page, SHEET); return s && /^Stopped/.test(row(s, theirsKey).status || '') ? s : null; }, 15000);
    check('Stop stops "theirs"; it stays in the list as Stopped, without Stop', Boolean(s2) && row(s2, theirsKey).acts.indexOf('stop') < 0, s2 ? row(s2, theirsKey) : await q(page, SHEET));
    // /editlens stop <name> (the terminal): the "mine" task by its name.
    const byName = await call(LAPTOP, 'POST', '/sessions/stop', { cwd: laptop, name: 'link the ABOUT page' });
    check('/editlens stop <name> stops a task by its name (any case)', byName.status === 200 && byName.json.stopped === 'Link the about page' && byName.json.kind === 'there', byName);
    const again = await call(LAPTOP, 'POST', '/sessions/stop', { cwd: laptop, name: 'Link the about page' });
    check('a second stop: it is not running', again.status === 409 && again.json.error === '"Link the about page" is not running.', again);
    const nobody = await call(LAPTOP, 'POST', '/sessions/stop', { cwd: laptop, name: 'Nobody' });
    check('no session with that name: 404, and the running ones', nobody.status === 404 && /No session here is named "Nobody"/.test(nobody.json.error) && nobody.json.running.includes('Blue header'), nobody);
    // Page control: Stop switches to Manual; the row stays, with its command.
    await q(page, `r.querySelector('.ssr[data-key^="pc:"]').click(); return true;`);
    await q(page, `r.querySelector('.ssr.on [data-act="stop"]').click(); return true;`);
    s2 = await waitFor(async () => { const s = await q(page, SHEET); return s && /^Stopped/.test(row(s, 'page').status || '') ? s : null; }, 15000);
    check('Stop on page control: Manual again, the row stays (Stopped) with Continue in terminal', Boolean(s2) && row(s2, 'page').name === 'Blue header' && row(s2, 'page').acts.join('|') === 'continue|more', s2 ? row(s2, 'page') : await q(page, SHEET));
    check('the page is in Manual', !(await q(page, `return r.querySelector('.panel').classList.contains('driving')`)));
    check('Stop started nothing and sent nothing', quiet() === after, { now: quiet(), after });
    await page.locator('.usage.sessions').screenshot({ path: path.join(outDir, 'sessions-stopped.png') });

    // Dark, and a phone-wide window.
    await page.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    await page.locator('.usage.sessions').screenshot({ path: path.join(outDir, 'sessions-sheet-dark.png') });
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const mp = await phone.newPage();
    mp.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await mp.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await mp.goto(`http://127.0.0.1:${SITE_PORT}/`);
    await mp.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(800);
    await q(mp, `r.querySelector('.panel button.icon[aria-label="More"]').click(); return true;`);
    await sleep(300);
    await q(mp, `r.querySelector('.lmenu [data-act="sessions"]').click(); return true;`);
    await waitFor(() => q(mp, `return r.querySelectorAll('.usage.sessions.on .ssr').length >= 3`), 8000);
    const fits = await q(mp, `const s = r.querySelector('.usage.sessions.on'); return { wide: s.scrollWidth <= s.clientWidth + 1, page: document.documentElement.scrollWidth <= innerWidth + 1 }`);
    check('phone-wide: no sideways scroll', fits.wide && fits.page, fits);
    await mp.screenshot({ path: path.join(outDir, 'sessions-phone.png') });
    // An error page that isn't JSON: the sheet shows its status, not a parse error.
    await mp.route(`http://127.0.0.1:${LAPTOP.port}/sessions?*`, (rt) => rt.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad gateway</html>' }));
    await mp.reload();
    await mp.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(800);
    await q(mp, `r.querySelector('.panel button.icon[aria-label="More"]').click(); return true;`);
    await sleep(300);
    await q(mp, `r.querySelector('.lmenu [data-act="sessions"]').click(); return true;`);
    const notJson = await waitFor(() => q(mp, `const n = r.querySelector('.usage.sessions.on .ssnone'); return n && /Could not list/.test(n.textContent) ? n.textContent : null`), 8000);
    check('a non-JSON error page: the sheet says its status', notJson === 'Could not list the sessions: HTTP 502', notJson);
    await phone.close();

    // Sessions opened before the event stream's first hello: no GET /sessions until then (a page
    // through a pairing link learns that from the hello).
    const early = await ctx.newPage();
    early.on('pageerror', (e) => errors.push(e.message));
    const asked = [];
    let helloAt = 0;
    early.on('request', (r) => { if (/\/sessions\?/.test(r.url())) asked.push(Date.now()); });
    await early.route(`http://127.0.0.1:${LAPTOP.port}/events?*`, async (rt) => {
      await sleep(3000);
      helloAt = Date.now();
      await rt.continue();
    });
    await early.goto(`http://127.0.0.1:${SITE_PORT}/`);
    await early.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await q(early, `r.querySelector('.panel button.icon[aria-label="More"]').click(); return true;`);
    await sleep(200);
    await q(early, `r.querySelector('.lmenu [data-act="sessions"]').click(); return true;`);
    const listed = await waitFor(() => q(early, `return r.querySelectorAll('.usage.sessions.on .ssr').length >= 3`), 15000);
    check('before the hello: no GET /sessions', helloAt > 0 && asked.length > 0 && asked.every((t) => t >= helloAt), { asked: asked.map((t) => t - helloAt) });
    check('after it, the list loads', listed);
    await early.close();

    // Times too far away to be a date (1e20 ms) are left out, never "undefined NaN".
    const odd = await ctx.newPage();
    odd.on('pageerror', (e) => errors.push(e.message));
    await odd.route(`http://127.0.0.1:${LAPTOP.port}/sessions?*`, (rt) => rt.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ total: 1, running: 0, waiting: 0, names: {}, groups: [{ key: 'here', title: 'This computer',
        rows: [{ key: 'task:abcdef', kind: 'here', name: 'Odd time', state: 'stopped', running: false, at: 1e20, startedAt: 1e20, how: 'Task' }] }] }) }));
    await odd.goto(`http://127.0.0.1:${SITE_PORT}/`);
    await odd.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(800);
    await q(odd, `r.querySelector('.panel button.icon[aria-label="More"]').click(); return true;`);
    await sleep(200);
    await q(odd, `r.querySelector('.lmenu [data-act="sessions"]').click(); return true;`);
    const oddRow = await waitFor(() => q(odd, `const x = r.querySelector('.usage.sessions.on .ssr'); return x ? x.querySelector('.sss').textContent + ' | ' + x.querySelector('.ssm').textContent : null`), 8000);
    check('a time that is not a date is left out', oddRow === 'Stopped | Task', oddRow);
    await odd.close();
    check('no page errors', !errors.length, errors);
  } finally {
    clearInterval(modTimer);
    if (browser) await browser.close();
    if (lapSite) lapSite.close();
    if (vpsSite) vpsSite.close();
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
