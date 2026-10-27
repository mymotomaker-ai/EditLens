'use strict';
require('./isolate');
// Restore and "Undo only this edit" for an edit made on a paired computer (handoff 10.3). Two
// servers stand in for a VPS (where Claude edits) and a laptop (whose page asks): the laptop's
// /restore asks the VPS through the pairing link, the VPS does it and checks everything itself,
// and its restore shows on the laptop's page. Also: unknown edits, files outside the project, a
// wrong key, the link down, an older EditLens there, and the file's owner kept.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const tls = require('tls');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const wire = require('../lib/pairwire');
const { diffText, countStats } = require('../lib/diff');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-remote-'));
const vpsProject = path.join(base, 'vps-site');
const laptopProject = path.join(base, 'laptop-app');
const SERVER = path.join(__dirname, '..', 'server', 'server.js');
const HOST = { port: 4944, pairPort: 4945, dir: path.join(base, 'host') };
const REMOTE = { port: 4946, pairPort: 4947, dir: path.join(base, 'remote') };
const children = new Set();
const L = (...xs) => xs.join('\n') + '\n';

function request(port, method, urlPath, body, headers = {}) {
  return new Promise((resolve) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', (err) => resolve({ status: 0, json: null, error: err.code }));
    if (data) req.write(data);
    req.end();
  });
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}
function startServer(s) {
  fs.mkdirSync(s.dir, { recursive: true });
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, EDITLENS_PORT: String(s.port), EDITLENS_PAIR_PORT: String(s.pairPort), EDITLENS_STATE_DIR: s.dir }, stdio: 'ignore' });
  children.add(child);
  child.on('exit', () => children.delete(child));
  s.child = child;
  return waitFor(async () => (await request(s.port, 'GET', '/health')).status === 200);
}
function stopServer(s) {
  return new Promise((resolve) => {
    if (!s.child || s.child.exitCode !== null) return resolve();
    s.child.once('exit', () => resolve());
    s.child.kill();
  });
}
const token = (s) => fs.readFileSync(path.join(s.dir, `token-${s.port}`), 'utf8');
const api = (s, method, urlPath, body) => request(s.port, method, urlPath, body, { 'x-editlens-token': token(s) }).then((r) => r.json);
// The laptop page's own route (no key: a page).
// Requests by edit number name the server start (instance), as the page does.
const restore = async (body) => {
  const { instance } = (await request(REMOTE.port, 'GET', '/summary')).json;
  return request(REMOTE.port, 'POST', '/restore', { page: 'lp', instance, ...body });
};
function stream(s, query) {
  const events = [];
  const ac = new AbortController();
  fetch(`http://127.0.0.1:${s.port}/events?${query}`, { signal: ac.signal }).then(async (res) => {
    let buf = '';
    for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const data = buf.slice(0, i).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
        buf = buf.slice(i + 2);
        try {
          if (data) events.push(JSON.parse(data));
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
        }
      }
    }
  }).catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  return { events, close: () => ac.abort() };
}
function gitProject(dir, files) {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-q', '-m', 'start']]) {
    assert.strictEqual(spawnSync('git', ['-C', dir, ...args]).status, 0);
  }
}
// One request on the pairing link, as the laptop would send it (or with another key).
function overLink(body, { key } = {}) {
  const saved = JSON.parse(fs.readFileSync(path.join(REMOTE.dir, 'pair-remote.json'), 'utf8')).hosts[0];
  return new Promise((resolve) => {
    const socket = tls.connect({ ...wire.TLS, host: '127.0.0.1', port: HOST.pairPort, checkServerIdentity: () => undefined,
      pskCallback: () => ({ psk: key || Buffer.from(saved.key, 'hex'), identity: saved.id }) });
    socket.once('secureConnect', () => {
      wire.writeLine(socket, { t: 'task' });
      wire.writeLine(socket, body);
      wire.readHeader(socket, 5000, wire.BODY_MAX).then((a) => {
        socket.destroy();
        resolve(a);
      }, (err) => {
        socket.destroy();
        resolve({ failed: err.message });
      });
    });
    socket.once('error', (err) => resolve({ failed: err.code || err.message }));
  });
}

