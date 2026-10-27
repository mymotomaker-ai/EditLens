'use strict';
require('./isolate');
// Restore and "Undo only this edit" for edits made on a paired computer, on a real page: two servers
// stand in for a VPS (where Claude edits) and a laptop (whose page shows "◆ <name>: <file>"). The
// work is done on the VPS and its result appears on the laptop; also Put it back, Remove file, a
// conflict (Ask Claude is off), the VPS stopped, and an older EditLens there.
// usage: NODE_PATH=$(npm root -g) node test/undo-remote-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const tls = require('tls');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launch } = require('./launch');
const wire = require('../lib/pairwire');
const { diffText, countStats } = require('../lib/diff');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: undo-remote-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-remote-'));
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 5223, pairPort: 5224, dir: path.join(tmp, 'host') };
const REMOTE = { port: 5225, pairPort: 5226, dir: path.join(tmp, 'remote') };
const vpsProject = path.join(tmp, 'vps-site');
const laptopProject = path.join(tmp, 'laptop-app');
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const L = (...xs) => xs.join('\n') + '\n';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
async function waitFor(fn, ms = 15000) {
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

const APP = path.join(vpsProject, 'src', 'app.js');
const disk = (f = APP) => fs.readFileSync(f, 'utf8');
async function vpsEdit(file, next, intent, extra = {}) {
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  const hunks = diffText(before, next);
  await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'v1', cwd: vpsProject, file, relFile: path.relative(vpsProject, file), tool: 'Edit', kind: 'frontend',
    before, after: next, hunks, stats: countStats(hunks), intent, ts: Date.now(), ...extra });
}

// A request the old peer could not read (closed, too slow, not JSON): logged, and the socket closed.
function dropped(err) {
  console.log(`old peer: a request could not be read: ${err.message}`);
  return null;
}
// A paired computer on EditLens 0.24.29: its edits have no ref, and it does not know the request.
function oldPeer(saved) {
  let sent = false;
  return tls.createServer({ ...wire.TLS, pskCallback: (s, id) => (id === saved.id ? Buffer.from(saved.key, 'hex') : null) }, async (socket) => {
    socket.on('error', () => socket.destroy());
    const head = await wire.readHeader(socket).catch(dropped);
    if (!head) return socket.destroy();
    if (head.t === 'ping') {
      wire.writeLine(socket, { ok: true, protocol: wire.PROTOCOL, version: '0.24.29', name: 'oldvps', site: false });
      return socket.end();
    }
    if (head.t !== 'task') return socket.destroy();
    const body = await wire.readHeader(socket, 5000, wire.BODY_MAX).catch(dropped);
    if (!body) return socket.destroy();
    if (body.op === 'watch-all') {
      const edits = sent ? [] : [{ kind: 'session', rel: 'old.js', file: '/srv/old/old.js', tool: 'Edit', intent: 'Old edit', before: 'a\n', after: 'b\n', stats: { added: 1, removed: 1 }, ts: Date.now(), fseq: 5 }];
      if (sent) await sleep(1000);
      sent = true;
      wire.writeLine(socket, { computer: 'oldvps', seq: 1, tasks: [], edits, editSeq: 5 });
      return socket.end();
    }
    wire.writeLine(socket, { error: `Unknown op "${body.op}".` });
    return socket.end();
  });
}

(async () => {
  fs.mkdirSync(path.join(vpsProject, 'src'), { recursive: true });
  fs.writeFileSync(APP, L('1', '2', '3', '4', '5', '6', '7', '8'));
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'start']]) spawnSync('git', ['-C', vpsProject, ...args]);
  fs.mkdirSync(laptopProject, { recursive: true });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>Laptop app</title><body style="font:16px system-ui;margin:60px"><h1>Laptop app</h1>
