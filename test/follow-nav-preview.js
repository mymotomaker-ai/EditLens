'use strict';
require('./isolate');
// Follow moving the page, on a small hand-written app with a client-side router: it clicks only a
// shown link without action words (never "Delete reports" before the plain Reports link), uses the
// history API when no such link exists, and a pause stops a page move that is waiting (a tab click,
// a reload). A source line too large to be a number is not learned. The reads it sends are made up.
// usage: NODE_PATH=$(npm root -g) node test/follow-nav-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');

const outDir = process.argv[2];
if (!outDir) {
  console.log('usage: follow-nav-preview.js <out-dir>');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-follow-nav-'));
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(tmp, 'live'), EDITLENS_PORT: '5242' });
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const { launch } = require('./launch');
const proj = path.join(tmp, 'proj');
fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
for (const n of ['Home', 'Reports', 'Settings', 'Customers', 'Static', 'Danger', 'Orders', 'Erase', 'Billing']) fs.writeFileSync(path.join(proj, 'src', n + '.jsx'), 'export default 1;\n'.repeat(6));
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = 'follow-nav';

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chat = (ev) => postEvent({ type: 'chat', sessionId: SESSION, cwd: proj, ts: Date.now(), backlog: false, ...ev });
let step = 0;
const read = (name) => chat({ role: 'agent-step', agentId: 'agA', toolUseId: 'tuA', agentType: 'general-purpose', kind: 'tool', tool: 'Read',
  summary: name + '.jsx', file: path.join(proj, 'src', name + '.jsx'), line: 3, end: 3, op: 'read', id: 'r' + ++step });

// Every path serves the same app. "Delete reports" and "Remove settings" go to the same addresses
// as the plain links but do something on click. /tabs shows its Customers tab after 2 s; /static
// changes nothing on the page, so Follow loads it again unless stopped.
const app = `<!doctype html><title>Nav</title><body style="font:16px system-ui;margin:40px">
<nav><a href="/reports" id="bad" onclick="window.__bad = (window.__bad || 0) + 1">Delete reports</a>
<a href="/reports" style="display:none">Reports</a>
<form><a href="/reports">Reports</a></form>
<a href="/reports" id="good">Reports</a>
<a href="/settings" onclick="window.__bad = (window.__bad || 0) + 1">Remove settings</a></nav>
<main id="main"></main>
<script>
var timer = 0;
function render() {
  var p = location.pathname, m = document.getElementById('main');
  clearTimeout(timer);
  if (p === '/static') return;
  // Sol H10: tabs that act (action words, a form's submit button) are never clicked by Follow.
  if (p === '/tabs2') {
    m.innerHTML = '<div role="tablist"><button role="tab" id="danger" onclick="window.__danger = (window.__danger || 0) + 1">Delete all</button></div>' +
      '<form onsubmit="window.__sent = (window.__sent || 0) + 1; return false"><div role="tablist"><button role="tab" type="submit" id="orders">Orders</button></div></form>' +
      // Sol H7: buttons outside the form that belong to it through form="...": with no type, they submit it.
      '<form id="erase" onsubmit="window.__erased = (window.__erased || 0) + 1; return false"></form>' +
      '<div role="tablist"><button role="tab" form="erase" id="erasetab">Archive</button></div><nav><button form="erase" id="billing">Billing</button></nav>';
    return;
  }
  if (p === '/tabs') {
    m.innerHTML = '<p>Tabs</p>';
    timer = setTimeout(function () {
      m.innerHTML = '<div role="tablist"><button role="tab" id="cust" data-editlens-src="src/Tabs.jsx:${'9'.repeat(400)}:1">Customers</button></div>';
      document.getElementById('cust').onclick = function () {
        window.__tab = (window.__tab || 0) + 1;
        m.insertAdjacentHTML('beforeend', '<table data-editlens-src="src/Customers.jsx:3:1"><tr><td>Acme</td></tr></table>');
      };
    }, 2000);
    return;
  }
  var name = p === '/reports' ? 'Reports' : p === '/settings' ? 'Settings' : 'Home';
  m.innerHTML = '<h2 data-editlens-src="src/' + name + '.jsx:3:1">' + name + '</h2>';
}
document.addEventListener('click', function (e) {
  var a = e.target.closest && e.target.closest('a[href^="/"]');
  if (!a) return;
  e.preventDefault();
  if (a.id === 'good') window.__good = (window.__good || 0) + 1;
  history.pushState(null, '', a.getAttribute('href'));
  render();
});
window.addEventListener('popstate', render);
render();
</script>
<script src="http://127.0.0.1:5242/live.js" data-root="${proj}" data-panel="open"></script></body>`;

