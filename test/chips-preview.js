#!/usr/bin/env node
'use strict';
require('./isolate');
// Agent labels, their details card (handoff 12) and the Changes row (handoff 14), on the laptop's page
// with a main agent, two subagents and two tasks on the paired VPS ("mine" on a copy of the laptop's
// project, "theirs" on the VPS's own). Checks the labels, the card on hover, focus and touch, Follow,
// Stop, and that unknown counts read "lines not known yet", never "0 lines".
//
//   NODE_PATH=$(npm root -g) node test/chips-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'chips-out', 'node test/chips-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-chips-preview-'));
const vpsProject = path.join(base, 'shop');
const laptop = path.join(base, 'laptop-app');
const fake = path.join(base, 'fake');
const VPS = { port: 4955, pairPort: 4956, dir: path.join(base, 'vps') };
const LAPTOP = { port: 4957, pairPort: 4958, dir: path.join(base, 'laptop') };
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
const task = (body) => api(LAPTOP, 'POST', '/remote/task', { localDir: laptop, ...body });
function edit(s, sessionId, cwd, file, from, to, intent, extra = {}) {
  return api(s, 'POST', '/event', { type: 'change', sessionId, cwd, file, tool: 'Edit', intent, stats: { added: 1, removed: 1 }, before: from, after: to,
    hunks: [{ oldStart: 1, newStart: 1, lines: ['-' + from.trimEnd(), '+' + to.trimEnd()] }], relFile: path.relative(cwd, file).split(path.sep).join('/'), ts: Date.now(), ...extra });
}
const chat = (role, extra) => api(LAPTOP, 'POST', '/event', { type: 'chat', role, sessionId: 'lap', cwd: laptop, ts: Date.now(), backlog: false, ...extra });

// The open card: header, rows by label, buttons.
const CARD = `const c = r.querySelector('.acard'); if (!c) return null;
  const rows = {}; c.querySelectorAll('.akv .av').forEach((v) => { rows[v.getAttribute('data-row')] = v.textContent; });
  return { title: c.querySelector('.ah b').textContent, status: c.querySelector('.ast').textContent, badge: c.querySelector('.abdg').textContent, rows,
    badgeStyle: (() => { const s = getComputedStyle(c.querySelector('.abdg')); return s.display + ' ' + s.fontSize + ' ' + s.justifyContent; })(),
    buttons: [...c.querySelectorAll('.aacts button')].map((b) => b.textContent), sheet: c.classList.contains('sheet'),
    box: (() => { const b = c.getBoundingClientRect(); return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), width: Math.round(b.width) }; })() };`;

