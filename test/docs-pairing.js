#!/usr/bin/env node
'use strict';
require('./isolate');
// Makes the pictures for docs/pairing.md with two servers on this machine (a "VPS" and a "laptop"):
// the /editlens pair and /editlens join output, the paired page with its ◆ label, a VPS edit shown
// live on the laptop (a GIF), and page control from the laptop. Stand-in SDK and ssh; nothing real.
//
//   NODE_PATH=$(npm root -g) node test/docs-pairing.js <out-dir>   (ports 4966-4969; ffmpeg for the GIF)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'docs-pairing-out', 'node test/docs-pairing.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const PLUGIN = path.join(__dirname, '..');
const SERVER = path.join(PLUGIN, 'server', 'server.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-docs-pairing-'));
const fake = path.join(base, 'fake');
const home = path.join(base, 'home');

const VPS = { name: 'vps', port: 4966, pairPort: 4967, dir: path.join(base, 'vps') };
const LAPTOP = { name: 'laptop', port: 4968, pairPort: 4969, dir: path.join(base, 'laptop') };
// What the pictures show instead of this machine's own names (documentation addresses).
const SHOWN = [[/tester@127\.0\.0\.1:\d+/g, 'root@203.0.113.5'], [/\w+@\d+\.\d+\.\d+\.\d+:4967/g, 'root@203.0.113.5'], [/127\.0\.0\.1:4967/g, '203.0.113.5'],
  [new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '/root'], [new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '/root'],
  [/"[^"]*id_docs"/g, '"C:/Users/you/.ssh/id_ed25519"']];
const shown = (text) => SHOWN.reduce((t, [re, to]) => t.replace(re, to), text);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}
const ownEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC_|EDITLENS_)/.test(k)));
const env = (s) => ({ ...ownEnv, EDITLENS_TEST_PASSWD: process.env.EDITLENS_TEST_PASSWD, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_STEADY_PORTS: 'off',
  EDITLENS_NO_BROWSER: '1', EDITLENS_SSH: path.join(__dirname, 'fixtures', 'fake-ssh.js'), EDITLENS_SDK_DIR: path.join(fake, 'sdk'),
  EDITLENS_CLAUDE_PATH: path.join(fake, 'bin', 'claude'), FAKE_SDK_MODEL: 'sonnet', FAKE_CLAUDE_STATE: path.join(fake, 'state'), HOME: home, USERPROFILE: home });
