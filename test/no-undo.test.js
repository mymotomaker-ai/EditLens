'use strict';
require('./isolate');
// D23 B (Sol 0.24.46 M6): a restore, a Remove file or a put back that could keep no copy of the
// current file for Undo (over 2 MB, or not text) is refused with the reason (noUndo: 'large' |
// 'binary'), and done only when the request says noUndo: true ("Restore without Undo" on the card).
// The same through the pairing link. Checks say it first, so the card can ask before anything.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-no-undo-state-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '5450';
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');
const config = require('../lib/config');
const { BackupStore } = require('../server/backups');
const { createUndo } = require('../server/undo');
const { createHostRestore, createRemoteRestore } = require('../server/remote-restore');

const BIG = 'x'.repeat(3 * 1024 * 1024);
function place() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-no-undo-')));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, store: new BackupStore(path.join(dir, 'backups')) };
}

test('a restore over a file too large or not text for an undo copy is refused, then done with noUndo', () => {
  const { dir, store } = place();
  const file = path.join(dir, 'big.txt');
  const id = store.save({ file, relFile: 'big.txt', cwd: dir, text: 'small earlier version\n' });
  fs.writeFileSync(file, BIG);
  assert.strictEqual(store.check(id).noUndo, 'large', 'the check says it first');
  const refused = store.restore(id);
  assert.strictEqual(refused.noUndo, 'large', JSON.stringify(refused).slice(0, 300));
  assert.match(refused.error, /big\.txt is over 2 MB, so its current version can't be kept for Undo/);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), BIG, 'nothing written');
  const done = store.restore(id, { noUndo: true });
  assert.ok(done.ok && done.undo === null, JSON.stringify(done).slice(0, 300));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'small earlier version\n');

  const bin = path.join(dir, 'bin.dat');
  const id2 = store.save({ file: bin, relFile: 'bin.dat', cwd: dir, text: 'text before\n' });
  fs.writeFileSync(bin, Buffer.from([1, 0, 2, 0]));
  assert.strictEqual(store.check(id2).noUndo, 'binary');
  assert.strictEqual(store.restore(id2).noUndo, 'binary');
  assert.match(store.restore(id2).error, /bin\.dat is not a text file/);
  // A file that can be kept: as before, with no noUndo field.
  const small = path.join(dir, 'small.txt');
  const id3 = store.save({ file: small, relFile: 'small.txt', cwd: dir, text: 'a\n' });
  fs.writeFileSync(small, 'b\n');
  assert.strictEqual(store.check(id3).noUndo, undefined);
  assert.ok(store.restore(id3).undo);
});

test('Remove file with no copy possible is refused, then done with noUndo', () => {
  const { dir, store } = place();
  const file = path.join(dir, 'made.bin');
  fs.writeFileSync(file, BIG);
  const refused = store.removeFile({ file, relFile: 'made.bin', cwd: dir });
  assert.strictEqual(refused.noUndo, 'large');
  assert.ok(fs.existsSync(file));
  const done = store.removeFile({ file, relFile: 'made.bin', cwd: dir, noUndo: true });
  assert.ok(done.ok && done.undo === null && !fs.existsSync(file), JSON.stringify(done).slice(0, 300));
});

// The edit, undone (only it), then grown over 2 MB: put back has no copy to keep.
function undoPlace() {
  const { dir, store } = place();
  const file = path.join(dir, 'a.txt');
  fs.writeFileSync(file, 'one\nold\n');
  const id = store.save({ file, relFile: 'a.txt', cwd: dir, text: 'one\nold\n', after: 'one\nnew\n' });
  const kept = store.save({ file, relFile: 'a.txt', cwd: dir, text: 'one\nnew\n', reason: 'undo-edit' });
  const history = [
    { type: 'change', seq: 1, file, relFile: 'a.txt', cwd: dir, backup: id },
    { type: 'change', kind: 'restore', seq: 2, file, cwd: dir, via: 'undo-edit', undidBackup: id, backup: kept },
  ];
  let seq = 2;
  const restoreEvent = (done, via, from, extra) => {
    const ev = { type: 'change', kind: 'restore', seq: ++seq, file: done.file, cwd: done.cwd, via, restoredFrom: from, backup: done.undo, ...extra };
    history.push(ev);
    return ev;
  };
  const undo = createUndo({ history, snapshots: { items: new Map() }, backups: store, restoreEvent, log: () => {} });
  fs.writeFileSync(file, BIG);
  return { dir, store, file, history, undo, restoreEvent, id };
}

test('put back (after Undo only this edit) with no copy possible is refused, then done with noUndo', () => {
  const { file, undo } = undoPlace();
  const refused = undo.putBack(1, 4);
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.noUndo, 'large', JSON.stringify(refused.body));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), BIG);
  const done = undo.putBack(1, 4, { noUndo: true });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'one\nnew\n');
});

