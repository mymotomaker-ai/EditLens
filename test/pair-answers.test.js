'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5255';
// "Paired computers can answer questions here" (paired_answers) in the EditLens window's own code:
// what a paired computer's window lists and may answer, the setting in each ping, and unpairing
// from the other computer closing its page connections (Sol M4).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { AnswerDesk } = require('../server/answer');
const { PairHost } = require('../server/pair-host');

const pair = { id: 'p1', name: 'laptop', cwd: '/work/shop' };
const inPair = (p, cwd) => cwd === p.cwd || String(cwd).startsWith(p.cwd + '/');
const drive = { active: true, runId: 'r1', cwd: '/work/shop', permissions: [{ id: 'd1', title: 'Run npm test', ts: 1 }] };
const tasks = [
  { id: 'aaaaaaaaaaaa', by: 'laptop', pairId: 'p1', permissions: new Map([['t1', { id: 't1', title: 'Edit a.js', ts: 2 }]]) },
  { id: 'bbbbbbbbbbbb', by: 'phone', pairId: 'p2', permissions: new Map([['t2', { id: 't2', title: 'Edit b.js', ts: 3 }]]) },
];
const asks = { list: (match) => [{ id: 'q1', cwd: '/work/shop', title: 'Bash', ts: 4 }, { id: 'q2', cwd: '/work/other', title: 'Bash', ts: 5 }].filter((q) => match(q.cwd)) };

test('off (the default): a paired window is refused; on: it lists only its project\'s questions and the tasks it gave', () => {
  let on = false;
  const desk = new AnswerDesk({ pairAnswers: () => on, inPair });
  desk.requestRoot();
  const req = (paired) => ({ socket: paired ? { editlensPair: pair } : {}, headers: { 'sec-fetch-site': 'same-origin', 'x-editlens-answer': desk.key } });
  assert.strictEqual(desk.allowed(req(true)), false);
  assert.strictEqual(desk.allowed(req(false)), true);
  assert.strictEqual(desk.pairCan(pair, { kind: 'drive', id: 'd1' }, { drive }), false);
  on = true;
  assert.strictEqual(desk.allowed(req(true)), true);
  const listed = desk.list({ drive, tasks, asks, host: 'vps', pair });
  assert.strictEqual(listed.via, true);
  assert.deepStrictEqual(listed.questions.map((q) => q.key), ['p:d1', 't:aaaaaaaaaaaa:t1', 'a:q1']);
  assert.ok(listed.questions.every((q) => q.who.startsWith('◆ vps · ')), 'each says which computer it is on');
  // On this computer itself: everything, the root request too.
  assert.deepStrictEqual(desk.list({ drive, tasks, asks, host: 'vps' }).questions.map((q) => q.kind).sort(), ['ask', 'ask', 'drive', 'root', 'task', 'task']);
  assert.strictEqual(desk.pairCan(pair, { kind: 'drive', id: 'd1' }, { drive }), true);
  assert.strictEqual(desk.pairCan(pair, { kind: 'drive', id: 'nope' }, { drive }), false);
  assert.strictEqual(desk.pairCan(pair, { kind: 'drive', id: 'd1' }, { drive: { ...drive, cwd: '/work/other' } }), false, 'page control in another project');
  assert.strictEqual(desk.pairCan(pair, { kind: 'task', task: 'aaaaaaaaaaaa' }, { task: tasks[0] }), true);
  assert.strictEqual(desk.pairCan(pair, { kind: 'task', task: 'bbbbbbbbbbbb' }, { task: tasks[1] }), false, 'another computer\'s task');
  for (const kind of ['root', 'setting', 'mode', 'ask', undefined]) assert.strictEqual(desk.pairCan(pair, { kind, id: 'x' }, { drive }), false, String(kind));
});

