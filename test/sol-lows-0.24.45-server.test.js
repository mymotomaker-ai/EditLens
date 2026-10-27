'use strict';
require('./isolate');
// Sol scan of 0.24.45, Lows L1 and L4 (L3 is in sol-paired-0.24.45.test.js). L1: the line counts on
// a paired computer's task card and the count /disconnect answers are checked numbers (a sum past
// the largest number, or a count sent as text, is not used). L4: a transcript line that is JSON but
// not an object (null, a list) is skipped, and the rest of the batch is read. No fixed port: the
// stand-in server takes a free one.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
function tmpDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// cardFiles in server/server.js, run alone (the server itself starts on load).
function cardFiles() {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'server.js'), 'utf8');
  const fn = /^function cardFiles\(c\) \{[\s\S]*?^\}$/m.exec(src);
  assert.ok(fn, 'cardFiles is in server.js');
  const box = { worktree: { withoutCopy: (rel) => rel } };
  vm.runInNewContext(`${fn[0]}\nthis.cardFiles = cardFiles;`, box);
  return box.cardFiles;
}

test('L1: task card line counts that add up past the largest number are unknown, not Infinity', () => {
  const files = cardFiles();
  const big = Number.MAX_VALUE;
  const out = files({ editCount: 2, edits: [{ relFile: 'a.js', added: big, removed: 1 }, { relFile: 'b.js', added: big, removed: 2 }] });
  assert.strictEqual(out.count, 2);
  assert.strictEqual(out.added, null, `added: ${out.added}`);
  assert.strictEqual(out.removed, null);
  // Counts that are not whole numbers are not counts.
  assert.strictEqual(files({ edits: [{ relFile: 'a.js', added: 1.5, removed: 0 }] }).added, null);
  assert.deepStrictEqual({ ...files({ edits: [{ relFile: 'a.js', added: 3, removed: 1 }, { relFile: 'b.js', added: '2', removed: 0 }] }) }, { count: 2, added: 5, removed: 1 });
});

test('L1: /editlens stop counts only whole numbers from /disconnect', async (t) => {
  const state = tmpDir(t, 'editlens-l1-stop-');
  const project = tmpDir(t, 'editlens-l1-project-');
  // A stand-in EditLens that says it stopped "0" (text, not a number) connections.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url.startsWith('/health')) return res.end(JSON.stringify({ ok: true, version: require('../package.json').version }));
    if (req.url.startsWith('/connections')) return res.end('[]');
    if (req.url.startsWith('/disconnect')) return res.end(JSON.stringify({ stopped: '0' }));
    return res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const port = server.address().port;
  fs.writeFileSync(path.join(state, `token-${port}`), 'stand-in-key');
  const out = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(ROOT, 'bin', 'connect.js'), 'stop'], {
      cwd: project, timeout: 30000, env: { ...process.env, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: state, CLAUDE_PROJECT_DIR: project },
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, text: stdout + stderr }));
  });
  assert.match(out.text, /nothing was connected with \/editlens here/, out.text);
  assert.doesNotMatch(out.text, /disconnected/, out.text);
});

test('L4: a transcript line that is null or a list is skipped, and the rest of the batch is read', async (t) => {
  const { SessionWatcher } = require('../server/transcript');
  const dir = tmpDir(t, 'editlens-l4-');
  const file = path.join(dir, 'session.jsonl');
  const user = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
  fs.writeFileSync(file, ['null', '[1,2]', '"text"', '7', user('first question here')].join('\n') + '\n');
  const events = [];
  const w = new SessionWatcher({ sessionId: 'l4', transcriptPath: file, cwd: dir, emit: (ev) => events.push(ev) });
  t.after(() => w.stop());
  w.start();
  fs.appendFileSync(file, ['null', user('second question here')].join('\n') + '\n');
  const end = Date.now() + 5000;
  while (!events.some((e) => e.text === 'second question here') && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  assert.ok(events.some((e) => e.text === 'first question here'), JSON.stringify(events));
  assert.ok(events.some((e) => e.text === 'second question here'), JSON.stringify(events));
  // A subagent's meta file that is JSON null: no details, not an error.
  fs.mkdirSync(w.subDir, { recursive: true });
  fs.writeFileSync(path.join(w.subDir, 'agent-x1.meta.json'), 'null');
  assert.deepStrictEqual(w.readMeta('x1'), {});
});
