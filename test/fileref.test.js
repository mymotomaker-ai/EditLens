'use strict';
require('./isolate');
// File references from Claude's replies: resolved inside the project only, with folders,
// duplicate names, hidden and secret files, and paths written relative to another folder.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRef, cleanRef } = require('../lib/fileref');
const sendproject = require('../lib/sendproject');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-ref-'));
const project = path.join(base, 'My Site');
function write(rel, text) {
  const f = path.join(project, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}
write('live-edits-demo/src/App.jsx', 'export default function App() {}\n');
write('live-edits-demo/src/components.jsx', 'export const A = 1;\n');
write('live-edits-demo/src/pages/Home.jsx', 'home\n');
write('live-edits-demo/src/pages/About.jsx', 'about\n');
write('other/components.jsx', 'dup\n');
write('live-edits-demo/.env', 'KEY=1\n');
write('live-edits-demo/secrets.json', '{}\n');
for (const n of ['apikey.json', 'token.txt', 'serviceAccount.json', 'auth.json', 'api_key', 'deploy.token', 'auth.ts', 'token.js', 'tokenizer.json']) write(`keys/${n}`, 'x\n');
write('live-edits-demo/logo.png', 'a\u0000b');
write('live-edits-demo/node_modules/x/App.jsx', 'nope\n');
fs.writeFileSync(path.join(base, 'outside.js'), 'outside\n');
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test('cleanRef handles file URLs, escapes and ./', () => {
  assert.strictEqual(cleanRef('file:///C:/a/b.js'), 'C:/a/b.js');
  assert.strictEqual(cleanRef('file:///home/a.js'), '/home/a.js');
  assert.strictEqual(cleanRef('./src/My%20File.js'), 'src/My File.js');
  assert.strictEqual(cleanRef('<src/a.js>'), 'src/a.js');
  assert.strictEqual(cleanRef('%E0%A4%A'), '%E0%A4%A', 'a broken escape is not changed');
});

test('relative to the session folder, with backslashes, and absolute', () => {
  const r = resolveRef('live-edits-demo/src/App.jsx', [project]);
  assert.strictEqual(r.kind, 'file');
  assert.strictEqual(r.rel, 'live-edits-demo/src/App.jsx');
  assert.strictEqual(resolveRef('live-edits-demo\\src\\App.jsx', [project]).kind, 'file');
  assert.strictEqual(resolveRef(path.join(project, 'live-edits-demo', 'src', 'App.jsx'), [project]).kind, 'file');
});

test('a path that starts with the session folder name, from inside it', () => {
  const r = resolveRef('live-edits-demo/src/App.jsx', [path.join(project, 'live-edits-demo')]);
  assert.strictEqual(r.kind, 'file');
});

test('a bare or partial name is found by suffix; duplicates ask which', () => {
  assert.strictEqual(resolveRef('App.jsx', [project]).rel, 'live-edits-demo/src/App.jsx', 'node_modules is skipped');
  const dup = resolveRef('components.jsx', [project]);
  assert.strictEqual(dup.kind, 'choices');
  assert.deepStrictEqual(dup.matches, ['live-edits-demo/src/components.jsx', 'other/components.jsx']);
  assert.strictEqual(resolveRef('src/components.jsx', [project]).kind, 'file');
});

test('folders list their files', () => {
  const r = resolveRef('live-edits-demo/src/pages', [project]);
  assert.strictEqual(r.kind, 'dir');
  assert.deepStrictEqual(r.entries.map((e) => e.name), ['About.jsx', 'Home.jsx']);
  assert.strictEqual(r.entries[0].rel, 'live-edits-demo/src/pages/About.jsx');
  assert.ok(!resolveRef('live-edits-demo', [project]).entries.some((e) => e.name === '.env' || e.name === 'node_modules'));
});

test('outside the project, hidden, secret, binary and missing files are refused with a reason', () => {
  assert.match(resolveRef('../outside.js', [project]).error, /outside this project/);
  assert.match(resolveRef(path.join(base, 'outside.js'), [project]).error, /outside this project/);
  assert.match(resolveRef('live-edits-demo/.env', [project]).error, /hidden/);
  assert.match(resolveRef('live-edits-demo/secrets.json', [project]).error, /secrets/);
  assert.match(resolveRef('live-edits-demo/logo.png', [project]).error, /binary/);
  assert.match(resolveRef('nope/missing.js', [project]).error, /Couldn't find/);
  assert.match(resolveRef('a.js', []).error, /No Claude Code session/);
  assert.match(resolveRef('', [project]).error, /Empty/);
});

test('files named for a key are not shown when they hold data; code files with those names are', () => {
  for (const n of ['apikey.json', 'token.txt', 'serviceAccount.json', 'auth.json', 'api_key', 'deploy.token']) {
    assert.match(resolveRef(`keys/${n}`, [project]).error || '', /key or secrets file/, n);
    assert.ok(sendproject.excluded(`keys/${n}`), `${n} is never sent to another computer either`);
  }
  for (const n of ['auth.ts', 'token.js', 'tokenizer.json']) {
    assert.strictEqual(resolveRef(`keys/${n}`, [project]).kind, 'file', n);
    assert.ok(!sendproject.excluded(`keys/${n}`), n);
  }
});
