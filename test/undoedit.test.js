'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert');
const { reverseEdit } = require('../lib/undoedit');

const L = (...xs) => xs.join('\n') + '\n';

test('undo only this edit: nothing changed since, gives the old text back', () => {
  const before = L('a', 'b', 'c');
  const after = L('a', 'B', 'c');
  assert.deepStrictEqual(reverseEdit({ before, after, now: after }), { clean: true, text: before, lines: [2, 2] });
});

test('undo only this edit: a later edit on other lines is kept', () => {
  const before = L('1', '2', '3', '4', '5', '6', '7', '8');
  const after = L('1', 'TWO', '3', '4', '5', '6', '7', '8');
  const now = L('1', 'TWO', '3', '4', '5', '6', 'seven', '8', '9');
  const r = reverseEdit({ before, after, now });
  assert.strictEqual(r.clean, true);
  assert.strictEqual(r.text, L('1', '2', '3', '4', '5', '6', 'seven', '8', '9'));
});

test('undo only this edit: added lines are removed, removed lines are restored, with lines moved by later edits', () => {
  const before = L('a', 'b', 'c', 'd', 'e', 'f');
  const after = L('a', 'new1', 'new2', 'b', 'c', 'e', 'f'); // two added after a, d removed
  const now = L('top', 'a', 'new1', 'new2', 'b', 'c', 'e', 'f', 'end');
  const r = reverseEdit({ before, after, now });
  assert.strictEqual(r.clean, true);
  assert.strictEqual(r.text, L('top', 'a', 'b', 'c', 'd', 'e', 'f', 'end'));
});

test('undo only this edit: a later edit on the same lines is a conflict', () => {
  const before = L('a', 'b', 'c');
  const after = L('a', 'B', 'c');
  const now = L('a', 'BB', 'c');
  assert.deepStrictEqual(reverseEdit({ before, after, now }), { clean: false, lines: [2, 2] });
});

test('undo only this edit: a line put between a removed block\'s neighbours is a conflict', () => {
  const before = L('a', 'b', 'c');
  const after = L('a', 'c');
  const now = L('a', 'x', 'c');
  assert.strictEqual(reverseEdit({ before, after, now }).clean, false);
});

test('undo only this edit: a new file and missing texts', () => {
  assert.deepStrictEqual(reverseEdit({ before: '', after: L('x'), now: L('x') }), { clean: true, text: '', lines: [1, 1] });
  assert.deepStrictEqual(reverseEdit({ before: undefined, after: 'x', now: 'x' }), { error: 'not-kept' });
  assert.deepStrictEqual(reverseEdit({ before: 'x', after: 'x', now: 'x' }), { error: 'no-change' });
});

test('undo only this edit: no trailing newline stays without one, and line numbers are never NaN', () => {
  const r = reverseEdit({ before: 'a\nb', after: 'a\nB', now: 'z\na\nB' });
  assert.deepStrictEqual(r, { clean: true, text: 'z\na\nb', lines: [2, 2] });
  assert.ok(r.lines.every(Number.isFinite));
});
