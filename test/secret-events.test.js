'use strict';
require('./isolate');
// Sol H6 (server side): a key or credentials file's text is never kept, backed up or shown, even
// when an event includes it (an older hook, a task's Claude): the edit shows only that it changed.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-secret-events-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '5251';
const { ensureServer, stopServer, postEvent } = require('../lib/client');
const config = require('../lib/config');

// Every file under dir whose text has the word, as relative paths.
function filesWith(dir, word) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesWith(p, word));
    else if (e.isFile() && fs.readFileSync(p, 'latin1').includes(word)) out.push(path.relative(stateDir, p));
  }
  return out;
}

test('edits, views and questions about key files send no text to the server', async (t) => {
  // The project is outside the state folder: only EditLens's own files are searched.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-secret-proj-'));
  fs.mkdirSync(path.join(dir, 'keys'), { recursive: true });
  const stream = new AbortController();
  t.after(async () => {
    stream.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await ensureServer();
  const res = await fetch(`${config.baseUrl}/events?page=p1&root=${encodeURIComponent(dir)}`, { signal: stream.signal });
  const reader = res.body.getReader();
  let seen = '';
  const reading = (async () => {
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) return;
      seen += dec.decode(value, { stream: true });
    }
  })();
  const cases = [['.env', 'SECRET_ENV'], ['keys/id_rsa', 'SECRET_KEY'], ['cert.pem', 'SECRET_PEM']];
  let n = 0;
  for (const [rel, word] of cases) {
    const file = path.join(dir, rel);
    fs.writeFileSync(file, `${word}=new\n`);
    const id = `tu${n++}`;
    await postEvent({ type: 'pending', sessionId: 's1', cwd: dir, toolUseId: id, file, relFile: rel, before: `${word}=old\n`, existed: true });
    await postEvent({ type: 'change', sessionId: 's1', cwd: dir, toolUseId: id, tool: 'Edit', file, relFile: rel, before: `${word}=old\n`, after: `${word}=new\n`, kind: 'other', intent: 'x',
      hunks: [{ oldStart: 1, newStart: 1, lines: [`-${word}=old`, `+${word}=new`] }], stats: { added: 1, removed: 1 }, hints: { texts: [word], selectors: [], ids: [], classes: [] } });
    await postEvent({ type: 'code', sessionId: 's1', cwd: dir, file, relFile: rel, content: `${word}=new\n` });
    await postEvent({ type: 'ask', sessionId: 's1', cwd: dir, tool: 'Write', input: { file_path: file, content: `${word}=ask\n` } });
  }
  // Sol H9: a plain name that is a link to a key file, from a hook that did not mark it.
  const keyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-secret-home-'));
  t.after(() => fs.rmSync(keyHome, { recursive: true, force: true }));
  fs.writeFileSync(path.join(keyHome, 'id_ed25519'), 'SECRET_LINKED=1\n');
  fs.symlinkSync(path.join(keyHome, 'id_ed25519'), path.join(dir, 'notes.txt'));
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file: path.join(dir, 'notes.txt'), relFile: 'notes.txt', before: 'SECRET_LINKED=0\n', after: 'SECRET_LINKED=1\n', kind: 'other', intent: 'x',
    hunks: [{ oldStart: 1, newStart: 1, lines: ['-SECRET_LINKED=0', '+SECRET_LINKED=1'] }], stats: { added: 1, removed: 1 } });
  cases.push(['notes.txt', 'SECRET_LINKED']);
  // A plain file still shows its lines.
  const plain = path.join(dir, 'app.js');
  fs.writeFileSync(plain, 'PLAIN_TEXT\n');
  await postEvent({ type: 'change', sessionId: 's1', cwd: dir, tool: 'Edit', file: plain, relFile: 'app.js', before: 'old\n', after: 'PLAIN_TEXT\n', kind: 'frontend', intent: 'x',
    hunks: [{ oldStart: 1, newStart: 1, lines: ['-old', '+PLAIN_TEXT'] }], stats: { added: 1, removed: 1 } });
  await new Promise((r) => setTimeout(r, 400));
  stream.abort();
  await reading;
  assert.match(seen, /PLAIN_TEXT/);
  for (const [rel, word] of cases) {
    assert.doesNotMatch(seen, new RegExp(word), `${rel}: no text on the page`);
    assert.deepStrictEqual(filesWith(stateDir, word), [], `${rel}: no text kept`);
  }
  assert.match(seen, /"relFile":"keys\/id_rsa"/, 'the edit itself is shown');
  assert.match(seen, /"backupSkipped":"secret"/);
});
