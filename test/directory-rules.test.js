'use strict';
require('./isolate');
// The plugin directory's rules for the mod (hooks/mod.mjs), from its Validate on 2026-10-27: the
// names $, on and next are only the engine's, each hook is a plain on('event', ...) statement
// (a .catch(handler) may follow), and a settings change names its key as fixed text on the hook's $.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'hooks', 'mod.mjs'), 'utf8');
const lines = SRC.split('\n');
const where = (re) => lines.map((l, i) => (re.test(l) ? `${i + 1}: ${l.trim()}` : null)).filter(Boolean);

test('no variable named $, on or next', () => {
  assert.deepStrictEqual(where(/\b(const|let|var)\s+(\$|on|next)\b|\b(const|let|var)\s+[[{][^\]}]*(\bon\b|\bnext\b|\$[\s,\]}])/), []);
});

test('each hook registration is a plain on(...), with at most a .catch(handler) after it', () => {
  assert.deepStrictEqual(where(/^\s*on\(.*\)\s*\.(?!catch\(\w+\)\s*$)\w+\(/), []);
  assert.deepStrictEqual(where(/^\s*\}\)\s*\.(?!catch\(\w+\)\s*$)\w+\(/), []);
  assert.deepStrictEqual(where(/[^\w.]on\([^'"]/).filter((l) => !/function register\(on/.test(l)), []);
});

// Code only: strings, template text, regex literals and comments are taken out first.
const code = (l) => l.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''")
  .replace(/([(=,:!&|?]\s*)\/(?:\\.|\[(?:\\.|[^\]])*\]|[^/\n])+\/[a-z]*/g, '$1/x/').replace(/\/\/.*$/, '');

test('on is used only for registrations and the register parameter', () => {
  const uses = lines.map((l, i) => [i + 1, code(l)]).filter(([, c]) => /(?<![\w.$])on(?![\w$])/.test(c))
    .filter(([, c]) => !/^\s*on\('',/.test(c) && !/^export function register\(on, \w+\) \{$/.test(c));
  assert.deepStrictEqual(uses, []);
});

// A hook given by name: the directory reads it as passing its event on only when the name is
// declared once and used for nothing but registrations.
test('each hook given by name is used only in registrations', () => {
  const names = new Set([...SRC.matchAll(/^\s*on\('[^']+',(?: \{[^}]*\},)? (\w+)\)(?:\.catch\((\w+)\))?$/gm)]
    .flatMap((m) => [m[1], m[2]]).filter(Boolean));
  assert.ok(names.size >= 3, 'the mod registers hooks by name');
  const other = [...names].flatMap((n) => where(new RegExp('\\b' + n + '\\b'))
    .filter((l) => !/^\d+: on\(/.test(l) && !new RegExp('^\\d+: (async )?function ' + n + '\\(').test(l)));
  assert.deepStrictEqual(other, []);
});

test('no object key named on', () => {
  assert.deepStrictEqual(where(/[{,]\s*on\s*:|^\s*on\s*:/), []);
});

test('$.config.set names its key as fixed text', () => {
  const calls = where(/\$\.config\.set\(/);
  assert.ok(calls.length >= 1, 'the mod changes settings');
  assert.deepStrictEqual(calls.filter((l) => !/\$\.config\.set\(\{ key: '[a-z_.]+', value \}\)/.test(l)), []);
});

test('a fixed settings key for every setting in plugin.json', () => {
  const keys = [...SRC.matchAll(/\$\.config\.set\(\{ key: 'editlens\.([a-z_]+)', value \}\)/g)].map((m) => m[1]).sort();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepStrictEqual(keys, Object.keys(manifest.userConfig).sort());
});
