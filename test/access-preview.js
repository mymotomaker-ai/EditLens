#!/usr/bin/env node
'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4951';
// The yellow "Manual" badge in the panel header, without Claude: shown in Manual, a click opens a
// short how-to with Copy, page control hides it, and nothing runs past a 480px panel. Every place where
// Claude can't act from the page offers the same "Turn on page control" button, which copies the command.
//
//   NODE_PATH=$(npm root -g) node test/access-preview.js <site-url> <site-dir> <out-dir>
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { onTimeout } = require('./timeout');
const { launchOwnPort } = require('./site-port');
const { ensureServer, stopServer, postEvent } = require('../lib/client');

const [siteUrl, siteArg, outDir = 'access-out'] = process.argv.slice(2);
if (!siteUrl || !siteArg) {
  console.error('usage: access-preview.js <site-url> <site-dir> <out-dir>');
  process.exit(2);
}
const siteDir = path.resolve(siteArg);
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const SESSION = `access-${Date.now()}`;
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}

(async () => {
  await stopServer();
  await ensureServer();
  await postEvent({ type: 'session', sessionId: SESSION, cwd: siteDir, ts: Date.now(), canListen: false });
  const browser = await launchOwnPort(chromium);
  for (const scheme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    page.on('pageerror', (e) => { console.log('[pageerror]', e.message); failed++; });
    await page.goto(siteUrl);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status.idle, .status.stopped')`);
    const q = (src) => page.evaluate(`(() => { const r = ${ROOT}; ${src} })()`);
    const shown = (sel) => q(`const e = r.querySelector(${JSON.stringify(sel)}); return !!e && getComputedStyle(e).display !== 'none';`);

    if (scheme === 'light') {
      // First visit: the tour ends with the "Page control" step.
      const steps = [];
      for (let i = 0; i < 8 && (await shown('.tour.on')); i++) {
        steps.push(await q(`return r.querySelector('.tour.on b').textContent`));
        const done = await q(`const n = [...r.querySelectorAll('.tour.on button')].find((b) => b.textContent === 'Next'); if (n) { n.click(); return false; } return true;`);
        if (done) break;
      }
      check('tour: the last step is Page control', /Page control/.test(steps[steps.length - 1] || ''), steps);
      const pc = await q(`const b = [...r.querySelectorAll('.tour.on button')].find((x) => x.textContent === 'Turn on page control'); if (b) b.click(); return !!b;`);
      await page.waitForTimeout(200);
      check('tour: its button copies /editlens control', pc && (await page.evaluate(() => navigator.clipboard.readText())) === '/editlens control');
      await q(`[...r.querySelectorAll('.tour.on button')].find((x) => x.textContent === 'Done').click(); return true;`);
      check('tour: Done ends it', !(await shown('.tour.on')));
    }
    check(`${scheme}: badge shows in Manual`, await shown('.acc'));
    check(`${scheme}: badge text`, (await q(`return r.querySelector('.acc').textContent`)) === 'Manual' && (await q(`return getComputedStyle(r.querySelector('.acc .adot')).display`)) !== 'none');
    const amber = await q(`return getComputedStyle(r.querySelector('.acc')).color`);
    check(`${scheme}: badge is amber`, /^rgb\((178, 80, 0|255, 179, 64)\)$/.test(amber), amber);
    check(`${scheme}: badge has a hover tip`, /Click for how/.test(await q(`return r.querySelector('.acc').title`)));
    check(`${scheme}: how-to hidden until clicked`, !(await shown('.accpop')));
    await q(`r.querySelector('.acc').click(); return true;`);
    check(`${scheme}: click opens the how-to`, await shown('.accpop'));
    const text = await q(`return r.querySelector('.accpop').innerText`);
    check(`${scheme}: how-to names the command`, /\/editlens control/.test(text), text);
    await page.screenshot({ path: path.join(outDir, `access-${scheme}.png`) });
    await page.locator('edit-lens').evaluate((host) => host.shadowRoot.querySelector('.panel').scrollIntoView());
    const panelShot = await page.evaluate(`(() => { const b = ${ROOT}.querySelector('.panel').getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: Math.min(b.height, 260) }; })()`);
    await page.screenshot({ path: path.join(outDir, `access-${scheme}-panel.png`), clip: panelShot });
    check(`${scheme}: how-to offers Turn on page control`, await q(`const b = r.querySelector('.accpop .abtn'); return b.textContent === 'Turn on page control' && /For full control from this page/.test(b.title);`));
    await q(`[...r.querySelectorAll('.accpop .abtn')].find((b) => b.textContent === 'Not now').click(); return true;`);

    // A page message while Claude is idle in Manual: the same accent button, next to Copy and Cancel.
    await q(`const i = r.querySelector('.composer textarea'); i.value = 'test'; i.dispatchEvent(new Event('input')); r.querySelector('.composer .send, .composer button[title^="Send"]').click(); return true;`);
    const bubbleOk = await page.waitForFunction(`[...${ROOT}.querySelectorAll('.k-user .state.wait .pcon')].some((b) => b.getClientRects().length)`, null, { timeout: 3000 }).then(() => true, onTimeout(false));
    check(`${scheme}: a waiting page message offers Turn on page control`, bubbleOk);
    const pc = await q(`const b = [...r.querySelectorAll('.k-user .state.wait .pcon')].pop(); const acc = getComputedStyle(r.querySelector('.panel')).getPropertyValue('--accent').trim();
      return { text: b.textContent, tip: b.title, bg: getComputedStyle(b).backgroundColor, acts: [...b.parentNode.children].map((x) => x.textContent), foot: getComputedStyle(r.querySelector('.cfoot .pcon')).display !== 'none' };`);
    check(`${scheme}: button text, tip and place`, pc.text === 'Turn on page control' && /For full control from this page, turn on page control: type \/editlens control in Claude Code/.test(pc.tip) && pc.acts.join('|') === 'Turn on page control|Copy|Cancel', pc);
    check(`${scheme}: button is the accent color`, /^rgb\((191, 85, 44|180, 83, 44)\)$/.test(pc.bg), pc.bg);
    check(`${scheme}: the composer offers it too`, pc.foot, pc);
    check(`${scheme}: only the newest waiting message shows it`, await q(`return [...r.querySelectorAll('.k-user .state.wait .pcon')].filter((b) => b.getClientRects().length).length === 1;`));
    await q(`[...r.querySelectorAll('.k-user .state.wait .pcon')].pop().click(); return true;`);
    await page.waitForTimeout(300);
    const copied = await page.evaluate(() => navigator.clipboard.readText()).catch((err) => 'error: ' + err.message);
    const toastText = await q(`return r.querySelector('.toast').textContent`);
    check(`${scheme}: click copies the command`, copied === '/editlens control' && /Paste it into Claude Code to turn on page control/.test(toastText), { copied, toastText });
    await page.screenshot({ path: path.join(outDir, `access-${scheme}-message.png`) });
    check(`${scheme}: Not now closes it`, !(await shown('.accpop')));

    // Page control on: the badge is hidden; back in Manual: it appears again.
    await postEvent({ type: 'drive', phase: 'starting', sessionId: SESSION, ts: Date.now() });
    const hid = await page.waitForFunction(`getComputedStyle(${ROOT}.querySelector('.acc')).display === 'none'`, null, { timeout: 3000 }).then(() => true, onTimeout(false));
    check(`${scheme}: page control hides the badge`, hid);
    check(`${scheme}: page control hides the other buttons`, await q(`return [...r.querySelectorAll('.pcon')].every((b) => !b.getClientRects().length);`));
    await postEvent({ type: 'drive', phase: 'ended', sessionId: SESSION, ts: Date.now() });
    const back = await page.waitForFunction(`getComputedStyle(${ROOT}.querySelector('.acc')).display !== 'none'`, null, { timeout: 3000 }).then(() => true, onTimeout(false));
    check(`${scheme}: Manual shows it again`, back);

    if (scheme === 'light') {
      await page.setViewportSize({ width: 480, height: 800 });
      await page.waitForTimeout(300);
      await q(`r.querySelector('.acc').click(); return true;`);
      const past = await q(`const p = r.querySelector('.panel').getBoundingClientRect(); return [...r.querySelectorAll('.head *, .accpop *')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && b.right > p.right + 1; }).map((e) => e.className || e.tagName);`);
      check('480px: nothing runs past the panel', past.length === 0, past);
      await page.screenshot({ path: path.join(outDir, 'access-480.png') });
    }
    await context.close();
  }
  await browser.close();
  await stopServer(); // left running, it would refuse the next run (a new state folder)
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exit(failed ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  await stopServer();
  process.exit(1);
});
