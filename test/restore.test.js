'use strict';
require('./isolate');
// Restore is sent as an edit: the live server writes the file, then sends a normal change event of
// kind 'restore' (with the text before and after), so the code view plays it, other tabs see it and
// it can be undone from its own card. Edits with an earlier copy are listed again after a restart.
// A read-only file is refused, a failed write leaves no stray copy, a created file can be removed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-restore-state-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4914';
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');
const config = require('../lib/config');
const { BackupStore, skipReason } = require('../server/backups');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-restore-'));

test('backups: restore says what it replaced; read-only files and failed writes', () => {
  const dir = tmp();
  try {
    const store = new BackupStore(path.join(dir, 'backups'));
    const file = path.join(dir, 'a.js');
    fs.writeFileSync(file, 'new\n');
    const id = store.save({ file, relFile: 'a.js', cwd: dir, text: 'old\n' });
    assert.deepStrictEqual(store.check(id), { ok: true, file, relFile: 'a.js', cwd: dir, exists: true, same: false, readOnly: false });

    // Read-only: refused, nothing written, no copy kept.
    const before = store.list().length;
    fs.chmodSync(file, 0o444);
    assert.strictEqual(store.check(id).readOnly, true);
    const ro = store.restore(id);
    assert.match(ro.error || '', /a\.js is read-only/, JSON.stringify(ro));
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'new\n');
    assert.strictEqual(store.list().length, before, 'no undo copy for a refused restore');
    fs.chmodSync(file, 0o644);

    // A write that fails: a readable error, and the undo copy is removed again.
    const rename = fs.renameSync;
    fs.renameSync = () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }); };
    let failed;
    try {
      failed = store.restore(id);
    } finally {
      fs.renameSync = rename;
    }
    assert.strictEqual(failed.error, 'Could not write a.js: EROFS');
    assert.strictEqual(store.list().length, before, 'no stray copy after a failed write');

    const r = store.restore(id);
    assert.ok(r.ok && r.undo, JSON.stringify(r));
    assert.deepStrictEqual([r.before, r.after, r.reason, r.missing], ['new\n', 'old\n', 'edit', false]);
    assert.strictEqual(store.restore(r.undo).reason, 'restore', 'restoring the undo copy is an undo');
    assert.match(store.restore('b0000000000000000').error, /no longer kept \(EditLens keeps the last 200\)/);
    assert.ok(store.restore('b0000000000000000').gone);

    // A file Claude created: removed, and its copy creates it again.
    const made = path.join(dir, 'made.js');
    fs.writeFileSync(made, 'made\n');
    const rm = store.removeFile({ file: made, relFile: 'made.js', cwd: dir });
    assert.ok(rm.ok && rm.undo && !fs.existsSync(made), JSON.stringify(rm));
    assert.match(store.removeFile({ file: made, relFile: 'made.js', cwd: dir }).error, /already gone/);
    const back = store.restore(rm.undo);
    assert.ok(back.ok && back.missing && back.before === null);
    assert.strictEqual(fs.readFileSync(made, 'utf8'), 'made\n');

    assert.strictEqual(skipReason('a\u0000b'), 'binary');
    assert.strictEqual(skipReason('x'.repeat(2 * 1024 * 1024 + 1)), 'large');
    assert.strictEqual(skipReason(undefined, 3 * 1024 * 1024), 'large');
    assert.strictEqual(skipReason(undefined, NaN), null);
    assert.strictEqual(skipReason('fine'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a restore is a change event of kind restore, played like an edit; listed again after a restart', async (t) => {
  const dir = path.join(stateDir, 'proj');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'app.js');
  const OLD = 'const title = "Hello";\n';
  const NEW = 'const title = "Hi there";\n';
  fs.writeFileSync(file, NEW);
  const streams = [];
  t.after(async () => {
    for (const s of streams) s.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  await ensureServer();
  const open = async () => {
    const s = new AbortController();
    streams.push(s);
    await fetch(`${config.baseUrl}/events?page=p1&root=${encodeURIComponent(dir)}`, { signal: s.signal });
  };
  await open();
  // Requests by edit number name the server start (instance), as the page does.
  const restore = async (body) => {
    const { instance } = await getJson('/summary');
    const r = await fetch(`${config.baseUrl}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instance, ...body }) });
    return { status: r.status, body: await r.json() };
  };
  const changes = async () => (await getJson('/history')).filter((e) => e.type === 'change');

  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file, relFile: 'app.js', before: OLD, after: NEW, kind: 'frontend', stats: { added: 1, removed: 1 } });
  const edit = (await changes()).pop();
  assert.match(edit.backup || '', /^b[0-9a-f]{16}$/);

  const checked = await restore({ page: 'p1', id: edit.backup, check: true });
  assert.deepStrictEqual([checked.status, checked.body.exists, checked.body.same], [200, true, false]);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), NEW, 'a check changes nothing');

  const r = await restore({ page: 'p1', id: edit.backup });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), OLD);
  const ev = (await changes()).pop();
  assert.strictEqual(ev.kind, 'restore');
  assert.strictEqual(ev.via, 'restore');
  assert.strictEqual(ev.intent, 'Restored 1 line', 'a changed line counts once');
  assert.strictEqual(ev.restoredFrom, edit.backup);
  assert.strictEqual(ev.backup, r.body.undo, 'its own Restore is the undo copy (no second copy)');
  assert.strictEqual(ev.seq, r.body.seq);
  assert.ok(!ev.overlap, 'a restore is never "another agent edited this file"');
  assert.deepStrictEqual(ev.hunks[0].lines, ['-const title = "Hi there";', '+const title = "Hello";']);
  const snap = await getJson(`/snapshot?id=${ev.snapshot}&instance=${(await getJson('/summary')).instance}`);
  assert.deepStrictEqual([snap.before, snap.after], [NEW, OLD], 'the code view gets the text to play');

  const undo = await restore({ page: 'p1', id: r.body.undo });
  assert.strictEqual(undo.body.via, 'undo');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), NEW);
  const undone = (await changes()).pop();
  assert.deepStrictEqual([undone.kind, undone.intent, undone.restoredFrom], ['restore', 'Undid restore', r.body.undo]);

  // Restore of an id that is gone: 404 with gone, so the page can remove its Restore button.
  const gone = await restore({ page: 'p1', id: 'b0000000000000000' });
  assert.deepStrictEqual([gone.status, gone.body.gone], [404, true]);

  // A binary file: no copy, and the event says why.
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file: path.join(dir, 'bin.dat'), relFile: 'bin.dat', before: 'a\u0000b', after: 'c', kind: 'other' });
  const bin = (await changes()).pop();
  assert.deepStrictEqual([bin.backup, bin.backupSkipped], [undefined, 'binary']);

  // A file Claude created: Remove file deletes it, as an event; restoring its copy creates it again.
  const made = path.join(dir, 'made.js');
  fs.writeFileSync(made, 'made\n');
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Write', file: made, relFile: 'made.js', created: true, before: '', after: 'made\n', kind: 'other' });
  const created = (await changes()).pop();
  assert.strictEqual((await restore({ page: 'p1', remove: 999999 })).status, 404);
  assert.strictEqual((await restore({ page: 'p1', remove: edit.seq })).status, 404, 'only a created file can be removed');
  const rm = await restore({ page: 'p1', remove: created.seq });
  assert.strictEqual(rm.status, 200, JSON.stringify(rm.body));
  assert.ok(!fs.existsSync(made));
  const rmEv = (await changes()).pop();
  assert.deepStrictEqual([rmEv.kind, rmEv.via, rmEv.deleted, rmEv.backup], ['restore', 'remove', true, rm.body.undo]);
  assert.strictEqual((await restore({ page: 'p1', id: rm.body.undo })).body.via, 'undo');
  assert.strictEqual(fs.readFileSync(made, 'utf8'), 'made\n');

  // Restart: the edits with an earlier copy are listed again (marked earlier), without a pruned one.
  const kept = (await changes()).filter((e) => e.backup).map((e) => e.backup);
  fs.unlinkSync(path.join(stateDir, 'backups', r.body.undo + '.json'));
  for (const s of streams) s.abort();
  await stopServer();
  await ensureServer();
  const again = await changes();
  assert.ok(again.length > 0 && again.every((e) => e.earlier && e.backup), JSON.stringify(again.map((e) => [e.seq, e.backup])));
  assert.deepStrictEqual(again.map((e) => e.backup), kept.filter((b) => b !== r.body.undo));
  assert.ok(again.every((e) => !e.snapshot), 'no old snapshot ids');
  const back = await restore({ page: 'p1', id: edit.backup }).catch(() => null);
  assert.ok(back && back.status === 403, 'the page must register again first');
  await open();
  const after = await restore({ page: 'p1', id: edit.backup });
  assert.strictEqual(after.status, 200, JSON.stringify(after.body));
  assert.strictEqual(fs.readFileSync(file, 'utf8'), OLD, 'Restore from a listed earlier edit works');
  // A damaged list starts over, and the server still starts.
  await stopServer();
  fs.writeFileSync(path.join(stateDir, 'backups', 'edits.json'), '{broken');
  await ensureServer();
  assert.deepStrictEqual(await changes(), []);
});