test('restore and undo only this edit, for edits made on a paired computer', async (t) => {
  gitProject(vpsProject, { 'index.html': L('<h1>VPS</h1>', 'a', 'b', 'c', 'd', '<p>end</p>') });
  fs.mkdirSync(laptopProject, { recursive: true });
  await startServer(HOST);
  await startServer(REMOTE);
  const servers = [];
  t.after(() => {
    for (const c of children) c.kill();
    for (const s of servers) s.close();
    fs.rmSync(base, { recursive: true, force: true });
  });
  await api(HOST, 'POST', '/event', { type: 'session', sessionId: 'v1', cwd: vpsProject, ts: Date.now() });
  const { code } = await api(HOST, 'POST', '/pair', { cwd: vpsProject });
  assert.ok((await api(REMOTE, 'POST', '/join', { address: `127.0.0.1:${HOST.pairPort}`, code })).ok);
  const page = stream(REMOTE, `page=lp&root=${encodeURIComponent(laptopProject)}`);
  t.after(() => page.close());
  await waitFor(() => page.events.some((e) => e.type === 'hello'));
  await api(REMOTE, 'GET', '/remote/tasks?follow=');

  // Claude on the VPS edits a file in its project (the hook's event; the file is written as it says).
  const vpsFile = (rel) => path.join(vpsProject, rel);
  const disk = (rel = 'index.html') => fs.readFileSync(vpsFile(rel), 'utf8');
  async function vpsEdit(rel, next, intent, extra = {}) {
    const file = path.isAbsolute(rel) ? rel : vpsFile(rel);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, next);
    const hunks = diffText(before, next);
    await api(HOST, 'POST', '/event', { type: 'change', sessionId: 'v1', cwd: vpsProject, file, relFile: path.relative(vpsProject, file), tool: 'Edit', intent,
      before, after: next, hunks, stats: countStats(hunks), ts: Date.now(), ...extra });
    const vps = (await api(HOST, 'GET', '/history')).filter((e) => e.type === 'change' && e.file === file).pop();
    return vps;
  }
  const remoteCard = (intent) => waitFor(() => page.events.find((e) => e.type === 'change' && e.remote && e.intent === intent));
  const remoteRestores = () => page.events.filter((e) => e.type === 'change' && e.remote && e.kind === 'restore');
  const nextRestore = async (n) => waitFor(() => remoteRestores().length > n && remoteRestores()[n]);

  const v1 = await vpsEdit('index.html', L('<h1>VPS site</h1>', 'a', 'b', 'c', 'd', '<p>end</p>'), 'Bigger heading');
  const c1 = await remoteCard('Bigger heading');
  assert.ok(c1, 'the edit shows on the laptop page');
  assert.ok(v1.backup, 'the VPS kept its earlier copy');
  assert.strictEqual(c1.backup, v1.backup, 'the card includes the copy id there (the page keys its Restore by it)');
  // inst: that server's run (Sol M1), so a ref from before it restarted matches no new edit.
  assert.match(String(c1.remote.ref.inst), /^[0-9a-f]{16}$/);
  assert.deepStrictEqual(c1.remote.ref, { seq: v1.seq, backup: v1.backup, rel: 'index.html', inst: c1.remote.ref.inst });
  assert.ok(!c1.remote.old);

  await t.test('restore: check, run, undo the restore; the result shows on the laptop page', async () => {
    const chk = await restore({ remote: true, edit: c1.seq, id: c1.backup, check: true });
    assert.strictEqual(chk.status, 200, JSON.stringify(chk.json));
    assert.deepStrictEqual([chk.json.ok, chk.json.exists, chk.json.same, chk.json.readOnly], [true, true, false, false]);
    assert.strictEqual(disk(), L('<h1>VPS site</h1>', 'a', 'b', 'c', 'd', '<p>end</p>'), 'a check changes nothing');
    const n = remoteRestores().length;
    const r = await restore({ remote: true, edit: c1.seq, id: c1.backup });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.ok && r.json.via === 'restore' && /^b[0-9a-f]{16}$/.test(r.json.undo), JSON.stringify(r.json));
    assert.match(r.json.relFile, /^◆ .+: index\.html$/, 'named as the card names it');
    assert.strictEqual(disk(), L('<h1>VPS</h1>', 'a', 'b', 'c', 'd', '<p>end</p>'), 'the VPS file is back as before the edit');
    const ev = await nextRestore(n);
    assert.ok(ev, 'the restore shows on the laptop page');
    assert.strictEqual(ev.via, 'restore');
    assert.strictEqual(ev.restoredFrom, c1.backup, 'it marks the card of the edit it restored');
    assert.strictEqual(ev.backup, r.json.undo, 'its own Undo is the copy kept there');
    assert.ok(ev.snapshot, 'the code view can show it');
    assert.ok(!ev.agentId, 'a restore is not Claude\'s');
    // Undo the restore: by the copy the restore kept, on the restore's own card.
    const u = await restore({ remote: true, edit: ev.seq, id: ev.backup });
    assert.ok(u.json.ok && u.json.via === 'undo', JSON.stringify(u.json));
    assert.strictEqual(disk(), L('<h1>VPS site</h1>', 'a', 'b', 'c', 'd', '<p>end</p>'));
    const ev2 = await nextRestore(n + 1);
    assert.strictEqual(ev2.via, 'undo');
    assert.strictEqual(ev2.restoredFrom, ev.backup);
  });

  await t.test('undo only this edit: clean, then put back', async () => {
    const v2 = await vpsEdit('index.html', L('<h1>VPS site</h1>', 'a', 'b', 'c', 'd', '<p>The end</p>'), 'Longer ending');
    const c2 = await remoteCard('Longer ending');
    const chk = await restore({ undoEdit: c1.seq, check: true });
    assert.strictEqual(chk.status, 200);
    assert.ok(chk.json.ok && chk.json.clean && !chk.json.same, JSON.stringify(chk.json));
    assert.deepStrictEqual(chk.json.lines, [1, 1]);
    const n = remoteRestores().length;
    const r = await restore({ undoEdit: c1.seq });
    assert.ok(r.json.ok && r.json.via === 'undo-edit', JSON.stringify(r.json));
    assert.strictEqual(disk(), L('<h1>VPS</h1>', 'a', 'b', 'c', 'd', '<p>The end</p>'), 'only that edit is removed; the later one stays');
    const ev = await nextRestore(n);
    assert.strictEqual(ev.via, 'undo-edit');
    assert.strictEqual(ev.undidBackup, c1.backup, 'it marks the card of the edit it undid');
    assert.strictEqual(ev.undidSeq, c1.seq, 'in this page\'s numbers');
    const back = await restore({ undoEdit: c1.seq, back: true });
    assert.ok(back.json.ok, JSON.stringify(back.json));
    assert.strictEqual(disk(), L('<h1>VPS site</h1>', 'a', 'b', 'c', 'd', '<p>The end</p>'), 'put back');
    const ev2 = await nextRestore(n + 1);
    assert.strictEqual(ev2.via, 'undo');
    assert.ok(v2.backup && c2.remote.ref.seq === v2.seq);
  });

  await t.test('undo only this edit: a conflict is said, nothing changes', async () => {
    await vpsEdit('index.html', L('<h1>VPS site</h1>', 'a', 'b', 'c', 'd', '<p>The very end</p>'), 'Even longer ending');
    const c2 = await remoteCard('Longer ending');
    const before = disk();
    const chk = await restore({ undoEdit: c2.seq, check: true });
    assert.strictEqual(chk.status, 200);
    assert.ok(!chk.json.ok && chk.json.conflict, JSON.stringify(chk.json));
    const run = await restore({ undoEdit: c2.seq });
    assert.strictEqual(run.status, 409);
    assert.ok(run.json.conflict);
    assert.strictEqual(disk(), before, 'the file is not changed');
  });

  await t.test('a file Claude created there: Remove file, and its Undo', async () => {
    const v = await vpsEdit('notes.txt', 'new file\n', 'Add notes', { created: true });
    const c = await remoteCard('Add notes');
    assert.ok(c.created && c.remote.ref && c.remote.ref.backup === null && !c.backup, JSON.stringify(c.remote));
    assert.strictEqual(c.remote.ref.seq, v.seq);
    const chk = await restore({ remove: c.seq, check: true });
    assert.ok(chk.json.ok && chk.json.exists, JSON.stringify(chk.json));
    assert.ok(fs.existsSync(vpsFile('notes.txt')), 'a check removes nothing');
    const n = remoteRestores().length;
    const r = await restore({ remove: c.seq });
    assert.ok(r.json.ok && r.json.deleted && r.json.undo, JSON.stringify(r.json));
    assert.ok(!fs.existsSync(vpsFile('notes.txt')));
    const ev = await nextRestore(n);
    assert.strictEqual(ev.via, 'remove');
    assert.strictEqual(ev.removedSeq, c.seq, 'it marks the card of the edit that created it, in this page\'s numbers');
    const u = await restore({ remote: true, edit: c.seq, id: r.json.undo });
    assert.ok(u.json.ok, JSON.stringify(u.json));
    assert.strictEqual(disk('notes.txt'), 'new file\n', 'the file is back');
  });

  await t.test('unknown edits, files outside the project and wrong keys are refused there', async () => {
    // On the laptop: an edit number it doesn't have.
    const none = await restore({ undoEdit: 999999, check: true });
    assert.strictEqual(none.status, 404);
    const noCard = await restore({ remote: true, edit: 999999, id: c1.backup });
    assert.strictEqual(noCard.status, 404);
    // On the VPS, as if the laptop sent them: a number it doesn't have, a copy it doesn't have,
    // and a number whose copy or file differs (its numbers start again after a restart).
    for (const body of [
      { op: 'edit-restore', do: 'undo', seq: 999999, backup: c1.backup, rel: 'index.html', inst: c1.remote.ref.inst, check: true },
      { op: 'edit-restore', do: 'restore', backup: 'b0000000000000000', check: true },
      { op: 'edit-restore', do: 'undo', seq: c1.remote.ref.seq, backup: 'b0000000000000000', rel: 'index.html', inst: c1.remote.ref.inst, check: true },
      { op: 'edit-restore', do: 'undo', seq: c1.remote.ref.seq, backup: c1.backup, rel: 'other.html', inst: c1.remote.ref.inst, check: true },
    ]) {
      const a = await overLink(body);
      assert.strictEqual(a.status, 404, JSON.stringify([body, a]));
    }
    // An older EditLens (no server start id): refused, with what to do (Sol M3).
    const older = await overLink({ op: 'edit-restore', do: 'undo', seq: c1.remote.ref.seq, backup: c1.backup, rel: 'index.html', check: true });
    assert.strictEqual(older.status, 409, JSON.stringify(older));
    assert.strictEqual((await overLink({ op: 'edit-restore', do: 'rm -rf', seq: 1 })).status, 400);
    // A session there working outside the paired project: never touched through the link.
    const elsewhere = path.join(base, 'pulse');
    fs.mkdirSync(elsewhere);
    const out = path.join(elsewhere, 'outside.txt');
    fs.writeFileSync(out, 'one\n');
    const vo = await vpsEdit(out, 'two\n', 'Outside edit');
    assert.ok(vo.backup, 'it has a copy there (its own page can restore it)');
    const rel = path.relative(vpsProject, out);
    for (const body of [
      { op: 'edit-restore', do: 'restore', backup: vo.backup },
      { op: 'edit-restore', do: 'undo', seq: vo.seq, backup: vo.backup, rel, inst: c1.remote.ref.inst },
      { op: 'edit-restore', do: 'remove', seq: vo.seq, backup: vo.backup, rel, inst: c1.remote.ref.inst },
    ]) {
      const a = await overLink(body);
      assert.strictEqual(a.status, 403, JSON.stringify([body, a]));
    }
    assert.strictEqual(fs.readFileSync(out, 'utf8'), 'two\n', 'the file outside the project is not changed');
    // Not through the link: a wrong key gets no response at all.
    const bad = await overLink({ op: 'edit-restore', do: 'restore', backup: c1.backup }, { key: crypto.randomBytes(32) });
    assert.ok(bad.failed, JSON.stringify(bad));
    // And no HTTP route on the VPS does it, even with its key.
    assert.strictEqual((await request(HOST.port, 'POST', '/edit-restore', { do: 'restore', backup: c1.backup }, { 'x-editlens-token': token(HOST) })).status, 404);
  });

  await t.test('the file keeps its owner and mode', { skip: typeof process.getuid !== 'function' || process.getuid() !== 0 ? 'needs root' : false }, async () => {
    const rel = 'task-owned.txt';
    fs.writeFileSync(vpsFile(rel), L('x', 'y'));
    fs.chownSync(vpsFile(rel), 65534, 65534);
    fs.chmodSync(vpsFile(rel), 0o640);
    await vpsEdit(rel, L('x', 'Y'), 'Owned edit');
    fs.chownSync(vpsFile(rel), 65534, 65534);
    const c = await remoteCard('Owned edit');
    const r = await restore({ remote: true, edit: c.seq, id: c.backup });
    assert.ok(r.json.ok, JSON.stringify(r.json));
    const st = fs.statSync(vpsFile(rel));
    assert.strictEqual(disk(rel), L('x', 'y'));
    assert.deepStrictEqual([st.uid, st.gid, st.mode & 0o7777], [65534, 65534, 0o640], 'not root\'s, same mode');
    // Undo only this edit writes the same way.
    await vpsEdit(rel, L('x', 'Z'), 'Owned edit 2');
    const c2 = await remoteCard('Owned edit 2');
    const u = await restore({ undoEdit: c2.seq });
    assert.ok(u.json.ok, JSON.stringify(u.json));
    const st2 = fs.statSync(vpsFile(rel));
    assert.deepStrictEqual([st2.uid, st2.gid, st2.mode & 0o7777], [65534, 65534, 0o640]);
  });

  await t.test('the link down: said, nothing changes', async () => {
    const before = disk();
    await stopServer(HOST);
    for (const body of [{ remote: true, edit: c1.seq, id: c1.backup, check: true }, { undoEdit: c1.seq, check: true }]) {
      const r = await restore(body);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.ok(!r.json.ok && r.json.blocked, JSON.stringify(r.json));
      assert.match(r.json.error, /^[\w-]+ is not connected\. Try again when it reconnects\.$/);
    }
    const run = await restore({ remote: true, edit: c1.seq, id: c1.backup });
    assert.strictEqual(run.status, 409);
    assert.match(run.json.error, / is not connected/);
    assert.strictEqual(disk(), before);
  });

  await t.test('an older EditLens there: said, never sent', async () => {
    // A paired computer on 0.24.29: its edits have no ref, and it does not know the request.
    // A stand-in that uses the pairing protocol replaces the VPS.
    const saved = JSON.parse(fs.readFileSync(path.join(REMOTE.dir, 'pair-remote.json'), 'utf8')).hosts[0];
    const asked = [];
    let sent = false;
    const old = tls.createServer({ ...wire.TLS, pskCallback: (s, id) => (id === saved.id ? Buffer.from(saved.key, 'hex') : null) }, async (socket) => {
      socket.on('error', () => socket.destroy());
      const head = await wire.readHeader(socket).catch(() => null);
      if (!head) return socket.destroy();
      if (head.t === 'ping') {
        wire.writeLine(socket, { ok: true, protocol: wire.PROTOCOL, version: '0.24.29', name: 'oldvps', site: false });
        return socket.end();
      }
      if (head.t !== 'task') return socket.destroy();
      const body = await wire.readHeader(socket, 5000, wire.BODY_MAX).catch(() => null);
      if (!body) return socket.destroy();
      asked.push(body.op);
      if (body.op === 'watch-all') {
        if (!sent) {
          sent = true;
          const one = { kind: 'session', rel: 'a.txt', file: '/srv/old/a.txt', tool: 'Edit', intent: 'Old edit', before: 'a\n', after: 'b\n', stats: { added: 1, removed: 1 }, ts: Date.now(), fseq: 5 };
          // One with a ref too: a newer EditLens there that was put back to an older one.
          const two = { ...one, rel: 'b.txt', file: '/srv/old/b.txt', intent: 'Old edit with ref', fseq: 6, ref: { seq: 3, backup: 'b1111111111111111' } };
          wire.writeLine(socket, { computer: 'oldvps', seq: 1, tasks: [], edits: [one, two], editSeq: 6 });
          return socket.end();
        }
        await new Promise((r) => setTimeout(r, 1000));
        wire.writeLine(socket, { computer: 'oldvps', seq: 1, tasks: [], edits: [], editSeq: 6 });
        return socket.end();
      }
      wire.writeLine(socket, { error: `Unknown op "${body.op}".` });
      return socket.end();
    });
    servers.push(old);
    await new Promise((r) => old.listen(0, '127.0.0.1', r));
    await stopServer(REMOTE);
    const file = path.join(REMOTE.dir, 'pair-remote.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.hosts[0].port = old.address().port;
    fs.writeFileSync(file, JSON.stringify(data));
    page.close();
    await startServer(REMOTE);
    const p2 = stream(REMOTE, `page=lp&root=${encodeURIComponent(laptopProject)}`);
    t.after(() => p2.close());
    await waitFor(() => p2.events.some((e) => e.type === 'hello'));
    await api(REMOTE, 'GET', '/remote/tasks?follow=');
    const a = await waitFor(() => p2.events.find((e) => e.type === 'change' && e.intent === 'Old edit'));
    const b = await waitFor(() => p2.events.find((e) => e.type === 'change' && e.intent === 'Old edit with ref'));
    assert.ok(a && b);
    assert.ok(a.remote.old && !a.remote.ref && !a.backup, 'no ref: an older EditLens there');
    const OLD = /^Update EditLens on oldvps to restore its edits\.$/;
    const r1 = await restore({ undoEdit: a.seq, check: true });
    assert.ok(r1.json.blocked && OLD.test(r1.json.error), JSON.stringify(r1.json));
    assert.ok(!asked.includes('edit-restore'), 'not sent: the laptop knows already');
    const r2 = await restore({ remote: true, edit: b.seq, id: b.backup, check: true });
    assert.ok(r2.json.blocked && OLD.test(r2.json.error), JSON.stringify(r2.json));
    assert.ok(asked.includes('edit-restore'), 'sent, and refused there as unknown');
    const r3 = await restore({ undoEdit: b.seq });
    assert.strictEqual(r3.status, 409);
    assert.match(r3.json.error, OLD);
  });
});
