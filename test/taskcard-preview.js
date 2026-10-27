#!/usr/bin/env node
'use strict';
require('./isolate');
// Task cards (handoff 16.1) and the task tools' lines in Claude Code's chat (16.2), with two servers
// and the stand-in SDK and claude. Claude on the laptop (mcp/live-page.js) gives the paired VPS (one
// task at a time) four tasks: done, working, waiting then asking, and not started. Checks each card's
// rows and buttons, folding, a narrow panel and a phone; the page never allows a permission question
// or messages Claude. Each tool's summary is saved as text. Ports 4535-4539.
//   NODE_PATH=$(npm root -g) node test/taskcard-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning, onTimeout } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'taskcard-out', 'node test/taskcard-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const MCP = path.join(__dirname, '..', 'mcp', 'live-page.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-taskcard-preview-'));
const vpsProject = path.join(base, 'shop');
const laptop = path.join(base, 'laptop-app');
const fake = path.join(base, 'fake');
const home = path.join(base, 'home');
// Run the same inside a Claude Code session as on CI: no CLAUDE*/ANTHROPIC_* from this shell.
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_)/.test(k)));
const VPS = { port: 5216, pairPort: 5217, dir: path.join(base, 'vps'), state: path.join(fake, 'state-vps') };
const LAPTOP = { port: 5218, pairPort: 5219, dir: path.join(base, 'laptop'), state: path.join(fake, 'state-laptop') };
const SITE_PORT = 5220;
const AS_ROOT = process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0;
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
// The stand-in SDK and claude, as every server and the MCP server here have: no claude on PATH needed.
const fakeEnv = (s) => ({ EDITLENS_SDK_DIR: path.join(fake, 'sdk'), EDITLENS_CLAUDE_PATH: path.join(fake, 'bin', 'claude'), FAKE_CLAUDE_STATE: s.state, FAKE_SDK_HOOKS: '1', HOME: home, USERPROFILE: home });
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
// Stops a process this script started, by its own pid.
function stop(child) {
  return new Promise((r) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return r();
    child.once('exit', r);
    child.kill();
  });
}
const call = (s, method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, {
  method, headers: { 'content-type': 'application/json', 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then(async (r) => ({ status: r.status, json: await r.json() }));
const api = (s, method, p, body) => call(s, method, p, body).then((r) => r.json);
const lines = (s, name) => {
  const f = path.join(s.state, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
// The mod on the VPS: it reports the settings Claude Code has (Tasks at once 1), as hooks/mod.mjs does.
async function modReport() {
  const { values } = await api(VPS, 'GET', '/settings');
  return api(VPS, 'POST', '/settings/report', { from: 'mod', values: { ...values, tasks_at_once: 1 } });
}
function site(port, serverPort, root, title) {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>${title}</h1>
<script src="http://127.0.0.1:${serverPort}/live.js" data-root="${root}" data-panel="open"></script></body></html>`);
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r(srv)));
}

// Claude Code's side: the MCP server, its tools called as Claude calls them.
function mcpServer() {
  const child = spawn(process.execPath, [MCP], { cwd: laptop, stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...ownEnv, CLAUDE_PROJECT_DIR: laptop, EDITLENS_PORT: String(LAPTOP.port), EDITLENS_PAIR_PORT: String(LAPTOP.pairPort), EDITLENS_STATE_DIR: LAPTOP.dir, ...fakeEnv(LAPTOP) } });
  const replies = new Map();
  let buf = '';
  let n = 0;
  child.stdout.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const l of parts.filter(Boolean)) {
      const m = JSON.parse(l);
      replies.set(m.id, m);
    }
  });
  const tool = async (name, args, ms = 90000) => {
    const id = ++n;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const m = await waitFor(() => replies.get(id), ms);
    if (!m) throw new Error(`${name}: no answer`);
    return m.result;
  };
  return { child, tool };
}

// What a card shows, read from the page. id: its data-task.
const CARD = (id) => `const c = r.querySelector('.k-task[data-task="${id}"]'); if (!c) return null;
  const t = (s) => { const n = c.querySelector(s); return n ? n.textContent : null; };
  const shown = (s) => { const n = c.querySelector(s); return n ? !n.hidden : null; };
  const tp = c.querySelector('.tp');
  const tsw = c.querySelector('.th .tsw');
  return { folded: c.classList.contains('folded'), asks: c.classList.contains('asks'), chip: t('.th .achip'), root: c.querySelector('.rootc') ? c.querySelector('.rootc').title : null,
    status: t('.tst'), slots: t('.tslots'), ago: t('.tago'), tone: tsw ? tsw.className.replace('tsw', '').trim() : null, title: t('.tt') || t('.ttl'), prompt: t('.tp'),
    clamped: tp ? tp.scrollHeight > tp.clientHeight + 1 : null, promptOpen: tp ? tp.classList.contains('open') : null, promptMore: shown('[data-act="more-prompt"]'), now: t('.tnow'), q: t('.tq'),
    filesHead: t('.tfh'), rows: [...c.querySelectorAll('.tfiles li')].map((li) => li.textContent), all: t('.tall'), where: t('.twhere'),
    whereLabel: c.querySelector('.twhere') ? c.querySelector('.twhere').getAttribute('aria-label') : null, warn: t('.twarn'), note: t('.tnote'),
    replyHead: t('.trep .lh2'), reply: t('.trep p'), replyOpen: c.querySelector('.trep p') ? c.querySelector('.trep p').classList.contains('open') : null, replyMore: shown('[data-act="more-reply"]'),
    applied: t('.tapl'), filesCount: t('.tfc'), effort: Boolean(c.querySelector('.tft .pmode.ef')),
    acts: [...c.querySelectorAll('.tft [data-act], .tapl [data-act]')].map((b) => b.getAttribute('data-act') + ':' + b.textContent),
    allButtons: [...c.querySelectorAll('button, a')].map((b) => b.textContent) }`;

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
  const chat = [];
  let modTimer = null;
  let lapSite = null;
  let vpsSite = null;
  let browser = null;
  let mcp = null;
  try {
    if (!(await start(VPS)) || !(await start(LAPTOP))) throw new Error(`a server did not start: are ports ${VPS.port}-${SITE_PORT} free?`);
    lapSite = await site(SITE_PORT, LAPTOP.port, laptop, 'Home');
    vpsSite = await site(0, VPS.port, vpsProject, 'Shop');
    browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    await modReport();
    modTimer = setInterval(() => { modReport().catch((err) => errors.push('mod report: ' + err.message)); }, 2500);
    await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
    await api(LAPTOP, 'POST', '/event', { type: 'session', sessionId: 'lap', cwd: laptop, execPath: path.join(fake, 'bin', 'claude'), ts: Date.now() });
    // The VPS's site, so the laptop can open its page through the link (the paired page).
    await api(VPS, 'POST', '/connect', { cwd: vpsProject, target: `http://127.0.0.1:${vpsSite.address().port}` });
    const { code } = await api(VPS, 'POST', '/pair', { cwd: vpsProject });
    const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code });
    check('paired', joined.ok, joined);
    const vm = joined.host && joined.host.name;
    mcp = mcpServer();
    // Each task tool: two text items, a plain summary (≤ 3 lines of ≤ 64 columns) and the data.
    const tool = async (name, args, label) => {
      const res = await mcp.tool(name, args);
      const items = (res && res.content) || [];
      const sum = items.length === 2 ? items[0].text : null;
      const ok = Boolean(sum) && sum.split('\n').length <= 3 && sum.split('\n').every((l) => [...l].length <= 64) && !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(sum);
      check(`${label}: the chat shows a plain summary, then the data`, ok, items);
      chat.push(`== ${name} (${label})\n${sum || '(none)'}\n`);
      let data = null;
      try {
        data = JSON.parse(items[items.length - 1].text);
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        // wait_for_computer_tasks answers lines, not JSON.
        data = items.length ? items[items.length - 1].text : null;
      }
      return { sum, data, isError: res && res.isError };
    };

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${SITE_PORT}/`);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    await sleep(800);
    const q = (p, src) => p.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const card = (p, id) => q(p, CARD(id));
    const shot = async (p, id, name) => {
      const loc = p.locator(`.k-task[data-task="${id}"]`);
      await loc.scrollIntoViewIfNeeded();
      await sleep(250); // the feed's own scroll to a new card, and the card's flash, finish first
      await loc.screenshot({ path: path.join(outDir, name) });
    };
    // Messages sent to Claude, and conversations started, on both computers: the cards add neither.
    const quiet = () => ['queries', 'messages'].map((f) => lines(LAPTOP, f).length + lines(VPS, f).length).join('/');

    // ---------- 1. "theirs": done, four files, a reply ----------
    const t1 = await tool('start_task_on_computer', { computer: vm, workspace: 'theirs', prompt: 'Tidy the FAQ and the footer\n'
      + 'Keep the tone friendly and short. Check every link on the FAQ page, fix the footer\'s year, and make the contact section match the about page so both read the same way.\n'
      + 'files faq.html,footer.html,about.html,contact.html\n'
      + 'reply: Done: Tidy the FAQ and the footer\\nShorter answers on the FAQ, and every link checked.\\nThe footer says 2026 now.\\nThe contact section matches the about page.\\nTwo links pointed to old pages; both go to the new ones.' }, 'start "theirs"');
    const id1 = t1.data && t1.data.task;
    check('the start summary: started on ◆ vm, title ··· status, where the edits go', /^✦ Task started on ◆ /.test(t1.sum || '') && /\nTidy the FAQ and the footer ·+ (Starting|Working)/.test(t1.sum || '') && /\nEdits go to ·+ a copy of its project$/.test(t1.sum || ''), t1.sum);
    const w1 = await tool('wait_for_computer_tasks', { computer: vm, tasks: [id1], until: 'turn_done', wait_seconds: 60 }, 'wait');
    check('the wait summary: done, 4 files with counts, not merged yet', /^✦ Task done on ◆ .+\nTidy the FAQ and the footer ·+ Done · 4 files · \+\d+ −\d+\nNot in its project yet\. Claude merges them next\.$/.test(w1.sum || ''), w1.sum);
    check('and the lines Claude got before, unchanged', new RegExp(`^Ready: ${id1} \\(turn_done\\)\\.\\n${id1} on .+: idle, 1 replies, \\d+ steps, 4 edits \\(`).test(w1.data || ''), w1.data);
    const c1 = await tool('check_computer_task', { computer: vm, task: id1 }, 'check');
    check('check: the same fields for Claude as before (state, prompt, replies, files, workspace)', c1.data && c1.data.state === 'idle' && c1.data.filesEdited.length === 4 && c1.data.workspace && typeof c1.data.prompt === 'string', c1.data && Object.keys(c1.data));
    const rowKey1 = `r:${vm}:${id1}`;
    let k1 = await waitFor(async () => { const c = await card(page, id1); return c && c.status === 'Done' && c.rows.length === 3 && c.reply ? c : null; }, 15000);
    check('"theirs" done: the label ◆ vm, Done and the time, the title', Boolean(k1) && /◆ /.test(k1.chip) && k1.tone === 'ok' && /^(now|\d+ s)$/.test(k1.ago) && k1.title === 'Tidy the FAQ and the footer', k1);
    check('the prompt: two lines, then More', Boolean(k1) && /^Keep the tone friendly/.test(k1.prompt) && k1.clamped && k1.promptMore, k1 && [k1.clamped, k1.promptMore]);
    check('Files · 4 · +A −R, three rows, Show all 4 files', Boolean(k1) && /^Files · 4\+\d+ −\d+/.test(k1.filesHead) && k1.rows.length === 3 && k1.all === 'Show all 4 files', k1 && [k1.filesHead, k1.rows, k1.all]);
    check('where they are, with the full sentence for ⓘ', Boolean(k1) && k1.where === 'In a copy of its project' && /^In a copy of its project\. On ◆ .+, in a copy of its project\. Not in its project yet: Claude merges them/.test(k1.whereLabel), k1 && k1.whereLabel);
    check('Claude\'s reply: three lines and More, without the "Done: <title>" line', Boolean(k1) && k1.replyHead === 'Claude\'s reply' && /^Shorter answers on the FAQ/.test(k1.reply) && !/Done:/.test(k1.reply) && k1.replyMore, k1 && [k1.reply, k1.replyMore]);
    check('the buttons: Sessions, Review changes (no Stop once done)', Boolean(k1) && k1.acts.filter((a) => !/^app:/.test(a)).join('|') === 'sessions:Sessions|review:Review changes', k1 && k1.acts);
    check('no Allow button anywhere on it', Boolean(k1) && !k1.allButtons.some((b) => /^(Allow|Always allow)/.test(b)), k1 && k1.allButtons);
    await page.locator(`.k-task[data-task="${id1}"]`).scrollIntoViewIfNeeded();
    await shot(page, id1, 'theirs-done.png');
    const before = quiet();
    // More (prompt and reply) and Show all, in place.
    await q(page, `r.querySelector('.k-task[data-task="${id1}"] [data-act="more-prompt"]').click(); r.querySelector('.k-task[data-task="${id1}"] [data-act="more-reply"]').click(); r.querySelector('.k-task[data-task="${id1}"] [data-act="files"]').click(); return true;`);
    k1 = await waitFor(async () => { const c = await card(page, id1); return c && c.rows.length === 4 && c.promptOpen && c.replyOpen ? c : null; }, 3000);
    check('More shows the whole prompt and reply; Show all shows the 4 files, then Show fewer', Boolean(k1) && /files faq\.html/.test(k1.prompt) && /Two links pointed/.test(k1.reply) && k1.all === 'Show fewer', k1 || await card(page, id1));
    check('More and Show all sent nothing', quiet() === before, { now: quiet(), before });
    await shot(page, id1, 'theirs-done-open.png');
    // Review changes: there is no review view; it opens the files in the code view, following this task.
    await q(page, `r.querySelector('.k-task[data-task="${id1}"] [data-act="review"]').click(); return true;`);
    const followed = await waitFor(() => q(page, `const b = r.querySelector('.dock .dhead .fhead.on'); return b && b.getAttribute('data-key') === ${JSON.stringify(rowKey1)} ? b.getAttribute('data-key') : null`), 5000);
    check('Review changes: the code view follows this task, and nothing is sent', followed === rowKey1 && quiet() === before, { followed, quiet: quiet(), before });
    await q(page, `const b = r.querySelector('.follow .fchip[data-key="all"]') || [...r.querySelectorAll('.follow .fchip')].find((x) => /All agents/.test(x.textContent)); if (b) b.click(); return true;`);

    // ---------- 2. "mine": working, on a step ----------
    const t2 = await tool('start_task_on_computer', { computer: vm, workspace: 'mine', prompt: 'Write the four design essays\n'
      + 'Use your agents: one essay each, then read them side by side and make the voice match.\nfiles essays/one.md\nstep Edit essays/two.md\nhold 60000' }, 'start "mine"');
    const id2 = t2.data && t2.data.task;
    check('the start summary of "mine": edits go to a copy of this project', /\nEdits go to ·+ a copy of this project$/.test(t2.sum || ''), t2.sum);
    let k2 = await waitFor(async () => { const c = await card(page, id2); return c && c.status === 'Working' && c.now && c.slots ? c : null; }, 20000);
    check('"mine" working: Working · 1 of 1 running, the Now line names its step', Boolean(k2) && k2.slots === '1 of 1 running' && k2.now === 'Editingtwo.md' && k2.tone === '', k2);
    check('its files: Files · 1, in a copy, not in your files yet', Boolean(k2) && /^Files · 1/.test(k2.filesHead) && k2.rows.length === 1 && k2.where === 'In a copy · not in your files yet', k2 && [k2.filesHead, k2.where]);
    check('its buttons: effort, Sessions, Stop', Boolean(k2) && k2.effort && k2.acts.filter((a) => !/^app:/.test(a)).join('|') === 'sessions:Sessions|stop:Stop', k2 && [k2.effort, k2.acts]);
    // The root tag: a task run as root (this check runs as root only where the server does).
    check(AS_ROOT ? 'as root: the root tag, with why on hover' : 'not as root: no root tag', Boolean(k2) && (AS_ROOT ? /^Runs as root/.test(k2.root || '') : k2.root === null), k2 && k2.root);
    const s2 = await tool('check_computer_task', { computer: vm, task: id2 }, 'check "mine"');
    check('a working task\'s summary: the whole title, its files (no room for "1 of 1 running")', /^✦ Task working on ◆ .+\nWrite the four design essays ·+ Working · 1 file · \+2 −0$/.test(s2.sum || ''), s2.sum);
    await shot(page, id2, 'mine-working.png');
    // The finished card above folds now that a newer card is below it.
    let f1 = await waitFor(async () => { const c = await card(page, id1); return c && c.folded ? c : null; }, 5000);
    check('the finished card folds once a newer card is below: label, title, 4 files, time', Boolean(f1) && f1.title === 'Tidy the FAQ and the footer' && f1.filesCount === '4 files' && f1.rows.length === 0, f1 || await card(page, id1));
    await shot(page, id1, 'folded.png');
    await q(page, `r.querySelector('.k-task[data-task="${id1}"]').click(); return true;`);
    f1 = await waitFor(async () => { const c = await card(page, id1); return c && !c.folded && c.rows.length ? c : null; }, 3000);
    check('a click opens it again, with a button to fold it', Boolean(f1) && await q(page, `return Boolean(r.querySelector('.k-task[data-task="${id1}"] .tfold'))`), f1);
    await q(page, `r.querySelector('.k-task[data-task="${id1}"] .tfold').click(); return true;`);
    check('and that button folds it', Boolean(await waitFor(async () => { const c = await card(page, id1); return c && c.folded; }, 3000)));

    // ---------- 3. waiting for a session (Tasks at once 1) ----------
    const t3 = await tool('start_task_on_computer', { computer: vm, workspace: 'theirs', prompt: 'Update the pricing table\nask npm test' }, 'start (waits)');
    const id3 = t3.data && t3.data.task;
    check('its summary: waiting on ◆ vm, 1 of 1 running, and why', /^✦ Task waiting on ◆ .+\nUpdate the pricing table ·+ Waiting · 1 of 1 running\n.*is running 1 task/.test(t3.sum || ''), t3.sum);
    const k3 = await waitFor(async () => { const c = await card(page, id3); return c && c.status === 'Waiting' && c.slots ? c : null; }, 15000);
    check('the waiting card: Waiting · 1 of 1 running, why it waits, Cancel', Boolean(k3) && k3.slots === '1 of 1 running' && k3.tone === 'w' && /is running 1 task/.test(k3.now || '') && !/^Waiting · /.test(k3.now) && k3.acts.filter((a) => !/^app:/.test(a)).join('|') === 'sessions:Sessions|stop:Cancel', k3);
    await shot(page, id3, 'waiting.png');
    const l1 = await tool('list_computer_tasks', { computer: vm }, 'list');
    check('the list summary: 3 tasks, newest first', /^✦ 3 tasks on ◆ .+ · 2 working\nUpdate the pricing table ·+ Waiting\nWrite the four design essays ·+ Working$/.test(l1.sum || ''), l1.sum);

    // ---------- 4. didn't start ----------
    const t4 = await tool('start_task_on_computer', { computer: 'nowhere', workspace: 'theirs', prompt: 'Update the README\nAdd the new install steps.' }, 'start (fails)');
    check('a failed start: didn\'t start, and why', t4.isError && /^✦ Task didn't start on ◆ nowhere\nUpdate the README ·+ Didn't start\nWhy: /.test(t4.sum || ''), t4.sum);
    const nid = await waitFor(() => q(page, `const c = [...r.querySelectorAll('.k-task[data-task^="notice:"]')].find((x) => /Update the README/.test(x.textContent)); return c ? c.getAttribute('data-task') : null`), 10000);
    const k4 = nid && await card(page, nid);
    check('the didn\'t-start card: ◆ nowhere, Didn\'t start, why, Try again', Boolean(k4) && /◆ nowhere/.test(k4.chip) && k4.status === 'Didn\'t start' && k4.tone === 'er' && Boolean(k4.warn) && !/^Didn't start · /.test(k4.warn) && k4.acts.join('|') === 'retry:Try again', k4);
    if (nid) await shot(page, nid, 'didnt-start.png');
    // Try again: the request goes in the message box (or is copied); nothing is sent.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    const beforeRetry = quiet();
    await q(page, `r.querySelector('.k-task[data-task="${nid}"] [data-act="retry"]').click(); return true;`);
    const again = await waitFor(async () => {
      const box = await q(page, `const x = r.querySelector('.composer textarea'); return x ? x.value : ''`);
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      return [box, clip].find((v) => v === 'Start the task on ◆ nowhere again: Update the README') || null;
    }, 3000);
    check('Try again puts the request in the message box (or copies it), and sends nothing', Boolean(again) && quiet() === beforeRetry, { again, quiet: quiet(), beforeRetry });
    await q(page, `const x = r.querySelector('.composer textarea'); if (x) { x.value = ''; x.dispatchEvent(new Event('input')); } return true;`);

    // ---------- Stop "mine" from its card: the waiting one starts, and asks ----------
    await q(page, `r.querySelector('.k-task[data-task="${id2}"] [data-act="stop"]').click(); return true;`);
    k2 = await waitFor(async () => { const c = await card(page, id2); return c && c.status === 'Stopped' ? c : null; }, 15000);
    check('Stop on the card stops "mine" (the same stop path as before)', Boolean(k2), k2 || await card(page, id2));
    const k3a = await waitFor(async () => { const c = await card(page, id3); return c && c.asks ? c : null; }, 20000);
    check('the asking card here: Needs your answer, the question, "Answer on ◆ vm", no Allow', Boolean(k3a) && k3a.status === 'Needs your answer' && k3a.tone === 'w' && /Run a command/.test(k3a.q) && /Only someone there can answer it/.test(k3a.q)
      && k3a.acts.some((a) => a === `answer-there:Answer on ◆ ${vm}`) && !k3a.allButtons.some((b) => /^(Allow|Always allow|Deny)$/.test(b)), k3a);
    await shot(page, id3, 'asking-there.png');
    // The VPS lets this computer answer (its setting "Paired computers can answer questions here"):
    // the card here gets Answer…, which opens the VPS's EditLens window through the link.
    const pairedAnswers = async (on) => {
      // The servers here use HOME/.claude (no CLAUDE_CONFIG_DIR).
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ pluginConfigs: { 'editlens@editlens': { options: { paired_answers: on } } } }));
      return api(VPS, 'POST', '/settings/report', { values: { paired_answers: on } });
    };
    // The VPS's page through the link (the paired page): its card's "Allow in the EditLens window"
    // says to answer on ◆ vm, and opens no window, while the setting is off.
    const ppage = await ctx.newPage();
    ppage.on('pageerror', (e) => errors.push(e.message));
    // The address with this user's key (D11): the browser keeps the site's cookie it sets.
    await ppage.goto(joined.host.keyUrl);
    await ppage.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    const pAsk = await waitFor(async () => { const c = await card(ppage, id3); return c && c.asks ? c : null; }, 15000);
    let popups = 0;
    // close() already ignores a page that closed by itself; any other error fails "no page errors".
    ppage.on('popup', (w) => { popups += 1; w.close().catch((err) => errors.push('popup close: ' + err.message)); });
    const clickAllow = () => q(ppage, `r.querySelector('.k-task[data-task="${id3}"] [data-act="answer"]').click(); return true;`);
    if (pAsk) await clickAllow();
    const told = await waitFor(() => q(ppage, `const t = r.querySelector('.toast.on'); return t ? t.textContent : null`), 3000);
    await sleep(800);
    check('paired page, setting off: Allow says to answer on ◆ vm (and how to allow it here), opens no window', Boolean(pAsk) && /^Answer this on ◆ .+ itself\. To answer from here, turn on "Paired computers can answer questions here"/.test(told || '') && popups === 0, { pAsk, told, popups });
    const turnedOn = await pairedAnswers(true);
    check('the VPS turns on "Paired computers can answer questions here" (saved in Claude Code there)', turnedOn.values && turnedOn.values.paired_answers === true, turnedOn);
    const k3b = await waitFor(async () => { const c = await card(page, id3); return c && c.acts.includes('answer-here:Answer…') ? c : null; }, 25000);
    check('the asking card here: "lets you answer it here" and Answer…; still no Allow or Deny on the page', Boolean(k3b) && /lets you answer it here/.test(k3b.q)
      && !k3b.allButtons.some((b) => /^(Allow|Always allow|Deny)$/.test(b)), k3b || await card(page, id3));
    await shot(page, id3, 'asking-answer-here.png');
    const [askWin] = await Promise.all([page.waitForEvent('popup', { timeout: 10000 }), q(page, `r.querySelector('.k-task[data-task="${id3}"] [data-act="answer-here"]').click(); return true;`)]);
    // The window may still be loading: wait in the page, which survives its navigation.
    const listed = await askWin.waitForFunction(() => /Run a command/.test(document.body.innerText), null, { timeout: 10000 })
      .then(() => askWin.evaluate(() => document.body.innerText), onTimeout(null));
    check('Answer… opens the VPS\'s EditLens window through the link: it says which computer asked and lists the question', Boolean(listed) && /the computer you paired with/.test(listed) && /npm test/.test(listed), listed);
    await askWin.screenshot({ path: path.join(outDir, "answer-window-paired.png") });
    await askWin.close();
    // The paired page now has the VPS's setting: its Allow opens the window through the link.
    const opened = await waitFor(async () => { await clickAllow(); await sleep(500); return popups > 0 ? popups : null; }, 10000);
    check('paired page, setting on: Allow opens the EditLens window', Boolean(opened), { popups });
    await ppage.close();
    await pairedAnswers(false);
    const k3c = await waitFor(async () => { const c = await card(page, id3); return c && c.acts.some((a) => a === `answer-there:Answer on ◆ ${vm}`) ? c : null; }, 25000);
    check('turned off on the VPS: the card here says "Answer on ◆ vm" again', Boolean(k3c), k3c || await card(page, id3));
    const a3 = await tool('check_computer_task', { computer: vm, task: id3 }, 'check (asks)');
    check('its summary: needs your answer, where to answer', /^✦ Task needs your answer on ◆ .+\nUpdate the pricing table ·+ Needs your answer\nAnswer its question in the EditLens window on ◆ /.test(a3.sum || ''), a3.sum);
    // The VPS's own page: "Allow in the EditLens window" and Deny; the page never allows.
    const vpage = await ctx.newPage();
    vpage.on('pageerror', (e) => errors.push(e.message));
    await vpage.goto(`http://127.0.0.1:${vpsSite.address().port}/`);
    await vpage.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    const h3 = await waitFor(async () => { const c = await card(vpage, id3); return c && c.asks ? c : null; }, 15000);
    check('the VPS\'s card: ◆ laptop · asked, Needs your answer, the command, "Allow in the EditLens window" and Deny', Boolean(h3) && / · asked$/.test(h3.chip) && h3.status === 'Needs your answer' && /Run a command/.test(h3.q) && /npm test/.test(h3.q)
      && h3.acts.join('|') === 'answer:Allow in the EditLens window|sessions:Sessions|deny:Deny', h3);
    await vpage.locator(`.k-task[data-task="${id3}"]`).scrollIntoViewIfNeeded();
    await shot(vpage, id3, 'asking-here.png');
    const popup = ctx.waitForEvent('page', { timeout: 5000 }).catch((err) => { if (!/Timeout/i.test(err.message)) throw err; return null; });
    await q(vpage, `r.querySelector('.k-task[data-task="${id3}"] [data-act="answer"]').click(); return true;`);
    const win = await popup;
    if (win) await win.waitForLoadState('domcontentloaded').catch((err) => { if (!/closed|Timeout/i.test(err.message)) throw err; });
    check('"Allow in the EditLens window" opens that window', Boolean(win) && /\/answer/.test(win.url()), win && win.url());
    if (win) await win.close();
    await sleep(1500);
    const pending = await card(vpage, id3);
    const there = await tool('check_computer_task', { computer: vm, task: id3 }, 'check (still asks)');
    check('the question is still waiting: the page answered nothing', Boolean(pending) && pending.asks && /^✦ Task needs your answer/.test(there.sum || ''), { pending, there: there.sum });
    await q(vpage, `r.querySelector('.k-task[data-task="${id3}"] [data-act="deny"]').click(); return true;`);
    const denied = await waitFor(async () => { const c = await card(page, id3); return c && c.status === 'Done' && /Not allowed/.test(c.reply || '') ? c : null; }, 15000);
    check('Deny on the VPS\'s page: the task continues without it, and the card here says so', Boolean(denied), denied || await card(page, id3));

    // ---------- "Added to your files" with Undo ----------
    const ap = await tool('apply_computer_task', { computer: vm, task: id2 }, 'apply');
    check('the apply summary: added to your files', /^✦ Changes added to your files from ◆ .+\nWrite the four design essays ·+ 1 file added$/.test(ap.sum || ''), ap.sum);
    check('the file is in the laptop\'s project', fs.existsSync(path.join(laptop, 'essays', 'one.md')));
    let k2a = await waitFor(async () => { const c = await card(page, id2); return c && c.applied ? c : null; }, 8000);
    check('the card: "Added to your files" with Undo (folded: a newer card is below)', Boolean(k2a) && k2a.folded && k2a.applied === 'Added to your filesUndo' && k2a.acts.includes('undo-apply:Undo'), k2a || await card(page, id2));
    await shot(page, id2, 'applied.png');
    await q(page, `r.querySelector('.k-task[data-task="${id2}"] [data-act="undo-apply"]').click(); return true;`);
    k2a = await waitFor(async () => { const c = await card(page, id2); return c && /^Undone\./.test(c.applied || '') ? c : null; }, 8000);
    check('Undo: the file is gone again, and the card says so', Boolean(k2a) && !fs.existsSync(path.join(laptop, 'essays', 'one.md')), k2a || await card(page, id2));
    const mg = await tool('merge_computer_task', { computer: vm, task: id1 }, 'merge');
    check('the merge summary: merged on ◆ vm', /^✦ Changes merged on ◆ .+\nTidy the FAQ and the footer ·+ 4 files merged$/.test(mg.sum || ''), mg.sum);
    const k1m = await waitFor(async () => { const c = await card(page, id1); return c && c.applied ? c : null; }, 8000);
    check('the merged task\'s card: "Added to its project" with Undo, no Review changes', Boolean(k1m) && k1m.applied === 'Added to its projectUndo' && !k1m.acts.some((a) => /^review/.test(a)), k1m || await card(page, id1));

    // ---------- the root tag, from the server's report (a computer where tasks run as root) ----------
    const rootId = '0123456789ab';
    await api(LAPTOP, 'POST', '/event', { type: 'task-remote', sessionId: `task-remote-${rootId}`, cwd: laptop, taskId: rootId, computer: vm, state: 'working', kind: 'copy', prompt: 'Check the root tag\nA task that runs as root there.',
      asRoot: 'unsafe', startedAt: Date.now(), ts: Date.now(), edits: [], editCount: 0, slots: { running: 1, limit: 1 }, step: 'Bash npm test' });
    const kr = await waitFor(async () => { const c = await card(page, rootId); return c && c.root ? c : null; }, 8000);
    check('the root tag: "root" after the label, why on hover; the Now line runs a command', Boolean(kr) && kr.root === `Runs as root on ◆ ${vm}, because the Root (unsafe) setting is on there.` && kr.now === 'Runningnpm test', kr);
    await shot(page, rootId, 'root.png');

    // ---------- the feed: light, dark, a narrow panel ----------
    await page.screenshot({ path: path.join(outDir, 'feed-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await sleep(300);
    await page.screenshot({ path: path.join(outDir, 'feed-dark.png') });
    await shot(page, id3, 'folded-dark.png');
    await shot(page, rootId, 'working-dark.png');
    await page.emulateMedia({ colorScheme: 'light' });
    await q(page, `const p = r.querySelector('.panel'); p.style.width = '300px'; p.style.maxWidth = '300px'; return true;`);
    await sleep(300);
    const narrow = await q(page, `const c = r.querySelector('.k-task[data-task="${rootId}"]'); const chip = c.querySelector('.th .achip').getBoundingClientRect(); const sw = c.querySelector('.th .tsw').getBoundingClientRect();
      const cards = [...r.querySelectorAll('.k-task')]; return { width: Math.round(c.getBoundingClientRect().width), statusBelow: sw.top >= chip.bottom - 1,
        overflow: cards.filter((k) => k.scrollWidth > k.clientWidth + 1).length, effortBars: [...c.querySelectorAll('.tft .pmode.ef > span')].filter((s) => s.offsetParent).length }`);
    check('a narrow panel (<320px): the status goes under the label, nothing runs past the card', narrow.width < 300 && narrow.statusBelow && narrow.overflow === 0, narrow);
    await shot(page, rootId, 'narrow.png');
    await shot(page, id3, 'narrow-done.png');

    // ---------- a phone ----------
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const mp = await phone.newPage();
    mp.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await mp.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await mp.goto(`http://127.0.0.1:${SITE_PORT}/`);
    await mp.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    const pk = await waitFor(async () => { const c = await card(mp, id3); return c && c.title === 'Update the pricing table' && (c.folded || c.status === 'Done') ? c : null; }, 10000);
    check('a phone: the cards are there', Boolean(pk), pk);
    const fits = await q(mp, `const cards = [...r.querySelectorAll('.k-task')]; const f = r.querySelector('.feed');
      return { cards: cards.length, over: cards.filter((k) => k.scrollWidth > k.clientWidth + 1).length, feed: f.scrollWidth <= f.clientWidth + 1, page: document.documentElement.scrollWidth <= innerWidth + 1,
        small: [...r.querySelectorAll('.k-task:not(.folded) .tft .tb')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 31.5).length }`);
    check('phone: no sideways scroll, buttons 32 px high', fits.cards >= 4 && fits.over === 0 && fits.feed && fits.page && fits.small === 0, fits);
    // A short prompt has no More; shown here to check where it opens.
    // It may fold while the page is still filling in (a newer card below): opened in the same step.
    await mp.locator(`.k-task[data-task="${id3}"]`).scrollIntoViewIfNeeded();
    await waitFor(() => q(mp, `const c = r.querySelector('.k-task[data-task="${id3}"]'); if (c.classList.contains('folded')) c.click();
      const m = c.querySelector('[data-act="more-prompt"]'); if (!m) return false; m.hidden = false; m.click(); return true;`), 3000);
    const sheet = await waitFor(() => q(mp, `const s = r.querySelector('.acard .tsheet'); return s ? s.textContent : null`), 3000);
    check('phone: More opens the whole text in a sheet', sheet === 'Update the pricing tableask npm test', sheet);
    await mp.screenshot({ path: path.join(outDir, 'phone.png') });
    await phone.close();
    check('no page errors', !errors.length, errors);
  } finally {
    clearInterval(modTimer);
    fs.writeFileSync(path.join(outDir, 'chat-summaries.txt'), chat.join('\n'));
    if (mcp) await stop(mcp.child);
    if (browser) await browser.close();
    if (lapSite) lapSite.close();
    if (vpsSite) vpsSite.close();
    await stop(VPS.child);
    await stop(LAPTOP.child);
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
