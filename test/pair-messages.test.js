'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4907';
// Pairing messages and one layout for every /editlens reply (handoff 11.3 and 8): two EditLens
// servers stand in for a VPS ("host") and a laptop ("remote"), as test/pairing.test.js does.
//   - /editlens pair: layout B rows, the join line alone on one line
//   - success on both computers, and "pairing open" gone once the code is used
//   - "2 computers paired": the same computer pairing again (another folder, another address)
//   - every command's reply: labelled values start in one column, with a dotted line to it
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const { parse, plain } = require('../lib/say');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pairmsg-'));
const project = path.join(base, 'project');
const inner = path.join(project, 'site'); // an app folder inside the project
for (const dir of [project, inner]) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>t</title><p>hi</p>\n');
}
const ROOT = path.join(__dirname, '..');
const HOST = { port: 4903, pairPort: 4904, dir: path.join(base, 'host') };
const REMOTE = { port: 4905, pairPort: 4906, dir: path.join(base, 'remote') };
const children = new Set();

function envFor(s, extra) {
  const env = { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir, EDITLENS_NO_BROWSER: '1', ...extra };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_') || k === 'EDITLENS_TYPED') delete env[k];
  // Plain /editlens connects only: page control would set up the Agent SDK (a download).
  env.CLAUDE_PLUGIN_OPTION_START = 'Connect the page';
  return env;
}

function startServer(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: envFor(s), stdio: 'ignore' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, text: err.code || err.message, json: null }));
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
    if (data) req.write(data);
    req.end();
  });
}

function api(s, method, urlPath, body) {
  const token = fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
  return request(s.port, method, urlPath, body, { 'x-editlens-token': token }).then((r) => r.json);
}

async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return true;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 150));
  }
}

// /editlens <args> on that computer, as the mod runs it: its records (and its plain text, run again
// without records, must be the same text).
function run(s, args, cwd = project) {
  const go = (say) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { encoding: 'utf8', timeout: 90000, env: envFor(s, { CLAUDE_PROJECT_DIR: cwd, EDITLENS_SAY: say }) });
  const out = go('records');
  return { list: parse(out.stdout + out.stderr), status: out.status };
}

const cells = (t) => [...String(t)].length;

// Where the value of a labelled field starts (in cells), and whether a dotted line leads to it.
function valueColumn(line) {
  const m = /^(\S.*?) (·{2,}) /.exec(line);
  return m ? cells(m[0]) : null;
}

