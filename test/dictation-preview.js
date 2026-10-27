'use strict';
require('./isolate');
// The dictation mic, with a stand-in for the browser's SpeechRecognition: the first-use card, words
// in grey while heard and in place once final, never sent, stops on Send, Add, Esc and the mic; a
// long silence; the pick box; browsers without it (grey mic and why); online-only; the setting.
// usage: NODE_PATH=$(npm root -g) node test/dictation-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: dictation-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-dictation-'));
// Manual: opening the page starts no page control setup.
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5266', CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
const { ensureServer, stopServer, getJson } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(proj, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Hill Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:40px 60px;max-width:640px}h1{font-size:40px;margin:0 0 12px}
@media (prefers-color-scheme:dark){body{background:#18181a;color:#eee}}</style></head>
<body><main><h1 id="h">New coffee each day</h1><p>Small-batch roasts, brewed slowly.</p></main>
<script src="http://127.0.0.1:5266/live.js" data-root="${proj}" data-panel="open" data-settle="300"></script></body></html>`;

// The stand-in. kind: 'device' (can do it on this computer once downloaded), 'online' (no on-device
// check, as Edge and Safari), 'none' (no SpeechRecognition, as Firefox).
function speechStub(kind) {
  const s = { instances: [], installs: 0, available: 'downloadable' };
  window.__speech = s;
  try {
    localStorage.setItem('editlens.tourDone', '1');
  } catch (err) {
    if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
  }
  if (kind === 'none') {
    window.SpeechRecognition = undefined;
    window.webkitSpeechRecognition = undefined;
    return;
  }
  function Fake() {
    this.lang = '';
    this.continuous = false;
    this.interimResults = false;
    this.processLocally = false;
    this.calls = [];
    s.instances.push(this);
  }
  Fake.prototype.start = function () { this.calls.push('start'); };
  Fake.prototype.stop = function () {
    this.calls.push('stop');
    setTimeout(() => this.onend && this.onend(), 60);
  };
  Fake.prototype.abort = function () {
    this.calls.push('abort');
    setTimeout(() => this.onend && this.onend(), 10);
  };
  if (kind === 'device') {
    Fake.available = (o) => {
      s.asked = o;
      return Promise.resolve(s.available);
    };
    Fake.install = () => new Promise((resolve) => {
      s.release = () => {
        s.installs++;
        s.available = 'available';
        resolve(true);
      };
      if (!s.hold) s.release();
    });
  }
  window.SpeechRecognition = Fake;
  window.webkitSpeechRecognition = Fake;
  // parts: [[text, final], ...] from result `from` on, as the browser sends them.
  window.__say = (parts, from) => {
    const rec = s.instances[s.instances.length - 1];
    const results = parts.map((p) => Object.assign([{ transcript: p[0] }], { isFinal: p[1] }));
    rec.onresult({ resultIndex: from || 0, results });
  };
}

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const browser = await launch(chromium);
  const take = () => getJson(`/messages/take?cwd=${encodeURIComponent(proj)}&via=prompt`);

  async function open(kind, opts) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 820 }, ...opts });
    await ctx.addInitScript(speechStub, kind);
    const errors = [];
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    const q = (js) => page.evaluate(`(() => { const r = ${ROOT}; ${js} })()`);
    const mic = (sel) => q(`const m = r.querySelector('${sel} .mic'); const f = m.closest('.field, .notebox');
      return { shown: !m.hidden && m.offsetWidth > 0, rec: m.classList.contains('rec'), na: m.classList.contains('na'), title: m.title, text: m.textContent,
        ring: f.classList.contains('listen'), grey: f.classList.contains('dictgrey') };`);
    const speech = () => page.evaluate(() => {
      const s = window.__speech;
      const last = s.instances[s.instances.length - 1];
      return { count: s.instances.length, installs: s.installs, asked: s.asked || null, last: last ? { lang: last.lang, local: last.processLocally, continuous: last.continuous, interim: last.interimResults, calls: last.calls } : null };
    });
    return { ctx, page, q, mic, speech, errors };
  }

  try {
    for (const scheme of ['light', 'dark']) {
      const t = await open('device', { colorScheme: scheme });
      const { page, q, mic, speech } = t;
      const panel = () => q(`return r.querySelector('.composer textarea').value;`);

      let m = await mic('.composer');
      // Between them only the "N lines" count (handoff section 19).
      check(`${scheme}: a mic between Commands and Send`, m.shown && !m.rec && m.title === 'Dictate (Ctrl+Shift+Space)'
        && await q(`const b = r.querySelector('.composer .cbar'); const k = [...b.querySelectorAll('.slash, .nlines, .mic, .send')].map((x) => x.className.split(' ')[0]); return k.join() === 'slash,nlines,mic,send' && b.querySelector('.mic').previousElementSibling.className === 'nlines' && b.querySelector('.mic').nextElementSibling === b.querySelector('.send');`), m);

      // First use: the card with the two choices.
      await q(`r.querySelector('.composer textarea').focus(); return true;`);
      await page.keyboard.type('Hello');
      await q(`r.querySelector('.composer .mic').click(); return true;`);
      await sleep(200);
      const card = await q(`const c = r.querySelector('.dpop'); return c && { text: c.textContent, checked: c.querySelector('input:checked').value, go: c.querySelector('button.go').textContent,
        above: c.getBoundingClientRect().bottom <= r.querySelector('.composer .mic').getBoundingClientRect().top };`);
      check(`${scheme}: first use: a card above the mic, on this device chosen, Download and start`, card && card.checked === 'device' && card.go === 'Download and start' && card.above
        && /On this device only/.test(card.text) && /Chrome downloads the speech model once/.test(card.text) && /Online \(Google\)/.test(card.text), card);
      check(`${scheme}: nothing listens yet`, (await speech()).count === 0);
      await page.screenshot({ path: path.join(outDir, `dictation-${scheme}-first.png`) });
      await q(`r.querySelector('.dpop button.go').click(); return true;`);
      await sleep(200);
      let s = await speech();
      check(`${scheme}: it downloads the model, then listens on this device`, s.installs === 1 && s.asked && s.asked.processLocally === true
        && s.last && s.last.local === true && s.last.continuous && s.last.interim && s.last.lang && s.last.calls.join() === 'start', s);
      m = await mic('.composer');
      check(`${scheme}: listening: red pill with Stop, a red ring, a line above the box`, m.rec && m.ring && /Stop/.test(m.text)
        && await q(`const l = r.querySelector('.dlst'); return l.classList.contains('on') && /Listening · on this device/.test(l.textContent) && /Esc stops/.test(l.textContent);`), m);

      // Words still being heard: grey, after the typed text; then final.
      await page.evaluate(() => window.__say([['make the', false]]));
      await sleep(50);
      check(`${scheme}: words still being heard go in at the cursor, in grey`, (await panel()) === 'Hello make the' && (await mic('.composer')).grey
        && await q(`return r.querySelector('.inmarks .interim').textContent === ' make the' && getComputedStyle(r.querySelector('.composer textarea')).color === 'rgba(0, 0, 0, 0)';`), await panel());
      await page.screenshot({ path: path.join(outDir, `dictation-${scheme}-listening.png`) });
      await page.evaluate(() => window.__say([['make the title bigger', true]]));
      await sleep(50);
      check(`${scheme}: final words stay, not grey`, (await panel()) === 'Hello make the title bigger' && !(await mic('.composer')).grey, await panel());
      await page.keyboard.type(' now');
      check(`${scheme}: typing still works while it listens`, (await panel()) === 'Hello make the title bigger now');
      await page.evaluate(() => window.__say([['make the title bigger', true], ['and blue', false]]));
      await sleep(50);
      check(`${scheme}: next words follow what was typed`, (await panel()) === 'Hello make the title bigger now and blue', await panel());

      // Send: the grey words are not sent, listening stops.
      await q(`r.querySelector('.composer .send').click(); return true;`);
      await sleep(400);
      const sent = await take();
      const texts = (sent.messages || []).map((x) => x.text);
      check(`${scheme}: Send sends only the final words and stops listening`, texts.length === 1 && texts[0] === 'Hello make the title bigger now' && !(await mic('.composer')).rec
        && (await speech()).last.calls.includes('abort'), { texts, s: await speech() });

      // Ctrl+Shift+Space starts it again (no card now); Esc stops it, keeping the last words.
      await q(`r.querySelector('.composer textarea').focus(); return true;`);
      await page.keyboard.press('Control+Shift+Space');
      await sleep(200);
      s = await speech();
      check(`${scheme}: Ctrl+Shift+Space starts it, no card the second time`, s.count === 2 && (await mic('.composer')).rec && !(await q(`return Boolean(r.querySelector('.dpop'));`)), s);
      await page.evaluate(() => window.__say([['short note', false]]));
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.__say([['short note', true]]));
      await sleep(200);
      check(`${scheme}: Esc stops it; the words heard last are kept`, !(await mic('.composer')).rec && (await panel()) === 'short note' && (await speech()).last.calls.join() === 'start,stop', { v: await panel(), s: await speech() });

      // The browser ends a session after a pause: it starts again while words came lately; a minute
      // of silence stops it.
      await q(`r.querySelector('.composer .mic').click(); return true;`);
      await sleep(200);
      await page.evaluate(() => window.__speech.instances[window.__speech.instances.length - 1].onend());
      check(`${scheme}: a session that ends is started again`, (await speech()).last.calls.join() === 'start,start' && (await mic('.composer')).rec, await speech());
      await page.evaluate(() => {
        const real = Date.now;
        Date.now = () => real() + 61000;
        window.__speech.instances[window.__speech.instances.length - 1].onend();
        Date.now = real;
      });
      await sleep(100);
      check(`${scheme}: after a minute with no words it stops and says so`, !(await mic('.composer')).rec && await q(`return /no words for a minute/.test(r.querySelector('.toast').textContent);`));

      // The pick box: its own mic before Add; Esc stops it first; Add puts in only final words.
      await q(`r.querySelector('.composer textarea').value = ''; r.querySelector('.composer textarea').dispatchEvent(new Event('input')); r.querySelector('.icon.pt').click(); return true;`);
      await sleep(100);
      const h = await page.evaluate(() => { const b = document.querySelector('#h').getBoundingClientRect(); return [b.left + 40, b.top + b.height / 2]; });
      await page.mouse.move(h[0], h[1]);
      await page.mouse.click(h[0], h[1]);
      await sleep(250);
      m = await mic('.notebox');
      check(`${scheme}: the pick box has a mic before Add`, m.shown && await q(`const n = r.querySelector('.notebox .nbrow'); return n.querySelector('.mic').nextElementSibling === n.querySelector('.nbadd');`), m);
      await q(`r.querySelector('.notebox .mic').click(); return true;`);
      await sleep(200);
      await page.evaluate(() => window.__say([['bolder', true], ['and red', false]]));
      await sleep(50);
      m = await mic('.notebox');
      check(`${scheme}: pick box: listening with bars and a square, ring, grey words`, m.rec && m.ring && m.grey && !/Stop/.test(m.text)
        && await q(`return r.querySelector('.notebox textarea').value === 'bolder and red' && r.querySelector('.nbmirror .interim').textContent === ' and red';`), m);
      await page.screenshot({ path: path.join(outDir, `dictation-${scheme}-pickbox.png`) });
      await page.keyboard.press('Escape');
      await sleep(150);
      check(`${scheme}: pick box: Esc stops dictating and keeps the box open`, !(await mic('.notebox')).rec && await q(`return r.querySelector('.notebox').classList.contains('on');`));
      await q(`r.querySelector('.notebox .mic').click(); return true;`);
      await sleep(200);
      await page.evaluate(() => window.__say([['and italic', false]]));
      await page.keyboard.press('Enter');
      await sleep(200);
      check(`${scheme}: Add puts in the final words only and stops`, (await panel()) === '1 bolder' && !(await mic('.notebox')).rec, await panel());
      await q(`r.querySelector('.composer textarea').value = ''; r.querySelector('.composer textarea').dispatchEvent(new Event('input')); return true;`);
      check(`${scheme}: nothing was sent by itself`, ((await take()).messages || []).length === 0);

      // The setting: Off hides the mics.
      await q(`r.querySelector('.head button[aria-label="More"]').click(); return true;`);
      await sleep(150);
      await q(`[...r.querySelectorAll('button')].find((b) => b.textContent.trim() === 'All settings ›').click(); return true;`);
      await sleep(300);
      const seg = await q(`const g = r.querySelector('.seg[aria-label="Dictation"]'); return g && [...g.querySelectorAll('button')].map((b) => b.textContent);`);
      check(`${scheme}: Settings has Dictation: On this device, Allow online, Off`, JSON.stringify(seg) === JSON.stringify(['On this device', 'Allow online', 'Off']), seg);
      await q(`r.querySelector('.seg[aria-label="Dictation"]').closest('.srow').scrollIntoView({ block: 'center' }); return true;`);
      await sleep(150);
      await page.screenshot({ path: path.join(outDir, `dictation-${scheme}-setting.png`) });
      await q(`[...r.querySelector('.seg[aria-label="Dictation"]').querySelectorAll('button')].find((b) => b.textContent === 'Off').click(); return true;`);
      await sleep(200);
      check(`${scheme}: Off: no mic in either box`, !(await mic('.composer')).shown && await q(`return r.querySelector('.notebox .mic').hidden;`));
      await q(`[...r.querySelector('.seg[aria-label="Dictation"]').querySelectorAll('button')].find((b) => b.textContent === 'On this device').click(); return true;`);
      check(`${scheme}: no page errors`, !t.errors.length, t.errors);
      await t.ctx.close();
    }

    // Sol M10, M11: the first-use card closed with Esc or a click outside; Off while the start waits.
    {
      const t = await open('device', {});
      const card = () => t.q(`return Boolean(r.querySelector('.dpop'));`);
      const micClick = () => t.q(`r.querySelector('.composer textarea').focus(); r.querySelector('.composer .mic').click(); return true;`);
      await micClick();
      await sleep(200);
      await t.page.keyboard.press('Escape');
      await sleep(100);
      const closed = !(await card());
      await micClick();
      await sleep(200);
      check('M10: after Esc closes the first-use card, the mic opens it again', closed && await card());
      await t.page.mouse.click(600, 120);
      await sleep(100);
      const closed2 = !(await card());
      await micClick();
      await sleep(200);
      check('M10: after a click outside closes it, the mic opens it again', closed2 && await card());
      // Turned Off while the speech model downloads: it never starts listening.
      await t.page.evaluate(() => { window.__speech.hold = true; });
      await t.q(`r.querySelector('.dpop button.go').click(); return true;`);
      await sleep(150);
      await t.q(`r.querySelector('.head button[aria-label="More"]').click(); return true;`);
      await sleep(150);
      await t.q(`[...r.querySelectorAll('button')].find((b) => b.textContent.trim() === 'All settings ›').click(); return true;`);
      await sleep(300);
      await t.q(`[...r.querySelector('.seg[aria-label="Dictation"]').querySelectorAll('button')].find((b) => b.textContent === 'Off').click(); return true;`);
      await sleep(200);
      await t.page.evaluate(() => window.__speech.release());
      await sleep(200);
      const s = await t.speech();
      check('M11: turned Off while it waits to start: it does not listen', s.count === 0 && !(await t.q(`return r.querySelector('.dlst').classList.contains('on');`)), s);
      await t.q(`[...r.querySelector('.seg[aria-label="Dictation"]').querySelectorAll('button')].find((b) => b.textContent === 'On this device').click(); return true;`);
      await sleep(200);
      check('M10, M11: no page errors', !t.errors.length, t.errors);
      await t.ctx.close();
    }

    // Sol M9: Send, or closing the pick box, while the start waits for the download: it never listens.
    {
      const t = await open('device', {});
      await t.page.evaluate(() => {
        localStorage.setItem('editlens.dictationAsked', 'yes');
        window.__speech.hold = true;
      });
      await t.q(`r.querySelector('.composer textarea').focus(); return true;`);
      await t.page.keyboard.type('Hello');
      await t.q(`r.querySelector('.composer .mic').click(); return true;`);
      await sleep(150);
      await t.q(`r.querySelector('.composer .send').click(); return true;`);
      await sleep(300);
      await t.page.evaluate(() => window.__speech.release());
      await sleep(300);
      const sent = ((await take()).messages || []).map((x) => x.text);
      let s = await t.speech();
      check('M9: Send while the start waits: it does not listen, the box stays empty', sent.join() === 'Hello' && s.count === 0
        && (await t.q(`return r.querySelector('.composer textarea').value;`)) === '' && !(await t.mic('.composer')).rec, { sent, s });
      // The pick box closed with Esc while its start waits.
      await t.page.evaluate(() => { window.__speech.available = 'downloadable'; });
      await t.q(`r.querySelector('.icon.pt').click(); return true;`);
      await sleep(100);
      const h = await t.page.evaluate(() => { const b = document.querySelector('#h').getBoundingClientRect(); return [b.left + 40, b.top + b.height / 2]; });
      await t.page.mouse.move(h[0], h[1]);
      await t.page.mouse.click(h[0], h[1]);
      await sleep(250);
      await t.q(`r.querySelector('.notebox textarea').focus(); r.querySelector('.notebox .mic').click(); return true;`);
      await sleep(150);
      await t.page.keyboard.press('Escape');
      await sleep(200);
      const closed = !(await t.q(`return r.querySelector('.notebox').classList.contains('on');`));
      await t.page.evaluate(() => window.__speech.release());
      await sleep(300);
      s = await t.speech();
      check('M9: the pick box closed while the start waits: it does not listen', closed && s.count === 0 && !(await t.mic('.notebox')).rec, { closed, s });
      check('M9: no page errors', !t.errors.length, t.errors);
      await t.ctx.close();
    }

    // Sol L9: stop and abort pass over only the DOMException the browser may throw there
    // (InvalidStateError); any other error is thrown again.
    {
      const t = await open('online', {});
      const last = 'window.__speech.instances[window.__speech.instances.length - 1]';
      const listen = async () => {
        await t.q(`r.querySelector('.composer textarea').focus(); r.querySelector('.composer .mic').click(); return true;`);
        await sleep(200);
        if (await t.q(`return Boolean(r.querySelector('.dpop button.go'));`)) await t.q(`r.querySelector('.dpop button.go').click(); return true;`);
        await sleep(200);
      };
      await listen();
      await t.page.evaluate(`${last}.stop = () => { throw new DOMException('not running', 'InvalidStateError'); }`);
      await t.page.keyboard.press('Escape');
      await sleep(2800);
      check('L9: stop throwing InvalidStateError: it stops all the same', !(await t.mic('.composer')).rec);
      await listen();
      const passed = await t.page.evaluate(`(() => { const rec = ${last}; rec.abort = () => { throw new DOMException('not running', 'InvalidStateError'); };
        try { rec.onerror({ error: 'network' }); return 'none'; } catch (err) { return err.name; } })()`);
      check('L9: abort throwing InvalidStateError is passed over', passed === 'none' && !(await t.mic('.composer')).rec, passed);
      await t.page.keyboard.press('Escape');
      await sleep(100);
      await listen();
      const thrown = await t.page.evaluate(`(() => { const rec = ${last}; rec.abort = () => { throw new DOMException('broken', 'NetworkError'); };
        try { rec.onerror({ error: 'network' }); return 'none'; } catch (err) { return err.name; } })()`);
      check('L9: abort throwing another DOMException is thrown again', thrown === 'NetworkError', thrown);
      check('L9: no page errors', !t.errors.length, t.errors);
      await t.ctx.close();
    }

    // A browser that only does it online (Edge, Safari): its own card, then online.
    {
      const t = await open('online', {});
      await t.q(`r.querySelector('.composer .mic').click(); return true;`);
      await sleep(200);
      const text = await t.q(`const c = r.querySelector('.dpop'); return c && c.textContent;`);
      check('online only: the card says where the audio goes, and that nothing else is sent', /sends the audio to Google to turn it into text\. Nothing else from the page is sent\./.test(text || '') && /Not now/.test(text) && /Allow/.test(text), text);
      await t.page.screenshot({ path: path.join(outDir, 'dictation-online.png') });
      await t.q(`r.querySelector('.dpop button.go').click(); return true;`);
      await sleep(200);
      const s = await t.speech();
      check('online only: Allow listens online and says so', s.last && s.last.local === false && await t.q(`return /Listening · online, Google/.test(r.querySelector('.dlst').textContent);`), s);
      check('online only: no page errors', !t.errors.length, t.errors);
      await t.ctx.close();
    }

    // No SpeechRecognition (Firefox): a grey mic that says why and what to use instead.
    {
      const t = await open('none', {});
      const m = await t.mic('.composer');
      check('no speech here: the mic stays, grey', m.shown && m.na, m);
      await t.q(`r.querySelector('.composer .mic').click(); return true;`);
      await sleep(150);
      const text = await t.q(`const c = r.querySelector('.dpop'); return c && c.textContent;`);
      check('no speech here: the card names the system\'s dictation', /This browser can't turn speech into text/.test(text || '') && /Win\+H on Windows, Fn twice on a Mac/.test(text), text);
      await t.page.screenshot({ path: path.join(outDir, 'dictation-unavailable.png') });
      await t.page.keyboard.press('Escape');
      check('no speech here: Esc closes the card', !(await t.q(`return Boolean(r.querySelector('.dpop'));`)));
      check('no speech here: no page errors', !t.errors.length, t.errors);
      await t.ctx.close();
    }
  } finally {
    await browser.close();
    site.close();
    await stopServer();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