<script src="http://127.0.0.1:${REMOTE.port}/live.js" data-root="${laptopProject}" data-panel="open"></script></body>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  let browser = null;
  let oldServer = null;
  try {
    await start(HOST);
    await start(REMOTE);
    await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, ts: Date.now() });
    const { code } = await api(HOST, 'POST', '/pair', { cwd: vpsProject });
    const joined = await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code });
    check('the laptop pairs with the VPS', joined && joined.ok, joined);
    browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}, [HOST.child, REMOTE.child]);
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    // Skip the tour; localStorage can throw in private mode.
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    const errors = [];
    const section = (name, fn) => fn().catch((err) => check(name + ' (step failed)', false, err.message.split('\n')[0]));
    const open = async (u) => {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(u);
      await p.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
      await sleep(800);
      return p;
    };
    const pg = await open(url);
    await api(REMOTE, 'GET', '/remote/tasks?follow=');
    const messages = [];
    pg.on('request', (r) => { if (r.method() === 'POST' && /\/message$/.test(r.url())) messages.push(r.postData()); });
    const q = (src) => pg.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const card = (intent) => `[...r.querySelectorAll('.k-edit:not(.restore)')].filter((x) => (x.querySelector('.why') || {}).textContent === ${JSON.stringify(intent)}).pop()`;
    const waitCard = (intent) => pg.waitForFunction(`(() => { const r = ${ROOT}; return ${card(intent)}; })()`, null, { timeout: 10000 }).then(() => true, onTimeout(false));
    const buttons = (box) => q(`const b = ${box}; return b ? [...b.querySelectorAll('.pacts button')].map((x) => ({ t: x.textContent, off: x.disabled, title: x.title })) : null;`);
    const waitOnly = (box) => pg.waitForFunction(`(() => { const r = ${ROOT}; const b = ${box}; const u = b && b.querySelector('.uonly'); return u && u.getAttribute('data-mode') !== 'checking' && b.getAttribute('data-check') === 'done'; })()`, null, { timeout: 8000 }).then(() => true, onTimeout(false));
    const paneOf = `[...r.querySelectorAll('.pane.on')].find((x) => /app\\.js/.test(x.getAttribute('data-path')))`;
    const pane = () => q(`const pn = ${paneOf}; if (!pn) return null;
      return { text: [...pn.querySelectorAll('.cl .tx')].map((t) => t.textContent).join('\\n'), label: (pn.querySelector('.pcap .rlab') || {}).textContent || '',
        head: (() => { const b = r.querySelector('.dhead .crumb .fbtn'); if (!b || !/app\\.js/.test(b.getAttribute('aria-label'))) return { head: null, off: false }; b.click(); const row = r.querySelector('.lwrap .fmenu [data-act=restore]'); const out = row && row.getAttribute('data-state') !== 'none' ? { head: row.querySelector('.lbl').firstChild.textContent, off: row.disabled } : { head: null, off: false }; r.querySelectorAll('.lwrap').forEach((n) => n.remove()); return out; })().head, headOff: (() => { const b = r.querySelector('.dhead .crumb .fbtn'); if (!b || !/app\\.js/.test(b.getAttribute('aria-label'))) return { head: null, off: false }; b.click(); const row = r.querySelector('.lwrap .fmenu [data-act=restore]'); const out = row && row.getAttribute('data-state') !== 'none' ? { head: row.querySelector('.lbl').firstChild.textContent, off: row.disabled } : { head: null, off: false }; r.querySelectorAll('.lwrap').forEach((n) => n.remove()); return out; })().off };`);
    const waitPane = (re) => pg.waitForFunction(`(() => { const r = ${ROOT}; const pn = ${paneOf};
      return pn && !r.querySelector('.tab.busy') && ${re}.test([...pn.querySelectorAll('.cl .tx')].map((t) => t.textContent).join('\\n')); })()`, null, { timeout: 10000 }).then(() => true, onTimeout(false));

    await vpsEdit(APP, L('1', 'TWO', '3', '4', '5', '6', '7', '8'), 'Spell out two');
    await vpsEdit(APP, L('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'), 'Spell out seven');
    check('the VPS edits show on the laptop page', await waitCard('Spell out seven'));
    // The agent chip names the computer ("◆ <name>"; the card's text runs words together).
    const name = await q(`const c = ${card('Spell out two')}; const a = c && c.querySelector('.ewho .achip'); return a ? a.textContent : c && c.textContent;`);
    const computer = (/◆ ([\w-]+)/.exec(name) || [])[1] || '';
    check('labelled with the VPS\'s name', Boolean(computer), name);

    await section('Edit card: clean undo on the VPS, then Put it back', async () => {
      const rst = await q(`const b = ${card('Spell out two')}.querySelector('.rst'); return b ? { t: b.textContent, off: b.disabled } : null;`);
      check('the remote edit card has Restore', rst && rst.t === 'Restore' && !rst.off, rst);
      await q(`${card('Spell out two')}.querySelector('.rst').click(); return true;`);
      const box = `${card('Spell out two')}.querySelector('.rconf')`;
      check('the check finished', await waitOnly(box));
      const b = await buttons(box);
      check('buttons: Restore · Undo only this edit · Cancel, all on', b && JSON.stringify(b.map((x) => x.t)) === JSON.stringify(['Restore', 'Undo only this edit', 'Cancel']) && !b[0].off && !b[1].off, b);
      await pg.screenshot({ path: path.join(outDir, 'undo-remote-1-question.png') });
      await q(`${box}.querySelector('.uonly').click(); return true;`);
      const done = await waitFor(() => disk() === L('1', '2', '3', '4', '5', '6', 'SEVEN', '8'), 5000);
      check('the VPS file has only that edit removed; the later edit stays', done, disk());
      await pg.waitForFunction(`(() => { const r = ${ROOT}; return ${card('Spell out two')}.querySelector('.enote.undid'); })()`, null, { timeout: 8000 }).catch(onTimeout(null));
      const c = await q(`const c = ${card('Spell out two')}; return { line: (c.querySelector('.enote.undid') || {}).textContent || null, tag: (c.querySelector('.rtag') || {}).textContent || null, box: Boolean(c.querySelector('.rconf')) };`);
      check('the card says "✓ Undid only this edit. Later changes kept." with Put it back', c.line === '✓ Undid only this edit. Later changes kept. Put it back' && c.tag === 'Undone' && !c.box, c);
      const restoreCard = await q(`const x = [...r.querySelectorAll('.k-edit.restore')].pop(); return x ? { tag: (x.querySelector('.tool') || {}).textContent, note: (x.querySelector('.enote') || {}).textContent } : null;`);
      check('the VPS\'s result shows as a card here', restoreCard && restoreCard.tag === 'Undone (only this edit)' && /^On ◆ /.test(restoreCard.note), restoreCard);
      check('the code view shows it', await waitPane(/^2$/m), await pane());
      const v = await pane();
      check('labelled "Undone (only this edit)" in the code view', v && v.label === 'Undone (only this edit)', v);
      await pg.screenshot({ path: path.join(outDir, 'undo-remote-2-done.png') });
      await q(`${card('Spell out two')}.querySelector('.enote.undid button').click(); return true;`);
      check('Put it back puts the edit back on the VPS', await waitFor(() => disk() === L('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'), 5000), disk());
      const back = await pg.waitForFunction(`(() => { const r = ${ROOT}; const c = ${card('Spell out two')}; const b = c.querySelector('.rst'); return !c.querySelector('.enote.undid') && b && b.textContent === 'Restore' && !b.hidden; })()`, null, { timeout: 8000 }).then(() => true, onTimeout(false));
      check('the card has Restore again', back);
    });

    await section('Changes list and file menu in the code view', async () => {
      await q(`${card('Spell out two')}.click(); return true;`);
      await sleep(400);
      await q(`r.querySelector('.chg').click(); return true;`);
      await sleep(300);
      const row = `[...r.querySelectorAll('.chlist .chr')].find((x) => /Spell out two/.test(x.textContent) && x.querySelector('.chrst'))`;
      const has = await q(`return Boolean(${row});`);
      check('the Changes list has Restore for the remote edit', has);
      if (has) {
        await q(`${row}.querySelector('.chrst').click(); return true;`);
        check('its question has Undo only this edit', await waitOnly(`${row}.querySelector('.rconf')`), await buttons(`${row}.querySelector('.rconf')`));
        const b = await buttons(`${row}.querySelector('.rconf')`);
        check('in the order Restore · Undo only this edit · Cancel', b && JSON.stringify(b.map((x) => x.t)) === JSON.stringify(['Restore', 'Undo only this edit', 'Cancel']), b);
        await q(`[...${row}.querySelectorAll('.rconf button')].find((x) => x.textContent === 'Cancel').click(); return true;`);
      }
      await q(`r.querySelector('.chg').click(); return true;`);
      await waitPane(/SEVEN/);
      const v = await pane();
      check('the file menu in the code view has Restore…', v && v.head === 'Restore…' && !v.headOff, v);
      // Restore… is in the file menu (the file's name in the header).
      await q(`r.querySelector('.dhead .crumb .fbtn').click(); r.querySelector('.lwrap .fmenu [data-act=restore]').click(); return true;`);
      check('the question from the file menu has Undo only this edit', await waitOnly(`r.querySelector('.pane > .rconf')`), await buttons(`r.querySelector('.pane > .rconf')`));
      // Restore from the header: the whole file, as before the latest edit, done on the VPS.
      // Restore is on once its check answers.
      await pg.waitForFunction(`(() => { const g = ${ROOT}.querySelector('.pane > .rconf .allow'); return g && !g.disabled; })()`, null, { timeout: 8000 }).catch(onTimeout(null));
      await q(`r.querySelector('.pane > .rconf .allow').click(); return true;`);
      check('Restore from the header puts the VPS file back', await waitFor(() => disk() === L('1', 'TWO', '3', '4', '5', '6', '7', '8'), 5000), disk());
      const toast = await pg.waitForFunction(`(() => { const t = ${ROOT}.querySelector('.toast.on'); return t && /^Restored ◆ /.test(t.textContent) && t.querySelector('button') && t.textContent; })()`, null, { timeout: 5000 }).then((h) => h.jsonValue(), onTimeout(null));
      check('the toast says what was restored, with Undo', Boolean(toast), toast);
      await q(`[...r.querySelectorAll('.toast.on button')].pop().click(); return true;`);
      check('its Undo puts the edit back on the VPS', await waitFor(() => disk() === L('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'), 5000), disk());
    });

    await section('Conflict: Ask Claude there', async () => {
      await vpsEdit(APP, L('1', 'TWO', '3', '4', '5', '6', 'SEVEN!', '8'), 'Shout seven');
      await waitCard('Shout seven');
      await q(`${card('Spell out seven')}.querySelector('.rst').click(); return true;`);
      const box = `${card('Spell out seven')}.querySelector('.rconf')`;
      check('the check finished', await waitOnly(box));
      const c = await q(`const b = ${box}; return { dim: (b.querySelector('.rdim') || {}).textContent || null };`);
      check('the dim line says only Claude can undo just this part', c.dim === 'A later edit changed the same lines, so only Claude can undo just this part.', c);
      const b = await buttons(box);
      const want = `This edit was made on ${computer}. Ask Claude there.`;
      check('"Ask Claude to undo it" is off, with the tooltip', b && b[1] && b[1].t === 'Ask Claude to undo it' && b[1].off && b[1].title === want, b);
      check('Restore still works there', b && b[0] && b[0].t === 'Restore' && !b[0].off, b);
      await pg.screenshot({ path: path.join(outDir, 'undo-remote-3-conflict.png') });
      await q(`${box}.querySelector('.uonly').click(); return true;`);
      await sleep(400);
      check('nothing is sent to Claude here', messages.length === 0, messages);
      await q(`[...${box}.querySelectorAll('button')].find((x) => x.textContent === 'Cancel').click(); return true;`);
    });

    await section('Remove file, for a file Claude created there', async () => {
      const NEW = path.join(vpsProject, 'src', 'new.js');
      await vpsEdit(NEW, 'new\n', 'Add a file', { created: true });
      await waitCard('Add a file');
      const rm = await q(`const b = ${card('Add a file')}.querySelector('.rst'); return b ? b.textContent : null;`);
      check('the card has Remove file', rm === 'Remove file', rm);
      await q(`${card('Add a file')}.querySelector('.rst').click(); return true;`);
      const ready = await pg.waitForFunction(`(() => { const r = ${ROOT}; const g = ${card('Add a file')}.querySelector('.rconf .allow'); return g && !g.disabled; })()`, null, { timeout: 8000 }).then(() => true, onTimeout(false));
      check('its button turns on once the VPS is checked', ready);
      await q(`${card('Add a file')}.querySelector('.rconf .allow').click(); return true;`);
      check('the file is removed on the VPS', await waitFor(() => !fs.existsSync(NEW), 5000));
      const tag = await pg.waitForFunction(`(() => { const r = ${ROOT}; const t = ${card('Add a file')}.querySelector('.rtag'); return t && t.textContent; })()`, null, { timeout: 8000 }).then((h) => h.jsonValue(), onTimeout(null));
      check('its card is tagged Removed', tag === 'Removed', tag);
    });

    await section('The VPS stopped: the buttons are off, with the reason', async () => {
      await stop(HOST);
      await q(`${card('Spell out two')}.querySelector('.rst').click(); return true;`);
      const box = `${card('Spell out two')}.querySelector('.rconf')`;
      check('the check finished', await waitOnly(box));
      const want = `${computer} is not connected. Try again when it reconnects.`;
      // Restore has its own check, which can answer after Undo only this edit's.
      check('the Restore check finished', await pg.waitForFunction(`(() => { const r = ${ROOT}; const g = ${box}.querySelector('.pacts button'); return g && g.disabled; })()`, null, { timeout: 8000 }).then(() => true, onTimeout(false)));
      const b = await buttons(box);
      const rq = await q(`return ${box}.querySelector('.rq').textContent;`);
      check('Restore and Undo only this edit are off', b && b[0].off && b[1].off, b);
      check('the reason is said in the question and the tooltips', rq === want && b[0].title === want && b[1].title === want, { rq, b });
      await pg.screenshot({ path: path.join(outDir, 'undo-remote-4-not-connected.png') });
    });

    await section('An older EditLens there: Restore is off, with the reason', async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(REMOTE.dir, 'pair-remote.json'), 'utf8')).hosts[0];
      oldServer = oldPeer(saved);
      await new Promise((r) => oldServer.listen(0, '127.0.0.1', r));
      await pg.close();
      await stop(REMOTE);
      const file = path.join(REMOTE.dir, 'pair-remote.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      data.hosts[0].port = oldServer.address().port;
      fs.writeFileSync(file, JSON.stringify(data));
      await start(REMOTE);
      const p2 = await open(url);
      await api(REMOTE, 'GET', '/remote/tasks?follow=');
      const q2 = (src) => p2.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
      const got = await p2.waitForFunction(`(() => { const r = ${ROOT}; return ${card('Old edit')}; })()`, null, { timeout: 10000 }).then(() => true, onTimeout(false));
      check('its edit shows', got);
      const b = await q2(`const b = ${card('Old edit')}.querySelector('.rst'); return b ? { t: b.textContent, off: b.disabled, title: b.title } : null;`);
      check('the card\'s Restore is off: "Update EditLens on oldvps to restore its edits."', b && b.t === 'Restore' && b.off && b.title === 'Update EditLens on oldvps to restore its edits.', b);
      await q2(`${card('Old edit')}.click(); return true;`);
      await sleep(400);
      await q2(`r.querySelector('.chg').click(); return true;`);
      await sleep(300);
      const ch = await q2(`const x = [...r.querySelectorAll('.chlist .chr')].find((x) => /Old edit/.test(x.textContent)); const b = x && x.querySelector('.chrst'); return b ? { off: b.disabled, title: b.title } : null;`);
      check('so is the Changes list\'s', ch && ch.off && /^Update EditLens on oldvps/.test(ch.title), ch);
      await p2.screenshot({ path: path.join(outDir, 'undo-remote-5-older.png') });
      await p2.close();
    });

    check('no page errors', errors.length === 0, errors);
  } finally {
    if (browser) await browser.close();
    site.close();
    if (oldServer) oldServer.close();
    await stop(HOST);
    await stop(REMOTE);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})();