test('through the pairing link: refused with noUndo, done when the asking computer sends noUndo', async () => {
  const { dir, store, file, history, undo, restoreEvent, id } = undoPlace();
  const host = createHostRestore({ history, backups: store, undo, restoreEvent, log: () => {}, instance: 'i1' });
  const pair = { id: 'p1', name: 'laptop', cwd: dir };
  const back = { do: 'back', seq: 1, backup: id, rel: 'a.txt', inst: 'i1' };
  const refused = host.handle(pair, back);
  assert.strictEqual(refused.body.noUndo, 'large', JSON.stringify(refused.body));
  // Restore by its copy, and its check.
  const rid = store.save({ file, relFile: 'a.txt', cwd: dir, text: 'earlier\n' });
  history.push({ type: 'change', seq: 10, file, relFile: 'a.txt', cwd: dir, backup: rid });
  assert.strictEqual(host.handle(pair, { do: 'restore', backup: rid, check: true }).body.noUndo, 'large');
  assert.strictEqual(host.handle(pair, { do: 'restore', backup: rid }).body.noUndo, 'large');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), BIG);
  assert.strictEqual(host.handle(pair, { do: 'restore', backup: rid, noUndo: true }).status, 200);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'earlier\n');

  // The asking computer: sends the flag only when its page sent it, and passes the reason back.
  const asked = [];
  const remote = createRemoteRestore({
    history: [{ type: 'change', seq: 5, file: '/there/a.txt', relFile: 'a.txt', remote: { computer: 'vps', link: 'vps', ref: { seq: 1, backup: id, rel: 'a.txt', inst: 'i1' } } }],
    pairs: { editRestore: async (name, body) => { asked.push(body); return { answer: { status: 409, body: { ok: false, error: 'a.txt is over 2 MB', noUndo: 'large' } } }; } },
    follow: () => {},
  });
  const page = { root: null };
  const plain = await remote.handle(page, { remote: true, edit: 5, id: rid }, remote.target({ remote: true, edit: 5 }));
  assert.strictEqual(plain.body.noUndo, 'large', JSON.stringify(plain.body));
  await remote.handle(page, { remote: true, edit: 5, id: rid, noUndo: true }, remote.target({ remote: true, edit: 5 }));
  assert.deepStrictEqual(asked.map((b) => b.noUndo === true), [false, true]);
});

test('POST /restore: refused with the reason, the check says it first, noUndo: true restores', async (t) => {
  const dir = path.join(stateDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'data.txt');
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await ensureServer();
  const s = new AbortController();
  streams.push(s);
  await fetch(`${config.baseUrl}/events?page=p1&root=${encodeURIComponent(dir)}`, { signal: s.signal });
  const restore = async (body) => {
    const { instance } = await getJson('/summary');
    const r = await fetch(`${config.baseUrl}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instance, page: 'p1', ...body }) });
    return { status: r.status, body: await r.json() };
  };
  fs.writeFileSync(file, 'new\n');
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file, relFile: 'data.txt', before: 'old\n', after: 'new\n', kind: 'other', stats: { added: 1, removed: 1 } });
  const edit = (await getJson('/history')).filter((e) => e.type === 'change').pop();
  fs.writeFileSync(file, BIG);
  const checked = await restore({ id: edit.backup, check: true });
  assert.strictEqual(checked.body.noUndo, 'large', JSON.stringify(checked.body));
  const refused = await restore({ id: edit.backup });
  assert.strictEqual(refused.status, 409);
  assert.strictEqual(refused.body.noUndo, 'large');
  assert.strictEqual(fs.statSync(file).size, BIG.length);
  const done = await restore({ id: edit.backup, noUndo: true });
  assert.strictEqual(done.status, 200, JSON.stringify(done.body));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'old\n');
  assert.strictEqual(done.body.undo, null);

  // Remove file: a created file over 2 MB.
  const made = path.join(dir, 'made.txt');
  fs.writeFileSync(made, BIG);
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Write', file: made, relFile: 'made.txt', created: true, after: 'x', kind: 'other' });
  const ev = (await getJson('/history')).filter((e) => e.type === 'change').pop();
  assert.strictEqual((await restore({ remove: ev.seq, check: true })).body.noUndo, 'large');
  assert.strictEqual((await restore({ remove: ev.seq })).body.noUndo, 'large');
  assert.ok(fs.existsSync(made));
  assert.strictEqual((await restore({ remove: ev.seq, noUndo: true })).status, 200);
  assert.ok(!fs.existsSync(made));
});
