'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5344';
// Sol scan of 0.24.45 (H1, M3, M6, M8, L3, M1's drive key) and the settings check (G1, G3). H1: with
// /repo/app-a paired, its page gets no chat, grant, board, task or snapshot of /repo. M3: removing a
// pairing while its page control starts ends that start. M6: Undo keeps the files it could not put
// back. M8: a snapshot id needs its server start. Three servers stand in for a VPS and two laptops.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFile, spawnSync } = require('child_process');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pair-scope-'));
const state = path.join(base, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
// The stand-in SDK, loaded through a file that says when it is being loaded and waits for the test
// to let it finish (M3 removes the pairing during that time).
const sdk = path.join(base, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'fake.mjs'));
const loading = path.join(state, 'sdk-loading');
const release = path.join(state, 'sdk-release');
fs.writeFileSync(path.join(sdk, 'sdk.mjs'), `import fs from 'fs';
fs.writeFileSync(${JSON.stringify(loading)}, 'yes');
for (let i = 0; i < 300 && !fs.existsSync(${JSON.stringify(release)}); i++) await new Promise((r) => setTimeout(r, 100));
export * from './fake.mjs';
`);
const exe = path.join(base, 'bin', 'claude');
fs.mkdirSync(path.dirname(exe));
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
const ROOT = path.join(__dirname, '..');
const VPS = { port: 5344, pairPort: 5345, dir: path.join(base, 'vps') };
const LAPTOP = { port: 5346, pairPort: 5347, dir: path.join(base, 'laptop') };
const LAPTOP2 = { port: 5348, pairPort: 5349, dir: path.join(base, 'laptop2') };
const projL = path.join(base, 'laptop-folder');
const projV = path.join(base, 'vps-folder');
fs.mkdirSync(projL);
fs.mkdirSync(projV);
const children = new Set();

function env(s) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^SSH_|^DISPLAY$|^WAYLAND_DISPLAY$|^EDITLENS_NO_BROWSER$/.test(k)));
  return { ...clean, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_SDK_DIR: path.join(base, 'sdk'), FAKE_CLAUDE_STATE: state, EDITLENS_CLAUDE_PATH: exe };
}
function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, text, json, headers: res.headers });
      });
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message, json: null }));
    if (data) req.write(data);
    req.end();
  });
}
const token = (s) => fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
const call = (s, method, p, body) => request(s.port, method, p, body, { 'x-editlens-token': token(s) });
const api = (s, method, p, body) => call(s, method, p, body).then((r) => r.json);
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
async function startServer(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const out = fs.openSync(path.join(s.dir, 'server.log'), 'a');
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: env(s), stdio: ['ignore', out, out] });
  fs.closeSync(out);
  children.add(child);
  child.on('exit', () => children.delete(child));
  assert.ok(await waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200));
}
function laptop(args, extra = {}) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { cwd: projL, timeout: 180000, env: { ...env(LAPTOP), CLAUDE_PROJECT_DIR: projL, ...extra } },
      (err, stdout) => (err && err.killed ? reject(err) : resolve({ out: stdout, code: err ? err.code : 0 })));
  });
}
// The paired page as a browser opens it from the address with the key: its EditLens address through the link.
async function openPaired(keyUrl) {
  let at = new URL(keyUrl);
  let cookie = '';
  for (let i = 0; i < 4; i++) {
    const r = await request(Number(at.port), 'GET', at.pathname + at.search, undefined, { host: at.host, ...(cookie && at.hostname === '127.0.0.1' ? { cookie } : {}) });
    if (r.status !== 302) break;
    if (r.headers['set-cookie'] && at.hostname === '127.0.0.1') cookie = String(r.headers['set-cookie']).split(';')[0];
    at = new URL(r.headers.location, at);
  }
  const sitePort = Number(new URL(keyUrl).port);
  const html = (await request(sitePort, 'GET', '/', undefined, { cookie })).text;
  const m = /127\.0\.0\.1:(\d+)((?:\/gk-[0-9a-f]{32})?)\/live\.js/.exec(html);
  assert.ok(m, html.slice(0, 300));
  return { port: Number(m[1]), gk: m[2], origin: `http://127.0.0.1:${sitePort}` };
}
// An event stream; .text is everything it was sent.
function stream(port, urlPath, headers = {}) {
  const s = { text: '' };
  s.req = http.get({ host: '127.0.0.1', port, path: urlPath, headers, agent: false }, (r) => r.on('data', (c) => { s.text += c; }));
  s.req.on('error', () => {});
  return s;
}
function git(cwd, ...args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}

