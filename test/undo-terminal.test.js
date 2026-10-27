'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4950';
// "Undo only this edit" in the terminal (handoff 10.2): /editlens undo [N [back]] and
// /editlens restore N [back] through bin/start.js -> bin/undo.js, against a stub live server on
// port 4948 (4949 stays unused for "server down"). The mod's pane is in test/mod.test.ts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 4948;
const DOWN_PORT = 4949;
const KEY = 'hook-key-undo-test';
const { parseArgs } = require('../bin/undo');
const { parse, MARK } = require('../lib/say');
const mod = () => import(path.join(ROOT, 'hooks', 'mod.mjs'));

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-'));
fs.writeFileSync(path.join(state, `token-${PORT}`), KEY + '\n');
fs.writeFileSync(path.join(state, `token-${DOWN_PORT}`), KEY + '\n');

// What the stub answers next, by route; and every request it got.
const seen = [];
let answers = {};
let server;

test.before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: req.headers['x-editlens-token'], body: body ? JSON.parse(body) : null });
      if (req.headers['x-editlens-token'] !== KEY) {
        res.writeHead(401);
        return res.end('bad token');
      }
      const a = answers[`${req.method} ${url.pathname}`] || [404, { ok: false, error: 'not found' }];
      res.writeHead(a[0], { 'content-type': 'application/json' });
      return res.end(typeof a[1] === 'string' ? a[1] : JSON.stringify(a[1]));
    });
  });
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

test.after(() => {
  server.close();
  fs.rmSync(state, { recursive: true, force: true });
});

