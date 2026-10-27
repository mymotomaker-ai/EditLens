'use strict';
require('./isolate');
// The code view design of 0.24.36 (handoff 15 and 15.1), on a real page and server, without Claude:
// the header and its menus, the sidebar (Edits, Files, Agents) and its hidden strip, folded code with
// each change's bar and marks, the timeline, split view, Settings in full screen and in its own window,
// narrow and phone layouts, and keys only with focus.
// usage: NODE_PATH=$(npm root -g) node test/codeview-design-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: codeview-design-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-cvd-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '4960' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src', 'parts'), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
let ran = 0; // checks run until now
function check(label, ok, detail) {
  ran++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}

// The page: a card whose markup starts on line 28 of src/card.js (a change on line 31 matches it
// only nearby), and a link back.
const page = () => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code view design</title><body style="font:16px system-ui;margin:40px">
<h1 id="top">Code view</h1><section id="card" data-editlens-src="src/card.js:28:3" style="padding:20px;border:1px solid #ccc;width:300px">A card</section>
<script src="http://127.0.0.1:4960/live.js" data-root="${proj.replace(/"/g, '&quot;')}" data-panel="open"></script></body>`;

const LINES = 60;
const content = (name, changed) => Array.from({ length: LINES }, (_, i) => `const ${name}${i} = ${changed[i] !== undefined ? changed[i] : i};`).join('\n') + '\n';
const edited = Object.create(null);
// Claude edits line `line` (1-based) of src/<name>.js.
async function edit(name, line, intent) {
  const file = path.join(proj, 'src', name + '.js');
  const changed = edited[name] || (edited[name] = {});
  const before = content(name, changed);
  changed[line - 1] = (changed[line - 1] || 0) + 1000;
  const after = content(name, changed);
  fs.writeFileSync(file, after);
  const b = before.split('\n');
  const a = after.split('\n');
  await postEvent({ type: 'change', sessionId: 's1', cwd: proj, file, relFile: 'src/' + name + '.js', tool: 'Edit', kind: 'frontend', intent: intent || 'Change ' + name,
    before, after, hunks: [{ oldStart: line, newStart: line, lines: ['-' + b[line - 1], '+' + a[line - 1]] }], stats: { added: 1, removed: 1 }, ts: Date.now() });
}
const chat = (ev) => postEvent(Object.assign({ type: 'chat', sessionId: 's1', cwd: proj, ts: Date.now(), backlog: false }, ev));
const ask = (text) => chat({ role: 'user', text });

