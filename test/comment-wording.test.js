'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5278'; // names server files to scan; runs none
// Code comments use plain words too: the list in test/plain-words.js, shared with the check of the
// text people read (test/wording.test.js). Comment lines that continue each other are joined first,
// so a phrase split over two lines is found. "pop out" is a kept term.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['bin', 'client/src', 'hooks', 'lib', 'mcp', 'server', 'integrations', 'examples'];
// Every script under dir (relative to ROOT), node_modules left out; then the previews.
function walk(dir) {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = dir + '/' + e.name;
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(rel);
    return e.isFile() && /\.(m?js|jsx)$/.test(e.name) ? [rel] : [];
  });
}
const PREVIEWS = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('-preview.js')).map((f) => 'test/' + f);
const FILES = [...DIRS.flatMap(walk), ...PREVIEWS];
const { hits, commentBlocks, lineAt } = require('./plain-words');

test('code comments use plain words', () => {
  const found = [];
  for (const rel of FILES) {
    for (const b of commentBlocks(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) {
      for (const h of hits(b.text)) found.push(`${rel}:${lineAt(b, h.index)} "${h.phrase}" in "${b.text.slice(0, 80)}": use "${h.use}"`);
    }
  }
  assert.deepStrictEqual(found, []);
});

// Test files too: their comments and test names. Left out: files whose comments quote code or the
// word list itself.
const QUOTES_CODE = ['plain-words.js', 'comments.test.js', 'wording.test.js', 'comment-wording.test.js', 'sol-0.24.45-harness.test.js'];
test('test comments and test names use plain words', () => {
  const found = [];
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => /\.(js|ts)$/.test(f) && !QUOTES_CODE.includes(f));
  for (const f of files) {
    const src = fs.readFileSync(path.join(ROOT, 'test', f), 'utf8');
    for (const b of commentBlocks(src)) {
      for (const h of hits(b.text)) found.push(`test/${f}:${lineAt(b, h.index)} "${h.phrase}": use "${h.use}"`);
    }
    src.split('\n').forEach((line, i) => {
      const name = line.match(/^\s*test\((['`])(.*?)\1/);
      if (name) for (const h of hits(name[2])) found.push(`test/${f}:${i + 1} name "${h.phrase}": use "${h.use}"`);
    });
  }
  assert.deepStrictEqual(found, []);
});

test('a phrase split over two comment lines is found, and strings inside template expressions are read', () => {
  const { read } = require('./plain-words');
  const blocks = commentBlocks('x();\n// the old copy is left\n// behind here\n');
  assert.deepStrictEqual(blocks.flatMap((b) => hits(b.text).map((h) => [h.phrase, lineAt(b, h.index)])), [['left behind', 2]]);
  const strings = read('const a = `one ${b ? `two ${"three"}` : \'four\'} five`;').strings.map((x) => x.text);
  assert.deepStrictEqual(strings.sort(), ['four', 'one ${} five', 'three', 'two ${}']);
});

test('the comment scan covers subfolders, integrations, examples and previews', () => {
  for (const rel of ['server/server.js', 'integrations/vite.mjs', 'examples/fullstack/server.js', 'examples/vite-router/src/App.jsx', 'test/pair-preview.js']) {
    assert.ok(FILES.includes(rel), rel);
  }
});
