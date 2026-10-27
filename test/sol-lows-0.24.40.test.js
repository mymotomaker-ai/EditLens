'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5280';
// Low findings L2, L3, L19 and L20 of the Sol scan of 0.24.40 (findings-0.24.40-sol.md): catches that
// ignored errors they did not expect, and numbers from files or answers used without a finite check.
// Each test was run on the code before its fix.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-sol-l-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
const newDir = () => {
  const d = path.join(base, String(++n));
  fs.mkdirSync(d, { recursive: true });
  return d;
};
// An error with a code that is not a file system error (no syscall), as a bug in Node's arguments gives.
const notFsError = () => Object.assign(new Error('not a file system error'), { code: 'ERR_TEST_NOT_FS' });

// Replaces obj[name] with fake while fn runs.
async function stubbed(obj, name, fake, fn) {
  const real = obj[name];
  obj[name] = fake(real);
  try {
    return await fn();
  } finally {
    obj[name] = real;
  }
}

// ---------- rule a: catches ----------

test('L3 lib/atomic.js: withLock throws an error it does not expect while checking the lock', async () => {
  const { withLock } = require('../lib/atomic');
  const file = path.join(newDir(), 'list.json');
  fs.writeFileSync(`${file}.lock`, '');
  const result = await stubbed(fs, 'statSync', (real) => (p, ...rest) => {
    if (String(p).endsWith('.lock')) throw notFsError();
    return real(p, ...rest);
  }, () => {
    try {
      return withLock(file, () => 'ran');
    } catch (err) {
      return err;
    }
  });
  assert.ok(result instanceof Error && result.code === 'ERR_TEST_NOT_FS', String(result));
});

test('L3 lib/atomic.js: withLock still waits when the lock is removed while it is checked', () => {
  const { withLock } = require('../lib/atomic');
  const file = path.join(newDir(), 'list.json');
  assert.strictEqual(withLock(file, () => 'ran'), 'ran');
});

test('L3 server/board.js: loadRecent skips a board it cannot read, and throws other errors', async () => {
  const { Boards } = require('../server/board');
  const dir = newDir();
  fs.writeFileSync(path.join(dir, 'a.jsonl'), '');
  const boards = new Boards({ dir });
  const run = (err) => stubbed(fs, 'statSync', (real) => (p, ...rest) => {
    if (String(p).endsWith('a.jsonl')) throw err;
    return real(p, ...rest);
  }, () => {
    try {
      boards.loadRecent();
      return null;
    } catch (e) {
      return e;
    }
  });
  assert.strictEqual(await run(Object.assign(new Error('gone'), { code: 'ENOENT', syscall: 'stat' })), null);
  const thrown = await run(notFsError());
  assert.ok(thrown && thrown.code === 'ERR_TEST_NOT_FS', String(thrown));
});

test('L3 lib/sendproject.js: unpack throws an error it does not expect while removing dest.part', async () => {
  const { unpack } = require('../lib/sendproject');
  const dest = path.join(newDir(), 'project');
  const run = (err) => {
    let calls = 0;
    return stubbed(fs.promises, 'rm', (real) => (...args) => (++calls === 1 ? real(...args) : Promise.reject(err)), () => unpack(Buffer.from('not gzip'), dest).catch((e) => e));
  };
  // A file system error leaves dest.part, which the next unpack removes first.
  assert.deepStrictEqual(await run(Object.assign(new Error('busy'), { code: 'EBUSY', syscall: 'rm' })), { error: 'The project bundle could not be read.' });
  const thrown = await run(notFsError());
  assert.ok(thrown instanceof Error && thrown.code === 'ERR_TEST_NOT_FS', JSON.stringify(thrown));
});

// ---------- rule b: numbers ----------

test('L2 lib/versions.js: a version part too large for a whole number is an unknown version', () => {
  const { older, olderNote } = require('../lib/versions');
  const huge = '9'.repeat(400);
  assert.strictEqual(older('1.0.0', `${huge}.0.0`), false);
  assert.strictEqual(older(`1.${huge}.0`, '1.0.0'), false);
  assert.strictEqual(olderNote({ version: `0.${huge}.1` }, '0.24.40'), null);
  assert.strictEqual(older('1.0.0', '1.0.1'), true);
});

test('L2 lib/portowner.js: a /proc folder name that is not a safe whole number is not a pid', async () => {
  const { linuxOwner } = require('../lib/portowner');
  const proc = newDir();
  fs.mkdirSync(path.join(proc, 'net'));
  // Port 5280 (14A0) listening (0A), socket inode 424242.
  const line = '  0: 0100007F:14A0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 424242 1 0';
  fs.writeFileSync(path.join(proc, 'net', 'tcp'), `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n${line}\n`);
  const pid = '9'.repeat(200);
  fs.mkdirSync(path.join(proc, pid, 'fd'), { recursive: true });
  fs.symlinkSync('socket:[424242]', path.join(proc, pid, 'fd', '3'));
  const found = await linuxOwner(5280, proc);
  assert.ok(found === null || Number.isSafeInteger(found.pid), JSON.stringify(found));
  fs.mkdirSync(path.join(proc, '77', 'fd'), { recursive: true });
  fs.symlinkSync('socket:[424242]', path.join(proc, '77', 'fd', '4'));
  assert.strictEqual((await linuxOwner(5280, proc)).pid, 77);
});

