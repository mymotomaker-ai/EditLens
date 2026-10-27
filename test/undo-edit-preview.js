'use strict';
require('./isolate');
// "Undo only this edit" on a real page and server: the Restore question has Restore · Undo only
// this edit · Cancel (on the edit card, Changes list, file menu and hover card, not on a card that
// undoes something); a clean undo removes only that edit and offers Put it back; a conflict offers
// "Ask Claude to undo it"; a page that can't message Claude has the button off, with the reason.
// Requests by edit number name the server start; after a restart, old cards can't use them.
// usage: NODE_PATH=$(npm root -g) node test/undo-edit-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: undo-edit-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-edit-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5222' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const { diffText, countStats } = require('../lib/diff');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const page = (root) => `<!doctype html><title>App</title><body style="font:16px system-ui;margin:60px">
<h1 id="h" data-editlens-src="src/app.js:2:1">Two</h1>
<p id="s" data-editlens-src="src/app.js:7:1">Seven</p>
<script src="http://127.0.0.1:5222/live.js" ${root ? `data-root="${proj}"` : ''} data-panel="open"></script></body>`;

const APP = path.join(proj, 'src', 'app.js');
const L = (...xs) => xs.join('\n') + '\n';
let text = L('1', '2', '3', '4', '5', '6', '7', '8');
async function edit(next, intent) {
  const before = text;
  text = next;
  fs.writeFileSync(APP, text);
  const hunks = diffText(before, text);
  await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: APP, relFile: 'src/app.js', tool: 'Edit', kind: 'frontend',
    before, after: text, hunks, stats: countStats(hunks), intent, ts: Date.now() });
}
const disk = () => fs.readFileSync(APP, 'utf8');

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page(!/nolink/.test(req.url)));
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
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
    fs.writeFileSync(APP, text);
    const pg = await open(url);
    const messages = [];
    pg.on('request', (r) => { if (r.method() === 'POST' && /\/message$/.test(r.url())) messages.push(JSON.parse(r.postData() || '{}')); });
    const restores = [];
    pg.on('request', (r) => { if (r.method() === 'POST' && /\/restore$/.test(r.url())) restores.push(JSON.parse(r.postData() || '{}')); });
    const q = (src) => pg.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    // The edit card for an intent (newest first when several).
    const card = (intent) => `[...r.querySelectorAll('.k-edit:not(.restore)')].filter((x) => (x.querySelector('.why') || {}).textContent === ${JSON.stringify(intent)}).pop()`;
    const buttons = (box) => q(`const b = ${box}; return b ? [...b.querySelectorAll('.pacts button')].map((x) => ({ t: x.textContent, off: x.disabled, title: x.title })) : null;`);
    const waitOnly = (box) => pg.waitForFunction(`(() => { const r = ${ROOT}; const b = ${box}; const u = b && b.querySelector('.uonly'); return u && u.getAttribute('data-mode') !== 'checking' && b.getAttribute('data-check') === 'done'; })()`, null, { timeout: 5000 }).then(() => true, onTimeout(false));
    const pane = () => q(`const pn = [...r.querySelectorAll('.pane.on')].find((x) => /app\\.js/.test(x.getAttribute('data-path'))); if (!pn) return null;
      return { text: [...pn.querySelectorAll('.cl .tx')].map((t) => t.textContent).join('\\n'), cap: pn.querySelector('.pcap .t').textContent, label: (pn.querySelector('.pcap .rlab') || {}).textContent || '',
        head: (() => { const b = r.querySelector('.dhead .crumb .fbtn'); if (!b || !/app\\.js/.test(b.getAttribute('aria-label'))) return { head: null, off: false }; b.click(); const row = r.querySelector('.lwrap .fmenu [data-act=restore]'); const out = row && row.getAttribute('data-state') !== 'none' ? { head: row.querySelector('.lbl').firstChild.textContent, off: row.disabled } : { head: null, off: false }; r.querySelectorAll('.lwrap').forEach((n) => n.remove()); return out; })().head };`);
    const waitPane = (re) => pg.waitForFunction(`(() => { const pn = [...${ROOT}.querySelectorAll('.pane.on')].find((x) => /app\\.js/.test(x.getAttribute('data-path')));
      return pn && !${ROOT}.querySelector('.tab.busy') && ${re}.test([...pn.querySelectorAll('.cl .tx')].map((t) => t.textContent).join('\\n')); })()`, null, { timeout: 10000 }).then(() => true, onTimeout(false));

    await edit(L('1', 'TWO', '3', '4', '5', '6', '7', '8'), 'Spell out two');
    await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'), 'Spell out seven');
    check('the edits show in the code view', await waitPane(/SEVEN/), await pane());

    await section('Edit card: clean undo, then Put it back', async () => {
      await q(`${card('Spell out two')}.querySelector('.rst').click(); return true;`);
      const box = `${card('Spell out two')}.querySelector('.rconf')`;
      check('the check finished', await waitOnly(box));
      const b = await buttons(box);
      check('buttons in one row: Restore · Undo only this edit · Cancel', JSON.stringify(b.map((x) => x.t)) === JSON.stringify(['Restore', 'Undo only this edit', 'Cancel']) && !b[1].off, b);
      check('Restore is the primary button, Undo only this edit is plain', await q(`const x = ${box}.querySelectorAll('.pacts button'); return x[0].classList.contains('allow') && !x[1].classList.contains('allow') && x[1].classList.contains('mini');`));
      await pg.screenshot({ path: path.join(outDir, 'undo-edit-1-question.png') });
      await q(`${box}.querySelector('.uonly').click(); return true;`);
      await sleep(700);
      check('only that edit is removed; the later edit stays', disk() === L('1', '2', '3', '4', '5', '6', 'SEVEN', '8'), disk());
      const c = await q(`const c = ${card('Spell out two')}; return { line: (c.querySelector('.enote.undid') || {}).textContent || null, tag: (c.querySelector('.rtag') || {}).textContent || null, btn: (c.querySelector('.rst') || {}).textContent || null, hid: Boolean((c.querySelector('.rst') || {}).hidden), box: Boolean(c.querySelector('.rconf')) };`);
      check('the card says "✓ Undid only this edit. Later changes kept." with Put it back', c.line === '✓ Undid only this edit. Later changes kept. Put it back' && !c.box, c);
      check('the card is tagged Undone; its row button is hidden (the undo line has Put it back)', c.tag === 'Undone' && c.btn === 'Put it back' && c.hid, c);
      check('the code view shows the undo', await waitPane(/^2$/m), await pane());
      const v = await pane();
      check('labelled "Undone (only this edit)" in the code view', v.label === 'Undone (only this edit)' && /Undid one earlier edit/.test(v.cap), v);
      await pg.screenshot({ path: path.join(outDir, 'undo-edit-2-done.png') });

      // A card that already undoes something has no single edit to remove.
      await q(`[...r.querySelectorAll('.k-edit.restore')].pop().querySelector('.rst').click(); return true;`);
      await sleep(300);
      const rb = await buttons(`[...r.querySelectorAll('.k-edit.restore')].pop().querySelector('.rconf')`);
      check('not on the Undone card (its question is Undo · Cancel)', rb && JSON.stringify(rb.map((x) => x.t)) === JSON.stringify(['Undo', 'Cancel']), rb);
      await q(`[...r.querySelectorAll('.k-edit.restore')].pop().querySelector('.rst').click(); return true;`);
      await q(`${card('Spell out two')}.querySelector('.rst').click(); return true;`);
      await sleep(300);
      const pb = await buttons(`${card('Spell out two')}.querySelector('.rconf')`);
      check('not on the Put it back question', pb && JSON.stringify(pb.map((x) => x.t)) === JSON.stringify(['Put it back', 'Cancel']), pb);
      await q(`${card('Spell out two')}.querySelector('.rst').click(); return true;`);

      await q(`${card('Spell out two')}.querySelector('.enote.undid button').click(); return true;`);
      await sleep(700);
      check('Put it back puts the edit back', disk() === text, disk());
      const after = await q(`const c = ${card('Spell out two')}; return { line: Boolean(c.querySelector('.enote.undid')), btn: (c.querySelector('.rst') || {}).textContent, hid: Boolean((c.querySelector('.rst') || {}).hidden) };`);
      check('the card has Restore again and no undo line', !after.line && after.btn === 'Restore' && !after.hid, after);
      check('the code view shows the edit again', await waitPane(/TWO/), await pane());
    });

    await section('Changes list', async () => {
      await q(`${card('Spell out two')}.click(); return true;`);
      await sleep(500);
      await q(`r.querySelector('.chg').click(); return true;`);
      await sleep(300);
      const row = `[...r.querySelectorAll('.chlist .chr')].find((x) => /Spell out two/.test(x.textContent) && x.querySelector('.chrst'))`;
      await q(`${row}.querySelector('.chrst').click(); return true;`);
      check('the check finished', await waitOnly(`${row}.querySelector('.rconf')`));
      const b = await buttons(`${row}.querySelector('.rconf')`);
      check('the Changes list question has Undo only this edit', b && b[1] && b[1].t === 'Undo only this edit' && !b[1].off, b);
      await q(`${row}.querySelector('.rconf .uonly').click(); return true;`);
      await sleep(800);
      check('undo from the Changes list works', disk() === L('1', '2', '3', '4', '5', '6', 'SEVEN', '8'), disk());
      const listed = await q(`const x = [...r.querySelectorAll('.chlist .chr')].find((x) => /Spell out two/.test(x.textContent)); return { rb: (x.querySelector('.rb') || {}).textContent || '', btn: (x.querySelector('.chrst') || {}).textContent || '' };`);
      check('the list marks it "Undone (only this edit)" with Put it back', /^Undone \(only this edit\)/.test(listed.rb) && listed.btn === 'Put it back', listed);
      await q(`r.querySelector('.chg').click(); return true;`);
      await q(`${card('Spell out two')}.querySelector('.enote.undid button').click(); return true;`);
      await sleep(700);
      check('and Put it back again', disk() === text, disk());
    });

    await section('Code view header and hover card show the button', async () => {
      await waitPane(/TWO/);
      const v = await pane();
      check('the file menu has Restore…', v.head === 'Restore…', v.head);
      // Restore… is in the file menu (the file's name in the header).
      await q(`r.querySelector('.dhead .crumb .fbtn').click(); r.querySelector('.lwrap .fmenu [data-act=restore]').click(); return true;`);
      check('the question from the file menu has Undo only this edit', await waitOnly(`r.querySelector('.pane > .rconf')`), await buttons(`r.querySelector('.pane > .rconf')`));
      const hb = await buttons(`r.querySelector('.pane > .rconf')`);
      check('in the order Restore · Undo only this edit · Cancel', hb && JSON.stringify(hb.map((x) => x.t)) === JSON.stringify(['Restore', 'Undo only this edit', 'Cancel']), hb);
      await q(`[...r.querySelectorAll('.pane > .rconf button')].find((b) => b.textContent === 'Cancel').click(); return true;`);
      // The edit shown on the page has a bar beside it, which can be where the pointer goes (the
      // wider code view moved the page's text): Esc clears it first.
      await pg.keyboard.press('Escape');
      await pg.waitForFunction(`!${ROOT}.querySelector('.selbar.on')`, null, { timeout: 3000 }).catch((err) => {
        if (err.name !== 'TimeoutError') throw err;
      });
      await pg.mouse.move(5, 5);
      await sleep(300);
      const box = await pg.locator('#s').boundingBox();
      await pg.mouse.move(box.x + 20, box.y + box.height / 2);
      const shown = await pg.waitForFunction(`${ROOT}.querySelector('.peek.on')`, null, { timeout: 5000 }).then(() => true, onTimeout(false));
      check('the hover card opens on the changed part', shown, await pg.evaluate(([x, y]) => { const h = document.elementFromPoint(x, y); const out = []; for (let n = document.querySelector('edit-lens').shadowRoot.elementFromPoint(x, y); n && out.length < 6; n = n.parentElement) out.push(n.tagName + '.' + String(n.className && n.className.baseVal !== undefined ? n.className.baseVal : n.className).replace(/ /g, '.')); return [h && (h.id || h.tagName), out.join(' < '), x, y, innerWidth]; }, [box.x + 20, box.y + box.height / 2]));
      await q(`r.querySelector('.peek .pkrst').click(); return true;`);
      check('the hover card question has Undo only this edit', await waitOnly(`r.querySelector('.peek .rconf')`), await buttons(`r.querySelector('.peek .rconf')`));
      await pg.screenshot({ path: path.join(outDir, 'undo-edit-3-hover.png') });
      await q(`[...r.querySelectorAll('.peek .rconf button')].find((b) => b.textContent === 'Cancel').click(); return true;`);
      await pg.mouse.move(5, 5);
      await pg.keyboard.press('Escape');
      check('nothing changed', disk() === text, disk());
    });

    await section('Conflict: Ask Claude to undo it', async () => {
      await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN!', '8'), 'Shout seven');
      await sleep(800);
      await q(`${card('Spell out seven')}.querySelector('.rst').click(); return true;`);
      const box = `${card('Spell out seven')}.querySelector('.rconf')`;
      await pg.waitForFunction(`(() => { const r = ${ROOT}; const b = ${box}; return b && b.querySelector('.rdim'); })()`, null, { timeout: 5000 }).catch((err) => { if (err.name !== 'TimeoutError') throw err; });
      const c = await q(`const b = ${box}; return { dim: (b.querySelector('.rdim') || {}).textContent || null, dimColor: b.querySelector('.rdim') ? getComputedStyle(b.querySelector('.rdim')).color : '', rqColor: getComputedStyle(b.querySelector('.rq')).color };`);
      check('the dim line says only Claude can undo just this part', c.dim === 'A later edit changed the same lines, so only Claude can undo just this part.' && c.dimColor !== c.rqColor, c);
      const b = await buttons(box);
      check('the button is "Ask Claude to undo it"', b && b[1] && b[1].t === 'Ask Claude to undo it' && !b[1].off, b);
      await pg.screenshot({ path: path.join(outDir, 'undo-edit-4-conflict.png') });
      await q(`${box}.querySelector('.uonly').click(); return true;`);
      await sleep(700);
      const sent = messages.pop();
      check('the fixed message is sent through the normal message path',
        sent && sent.text === 'Undo only edit 2 in src/app.js (line 7, Spell out seven). Keep the later changes.' && typeof sent.pageId === 'string', sent);
      check('the file is not changed by the page', disk() === text, disk());
      const bubble = await q(`return [...r.querySelectorAll('.feed li')].some((x) => /Undo only edit 2 in src\\/app\\.js/.test(x.textContent));`);
      check('it appears in the panel like a typed message', bubble);
      const chip = await q(`const c = ${card('Spell out seven')}; return (c.querySelector('.uask') || {}).textContent || null;`);
      check('the card shows "Claude is undoing it"', chip === 'Claude is undoing it', chip);
      await edit(L('1', 'TWO', '3', '4', '5', '6', '7', '8'), 'Undo seven');
      await sleep(800);
      const gone = await q(`return Boolean(${card('Spell out seven')}.querySelector('.uask'));`);
      check('the label goes at the next edit to that file', !gone);
    });

    await section('A page that can\'t message Claude', async () => {
      const p2 = await open(url + '?nolink');
      const q2 = (src) => p2.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
      await q2(`${card('Spell out two')}.querySelector('.rst').click(); return true;`);
      // The tooltip says "Checking …" until the check ends, then the reason.
      await p2.waitForFunction(`(() => { const r = ${ROOT}; const u = ${card('Spell out two')}.querySelector('.rconf .uonly'); return u && u.title && !/^Checking /.test(u.title); })()`, null, { timeout: 5000 }).catch((err) => { if (err.name !== 'TimeoutError') throw err; });
      const u = await q2(`const u = ${card('Spell out two')}.querySelector('.rconf .uonly'); return u ? { off: u.disabled, title: u.title } : null;`);
      check('the button is off, with the reason in its tooltip', u && u.off && /can't message Claude/.test(u.title), u);
      await p2.close();
    });

    // Edit numbers start again after a restart: every request by number names the server start,
    // and the buttons of edits from an earlier start are off.
    await section('Edit numbers and a restarted EditLens', async () => {
      const MADE = path.join(proj, 'src', 'made.js');
      const made = async (name) => {
        fs.writeFileSync(MADE.replace('made', name), 'x\n');
        await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: MADE.replace('made', name), relFile: `src/${name}.js`, tool: 'Write', kind: 'frontend',
          created: true, before: '', after: 'x\n', stats: { added: 1, removed: 0 }, intent: 'Make ' + name, ts: Date.now() });
      };
      await made('made1');
      await made('made2');
      await sleep(800);
      // Remove file on made1 sends the edit number with the server start.
      await q(`${card('Make made1')}.querySelector('.rst').click(); return true;`);
      await q(`${card('Make made1')}.querySelector('.rconf .allow').click(); return true;`);
      await sleep(700);
      check('Remove file removed the file', !fs.existsSync(MADE.replace('made', 'made1')));
      // Undo only this edit on "Spell out two" again, so its card has Put it back.
      await q(`${card('Spell out two')}.querySelector('.rst').click(); return true;`);
      await waitOnly(`${card('Spell out two')}.querySelector('.rconf')`);
      await q(`${card('Spell out two')}.querySelector('.rconf .uonly').click(); return true;`);
      await sleep(700);
      const byNumber = restores.filter((b) => b.undoEdit !== undefined || b.remove !== undefined);
      const inst = byNumber.length ? byNumber[0].instance : null;
      check('every request by edit number names the server start', byNumber.length >= 4 && typeof inst === 'string' && inst.length > 0 && byNumber.every((b) => b.instance === inst),
        byNumber);
      check('the check, the undo, Put it back and Remove all sent it', ['check', 'back', 'undo', 'remove'].every((k) => byNumber.some((b) =>
        k === 'remove' ? b.remove !== undefined : k === 'check' ? b.check === true : k === 'back' ? b.back === true : b.undoEdit !== undefined && !b.check && !b.back)), byNumber);
      const keys = await q(`return { two: ${card('Spell out two')}.getAttribute('data-ekey'), made: ${card('Make made2')}.getAttribute('data-ekey'), seven: ${card('Undo seven')}.getAttribute('data-ekey') };`);
      const byKey = (k) => `r.querySelector('.k-edit[data-ekey="' + ${JSON.stringify(k)} + '"]')`;
      await stopServer();
      await ensureServer();
      const OLD = 'From before EditLens restarted: reload the page to change it';
      const offNow = await pg.waitForFunction(`(() => { const r = ${ROOT}; const b = ${byKey(keys.made)}.querySelector('.rst'); return b && b.disabled; })()`, null, { timeout: 20000 })
        .then(() => true, onTimeout(false));
      const st = await q(`const m = ${byKey(keys.made)}.querySelector('.rst'); const p = ${byKey(keys.two)}.querySelector('.enote.undid button');
        return { remove: { off: m.disabled, title: m.title }, back: p ? { off: p.disabled, title: p.title } : null };`);
      check('after the restart, Remove file on an old card is off, with the reason', offNow && st.remove.off && st.remove.title === OLD, st);
      check('and Put it back on an old card is off, with the reason', st.back && st.back.off && st.back.title === OLD, st);
      const before = restores.length;
      await q(`${byKey(keys.seven)}.querySelector('.rst').click(); return true;`);
      await sleep(800);
      const u = await q(`const u = ${byKey(keys.seven)}.querySelector('.rconf .uonly'); return u ? { off: u.disabled, title: u.title } : null;`);
      check('and Undo only this edit on an old card is off, with the reason', u && u.off && u.title === OLD, u);
      check('no request by edit number was sent for an old card', !restores.slice(before).some((b) => b.undoEdit !== undefined || b.remove !== undefined), restores.slice(before));
      await pg.screenshot({ path: path.join(outDir, 'undo-edit-5-restarted.png') });
    });

    check('no page errors', errors.length === 0, errors);
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exit(failed ? 1 : 0);
})();