test.before(async () => {
  await startServer(VPS);
  await startServer(LAPTOP);
  await startServer(LAPTOP2);
});
test.after(async () => {
  for (const c of children) c.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

test('M3: pair off while the page control it asked for starts ends that start', async () => {
  const local = stream(VPS.port, '/events?page=m3-local&root=' + encodeURIComponent(projV));
  try {
    const pair = await api(VPS, 'POST', '/pair', { cwd: projV });
    const joined = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
    assert.ok(joined.ok, JSON.stringify(joined));
    const control = laptop(['control', joined.host.name], { EDITLENS_NO_BROWSER: '1' });
    // bin/drive.js on the VPS asked for page control, and Claude is starting (the SDK is loading).
    assert.ok(await waitFor(() => fs.existsSync(loading), 60000), 'the start began');
    const off = await api(VPS, 'POST', '/pair/off', {});
    assert.ok(off && off.removed === 1, JSON.stringify(off));
    fs.writeFileSync(release, 'yes');
    const said = await control;
    assert.match(said.out, /Page control didn't start on ◆ .*: The pairing was removed during the start/, said.out);
    // The fix is to pair again, not to try the same command again.
    assert.match(said.out, /\/editlens pair .*new code/, said.out);
    assert.doesNotMatch(said.out, /try again/, said.out);
    const summary = async () => (await api(VPS, 'GET', `/summary?cwd=${encodeURIComponent(projV)}`)).control;
    await new Promise((r) => setTimeout(r, 1500));
    assert.notStrictEqual(await summary(), 'page', 'page control is not on after the pairing was removed');
    assert.doesNotMatch(local.text, /"type":"drive-grant"/);
  } finally {
    fs.writeFileSync(release, 'yes');
    local.req.destroy();
    await api(VPS, 'POST', '/drive/end', {});
    await api(LAPTOP, 'POST', '/join/off', {});
  }
});

test('H1: a paired page gets no chat, grant, board, message or task of a project folder above it', async () => {
  fs.writeFileSync(release, 'yes');
  const repo = path.join(base, 'repo');
  const appA = path.join(repo, 'app-a');
  fs.mkdirSync(appA, { recursive: true });
  fs.writeFileSync(path.join(appA, 'index.html'), '<html><body>app-a</body></html>');
  fs.writeFileSync(path.join(repo, '.gitignore'), '.claude/\n');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'start');
  // A folder link in app-a that leads to /repo: a folder inside app-a as written, outside it really.
  fs.symlinkSync(repo, path.join(appA, 'up'));
  assert.ok((await api(VPS, 'POST', '/connect', { cwd: appA })).ok);
  await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'h1-repo', cwd: repo, execPath: exe, ts: Date.now() });
  const pairA = await api(VPS, 'POST', '/pair', { cwd: appA });
  const joinedA = await api(LAPTOP, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pairA.code });
  assert.ok(joinedA.ok, JSON.stringify(joinedA));
  const pairR = await api(VPS, 'POST', '/pair', { cwd: repo });
  const joinedR = await api(LAPTOP2, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pairR.code });
  assert.ok(joinedR.ok, JSON.stringify(joinedR));
  const { port, gk, origin } = await openPaired(joinedA.host.keyUrl);
  const paired = stream(port, gk + '/events?page=h1-page&root=' + encodeURIComponent(appA), { origin });
  const local = stream(VPS.port, '/events?page=h1-local&root=' + encodeURIComponent(repo));
  const page = (p, body) => request(port, 'POST', gk + p, body, { origin });
  try {
    assert.ok(await waitFor(() => paired.text.includes('"type":"hello"') && local.text.includes('"type":"hello"')), 'both pages are open');

    // Chat of the session in /repo, and of a folder that is in app-a only as written.
    await api(VPS, 'POST', '/event', { type: 'prompt', sessionId: 'h1-repo', cwd: repo, prompt: 'words-typed-in-repo', ts: Date.now() });
    await api(VPS, 'POST', '/event', { type: 'prompt', sessionId: 'h1-up', cwd: path.join(appA, 'up'), prompt: 'words-typed-through-link', ts: Date.now() });
    await api(VPS, 'POST', '/event', { type: 'prompt', sessionId: 'h1-app', cwd: appA, prompt: 'words-typed-in-app-a', ts: Date.now() });
    assert.ok(await waitFor(() => paired.text.includes('words-typed-in-app-a') && local.text.includes('words-typed-in-repo')), 'the chat of app-a is shown');
    assert.ok(!paired.text.includes('words-typed-in-repo'), 'no chat of /repo');
    assert.ok(!paired.text.includes('words-typed-through-link'), 'no chat of a folder that leads outside app-a');

    // A message from the paired page goes to a session in app-a, never to the one in /repo.
    const sent = await page('/message', { pageId: 'h1-page', text: 'message-from-app-a-page' });
    assert.strictEqual(sent.status, 200, sent.text);
    assert.deepStrictEqual((await api(VPS, 'GET', `/messages/take?cwd=${encodeURIComponent(repo)}`)).messages, []);
    assert.deepStrictEqual((await api(VPS, 'GET', `/messages/take?cwd=${encodeURIComponent(path.join(appA, 'up'))}`)).messages, []);
    assert.deepStrictEqual((await api(VPS, 'GET', `/messages/take?cwd=${encodeURIComponent(appA)}`)).messages.map((m) => m.text), ['message-from-app-a-page']);

    // The team board of /repo: not shown, not cleared.
    await api(VPS, 'POST', '/event', { type: 'subagent-start', sessionId: 'h1-repo', cwd: repo, agentId: 'agent-h1', agentType: 'helper', name: 'helper-in-repo' });
    assert.ok(await waitFor(() => local.text.includes('helper-in-repo')), 'the board of /repo has an entry');
    assert.strictEqual((await page('/board/clear', { pageId: 'h1-page', cwd: repo })).status, 403);
    assert.ok(!paired.text.includes('helper-in-repo'), 'no board of /repo');

    // Page control turned on in /repo: its key goes to /repo's own page only.
    const grant = await call(VPS, 'POST', '/drive/grant', { cwd: repo });
    assert.strictEqual(grant.status, 200, grant.text);
    assert.ok(await waitFor(() => local.text.includes('"type":"drive-grant"')), 'the page of /repo gets the key');
    assert.ok(!paired.text.includes('"type":"drive-grant"'), 'the paired page of app-a gets no key');
    await api(VPS, 'POST', '/drive/end', {});

    // A task in /repo (asked by the computer paired for /repo): no card, and no Stop from app-a's page.
    const started = await api(LAPTOP2, 'POST', '/remote/task', { op: 'start', prompt: 'task-prompt-in-repo' });
    assert.ok(started && started.task, JSON.stringify(started));
    assert.ok(await waitFor(() => local.text.includes('task-prompt-in-repo')), 'the page of /repo shows the task');
    assert.strictEqual((await page('/task/stop', { page: 'h1-page', task: started.task })).status, 404);
    assert.ok(!paired.text.includes('task-prompt-in-repo'), 'no task card of /repo');

    // Snapshot texts: a file of app-a, never one found through the folder link, nor .git/config.
    fs.mkdirSync(path.join(appA, '.git'));
    const instance = (await api(VPS, 'GET', '/summary')).instance;
    const snapOf = async (file) => {
      fs.writeFileSync(file, 'after\n');
      await api(VPS, 'POST', '/event', { type: 'change', sessionId: 'h1-app', cwd: appA, tool: 'Edit', file, relFile: path.relative(appA, file), before: 'before\n', after: 'after\n', kind: 'other' });
      const ev = (await api(VPS, 'GET', '/history')).filter((e) => e.type === 'change' && e.file === file).pop();
      assert.ok(ev && ev.snapshot, file);
      return request(port, 'GET', `${gk}/snapshot?id=${ev.snapshot}&instance=${instance}`, undefined, { origin });
    };
    assert.strictEqual((await snapOf(path.join(appA, 'own.txt'))).status, 200);
    assert.strictEqual((await snapOf(path.join(appA, 'up', 'outside.txt'))).status, 404, 'a file reached through a folder link');
    assert.strictEqual((await snapOf(path.join(appA, '.git', 'config'))).status, 404, 'an excluded file');
  } finally {
    paired.req.destroy();
    local.req.destroy();
    await api(VPS, 'POST', '/drive/end', {});
    await api(VPS, 'POST', '/pair/off', {});
  }
});

