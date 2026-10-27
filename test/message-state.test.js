'use strict';
require('./isolate');
// The server tells pages what Claude is doing (working, idle, stopped by Esc, closed), so a page
// message can say when Claude will read it, and a waiting message can be cancelled.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-state-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4392';
const { ensureServer, stopServer, postEvent, getJson } = require('../lib/client');
const config = require('../lib/config');

const transcript = path.join(stateDir, 'session.jsonl');
const project = path.join(stateDir, 'site');

async function post(urlPath, body) {
  const res = await fetch(`${config.baseUrl}${urlPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

async function lastState() {
  const history = await getJson('/history');
  const states = history.filter((e) => e.type === 'state');
  return states[states.length - 1] || null;
}

async function waitFor(check, ms) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

test('page messages follow Claude state, interrupts and cancels', async (t) => {
  fs.writeFileSync(transcript, '');
  await ensureServer();
  t.after(async () => {
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  // A page of this project with the panel open (a message needs a page that names its project).
  const stream = new AbortController();
  await fetch(`${config.baseUrl}/events?page=pg1&root=${encodeURIComponent(project)}`, { signal: stream.signal });
  t.after(() => stream.abort());
  const ev = (type, extra) => postEvent({ type, sessionId: 's1', cwd: project, transcriptPath: transcript, ts: Date.now(), ...extra });

  // A desktop / Remote Control session: idle, and it cannot listen.
  await ev('session', { canListen: false });
  let s = await lastState();
  assert.strictEqual(s.state, 'idle');
  assert.strictEqual(s.canListen, false);

  const sent = await post('/message', { text: 'Make the title blue', pageId: 'pg1' });
  assert.strictEqual(sent.status, 200);
  assert.strictEqual(sent.body.state, 'idle');
  assert.strictEqual(sent.body.canListen, false);

  // A prompt starts a turn; an edit keeps it working without a duplicate state event.
  await ev('prompt', { canListen: false });
  await ev('pending', { file: path.join(project, 'a.css') });
  const history = await getJson('/history');
  assert.deepStrictEqual(history.filter((e) => e.type === 'state').map((e) => e.state), ['idle', 'working']);

  // Esc: Claude Code writes the interrupt into the transcript and no Stop hook runs.
  fs.appendFileSync(transcript, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }) + '\n');
  s = await waitFor(async () => {
    const st = await lastState();
    return st && st.state === 'stopped' ? st : null;
  }, 3000);
  assert.ok(s, 'state becomes stopped after an interrupt');
  assert.strictEqual(s.canListen, false, 'stopping keeps what is known about listening');

  // The interrupt line is not shown as something the user typed.
  assert.ok(!(await getJson('/history')).some((e) => e.type === 'chat' && e.role === 'user'));

  // Cancel the message: Claude never gets it.
  assert.strictEqual((await post('/message/cancel', { id: sent.body.id, page: 'pg1' })).status, 200);
  // Twice (a double click): already cancelled, not "Claude already has this message".
  const again = await post('/message/cancel', { id: sent.body.id, page: 'pg1' });
  assert.deepStrictEqual([again.status, again.body], [200, { ok: true, already: true }]);
  assert.strictEqual((await post('/message/cancel', { id: 'nope', page: 'pg1' })).status, 404);
  assert.deepStrictEqual((await getJson(`/messages/take?cwd=${encodeURIComponent(project)}&via=prompt`)).messages, []);
  assert.ok((await getJson('/history')).some((e) => e.type === 'cancelled' && e.ids[0] === sent.body.id));

  // A delivered message cannot be cancelled.
  const second = await post('/message', { text: 'And bold', pageId: 'pg1' });
  assert.strictEqual(second.body.state, 'stopped');
  assert.strictEqual((await getJson(`/messages/take?cwd=${encodeURIComponent(project)}&via=prompt`)).messages.length, 1);
  assert.strictEqual((await post('/message/cancel', { id: second.body.id, page: 'pg1' })).status, 409);

  // Another session ending leaves this one alone; this one ending closes it.
  await postEvent({ type: 'end', sessionId: 'other', cwd: project, ts: Date.now() });
  assert.strictEqual((await lastState()).state, 'stopped');
  await postEvent({ type: 'end', sessionId: 's1', cwd: project, ts: Date.now() });
  assert.strictEqual((await lastState()).state, 'closed');
});

test('SessionEnd does not start a server', async () => {
  // Runs after the first test stopped its server.
  assert.strictEqual(await postEvent({ type: 'end', sessionId: 's1', ts: Date.now() }, { start: false }), null);
});
