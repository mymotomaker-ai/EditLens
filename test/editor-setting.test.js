'use strict';
require('./isolate');
// The Editor setting (the file menu's Open link): declared in plugin.json like the other choices,
// page-editable, and anything else uses VS Code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const settings = require('../lib/settings');

test('Editor: VS Code / Cursor / None, VS Code by default, the page may change it', () => {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8')).userConfig.editor;
  assert.ok(f, 'plugin.json declares editor');
  assert.strictEqual(f.type, 'string');
  assert.strictEqual(f.title, 'Editor');
  assert.deepStrictEqual(f.options, ['VS Code', 'Cursor', 'None']);
  assert.strictEqual(f.default, 'VS Code');
  assert.ok(settings.PAGE_EDITABLE.includes('editor'));
  assert.strictEqual(settings.describe(settings.defaults()).find((x) => x.key === 'editor').pageEditable, true);
  for (const bad of ['Sublime', 'vscode', '', ' ', null, 1, NaN, true]) assert.strictEqual(settings.check('editor', bad), undefined, String(bad));
  assert.strictEqual(settings.check('editor', ' Cursor '), 'Cursor');
  assert.strictEqual(settings.normalize({ editor: 'Emacs' }).editor, 'VS Code');
  assert.strictEqual(settings.fromEnv({ CLAUDE_PLUGIN_OPTION_EDITOR: 'None' }).values.editor, 'None');
  // Only the two link schemes the page may open; None opens nothing.
  assert.deepStrictEqual(settings.EDITOR_IDS, { 'VS Code': 'vscode', Cursor: 'cursor', None: null });
});

test('the page builds Open links only as vscode://file/ or cursor://file/, with a checked line', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'client', 'src', '3-code.js'), 'utf8');
  const fn = src.slice(src.indexOf('function editorLink('), src.indexOf('// The paired computer a file is on'));
  assert.ok(/scheme \+ '\:\/\/file'/.test(fn), 'the link is <scheme>://file/…');
  assert.ok(/Number\.isFinite/.test(src.slice(src.indexOf('function lineNo('), src.indexOf('function editorLink('))), 'the line is checked with Number.isFinite');
  assert.ok(/EDITOR_SCHEMES = dict\(\{ 'VS Code': 'vscode', Cursor: 'cursor' \}\)/.test(src), 'only vscode and cursor');
});
