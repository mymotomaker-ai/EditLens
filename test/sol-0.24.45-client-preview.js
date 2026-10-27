'use strict';
require('./isolate');
// Sol scan of 0.24.45, the page script: M7 (a file asked for before Follow changed is not shown;
// the saved page move is cleared), L5 (a dictation start canceled during the browser's check shows
// no card), L8 (agent colors removed with the board), L9 (output-token list limited), L11 (no
// Infinity sums) and L13 (the backend wait ends at its deadline). A few lines added at the end of
// the served page script give the checks its inner functions; nothing else in it changes.
// usage: NODE_PATH=$(npm root -g) node test/sol-0.24.45-client-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: sol-0.24.45-client-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol45-client-'));
// Manual: opening the page starts no page control setup.
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5357', CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
for (const n of ['A', 'B']) fs.writeFileSync(path.join(proj, 'src', n + '.jsx'), `export const ${n} = 1;\n`.repeat(8));
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = 'sol45-client';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: proj, ts: Date.now(), backlog: false, ...ev });
let step = 0;
const read = (who, name) => chat({ role: 'agent-step', agentId: 'ag' + who, toolUseId: 'tu' + who, agentType: 'general-purpose', kind: 'tool', tool: 'Read',
  summary: name + '.jsx', file: path.join(proj, 'src', name + '.jsx'), line: 2, end: 2, op: 'read', id: 'r' + ++step });

// The lines added at the end of the page script, inside its scope.
const HOOK = `
  window.__el = { team: team, follow: follow, agents: function () { return agents; }, mateColor: mateColor, boardSync: boardSync, boardClear: boardClear,
    addAgentStep: addAgentStep, agentTokens: agentTokens, sum: sum, seqKey: seqKey, setFollow: setFollow, reloadForBackend: reloadForBackend };
  window.__shown = [];
  var shownBefore = showFile;
  showFile = function (f) { window.__shown.push(f && f.rel); return shownBefore.apply(this, arguments); };
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sol checks</title></head>
<body style="font:16px system-ui;margin:40px"><h1 id="h">Checks</h1>
<script src="http://127.0.0.1:5357/live.js" data-root="${proj}" data-panel="open" data-settle="300"></script></body></html>`;

// A stand-in SpeechRecognition whose on-device check takes 1.5 s.
function speechStub() {
  window.__recs = [];
  function Fake() { window.__recs.push(this); }
  Fake.prototype.start = function () {};
  Fake.prototype.stop = function () { setTimeout(() => this.onend && this.onend(), 10); };
  Fake.prototype.abort = function () { setTimeout(() => this.onend && this.onend(), 10); };
  Fake.available = () => new Promise((resolve) => setTimeout(() => resolve('downloadable'), 1500));
  Fake.install = () => Promise.resolve(true);
  window.SpeechRecognition = Fake;
  window.webkitSpeechRecognition = Fake;
}

