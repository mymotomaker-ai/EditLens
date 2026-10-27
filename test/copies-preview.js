#!/usr/bin/env node
'use strict';
require('./isolate');
// Subagents in their own copy, in the browser: an edit made in a copy (labelled, not highlighted),
// the card when the subagent finishes, Merge (the file appears as an edit with Restore), a conflict
// with "Use its version", Remove, and the warning when two agents edit the same file.
// Light and dark, wide and narrow.
//
//   NODE_PATH=$(npm root -g) node test/copies-preview.js <out-dir>
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');
const { notRunning } = require('./timeout');
const { launch, stopChildren } = require('./launch');

const outDir = require('./out-dir')(process.argv[2] || 'copies-out', 'node test/copies-preview.js <out-dir>');
fs.mkdirSync(outDir, { recursive: true });
const ROOT = 'document.querySelector("edit-lens").shadowRoot';
const PORT = 4370;
const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ': ' + JSON.stringify(detail)}`);
  if (!ok) failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await sleep(150);
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-copies-preview-'));
const stateDir = path.join(base, 'state');
const project = path.join(base, 'shop');
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}
// Manual (as Claude Code passes the setting to hooks): with page control on (the default) the server
// sets it up when the page opens, in a process (bin/drive.js) that downloads the SDK and outlives
// this script.
const env = { ...process.env, EDITLENS_PORT: String(PORT), EDITLENS_STATE_DIR: stateDir, CLAUDE_PLUGIN_OPTION_START: 'Connect the page' };
function hook(phase, input) {
  spawnSync(process.execPath, [HOOK, phase], { input: JSON.stringify(input), encoding: 'utf8', env });
}

(async () => {
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  git(project, 'init', '-q', '-b', 'main');
  git(project, 'config', 'user.email', 't@example.com');
  git(project, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(project, 'src', 'Prices.jsx'), 'export const Prices = () => <p className="price">$12</p>;\n');
  fs.writeFileSync(path.join(project, 'src', 'Nav.jsx'), 'export const Nav = () => <nav>Shop</nav>;\n');
  fs.writeFileSync(path.join(project, '.gitignore'), '.claude/\n');
  git(project, 'add', '-A');
  git(project, 'commit', '-q', '-m', 'start');
  const copy = path.join(project, '.claude', 'worktrees', 'agent-a7f3');
  git(project, 'worktree', 'add', '-q', '-b', 'worktree-agent-a7f3', copy, 'HEAD');

  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><head><title>Shop</title><style>body{font:16px system-ui;margin:40px}</style></head><body><h1>Shop</h1><p class="price">$12</p>
<script src="http://127.0.0.1:${PORT}/live.js" data-root="${project}"></script></body></html>`);
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${site.address().port}/`;
  let server = null;
  let browser = null;
  try {
    server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], { env, stdio: 'ignore' });
    await waitFor(() => fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, notRunning(false)));
    browser = await launch(chromium, {}, [server]);
    hook('session', { hook_event_name: 'SessionStart', session_id: 's1', cwd: project, source: 'startup' });
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Skip the tour; localStorage can throw in private mode.
    await page.addInitScript(() => { try { localStorage.setItem('editlens.tourDone', '1'); } catch (err) { if (!/^(SecurityError|QuotaExceededError)$/.test(err.name)) throw err; } });
    await page.goto(url);
    await page.waitForFunction(`${ROOT} && ${ROOT}.querySelector('.status')`, null, { timeout: 15000 });
    await page.evaluate(`${ROOT}.querySelector('.panel') && ${ROOT}.querySelector('.panel').classList.contains('open') || (${ROOT}.querySelector('.launcher') || {click(){}}).click()`);
    await sleep(800);

    // The subagent edits Prices.jsx and Nav.jsx in its copy; meanwhile Claude edits Nav.jsx in the project.
    const edit = (dirRoot, rel, from, to, agent, tu) => {
      const file = path.join(dirRoot, rel);
      const before = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, before.replace(from, to));
      hook('step', { hook_event_name: 'PostToolUse', session_id: 's1', cwd: dirRoot, tool_name: 'Edit', tool_use_id: tu, ...(agent ? { agent_id: 'a7f3', agent_type: 'general-purpose' } : {}),
        tool_input: { file_path: file, old_string: from, new_string: to }, tool_response: { originalFile: before } });
    };
    edit(copy, 'src/Prices.jsx', '$12', '<b>$12</b>', true, 't1');
    edit(copy, 'src/Nav.jsx', 'Shop', 'Shop · Sale', true, 't2');
    edit(project, 'src/Nav.jsx', 'Shop', 'Store', false, 't3');
    const incopy = await waitFor(() => page.evaluate(`${ROOT}.querySelectorAll('.k-edit.incopy').length`));
    check('edits in the copy are labelled', incopy === 2, incopy);
    hook('agent-stop', { hook_event_name: 'SubagentStop', session_id: 's1', cwd: copy, agent_id: 'a7f3', agent_type: 'general-purpose', last_assistant_message: 'Done.' });
    const card = await waitFor(() => page.evaluate(`(() => { const c = ${ROOT}.querySelector('.k-copy'); return c && { text: c.textContent, files: [...c.querySelectorAll('.cf')].map((f) => f.className + ' ' + f.textContent) }; })()`));
    check('the copy card lists a ready file and a conflict', card && card.files.length === 2 && /Merge 1 file/.test(card.text) && card.files.some((f) => /conflict/.test(f)), card);
    for (const [scheme, width] of [['light', 1280], ['dark', 1280], ['light', 390]]) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height: 860 });
      await sleep(400);
      await page.evaluate(`${ROOT}.querySelector('.k-copy').scrollIntoView({ block: 'center' })`);
      await page.screenshot({ path: path.join(outDir, `copy-${scheme}-${width}.png`) });
    }
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setViewportSize({ width: 1280, height: 860 });

    await page.evaluate(`[...${ROOT}.querySelectorAll('.k-copy .pacts .allow')][0].click()`);
    const merged = await waitFor(() => page.evaluate(`[...${ROOT}.querySelectorAll('.k-edit')].some((e) => !e.classList.contains('incopy') && /Merged from its copy/.test(e.textContent) && e.querySelector('.rst'))`));
    check('Merge: the file appears as an edit with Restore', merged);
    check('Prices.jsx changed in the project', /<b>\$12<\/b>/.test(fs.readFileSync(path.join(project, 'src', 'Prices.jsx'), 'utf8')));
    check('Nav.jsx kept as it was (a conflict)', /Store/.test(fs.readFileSync(path.join(project, 'src', 'Nav.jsx'), 'utf8')));
    const after = await waitFor(() => page.evaluate(`(() => { const c = ${ROOT}.querySelector('.k-copy'); return c && !/Merge 1 file/.test(c.textContent) && c.textContent; })()`));
    check('the card updates after merging', Boolean(after), after);
    await page.evaluate(`${ROOT}.querySelector('.k-copy').scrollIntoView({ block: 'center' })`);
    await page.screenshot({ path: path.join(outDir, 'copy-merged.png') });

    await page.evaluate(`[...${ROOT}.querySelectorAll('.k-copy .cf.conflict .mini')][0].click()`);
    const took = await waitFor(() => /Sale/.test(fs.readFileSync(path.join(project, 'src', 'Nav.jsx'), 'utf8')));
    check('Use its version takes the copy\'s Nav.jsx', took);
    const done = await waitFor(() => page.evaluate(`${ROOT}.querySelector('.k-copy.done') !== null`));
    check('then the card says everything is in', done);

    // After a merge the card is redrawn twice (the server's copy-state event and the page's own
    // check of the copy), and the later one closes an open question: open it again until it stays (L9).
    const openRemove = `const c = ${ROOT}.querySelector('.k-copy'); const rm = [...c.querySelectorAll('.pacts .mini')]
      .find((b) => b.textContent === 'Remove copy' && !b.disabled); if (rm) rm.click(); return false;`;
    const asked = await waitFor(() => page.evaluate(`(() => { if (${ROOT}.querySelector('.k-copy .rconf .pacts .mini')) return true; ${openRemove} })()`));
    check('Remove copy asks first', asked);
    await page.screenshot({ path: path.join(outDir, 'copy-remove-confirm.png') });
    const confirmed = await waitFor(() => page.evaluate(`(() => { const go = ${ROOT}.querySelector('.k-copy .rconf .pacts .mini');
      if (go) { go.click(); return true; } ${openRemove} })()`));
    check('the question has a Remove button', confirmed);
    const removed = await waitFor(() => !fs.existsSync(copy));
    check('Remove copy removes the worktree', removed);

    // Two agents, same file, no copy: a warning on the second edit.
    edit(project, 'src/Prices.jsx', '<b>', '<strong>', false, 't4');
    hook('step', { hook_event_name: 'PostToolUse', session_id: 's1', cwd: project, tool_name: 'Edit', tool_use_id: 't5', agent_id: 'b9c1', agent_type: 'general-purpose',
      tool_input: { file_path: path.join(project, 'src', 'Prices.jsx'), old_string: '$12', new_string: '$10' }, tool_response: { originalFile: '' } });
    const warn = await waitFor(() => page.evaluate(`(() => { const w = ${ROOT}.querySelector('.enote.warn'); return w && w.textContent; })()`));
    check('two agents on one file: a warning', /also edited this file/.test(warn || ''), warn);
    await page.evaluate(`${ROOT}.querySelector('.enote.warn').scrollIntoView({ block: 'center' })`);
    await page.screenshot({ path: path.join(outDir, 'copy-overlap.png') });
    check('no page errors', !errors.length, errors);
  } finally {
    if (browser) await browser.close();
    site.close();
    await stopChildren([server]);
    fs.rmSync(base, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} failed` : 'all ok');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
