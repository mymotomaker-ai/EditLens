'use strict';
require('./isolate');
// First-time setup problems found in a test project: Claude's page list, EditLens's own address
// pointing to the project's page, unknown paths, the /editlens command where the mod doesn't run,
// and page control continuing its conversation after a restart. Uses the stand-in SDK and claude.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-setup-'));
const state = path.join(dir, 'state');
fs.mkdirSync(state);
fs.writeFileSync(path.join(state, 'signed-in'), 'yes');
const sdk = path.join(dir, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
const bin = path.join(dir, 'bin');
fs.mkdirSync(bin);
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), path.join(bin, 'claude'));
const exe = path.join(bin, 'claude');
const claudeDir = path.join(dir, 'claude-config');
const SESSION = '11111111-2222-3333-4444-555555555555'; // the stand-in SDK's session id
Object.assign(process.env, {
  EDITLENS_STATE_DIR: path.join(dir, 'live'),
  EDITLENS_PORT: '4358',
  EDITLENS_SDK_DIR: path.join(dir, 'sdk'),
  FAKE_CLAUDE_STATE: state,
  CLAUDE_CONFIG_DIR: claudeDir,
});
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { ensureServer, stopServer, postJson, getJson } = require('../lib/client');
const config = require('../lib/config');

const proj = path.join(dir, 'proj');
fs.mkdirSync(proj);

const err = (p) => p.then((r) => r, (e) => {
  const m = /server answered (\d+): (.*)$/s.exec(String(e.message));
  return m ? { status: Number(m[1]), ...JSON.parse(m[2]) } : { error: e.message };
});
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
};

// An open page: reads the stream until the hello arrives. -> { hello, close }
async function openPage(id, root, origin) {
  const ctl = new AbortController();
  const q = new URLSearchParams({ page: id, url: `${origin}/` });
  if (root) q.set('root', root);
  const res = await fetch(`${config.baseUrl}/events?${q}`, { signal: ctl.signal, headers: { origin } });
  const reader = res.body.getReader();
  let text = '';
  while (!/"type":"hello"[^\n]*\n/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString('utf8');
  }
  const line = text.split('\n').find((l) => l.includes('"type":"hello"'));
  return { hello: JSON.parse(line.slice(line.indexOf('{'))), close: () => ctl.abort() };
}

test('the page list, the home page and unknown paths', async (t) => {
  await ensureServer();
  const open = [];
  t.after(async () => {
    for (const p of open) p.close();
    await stopServer();
  });
  const html = (p) => fetch(config.baseUrl + p, { headers: { accept: 'text/html' } }).then(async (r) => ({ status: r.status, text: await r.text() }));

  let home = await html('/');
  assert.strictEqual(home.status, 200);
  assert.match(home.text, /not your app/);
  assert.match(home.text, /run <code>\/editlens<\/code>/);
  assert.doesNotMatch(home.text, /live\.js/, 'no panel on EditLens\'s own address');
  assert.deepStrictEqual(await getJson('/pages/live'), []);

  open.push(await openPage('p1', proj, 'http://127.0.0.1:5173'));
  assert.ok(await until(async () => (await getJson('/pages/live')).length === 1), 'Claude sees the page');
  home = await html('/');
  assert.match(home.text, /href="http:\/\/127\.0\.0\.1:5173"/, 'links to the project\'s page');
  const unknown = await html('/index.html');
  assert.strictEqual(unknown.status, 404);
  assert.match(unknown.text, /nothing at \/index\.html here/);
  assert.match(unknown.text, /href="http:\/\/127\.0\.0\.1:5173"/);

  // A page that names no project is told where the project's page is.
  const bare = await openPage('p2', null, 'http://localhost:8080');
  open.push(bare);
  assert.deepStrictEqual(bare.hello.projects.map((p) => p.url), ['http://127.0.0.1:5173']);

  // A script still gets 401 without its key (only a browser asking for a page gets the home page).
  const api = await fetch(`${config.baseUrl}/messages/take`);
  assert.strictEqual(api.status, 401);
});

test('page control continues its earlier conversation after a restart', async (t) => {
  await ensureServer();
  let page = null;
  t.after(async () => {
    if (page) page.close();
    await stopServer();
  });
  page = await openPage('pc', proj, 'http://127.0.0.1:5173');
  const first = await err(postJson('/drive/grant', { cwd: proj, claudePath: exe, fresh: true }, { timeoutMs: 20000 }));
  assert.ok(first.ok, JSON.stringify(first));
  assert.ok(await until(() => fs.existsSync(path.join(config.stateDir, 'page-control-last.json'))), 'remembered');
  await postJson('/drive/end', {});
  await until(async () => (await getJson(`/summary?cwd=${encodeURIComponent(proj)}`)).control !== 'page');

  // Its transcript is gone: a new conversation, as before.
  const fresh = await err(postJson('/drive/grant', { cwd: proj, claudePath: exe, auto: true, waiter: 'c'.repeat(16) }, { timeoutMs: 20000 }));
  assert.ok(fresh.ok && !fresh.continued, JSON.stringify(fresh));
  await postJson('/drive/end', {});
  await until(async () => (await getJson(`/summary?cwd=${encodeURIComponent(proj)}`)).control !== 'page');

  // Its transcript is there: turned on by itself, it continues with that conversation.
  fs.mkdirSync(path.join(claudeDir, 'projects', '-proj'), { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'projects', '-proj', `${SESSION}.jsonl`), '{}\n');
  const again = await err(postJson('/drive/grant', { cwd: proj, claudePath: exe, auto: true, waiter: 'd'.repeat(16) }, { timeoutMs: 20000 }));
  assert.ok(again.ok && again.continued && again.from === SESSION, JSON.stringify(again));
  const queries = fs.readFileSync(path.join(state, 'queries'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(queries[queries.length - 1].resume, SESSION);
  await postJson('/drive/end', {});
  await until(async () => (await getJson(`/summary?cwd=${encodeURIComponent(proj)}`)).control !== 'page');
});

test('/editlens runs by itself where the mod does not (the desktop app)', () => {
  const runner = fs.readFileSync(path.join(__dirname, '..', 'skills', 'editlens', 'SKILL.md'), 'utf8');
  assert.match(runner, /^---\nname: editlens\n/);
  assert.match(runner, /\ndisable-model-invocation: true\n/, 'only the user starts it');
  assert.match(runner, /node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/bin\/start\.js" \$ARGUMENTS/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'bin', 'start.js')));
  const { listCommands } = require('../lib/commands');
  const list = listCommands({ projectDir: dir, pluginRoot: path.join(__dirname, '..'), pluginName: 'editlens', claudeDir });
  const cmd = list.find((c) => /(^|:)editlens$/.test(c.name));
  assert.ok(cmd && cmd.runnable === false, 'a page can\'t have Claude run it');
});