function fakeSocket(identity) {
  const s = new EventEmitter();
  s.editlensIdentity = identity;
  s.lines = [];
  s.destroyed = false;
  s.write = (t) => s.lines.push(String(t));
  s.end = () => {};
  s.destroy = () => {
    s.destroyed = true;
  };
  s.resume = () => {};
  s.pause = () => {};
  return s;
}

async function serve(host, head) {
  const s = fakeSocket('p1');
  const done = host.serve(s);
  s.emit('data', Buffer.from(JSON.stringify(head) + '\n'));
  await done;
  return s;
}

test('the ping says whether this computer lets the paired one answer; unpairing there closes its page connections', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pair-answers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let on = false;
  const host = new PairHost({ stateDir: dir, port: 0, httpServer: null, siteOf: () => null, version: 'x', livePort: 1, log: () => {}, answersAllowed: () => on });
  host.pairs = [{ ...pair, key: '00'.repeat(32) }];
  const ping = async () => JSON.parse((await serve(host, { t: 'ping' })).lines.join('').trim());
  assert.strictEqual((await ping()).answers, false);
  on = true;
  assert.strictEqual((await ping()).answers, true);
  // A page connection that is open when the other computer unpairs.
  const page = fakeSocket('p1');
  host.track(page, host.pairs[0]);
  await serve(host, { t: 'unpair' });
  assert.strictEqual(host.has('p1'), false);
  assert.strictEqual(page.destroyed, true, 'its page connection is closed');
});

test('the joined computer learns at the next ping that it may answer: its window address, and cards drawn again', async (t) => {
  const { PairRemotes } = require('../server/pair-remote');
  const calls = [];
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-pair-answers-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const remotes = new PairRemotes({ stateDir, port: 5252, onChange: (d, why) => calls.push([d.answerUrl, why || null]) });
  const h = { id: 'h1', name: 'vps', host: '203.0.113.5', port: 5256, cwd: '/work/shop', liveGateway: 5253, siteGateway: 5254 };
  const link = { state: 'connected', fails: 0 };
  remotes.links.set(h.id, link);
  let answers = true;
  remotes.ask = async () => ({ ok: true, version: '0.24.39', site: true, answers });
  const ping = async () => {
    remotes.check(h, link);
    await new Promise((r) => setImmediate(r));
    clearTimeout(link.timer);
  };
  await ping();
  assert.deepStrictEqual(calls, [['http://127.0.0.1:5253/answer', 'answers']]);
  await ping();
  assert.strictEqual(calls.length, 1, 'no change, no redraw');
  answers = false;
  await ping();
  assert.deepStrictEqual(calls[1], [null, 'answers']);
  assert.strictEqual(remotes.describe(h).answers, false);
});

test('terminal: the Settings pane row "Can answer here", its second press, and the paired block', async () => {
  const mod = await import('../hooks/mod.mjs');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  const other = mod.settingSections(manifest.userConfig).find((s) => s.title === 'Other computers');
  assert.deepStrictEqual(other.rows.map((r) => r.label), ['Can run Claude here', 'Can answer here', 'Tasks at once', 'Run their tasks as']);
  const line = (on) => mod.settingsLines(manifest.userConfig, { remote_tasks: true, paired_answers: on, tasks_at_once: 4, task_account: 'Auto' }).find((l) => l.label === 'Other computers');
  assert.deepStrictEqual(line(false).bits.slice(0, 2), ['can run Claude here', "can't answer here"]);
  assert.deepStrictEqual(line(true).bits.slice(0, 2), ['can run Claude here', 'can answer here']);
  assert.strictEqual(mod.CONFIRM.paired_answers.value, true, 'turning it on needs a second press');
  const block = (answers) => mod.pairedRecords({ name: 'laptop', site: true, answers }).map((r) => r.plain[0]);
  assert.ok(block(false).includes('You answer ·· its permission questions'));
  assert.ok(block(true).includes('You answer ·· its permission questions; it can too, in its EditLens window'));
});