(async () => {
  for (const n of ['one', 'two', 'three', 'four', 'five']) fs.writeFileSync(path.join(proj, 'src', n + '.js'), content(n, {}));
  fs.writeFileSync(path.join(proj, 'src', 'parts', 'nav.js'), 'export const nav = 1;\n');
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: 's1', cwd: proj, ts: Date.now(), canListen: false });
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page());
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  const errors = [];
  // A section that stops early still lists each check it did not run as failed (read from this
  // file in order).
  const SRC = fs.readFileSync(__filename, 'utf8');
  const labelsOf = (name) => {
    const from = SRC.indexOf("section('" + name.replace(/'/g, "\\'") + "'");
    const to = SRC.indexOf('await section(', from + 1);
    const part = from < 0 ? '' : SRC.slice(from, to < 0 ? SRC.length : to);
    return [...part.matchAll(/^\s*check\('((?:\\.|[^'\\])*)'/gm)].map((m) => m[1].replace(/\\'/g, "'"));
  };
  // CVD_ONLY=<words>: only the sections whose name has them (while debugging one).
  const section = (name, fn) => {
    if (process.env.CVD_ONLY && name.indexOf(process.env.CVD_ONLY) < 0) return Promise.resolve();
    const start = ran;
    return fn().catch((err) => {
      const done = ran - start;
      check(name + ' (step failed)', false, err.message.split('\n')[0]);
      labelsOf(name).slice(done).forEach((label) => check(label + ' (not run)', false));
    });
  };
  // init: localStorage values for this context, set once (null: removed).
  async function openPage(init, opts) {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 860 } }, opts || {}));
    await ctx.addInitScript((extra) => {
      try {
        localStorage.setItem('editlens.tourDone', '1');
        if (!sessionStorage.getItem('seeded')) {
          Object.keys(extra || {}).forEach((k) => { if (extra[k] === null) localStorage.removeItem(k); else localStorage.setItem(k, extra[k]); });
          sessionStorage.setItem('seeded', '1');
        }
      } catch (err) {
        if (!err || err.name !== 'SecurityError') throw err; // storage blocked: the defaults are used
      }
    }, init || {});
    const pg = await ctx.newPage();
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(url);
    await pg.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
    return { ctx, page: pg };
  }
  const qq = (pg, src) => pg.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
  // Waits for a state; false when it never came (the check after it then fails).
  const until = (pg, cond, ms) => pg.waitForFunction(`(() => { const r = ${ROOT}; if (!r) return false; ${cond} })()`, null, { timeout: ms || 8000, polling: 50 }).then(() => true, onTimeout(false));
  // Nothing playing or waiting, and the shown text stopped changing.
  const idle = (pg) => until(pg, `const d = r.querySelector('.dock.on'); return Boolean(d) && !r.querySelector('.tab.busy') && !r.querySelector('.dqueue[data-busy]') && /^Edit \\d+ of \\d+$/.test((r.querySelector('.dqueue .lg') || {}).textContent || '');`, 30000);
  // A real click at the centre of a node, only when nothing covers it there.
  async function clickNode(pg, find) {
    const at = await qq(pg, `const n = (${find})(r); if (!n) return null; const b = n.getBoundingClientRect(); const x = b.left + b.width / 2; const y = b.top + Math.min(b.height / 2, 60);
      const hit = r.elementFromPoint(x, y); return { x, y, hit: Boolean(hit && (hit === n || n.contains(hit))) };`);
    if (!at || !at.hit) return false;
    await pg.mouse.click(at.x, at.y);
    return true;
  }
  const onTop = (pg, find) => qq(pg, `const n = (${find})(r); if (!n) return 'missing'; const b = n.getBoundingClientRect(); if (!b.width || !b.height) return 'not shown';
    const hit = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return hit && (hit === n || n.contains(hit)) ? true : 'covered by ' + (hit ? hit.className || hit.tagName : 'nothing');`);
  const focusedIn = (pg, find) => qq(pg, `const n = (${find})(r); const a = r.activeElement; return Boolean(n && a && (a === n || n.contains(a)));`);
  const shown = (sel) => `((n) => Boolean(n) && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== 'hidden')(r.querySelector(${JSON.stringify(sel)}))`;
  const counter = (pg) => qq(pg, `const n = r.querySelector('.dqueue .lg'); return n ? n.textContent : null;`);
  const menuRows = (pg) => qq(pg, `const m = r.querySelector('.lwrap .lmenu'); if (!m) return null; return [...m.querySelectorAll('.lh, button, a.li')].map((b) => ((b.querySelector('.lbl') ? b.querySelector('.lbl').firstChild.textContent : b.textContent) || '').trim()).filter(Boolean);`);
  const closeMenu = async (pg) => { await pg.keyboard.press('Escape'); await until(pg, `return !r.querySelector('.lwrap');`, 3000); };
  // The files in each pane, in screen order: [{ tabs, active, focus }].
  const groupsOf = (pg) => qq(pg, `return [...r.querySelectorAll('.pgrp')].filter((g) => g.getClientRects().length).sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0))
    .map((g) => ({ tabs: [...g.querySelectorAll('.ptabs .tab .nm')].map((n) => n.textContent), active: (g.querySelector('.ptabs .tab.on .nm') || {}).textContent || null, focus: g.classList.contains('focus'), follow: (g.querySelector('.pfol') || {}).textContent || '' }));`);
  // A picture once the sheets and menus have finished sliding in (spinners keep going). A window
  // in the background may not run its animations: those are ended for the picture.
  const shot = async (pg, name) => {
    const busy = `r.getAnimations().filter((a) => a.playState === 'running' && a.effect.getComputedTiming().iterations !== Infinity)`;
    if (!(await until(pg, `return ${busy}.length === 0;`, 3000))) await qq(pg, `${busy}.forEach((a) => a.finish()); return true;`);
    await pg.screenshot({ path: path.join(outDir, name) });
  };
  // Claude edits, then the edit is in the panel (its card) and the code view is idle again.
  async function played(pg, name, line, intent) {
    const before = await qq(pg, `return r.querySelectorAll('.k-edit').length;`);
    await edit(name, line, intent);
    await until(pg, `return r.querySelectorAll('.k-edit').length > ${before};`, 15000);
    return idle(pg);
  }

  try {
    let ctx;
    let pg;
    await section('header, menus, sidebar, code, timeline (wide)', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.dockLayout': 'tabs', 'editlens.layout': null, 'editlens.dockWidth': null }));
      await ask('Make the cards tidy');
      await played(pg, 'card', 31, 'Tidy the card');
      await played(pg, 'card', 50, 'Space the card');
      await played(pg, 'list', 5, 'Tidy the list');

      // ----- the header -----
      const head = await qq(pg, `const h = r.querySelector('.dock .dhead'); if (!h) return null;
        const vis = (n) => Boolean(n) && n.getClientRects().length > 0;
        const kids = [...h.querySelectorAll('button, .crumb, .capsule')].filter(vis);
        const name = (n) => n.classList.contains('crumb') ? 'path' : n.classList.contains('capsule') ? 'capsule' : n.classList.contains('dsb') ? 'sidebar' : n.classList.contains('fhead') ? 'follow' : n.getAttribute('aria-label');
        const order = [];
        kids.forEach((n) => { if (n.closest('.crumb') && !n.classList.contains('crumb')) return; if (n.closest('.capsule') && !n.classList.contains('capsule')) return; order.push(name(n)); });
        const cap = h.querySelector('.capsule');
        return { order, cap: cap ? [...cap.querySelectorAll('button')].filter(vis).map((b) => b.getAttribute('aria-label')).concat([(cap.querySelector('.dqueue .lg') || {}).textContent]) : null };`);
      check('header, left to right: sidebar, path, Follow, playback, Split, View, Close',
        head && JSON.stringify(head.order) === JSON.stringify(['sidebar', 'path', 'follow', 'capsule', 'Split', 'View', 'Close the code view']), head);
      check('the playback capsule: previous, play, next and "Edit 3 of 3"', head && head.cap && head.cap.join('|') === 'Previous edit|Play from here|Next edit|Edit 3 of 3', head && head.cap);
      const crumb = await qq(pg, `const c = r.querySelector('.crumb'); const b = c && c.querySelector('.fbtn'); const d = c && c.querySelector('.cdir'); if (!b) return null;
        return { name: b.querySelector('b').textContent, bold: Number(getComputedStyle(b.querySelector('b')).fontWeight), dir: d ? d.textContent : '', dim: d ? getComputedStyle(d).color !== getComputedStyle(b.querySelector('b')).color : false,
          title: b.title.split('\\n')[0], rtl: d ? getComputedStyle(d).direction : '' };`);
      check('the path: the folder dim and cut from the left, the name bold, the full path on hover',
        crumb && crumb.name === 'list.js' && crumb.bold >= 600 && crumb.dir === 'src›' && crumb.dim && crumb.rtl === 'rtl' && crumb.title === path.join(proj, 'src', 'list.js'), crumb);
      await shot(pg, 'design-1-wide-light.png');

      // ----- the file menu (the file name) -----
      await qq(pg, `r.querySelector('.crumb .fbtn').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.lwrap .fmenu'));`, 3000);
      const fm = await menuRows(pg);
      check('the file menu: its name, Open, Copy path, Copy code, Restore, Undo only this edit, Open in a split, Close',
        fm && fm[0] === 'list.js' && ['Open in VS Code', 'Copy path', 'Copy code', 'Restore…', 'Undo only this edit', 'Open in a split', 'Close'].every((x) => fm.indexOf(x) > 0), fm);
      await closeMenu(pg);

      // ----- Follow and its menu -----
      check('Follow says "Following everyone"', (await qq(pg, `const f = r.querySelector('.dhead .fhead'); return f ? f.textContent : null;`)) === 'Following everyone');
      await qq(pg, `r.querySelector('.dhead .fhead').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.lwrap .fwmenu'));`, 3000);
      const fw = await menuRows(pg);
      check('the Follow menu: Everyone, Main, Follow the latest edit, Show only this agent\'s edits, The page follows',
        fw && ['Everyone', 'Follow the latest edit', 'Show only this agent\'s edits'].every((x) => fw.indexOf(x) >= 0) && fw.some((x) => /^Main/.test(x)), fw);
      await qq(pg, `[...r.querySelectorAll('.lwrap .fwmenu button')].find((b) => /Follow the latest edit/.test(b.textContent)).click(); return true;`);
      check('Follow the latest edit: the chip says so', await until(pg, `return /^Following the latest/.test((r.querySelector('.dhead .fhead') || {}).textContent || '');`, 3000));
      await qq(pg, `r.querySelector('.dhead .fhead').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.lwrap .fwmenu'));`, 3000);
      await qq(pg, `[...r.querySelectorAll('.lwrap .fwmenu button')].find((b) => b.getAttribute('data-mode') === 'all').click(); return true;`);
      await until(pg, `return (r.querySelector('.dhead .fhead') || {}).textContent === 'Following everyone';`, 3000);

      // ----- the View menu -----
      await qq(pg, `r.querySelector('.dhead button[aria-label="View"]').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.lwrap .vmenu'));`, 3000);
      const vm = await qq(pg, `const m = r.querySelector('.lwrap .vmenu'); if (!m) return null; return { text: m.textContent, acts: [...m.querySelectorAll('[data-act]')].map((b) => b.getAttribute('data-act')),
        wrap: (m.querySelector('[data-act=wrap]') || {}).getAttribute && m.querySelector('[data-act=wrap]').getAttribute('aria-checked'), side: m.querySelector('[data-act=side]') && m.querySelector('[data-act=side]').getAttribute('aria-checked') };`);
      check('the View menu: Wrap long lines, Text size, Speed, Position (beside, bottom, floating, own window, full screen), Collapse, Reset layout, Quick tour, All settings',
        vm && ['Wrap long lines', 'Text size', 'Speed', 'Position', 'Beside the page', 'At the bottom', 'Floating window', 'In its own window', 'Full screen', 'Collapse to a narrow bar', 'Reset layout', 'Quick tour', 'All settings'].every((x) => vm.text.indexOf(x) >= 0)
        && ['wrap', 'side', 'bottom', 'float', 'popout', 'full', 'collapse', 'reset', 'tour', 'settings'].every((x) => vm.acts.indexOf(x) >= 0), vm);
      check('Wrap long lines is on by default (nothing stored), and Beside the page is checked', vm && vm.wrap === 'true' && vm.side === 'true', vm);
      await closeMenu(pg);

      // ----- the sidebar -----
      const side = await qq(pg, `const s = r.querySelector('.dock .dside'); if (!s || !s.getClientRects().length) return null;
        return { w: Math.round(s.getBoundingClientRect().width), tabs: [...s.querySelectorAll('[role=tab]')].map((t) => t.firstChild.textContent + ':' + t.getAttribute('aria-selected')),
          groups: [...s.querySelectorAll('.egh')].map((g) => g.textContent), rows: [...s.querySelectorAll('.erow')].map((e) => e.querySelector('.cno').textContent + ' ' + e.querySelector('.ef').firstChild.textContent),
          foot: (s.querySelector('.sdfoot') || {}).textContent || '' };`);
      check('the sidebar is 236 px wide with Edits, Files and Agents (Edits chosen)', side && Math.abs(side.w - 236) <= 1 && side.tabs.join() === 'Edits:true,Files:false,Agents:false', side);
      check('Edits are grouped under your request, with its time', side && side.groups.length === 1 && /^“Make the cards tidy”\s*\d{1,2}:\d{2}/.test(side.groups[0]) && side.rows.join() === '1 card.js,2 card.js,3 list.js', side);
      check('the sidebar\'s footer: Show all now · Earlier requests', side && /Show all now/.test(side.foot) && /Earlier requests/.test(side.foot), side && side.foot);
      await ask('Now the list');
      await played(pg, 'list', 40, 'Space the list');
      const two = await qq(pg, `return [...r.querySelectorAll('.dside .egh')].map((g) => g.textContent.replace(/\\s*\\d{1,2}:\\d{2}.*$/, ''));`);
      check('a new request starts a new group, newest first', JSON.stringify(two) === JSON.stringify(['“Now the list”', '“Make the cards tidy”']), two);
      // Waiting to play: paused while Claude's edits come in.
      await edit('one', 20, 'Change one');
      await until(pg, `return Boolean(r.querySelector('.dqueue[data-busy]'));`, 8000);
      const pauseAt = await qq(pg, `const b = r.querySelector('.capsule button[aria-label="Pause playback"]'); const q = r.querySelector('.dqueue').textContent; if (b) b.click(); return { clicked: Boolean(b), q };`);
      const paused = await until(pg, `return /Paused/.test((r.querySelector('.dqueue') || {}).textContent || '');`, 3000);
      await edit('two', 20, 'Change two');
      await edit('three', 20, 'Change three');
      const waitOk = await until(pg, `const g = r.querySelector('.dside .egh.wait'); const n = r.querySelectorAll('.tlt.wait').length;
        return Boolean(g) && n >= 2 && r.querySelectorAll('.timeline .tlt').length === 7 && g.textContent === 'Waiting to play' + n;`, 8000);
      const wait = await qq(pg, `const g = r.querySelector('.dside .egh.wait'); const ticks = [...r.querySelectorAll('.timeline .tlt')];
        return { head: g ? g.textContent : null, rows: g ? [...r.querySelectorAll('.dside .erow.wait, .dside .egh.wait ~ .erow')].length : 0, n: r.querySelectorAll('.tlt.wait').length,
          faded: ticks.map((t) => t.classList.contains('wait') ? Number(getComputedStyle(t).opacity) : 1), badge: (r.querySelector('.dseg [data-tab=edits] .k') || {}).textContent };`);
      // The edit that came in before Pause may still be waiting too: two or three wait.
      check('paused: the edits that came in are under "Waiting to play", counted on the Edits tab', waitOk && wait.head === 'Waiting to play' + wait.n && wait.badge === String(wait.n), Object.assign({ pauseAt, paused }, wait));
      check('the timeline: one tick per edit, the waiting ones (the last) faded', waitOk && wait.faded.length === 7 && wait.faded.slice(7 - wait.n).every((o) => o < 0.7) && wait.faded.slice(0, 7 - wait.n).every((o) => o === 1), wait.faded);
      await shot(pg, 'design-2-waiting.png');
      await qq(pg, `[...r.querySelectorAll('.dside .sdfoot button')].find((b) => b.textContent === 'Show all now').click(); return true;`);
      check('Show all now: everything plays, nothing waits', await idle(pg) && await until(pg, `return !r.querySelector('.dside .egh.wait') && !r.querySelector('.tlt.wait');`, 8000) && (await counter(pg)) === 'Edit 7 of 7');

      // ----- the code: folding, the change's bar, the marks -----
      await qq(pg, `[...r.querySelectorAll('.dside .erow')].find((e) => e.querySelector('.cno').textContent === '4').click(); return true;`);
      await until(pg, `return /list\\.js$/.test((r.querySelector('.pane.on') || { getAttribute: () => '' }).getAttribute('data-path') || '') && (r.querySelector('.pane.on .hbar .cno') || {}).textContent === '4';`, 8000);
      await idle(pg);
      const code = await qq(pg, `const p = r.querySelector('.pane.on'); if (!p) return null; const bars = [...p.querySelectorAll('.hbar')];
        const b = bars[0]; const acts = b ? [...b.querySelectorAll('.acts button')].filter((x) => x.getClientRects().length) : [];
        return { file: p.getAttribute('data-path'), folds: [...p.querySelectorAll('.cfold')].map((f) => f.textContent), hidden: p.querySelectorAll('.cl.fold').length,
          bars: bars.length, no: b ? b.querySelector('.cno').textContent : null, why: b ? b.querySelector('.why').textContent : null, who: b ? (b.querySelector('.hw') || {}).textContent : null,
          acts: acts.map((x) => x.getAttribute('aria-label') || x.textContent), off: acts.filter((x) => x.disabled).map((x) => x.getAttribute('aria-label') || x.textContent),
          marks: [...p.querySelectorAll('.emarks i')].map((m) => Math.round(parseFloat(m.style.top))) };`);
      check('a change\'s bar: its number, why, who and when', code && code.bars >= 1 && code.no === '4' && code.why === 'Space the list' && /Main/.test(code.who || '') && /now|s ago|\d+s/.test(code.who || ''), code);
      check('the bar\'s buttons: Restore, Undo only this edit, older and newer change here (newer off: it is the newest)',
        code && code.acts.join('|') === 'Restore|Undo only this edit|Older change in this file|Newer change in this file' && code.off.join() === 'Newer change in this file', code && code.acts);
      check('unchanged lines fold: "Lines 1–36 unchanged", and they are hidden', code && code.folds[0] === 'Lines 1–36 unchanged' && code.hidden >= 36, code && [code.folds, code.hidden]);
      check('the marks on the right edge: where this file\'s changes are', code && code.marks.length === 1 && Math.abs(code.marks[0] - Math.round((39 / LINES) * 100)) <= 2, code && code.marks);
      await qq(pg, `r.querySelector('.pane.on .cfold').click(); return true;`);
      check('a click on the fold shows the lines', await until(pg, `const p = r.querySelector('.pane.on'); return p.querySelectorAll('.cl.fold').length < 30 && [...p.querySelectorAll('.cfold')].every((f) => f.textContent !== 'Lines 1–36 unchanged');`, 3000));
      await qq(pg, `r.querySelector('.pane.on .hbar .bprev').click(); return true;`);
      await idle(pg);
      const older = await qq(pg, `const b = r.querySelector('.pane.on .hbar'); return b ? { no: b.querySelector('.cno').textContent, newer: !b.querySelector('.bnext').disabled, older: !b.querySelector('.bprev').disabled } : null;`);
      check('Older change here: the earlier edit of this file, with Newer on', older && older.no === '3' && older.newer && !older.older, older);
      await qq(pg, `r.querySelector('.pane.on .hbar .bnext').click(); return true;`);
      await until(pg, `return (r.querySelector('.pane.on .hbar .cno') || {}).textContent === '4';`, 8000);
      await idle(pg);
      await qq(pg, `r.querySelector('.pane.on .hbar .brst').click(); return true;`);
      check('Restore on the bar asks first, under it', await until(pg, `const b = r.querySelector('.pane.on .hbar'); const n = b && b.nextElementSibling; return Boolean(n && n.classList.contains('hbox') && n.getAttribute('data-kind') === 'restore' && n.querySelector('.rconf'));`, 3000));
      await qq(pg, `const b = [...r.querySelectorAll('.pane.on .hbox button')].find((x) => x.textContent === 'Cancel'); if (b) b.click(); return true;`);
      await qq(pg, `r.querySelector('.pane.on .hbar .buo').click(); return true;`);
      check('Undo only this edit on the bar asks first', await until(pg, `const n = r.querySelector('.pane.on .hbar + .hbox'); return Boolean(n && n.getAttribute('data-kind') === 'only' && /Remove only this edit from/.test(n.textContent));`, 3000));
      await qq(pg, `const b = [...r.querySelectorAll('.pane.on .hbox button')].find((x) => x.textContent === 'Cancel'); if (b) b.click(); return true;`);

      // ----- the timeline -----
      const tl = await qq(pg, `const t = r.querySelector('.timeline .track'); if (!t) return null; const ticks = [...t.querySelectorAll('.tlt')];
        return { n: ticks.length, colours: ticks.map((x) => x.style.background), main: getComputedStyle(r.querySelector('.dock')).getPropertyValue('--add').trim(), speed: (r.querySelector('.timeline button.speed') || {}).textContent };`);
      check('the timeline: 7 ticks in the main agent\'s colour, the speed button at its end', tl && tl.n === 7 && tl.colours.every((c) => c === 'var(--add)') && tl.speed === '1×', tl);
      const tick = async (i) => qq(pg, `const t = r.querySelector('.timeline .track .tlt:nth-of-type(${i + 1})') || [...r.querySelectorAll('.timeline .tlt')][${i}]; const b = t.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
      let at = await tick(1);
      await pg.mouse.click(at.x, at.y);
      check('a click on a tick shows that edit', await idle(pg) && (await counter(pg)) === 'Edit 2 of 7', await counter(pg));
      const from = await qq(pg, `const b = r.querySelector('.timeline .tlh').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };`);
      at = await tick(5);
      await pg.mouse.move(from.x, from.y);
      await pg.mouse.down();
      await pg.mouse.move((from.x + at.x) / 2, at.y, { steps: 4 });
      await pg.mouse.move(at.x, at.y, { steps: 4 });
      await pg.mouse.up();
      check('dragging the head to a tick shows that edit', await idle(pg) && (await counter(pg)) === 'Edit 6 of 7', await counter(pg));
      await qq(pg, `r.querySelector('.timeline button.speed').click(); return true;`);
      check('the speed button: 1× to 2×', await until(pg, `return (r.querySelector('.timeline button.speed') || {}).textContent === '2×';`, 3000));
      await qq(pg, `r.querySelector('.timeline button.speed').click(); r.querySelector('.timeline button.speed').click(); return true;`);

      // ----- keys: only while the code view has focus -----
      await idle(pg);
      const before = await counter(pg);
      await pg.click('#top');
      await pg.keyboard.press('ArrowLeft');
      await pg.keyboard.press('ArrowLeft');
      check('← on the page (the code view not focused) does nothing', (await counter(pg)) === before && !(await qq(pg, `return Boolean(r.querySelector('.dqueue[data-busy]'));`)), [before, await counter(pg)]);
      await qq(pg, `r.querySelector('.pane.on .code').focus(); return true;`);
      await pg.keyboard.press('Alt+ArrowLeft');
      check('Alt+← in the code view does nothing (it is the browser\'s Back)', (await counter(pg)) === before && pg.url() === url, [before, await counter(pg)]);
      await pg.keyboard.press('ArrowLeft');
      check('← with the code focused: the previous edit', await idle(pg) && (await counter(pg)) === 'Edit 5 of 7', await counter(pg));
      await pg.keyboard.press('ArrowRight');
      check('→ with the code focused: the next edit', await idle(pg) && (await counter(pg)) === 'Edit 6 of 7', await counter(pg));
      await pg.keyboard.press('Space');
      check('Space with the code focused: plays from here', await until(pg, `return Boolean(r.querySelector('.dqueue[data-busy]')) || (r.querySelector('.dqueue .lg') || {}).textContent === 'Edit 7 of 7';`, 4000));
      await idle(pg);

      // ----- Files and Agents -----
      await qq(pg, `r.querySelector('.dseg [data-tab=files]').click(); return true;`);
      check('Files: the open files, then the project\'s folders', await until(pg, `const s = r.querySelector('.dside .sfiles.on, .dside .spanel.on'); return Boolean(s) && s.querySelectorAll('.frow[data-key]').length === 5 && [...s.querySelectorAll('.frow[data-rel]')].some((b) => b.getAttribute('data-rel') === 'src');`, 6000));
      await qq(pg, `[...r.querySelectorAll('.dside .spanel.on .frow[data-rel]')].find((b) => b.getAttribute('data-rel') === 'src').click(); return true;`);
      await until(pg, `return [...r.querySelectorAll('.dside .spanel.on .frow[data-rel]')].some((b) => b.getAttribute('data-rel') === 'src/four.js');`, 6000);
      await qq(pg, `[...r.querySelectorAll('.dside .spanel.on .frow[data-rel]')].find((b) => b.getAttribute('data-rel') === 'src/four.js').click(); return true;`);
      check('a file from the project\'s folders opens in the code view', await until(pg, `const p = r.querySelector('.pane.on'); return Boolean(p) && /four\\.js$/.test(p.getAttribute('data-path') || '') && /const four59/.test(p.textContent);`, 8000));
      await chat({ role: 'agent-start', toolUseId: 'tuA', description: 'Check the header', agentType: 'general-purpose', prompt: '' });
      await qq(pg, `r.querySelector('.dseg [data-tab=agents]').click(); return true;`);
      const ag = await until(pg, `const s = r.querySelector('.dside .sagents.on'); return Boolean(s) && s.querySelectorAll('.arow').length === 2;`, 6000);
      const agRows = await qq(pg, `return { rows: [...r.querySelectorAll('.dside .sagents .arow b')].map((b) => b.textContent), floating: Boolean(r.querySelector('.asw.on')) };`);
      check('Agents: the agents in the sidebar (Main and the subagent), no floating switcher', ag && agRows.rows[0] === 'Main' && /Check the header/.test(agRows.rows[1] || '') && !agRows.floating, agRows);
      await shot(pg, 'design-3-agents.png');

      // ----- the strip when the sidebar is hidden -----
      await qq(pg, `r.querySelector('.dhead .dsb').click(); return true;`);
      const strip = await until(pg, `const s = r.querySelector('.dock .dstrip'); return Boolean(s) && s.getClientRects().length > 0 && !(r.querySelector('.dock .dside') || {}).getClientRects().length;`, 3000);
      const sk = await qq(pg, `const s = r.querySelector('.dock .dstrip'); if (!s) return null; return { w: Math.round(s.getBoundingClientRect().width), b: [...s.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || b.title) };`);
      check('sidebar hidden: a 40 px strip with Show the sidebar, Edits, Files, Agents, then Select and Full screen',
        strip && sk && sk.w === 40 && sk.b.length === 6 && sk.b[0] === 'Show the sidebar' && sk.b[1] === 'Edits' && sk.b[2] === 'Files' && sk.b[3] === 'Agents' && /^Select/.test(sk.b[4]) && /Full screen/.test(sk.b[5]), sk);
      await shot(pg, 'design-4-hidden-strip.png');
      await qq(pg, `r.querySelector('.dock .dstrip [data-tab=files]').click(); return true;`);
      check('Files on the strip: the sidebar opens on Files', await until(pg, `return ${shown('.dock .dside')} && r.querySelector('.dseg [data-tab=files]').getAttribute('aria-selected') === 'true';`, 3000));
      await pg.click('#top');
      await pg.keyboard.press('Alt+Shift+B');
      check('Alt+Shift+B hides the sidebar', await until(pg, `return r.querySelector('.dock').classList.contains('noside');`, 3000));
      const selOk = await clickNode(pg, `(r) => [...r.querySelectorAll('.dock .dstrip button')].find((b) => /^Select/.test(b.title))`);
      check('Select on the strip: pointing at the page is on', selOk && await until(pg, `return r.querySelector('.catcher').classList.contains('on');`, 3000));
      await pg.keyboard.press('Escape');
      await until(pg, `return !r.querySelector('.catcher.on');`, 3000);
      // Counted after EditLens's own listener has run (it was added first).
      await pg.evaluate(() => { window.cvdFullChanges = 0; document.addEventListener('fullscreenchange', () => { window.cvdFullChanges++; }); });
      const fullOk = await clickNode(pg, `(r) => [...r.querySelectorAll('.dock .dstrip button')].find((b) => /Full screen/.test(b.title))`);
      check('Full screen on the strip: the code view fills the window', fullOk && await until(pg, `const b = r.querySelector('.dock').getBoundingClientRect(); return b.left <= 0 && b.top <= 0 && b.width >= innerWidth - 1 && b.height >= innerHeight - 1;`, 4000));
      // The browser's own full screen comes a moment later, and its change event closes open menus;
      // where the browser refuses it, the code view fills the window and no event comes.
      const fullEvents = (n) => pg.waitForFunction((want) => window.cvdFullChanges >= want, n, { timeout: 3000, polling: 50 })
        .catch((err) => { if (!err || err.name !== 'TimeoutError') throw err; });
      await fullEvents(1);
      // Settings from the file menu in full screen: a sheet in the code view, above it, focused.
      await qq(pg, `r.querySelector('.crumb .fbtn').click(); return true;`);
      const menuOpen = await until(pg, `return Boolean(r.querySelector('.lwrap .fmenu'));`, 3000);
      const link = `(r) => [...r.querySelectorAll('.lwrap .fmenu button')].find((b) => b.textContent === 'change in Settings')`;
      const linkTop = await onTop(pg, link);
      const linkOk = await clickNode(pg, link);
      const sheetOk = await until(pg, `const s = r.querySelector('.dock .dsheet.settings.on'); return Boolean(s && s.querySelector('.settings.on'));`, 3000);
      const top = await onTop(pg, `(r) => r.querySelector('.dock .dsheet.on .settings')`);
      check('full screen, "change in Settings": Settings open in the code view, above the code, focused',
        sheetOk && top === true && await focusedIn(pg, `(r) => r.querySelector('.dock .dsheet.on')`) && !(await qq(pg, `return r.querySelector('.panel').classList.contains('sheet');`)), { linkOk, linkTop, sheetOk, top, menuOpen, now: await qq(pg, `const fs = document.fullscreenElement; return { full: fs ? fs.tagName : null, lwrap: r.querySelectorAll('.lwrap').length };`) });
      // The panel stays open beside a full-screen code view: Settings cover it too.
      const above = await qq(pg, `const p = r.querySelector('.panel:not(.min):not(.hidden)'); const b = p ? p.getBoundingClientRect() : null; if (!b || !b.width) return 'panel not open';
        const hit = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); const s = r.querySelector('.dock .dsheet.on'); return Boolean(s && hit && s.contains(hit)) || 'covered by ' + (hit ? hit.className || hit.tagName : 'nothing');`);
      check('full screen: Settings are above the panel too', above === true, above);
      await shot(pg, 'design-5-full-settings.png');
      await pg.keyboard.press('Escape');
      check('Esc: Settings close, back to the full-screen code view', await until(pg, `const b = r.querySelector('.dock').getBoundingClientRect(); return !r.querySelector('.dock .dsheet.on') && !r.querySelector('.settings.on') && b.width >= innerWidth - 1;`, 3000));
      await qq(pg, `r.querySelector('.dhead button[aria-label="View"]').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.lwrap .vmenu'));`, 3000);
      await qq(pg, `r.querySelector('.lwrap .vmenu [data-act=full]').click(); return true;`);
      await until(pg, `return r.querySelector('.dock').getBoundingClientRect().left > 100;`, 4000);
      await fullEvents(2);
      await qq(pg, `r.querySelector('.dhead .dsb').click(); return true;`);

      // ----- the hover card: "Open in code view" opens at the change, its bar marked, "nearby" -----
      await qq(pg, `r.querySelector('.dseg [data-tab=edits]').click(); return true;`);
      await played(pg, 'card', 31, 'Tidy the card again');
      // The edit shown on the page (its outline and the bar at the top) is cleared first.
      await pg.click('#top');
      await pg.keyboard.press('Escape');
      await until(pg, `return !r.querySelector('.selbar.on');`, 3000);
      await pg.mouse.move(4, 700);
      const box = await pg.locator('#card').boundingBox();
      await pg.mouse.move(box.x + 30, box.y + box.height / 2, { steps: 3 });
      const peek = await until(pg, `return Boolean(r.querySelector('.peek.on .pkacts'));`, 5000);
      await qq(pg, `const b = [...r.querySelectorAll('.peek.on .pkacts button')].find((x) => x.textContent === 'Open in code view'); if (b) b.click(); return true;`);
      const near = await until(pg, `const b = r.querySelector('.pane.on .hbar.hl'); return Boolean(b && b.querySelector('.near') && /card\\.js$/.test(r.querySelector('.pane.on').getAttribute('data-path')));`, 8000);
      const hit = await qq(pg, `const h = r.elementFromPoint(${box.x + 30}, ${box.y + box.height / 2}); const out = []; for (let n = h; n && out.length < 6; n = n.parentElement) out.push(n.tagName + '.' + String(n.className || '').replace(/ /g, '.')); return out.join(' < ');`);
      check('hover card › Open in code view: that change\'s bar is marked, with "nearby"', peek && near, { peek, near, hit });
      await pg.mouse.move(4, 700);
      await ctx.close();
    });

    await section('split view: one tab row per pane, the 15.1 rules', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': JSON.stringify({ dock: { mode: 'bottom' } }), 'editlens.dockLayout': 'split', 'editlens.dockSide': 'off' }));
      for (const n of ['one', 'two', 'three']) await played(pg, n, 10);
      let g = await groupsOf(pg);
      check('three panes, each with its own tab row', g.length === 3 && g.every((x) => x.tabs.length === 1) && g.map((x) => x.active).join() === 'one.js,two.js,three.js', g);
      check('one pane plays Claude\'s edits ("Edits play here")', g.filter((x) => x.follow === 'Edits play here').length === 1, g.map((x) => x.follow));
      await shot(pg, 'design-6-split.png');
      // Focus the first pane; pick a file already open in the third: it is selected where it is.
      const codeOf = (i) => `(r) => [...r.querySelectorAll('.pgrp')].filter((x) => x.getClientRects().length).sort((a, b) => (Number(a.style.order) || 0) - (Number(b.style.order) || 0))[${i}].querySelector('.pane.on .code')`;
      await clickNode(pg, codeOf(0));
      await until(pg, `return [...r.querySelectorAll('.pgrp')][0].classList.contains('focus');`, 2000);
      g = await groupsOf(pg);
      check('a click on a pane focuses it (a line above its tabs)', g[0].focus && !g[1].focus && !g[2].focus, g.map((x) => x.focus));
      await qq(pg, `r.querySelector('.dstrip [data-tab=files]').click(); return true;`);
      await until(pg, `return r.querySelectorAll('.dside .spanel.on .frow[data-key]').length === 3;`, 4000);
      await qq(pg, `[...r.querySelectorAll('.dside .spanel.on .frow[data-key]')].find((b) => /three\\.js/.test(b.textContent)).click(); return true;`);
      await until(pg, `return [...r.querySelectorAll('.pgrp.focus .tab.on .nm')].some((t) => t.textContent === 'three.js');`, 3000);
      g = await groupsOf(pg);
      check('a file open in another pane is shown where it is, not moved', g.map((x) => x.tabs.join('+')).join() === 'one.js,two.js,three.js' && g[2].focus, g);
      // A new file you pick opens in the focused pane.
      await clickNode(pg, codeOf(0));
      await until(pg, `return [...r.querySelectorAll('.pgrp')][0].classList.contains('focus');`, 2000);
      await qq(pg, `r.querySelector('.dseg [data-tab=files]').click(); return true;`);
      await until(pg, `return [...r.querySelectorAll('.dside .spanel.on .frow[data-rel]')].some((b) => b.getAttribute('data-rel') === 'src');`, 6000);
      await qq(pg, `[...r.querySelectorAll('.dside .spanel.on .frow[data-rel]')].find((b) => b.getAttribute('data-rel') === 'src').click(); return true;`);
      await until(pg, `return [...r.querySelectorAll('.dside .spanel.on .frow[data-rel]')].some((b) => b.getAttribute('data-rel') === 'src/four.js');`, 6000);
      await qq(pg, `[...r.querySelectorAll('.dside .spanel.on .frow[data-rel]')].find((b) => b.getAttribute('data-rel') === 'src/four.js').click(); return true;`);
      await until(pg, `return [...r.querySelectorAll('.tab .nm')].some((t) => t.textContent === 'four.js');`, 8000);
      await idle(pg);
      g = await groupsOf(pg);
      check('a file you pick opens in the focused pane, the others stay', g.length === 3 && g[0].tabs.join() === 'one.js,four.js' && g[0].active === 'four.js' && g[1].tabs.join() === 'two.js' && g[2].tabs.join() === 'three.js', g);
      // Claude's edits play in the pane that plays edits; one of a file already open plays where it is.
      await qq(pg, `[...r.querySelectorAll('.pgrp')][1].querySelector('.pfol').click(); return true;`);
      await until(pg, `return ([...r.querySelectorAll('.pgrp')][1].querySelector('.pfol') || {}).textContent === 'Edits play here';`, 3000);
      await played(pg, 'five', 10);
      g = await groupsOf(pg);
      check('Claude edits a file not open: it plays in the pane that plays edits', g[1].tabs.join() === 'two.js,five.js' && g[1].active === 'five.js' && g[0].tabs.join() === 'one.js,four.js' && g[2].tabs.join() === 'three.js', g);
      await played(pg, 'three', 12);
      g = await groupsOf(pg);
      check('Claude edits a file open in another pane: it plays there, nothing moves', g[2].tabs.join() === 'three.js' && g[1].tabs.join() === 'two.js,five.js' && g[0].tabs.join() === 'one.js,four.js', g);
      // A tab moves only by drag or "Open in a split".
      const drag = await qq(pg, `const tab = [...r.querySelectorAll('.tab')].find((t) => t.querySelector('.nm').textContent === 'four.js'); const dest = [...r.querySelectorAll('.pgrp')][2].querySelector('.ptrow');
        if (!tab || !dest) return false; const dt = new DataTransfer(); const ev = (type, n) => n.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
        ev('dragstart', tab); ev('dragover', dest); ev('drop', dest); ev('dragend', tab); return true;`);
      await until(pg, `return [...r.querySelectorAll('.pgrp')][2].querySelectorAll('.tab').length === 2;`, 3000);
      g = await groupsOf(pg);
      check('a tab dragged to another pane\'s tab row moves there', drag && g[2].tabs.join() === 'three.js,four.js' && g[0].tabs.join() === 'one.js', g);
      await qq(pg, `const t = [...r.querySelectorAll('.tab')].find((x) => x.querySelector('.nm').textContent === 'five.js'); t.click(); return true;`);
      await until(pg, `return (r.querySelector('.crumb .fbtn b') || {}).textContent === 'five.js';`, 3000);
      await qq(pg, `r.querySelector('.crumb .fbtn').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.lwrap .fmenu [data-act=split]'));`, 3000);
      await qq(pg, `r.querySelector('.lwrap .fmenu [data-act=split]').click(); return true;`);
      await until(pg, `return [...r.querySelectorAll('.pgrp')][1].querySelectorAll('.tab').length === 1;`, 3000);
      g = await groupsOf(pg);
      check('"Open in a split" moves the file to the next pane', g[1].tabs.join() === 'two.js' && g[2].tabs.indexOf('five.js') >= 0, g);
      // Focus and panes are kept for this page.
      await clickNode(pg, codeOf(1));
      await until(pg, `return [...r.querySelectorAll('.pgrp')][1].classList.contains('focus');`, 2000);
      const kept = await groupsOf(pg);
      await pg.reload();
      await until(pg, `return r.querySelectorAll('.pgrp').length === 3 && r.querySelectorAll('.tab').length === 6;`, 15000);
      await idle(pg);
      g = await groupsOf(pg);
      check('after a reload: the same files in the same panes, the same pane focused', JSON.stringify(g.map((x) => [x.tabs, x.focus])) === JSON.stringify(kept.map((x) => [x.tabs, x.focus])), { kept, g });
      await ctx.close();
    });

    await section('Settings in the code view\'s own window', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': null, 'editlens.dockLayout': 'tabs' }));
      await played(pg, 'two', 30);
      await qq(pg, `r.querySelector('.dhead button[aria-label="View"]').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.lwrap .vmenu [data-act=popout]'));`, 3000);
      const [win] = await Promise.all([
        ctx.waitForEvent('page', { timeout: 8000 }),
        qq(pg, `r.querySelector('.lwrap .vmenu [data-act=popout]').click(); return true;`),
      ]);
      const W = 'document.querySelector("edit-lens") && document.querySelector("edit-lens").shadowRoot';
      const wq = (src) => win.evaluate(`(() => { const r = ${W}; if (!r) return null; ${src} })()`);
      const wuntil = (cond, ms) => win.waitForFunction(`(() => { const r = ${W}; if (!r) return false; ${cond} })()`, null, { timeout: ms || 8000, polling: 50 }).then(() => true, onTimeout(false));
      await wuntil(`return Boolean(r.querySelector('.dock .dhead button[aria-label="View"]'));`);
      await wq(`r.querySelector('.dock .dhead button[aria-label="View"]').click(); return true;`);
      await wuntil(`return Boolean(r.querySelector('.lwrap .vmenu [data-act=settings]'));`, 3000);
      await wq(`r.querySelector('.lwrap .vmenu [data-act=settings]').click(); return true;`);
      const inWin = await wuntil(`const s = r.querySelector('.dock .dsheet.settings.on'); return Boolean(s && s.querySelector('.settings.on'));`, 4000);
      const winTop = await wq(`const n = r.querySelector('.dock .dsheet.on .settings'); if (!n) return 'missing'; const b = n.getBoundingClientRect(); const hit = r.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return Boolean(hit && n.contains(hit));`);
      const panelSheet = await qq(pg, `return r.querySelector('.panel').classList.contains('sheet');`);
      check('own window, All settings: Settings open in that window, above the code (not in the page\'s panel)', inWin && winTop === true && !panelSheet, { inWin, winTop, panelSheet });
      // As shot(), in that window.
      const winBusy = `r.getAnimations().filter((a) => a.playState === 'running' && a.effect.getComputedTiming().iterations !== Infinity)`;
      if (!(await wuntil(`return ${winBusy}.length === 0;`, 3000))) await wq(`${winBusy}.forEach((a) => a.finish()); return true;`);
      await win.screenshot({ path: path.join(outDir, 'design-7-own-window-settings.png') });
      await wq(`[...r.querySelectorAll('.dock .dsheet .shh button')].find((b) => b.textContent === 'Done').click(); return true;`);
      check('Done: back to the code in that window', await wuntil(`return !r.querySelector('.dock .dsheet.on') && Boolean(r.querySelector('.dock .pane.on'));`, 3000));
      await win.close();
      await ctx.close();
    });

    await section('the edits made while this page was closed', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': null, 'editlens.dockLayout': 'tabs' }));
      await played(pg, 'one', 33);
      await pg.close();
      await edit('two', 33);
      await edit('three', 33);
      pg = await ctx.newPage();
      pg.on('pageerror', (e) => errors.push(e.message));
      await pg.goto(url);
      await pg.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`, null, { timeout: 15000 });
      await until(pg, `return Boolean(r.querySelector('.k-missed'));`, 8000);
      await qq(pg, `if (!r.querySelector('.dock.on')) r.querySelector('.panel button[title^="Split screen"]').click(); return true;`);
      const g = await until(pg, `const h = r.querySelector('.dside .egh.missed'); return Boolean(h) && /^2 edits .*while this page was closed/.test(h.textContent);`, 8000);
      check('Edits: "2 edits … while this page was closed" at the top, with Play', g && await qq(pg, `const h = r.querySelector('.dside .egh.missed'); return h === r.querySelector('.dside .egh') && [...h.querySelectorAll('button')].some((b) => b.textContent === 'Play');`));
      await qq(pg, `[...r.querySelectorAll('.dside .egh.missed button')].find((b) => b.textContent === 'Play').click(); return true;`);
      check('Play: they play, the group and the panel\'s notice go', await until(pg, `return !r.querySelector('.dside .egh.missed') && !r.querySelector('.k-missed') && [...r.querySelectorAll('.tab .nm')].some((t) => t.textContent === 'three.js');`, 15000));
      await ctx.close();
    });

    await section('narrow code view', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': null, 'editlens.dockWidth': '480', 'editlens.dockLayout': 'tabs' }));
      await played(pg, 'four', 30, 'Change four');
      await played(pg, 'four', 50, 'Change four again');
      const n = await qq(pg, `const d = r.querySelector('.dock'); const vis = (s) => { const x = r.querySelector(s); return Boolean(x) && x.getClientRects().length > 0; };
        return { narrow: d.classList.contains('narrow'), side: vis('.dock .dside'), strip: vis('.dock .dstrip'), short: (r.querySelector('.dqueue .sh') || {}).textContent, shortShown: vis('.dqueue .sh'), longShown: vis('.dqueue .lg'),
          bar: [...r.querySelectorAll('.pane.on .hbar .acts button')].filter((b) => b.getClientRects().length).map((b) => b.textContent) };`);
      check('narrow (< 560 px): no sidebar and no strip', n.narrow && !n.side && !n.strip, n);
      const m = /^(\d+)\/(\d+)$/.exec(n.short || '');
      check('narrow: "N/N" for the edit, the bar has one "Restore ▾"', m && m[1] === m[2] && n.shortShown && !n.longShown && n.bar.join() === 'Restore ▾', n);
      await qq(pg, `r.querySelector('.crumb .fbtn').click(); return true;`);
      const sheet = await until(pg, `const s = r.querySelector('.dock .dsheet.on'); return Boolean(s) && Boolean(s.querySelector('.dside .dseg')) && ${shown('.dock .dsheet.on .dside')};`, 3000);
      check('narrow: the file button opens Edits, Files and Agents in a sheet', sheet);
      await shot(pg, 'design-8-narrow.png');
      await pg.keyboard.press('Escape');
      check('Esc closes the sheet', await until(pg, `return !r.querySelector('.dock .dsheet.on');`, 3000));
      await ctx.close();
    });

    await section('phone', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': null, 'editlens.dockLayout': 'tabs' }, { viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true }));
      await edit('five', 20, 'Change five');
      await until(pg, `return r.querySelectorAll('.k-edit').length > 0;`, 15000);
      await qq(pg, `if (!r.querySelector('.dock.on')) r.querySelector('.panel button[title^="Split screen"]').click(); return true;`);
      await until(pg, `return Boolean(r.querySelector('.dock.on'));`, 8000);
      await played(pg, 'five', 40, 'Change five again');
      const total = Number(((await counter(pg)) || '').replace(/^Edit \d+ of /, ''));
      check('phone: the edit counter says how many edits', Number.isInteger(total) && total > 1, await counter(pg));
      const p = await qq(pg, `const d = r.querySelector('.dock'); const b = d.getBoundingClientRect(); const vis = (s) => { const x = r.querySelector(s); return Boolean(x) && x.getClientRects().length > 0; };
        return { phone: d.classList.contains('phone'), bottom: Math.round(innerHeight - b.bottom), h: b.height / innerHeight, grab: vis('.dock .dgrab'), prev: vis('.timeline .tlp'), next: vis('.timeline .tln') };`);
      check('phone: a bottom sheet at half height, with its drag handle', p.phone && p.bottom === 0 && p.h > 0.5 && p.h < 0.66 && p.grab, p);
      check('phone: big previous and next buttons beside the timeline', p.prev && p.next, p);
      // The panel minimized, so the picture shows the code view's sheet.
      await qq(pg, `const b = r.querySelector('.panel button[title^="Minimize"]'); if (b && r.querySelector('.panel:not(.min):not(.hidden)')) b.click(); return true;`);
      await until(pg, `return !r.querySelector('.panel:not(.min):not(.hidden)');`, 3000);
      const clear = await qq(pg, `const p = r.querySelector('.pill'); const t = r.querySelector('.timeline'); if (!p || !p.getClientRects().length || !t) return null; const a = p.getBoundingClientRect(); const b = t.getBoundingClientRect();
        return { pill: Math.round(a.bottom), timeline: Math.round(b.top), clear: a.bottom <= b.top };`);
      check('phone: the minimized panel\'s button sits above the timeline, not over it', Boolean(clear && clear.clear), clear);
      await shot(pg, 'design-9-phone.png');
      const swipe = (dx) => qq(pg, `const c = r.querySelector('.pane.on .code'); const b = c.getBoundingClientRect(); const x = b.left + b.width / 2; const y = b.top + b.height / 2;
        const t = (cx) => new Touch({ identifier: 1, target: c, clientX: cx, clientY: y });
        c.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, composed: true, touches: [t(x)], changedTouches: [t(x)] }));
        c.dispatchEvent(new TouchEvent('touchend', { bubbles: true, composed: true, touches: [], changedTouches: [t(x + ${dx})] })); return true;`);
      await swipe(120);
      check('swipe right on the code: the previous edit', await idle(pg) && (await counter(pg)) === `Edit ${total - 1} of ${total}`, await counter(pg));
      await swipe(-120);
      check('swipe left on the code: the next edit', await idle(pg) && (await counter(pg)) === `Edit ${total} of ${total}`, await counter(pg));
      const h0 = await qq(pg, `return r.querySelector('.dock').getBoundingClientRect().height / innerHeight;`);
      await clickNode(pg, `(r) => r.querySelector('.dock .dgrab')`);
      check('the drag handle: from half to the next height (full)', h0 < 0.66 && await until(pg, `const b = r.querySelector('.dock').getBoundingClientRect(); return b.height > innerHeight * 0.9;`, 3000), h0);
      await ctx.close();
    });

    await section('dark theme', async () => {
      ({ ctx, page: pg } = await openPage({ 'editlens.layout': null, 'editlens.dockLayout': 'tabs' }, { colorScheme: 'dark' }));
      await ask('Make the cards tidy');
      await played(pg, 'card', 45, 'Tidy the card');
      const bg = await qq(pg, `const s = r.querySelector('.dock .dside'); return s ? getComputedStyle(s).backgroundColor : null;`);
      check('dark: the sidebar is dark', Boolean(bg) && bg.match(/\d+/g).slice(0, 3).every((v) => Number(v) < 80), bg);
      await shot(pg, 'design-10-wide-dark.png');
      await ctx.close();
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
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
