'use strict';
require('./isolate');
// "Undo only this edit" on the live server: the page's /restore { undoEdit } (check, run, put
// back), the terminal's hook-key routes (/edits/recent, /edits/undo, /edits/restore), numbers that
// match the page's markers, the fixed conflict message, and refusals (no key, the task key, bad N).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-edit-state-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4943';
const { ensureServer, stopServer, postEvent, readToken } = require('../lib/client');
const config = require('../lib/config');
const { conflictMessage, seqOf, oneLine } = require('../server/undo');
const taskuser = require('../lib/taskuser');

const L = (...xs) => xs.join('\n') + '\n';

test('the conflict message never says NaN or undefined, and leaves out missing parts', () => {
  assert.strictEqual(conflictMessage({ n: 3, file: 'src/a.js', lines: [4, 6], reason: 'Make the title bold.' }),
    'Undo only edit 3 in src/a.js (lines 4–6, Make the title bold). Keep the later changes.');
  assert.strictEqual(conflictMessage({ n: 3, file: 'src/a.js', lines: [4, 4], reason: '' }), 'Undo only edit 3 in src/a.js (line 4). Keep the later changes.');
  assert.strictEqual(conflictMessage({ n: 3, file: 'src/a.js', lines: [NaN, undefined], reason: undefined }), 'Undo only edit 3 in src/a.js. Keep the later changes.');
  assert.strictEqual(conflictMessage({ n: 'x', file: 'a.js', lines: null, reason: 'Two\nlines' }), 'Undo only one edit in a.js (Two). Keep the later changes.');
  assert.strictEqual(conflictMessage({}), 'Undo only one edit in this file. Keep the later changes.');
  for (const bad of [NaN, Infinity, -1, 0, 1.5, '1.5', '1e3', ' 2', '', null, undefined, {}, [], true, '99999999999999999999']) assert.strictEqual(seqOf(bad), null, String(bad));
  assert.deepStrictEqual([seqOf(4), seqOf('12')], [4, 12]);
  assert.strictEqual(oneLine('x'.repeat(300)).length, 120);
});

test('the task account key may not use Restore or the /edits routes', () => {
  for (const r of ['GET /edits/recent', 'POST /edits/undo', 'POST /edits/restore', 'POST /restore', 'GET /summary']) assert.strictEqual(taskuser.keyAllows(r), false, r);
  assert.strictEqual(taskuser.keyAllows('POST /event'), true);
  // Every place the server lets the task key through asks keyAllows.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'server.js'), 'utf8');
  const uses = src.split('\n').filter((l) => /\btaskKey\b/.test(l) && !/const taskKey/.test(l) && !/if \(taskKey\)/.test(l));
  assert.ok(uses.length >= 2 && uses.every((l) => l.includes('taskuser.keyAllows(route)')), uses.join('\n'));
});

