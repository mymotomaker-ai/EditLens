'use strict';
require('./isolate');
// Restore everywhere, and the reversal shown live in the code view, on a real page and server: the
// card's Restore and Undo restore, the toast's Undo (one request however fast the clicks), the hover
// card, the Changes list and the file menu; a copy no longer kept, a missing or read-only file,
// EditLens stopped; removing a created file; binary files; Restore after EditLens restarts.
// usage: NODE_PATH=$(npm root -g) node test/restore-live-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: restore-live-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-restore-live-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '4998' });
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

const PAGE = `<!doctype html><title>App</title><body style="font:16px system-ui;margin:60px">
<h1 id="h" data-editlens-src="src/app.js:1:1">Hello</h1>
<p id="o" data-editlens-src="src/other.js:1:1">Other</p>
<p class="t2">Old words</p>
<script src="http://127.0.0.1:4998/live.js" data-root="${proj}" data-panel="open"></script></body>`;

const APP = path.join(proj, 'src', 'app.js');
const OLD = 'const title = "Hello";\nexport default title;\n';
const NEW = 'const title = "Hi there";\nexport default title;\n';
function edit(rel, before, after, extra) {
  const hunks = diffText(before, after);
  return postEvent({ type: 'change', sessionId: 's1', cwd: proj, file: path.join(proj, rel), relFile: rel, tool: 'Edit', kind: 'frontend',
    before, after, hunks, stats: countStats(hunks), intent: 'Change the title', ts: Date.now(), ...extra });
}
const disk = (f = APP) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
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
    const open = async () => {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(url);
      await p.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
      await sleep(800);
      return p;
    };
    const page = await open();
    const page2 = await open();
    const restores = [];
    page.on('request', (r) => { if (r.method() === 'POST' && /\/restore$/.test(r.url()) && !/"check":true/.test(r.postData() || '')) restores.push(r.postData()); });
    const qp = (p, src) => p.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const q = (src) => qp(page, src);
    // The question's Restore button is on once the server has checked the file: wait until it is on,
    // not a fixed time (a click on it while it is off does nothing). Polled by time: this tab may be in the
    // background, where animation frames do not run.
    const clickWhen = (find) => page.waitForFunction(`(() => { const r = ${ROOT}; const b = ${find}; const on = Boolean(b && !b.disabled); if (on) b.click(); return on; })()`,
      null, { timeout: 10000, polling: 100 });
    const appCard = (p, n = 0) => qp(p, `const c = [...r.querySelectorAll('.k-edit:not(.restore)')].filter((x) => /app\\.js/.test(x.textContent))[${n}]; return c ? { cls: c.className, tag: (c.querySelector('.rtag') || {}).textContent || null, btn: (c.querySelector('.rst') || {}).textContent || null } : null;`);
    const pane = (p) => qp(p, `const pn = [...r.querySelectorAll('.pane.on')].find((x) => /app\\.js/.test(x.getAttribute('data-path'))); if (!pn) return null;
      return { text: [...pn.querySelectorAll('.cl .tx')].map((t) => t.textContent).join('\\n'), cap: pn.querySelector('.pcap .t').textContent, label: (pn.querySelector('.pcap .rlab') || {}).textContent || '',
        rst: pn.classList.contains('rstd'), busy: Boolean(r.querySelector('.tab.busy')), head: (() => { const b = r.querySelector('.dhead .crumb .fbtn'); if (!b || !/app\\.js/.test(b.getAttribute('aria-label'))) return { head: null, off: false }; b.click(); const row = r.querySelector('.lwrap .fmenu [data-act=restore]'); const out = row && row.getAttribute('data-state') !== 'none' ? { head: row.querySelector('.lbl').firstChild.textContent, off: row.disabled } : { head: null, off: false }; r.querySelectorAll('.lwrap').forEach((n) => n.remove()); return out; })().head };`);
    const waitPane = (p, re) => p.waitForFunction(`(() => { const pn = [...${ROOT}.querySelectorAll('.pane.on')].find((x) => /app\\.js/.test(x.getAttribute('data-path')));
      return pn && !${ROOT}.querySelector('.tab.busy') && ${re}.test([...pn.querySelectorAll('.cl .tx')].map((t) => t.textContent).join('\\n')); })()`, null, { timeout: 10000 }).then(() => true, onTimeout(false));

    fs.writeFileSync(APP, NEW);
    await edit('src/app.js', OLD, NEW);
    check('the edit plays in the code view', await waitPane(page, /Hi there/), await pane(page));

    await section('Restore on the edit card', async () => {
      await q(`[...r.querySelectorAll('.k-edit')].find((x) => /app\\.js/.test(x.textContent)).querySelector('.rst').click(); return true;`);
      await clickWhen(`r.querySelector('.k-edit .rconf .allow')`);
      await sleep(300);
      check('the file on disk is restored', disk() === OLD, disk());
      const reversed = await waitPane(page, /"Hello"/);
      const v = await pane(page);
      check('the code view shows the reversal (restored text)', reversed && /"Hello"/.test(v.text) && !/Hi there/.test(v.text), v);
      check('labelled "Restored", caption "Restored 1 line", in the restore color', v.label === 'Restored' && v.cap === 'Restored 1 line' && v.rst, v);
      const card = await appCard(page);
      check('the edit card is marked Restored, its button is Undo restore', /restored/.test(card.cls) && card.tag === 'Restored' && card.btn === 'Undo restore', card);
      const rc = await q(`const c = [...r.querySelectorAll('.k-edit.restore')].pop(); return c ? { tag: c.querySelector('.tool').textContent, btn: (c.querySelector('.rst') || {}).textContent } : null;`);
      check('a Restored card follows, with Undo', rc && rc.tag === 'Restored' && rc.btn === 'Undo', rc);
      const toast = await q(`const t = r.querySelector('.toast'); return { on: t.classList.contains('on'), text: t.textContent };`);
      check('the toast says Restored, with Undo', toast.on && /Restored src\/app\.js\./.test(toast.text) && /Undo/.test(toast.text), toast);
      check('the file menu in the code view offers Undo restore', v.head === 'Undo restore', v.head);
      await page.screenshot({ path: path.join(outDir, 'restore-live-1.png') });
      // The other tab: the same card and the same reversal, no "from another tab" toast.
      check('the other tab plays the reversal too', await waitPane(page2, /"Hello"/), await pane(page2));
      const t2 = await qp(page2, `return { restoreCards: r.querySelectorAll('.k-edit.restore').length, toast: r.querySelector('.toast').textContent, card: (([...r.querySelectorAll('.k-edit:not(.restore)')].find((x) => /app\\.js/.test(x.textContent)) || {}).className || '') };`);
      check('the other tab has the Restored card and marks the edit', t2.restoreCards === 1 && /restored/.test(t2.card) && !/another tab/.test(t2.toast), t2);
    });

    await section('Undo in the toast', async () => {
      const before = restores.length;
      await q(`const b = r.querySelector('.toast button'); b.click(); b.click(); b.click(); return true;`);
      await sleep(800);
      check('three fast clicks send one request', restores.length - before === 1, restores.length - before);
      check('Undo puts the edit back on disk', disk() === NEW, disk());
      check('the code view shows the edit again', await waitPane(page, /Hi there/), await pane(page));
      const v = await pane(page);
      check('labelled Undone, caption "Undid restore"', v.label === 'Undone' && v.cap === 'Undid restore', v);
      const toast = await q(`return r.querySelector('.toast').textContent`);
      check('the toast says "Undid the restore", with Redo', /Undid the restore of src\/app\.js/.test(toast) && /Redo/.test(toast), toast);
      const card = await appCard(page);
      check('the edit card has Restore again', !/restored/.test(card.cls) && card.btn === 'Restore', card);
      await q(`r.querySelector('.toast').classList.remove('on'); return true;`);
    });

    await section('Restore on the hover card', async () => {
      await page.mouse.move(5, 5);
      await sleep(300);
      const box = await page.locator('#h').boundingBox();
      await page.mouse.move(box.x + 20, box.y + box.height / 2);
      const shown = await page.waitForFunction(`${ROOT}.querySelector('.peek.on')`, null, { timeout: 5000 }).then(() => true, onTimeout(false));
      check('the hover card opens on the changed heading', shown);
      // The newest change here is the undone restore: its button puts the restore back.
      const label = await q(`const b = r.querySelector('.peek .pkrst'); return b ? b.textContent : null;`);
      check('the hover card has a restore button', Boolean(label), label);
      await q(`r.querySelector('.peek .pkrst').click(); return true;`);
      await sleep(400);
      const ask = await q(`const b = r.querySelector('.peek .rconf'); return { box: b ? b.textContent : null, pinned: r.querySelector('.peek').classList.contains('pinned') };`);
      check('the hover card asks first and stays open', ask.box && /Put src\/app\.js back/.test(ask.box) && ask.pinned, ask);
      // Drawn again (a new edit of another file arrives): the question stays.
      fs.writeFileSync(path.join(proj, 'src', 'other.js'), 'b\n');
      await edit('src/other.js', 'a\n', 'b\n');
      await sleep(600);
      check('the question is still there after the card is drawn again', Boolean(await q(`return r.querySelector('.peek .rconf')`)));
      await page.screenshot({ path: path.join(outDir, 'restore-live-2-hover.png') });
      await q(`r.querySelector('.peek .rconf .allow').click(); return true;`);
      await sleep(600);
      check('the hover card Restore restores the file', disk() === OLD, disk());
      check('and the hover card closes', !(await q(`return r.querySelector('.peek.on')`)));
      check('the code view shows the reversal', await waitPane(page, /"Hello"/), await pane(page));
      // A restore that puts text on the page back: its part is marked in the restore color.
      const T = path.join(proj, 'src', 'Note.jsx');
      const T_OLD = 'export default () => <p className="t2">Old words</p>;\n';
      const T_NEW = 'export default () => <p className="t2">New words</p>;\n';
      fs.writeFileSync(T, T_NEW);
      await edit('src/Note.jsx', T_OLD, T_NEW);
      await sleep(1200);
      const marksBefore = await q(`return r.querySelectorAll('.emark.rst').length`);
      await q(`[...r.querySelectorAll('.k-edit:not(.restore)')].filter((x) => /Note\.jsx/.test(x.textContent)).pop().querySelector('.rst').click(); return true;`);
      await sleep(300);
      await q(`[...r.querySelectorAll('.k-edit .rconf .allow')].pop().click(); return true;`);
      await sleep(2500);
      check('restored Note.jsx', disk(T) === T_OLD, disk(T));
      const marker = await q(`const m = [...r.querySelectorAll('.emark.rst')]; return { n: m.length, color: m.length ? getComputedStyle(m[m.length - 1]).backgroundColor : null, accent: getComputedStyle(r.querySelector('.emark:not(.rst)') || r.host).backgroundColor };`);
      check('the page marker for the restore is in the restore color', marker.n > marksBefore && marker.color !== marker.accent, marker);
    });

    await section('Restore in the file menu in the code view', async () => {
      const v = await pane(page);
      check('the file menu says Undo restore', v.head === 'Undo restore', v.head);
      // Restore… is in the file menu (the file's name in the header).
      await q(`r.querySelector('.dhead .crumb .fbtn').click(); r.querySelector('.lwrap .fmenu [data-act=restore]').click(); return true;`);
      await sleep(400);
      const ask = await q(`const b = r.querySelector('.pane > .rconf'); return b ? b.textContent : null;`);
      check('it asks inside the code view', /before the restore/.test(ask || ''), ask);
      await q(`r.querySelector('.pane > .rconf .allow').click(); return true;`);
      await sleep(600);
      check('Undo restore in the file menu works', disk() === NEW, disk());
      check('the code view shows it', await waitPane(page, /Hi there/), await pane(page));
      check('the file menu offers Restore… again', (await pane(page)).head === 'Restore…', (await pane(page)).head);
    });

    await section('Restore in the Changes list', async () => {
      await q(`[...r.querySelectorAll('.k-edit:not(.restore)')].find((x) => /app\\.js/.test(x.textContent)).click(); return true;`);
      await sleep(500);
      await q(`r.querySelector('.chg').click(); return true;`);
      await sleep(300);
      const rows = await q(`return [...r.querySelectorAll('.chlist .chr')].map((x) => ({ f: x.querySelector('.chi .f').textContent.replace(/\\u200e/g, ''), btn: (x.querySelector('.chrst') || {}).textContent || null, rb: Boolean(x.querySelector('.rb')) }))`);
      check('Changes rows have a Restore action, and restores are listed', rows.some((x) => /app\.js/.test(x.f) && x.btn === 'Restore') && rows.filter((x) => /app\.js/.test(x.f)).length >= 4, rows);
      await q(`[...r.querySelectorAll('.chlist .chr')].find((x) => /app\\.js/.test(x.textContent) && x.querySelector('.chrst') && x.querySelector('.chrst').textContent === 'Restore').querySelector('.chrst').click(); return true;`);
      await clickWhen(`r.querySelector('.chlist .rconf .allow')`);
      await sleep(800);
      check('Restore from the Changes list works', disk() === OLD, disk());
      const marked = await q(`return [...r.querySelectorAll('.chlist .chr')].some((x) => /app\\.js/.test(x.textContent) && x.querySelector('.rb'))`);
      check('the restored change is marked in the list', marked);
      await q(`r.querySelector('.chg').click(); return true;`);
    });

    await section('Edge cases', async () => {
      // A missing file: the question says Restore creates it again.
      fs.writeFileSync(APP, NEW);
      await edit('src/app.js', OLD, NEW);
      await sleep(1500);
      fs.unlinkSync(APP);
      const last = `[...r.querySelectorAll('.k-edit:not(.restore)')].filter((x) => /app\\.js/.test(x.textContent)).pop()`;
      await q(`${last}.querySelector('.rst').click(); return true;`);
      await sleep(500);
      const missing = await q(`return ${last}.querySelector('.rconf').textContent`);
      check('a missing file: the question says so', /no longer exists \(it was moved or deleted\)/.test(missing), missing);
      await q(`[...${last}.querySelectorAll('.rconf button')].find((b) => b.textContent === 'Cancel').click(); return true;`);
      // Read-only: the question says so, and Restore is off.
      fs.writeFileSync(APP, NEW);
      fs.chmodSync(APP, 0o444);
      await q(`${last}.querySelector('.rst').click(); return true;`);
      await sleep(500);
      const ro = await q(`const b = ${last}.querySelector('.rconf'); return { text: b.textContent, off: b.querySelector('.allow').disabled };`);
      check('a read-only file: the question says so and Restore is off', /read-only/.test(ro.text) && ro.off, ro);
      fs.chmodSync(APP, 0o644);
      await q(`[...${last}.querySelectorAll('.rconf button')].find((b) => b.textContent === 'Cancel').click(); return true;`);
      // No longer kept: the card loses Restore and says why.
      const backups = path.join(tmp, 'live', 'backups');
      const newest = fs.readdirSync(backups).filter((n) => /^b[0-9a-f]{16}\.json$/.test(n)).map((n) => ({ n, t: fs.statSync(path.join(backups, n)).mtimeMs })).sort((a, b) => b.t - a.t)[0].n;
      fs.unlinkSync(path.join(backups, newest));
      await q(`${last}.querySelector('.rst').click(); return true;`);
      await sleep(500);
      const allow = await q(`const b = ${last}.querySelector('.rconf .allow'); return b ? !b.disabled : false;`);
      if (allow) {
        await q(`${last}.querySelector('.rconf .allow').click(); return true;`);
        await sleep(600);
      }
      const gone = await q(`const c = ${last}; return { btn: Boolean(c.querySelector('.rst')), note: (c.querySelector('.enote.gone') || {}).textContent || null, toast: r.querySelector('.toast').textContent };`);
      check('a copy no longer kept: Restore goes, the card says why', !gone.btn && /no longer kept \(EditLens keeps the last 200\)/.test(gone.note || ''), gone);
      check('the file was not changed', disk() === NEW);
      // Binary: says why there is no Restore.
      await edit('src/logo.dat', 'a\u0000b', 'c', { kind: 'other' });
      await sleep(600);
      const bin = await q(`const c = [...r.querySelectorAll('.k-edit')].filter((x) => /logo\\.dat/.test(x.textContent)).pop(); return { btn: Boolean(c.querySelector('.rst')), note: (c.querySelector('.enote') || {}).textContent };`);
      check('a binary file says why it has no Restore', !bin.btn && /binary/.test(bin.note || ''), bin);
    });

    await section('Remove file for a file Claude created', async () => {
      const made = path.join(proj, 'src', 'made.js');
      fs.writeFileSync(made, 'export const made = 1;\n');
      await edit('src/made.js', '', 'export const made = 1;\n', { tool: 'Write', created: true });
      await sleep(800);
      const card = `[...r.querySelectorAll('.k-edit:not(.restore)')].filter((x) => /made\\.js/.test(x.textContent)).pop()`;
      check('a created file has Remove file', (await q(`return (${card}.querySelector('.rst') || {}).textContent`)) === 'Remove file');
      await q(`${card}.querySelector('.rst').click(); return true;`);
      await clickWhen(`(${card}).querySelector('.rconf .allow')`);
      await sleep(800);
      check('Remove file deletes it', !fs.existsSync(made));
      const st = await q(`const c = ${card}; return { tag: (c.querySelector('.rtag') || {}).textContent, btn: (c.querySelector('.rst') || {}).textContent };`);
      check('its card says Removed, with Undo restore', st.tag === 'Removed' && st.btn === 'Undo restore', st);
      await q(`r.querySelector('.toast button').click(); return true;`);
      await sleep(800);
      check('Undo puts the file back', disk(made) === 'export const made = 1;\n');
    });

    await section('EditLens stopped, then restarted', async () => {
      const LATE = path.join(proj, 'src', 'late.js');
      fs.writeFileSync(LATE, 'late new\n');
      await edit('src/late.js', 'late old\n', 'late new\n');
      await sleep(800);
      await stopServer();
      await sleep(500);
      const last = `[...r.querySelectorAll('.k-edit')].filter((x) => /app\\.js/.test(x.textContent) && x.querySelector('.rst')).pop()`;
      check('a card with Restore is there', await q(`return Boolean(${last})`), await q(`return r.querySelectorAll('.k-edit').length`));
      await q(`${last}.querySelector('.rst').click(); return true;`);
      // The check before a restore fails: the question says why and Restore stays off (Sol 0.24.43 L8).
      const down = await page.waitForFunction(`(() => { const r = ${ROOT}; const b = ${last}.querySelector('.rconf'); return b && /isn't running/.test(b.querySelector('.rq').textContent); })()`, null, { timeout: 6000 }).then(() => true, onTimeout(false));
      const ask = await q(`const b = ${last}.querySelector('.rconf'); return b ? { text: b.querySelector('.rq').textContent, off: b.querySelector('.allow').disabled } : null;`);
      check('EditLens stopped: the question says the live server isn\'t running, Restore is off', down && ask && ask.off, ask);
      await q(`${last}.querySelector('.rconf .allow').click(); return true;`);
      await sleep(300);
      check('and a click on Restore sends nothing', !/Restored src\/app/.test(await q(`return r.querySelector('.toast').textContent`)));
      await ensureServer();
      await page.reload();
      await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
      await sleep(1500);
      const listed = await q(`return [...r.querySelectorAll('.k-edit')].filter((x) => /app\\.js/.test(x.textContent) && x.querySelector('.rst')).length`);
      check('after a restart the edits with an earlier copy are listed again', listed >= 1, listed);
      fs.writeFileSync(APP, NEW);
      const which = await q(`const c = [...r.querySelectorAll('.k-edit')].filter((x) => /late\\.js/.test(x.textContent) && x.querySelector('.rst')).pop(); c.querySelector('.rst').click(); return c.querySelector('.rst').textContent;`);
      await clickWhen(`r.querySelector('.k-edit .rconf .allow')`);
      await sleep(800);
      check('and Restore from them works', which === 'Restore' && disk(LATE) === 'late old\n', [which, disk(LATE)]);
    });

    check('no page errors', !errors.length, errors);
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