// M6: Undo after a merge put back only the files still as the merge left them, then forgot the rest:
// the next Undo said there was nothing to undo, and the task card lost its Undo button.
test('M6: Undo keeps the files it could not put back, and the next Undo puts them back', async () => {
  fs.writeFileSync(release, 'yes');
  const proj = path.join(base, 'm6-project');
  const projL2 = path.join(base, 'm6-laptop2');
  fs.mkdirSync(projL2);
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, '.gitignore'), '.claude/\n');
  fs.writeFileSync(path.join(proj, 'readme.txt'), 'start\n');
  git(proj, 'init', '-q', '-b', 'main');
  git(proj, 'config', 'user.email', 't@example.com');
  git(proj, 'config', 'user.name', 'T');
  git(proj, 'add', '-A');
  git(proj, 'commit', '-q', '-m', 'start');
  await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'm6-session', cwd: proj, execPath: exe, ts: Date.now() });
  const pair = await api(VPS, 'POST', '/pair', { cwd: proj });
  const joined = await api(LAPTOP2, 'POST', '/join', { address: `127.0.0.1:${VPS.pairPort}`, code: pair.code });
  assert.ok(joined.ok, JSON.stringify(joined));
  const name = joined.host.name;
  const page = stream(LAPTOP2.port, '/events?page=m6-page&root=' + encodeURIComponent(projL2));
  try {
    const task = (body) => api(LAPTOP2, 'POST', '/remote/task', { computer: name, localDir: projL2, ...body });
    const started = await task({ op: 'start', prompt: 'files m6a.html,m6b.html' });
    assert.ok(started && started.task, JSON.stringify(started));
    assert.ok(await waitFor(async () => (await task({ op: 'check', task: started.task })).state === 'idle', 30000), 'the task finished its turn');
    const merged = await task({ op: 'merge', task: started.task });
    assert.deepStrictEqual([...merged.applied].sort(), ['m6a.html', 'm6b.html'], JSON.stringify(merged));
    assert.ok((await api(LAPTOP2, 'POST', '/remote/task-applied', { task: started.task, computer: name, dir: projL2, how: 'merge', count: 2 })).ok);
    const fileA = path.join(proj, 'm6a.html');
    const asMerged = fs.readFileSync(fileA, 'utf8');
    fs.writeFileSync(fileA, 'changed by the user\n');
    const undo = () => request(LAPTOP2.port, 'POST', '/remote/task/undo-apply', { page: 'm6-page', task: started.task });
    const first = await undo();
    assert.strictEqual(first.status, 200, first.text);
    assert.deepStrictEqual(first.json.undone, ['m6b.html']);
    assert.deepStrictEqual(first.json.kept.map((k) => k.path), ['m6a.html']);
    assert.strictEqual(first.json.partial, true, 'a partial result says so');
    // The user's change is removed again: the next Undo puts that file back too.
    fs.writeFileSync(fileA, asMerged);
    const second = await undo();
    assert.strictEqual(second.status, 200, second.text);
    assert.deepStrictEqual(second.json.undone, ['m6a.html']);
    assert.ok(!fs.existsSync(fileA) && !fs.existsSync(path.join(proj, 'm6b.html')), 'both merged files are removed');
    assert.strictEqual((await undo()).status, 409, 'then there is nothing left to undo');
  } finally {
    page.req.destroy();
    await api(VPS, 'POST', '/pair/off', {});
  }
});