test('L2 server/driver.js: versionDirs leaves out names with parts too large for a whole number', () => {
  const { versionDirs } = require('../server/driver');
  const dir = newDir();
  for (const name of ['2.1.5', `${'9'.repeat(30)}.0`, '2.1.10', `2.${'9'.repeat(30)}`]) fs.mkdirSync(path.join(dir, name));
  assert.deepStrictEqual(versionDirs(dir), ['2.1.10', '2.1.5']);
});

test('L2 server/pair-remote.js: ports saved in the paired computers file are used only when valid', () => {
  const { PairRemotes } = require('../server/pair-remote');
  const stateDir = newDir();
  const host = { id: 'a'.repeat(32), key: 'b'.repeat(64), host: '127.0.0.1', port: 5281, name: 'vm', livePort: 'abc', liveGateway: 'sock', siteGateway: 1e9 };
  const good = { ...host, id: 'c'.repeat(32), name: 'vm2', livePort: 5282, liveGateway: 5283, siteGateway: 5284 };
  fs.writeFileSync(path.join(stateDir, 'pair-remote.json'), JSON.stringify({ hosts: [host, good] }));
  const remotes = new PairRemotes({ stateDir, port: 5280 });
  const [h, g] = remotes.hosts;
  assert.ok(Number.isInteger(h.livePort) && h.livePort >= 1 && h.livePort <= 65535, String(h.livePort));
  assert.strictEqual(h.liveGateway, 0);
  assert.strictEqual(h.siteGateway, 0);
  assert.deepStrictEqual([g.livePort, g.liveGateway, g.siteGateway], [5282, 5283, 5284]);
});

test('L2 server/answer.js: questions with times that are not finite are listed first, the rest oldest first', () => {
  const { AnswerDesk } = require('../server/answer');
  const desk = new AnswerDesk();
  const ts = [Infinity, 5, Infinity, 3, 1, -Infinity, 4, 2, NaN, 6, Infinity, 7];
  const asks = { list: () => ts.map((t, i) => ({ id: `q${i}`, title: `q${i}`, ts: t })) };
  const got = desk.list({ tasks: [], asks, host: 'here' }).questions.map((q) => q.ts);
  const unknown = got.slice(0, 5);
  assert.ok(unknown.every((t) => !Number.isFinite(t)), JSON.stringify(got));
  assert.deepStrictEqual(got.slice(5), [1, 2, 3, 4, 5, 6, 7]);
});

test('L2 server/transcript.js: a Read offset or limit too large for a line number gives no range', () => {
  const { toolTarget } = require('../server/transcript');
  const a = toolTarget('Read', { file_path: '/p/a.js', offset: 1e308, limit: 1e308 });
  assert.deepStrictEqual([a.line, a.end], [null, null]);
  const b = toolTarget('Read', { file_path: '/p/a.js', offset: 5, limit: 1e300 });
  assert.deepStrictEqual([b.line, b.end], [5, null]);
  const c = toolTarget('Read', { file_path: '/p/a.js', offset: 5, limit: 10 });
  assert.deepStrictEqual([c.line, c.end], [5, 14]);
});

function assistant(id, usage) {
  return { type: 'assistant', timestamp: '2026-10-07T10:00:00.000Z', message: { id, model: 'claude-opus-5-5', usage, content: [] } };
}

test('L2 server/usage.js: token counts too large for a whole number are not added (no Infinity)', () => {
  const { UsageTracker } = require('../server/usage');
  const t = new UsageTracker();
  const big = { input_tokens: 1e308, cache_read_input_tokens: 1e308, cache_creation_input_tokens: 1e308, output_tokens: 1e308 };
  t.ingest(assistant('m1', big));
  t.ingest(assistant('m2', big));
  t.ingest({ type: 'user', message: { content: [] }, toolUseResult: { totalTokens: 1e308, agentId: 'a1' } });
  t.ingest({ type: 'user', message: { content: [] }, toolUseResult: { totalTokens: 1e308, agentId: 'a2' } });
  const s = t.snapshot();
  for (const [k, v] of Object.entries(s.totals)) assert.ok(Number.isFinite(v), `${k}: ${v}`);
  assert.ok(s.context.used === null || Number.isFinite(s.context.used), String(s.context.used));
});

test('L2 server/usage.js: Claude Code\'s own count of 0 is used before the transcript\'s (??)', () => {
  const { UsageTracker, resetSharedLimits } = require('../server/usage');
  resetSharedLimits();
  const t = new UsageTracker();
  t.ingest(assistant('m1', { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 40 }));
  t.merge({ context_window: { total_input_tokens: 0 } });
  assert.strictEqual(t.snapshot().context.used, 0);
});

test('L2 server/usage.js: a rate limit reset time too large for a date is unknown, not Infinity', () => {
  const { UsageTracker, resetSharedLimits } = require('../server/usage');
  resetSharedLimits();
  const t = new UsageTracker();
  t.merge({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 1e306 } } });
  const five = t.snapshot().limits.five_hour;
  assert.strictEqual(five.percent, 10);
  assert.strictEqual(five.resetsAt, null);
  resetSharedLimits();
});

test('L2 server/summary.js: token sums that pass the largest number are unknown, not Infinity', () => {
  const { summarize } = require('../server/summary');
  const s = summarize({ usage: { totals: { input: 1e308, cacheRead: 1e308, cacheCreate: 0, output: 0 } }, history: [], rootMatches: () => true });
  assert.strictEqual(s.tokens.main, null);
  const ok = summarize({ usage: { totals: { input: 1, cacheRead: 2, cacheCreate: 3, output: 4 } }, history: [], rootMatches: () => true });
  assert.strictEqual(ok.tokens.main, 10);
});
