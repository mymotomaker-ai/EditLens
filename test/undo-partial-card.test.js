'use strict';
require('./isolate');
// Sol M6 (0.24.45), the tools' side: undo_computer_task_apply and undo_computer_task_merge mark the
// task card undone only when no file was kept. A file kept (changed, in use) keeps the card's Undo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { sha } = require('../lib/sendproject');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-undo-card-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// A stand-in EditLens server: records the card notes, answers undo-merge with `merge`.
async function stub(merge) {
  const notes = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const data = JSON.parse(body || '{}');
      if (req.url === '/remote/task-applied') notes.push(data);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(req.url === '/remote/task' && data.op === 'undo-merge' ? merge : { ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, notes, port: server.address().port };
}

async function callTool({ port, project, stateDir }, name, args) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: stateDir, EDITLENS_NO_START: '1' } });
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  const started = Date.now();
  while (!buf.includes('\n') && Date.now() - started < 10000) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  return JSON.parse(buf.split('\n')[0]).result;
}

test('an apply undone with a file kept: the card is not marked undone; all put back: it is', async () => {
  const { server, notes, port } = await stub({});
  try {
    const project = fs.mkdtempSync(path.join(root, 'site-'));
    const stateDir = fs.mkdtempSync(path.join(root, 'state-'));
    fs.writeFileSync(path.join(project, 'a.txt'), 'new a');
    fs.writeFileSync(path.join(project, 'b.txt'), 'changed since');
    const jdir = path.join(stateDir, 'applies', 'aaaaaaaaaaaa');
    fs.mkdirSync(jdir, { recursive: true });
    const files = [
      { path: 'a.txt', existed: false, kept: null, wrote: sha(Buffer.from('new a')), landed: true },
      { path: 'b.txt', existed: false, kept: null, wrote: sha(Buffer.from('new b')), landed: true },
    ];
    fs.writeFileSync(path.join(jdir, 'journal.json'), JSON.stringify({ dir: project, files }));
    const first = await callTool({ port, project, stateDir }, 'undo_computer_task_apply', { apply: 'aaaaaaaaaaaa' });
    assert.ok(!first.isError, JSON.stringify(first));
    assert.ok(!fs.existsSync(path.join(project, 'a.txt')), 'a.txt put back (removed)');
    assert.deepStrictEqual(notes.filter((n) => n.undone), [], 'b.txt was kept: the card keeps its Undo');
    // b.txt back as the apply left it: the next undo puts it back and marks the card.
    fs.writeFileSync(path.join(project, 'b.txt'), 'new b');
    await callTool({ port, project, stateDir }, 'undo_computer_task_apply', { apply: 'aaaaaaaaaaaa' });
    assert.strictEqual(notes.filter((n) => n.undone).length, 1);
  } finally {
    server.close();
  }
});

test('a merge undone in part (partial): the card is not marked undone; in full: it is', async () => {
  const project = fs.mkdtempSync(path.join(root, 'site-'));
  const stateDir = fs.mkdtempSync(path.join(root, 'state-'));
  const part = await stub({ undone: ['a.txt'], kept: [{ path: 'b.txt', why: 'EBUSY' }], partial: true });
  try {
    await callTool({ port: part.port, project, stateDir }, 'undo_computer_task_merge', { computer: 'vps', task: 'abcdef12' });
    assert.deepStrictEqual(part.notes.filter((n) => n.undone), []);
  } finally {
    part.server.close();
  }
  const full = await stub({ undone: ['a.txt', 'b.txt'], kept: [] });
  try {
    await callTool({ port: full.port, project, stateDir }, 'undo_computer_task_merge', { computer: 'vps', task: 'abcdef12' });
    assert.strictEqual(full.notes.filter((n) => n.undone).length, 1);
  } finally {
    full.server.close();
  }
});
