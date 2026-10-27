'use strict';
require('./isolate');
// The command check of 0.24.39 (claude-live-mode-review/commands-check-0.24.39.md): each finding
// as it happened, through bin/start.js as Claude Code runs it, against a real server, the stand-in
// SDK and claude, and no browser. Pairing cases are in test/pair-commands.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { execFile } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-cmdcheck-'));
const PORT = 5261;
const fake = path.join(dir, 'fake');
Object.assign(process.env, { EDITLENS_STATE_DIR: path.join(dir, 'live'), EDITLENS_PORT: String(PORT), EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state') });
const { ensureServer, stopServer, health, postJson, getJson, postEvent } = require('../lib/client');
const config = require('../lib/config');

const sdk = path.join(fake, 'sdk', 'node_modules', '@anthropic-ai', 'claude-agent-sdk');
fs.mkdirSync(sdk, { recursive: true });
fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-sdk.mjs'), path.join(sdk, 'sdk.mjs'));
fs.mkdirSync(path.join(fake, 'state'));
fs.writeFileSync(path.join(fake, 'state', 'signed-in'), 'yes');
// Named claude, as findClaude accepts only that name; else it looks on PATH (no claude on CI).
const exe = path.join(fake, 'bin', 'claude');
fs.mkdirSync(path.dirname(exe));
fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-claude.js'), exe);
const queries = () => {
  const f = path.join(fake, 'state', 'queries');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const ON = 'Connect and turn on page control';
const MANUAL = 'Connect the page';
// A project folder with a page EditLens serves.
function project(name) {
  const p = path.join(dir, name);
  fs.mkdirSync(p, { recursive: true });
  fs.writeFileSync(path.join(p, 'index.html'), `<h1>${name}</h1>\n`);
  return p;
}
// /editlens as Claude Code runs it, with no browser here (a VPS through SSH).
function editlens(cwd, args, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE_PLUGIN_OPTION_|^EDITLENS_(DRIVEN|NO_START|TYPED)$/.test(k)));
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js'), ...args], {
      cwd, timeout: 60000,
      env: { ...clean, CLAUDE_PROJECT_DIR: cwd, EDITLENS_NO_BROWSER: '1', EDITLENS_SDK_DIR: path.join(fake, 'sdk'), FAKE_CLAUDE_STATE: path.join(fake, 'state'),
        CLAUDE_CODE_EXECPATH: exe, CLAUDE_PLUGIN_OPTION_START: MANUAL, ...env },
    }, (err, stdout) => (err && err.killed ? reject(err) : resolve({ out: stdout, code: err ? err.code : 0 })));
  });
}
function get(url) {
  return new Promise((resolve) => {
    http.get(url, { agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', (err) => resolve({ status: 0, body: err.code }));
  });
}
// A page's event stream; frames collects its events.
const streams = new Set();
function openPage(id, root) {
  const frames = [];
  const req = http.get({ host: '127.0.0.1', port: PORT, agent: false, path: `/events?page=${id}&root=${encodeURIComponent(root)}` }, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        buf = buf.slice(i + 2);
        if (!data) continue;
        try {
          frames.push(JSON.parse(data.slice(6)));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    });
  });
  req.on('error', (err) => {
    if (err.code !== 'ECONNRESET') throw err;
  });
  const page = { frames, close: () => req.destroy(), grants: () => frames.filter((f) => f.type === 'drive-grant') };
  streams.add(page);
  return page;
}
async function until(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
const control = async (cwd) => (await getJson(`/summary?cwd=${encodeURIComponent(cwd)}`)).control;
// The session the stand-in SDK reports for page control (test/fixtures/fake-sdk.mjs).
const FAKE_SESSION = '11111111-2222-3333-4444-555555555555';

test.after(async () => {
  for (const s of streams) s.close();
  await stopServer();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('H1: /editlens restart connects every page /editlens connected, at the same address', async () => {
  await stopServer();
  const a = project('h1-static');
  const b = project('h1-proxy');
  const site = http.createServer((req, res) => res.end('<h1>dev server</h1>'));
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  try {
    assert.match((await editlens(a, [])).out, /connected/);
    assert.match((await editlens(b, [String(site.address().port)])).out, /connected/);
    const before = await getJson('/connections');
    const urlA = before.find((c) => c.cwd === a).url;
    const urlB = before.find((c) => c.cwd === b).url;
    assert.strictEqual((await get(urlA)).status, 200);
    const r = await editlens(a, ['restart']);
    assert.match(r.out, /restarted/);
    assert.strictEqual((await get(urlA)).status, 200, 'the static page still answers');
    assert.match((await get(urlB)).body, /dev server/, 'the dev server page still answers');
    const after = await getJson('/connections');
    assert.deepStrictEqual(after.map((c) => [c.cwd, c.url, c.target]).sort(), before.map((c) => [c.cwd, c.url, c.target]).sort());
    assert.match((await editlens(a, ['status'])).out, /connected/);
    assert.doesNotMatch((await editlens(a, ['status'])).out, /not connected/);
  } finally {
    site.close();
  }
});

// R3 (0.24.40): a Vite server EditLens runs keeps its address too. The stand-in Vite takes a moment
// to close, as Vite does, so the next one would otherwise find the port taken and use the next.
// Its address says localhost, as Vite's does: it is read at the address it listens on (Node 18
// tries only the first address of localhost, ::1 on some computers).
async function viteRestart(name, host) {
  await stopServer();
  const v = project(name);
  fs.writeFileSync(path.join(v, 'package.json'), JSON.stringify({ devDependencies: { vite: '5.0.0' } }));
  fs.mkdirSync(path.join(v, 'node_modules', 'vite', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(v, 'node_modules', 'vite', 'package.json'), JSON.stringify({ name: 'vite', bin: { vite: 'bin/vite.js' } }));
  fs.copyFileSync(path.join(__dirname, 'fixtures', 'fake-vite.js'), path.join(v, 'node_modules', 'vite', 'bin', 'vite.js'));
  process.env.FAKE_VITE_PORT = '5267';
  process.env.FAKE_VITE_HOST = host;
  try {
    assert.match((await editlens(v, [])).out, /connected/);
    const before = (await getJson('/connections')).find((c) => c.cwd === v);
    assert.strictEqual(before.kind, 'vite');
    const r = await editlens(v, ['restart']);
    assert.match(r.out, /at the same address/);
    const after = (await getJson('/connections')).find((c) => c.cwd === v);
    assert.strictEqual(after && after.url, before.url, r.out);
    assert.match((await get(after.url.replace('localhost', host.includes(':') ? `[${host}]` : host))).body, /vite on 5267/);
  } finally {
    delete process.env.FAKE_VITE_PORT;
    delete process.env.FAKE_VITE_HOST;
    await stopServer();
  }
}

test('R3: /editlens restart starts Vite again at the same address', () => viteRestart('r3-vite', '127.0.0.1'));

// Vite listens on localhost: on computers where that is ::1 (Windows, most Linux), the wait for its
// port checks ::1 as well. Skipped where this computer has no IPv6 loopback.
test('R3: the same address when Vite listens on ::1', async (t) => {
  const v6 = await new Promise((resolve) => {
    const s = net.createServer().on('error', () => resolve(false)).listen(0, '::1', () => s.close(() => resolve(true)));
  });
  if (!v6) return t.skip('no IPv6 loopback here');
  return viteRestart('r3-vite6', '::1');
});

// L3 (0.24.40): two /editlens at the same time outside the terminal mod (the skill) open the page once.
test('L3: two /editlens at the same time open the page once', async () => {
  await ensureServer();
  const p = project('l3');
  const bin = path.join(dir, 'l3-browser');
  const log = path.join(dir, 'l3-opened');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'xdg-open'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, process.argv[2] + '\\n');\n`);
  fs.chmodSync(path.join(bin, 'xdg-open'), 0o755);
  const desk = { EDITLENS_NO_BROWSER: '', SSH_CONNECTION: '', SSH_CLIENT: '', SSH_TTY: '', DISPLAY: ':0', PATH: `${bin}${path.delimiter}${process.env.PATH}`, EDITLENS_TYPED: '1' };
  const both = await Promise.all([editlens(p, [], desk), editlens(p, [], desk)]);
  for (const r of both) assert.match(r.out, /connected/);
  await new Promise((r) => setTimeout(r, 500));
  const opened = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.strictEqual(opened.length, 1, opened.join(', '));
  // Later, once that tab is closed, /editlens opens it again.
  fs.rmSync(log);
  assert.match((await editlens(p, [], { ...desk, EDITLENS_OPEN_AGAIN_MS: '0' })).out, /opened in your browser/);
  assert.ok(await until(() => fs.existsSync(log)), 'opened again');
});

test('L4: /editlens restart with nothing running says it started', async () => {
  await stopServer();
  const r = await editlens(project('l4'), ['restart']);
  assert.match(r.out, /started/);
  assert.doesNotMatch(r.out, /restarted/);
  assert.match(r.out, /connected/);
});

test('H2: with no browser, page control starts when the page opens later', async () => {
  await ensureServer();
  const p = project('h2');
  // The session start asked for it, then the user typed /editlens: it must still happen.
  assert.ok((await postJson('/drive/auto', { cwd: p, claudePath: exe, sessionId: 's-h2' })).ok);
  const first = (await editlens(p, [], { CLAUDE_PLUGIN_OPTION_START: ON })).out;
  assert.match(first, /page control starts when your page is open/);
  // R2 (0.24.40): no "Then /editlens control" step: it starts by itself.
  assert.doesNotMatch(first, /Then\s+\/editlens control/);
  const page = openPage('h2-page', p);
  assert.ok(await until(() => page.grants().length > 0), 'page control started when the page opened');
  page.close();
  await postJson('/drive/end', {});
  // /editlens control alone (no waiter from the session start).
  const q = project('h2b');
  const typed = (await editlens(q, ['control'])).out;
  assert.match(typed, /page control starts when your page is open/);
  assert.doesNotMatch(typed, /Then\s+\/editlens control/);
  const page2 = openPage('h2b-page', q);
  assert.ok(await until(() => page2.grants().length > 0), '/editlens control: on when the page opened');
  page2.close();
  await postJson('/drive/end', {});
});

test('M2, L1, L9: control while on: "already on"; control new starts a new chat', async () => {
  await ensureServer();
  const p = project('m2');
  await editlens(p, []);
  const page = openPage('m2-page', p);
  assert.ok(await until(async () => (await getJson('/pages/live')).some((x) => x.id === 'm2-page')));
  assert.match((await editlens(p, ['control'])).out, /● Page control/);
  assert.strictEqual(await control(p), 'page');
  // L1: typed again while on.
  const again = await editlens(p, ['control']);
  assert.match(again.out, /already on/);
  assert.doesNotMatch(again.out, /a new chat/);
  // L9: the id of page control's own session.
  const same = await editlens(p, ['control', FAKE_SESSION]);
  assert.strictEqual(same.code, 0, same.out);
  assert.match(same.out, /already on/);
  // control new while a new chat with nothing sent in it runs: that one is kept (two asks at the same time
  // start one Claude).
  let n = queries().length;
  assert.match((await editlens(p, ['control', 'new'])).out, /already on/);
  assert.strictEqual(queries().length, n, 'not started again');
  // M2: another conversation asked for while on: it starts again in that one.
  const OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.doesNotMatch((await editlens(p, ['control', OTHER])).out, /already on/);
  assert.ok(await until(() => queries().length > n), 'Claude started again');
  assert.strictEqual(queries().pop().resume, OTHER);
  // M2: control new while a conversation is continued: a new chat starts.
  n = queries().length;
  const fresh = await editlens(p, ['control', 'new']);
  assert.match(fresh.out, /a new chat/);
  assert.ok(await until(() => queries().length > n), 'Claude started again');
  assert.strictEqual(queries().pop().resume, null, 'with no conversation to continue');
  page.close();
  await postJson('/drive/end', {});
});

// D5 (the user's choice, option A): stop also ends page control in that project; the chat is
// kept for claude --resume. Page control in another project keeps running.
test('M6, D5: /editlens stop ends page control in that project only, and names no dev server for a served folder', async () => {
  await ensureServer();
  const p = project('m6');
  const other = project('m6-other');
  await editlens(p, []);
  const page = openPage('m6-page', p);
  assert.ok(await until(async () => (await getJson('/pages/live')).some((x) => x.id === 'm6-page')));
  assert.match((await editlens(p, ['control'])).out, /● Page control/);
  // stop in another project: this one's page control stays.
  const elsewhere = await editlens(other, ['stop']);
  assert.doesNotMatch(elsewhere.out, /Page control/);
  const control = async () => (await getJson(`/summary?cwd=${encodeURIComponent(p)}`)).control;
  assert.strictEqual(await control(), 'page');
  const r = await editlens(p, ['stop']);
  assert.match(r.out, /disconnected/);
  assert.doesNotMatch(r.out, /dev server/);
  assert.match(r.out, /Page control ended/);
  assert.match(r.out, /claude --resume/);
  assert.doesNotMatch(r.out, /\/editlens manual/);
  assert.notStrictEqual(await control(), 'page');
  page.close();
});

test('M3, M4: undo N acts on this session\'s edits only; a second undo says it is already undone', async () => {
  await ensureServer();
  const p = project('m3');
  const file = path.join(p, 'app.js');
  let text = '1\n2\n3\n';
  fs.writeFileSync(file, text);
  const edit = async (next, sessionId) => {
    const before = text;
    text = next;
    fs.writeFileSync(file, text);
    await postEvent({ type: 'change', sessionId, cwd: p, tool: 'Edit', file, relFile: 'app.js', before, after: text, kind: 'frontend', intent: 'x', stats: { added: 1, removed: 1 } });
  };
  await edit('ONE\n2\n3\n', 'sess-a');
  await edit('ONE\n2\nTHREE\n', 'sess-b');
  const other = await editlens(p, ['undo', '1'], { CLAUDE_CODE_SESSION_ID: 'sess-b' });
  assert.notStrictEqual(other.code, 0);
  assert.match(other.out, /another session/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'ONE\n2\nTHREE\n', 'the other session\'s edit stays');
  const mine = await editlens(p, ['undo', '1'], { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  assert.strictEqual(mine.code, 0, mine.out);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '1\n2\nTHREE\n');
  const twice = await editlens(p, ['undo', '1'], { CLAUDE_CODE_SESSION_ID: 'sess-a' });
  assert.match(twice.out, /Edit 1 is already undone/);
  assert.match(twice.out, /\/editlens undo 1 back/);
  assert.doesNotMatch(twice.out, /only Claude can undo/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '1\n2\nTHREE\n');
  // Put back, then undone again: allowed again.
  assert.strictEqual((await editlens(p, ['undo', '1', 'back'], { CLAUDE_CODE_SESSION_ID: 'sess-a' })).code, 0);
  assert.strictEqual((await editlens(p, ['undo', '1'], { CLAUDE_CODE_SESSION_ID: 'sess-a' })).code, 0);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '1\n2\nTHREE\n');
});

test('L2: in a task\'s copy, the fix line says where /editlens works', async () => {
  await ensureServer();
  const p = project('l2');
  const copy = path.join(p, '.claude', 'worktrees', 'editlens-task-abc123');
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'index.html'), '<h1>copy</h1>\n');
  const page = openPage('l2-page', copy);
  assert.ok(await until(async () => (await getJson('/pages/live')).some((x) => x.id === 'l2-page')));
  const r = await editlens(copy, ['control']);
  assert.match(r.out, /EditLens started this session/);
  assert.doesNotMatch(r.out, /try again/);
  assert.match(r.out, /your own project folder/);
  page.close();
});

test('L5, L6: words a command does not take are refused with its help line', async () => {
  const p = project('l5');
  const bare = await editlens(p, ['localhost']);
  assert.notStrictEqual(bare.code, 0);
  assert.match(bare.out, /give the port/i);
  // R5 (0.24.40): out of range says the same as too short or too long.
  for (const n of ['0', '5', '99999', '123456', 'localhost:99999', 'http://127.0.0.1:70000/']) {
    const r = await editlens(p, [n]);
    assert.notStrictEqual(r.code, 0);
    assert.ok(r.out.includes(`"${n}" isn't a port`), r.out);
  }
  for (const [args, cmd] of [[['control', 'new', 'extra'], '/editlens control'], [['pair', 'bogus'], '/editlens pair'], [['task-user', 'bogus'], '/editlens task-user'], [['stop', 'remove', 'extra'], '/editlens stop']]) {
    const r = await editlens(p, args);
    assert.notStrictEqual(r.code, 0, args.join(' '));
    assert.match(r.out, /isn't a word|isn't something/, args.join(' '));
    assert.ok(r.out.includes(cmd), args.join(' ') + ': ' + r.out);
    assert.doesNotMatch(r.out, /Stopped|No session here is named|not needed|Pair another computer/, args.join(' '));
  }
});

test('L8: a busy older server is named, with how to replace it', () => {
  const { olderNote } = require('../lib/versions');
  assert.deepStrictEqual(olderNote({ version: '0.24.36' }, '0.24.40'), ['EditLens 0.24.36 is running', '/editlens restart for 0.24.40']);
  assert.strictEqual(olderNote({ version: '0.24.40' }, '0.24.40'), null);
  assert.strictEqual(olderNote({ version: '0.25.0' }, '0.24.40'), null, 'a newer one');
  for (const bad of [null, {}, { version: 5 }, { version: 'x' }]) assert.strictEqual(olderNote(bad, '0.24.40'), null);
});

test('L10: a one-line change is "Changed 1 line"', () => {
  const { describeChange } = require('../hooks/live-hook');
  const none = { selectors: [], ids: [], texts: [], classes: [] };
  assert.strictEqual(describeChange('Edit', none, { added: 1, removed: 1 }, false), 'Changed 1 line');
  assert.strictEqual(describeChange('Edit', none, { added: 3, removed: 2 }, false), 'Changed 3 lines');
  assert.strictEqual(describeChange('Edit', none, { added: 2, removed: 0 }, false), 'Added 2 lines');
  assert.strictEqual(describeChange('Edit', none, { added: 0, removed: 1 }, false), 'Removed 1 line');
});

test('the port this file uses is its own', () => {
  assert.strictEqual(config.port, PORT);
  return health();
});
