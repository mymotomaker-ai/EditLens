'use strict';
require('./isolate');
// Code snapshots behind the live code view: before/after text, the diff to animate, limits.
const test = require('node:test');
const assert = require('node:assert');
const { SnapshotStore } = require('../server/snapshots');

// Apply hunks the way the page does, to check they rebuild the file exactly.
function play(before, hunks) {
  const lines = before === '' ? [] : before.replace(/\n$/, '').split('\n');
  let delta = 0;
  for (const h of hunks) {
    let idx = Math.max(0, h.oldStart - 1) + delta;
    for (const l of h.lines) {
      if (l[0] === ' ') idx++;
      else if (l[0] === '-') {
        lines.splice(idx, 1);
        delta--;
      } else if (l[0] === '+') {
        lines.splice(idx, 0, l.slice(1));
        idx++;
        delta++;
      }
    }
  }
  return lines.join('\n');
}

test('an edit keeps the text from before (sent by PreToolUse) and after', () => {
  const store = new SnapshotStore();
  store.rememberBefore('tool1', 'a\nb\nc\n');
  assert.strictEqual(store.add('s1', { file: '/x/a.js', relFile: 'a.js', before: store.takeBefore('tool1'), after: 'a\nB\nc\nd\n', kind: 'frontend' }), 's1');
  const snap = store.get('s1');
  assert.strictEqual(snap.before, 'a\nb\nc\n');
  assert.strictEqual(play(snap.before, snap.hunks), 'a\nB\nc\nd');
  assert.strictEqual(store.takeBefore('tool1'), null, 'used once');
});

test('hunks rebuild the file for edits spread over a long file', () => {
  const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const afterLines = before.trim().split('\n');
  afterLines.splice(150, 1, 'changed 150', 'extra');
  afterLines.splice(10, 2);
  afterLines.unshift('// header');
  const after = afterLines.join('\n') + '\n';
  const store = new SnapshotStore();
  store.add('s1', { file: 'f', before, after });
  assert.strictEqual(play(before, store.get('s1').hunks), after.trim());
});

test('a new file plays from empty', () => {
  const store = new SnapshotStore();
  store.add('s1', { file: 'f', before: '', after: 'one\ntwo\n' });
  assert.strictEqual(play('', store.get('s1').hunks), 'one\ntwo');
});

test('show_code views and unknown before text have nothing to animate', () => {
  const store = new SnapshotStore();
  store.add('s1', { file: 'f', before: null, after: 'x\n' });
  assert.strictEqual(store.get('s1').hunks, null);
  assert.strictEqual(store.get('nope'), null);
});

test('binary or oversized text is not stored, and old snapshots are evicted', () => {
  const store = new SnapshotStore();
  assert.strictEqual(store.add('b', { file: 'f', after: 'a\u0000b' }), null);
  assert.strictEqual(store.add('big', { file: 'f', after: 'x'.repeat(600 * 1024) }), null);
  for (let i = 0; i < 100; i++) store.add(`s${i}`, { file: 'f', after: String(i) });
  assert.strictEqual(store.get('s0'), null);
  assert.ok(store.get('s99'));
});