(async () => {
  await stopServer();
  await ensureServer();
  const hung = new Set();
  const site = http.createServer((req, res) => {
    // A backend route that never answers (L13).
    if (req.url === '/hang') return hung.add(res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
    await postEvent({ type: 'session', sessionId: SESSION, cwd: proj, ts: Date.now(), canListen: false });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    await ctx.addInitScript(speechStub);
    await ctx.addInitScript(() => {
      try {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('editlens.tourDone', '1');
        sessionStorage.setItem('editlens.follow', 'tuA');
      } catch (err) {
        if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
      }
    });
    await ctx.route('http://127.0.0.1:5357/live.js', async (route) => {
      const r = await route.fetch();
      const body = (await r.text()).replace(/\}\)\(\);\s*$/, HOOK + '})();\n');
      await route.fulfill({ response: r, body });
    });
    // M7: the file the first agent reads is answered 2.5 s late.
    await ctx.route((u) => u.port === '5357' && u.pathname === '/file', async (route) => {
      if (/A\.jsx/.test(route.request().url())) await sleep(2500);
      await route.continue();
    });
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(origin + '/');
    await pg.waitForFunction(`window.__el && document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);

    // M7: following A, A reads A.jsx (slow); Follow switches to B, which read B.jsx before.
    for (const w of ['A', 'B']) await chat({ role: 'agent-start', toolUseId: 'tu' + w, agentId: 'ag' + w, description: 'Agent ' + w, agentType: 'general-purpose', prompt: '' });
    await sleep(500);
    await read('B', 'B');
    await sleep(500);
    await read('A', 'A');
    await sleep(500);
    await pg.evaluate(() => window.__el.setFollow('tuB', false));
    await sleep(3500);
    const shown = await pg.evaluate(() => window.__shown.slice());
    check('M7: the file asked for while following A is not shown after Follow switched to B', shown.length > 0 && /B\.jsx$/.test(shown[shown.length - 1])
      && !shown.some((f) => /A\.jsx$/.test(f)), shown);
    const task = await pg.evaluate(() => {
      sessionStorage.setItem('editlens.pageTask', JSON.stringify({ task: { file: 'src/A.jsx' }, until: Date.now() + 20000 }));
      window.__el.setFollow('all', false);
      return sessionStorage.getItem('editlens.pageTask');
    });
    check('M7: changing Follow clears the page move saved before a reload', task === null, task);

    // L8: colors of the agents on a board are removed when the board is cleared.
    const colors = await pg.evaluate(() => {
      const e = window.__el;
      e.boardSync({ cwd: '/elsewhere', entries: [{ id: 1, kind: 'note', agentId: 'mate1', text: 'a', ts: 1 }, { id: 2, kind: 'note', agentId: 'mate2', text: 'b', ts: 2 }] });
      e.mateColor({ agentId: 'mate1' });
      e.mateColor({ agentId: 'mate2' });
      const before = Object.keys(e.team.colors);
      e.boardClear({ cwd: '/elsewhere' });
      return { before, after: Object.keys(e.team.colors) };
    });
    check('L8: a cleared board removes its agents\' colors', colors.before.includes('mate1') && !colors.after.includes('mate1') && !colors.after.includes('mate2'), colors);

    // L9: 1000 messages of one agent: a limited list, the total still right.
    await chat({ role: 'agent-start', toolUseId: 'tuC', agentId: 'agC', description: 'Agent C', agentType: 'general-purpose', prompt: '' });
    await sleep(400);
    const out = await pg.evaluate(() => {
      const e = window.__el;
      for (let i = 0; i < 1000; i++) e.addAgentStep({ toolUseId: 'tuC', agentId: 'agC', kind: 'tool', tool: 'Read', summary: 'x', msgId: 'm' + i, out: 10 });
      e.addAgentStep({ toolUseId: 'tuC', agentId: 'agC', kind: 'tool', tool: 'Read', summary: 'x', msgId: 'm999', out: 1010 });
      const a = e.agents().tuC;
      return { size: a.out instanceof Map ? a.out.size : Object.keys(a.out).length, text: e.agentTokens('tuC') };
    });
    check('L9: an agent keeps at most 200 message counts, and the total counts every message', out.size <= 200 && /11K written/.test(out.text || ''), out);

    // L11: a sum past the largest number is unknown, and an edit key is never "NaN".
    const sums = await pg.evaluate(() => ({ sum: window.__el.sum({ input: 1e308, output: 1e308 }), key: window.__el.seqKey({ inst: 'i1' }, 'x') }));
    check('L11: token sum past the largest number is null; an edit key from a bad number is not NaN', sums.sum === null && sums.key === 'i1.0', sums);

    // L5: the mic, then Send while the browser still checks the device: no first-use card later.
    await pg.evaluate(`(() => { const r = ${ROOT}; r.querySelector('.composer textarea').focus(); return true; })()`);
    await pg.keyboard.type('Hello');
    await pg.evaluate(`${ROOT}.querySelector('.composer .mic').click()`);
    await sleep(200);
    await pg.evaluate(`${ROOT}.querySelector('.composer .send').click()`);
    await sleep(2500);
    const card = await pg.evaluate(`Boolean(${ROOT}.querySelector('.dpop'))`);
    check('L5: Send during the start: no first-use card after the check ends', !card && (await pg.evaluate(() => window.__recs.length)) === 0, { card });
    await pg.screenshot({ path: path.join(outDir, 'sol45-client.png') });
    check('no page errors', !errors.length, errors);

    // L13: a backend route that never answers: the page reloads once the 8 s wait ends.
    await pg.evaluate(() => {
      window.__mark = 1;
      window.__el.reloadForBackend({ type: 'change', kind: 'backend', file: '/p/server.js', relFile: 'server.js', routes: [] }, [{ method: 'GET', path: '/hang' }]);
    });
    const reloaded = await pg.waitForFunction('!window.__mark', null, { timeout: 15000, polling: 500 }).then(() => true, (err) => {
      if (err.name !== 'TimeoutError') throw err;
      return false;
    });
    check('L13: a request that never answers is stopped at the deadline, and the page reloads', reloaded);
  } finally {
    for (const res of hung) res.destroy();
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