// M8 (server part): a snapshot id with no server start (saved by 0.24.43) is refused, as one from
// another start is: after a restart the same number can be another file's snapshot.
test('M8: GET /snapshot needs the server start the id came from', async () => {
  const file = path.join(projV, 'm8.txt');
  fs.writeFileSync(file, 'after\n');
  await api(VPS, 'POST', '/event', { type: 'change', sessionId: 'm8-session', cwd: projV, tool: 'Edit', file, relFile: 'm8.txt', before: 'before\n', after: 'after\n', kind: 'other' });
  const ev = (await api(VPS, 'GET', '/history')).filter((e) => e.type === 'change' && e.file === file).pop();
  assert.ok(ev && ev.snapshot, 'the edit has a snapshot');
  const instance = (await api(VPS, 'GET', '/summary')).instance;
  const get = (q) => request(VPS.port, 'GET', `/snapshot?${q}`);
  assert.strictEqual((await get(`id=${ev.snapshot}&instance=${instance}`)).status, 200);
  assert.strictEqual((await get(`id=${ev.snapshot}`)).status, 404, 'no server start: refused');
  assert.strictEqual((await get(`id=${ev.snapshot}&instance=${'0'.repeat(16)}`)).status, 404, 'another server start: refused');
});

// L3: Allow and the less strict modes happen in the EditLens window, so the messages name it.
test('L3: page control messages about Allow and Bypass name the EditLens window', async () => {
  const { Driver } = require('../server/driver');
  const d = new Driver({ emit: () => {}, log: () => {}, stateDir: os.tmpdir() });
  d.run = { agentModes: new Map(), query: { setPermissionMode: async () => {} }, permissions: new Map() };
  for (const out of [d.setAgentMode('agent-1', 'bypassPermissions'), await d.setMode('bypassPermissions')]) {
    assert.match(out.error, /in the EditLens window/, out.error);
  }
  d.run = null;
  const src = fs.readFileSync(path.join(ROOT, 'server', 'driver.js'), 'utf8');
  assert.match(src, /Nobody answered the permission question in the EditLens window in 10 minutes\./);
  assert.doesNotMatch(src, /permission question on the page|confirmation in the panel/);
});