// Runs /editlens <args> the way the skill route does (plain text), or as the mod does (records).
function run(args, { port = PORT, records = false, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], {
      env: { ...process.env, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: state, EDITLENS_SAY: records ? 'records' : '', CLAUDE_PROJECT_DIR: '/work/app', CLAUDE_CODE_SESSION_ID: 'sess-1', EDITLENS_SESSION_ID: '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('N is a whole number from 1, digits only; only "back" may follow it', () => {
  assert.deepStrictEqual(parseArgs(['undo']), { cmd: 'list', word: 'undo' });
  assert.deepStrictEqual(parseArgs(['restore']), { cmd: 'list', word: 'restore' });
  assert.deepStrictEqual(parseArgs(['undo', '3']), { cmd: 'undo', n: 3, back: false });
  assert.deepStrictEqual(parseArgs(['UNDO', '12', 'BACK']), { cmd: 'undo', n: 12, back: true });
  assert.deepStrictEqual(parseArgs(['restore', '7', 'back']), { cmd: 'restore', n: 7, back: true });
  for (const bad of ['0', '-1', '3.0', '3.5', '1e3', '0x10', '03', 'three', 'NaN', 'Infinity', '1000000', '9999999999999999999', '', ' ']) {
    const p = parseArgs(['undo', bad, ...(bad.trim() ? [] : ['x'])]);
    assert.ok(p.error, `"${bad}" is refused`);
    assert.notStrictEqual(p.n, NaN);
  }
  assert.strictEqual(parseArgs(['undo', '3', 'now']).error, 'extra');
  assert.strictEqual(parseArgs(['undo', '3', 'back', 'back']).error, 'extra');
  assert.strictEqual(parseArgs(['undo', 'back', '3']).error, 'bad-n');
  assert.strictEqual(parseArgs(['undo', '\u001b[31m4']).word, '[31m4', 'control characters are not printed back');
});

test('/editlens undo lists this session\'s edits as the page\'s Changes row: N  file  folder/ ····· counts, then who, time and reason', async () => {
  const at = new Date(2026, 9, 9, 14, 52).getTime();
  answers = { 'GET /edits/recent': [200, { edits: [
    { n: 12, seq: 40, file: 'src/App.jsx', reason: 'Add the header', time: at, canUndo: true, canRestore: true, kind: 'frontend', added: 2, removed: 1, created: false, agentId: null },
    { n: 3, seq: 9, file: 'src/a.js', reason: 'Line one\nline two', time: 'soon', canUndo: false, canRestore: false, kind: 'other', added: 'x', agentId: 'a1', agentType: 'Explore' },
    { n: 7, seq: 20, file: 'essays/design/03.md', reason: 'New essay', time: at, canUndo: true, canRestore: true, added: 120, removed: 0, created: true },
    { n: 'x', file: 'bad.js' }, { n: 2.5, file: 'bad.js' }, null,
  ] }] };
  seen.length = 0;
  const { code, stdout } = await run(['undo']);
  assert.strictEqual(code, 0, stdout);
  assert.deepStrictEqual(seen.map((s) => [s.method, s.path, s.key, s.query.session, s.query.cwd]), [['GET', '/edits/recent', KEY, 'sess-1', '/work/app']]);
  const lines = stdout.split('\n');
  assert.strictEqual(lines[0], '✦ Recent edits  · this session');
  // Line 1: the file name, its folder, a dotted line to the counts; line 2: who, the time, the reason.
  const at12 = lines.findIndex((l) => /^12  App\.jsx  src\/ ·+ \+2 −1$/.test(l));
  assert.ok(at12 > 0, stdout);
  assert.match(lines[at12 + 1], /^ {4}Main · (14:52|\w{3} 14:52|Oct 9) · Add the header$/);
  // Unknown counts: no dots, no "0 lines"; a two-line reason becomes one line; a time that is not a
  // number is left out.
  const at3 = lines.indexOf('3   a.js  src/');
  assert.ok(at3 > 0, stdout);
  // (cut with "…" to fit 76 cells)
  assert.strictEqual(lines[at3 + 1], "    Subagent · Explore · can't be undone here · lines not known yet · Line …");
  assert.ok(lines.some((l) => /^7   03\.md  essays\/design\/ ·+ New · \+120$/.test(l)), stdout);
  assert.doesNotMatch(stdout, /bad\.js|NaN|undefined|null|0 lines/);
  // The counts column starts in one place.
  const rows = lines.filter((l) => /^\d+ +.* ·+ /.test(l));
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(new Set(rows.map((l) => l.lastIndexOf('··'))).size, 1, stdout);
  assert.match(stdout, /\/editlens undo N  only this edit  ·  \/editlens restore N  the whole file/);
  assert.match(stdout, /Restore puts the whole file back; later changes to it are undone too\./);
});

test('no edits yet, and a list the server can\'t give', async () => {
  answers = { 'GET /edits/recent': [200, { edits: [] }] };
  assert.strictEqual((await run(['undo'])).stdout.trim(), '✦ Recent edits  · this session · none yet');
  answers = { 'GET /edits/recent': [500, 'oops'] };
  const out = await run(['undo']);
  assert.strictEqual(out.code, 1);
  assert.match(out.stdout, /^✕ EditLens couldn't list the edits: the server gave an answer EditLens can't read\n! Fix  › \/editlens details/);
});

test('/editlens undo N and restore N post { n, back, session, cwd } and print the server\'s sentence', async () => {
  answers = {
    'POST /edits/undo': [200, { ok: true, text: 'Undid only edit 3 in src/a.js. Later changes kept.' }],
    'POST /edits/restore': [200, { ok: true }],
  };
  seen.length = 0;
  let out = await run(['undo', '3']);
  assert.strictEqual(out.code, 0);
  assert.strictEqual(out.stdout, '✓ Undid only edit 3 in src/a.js. Later changes kept.\n/editlens undo 3 back  puts it back\n');
  out = await run(['undo', '3', 'back']);
  assert.strictEqual(out.stdout, '✓ Undid only edit 3 in src/a.js. Later changes kept.\n', 'no "back" hint after back');
  out = await run(['restore', '5']);
  assert.strictEqual(out.stdout, '✓ Restored the file from before edit 5.\n/editlens restore 5 back  puts it back\n', 'a sentence of its own when the server gives none');
  out = await run(['restore', '5', 'back']);
  assert.strictEqual(out.stdout, '✓ Undid the restore of edit 5.\n');
  assert.deepStrictEqual(seen.map((s) => [s.path, s.key, s.body]), [
    ['/edits/undo', KEY, { n: 3, session: 'sess-1', cwd: '/work/app' }],
    ['/edits/undo', KEY, { n: 3, back: true, session: 'sess-1', cwd: '/work/app' }],
    ['/edits/restore', KEY, { n: 5, session: 'sess-1', cwd: '/work/app' }],
    ['/edits/restore', KEY, { n: 5, back: true, session: 'sess-1', cwd: '/work/app' }],
  ]);
  // The mod passes its own session id.
  seen.length = 0;
  await run(['undo', '3'], { env: { EDITLENS_SESSION_ID: 'from-mod' } });
  assert.strictEqual(seen[0].body.session, 'from-mod');
});

test('a conflict prints the ! line and the message to copy; nothing is sent to Claude', async () => {
  const message = 'Undo only edit 3 in src/a.js (lines 4–9, Add the header). Keep the later changes.';
  answers = { 'POST /edits/undo': [409, { ok: false, conflict: true, lines: [4, 9], message }] };
  const out = await run(['undo', '3']);
  assert.strictEqual(out.code, 0);
  assert.strictEqual(out.stdout, `! A later edit changed the same lines, so only Claude can undo just this part.\nCopy this into your prompt:\n\n    ${message}\n\n`);
  // As records (the mod): the message is marked so the mod can put it in the prompt.
  const rec = parse((await run(['undo', '3'], { records: true })).stdout);
  assert.ok(rec.some((r) => r.copyNote && r.text === 'Copy this into your prompt:'));
  assert.ok(rec.some((r) => r.k === 'code' && r.prompt === message));
  // The server's message is one line, whatever it contains.
  answers = { 'POST /edits/undo': [409, { ok: false, conflict: true, message: 'Undo only edit 3\n\u001b[2Jin a.js.' }] };
  assert.match((await run(['undo', '3'])).stdout, /\n {4}Undo only edit 3 \[2Jin a\.js\.\n/);
  answers = { 'POST /edits/undo': [409, { ok: false, conflict: true }] };
  assert.match((await run(['undo', '3'])).stdout, /\n {4}Undo only edit 3\. Keep the later changes\.\n/);
});

test('failures: the server\'s reason, bad N, a refused key, the server down', async () => {
  answers = { 'POST /edits/undo': [400, { ok: false, error: 'There is no edit 9 in this session.' }] };
  let out = await run(['undo', '9']);
  assert.strictEqual(out.code, 1);
  assert.strictEqual(out.stdout, '✕ There is no edit 9 in this session.\n! Fix  › /editlens undo lists the edits you can undo\n');
  answers = { 'POST /edits/restore': [404, { ok: false }] };
  assert.match((await run(['restore', '9'])).stdout, /^✕ Couldn't restore the file of edit 9\n/);
  // Bad N: a plain error, and the server is never asked.
  seen.length = 0;
  for (const bad of ['0', '-2', '1.5', '1e3', 'abc']) {
    out = await run(['undo', bad]);
    assert.strictEqual(out.code, 1, bad);
    assert.match(out.stdout, /^✕ ".*" isn't an edit number: use a whole number from 1, as on the page\n! Fix  › \/editlens undo lists the edits and their numbers\n$/, bad);
  }
  out = await run(['restore', '4', 'now']);
  assert.match(out.stdout, /^✕ "now" isn't something \/editlens restore knows: only "back" can follow the number\n/);
  assert.strictEqual(seen.length, 0);
  // Another key (the task account's): refused, said plainly, never NaN.
  const noKey = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-nokey-'));
  test.after(() => fs.rmSync(noKey, { recursive: true, force: true }));
  out = await run(['undo', '3'], { env: { EDITLENS_STATE_DIR: noKey } });
  assert.strictEqual(out.code, 1);
  assert.match(out.stdout, /^✕ EditLens refused this \(error 401\)\n/);
  // Nothing on the port: say so, never start a server for it.
  for (const args of [['undo'], ['undo', '3'], ['restore', '2', 'back']]) {
    out = await run(args, { port: DOWN_PORT });
    assert.strictEqual(out.code, 1);
    assert.strictEqual(out.stdout, "✕ EditLens isn't running\n! Fix  › /editlens to start it and connect your page\n", args.join(' '));
  }
});

test('help lists undo and restore, with a topic for each', async () => {
  const help = await run(['help']);
  assert.match(help.stdout, /\/editlens undo {8}recent edits: undo one, or restore its file/);
  assert.match(help.stdout, /\/editlens undo N {6}undo only edit N \(back: put it back\)/);
  assert.match(help.stdout, /\/editlens restore N {3}the whole file from before edit N/);
  assert.match((await run(['help', 'undo'])).stdout, /undo N back puts it back/);
  assert.match((await run(['help', 'restore'])).stdout, /restore N back undoes the restore/);
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'editlens', 'SKILL.md'), 'utf8');
  assert.match(skill, /argument-hint: ".*undo \[N\] \| restore N/);
  assert.match(skill, /don't make that change yourself until the user sends it/);
});

test('the mod\'s shared helpers: times, labels, outcomes, and the prompt records', async () => {
  const m = await mod();
  const now = new Date(2026, 9, 9, 18, 0).getTime();
  assert.strictEqual(m.editTime(new Date(2026, 9, 9, 9, 5).getTime(), now), '09:05');
  assert.match(m.editTime(new Date(2026, 9, 7, 9, 5).getTime(), now), /^[A-Z][a-z]{2} 09:05$/);
  assert.strictEqual(m.editTime(new Date(2026, 8, 1, 9, 5).getTime(), now), 'Sep 1');
  for (const bad of [NaN, Infinity, -1, 0, '123', null, undefined]) assert.strictEqual(m.editTime(bad, now), '');
  assert.strictEqual(m.editLabel({ file: 'src/App.jsx', reason: 'Add the header' }, 60), 'src/App.jsx  Add the header');
  assert.strictEqual(m.editLabel({ file: 'src/App.jsx', reason: 'Add the header' }, 15), 'src/App.jsx  A…');
  assert.strictEqual(m.editLabel({ file: 'a.js', reason: '' }, NaN), 'a.js');
  assert.deepStrictEqual(m.recentEdits({ edits: [{ n: 1, file: 'a', canUndo: 'yes', added: NaN, removed: -1 }, { n: 1, file: 'dup' }, { n: 0 }, { n: true }] }),
    [{ n: 1, seq: null, file: 'a', reason: '', time: null, canUndo: false, canRestore: false, added: null, removed: null, created: false, agentId: null, agentType: null }]);
  // The Changes row's counts: never "0 lines" unless both are a real 0.
  assert.deepStrictEqual([{ added: 3, removed: 1 }, { added: 0, removed: 0 }, { added: null, removed: 2 }, { created: true, added: 1 }, { created: true, added: null }, {}, null].map(m.editCounts),
    ['+3 −1', 'No line changes', '', 'New · 1 line', 'New', '', '']);
  assert.deepStrictEqual(m.fileParts('essays/design/03.md'), { name: '03.md', folder: 'essays/design/' });
  assert.strictEqual(m.folderFit('essays/design/', 9), '…design/');
  assert.strictEqual(m.folderFit('src/', 9), 'src/');
  assert.strictEqual(m.editWho({ agentId: 'a1', agentType: 'Explore' }, { agents: [{ agentId: 'a1', name: 'Check the header' }] }), 'Check the header');
  assert.strictEqual(m.editWho({ agentId: null }, null), 'Main');
  assert.deepStrictEqual(m.recentEdits(null), []);
  const o = m.outcomeOf({ status: 409, json: { conflict: true, lines: [4, 'x', 9] } }, { action: 'undo', n: 3 });
  assert.deepStrictEqual(o, { kind: 'conflict', message: 'Undo only edit 3. Keep the later changes.', lines: [4, 9] });
  assert.strictEqual(m.outcomeOf({ down: true }, { action: 'undo', n: 3 }).kind, 'down');
  assert.strictEqual(m.outcomeOf({ status: undefined, json: null }, { action: 'undo', n: 3 }).text, 'EditLens refused this');
  const list = [{ k: 'steps', heading: m.CONFLICT_LINE, plain: ['! x'] }, { k: 'text', text: m.COPY_NOTE, copyNote: true, plain: [m.COPY_NOTE] }, { k: 'code', text: 'msg', prompt: 'msg', plain: ['', '    msg', ''] }];
  assert.strictEqual(m.filledRecords(list, false), list, 'not filled: the message stays to copy');
  assert.deepStrictEqual(m.filledRecords(list, true).map((r) => r.plain[0]), ['! x', m.IN_PROMPT]);
  assert.ok(!MARK.includes('\n'));
});

// Last, on port 4949 (the "server down" port above is free again by now): the real live server.
test('against the live server: list, undo N, back, restore N, back, and a conflict', async (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-real-'));
  const dir = path.join(real, 'proj');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'app.js');
  const env = { EDITLENS_PORT: String(DOWN_PORT), EDITLENS_STATE_DIR: real, EDITLENS_SAY: '' };
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { cwd: real, env: { ...process.env, ...env }, stdio: 'ignore' });
  t.after(() => {
    child.kill(); // by its own pid
    fs.rmSync(real, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${DOWN_PORT}`;
  for (let i = 0; i < 100; i++) {
    const up = await fetch(base + '/health').then((r) => r.ok, () => false);
    if (up && fs.existsSync(path.join(real, `token-${DOWN_PORT}`))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const key = fs.readFileSync(path.join(real, `token-${DOWN_PORT}`), 'utf8').trim();
  const L = (...xs) => xs.join('\n') + '\n';
  let text = L('1', '2', '3', '4', '5', '6', '7', '8');
  fs.writeFileSync(file, text);
  const edit = async (next, intent) => {
    const before = text;
    text = next;
    fs.writeFileSync(file, text);
    const r = await fetch(base + '/event', { method: 'POST', headers: { 'content-type': 'application/json', 'x-editlens-token': key },
      body: JSON.stringify({ type: 'change', sessionId: 'sess-1', cwd: dir, tool: 'Edit', file, relFile: 'app.js', before, after: text, kind: 'frontend', intent, stats: { added: 1, removed: 1 } }) });
    assert.strictEqual(r.status, 200);
  };
  await edit(L('1', 'TWO', '3', '4', '5', '6', '7', '8'), 'Spell out two');
  await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'), 'Spell out seven');
  await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN!', '8'), 'Shout seven');
  const go = (args) => run(args, { port: DOWN_PORT, env: { ...env, CLAUDE_PROJECT_DIR: dir } });

  let out = await go(['undo']);
  assert.strictEqual(out.code, 0, out.stdout);
  assert.match(out.stdout, /^✦ Recent edits {2}· this session\n\n3 {2}app\.js ·+ \+1 −1\n {3}Main · \d\d:\d\d · Shout seven\n/, out.stdout);
  assert.match(out.stdout, /\n1 {2}app\.js ·+ \+1 −1\n {3}Main · \d\d:\d\d · Spell out two\n/);
  out = await go(['undo', '1']);
  assert.strictEqual(out.stdout, '✓ Undid only edit 1 in app.js. Later changes kept.\n/editlens undo 1 back  puts it back\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), L('1', '2', '3', '4', '5', '6', 'SEVEN!', '8'));
  out = await go(['undo', '1', 'back']);
  assert.strictEqual(out.code, 0, out.stdout);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  out = await go(['undo', '2']);
  assert.strictEqual(out.stdout, '! A later edit changed the same lines, so only Claude can undo just this part.\nCopy this into your prompt:\n\n' +
    '    Undo only edit 2 in app.js (line 7, Spell out seven). Keep the later changes.\n\n');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text, 'a conflict changes nothing');
  out = await go(['restore', '2']);
  assert.strictEqual(out.code, 0, out.stdout);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), L('1', 'TWO', '3', '4', '5', '6', '7', '8'));
  out = await go(['restore', '2', 'back']);
  assert.strictEqual(out.code, 0, out.stdout);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), text);
  out = await go(['undo', '99']);
  assert.strictEqual(out.code, 1);
  assert.match(out.stdout, /^✕ There is no edit 99 in the list\./);
});