test('undo only this edit: page and terminal routes', async (t) => {
  const dir = path.join(stateDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.js');
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await ensureServer();
  const open = async (page, root) => {
    const s = new AbortController();
    streams.push(s);
    await fetch(`${config.baseUrl}/events?page=${page}&root=${encodeURIComponent(root)}`, { signal: s.signal });
  };
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(config.baseUrl + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
    return { status: r.status, body: json, text };
  };
  const key = () => ({ 'x-editlens-token': readToken() });
  // Requests by edit number name the server start (instance), as the page does.
  const page = async (body) => call('POST', '/restore', { instance: (await call('GET', '/summary')).body.instance, ...body });
  const term = (what, body) => call('POST', `/edits/${what}`, { cwd: dir, ...body }, key());
  const recent = (session) => call('GET', `/edits/recent?session=${session}&cwd=${encodeURIComponent(dir)}`, undefined, key());
  const history = async () => JSON.parse((await call('GET', '/history', undefined, key())).text);
  const last = async () => (await history()).filter((e) => e.type === 'change').pop();
  const read = () => fs.readFileSync(file, 'utf8');
  let text = L('1', '2', '3', '4', '5', '6', '7', '8');
  fs.writeFileSync(file, text);
  const edit = async (next, intent, extra) => {
    const before = text;
    text = next;
    fs.writeFileSync(file, text);
    await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file, relFile: 'app.js', before, after: text, kind: 'frontend', intent, stats: { added: 1, removed: 1 }, ...extra });
    return last();
  };

  await open('p1', dir);
  const e1 = await edit(L('1', 'TWO', '3', '4', '5', '6', '7', '8'), 'Spell out two');
  const e2 = await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN', '8'), 'Spell out seven.\nMore words here.');
  const other = path.join(dir, 'b.js');
  fs.writeFileSync(other, 'b\n');
  await postEvent({ type: 'change', sessionId: 's2', cwd: dir, tool: 'Write', file: other, relFile: 'b.js', created: true, before: '', after: 'b\n', kind: 'other' });

  // ----- recent edits: this session's, newest first, numbered like the page's markers -----
  assert.strictEqual((await call('GET', '/edits/recent')).status, 401, 'no key');
  assert.strictEqual((await call('GET', '/edits/recent', undefined, { 'x-editlens-token': 'nope' })).status, 401, 'wrong key');
  assert.strictEqual((await call('POST', '/edits/undo', { n: 1 }, { 'x-editlens-token': 'nope' })).status, 401);
  const list = await recent('s1');
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.body.edits.map((e) => [e.n, e.seq, e.file, e.reason, e.canUndo, e.canRestore, e.kind]),
    [[2, e2.seq, 'app.js', 'Spell out seven', true, true, 'frontend'], [1, e1.seq, 'app.js', 'Spell out two', true, true, 'frontend']]);
  assert.ok(list.body.edits.every((e) => Number.isFinite(e.time) && e.time > 0));
  assert.deepStrictEqual((await recent('s2')).body.edits.map((e) => [e.n, e.file, e.canUndo, e.canRestore]), [[3, 'b.js', false, false]]);

  // ----- page: check, run, put back -----
  assert.deepStrictEqual((await page({ page: 'p1', undoEdit: e1.seq, check: true })).body, { ok: true, clean: true, lines: [2, 2], same: false });
  assert.strictEqual(read(), text, 'a check changes nothing');
  assert.strictEqual((await page({ page: 'nope', undoEdit: e1.seq })).status, 403, 'an unknown page');
  for (const bad of ['x', NaN, -1, 1.5, null, 99999]) assert.strictEqual((await page({ page: 'p1', undoEdit: bad })).status, 404, String(bad));
  await open('p2', path.join(stateDir, 'elsewhere'));
  assert.strictEqual((await page({ page: 'p2', undoEdit: e1.seq })).status, 403, 'another project\'s page');
  assert.strictEqual(read(), text);

  const run = await page({ page: 'p1', undoEdit: e1.seq });
  assert.strictEqual(run.status, 200, JSON.stringify(run.body));
  assert.strictEqual(read(), L('1', '2', '3', '4', '5', '6', 'SEVEN', '8'), 'only edit 1 is taken out; edit 2 stays');
  assert.strictEqual(run.body.text, 'Undid only edit 1 in app.js. Later changes kept.');
  const ev = await last();
  assert.deepStrictEqual([ev.kind, ev.via, ev.undidSeq, ev.undidBackup, ev.backup, ev.seq, ev.intent],
    ['restore', 'undo-edit', e1.seq, e1.backup, run.body.undo, run.body.seq, 'Undid one earlier edit. Later changes kept.']);
  assert.deepStrictEqual(ev.hunks[0].lines.filter((l) => l[0] !== ' '), ['-TWO', '+2'], 'played in the code view like any restore');
  assert.strictEqual((await recent('s1')).body.edits.length, 2, 'a restore is not one of this session\'s edits');

  const back = await page({ page: 'p1', undoEdit: e1.seq, back: true });
  assert.strictEqual(back.status, 200, JSON.stringify(back.body));
  assert.strictEqual(read(), text, 'Put it back restores the copy kept first');
  const bev = await last();
  assert.deepStrictEqual([bev.via, bev.restoredFrom, bev.intent], ['undo', run.body.undo, 'Put the undone edit back']);
  assert.strictEqual((await page({ page: 'p1', undoEdit: e2.seq, back: true })).status, 404, 'nothing to put back');

  // ----- conflict: a later edit changed the same lines -----
  const e4 = await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN!', '8'), 'Shout seven');
  const msg = 'Undo only edit 2 in app.js (line 7, Spell out seven). Keep the later changes.';
  assert.deepStrictEqual((await page({ page: 'p1', undoEdit: e2.seq, check: true })).body, { ok: false, conflict: true, lines: [7, 7], message: msg });
  const c = await page({ page: 'p1', undoEdit: e2.seq });
  assert.deepStrictEqual([c.status, c.body], [409, { ok: false, conflict: true, lines: [7, 7], message: msg }]);
  assert.strictEqual(read(), text, 'a conflict changes nothing');

  // ----- terminal: the same core by number -----
  // Restores are numbered too (they have cards and markers on the page): 1, 2, b.js, undo, put back, 6.
  assert.strictEqual((await recent('s1')).body.edits[0].n, 6);
  const tc = await term('undo', { n: 2 });
  assert.deepStrictEqual([tc.status, tc.body.conflict, tc.body.message, tc.body.lines], [409, true, msg, [7, 7]]);
  for (const bad of ['abc', '2.5', 2.5, 0, -3, null, undefined, '1e1', Infinity]) {
    const r = await term('undo', { n: bad });
    assert.deepStrictEqual([r.status, r.body.ok], [400, false], String(bad));
    assert.match(r.body.error, /whole number/);
  }
  const none = await term('restore', { n: 999 });
  assert.deepStrictEqual([none.status, none.body.ok], [404, false]);
  assert.match(none.body.error, /no edit 999/);
  const made = await term('undo', { n: 3 });
  assert.deepStrictEqual([made.status, made.body.ok], [409, false]);
  assert.match(made.body.error, /created b\.js/);

  // A row of the terminal's pane names its edit (seq) and the server start it came from (Sol H8):
  // another server start is refused, and the edit acted on is the row's even when its number changed.
  const listed = await recent('s1');
  assert.match(listed.body.instance, /^[0-9a-f]{16}$/);
  const row1 = listed.body.edits.find((e) => e.n === 1);
  const old = await term('undo', { n: 1, seq: row1.seq, instance: '0000000000000000' });
  assert.deepStrictEqual([old.status, old.body.ok, old.body.restarted], [409, false, true]);
  assert.match(old.body.error, /restarted/);
  assert.strictEqual(read(), text, 'nothing changed');
  const gone = await term('undo', { n: 1, seq: 999999, instance: listed.body.instance });
  assert.deepStrictEqual([gone.status, gone.body.ok], [404, false]);
  const byRow = await term('undo', { n: 99, seq: row1.seq, instance: listed.body.instance });
  assert.deepStrictEqual([byRow.status, byRow.body.text], [200, 'Undid only edit 1 in app.js. Later changes kept.']);
  assert.strictEqual((await term('undo', { n: 1, back: true })).status, 200);
  assert.strictEqual(read(), text);

  const tu = await term('undo', { n: 1 });
  assert.deepStrictEqual([tu.status, tu.body.ok, tu.body.text], [200, true, 'Undid only edit 1 in app.js. Later changes kept.']);
  assert.strictEqual(read(), L('1', '2', '3', '4', '5', '6', 'SEVEN!', '8'));
  const tb = await term('undo', { n: 1, back: true });
  assert.deepStrictEqual([tb.status, tb.body.text], [200, 'Put edit 1 back in app.js.']);
  assert.strictEqual(read(), text);

  const tr = await term('restore', { n: 2 });
  assert.deepStrictEqual([tr.status, tr.body.text], [200, 'Restored app.js as it was before edit 2. Later changes to it were undone too.']);
  assert.strictEqual(read(), L('1', 'TWO', '3', '4', '5', '6', '7', '8'));
  const trb = await term('restore', { n: 2, back: true });
  assert.deepStrictEqual([trb.status, trb.body.text], [200, 'Undid the restore of app.js.']);
  assert.strictEqual(read(), text);
  const nothing = await term('restore', { n: 1, back: true });
  assert.deepStrictEqual([nothing.status, nothing.body.ok], [404, false]);
  // A restore's number is not one of Claude's edits.
  const rno = (await history()).filter((e) => e.type === 'change').findIndex((e) => e.kind === 'restore') + 1;
  const rr = await term('undo', { n: rno });
  assert.deepStrictEqual([rr.status, rr.body.ok], [409, false]);
  assert.match(rr.body.error, /is a restore/);

  // ----- numbers: the terminal follows the project's open page that has numbered the longest -----
  for (let i = 0; i < 125; i++) await postEvent({ type: 'prompt', sessionId: 's9', cwd: dir, prompt: 'x' + i });
  assert.strictEqual((await recent('s1')).body.edits.find((e) => e.seq === e4.seq).n, 6, 'p1 still shows 6 on its marker');
  streams[0].abort();
  const s3 = new AbortController();
  streams.push(s3);
  await fetch(`${config.baseUrl}/events?page=p3&root=${encodeURIComponent(dir)}`, { signal: s3.signal });
  await new Promise((r) => setTimeout(r, 100));
  // p3 got only the last 120 events, none of them an edit: it numbers from its own start.
  assert.deepStrictEqual((await recent('s1')).body.edits, []);
  const e5 = await edit(L('1', 'TWO', '3', '4', '5', '6', 'SEVEN!', 'eight'), 'Spell out eight');
  assert.deepStrictEqual((await recent('s1')).body.edits.map((e) => [e.n, e.seq]), [[1, e5.seq]]);
  const u5 = await term('undo', { n: 1 });
  assert.deepStrictEqual([u5.status, u5.body.text], [200, 'Undid only edit 1 in app.js. Later changes kept.']);
  assert.strictEqual(read(), L('1', 'TWO', '3', '4', '5', '6', 'SEVEN!', '8'));
  text = read();

  // ----- after a restart: the text the edit wrote is kept with its earlier copy -----
  for (const s of streams) s.abort();
  await stopServer();
  await ensureServer();
  await open('p1', dir);
  const again = (await recent('s1')).body.edits;
  const first = again.find((e) => e.file === 'app.js' && e.reason === 'Spell out two');
  assert.ok(first && first.canUndo, JSON.stringify(again));
  const ar = await term('undo', { n: first.n });
  assert.strictEqual(ar.status, 200, JSON.stringify(ar.body));
  assert.strictEqual(read(), L('1', '2', '3', '4', '5', '6', 'SEVEN!', '8'));
});