// G1 (settings check): page control's own Claude (or a task's) reports its plugin defaults with its
// session events. Those never replace the user's settings.
test('G1: settings in events from page control\'s own session are ignored', async () => {
  fs.writeFileSync(release, 'yes');
  const values = async () => (await api(VPS, 'GET', '/settings')).values;
  assert.strictEqual((await api(VPS, 'POST', '/settings/report', { values: { tasks_at_once: 2, effort: 'Low' } })).values.tasks_at_once, 2);
  const local = stream(VPS.port, '/events?page=g1-local&root=' + encodeURIComponent(projV));
  try {
    assert.ok(await waitFor(() => local.text.includes('"type":"hello"')));
    const grant = await call(VPS, 'POST', '/drive/grant', { cwd: projV });
    assert.strictEqual(grant.status, 200, grant.text);
    const own = (await api(VPS, 'GET', `/summary?cwd=${encodeURIComponent(projV)}`));
    assert.strictEqual(own.control, 'page');
    // The stand-in SDK's session id (test/fixtures/fake-sdk.mjs).
    const sessionId = '11111111-2222-3333-4444-555555555555';
    await api(VPS, 'POST', '/event', { type: 'session', sessionId, cwd: projV, settings: { tasks_at_once: 4, effort: 'High' }, ts: Date.now() });
    const after = await values();
    assert.strictEqual(after.tasks_at_once, 2, JSON.stringify(after));
    assert.strictEqual(after.effort, 'Low');
    // The user's own session still reports them.
    await api(VPS, 'POST', '/event', { type: 'session', sessionId: 'g1-user-session', cwd: projV, settings: { tasks_at_once: 3, effort: 'Low' }, ts: Date.now() });
    assert.strictEqual((await values()).tasks_at_once, 3);
  } finally {
    local.req.destroy();
    await api(VPS, 'POST', '/drive/end', {});
    await api(VPS, 'POST', '/settings/report', { values: {} });
  }
});