(async () => {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
  fs.mkdirSync(vpsProject, { recursive: true });
  git(vpsProject, 'init', '-q', '-b', 'main');
  git(vpsProject, 'config', 'user.email', 't@example.com');
  git(vpsProject, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(vpsProject, 'faq.html'), '<h1>FAQ</h1>\n');
  fs.writeFileSync(path.join(vpsProject, '.gitignore'), '.claude/\n');
  git(vpsProject, 'add', '-A');
  git(vpsProject, 'commit', '-q', '-m', 'start');
  fs.mkdirSync(path.join(laptop, 'src'), { recursive: true });
  fs.writeFileSync(path.join(laptop, 'index.html'), '<h1>Home</h1>\n');
  fs.writeFileSync(path.join(laptop, 'contact.html'), '<h1>Contact</h1>\n');
  fs.writeFileSync(path.join(laptop, 'src', 'header.css'), 'h1{margin:0}\n');

  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Home</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Home</h1>
<script src="http://127.0.0.1:${LAPTOP.port}/live.js" data-root="${laptop}"></script></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
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
    await sleep(600);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);

    // The main agent, a working subagent and a finished one, each with an edit.
    await edit(LAPTOP, 'lap', laptop, path.join(laptop, 'contact.html'), '<h1>Contact</h1>\n', '<h1>Contact us</h1>\n', 'Main: contact heading');
    await chat('agent-start', { toolUseId: 'toolu_A', agentId: 'aaaa1111bbbb', agentType: 'general-purpose', description: 'Check the header', prompt: 'Make the header spacing even.' });
    await chat('agent-step', { toolUseId: 'toolu_A', agentId: 'aaaa1111bbbb', kind: 'tool', tool: 'Read', summary: 'src/header.css', model: 'claude-sonnet-4-5' });
    await edit(LAPTOP, 'lap', laptop, path.join(laptop, 'src', 'header.css'), 'h1{margin:0}\n', 'h1{margin:0 0 8px}\n', 'Subagent: header spacing', { agentId: 'aaaa1111bbbb', agentType: 'general-purpose' });
    await chat('agent-start', { toolUseId: 'toolu_B', agentId: 'bbbb2222cccc', agentType: 'Explore', description: 'Review styles', prompt: 'Look over the styles.' });
    await chat('agent-done', { toolUseId: 'toolu_B', agentId: 'bbbb2222cccc', status: 'completed', text: 'Looks fine.', toolCount: 2 });

    // "mine": a task on a copy of the laptop's project, still working ("hold": the stand-in waits).
    const remotework = require('../lib/remotework');
    const sent = await remotework.sendAndStart((op, extra) => task({ op, ...extra }), { dir: laptop, prompt: 'hold 60000', stateDir: LAPTOP.dir });
    check('"mine" task started on the VPS', Boolean(sent.task), sent);
    const ws = sent.workspace.folder;
    await edit(VPS, 'mine-s', ws, path.join(ws, 'index.html'), '<h1>Home</h1>\n', '<h1>Home</h1><a href="about.html">About</a>\n', 'VPS mine: link the about page');
    // A subagent of that task writes in its own copy inside the task's folder; no counts come with it.
    const essay = path.join(ws, '.claude', 'worktrees', 'agent-ac43565b43082b933', 'essays', 'design', '03-modern-ui-trends.md');
    fs.mkdirSync(path.dirname(essay), { recursive: true });
    fs.writeFileSync(essay, '# Trends\n');
    await api(VPS, 'POST', '/event', { type: 'change', sessionId: 'mine-sub', cwd: ws, file: essay, tool: 'Write', intent: 'VPS mine: an essay by its subagent', ts: Date.now() });
    // "theirs": a task on a copy of the VPS's own project; it finishes.
    const theirs = await task({ op: 'start', prompt: 'Tidy the FAQ' });
    check('"theirs" task started on the VPS', Boolean(theirs.task), theirs);
    const tws = theirs.workspace && theirs.workspace.folder;
    await edit(VPS, 'theirs-s', tws, path.join(tws, 'faq.html'), '<h1>FAQ</h1>\n', '<h1>Questions</h1>\n', 'VPS theirs: rename the FAQ');
    const mineKey = `r:${vm}:${sent.task}`;
    const theirsKey = `r:${vm}:${theirs.task}`;

    // ---------- 12.1 the labels in the Follow menu ----------
    // The Follow chip next to the file name opens it; it stays open until a pick, Esc or a click
    // outside, and is drawn again as agents come and go.
    const openFollow = () => q(`if (!r.querySelector('.lwrap .follow')) r.querySelector('.dock .dhead .fhead').click(); return Boolean(r.querySelector('.lwrap .follow'));`);
    const closeFollow = async () => {
      for (let i = 0; i < 3 && await q(`return Boolean(r.querySelector('.lwrap'))`); i++) { await page.keyboard.press('Escape'); await sleep(100); }
    };
    const labels = async () => (await openFollow()) && q(`return [...r.querySelectorAll('.lwrap .follow .fchip.achip')].map((b) => ({ key: b.getAttribute('data-key'), text: b.textContent, mark: (b.querySelector('.am').className.split(' ')[1] || '') }))`);
    const row = await waitFor(async () => {
      const l = (await labels()) || [];
      const t = l.find((x) => x.key === theirsKey);
      return l.length >= 5 && t && t.mark === 'ok' ? l : null;
    }, 20000);
    const by = (k) => (row || []).find((x) => x.key === k) || {};
    check('Follow menu: Main, the two subagents and the two tasks, by name', Boolean(row) && by('main').text === 'Main' && by('toolu_A').text === 'Check the header' && by('toolu_B').text === 'Review styles'
      && by(mineKey).text === `◆ ${vm} · Task` && by(theirsKey).text === `◆ ${vm} · Task`, row || await labels());
    check('no label has an id or "copy of this project"', Boolean(row) && row.every((x) => !hasId(x.text, vm, [sent.task, theirs.task]) && !/copy of/.test(x.text)), row);
    check('status marks: Main (working after its edit), spinner (working), purple (done subagent), spinner (mine, working), green (theirs, done)',
      by('main').mark === 'spin' && by('toolu_A').mark === 'spin' && by('toolu_B').mark === 'sub' && by(mineKey).mark === 'spin' && by(theirsKey).mark === 'ok', row);
    await page.screenshot({ path: path.join(outDir, 'chips-follow-row.png'), clip: await page.locator('.lwrap .follow').boundingBox() });

    // ---------- 12.2 the details card: hover ----------
    const chip = (k) => page.locator(`.lwrap .follow .fchip.achip[data-key="${k}"]`);
    await chip(mineKey).hover();
    await sleep(120);
    check('the card waits for a 300 ms hover', (await q(CARD)) === null);
    const card = await waitFor(() => q(CARD), 2000);
    check('after the hover: the card for the "mine" task', Boolean(card) && card.badge === '◆' && card.title === 'hold 60000' && /^Working · 2 edits made$/.test(card.status), card);
    check('its rows: Computer (name · user@host), Agent, Edits go to, Model, Mode, Started', Boolean(card) && card.rows.Computer === `${vm} · 127.0.0.1` && card.rows.Agent === 'Task you started from this page'
      && card.rows['Edits go to'] === 'A copy of this project' && Boolean(card.rows.Model) && Boolean(card.rows.Mode) && /^\d{1,2}:\d{2}.* · (just now|\d+ s ago)$/.test(card.rows.Started || ''), card && card.rows);
    check('row order as drawn: Computer, Agent, Edits go to, Model, (Effort), Mode, Started', Boolean(card) && JSON.stringify(Object.keys(card.rows).filter((k) => k !== 'Effort')) === JSON.stringify(['Computer', 'Agent', 'Edits go to', 'Model', 'Mode', 'Started']), card && Object.keys(card.rows));
    check('a running task: Stop and Follow', Boolean(card) && JSON.stringify(card.buttons) === '["Stop","Follow"]', card && card.buttons);
    await sleep(250); // the card's pop-in
    await page.screenshot({ path: path.join(outDir, 'chips-card-task.png') });
    // The pointer moves onto the card: it stays. Then away: it closes.
    const box = await page.locator('.acard').boundingBox();
    await page.mouse.move(box.x + 40, box.y + 30, { steps: 4 });
    await sleep(500);
    check('the card stays while the pointer is on it', Boolean(await q(CARD)));
    await page.mouse.move(600, 600, { steps: 3 });
    await sleep(500);
    check('and closes when the pointer leaves', (await q(CARD)) === null);

    // A subagent and Main.
    await chip('toolu_A').hover();
    const sub = await waitFor(() => q(CARD), 2000);
    check('subagent card: badge A, its description, This computer, Subagent · type, This project, same effort as Main',
      Boolean(sub) && sub.badge === 'A' && sub.title === 'Check the header' && sub.rows.Computer === 'This computer' && sub.rows.Agent === 'Subagent · general-purpose'
      && sub.rows['Edits go to'] === 'This project' && /same as Main/i.test(sub.rows.Effort || '') && Boolean(sub.rows.Model), sub);
    // The badge has the class sub, which the panel header's .sub rule (its status line) matches too.
    check('a subagent badge is drawn like the others: centered, 12px', Boolean(sub) && /^grid 12px /.test(sub.badgeStyle), sub && sub.badgeStyle);
    check('no Stop for a subagent this page does not run (Claude Code\'s own)', Boolean(sub) && !sub.buttons.includes('Stop'), sub && sub.buttons);
    await sleep(250); // the card's pop-in
    await page.screenshot({ path: path.join(outDir, 'chips-card-subagent.png') });
    await page.mouse.move(600, 600);
    await sleep(400);
    await chip('toolu_B').hover();
    const done = await waitFor(() => q(CARD), 2000);
    check('a finished subagent: Done, no Stop', Boolean(done) && /^Done/.test(done.status) && !done.buttons.includes('Stop'), done);
    await page.mouse.move(600, 600);
    await sleep(400);
    await chip(theirsKey).hover();
    const their = await waitFor(() => q(CARD), 2000);
    check('"theirs" card: Its own project, Done, no Stop', Boolean(their) && their.rows['Edits go to'] === 'Its own project' && /^Done/.test(their.status) && !their.buttons.includes('Stop'), their);
    await page.mouse.move(600, 600);
    await sleep(400);

    // ---------- keyboard: focus opens it, Esc closes it ----------
    // Everyone is just before Main in the menu.
    await openFollow();
    await q(`r.querySelector('.lwrap .follow .fchip[data-mode="all"]').focus(); return true;`);
    await page.keyboard.press('Tab');
    const main = await waitFor(() => q(CARD), 2000);
    check('Tab onto the Main label opens its card', Boolean(main) && main.title === 'Main' && main.rows.Agent === 'Your session' && main.rows.Computer === 'This computer' && !main.buttons.includes('Stop'), main);
    await page.keyboard.press('Escape');
    await sleep(200);
    const after = await q(`return { card: Boolean(r.querySelector('.acard')), focus: r.activeElement ? r.activeElement.getAttribute('data-key') : null }`);
    check('Esc closes it and the focus stays on the label', !after.card && after.focus === 'main', after);
    await closeFollow();

    // ---------- the same card from a task card and from an Agents tab row ----------
    await q(`r.querySelector('.k-task .th .achip[data-key="${mineKey}"]').click(); return true;`);
    const fromTask = await waitFor(() => q(CARD), 2000);
    check('a VPS task card\'s label opens the same card', Boolean(fromTask) && fromTask.title === 'hold 60000' && fromTask.rows.Computer === `${vm} · 127.0.0.1`, fromTask);
    await sleep(250); // the card's pop-in
    await page.screenshot({ path: path.join(outDir, 'chips-task-card.png') });
    await page.keyboard.press('Escape');
    await q(`r.querySelector('.filters button[data-f="agents"]').click(); return true;`);
    await sleep(300);
    const tab = await q(`return [...r.querySelectorAll('.agents .agrow')].map((x) => ({ key: x.getAttribute('data-key'), label: x.querySelector('.achip').textContent, step: x.querySelector('.ars').textContent }))`);
    check('Agents tab: a row per agent, its label and one line of what it is doing', tab.length >= 5 && tab[0].label === 'Main' && tab.some((x) => x.key === 'toolu_A' && x.step === 'Read src/header.css')
      && tab.some((x) => x.key === mineKey && x.label === `◆ ${vm} · Task`), tab);
    await q(`r.querySelector('.agents .agrow[data-key="toolu_A"]').click(); return true;`);
    const fromRow = await waitFor(() => q(CARD), 2000);
    check('an Agents tab row opens the same card', Boolean(fromRow) && fromRow.title === 'Check the header', fromRow);
    await sleep(250); // the card's pop-in
    await page.screenshot({ path: path.join(outDir, 'chips-agents-tab.png') });

    // ---------- Follow / Following ----------
    await q(`[...r.querySelectorAll('.acard .aacts button')].find((b) => b.textContent === 'Follow').click(); return true;`);
    await sleep(300);
    // The followed agent shows in the Follow chip next to the file name.
    const fol = await q(`const b = [...r.querySelectorAll('.acard .aacts button')].find((x) => x.getAttribute('data-act') === 'follow'); const on = r.querySelector('.dock .dhead .fhead.on');
      return { button: b ? b.textContent : null, pressed: b ? b.getAttribute('aria-pressed') : null, followed: on ? on.getAttribute('data-key') : null }`);
    check('Follow: the code view follows it, the button says Following, its label has the ring', fol.button === 'Following' && fol.pressed === 'true' && fol.followed === 'toolu_A', fol);
    const ring = await q(`const on = r.querySelector('.dock .dhead .fhead.on'); return on ? getComputedStyle(on).boxShadow : ''`);
    check('the followed label: a 1.5 px ring', /1\.5px/.test(ring), ring);
    await q(`[...r.querySelectorAll('.acard .aacts button')].find((b) => b.textContent === 'Following').click(); return true;`);
    await sleep(300);
    check('Following again: back to everyone', (await q(`const h = r.querySelector('.dock .dhead .fhead'); return h ? h.textContent : null`)) === 'Following everyone');
    await page.keyboard.press('Escape');

    // ---------- the Changes row (handoff 14) ----------
    await q(`r.querySelector('.filters button[data-f="all"]').click(); return true;`);
    const essayCard = await waitFor(() => q(`const c = [...r.querySelectorAll('.k-edit')].find((x) => x.querySelector('.why') && x.querySelector('.why').textContent === 'VPS mine: an essay by its subagent');
      return c ? { file: c.querySelector('.file').textContent.replace(/\\u200e/g, ''), stat: c.querySelector('.stat') ? c.querySelector('.stat').textContent : null, who: c.querySelector('.ewho') ? c.querySelector('.ewho').textContent : '', text: c.textContent } : null;`), 10000);
    check('edit card: the file as the project names it, no copy folder', Boolean(essayCard) && essayCard.file.replace(/\s/g, '') === 'essays/design/03-modern-ui-trends.md' && !/worktrees|agent-ac43/.test(essayCard.text), essayCard);
    check('edit card: unknown counts say "lines not known yet", never +0 −0', Boolean(essayCard) && essayCard.stat === null && /lines not known yet/.test(essayCard.who) && !/\+0/.test(essayCard.text), essayCard);
    await q(`r.querySelector('.selbar .chg').click(); return true;`);
    await sleep(400);
    const rows = await q(`return [...r.querySelectorAll('.chlist .chr')].map((x) => ({ no: (x.querySelector('.cno') || {}).textContent || '', f: x.querySelector('.c1 .f').textContent, dir: (x.querySelector('.c1 .cf') || {}).textContent || '',
      cnt: x.querySelector('.c1 .cnt').textContent, who: (x.querySelector('.c2 .achip') || {}).textContent || '', line2: x.querySelector('.c2').textContent, text: x.textContent,
      oneLine: (() => { const b = x.querySelector('.c1').getBoundingClientRect(); return b.height < 26; })() }))`);
    const er = rows.find((x) => x.f === '03-modern-ui-trends.md');
    check('Changes row: number, file name, its folder, counts on line 1', Boolean(er) && /^\d+$/.test(er.no) && er.dir === 'essays/design/' && er.oneLine, er);
    check('Changes row: unknown counts: nothing on line 1, "lines not known yet" on line 2', Boolean(er) && er.cnt === '' && /lines not known yet/.test(er.line2), er);
    check('Changes row: line 2 has the label "◆ vm · Task" and the computer is named only there', Boolean(er) && er.who === `◆ ${vm} · Task` && er.text.split(`◆ ${vm}`).length === 2, er);
    const known = rows.find((x) => x.f.startsWith('header.css'));
    check('Changes row with counts: "+1 −1", the subagent\'s label', Boolean(known) && known.cnt === '+1 −1' && known.who === 'Check the header' && known.dir === 'src/', known);
    check('no Changes row shows a copy folder, "0 lines" or "+0"', rows.length >= 5 && rows.every((x) => !/worktrees|0 lines|\+0 /.test(x.text)), rows.map((x) => x.text));
    await page.screenshot({ path: path.join(outDir, 'chips-changes.png') });
    // The file name's hover: the full path and where the edit is.
    await page.locator('.chlist .chr .c1 .f', { hasText: '03-modern-ui-trends.md' }).hover();
    const fpop = await waitFor(() => q(`const c = r.querySelector('.acard'); return c ? [...c.children].slice(1).map((x) => x.textContent) : null`), 2000);
    check('file name hover: project path, where it is, the full path there', Boolean(fpop) && fpop[0] === 'essays/design/03-modern-ui-trends.md' && /In a copy of this project on ◆/.test(fpop[1] || '') && /worktrees/.test(fpop[2] || ''), fpop);
    await sleep(250); // the card's pop-in
    await page.screenshot({ path: path.join(outDir, 'chips-file-hover.png') });
    await page.mouse.move(600, 600);
    await sleep(400);
    await q(`r.querySelector('.selbar .chg').click(); return true;`);

    // The VPS task card's file list: the same row.
    const tlist = await waitFor(() => q(`const c = [...r.querySelectorAll('.k-task')].find((x) => x.querySelector('.achip[data-key="${mineKey}"]')); if (!c) return null;
      // Its files are Changes rows without line 2 (every file is this task's, handoff 16.1); the header
      // has counts only when every file's are known.
      const head = c.querySelector('.tfh');
      const li = [...c.querySelectorAll('.tfiles li')].map((x) => ({ f: x.querySelector('.c1 .f').textContent, dir: (x.querySelector('.c1 .cf') || {}).textContent || '', cnt: x.querySelector('.cnt').textContent, line2: (x.querySelector('.c2') || {}).textContent || '',
        head: head ? head.querySelector('span').textContent + ((head.querySelector('.cnt') || {}).textContent || '') : '' }));
      return li.length >= 2 ? li : null;`), 10000);
    const te = (tlist || []).find((x) => x.f === '03-modern-ui-trends.md');
    check('task card file list: the project\'s path, no counts while they are not known', Boolean(te) && te.dir === 'essays/design/' && te.cnt === '' && te.line2 === '' && /^Files · \d+$/.test(te.head), tlist);
    const panelText = await q(`return r.querySelector('.panel').textContent`);
    check('the panel never shows a copy folder or "0 lines"', !/\.claude\/worktrees|0 lines/.test(panelText), (panelText.match(/.{0,40}(worktrees|0 lines).{0,40}/) || [])[0]);
    const counts = await q(`return [...r.querySelectorAll('.pinfo .lines')].map((x) => x.textContent)`);
    check('code view: no "0 lines"', !counts.includes('0 lines'), counts);

    // ---------- Stop (a running task only) ----------
    await q(`r.querySelector('.k-task .th .achip[data-key="${mineKey}"]').click(); return true;`);
    await waitFor(() => q(CARD), 2000);
    await q(`r.querySelector('.acard [data-act="stop"]').click(); return true;`);
    await sleep(200);
    check('Stop asks for a second click', (await q(`return r.querySelector('.acard [data-act="stop"]').textContent`)) === 'Stop it?');
    await q(`r.querySelector('.acard [data-act="stop"]').click(); return true;`);
    const stopped = await waitFor(async () => {
      const s = await task({ op: 'check', task: sent.task }).catch(notRunning(null));
      const st = s && (s.state || (s.card && s.card.state));
      return /stopped|ended/.test(String(st)) ? st : null;
    }, 15000);
    check('Stop stops the task on the VPS', Boolean(stopped), stopped);
    await page.keyboard.press('Escape');
    const label = await waitFor(async () => (await openFollow()) && q(`const c = r.querySelector('.lwrap .follow .fchip.achip[data-key="${mineKey}"] .am'); return c && !c.classList.contains('spin') ? c.className : null;`), 15000);
    check('and its label stops spinning', Boolean(label), label);
    await closeFollow();
    check('no page errors (desktop)', !errors.length, errors);

    // ---------- touch: a tap opens the card as a bottom sheet ----------
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const mp = await phone.newPage();
    mp.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await mp.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await mp.goto(`http://127.0.0.1:${site.address().port}/`);
    await mp.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    const mq = (src) => mp.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    await mq(`r.querySelector('.panel') && r.querySelector('.panel').classList.contains('open') || (r.querySelector('.launcher') || {click(){}}).click(); return true;`);
    await sleep(600);
    await mq(`r.querySelector('.filters button[data-f="agents"]').click(); return true;`);
    await waitFor(() => mq(`return r.querySelectorAll('.agents .agrow').length >= 3`), 8000);
    await mp.locator('.agents .agrow[data-key="toolu_A"]').tap();
    await waitFor(() => mq(CARD), 3000);
    await sleep(400); // its slide-up
    const sheet = await mq(CARD);
    const vh = await mp.evaluate('innerHeight');
    check('touch: a tap opens the card as a bottom sheet', Boolean(sheet) && sheet.sheet && Math.abs(sheet.box.bottom - vh) <= 1 && sheet.box.left === 0 && sheet.title === 'Check the header', { sheet, vh });
    await mp.screenshot({ path: path.join(outDir, 'chips-phone-sheet.png') });
    await mq(`r.querySelector('.ascrim').click(); return true;`);
    await sleep(300);
    check('touch: a tap outside closes the sheet', (await mq(`return Boolean(r.querySelector('.acard'))`)) === false);
    await phone.close();

    // Dark: the card and the labels.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await page.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
    await waitFor(async () => ((await labels()) || []).length >= 5, 10000);
    await chip(theirsKey).hover();
    await waitFor(() => q(CARD), 2000);
    await sleep(250); // the card's pop-in
    await page.screenshot({ path: path.join(outDir, 'chips-dark.png') });
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