// One reply: every labelled field has a dotted line, and all of them start their value in one
// column; a line under a value (no label) starts in that column too; copyable lines stand alone.
function checkLayout(name, list) {
  const fields = list.filter((r) => r.k === 'field');
  const cols = new Set();
  for (const r of fields.filter((f) => f.label)) {
    const col = valueColumn(r.plain[0]);
    assert.ok(col, `${name}: no dotted line in "${r.plain[0]}"`);
    cols.add(col);
  }
  assert.ok(cols.size <= 1, `${name}: values start in more than one column: ${[...cols].join(', ')}\n${fields.map((f) => f.plain[0]).join('\n')}`);
  const col = [...cols][0];
  for (const r of fields.filter((f) => !f.label && (!f.width || f.width > 2))) {
    if (col) assert.strictEqual(/^ */.exec(r.plain[0])[0].length, col, `${name}: "${r.plain[0]}" doesn't start under the values`);
  }
  const rows = list.filter((r) => r.k === 'row');
  const rowCols = new Set(rows.map((r) => valueColumn(r.plain[0])));
  assert.ok(rowCols.size <= 1, `${name}: rows with values in more than one column`);
  for (const r of list.filter((x) => x.k === 'code' && x.copy)) {
    const line = r.plain.find((l) => l.trim());
    assert.strictEqual(line, line.trim(), `${name}: the line to copy is indented`);
    assert.doesNotMatch(line, /·/, `${name}: dots inside the line to copy`);
  }
  for (const r of list) assert.doesNotMatch(r.plain.join('\n'), /undefined|NaN|\[object/, `${name}: ${r.plain.join('\n')}`);
  return col;
}

test.before(async () => {
  await startServer(HOST);
  await startServer(REMOTE);
});

test.after(async () => {
  for (const c of children) c.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(base, { recursive: true, force: true });
});

let hostName = '';
let remoteName = '';

test('/editlens pair: layout B rows and one line to type; on success both computers say "Paired with", and the code is no longer open', async () => {
  const pair = run(HOST, ['pair']);
  assert.strictEqual(pair.status, 0, JSON.stringify(pair.list));
  const head = pair.list[0];
  assert.strictEqual(head.plain[0], '✦ Pair another computer');
  assert.match(head.pairing, /^[0-9a-f]{12}$/);
  const byLabel = Object.fromEntries(pair.list.filter((r) => r.k === 'field' && r.label).map((r) => [r.label, r.plain[0]]));
  assert.strictEqual(byLabel['Open for'], 'Open for ······· 10 min');
  assert.strictEqual(byLabel['Code works'], 'Code works ····· once');
  assert.match(byLabel['This computer'], /^This computer ·· \S+@\S+$/);
  assert.strictEqual(byLabel.Cancel, 'Cancel ········· /editlens pair off  also ends every pairing');
  // The key file is no row of its own: the whole line with --key comes under the plain one.
  assert.ok(!('Another key' in byLabel), 'no "Another key" row');
  assert.ok(pair.list.some((r) => r.k === 'steps' && r.plain[0] === '! On your other computer, type this in Claude Code:'));
  const code = pair.list.find((r) => r.k === 'code');
  assert.strictEqual(code.copy, true);
  const line = code.plain.find((l) => l.trim());
  assert.match(line, /^\/editlens join \S+@\S+ ([A-Z2-9]{4}-){6}[A-Z2-9]{4}$/);
  // Then a dim "With a key file:" and the same line with the user's placeholder, also alone.
  const at = pair.list.indexOf(code);
  assert.deepStrictEqual(pair.list.slice(at + 1, at + 3).map((r) => [r.k, r.dim === true, r.plain.find((l) => l.trim())]),
    [['text', true, 'With a key file:'], ['code', false, `${line} --key "<path of your key file>"`]]);
  assert.strictEqual(pair.list[at + 2].copy, true);
  assert.ok(pair.list.some((r) => r.plain[0] === "Type it yourself; Claude can't run it." && r.dim));
  checkLayout('pair', pair.list);

  // The line above the prompt and Details are told the code is open.
  const open = await api(HOST, 'GET', `/summary?cwd=${encodeURIComponent(project)}`);
  assert.deepStrictEqual(open.paired.waiting, { minutesLeft: 10, id: head.pairing });

  // The laptop types the line (here straight to the pairing port, without SSH).
  const secret = /(([A-Z2-9]{4}-){6}[A-Z2-9]{4})$/.exec(line)[1];
  const join = run(REMOTE, ['join', `127.0.0.1:${HOST.pairPort}`, secret], inner);
  assert.strictEqual(join.status, 0, JSON.stringify(join.list));
  const jhead = join.list[0];
  assert.match(jhead.plain[0], /^✦ ✓ Paired with ◆ (\S+)  · reconnects by itself$/);
  hostName = /◆ (\S+)/.exec(jhead.plain[0])[1];
  const jl = Object.fromEntries(join.list.filter((r) => r.k === 'field' && r.label).map((r) => [r.label, r.plain[0]]));
  assert.match(jl.Page, /^Page ······ http:\/\/localhost:\d+\//);
  assert.strictEqual(jl['You can'], 'You can ··· open its page, give Claude there tasks');
  assert.strictEqual(jl.Next, `Next ······ /editlens control ${hostName}  run Claude there`);
  assert.strictEqual(jl.Remove, `Remove ···· /editlens join off ${hostName}`);
  checkLayout('join', join.list);

  // The host: a "paired" notice naming the code it used, and no code open any more.
  const after = await api(HOST, 'GET', `/summary?cwd=${encodeURIComponent(project)}`);
  assert.strictEqual(after.paired.waiting, null);
  const notice = after.pairing.find((n) => n.kind === 'paired');
  assert.ok(notice, JSON.stringify(after.pairing));
  assert.strictEqual(notice.pairing, head.pairing);
  remoteName = notice.name;
  assert.strictEqual(notice.site, true);
  // The joining computer is told too (its own line above the prompt turns green).
  const mine = await api(REMOTE, 'GET', `/summary?cwd=${encodeURIComponent(inner)}`);
  const joined = mine.pairing.find((n) => n.kind === 'paired');
  assert.deepStrictEqual([joined.name, joined.joined], [hostName, true]);

  // The host's success block, as the mod prints it (the same layout as the joiner's reply).
  const mod = await import('../hooks/mod.mjs');
  assert.deepStrictEqual(mod.pairedRecords(notice).map((r) => r.plain[0]), [
    `✦ ✓ Paired with ◆ ${remoteName}`,
    "It can ······ open this project's page, give Claude here tasks",
    'You answer ·· its permission questions',
    `Remove ······ /editlens join off ${remoteName}`,
  ]);
  checkLayout('host success', mod.pairedRecords(notice));
  // The line above the prompt: one computer, by name.
  assert.deepStrictEqual(mod.pairedOf(after).map((p) => p.parts.map((x) => x.text).join('')), [`◆ ${remoteName} paired`]);
});

test('"2 computers paired": the same laptop pairing again (a folder inside, another address for the host) leaves one pairing on each side', async () => {
  // Before 0.24.33 the host kept a pairing per folder and the laptop one per address, so the
  // first pairing stayed on both, never connecting again, and the line counted 2 computers.
  // Paired for the project through one address, then for a folder inside it through another.
  for (const [cwd, address] of [[project, '127.0.0.1'], [inner, 'localhost']]) {
    const { code } = await api(HOST, 'POST', '/pair', { cwd });
    const r = await api(REMOTE, 'POST', '/join', { address: `${address}:${HOST.pairPort}`, code });
    assert.ok(r.ok, JSON.stringify(r));
  }
  const status = await api(HOST, 'GET', '/pair');
  remoteName = remoteName || (await api(REMOTE, 'GET', '/pair')).remotes.name;
  assert.deepStrictEqual(status.host.pairs.map((p) => [p.name, p.cwd]), [[remoteName, inner]]);
  assert.strictEqual(status.remotes.hosts.length, 0);
  const remote = await api(REMOTE, 'GET', '/pair');
  assert.strictEqual(remote.remotes.hosts.length, 1);
  assert.strictEqual(remote.remotes.hosts[0].address, `localhost:${HOST.pairPort}`);
  const summary = await api(HOST, 'GET', `/summary?cwd=${encodeURIComponent(project)}`);
  assert.strictEqual(summary.paired.host.length, 1);
  const mod = await import('../hooks/mod.mjs');
  assert.deepStrictEqual(mod.pairedOf(summary).map((p) => p.parts.map((x) => x.text).join('')), [`◆ ${remoteName} paired`]);
  // A pairing saved before computers had an id (name only) is replaced the same way.
  const { sameComputer } = require('../server/pair-host');
  assert.strictEqual(sameComputer({ name: 'laptop-1' }, { name: 'laptop-1', machine: 'a'.repeat(32) }), true);
  assert.strictEqual(sameComputer({ name: 'laptop-1', machine: 'b'.repeat(32) }, { name: 'laptop-1', machine: 'a'.repeat(32) }), false);
});

test('/editlens join off <name> on the computer that was joined removes that pairing there', async () => {
  const off = run(HOST, ['join', 'off', remoteName]);
  assert.strictEqual(off.status, 0, JSON.stringify(off.list));
  assert.match(off.list[0].plain[0], new RegExp(`^✓ Unpaired ◆ ${remoteName}  it had joined this computer`));
  assert.deepStrictEqual((await api(HOST, 'GET', '/pair')).host.pairs, []);
  const none = run(HOST, ['join', 'off', 'nobody-here']);
  assert.strictEqual(none.status, 1);
  assert.match(none.list.map((r) => r.plain.join('\n')).join('\n'), /✕ Couldn't leave the paired computer: No paired computer is called "nobody-here"/);
  assert.strictEqual((await api(REMOTE, 'POST', '/join/off', {})).removed.length, 1);
});

test('every /editlens reply: labelled values start in one column with a dotted line to it (records and plain text)', async () => {
  const commands = [
    [''], ['status'], ['manual'], ['settings'], ['help'], ['help', 'pair'], ['usage'], ['undo'], ['restore', 'x'], ['undo', '3', 'sideways'],
    ['pair'], ['join'], ['join', 'off'], ['join', 'nowhere', 'ABCD'], ['pair', 'off'], ['task-user', 'status'], ['new'], ['new', 'extra'],
    ['control', 'no-such-computer'], ['manual', 'no-such-computer'], ['something-unknown'], ['stop'], ['status'],
  ];
  const seen = new Map();
  for (const args of commands) {
    const name = '/editlens ' + args.join(' ');
    const { list } = run(HOST, args);
    assert.ok(list.length, `${name}: no output`);
    seen.set(name, checkLayout(name, list));
    // Without the mod: the same text (for replies that don't change anything when run again).
    if (['', 'pair', 'stop', 'new', 'manual'].includes(args.join(' '))) continue;
    const text = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { encoding: 'utf8', timeout: 90000, env: envFor(HOST, { CLAUDE_PROJECT_DIR: project, EDITLENS_SAY: '' }) });
    const plainText = (text.stdout + text.stderr).trim().split('\n').filter((l) => l.trim());
    const fromRecords = list.flatMap((r) => r.plain).filter((l) => l.trim());
    assert.deepStrictEqual(plainText, fromRecords, name);
  }
  // The connect reply: Page, Control and Project in one 12-cell column.
  assert.strictEqual(seen.get('/editlens '), 12);
  // The fields made elsewhere follow the same rule: page control, joined, and the task account.
  const lines = [];
  const write = process.stdout.write;
  const saved = process.env.EDITLENS_SAY;
  const exitCode = process.exitCode; // sayControl sets it for a failure
  process.env.EDITLENS_SAY = 'records';
  process.stdout.write = (t) => lines.push(String(t)) && true;
  try {
    const { sayControl } = require('../bin/drive.js');
    const { sayJoined } = require('../bin/pair.js');
    sayControl({ ok: true, pages: [], from: 's1' }, () => require('../lib/say').say.field('Project', 'no files changed'));
    sayControl({ error: 'Claude runs from another page', busy: true, working: true });
    sayControl({ error: 'no page', noPage: true, url: 'http://127.0.0.1:4493/' });
    sayJoined({ name: 'vps-123456', url: 'http://127.0.0.1:4732/', site: false }, { ssh: true, opened: false });
    require('../lib/say').say.fields([['Account', '✓ editlens'], ['Claude Code', '✓ installed'], ['Signed in', '✕ not yet']]);
  } finally {
    process.stdout.write = write;
    process.exitCode = exitCode;
    if (saved === undefined) delete process.env.EDITLENS_SAY;
    else process.env.EDITLENS_SAY = saved;
  }
  const made = parse(lines.join(''));
  assert.strictEqual(checkLayout('control and joined', made.filter((r) => r.k !== 'field' || !['Account', 'Claude Code', 'Signed in'].includes(r.label))), 12);
  assert.strictEqual(checkLayout('task account', made.filter((r) => ['Account', 'Claude Code', 'Signed in'].includes(r.label))), 15);
  // The mod writes a field's line exactly as lib/say.js does.
  const mod = await import('../hooks/mod.mjs');
  for (const [label, width] of [['Page', undefined], ['This computer', 17], ['', 12], ['A label longer than its column', 12]]) {
    assert.strictEqual(mod.fieldLabel(label, width) + 'v', plain({ k: 'field', label, value: 'v', width })[0]);
  }
  assert.strictEqual(mod.fieldWidth(['Open for', 'This computer']), require('../lib/say').fieldWidth(['Open for', 'This computer']));
});