// G3 and tool names (settings check): the EditLens window says what a plan approval, a question
// and an MCP tool are, in words, not as a raw tool name and its input.
test('G3: permission cards for a plan, a question and MCP tools read as plain words', () => {
  const { describeTool } = require('../server/driver');
  const plan = describeTool('ExitPlanMode', { plan: '1. Add a button\n2. Test it' });
  assert.strictEqual(plan.title, 'Approve Claude\'s plan');
  assert.strictEqual(plan.detail, '1. Add a button\n2. Test it');
  const q = describeTool('AskUserQuestion', { questions: [{ question: 'Which color?', header: 'Color', multiSelect: false,
    options: [{ label: 'Blue', description: 'Calm' }, { label: 'Red', description: 'Bold' }] }] });
  assert.strictEqual(q.title, 'Answer Claude\'s question');
  assert.match(q.detail, /Which color\?\n {2}• Blue: Calm\n {2}• Red: Bold/);
  assert.strictEqual(describeTool('mcp__plugin_editlens_live-page__list_live_pages', {}).title, 'List live pages');
  assert.strictEqual(describeTool('mcp__live-page__show_code', { file: 'a.js' }).title, 'Show code');
  assert.strictEqual(describeTool('mcp__github__create_issue', { title: 'x' }).title, 'Use create_issue (github)');
  assert.strictEqual(describeTool('mcp__plugin_tools_search__find', {}).title, 'Use find (search)');
  assert.strictEqual(describeTool('Glob', { pattern: '*.js' }).title, 'Use Glob');
});

// Same as Sol M1, for the page control key: a key of the same length in characters but not in
// bytes (not ASCII) is refused, not an error.
test('M1 (drive key): a non-ASCII key of the same length is refused', async () => {
  fs.writeFileSync(release, 'yes');
  const local = stream(VPS.port, '/events?page=m1-local&root=' + encodeURIComponent(projV));
  try {
    assert.ok(await waitFor(() => local.text.includes('"type":"hello"')));
    assert.strictEqual((await call(VPS, 'POST', '/drive/grant', { cwd: projV })).status, 200);
    assert.ok(await waitFor(() => /"type":"drive-grant","key":"[0-9a-f]+"/.test(local.text)));
    const key = /"type":"drive-grant","key":"([0-9a-f]+)"/.exec(local.text)[1];
    const r = await request(VPS.port, 'POST', '/drive/interrupt', { key: 'é'.repeat(key.length), pageId: 'm1-local' });
    assert.strictEqual(r.status, 403, r.text);
    assert.strictEqual((await request(VPS.port, 'GET', '/health')).status, 200, 'the server still answers');
  } finally {
    local.req.destroy();
    await api(VPS, 'POST', '/drive/end', {});
  }
});
