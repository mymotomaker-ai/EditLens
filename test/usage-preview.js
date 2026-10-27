#!/usr/bin/env node
'use strict';
require('./isolate');
// Renders the usage rings and details, without running Claude: first from a transcript alone,
// then with Claude Code's status line numbers (exact window, cost, plan limits). Light and dark.
// A reset time too far away to be a date is left out (never "Invalid Date").
//   NODE_PATH=$(npm root -g) node test/usage-preview.js <out-dir> [prefix]
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const { launch } = require('./launch');

let failed = 0;
function check(label, ok, detail) {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
}

const [outDir, prefix = 'usage'] = process.argv.slice(2);
if (!outDir) {
  console.error('usage: usage-preview.js <out-dir> [prefix]');
  process.exit(2);
}
fs.mkdirSync(require('./out-dir')(outDir), { recursive: true });

const LIVE_PORT = 4389;
const PAGE_PORT = 4388;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-usage-preview-'));
const transcript = path.join(stateDir, 'session.jsonl');
// The page is light, so the panel would follow it; data-theme on the script tag sets the panel's theme.
// data-root links the page to the project, so its message box is on.
const PAGE = (theme) => `<!doctype html><html><head><meta charset="utf-8"><title>Trailhead Coffee</title>
<style>body{margin:0;font:16px/1.5 system-ui,sans-serif;background:#f6f5f1;color:#222}main{padding:48px 40px;max-width:560px}h1{font-size:40px;margin:0}</style>
</head><body><main><h1>New coffee each day</h1><p>Small-batch roasts, brewed slowly.</p></main>
<script src="http://127.0.0.1:${LIVE_PORT}/live.js" data-panel="open" data-root="/site" data-theme="${theme}"></script></body></html>`;

function request(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: LIVE_PORT, path: urlPath, method, headers: {
      ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      ...(token ? { 'x-editlens-token': token } : {}),
    } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitUp() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await request('GET', '/health')).status === 200) return;
    } catch (err) {
      if (err.code !== 'ECONNREFUSED') throw err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('live server did not start');
}

// A session of a few turns with tool calls, a subagent and a cost record for a 1M model.
function writeTranscript() {
  const t0 = Date.now() - 47 * 60000;
  const at = (min) => new Date(t0 + min * 60000).toISOString();
  const lines = [];
  let read = 0;
  for (let turn = 0; turn < 6; turn++) {
    lines.push({ type: 'user', timestamp: at(turn * 7), message: { content: `Request ${turn + 1}` } });
    for (let call = 0; call < 5; call++) {
      read += 6200;
      lines.push({ type: 'assistant', timestamp: at(turn * 7 + call), effort: { level: 'high' }, message: {
        id: `m${turn}-${call}`, model: 'claude-opus-5-5',
        usage: { input_tokens: 4, cache_read_input_tokens: 21000 + read, cache_creation_input_tokens: 2100, output_tokens: 380 },
        content: [{ type: 'tool_use', id: `t${turn}-${call}`, name: turn === 2 && call === 0 ? 'Agent' : 'Edit', input: {} }],
      } });
    }
  }
  lines.push({ type: 'cost-state', totalCostUSD: 3.4172, totalDuration: 2700000, modelUsage: { 'claude-opus-5-5[1m]': {} } });
  fs.writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

(async () => {
  writeTranscript();
  const site = http.createServer((req, res) => {
    const theme = new URL(req.url, 'http://127.0.0.1').searchParams.get('theme') === 'dark' ? 'dark' : 'light';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGE(theme));
  }).listen(PAGE_PORT, '127.0.0.1');
  let browser = null;
  let live = null;
  try {
    browser = await launch(chromium);
    for (const scheme of ['dark', 'light']) {
      // A new server per run, so each starts from the transcript alone.
      live = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
        env: { ...process.env, EDITLENS_PORT: String(LIVE_PORT), EDITLENS_STATE_DIR: stateDir },
        stdio: 'ignore',
      });
      await waitUp();
      const token = fs.readFileSync(path.join(stateDir, `token-${LIVE_PORT}`), 'utf8').trim();
      await request('POST', '/event', { type: 'session', sessionId: 's1', cwd: '/site', transcriptPath: transcript, canListen: true, ts: Date.now() }, token);
      const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 2, colorScheme: scheme });
      const page = await context.newPage();
      page.on('pageerror', (e) => console.log('[pageerror]', e.message));
      // Skip the first-visit tour; localStorage can throw in private mode.
      await page.addInitScript(() => {
        try {
          localStorage.setItem('editlens.tourDone', '1');
        } catch (err) {
          if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err;
        }
      });
      await page.goto(`http://127.0.0.1:${PAGE_PORT}/?theme=${scheme}`);
      const root = 'document.querySelector("edit-lens").shadowRoot';
      await page.waitForFunction(`${root} && ${root}.querySelector('.ring.ctx:not(.none)')`);
      const read = () => page.evaluate(`(() => { const r = ${root}; return { ctx: r.querySelector('.ring.ctx b').textContent, ses: r.querySelector('.ring.ses b').textContent, title: r.querySelector('.meters').title }; })()`);
      console.log(scheme, 'transcript only', JSON.stringify(await read()));
      await page.evaluate(`${root}.querySelector('.meters').click()`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-1-transcript.png`) });

      // Now Claude Code's status line reports exact numbers and plan limits.
      const now = Math.floor(Date.now() / 1000);
      const status = await request('POST', '/status', {
        session_id: 's1', transcript_path: transcript, workspace: { current_dir: '/site' },
        model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' }, effort: { level: 'high' },
        context_window: { context_window_size: 1000000, used_percentage: 23.4, total_input_tokens: 234000 },
        cost: { total_cost_usd: 3.52, total_duration_ms: 2820000 },
        rate_limits: { five_hour: { used_percentage: 41, resets_at: now + 2 * 3600 + 900 }, seven_day: { used_percentage: 74, resets_at: now + 3 * 86400 } },
      }, token);
      if (status.status !== 200) throw new Error(`status rejected: ${status.body}`);
      await page.waitForFunction(`${root}.querySelector('.ring.ses:not(.none)')`);
      await page.waitForTimeout(700);
      console.log(scheme, 'with status line', JSON.stringify(await read()));
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-2-status-line.png`) });
      // A reset time past the last date a Date can have (1e17 s).
      await request('POST', '/status', { session_id: 's1', transcript_path: transcript, workspace: { current_dir: '/site' },
        rate_limits: { five_hour: { used_percentage: 41, resets_at: now + 2 * 3600 + 900 }, seven_day: { used_percentage: 74, resets_at: 1e17 } } }, token);
      await page.waitForTimeout(700);
      const ses = await page.evaluate(`(() => { const c = ${root}.querySelector('.ucard.ses'); return c ? c.textContent : null; })()`);
      check(`${scheme}: a reset time that is not a date is left out`, Boolean(ses) && /74/.test(ses) && !/Invalid|NaN|undefined/.test(ses), ses);
      await page.evaluate(`${root}.querySelector('.meters').click()`);
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, `${prefix}-${scheme}-3-closed.png`), clip: { x: 700, y: 60, width: 480, height: 140 } });
      await context.close();
      const exited = new Promise((r) => live.once('exit', r));
      live.kill();
      await exited;
      live = null;
    }
  } finally {
    if (browser) await browser.close();
    site.close();
    if (live) live.kill();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
