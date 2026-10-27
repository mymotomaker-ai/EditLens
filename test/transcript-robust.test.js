'use strict';
require('./isolate');
// The transcript follower handles a file that is locked for a moment (Windows, antivirus), and
// stops following a subagent's file once its result is in.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SessionWatcher, Tail } = require('../server/transcript');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-transcript-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a locked transcript is skipped for a tick, then read', (t) => {
  const file = path.join(dir, 'locked.jsonl');
  fs.writeFileSync(file, '');
  const got = [];
  const tail = new Tail(file, (entries) => got.push(...entries), { backlog: false });
  tail.start();
  t.after(() => tail.stop());
  fs.appendFileSync(file, JSON.stringify({ n: 1 }) + '\n');
  const open = fs.openSync;
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    fs.openSync = () => {
      throw Object.assign(new Error(code), { code });
    };
    try {
      assert.doesNotThrow(() => tail.read(false), code);
    } finally {
      fs.openSync = open;
    }
  }
  tail.read(false);
  assert.deepStrictEqual(got, [{ n: 1 }]);
  // A character split across two reads arrives whole.
  const line = JSON.stringify({ s: 'é✓' }) + '\n';
  const bytes = Buffer.from(line);
  fs.appendFileSync(file, bytes.subarray(0, 10));
  tail.read(false);
  fs.appendFileSync(file, bytes.subarray(10));
  tail.read(false);
  assert.deepStrictEqual(got[1], { s: 'é✓' });
});

test('a finished subagent is no longer followed', async (t) => {
  const transcript = path.join(dir, 'sess.jsonl');
  const sub = path.join(dir, 'sess', 'subagents');
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(transcript, '');
  const events = [];
  const w = new SessionWatcher({ sessionId: 'sess', transcriptPath: transcript, cwd: dir, emit: (e) => events.push(e), doneGraceMs: 50 });
  w.start();
  t.after(() => w.stop());
  const line = (o) => fs.appendFileSync(transcript, JSON.stringify(o) + '\n');
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'look', prompt: 'p' } }] } });
  fs.writeFileSync(path.join(sub, 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'tu1', agentType: 'Explore' }));
  fs.writeFileSync(path.join(sub, 'agent-a1.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }) + '\n');
  w.main.read(false);
  w.scanAgents();
  const tail = w.agents.get('a1');
  assert.ok(tail && tail.timer, 'followed while it runs');
  w.agents.get('a1').read(false);
  assert.ok(events.some((e) => e.role === 'agent-step' && e.text === 'working'));
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'done' }] }, toolUseResult: { agentId: 'a1', status: 'completed' } });
  w.main.read(false);
  assert.ok(events.some((e) => e.role === 'agent-done'));
  await new Promise((r) => setTimeout(r, 150));
  assert.strictEqual(w.agents.get('a1'), null, 'stopped after its result');
  assert.strictEqual(tail.timer, null);
  assert.ok(!w.agentToolIds.has('tu1'));
  w.scanAgents();
  assert.strictEqual(w.agents.get('a1'), null, 'not picked up again');
});
