'use strict';
require('./isolate');
// Sol scan of 0.24.46, the page script: M7 (a Follow file still loading is not shown after Follow
// changed), M8 (Follow never replays a "Log off" button), M9 (online dictation stops when the setting
// no longer allows it), L1 (no Infinity edit counts), L2 (notice keys limited), L3 (Remove copy names
// files never merged), L7 (Deny added when the key arrives) and L8 (copy counts too large are not shown).
// usage: NODE_PATH=$(npm root -g) node test/sol-0.24.46-client-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: sol-0.24.46-client-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol46-client-'));
// Manual: opening the page starts no page control setup.
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5390', CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
for (const n of ['A', 'B']) fs.writeFileSync(path.join(proj, 'src', n + '.jsx'), `export const ${n} = 1;\n`.repeat(8));
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = 'sol46-client';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: proj, ts: Date.now(), backlog: false, ...ev });

// The lines added at the end of the served page script, inside its scope: the checks call its
// inner functions. Nothing else in the script changes.
const HOOK = `
  window.__el = { follow: follow, setFollow: setFollow, enqueue: enqueue, navLike: navLike, editsBy: editsBy, agentEdits: agentEdits,
    onRemoteOutside: onRemoteOutside, onRemoteMissed: onRemoteMissed, seen: function () { return [outsideSeen, missedSeen]; },
    addCopyCard: addCopyCard, copyCards: copyCards, renderCopy: renderCopy, copyKeyOf: copyKeyOf,
    addPermission: addPermission, onDriveGrant: onDriveGrant, permCards: permCards, drive: drive,
    settings: settings, changeSetting: changeSetting, dictToggle: dictToggle, boxes: DICT_BOXES, dictate: function () { return dictate; } };
  window.__shown = [];
  var shownBefore = showFile;
  showFile = function (f) { window.__shown.push(f && f.rel); return shownBefore.apply(this, arguments); };
`;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Sol checks</title></head>
<body style="font:16px system-ui;margin:40px"><h1 id="h">Checks</h1>
<script src="http://127.0.0.1:5390/live.js" data-root="${proj}" data-panel="open" data-settle="300"></script></body></html>`;

// A stand-in SpeechRecognition that can't run on this device (so it runs online when allowed).
function speechStub() {
  window.__recs = [];
  function Fake() { this.aborted = 0; window.__recs.push(this); }
  Fake.prototype.start = function () {};
  Fake.prototype.stop = function () { setTimeout(() => this.onend && this.onend(), 10); };
  Fake.prototype.abort = function () { this.aborted++; setTimeout(() => this.onend && this.onend(), 10); };
  Fake.available = () => Promise.resolve('unavailable');
  window.SpeechRecognition = Fake;
  window.webkitSpeechRecognition = Fake;
}

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
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
        localStorage.setItem('editlens.tourDone', '1');
        localStorage.setItem('editlens.dictationAsked', 'yes');
      } catch (err) {
        if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
      }
    });
    await ctx.route('http://127.0.0.1:5390/live.js', async (route) => {
      const r = await route.fetch();
      const body = (await r.text()).replace(/\}\)\(\);\s*$/, HOOK + '})();\n');
      await route.fulfill({ response: r, body });
    });
    // M7: the code of a Follow file arrives 1.5 s late.
    await ctx.route((u) => u.port === '5390' && u.pathname === '/snapshot', async (route) => {
      await sleep(1500);
      await route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ file: path.join(proj, 'src', 'A.jsx'), relFile: 'src/A.jsx', after: 'export const A = 1;\n' }) });
    });
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(origin + '/');
    await pg.waitForFunction(`window.__el && document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    await chat({ role: 'agent-start', toolUseId: 'tuA', agentId: 'agA', description: 'Agent A', agentType: 'general-purpose', prompt: '' });
    await sleep(500);

    // M7: Follow opens A.jsx (its code still on the way), then Follow changes to Everyone.
    await pg.evaluate(() => {
      const e = window.__el;
      e.setFollow('tuA', false);
      e.enqueue({ ev: { type: 'code', snapshot: '77', file: 'src/A.jsx', line: 1, endLine: 1, part: false, note: null }, owner: 'tuA', auto: true, followReq: e.follow.req });
    });
    await sleep(300);
    await pg.evaluate(() => window.__el.setFollow('all', false));
    await sleep(2200);
    const shown = await pg.evaluate(() => window.__shown.slice());
    check('M7: a Follow file whose code arrives after Follow changed is not shown', !shown.some((f) => /A\.jsx$/.test(f || '')), shown);

    // M8: a nav bar with Reports and Log off: Follow never replays either.
    const nav = await pg.evaluate(() => {
      const n = document.createElement('nav');
      n.innerHTML = '<button id="rep">Reports</button><button id="off">Log off</button><button id="so">Sign off</button>';
      document.body.appendChild(n);
      const e = window.__el;
      return ['rep', 'off', 'so'].map((id) => e.navLike(document.getElementById(id)));
    });
    check('M8: Follow never replays a nav button that logs off (nor its neighbours)', nav.every((v) => v === false), nav);
    // D22: Follow replays only links to another route and tabs; plain nav, menu bar and menu buttons
    // need a click from the user, whatever their words.
    const only = await pg.evaluate(() => {
      const d = document.createElement('div');
      d.innerHTML = '<nav><button id="b1">Reports</button><span role="link" id="l1">Reports</span></nav>' +
        '<div role="menubar"><button role="menuitem" id="m1">Reports</button></div><button aria-controls="x" id="c1">Reports</button>' +
        '<details><summary id="s1">Reports</summary></details>' +
        '<a href="/other-route" id="a1">Reports</a><div role="tablist"><button role="tab" id="t1">Reports</button></div>';
      document.body.appendChild(d);
      const e = window.__el;
      const out = {};
      ['b1', 'l1', 'm1', 'c1', 's1', 'a1', 't1'].forEach((id) => { out[id] = e.navLike(document.getElementById(id)); });
      d.remove();
      return out;
    });
    check('D22: Follow replays only a link to another route and a tab', only.a1 === true && only.t1 === true
      && ['b1', 'l1', 'm1', 'c1', 's1'].every((id) => only[id] === false), only);

    // L1: two owners of one agent with very large counts: no Infinity.
    const edits = await pg.evaluate(() => {
      const e = window.__el;
      e.editsBy.tuA = { 'src/A.jsx': 1e308 };
      e.editsBy['a:agA'] = { 'src/A.jsx': 1e308 };
      const out = e.agentEdits('tuA');
      delete e.editsBy.tuA;
      delete e.editsBy['a:agA'];
      return String(out['src/A.jsx']);
    });
    check('L1: an agent\'s edit count is never Infinity', edits !== 'Infinity', edits);

    // L2: 300 notices from different folders and sessions: the keys kept are limited.
    const seen = await pg.evaluate(() => {
      const e = window.__el;
      for (let i = 0; i < 300; i++) {
        e.onRemoteOutside({ computer: 'vm', where: '/w/' + i });
        e.onRemoteMissed({ computer: 'vm', sessionId: 's' + i, text: 'Missed' });
      }
      const size = (m) => (m instanceof Map || m instanceof Set ? m.size : Object.keys(m).length);
      return e.seen().map(size);
    });
    check('L2: outside and missed notices keep at most 200 keys each', seen.every((n) => n <= 200), seen);

    // L3: a copy whose only files left are held configuration: Remove names them.
    const conf = await pg.evaluate(async () => {
      const e = window.__el;
      const ev = { type: 'copy', cwd: '/p', name: 'c1', ts: Date.now(), agentName: 'Agent X', ready: 0, conflicts: 0,
        files: [{ relFile: 'src/A.jsx', state: 'merged' }, { relFile: '.mcp.json', state: 'held' }, { relFile: '.env', state: 'held' }] };
      e.addCopyCard(ev, true);
      const c = e.copyCards[e.copyKeyOf(ev)];
      const why = c.item.querySelector('.why').textContent;
      [].find.call(c.item.querySelectorAll('.pacts .mini'), (b) => b.textContent === 'Remove copy').click();
      const q = c.item.querySelector('.rconf .rq').textContent;
      return { why, q };
    });
    check('L3: Remove copy names the held files that were never merged', /never merged/.test(conf.q) && /\.mcp\.json/.test(conf.q) && /\.env/.test(conf.q)
      && !/Everything it changed/.test(conf.q + conf.why), conf);

    // L8: counts too large to be real are not shown, and Merge has no count.
    const big = await pg.evaluate(() => {
      const e = window.__el;
      const ev = { type: 'copy', cwd: '/p', name: 'c2', ts: Date.now(), agentName: 'Agent Y', ready: 1e308, conflicts: 1e308,
        files: [{ relFile: 'src/B.jsx', state: 'clean' }] };
      e.addCopyCard(ev, true);
      return e.copyCards[e.copyKeyOf(ev)].item.textContent;
    });
    check('L8: a copy count too large is shown as unknown', !/e\+308|Infinity/.test(big) && /Could not read/.test(big), big);

    // L7: a question drawn before the key arrived gets its Deny when the key comes.
    const deny = await pg.evaluate(() => {
      const e = window.__el;
      e.addPermission({ id: 'perm1', tool: 'Bash', title: 'Run a command', ts: Date.now() });
      const before = Boolean(e.permCards.perm1.card.querySelector('.deny'));
      e.onDriveGrant({ key: 'k'.repeat(48), cwd: '/p', resume: true });
      return { before, after: Boolean(e.permCards.perm1 && e.permCards.perm1.card.querySelector('.pacts .deny')) };
    });
    check('L7: a question card gets Deny when this tab gets the key', !deny.before && deny.after, deny);

    // M9: listening online, then Dictation is set to On this device: it stops.
    const dict = await pg.evaluate(async () => {
      const e = window.__el;
      if (!e.settings.values) e.settings.values = {};
      e.settings.values.dictation = 'Allow online';
      e.boxes[0].area.focus();
      e.dictToggle(e.boxes[0]);
      for (let i = 0; i < 40 && !e.dictate().on; i++) await new Promise((r) => setTimeout(r, 50));
      const where = e.dictate().where;
      const on = e.dictate().on;
      e.changeSetting('dictation', 'On this device');
      await new Promise((r) => setTimeout(r, 100));
      return { on, where, after: e.dictate().on || e.dictate().closing, aborted: window.__recs.map((r) => r.aborted) };
    });
    check('M9: online dictation stops when Dictation is set to On this device', dict.on && dict.where === 'online' && !dict.after
      && dict.aborted[0] > 0, dict);

    // A file reference inside a message sent from this page (the orange bubble) is readable: contrast of
    // at least 4.5 against the bubble, for the link and for code inside it (seen in the README pictures).
    const fref = await pg.evaluate(() => {
      const root = document.querySelector('edit-lens').shadowRoot;
      const item = document.createElement('div');
      item.className = 'item k-user page';
      item.innerHTML = '<div class="bubble"><div class="md">Change <a class="fref" href="#">public/index.html</a>'
        + ' and <a class="fref" href="#"><code>app.js</code></a></div></div>';
      (root.querySelector('.feed') || root.firstElementChild).appendChild(item);
      const rgb = (c) => (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (c) => rgb(c).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
      const bg = getComputedStyle(item.querySelector('.bubble')).backgroundColor;
      const out = [...item.querySelectorAll('a.fref')].map((a) => {
        const code = a.querySelector('code');
        return Math.round(ratio(getComputedStyle(code || a).color, bg) * 10) / 10;
      });
      item.remove();
      return { bg, out };
    });
    check('a file reference in a message from this page is readable on its bubble', fref.out.every((r) => r >= 4.5), fref);

    await pg.screenshot({ path: path.join(outDir, 'sol46-client.png') });
    check('no page errors', !errors.length, errors);
  } finally {
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