// As root, each server and command runs with its own host name ("vps", "laptop"); otherwise this machine's.
const NAMED = process.getuid && process.getuid() === 0 && spawnSync('unshare', ['-u', 'true']).status === 0;
const named = (s, args) => (NAMED ? ['unshare', ['-u', 'sh', '-c', 'hostname "$1" && shift && exec "$@"', 'sh', s.name, process.execPath, ...args]] : [process.execPath, args]);
// The VPS project, in the temporary folder; the pictures show it as /root/shop (see SHOWN and showAsRoot).
const vpsProject = path.join(home, 'shop');
function start(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  s.child = spawn(...named(s, [SERVER]), { env: env(s), stdio: 'ignore' });
  return waitFor(() => fs.existsSync(path.join(s.dir, `token-${s.port}`)) && fetch(`http://127.0.0.1:${s.port}/health`).then((r) => r.ok, notRunning(false)));
}
function stop(s) {
  return new Promise((r) => {
    if (!s.child || s.child.exitCode !== null) return r();
    s.child.once('exit', r);
    s.child.kill();
  });
}
const api = (s, method, p, body) => fetch(`http://127.0.0.1:${s.port}${p}`, {
  method, headers: { 'content-type': 'application/json', 'x-editlens-token': fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8') },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((r) => r.json());
// One /editlens command, as Claude Code runs it: plain text out.
function command(s, cwd, args) {
  const r = spawnSync(...named(s, [path.join(PLUGIN, 'bin', 'start.js'), ...args]), { cwd, encoding: 'utf8', timeout: 60000,
    env: { ...env(s), CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_ROOT: PLUGIN, EDITLENS_TYPED: '1' } });
  return (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

// In the page: the panel's text shows /root for the temporary home folder, as the terminal pictures do.
// A path the panel splits at its slashes (text and <wbr> only) is split the same way again.
function showAsRoot(from) {
  const fix = (node) => {
    if (node.nodeType === 3 && node.nodeValue.includes(from)) node.nodeValue = node.nodeValue.split(from).join('/root');
    const kids = [...node.childNodes];
    if (node.nodeType === 1 && kids.length > 1 && kids.every((k) => k.nodeType === 3 || k.nodeName === 'WBR') && node.textContent.includes(from)) {
      const text = node.textContent.split(from).join('/root');
      node.textContent = '';
      text.replace(/([\\/])/g, '$1\n').split('\n').forEach((part, i) => {
        if (i) node.appendChild(document.createElement('wbr'));
        node.appendChild(document.createTextNode(part));
      });
    }
    node.childNodes.forEach(fix);
  };
  const timer = setInterval(() => {
    const host = document.querySelector('edit-lens');
    if (!host || !host.shadowRoot) return;
    clearInterval(timer);
    fix(host.shadowRoot);
    new MutationObserver((list) => list.forEach((m) => fix(m.target))).observe(host.shadowRoot, { subtree: true, childList: true, characterData: true });
  }, 50);
}

// A Claude Code window drawn in HTML: the typed command, then what it printed.
function terminalHtml(title, typed, out) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;background:#e9e9ee;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.win{margin:24px;border-radius:12px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#1e1e22;color:#e8e8ea;width:1040px}
.bar{background:#2c2c31;padding:10px 14px;display:flex;gap:8px;align-items:center;color:#a0a0a8;font:12px system-ui}
.dot{width:12px;height:12px;border-radius:50%;background:#ff5f57}.dot:nth-child(2){background:#febc2e}.dot:nth-child(3){background:#28c840}
.t{margin-left:10px}pre{margin:0;padding:16px 20px;white-space:pre-wrap;overflow-wrap:anywhere}
.p{color:#d97757}.ok{color:#5fd068}</style></head><body><div class="win"><div class="bar"><span class="dot"></span><span class="dot"></span><span class="dot"></span><span class="t">${esc(title)}</span></div>
<pre><span class="p">&gt;</span> ${esc(typed)}\n\n${esc(out).replace(/^(✓.*)$/gm, '<span class="ok">$1</span>')}</pre></div></body></html>`;
}
async function shoot(browser, file, html) {
  const p = await browser.newPage({ viewport: { width: 1100, height: 400 }, deviceScaleFactor: 2 });
  await p.setContent(html);
  await p.locator('.win').screenshot({ path: path.join(outDir, file) });
  await p.close();
}

(async () => {
  const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
  fs.mkdirSync(sdk, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
  fs.mkdirSync(path.join(fake, 'bin'));
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(fake, 'bin', 'claude'));
  fs.mkdirSync(path.join(fake, 'state'));
  fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(vpsProject, { recursive: true });
  const page = (h1, extra) => `<!doctype html><html><head><title>Shop</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui;margin:0;background:#fafafa;color:#222}header{background:#1f3a5f;color:#fff;padding:18px 32px}main{padding:32px}
.card{background:#fff;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.08);padding:20px;margin:12px 0;max-width:520px}</style></head>
<body><header><b>Shop</b> on the VPS</header><main><h1>${h1}</h1><div class="card">Free delivery on orders over 50 €.</div>${extra || ''}</main></body></html>\n`;
  fs.writeFileSync(path.join(vpsProject, 'index.html'), page('Welcome'));
  const key = path.join(base, 'id_docs');
  fs.writeFileSync(key, 'not a real key');

  let browser = null;
  let failed = 0;
  try {
    if (!(await start(VPS)) || !(await start(LAPTOP))) throw new Error('a server did not start: are ports 4630-4633 free?');
    browser = await launch(chromium, process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
    await api(VPS, 'POST', '/connect', { cwd: vpsProject });

    // 1. On the VPS: /editlens pair.
    const pairOut = command(VPS, vpsProject, ['pair']);
    const code = (/[A-Z0-9]{4}(?:-[A-Z0-9]{4}){6}/.exec(pairOut) || [])[0];
    if (!code) throw new Error('no code in: ' + pairOut);
    await shoot(browser, 'pairing-1-pair.png', terminalHtml('VPS · Claude Code · ~/shop', '/editlens pair', shown(pairOut)));

    // 2. On the laptop: /editlens join (through SSH, with a key file).
    const joinArgs = ['join', `tester@127.0.0.1:${VPS.pairPort}`, code, '--key', key];
    const joinOut = command(LAPTOP, home, joinArgs);
    await shoot(browser, 'pairing-2-join.png', terminalHtml('Laptop · Claude Code', shown(`/editlens join tester@127.0.0.1:${VPS.pairPort} ${code} --key "${key}"`), shown(joinOut)));
    const hosts = await api(LAPTOP, 'GET', '/pair');
    const host = (hosts.remotes && hosts.remotes.hosts || [])[0] || null;
    const url = host && host.url;
    if (!url) throw new Error('not paired: ' + joinOut + ' ' + JSON.stringify(hosts));
    const name = host.name;

    // 3. The VPS's page in the laptop's browser, with ◆ name in the panel.
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1, recordVideo: { dir: path.join(base, 'video'), size: { width: 1280, height: 760 } } });
    await ctx.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await ctx.addInitScript(showAsRoot, home);
    const t0 = Date.now();
    const pg = await ctx.newPage();
    // The address with this user's key (D11): the browser keeps the site's cookie it sets.
    await pg.goto(host.keyUrl);
    await pg.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.host.on')`, null, { timeout: 15000 });
    await sleep(1200);
    await pg.screenshot({ path: path.join(outDir, 'pairing-3-paired-page.png') });

    // 4. An edit on the VPS appears live on the laptop's page (the GIF).
    const before = fs.readFileSync(path.join(vpsProject, 'index.html'), 'utf8');
    const tEdit = Date.now();
    const after = page('Welcome', '<div class="card"><b>New:</b> pay on delivery.</div>');
    fs.writeFileSync(path.join(vpsProject, 'index.html'), after);
    await api(VPS, 'POST', '/event', { type: 'change', sessionId: 'docs1', cwd: vpsProject, file: path.join(vpsProject, 'index.html'), tool: 'Edit',
      intent: 'Add a pay-on-delivery card.', stats: { added: 1, removed: 0 }, before, after, hunks: [{ oldStart: 1, newStart: 1, lines: ['+<div class="card"><b>New:</b> pay on delivery.</div>'] }], ts: Date.now() });
    await waitFor(() => pg.evaluate(() => document.body.textContent.includes('pay on delivery')), 10000);
    await waitFor(() => pg.evaluate(`!${ROOT}.querySelector('.toast.on')`), 10000);
    await sleep(1000);
    await pg.screenshot({ path: path.join(outDir, 'pairing-4-live-edit.png') });

    // 5. Page control from the laptop: /editlens control <name>.
    const controlOut = command(LAPTOP, home, ['control', name]);
    await shoot(browser, 'pairing-5-control.png', terminalHtml('Laptop · Claude Code', `/editlens control ${name}`, shown(controlOut)));
    const driving = await waitFor(() => pg.evaluate(`${ROOT}.querySelector('.panel').classList.contains('driving')`), 20000);
    if (!driving) {
      failed++;
      console.log('FAIL page control did not start on the paired page');
    }
    await sleep(800);
    await pg.screenshot({ path: path.join(outDir, 'pairing-6-page-control.png') });
    const video = await pg.video().path();
    await ctx.close();

    // The GIF: the part of the video where the edit appears.
    const gif = path.join(outDir, 'pairing-live-edit.gif');
    const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(Math.max(0, (tEdit - t0) / 1000 - 1.5).toFixed(1)), '-t', '5', '-i', video, '-vf',
      'fps=10,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=5', gif], { encoding: 'utf8' });
    if (ff.status !== 0) {
      failed++;
      console.log('FAIL ffmpeg: ' + ff.stderr);
    }
    for (const f of fs.readdirSync(outDir)) console.log(`${f} ${fs.statSync(path.join(outDir, f)).size}`);
    fs.writeFileSync(path.join(outDir, 'commands.txt'), [pairOut, joinOut, controlOut].map(shown).join('\n\n----\n\n'));
  } finally {
    if (browser) await browser.close();
    await stop(VPS);
    await stop(LAPTOP);
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
