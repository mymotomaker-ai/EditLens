'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { toolTarget } = require('../server/transcript');

const file = path.resolve('/project/src/App.jsx');

test('Read: the lines it reads, never NaN', () => {
  assert.deepStrictEqual(toolTarget('Read', { file_path: file, offset: 20, limit: 10 }), { file, line: 20, end: 29, op: 'read' });
  assert.deepStrictEqual(toolTarget('Read', { file_path: file }), { file, line: null, end: null, op: 'read' });
  assert.deepStrictEqual(toolTarget('Read', { file_path: file, offset: 'abc', limit: NaN }), { file, line: null, end: null, op: 'read' });
  assert.deepStrictEqual(toolTarget('Read', { file_path: file, offset: 5, limit: 0 }), { file, line: 5, end: null, op: 'read' });
});

test('edits and notebooks', () => {
  assert.strictEqual(toolTarget('Edit', { file_path: file }).op, 'edit');
  assert.strictEqual(toolTarget('Write', { file_path: file }).op, 'edit');
  assert.strictEqual(toolTarget('NotebookEdit', { notebook_path: file }).file, file);
});

test('no file, relative paths and other tools give nothing', () => {
  assert.deepStrictEqual(toolTarget('Read', { file_path: 'src/App.jsx' }), {});
  assert.deepStrictEqual(toolTarget('Bash', { command: 'ls' }), {});
  assert.deepStrictEqual(toolTarget('Read', null), {});
});