(async () => {
  await stopServer();
  await ensureServer();
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(app);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${site.address().port}`;
  const browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  try {
    await postEvent({ type: 'session', sessionId: SESSION, cwd: proj, ts: Date.now(), canListen: false });
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const now = Date.now();
    const map = {
      'src/Reports.jsx': { route: '/reports', via: null, ts: now },
      'src/Settings.jsx': { route: '/settings', via: null, ts: now },
      'src/Customers.jsx': { route: '/tabs', via: { tag: 'button', text: 'Customers', label: '', id: 'cust', href: '', src: '' }, ts: now },
      'src/Static.jsx': { route: '/static', via: null, ts: now },
      'src/Danger.jsx': { route: '/tabs2', via: { tag: 'button', text: 'Delete all', label: '', id: 'danger', href: '', src: '' }, ts: now },
      'src/Orders.jsx': { route: '/tabs2', via: { tag: 'button', text: 'Orders', label: '', id: 'orders', href: '', src: '' }, ts: now },
      'src/Erase.jsx': { route: '/tabs2', via: { tag: 'button', text: 'Archive', label: '', id: 'erasetab', href: '', src: '' }, ts: now },
      'src/Billing.jsx': { route: '/tabs2', via: { tag: 'button', text: 'Billing', label: '', id: 'billing', href: '', src: '' }, ts: now },
    };
    // Skip the tour, follow the latest agent, and know where each file shows.
    await ctx.addInitScript((m) => {
      try {
        if (sessionStorage.getItem('seeded')) return;
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('editlens.tourDone', '1');
        localStorage.setItem('editlens.pageMap', JSON.stringify(m));
        sessionStorage.setItem('editlens.follow', 'active');
      } catch (err) {
        if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
      }
    }, map);
    const pg = await ctx.newPage();
    const errors = [];
    pg.on('pageerror', (e) => errors.push(e.message));
    await pg.goto(origin + '/');
    await pg.waitForFunction(`document.querySelector("edit-lens") && ${ROOT}.querySelector('.panel')`);
    await sleep(800);
    const where = () => pg.evaluate('location.pathname');
    const win = (k) => pg.evaluate(`window[${JSON.stringify(k)}] || 0`);
    const waitPath = (p, ms = 8000) => pg.waitForFunction(`location.pathname === ${JSON.stringify(p)}`, null, { timeout: ms, polling: 'raf' }).then(() => true, onTimeout(false));
    // The Follow menu's "The page follows" row, in one step (no time passes between them).
    const togglePage = () => pg.evaluate(`(() => { const r = ${ROOT}; r.querySelector('.dhead .fhead').click(); const b = r.querySelector('.lwrap .fwmenu [data-act=page]');
      if (!b) return null; b.click(); const now = r.querySelector('.lwrap .fwmenu [data-act=page]'); const on = now ? now.getAttribute('aria-checked') : null;
      r.querySelectorAll('.lwrap').forEach((n) => n.remove()); return on; })()`);

    await chat({ role: 'agent-start', toolUseId: 'tuA', description: 'Look at the reports', agentType: 'general-purpose', prompt: '' });
    await sleep(600);
    await read('Reports');
    check('Follow goes to /reports', await waitPath('/reports'), await where());
    await sleep(300);
    check('by the plain Reports link, never "Delete reports" before it', (await win('__bad')) === 0 && (await win('__good')) === 1, { bad: await win('__bad'), good: await win('__good') });

    await sleep(1600);
    await read('Settings');
    check('with only "Remove settings" to /settings, Follow uses the history API', await waitPath('/settings'), await where());
    await sleep(300);
    check('and clicks nothing', (await win('__bad')) === 0, await win('__bad'));
    await pg.screenshot({ path: path.join(outDir, 'follow-nav-1.png') });

    // A pause while Follow waits for the Customers tab: the tab is never clicked.
    await sleep(1600);
    await read('Customers');
    check('Follow goes to /tabs', await waitPath('/tabs'), await where());
    const paused = await togglePage();
    check('Follow paused', paused === 'false', paused);
    await sleep(3500);
    check('the tab that appeared later is not clicked after the pause', (await win('__tab')) === 0, await win('__tab'));
    const resumed = await togglePage();
    check('Follow on again', resumed === 'true', resumed);
    const clicked = await pg.waitForFunction('window.__tab === 1', null, { timeout: 6000 }).then(() => true, onTimeout(false));
    check('on again, Follow clicks the tab (the same move, not stopped)', clicked, await win('__tab'));
    await sleep(1600);

    // Tabs that act: "Delete all", and a submit button in a form, are not clicked (Sol H10).
    await read('Danger');
    check('Follow goes to /tabs2', await waitPath('/tabs2'), await where());
    await sleep(3200);
    await read('Orders');
    await sleep(3200);
    check('a tab with action words or a submit tab in a form is never clicked', (await win('__danger')) === 0 && (await win('__sent')) === 0, { danger: await win('__danger'), sent: await win('__sent') });
    await read('Erase');
    await sleep(3200);
    await read('Billing');
    await sleep(3200);
    check('Sol H7: a button that belongs to a form through form="..." is never clicked', !(await win('__erased')), await win('__erased'));
    await sleep(600);

    // A pause in the 0.7 s before Follow loads a page that did not change: no reload.
    await read('Static');
    check('Follow goes to /static', await waitPath('/static'), await where());
    await pg.evaluate('window.__mark = true'); // gone if the page loads again
    const paused2 = await togglePage();
    check('paused immediately', paused2 === 'false', paused2);
    await sleep(2500);
    check('the page is not loaded again after the pause', (await win('__mark')) === true && (await where()) === '/static', { mark: await win('__mark'), path: await where() });
    // A tab whose source line is too large to be a number: learned without it (never "Infinity").
    await pg.goto(origin + '/tabs');
    await pg.waitForFunction(`document.getElementById('cust') && ${ROOT}.querySelector('.panel')`, null, { timeout: 10000 });
    await pg.click('#cust');
    await sleep(1500);
    const learned = await pg.evaluate(`JSON.parse(localStorage.getItem('editlens.pageMap') || '{}')['src/Customers.jsx'] || null`);
    check('a source line that is not a number is not learned', learned && learned.via && learned.via.id === 'cust' && !/Infinity|NaN/.test(learned.via.src), learned);
    // Sol M8: a page move that loaded the page again is not finished there while Follow is paused.
    await pg.evaluate((f) => {
      localStorage.setItem('editlens.followPage', 'off');
      sessionStorage.setItem('editlens.pageTask', JSON.stringify({ task: { file: f, line: 3, end: 3, quiet: true, key: 'm8' }, until: Date.now() + 20000 }));
    }, path.join(proj, 'src', 'Customers.jsx'));
    await pg.goto(origin + '/tabs');
    await pg.waitForFunction(`document.getElementById('cust') && ${ROOT}.querySelector('.panel')`, null, { timeout: 10000 });
    await sleep(2500);
    check('Sol M8: paused, the page move from before the reload does not click the tab', (await win('__tab')) === 0, await win('__tab'));
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
