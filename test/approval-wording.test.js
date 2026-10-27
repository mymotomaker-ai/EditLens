'use strict';
require('./isolate');
// Sol advice (0.24.45): permission questions are answered, and Bypass confirmed, in the EditLens
// window, never on the page or panel. Text that says otherwise fails here (Sol L3 found seven).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DIRS = ['server', 'lib', 'hooks', 'bin', 'mcp', 'client/src', 'skills', 'docs'];
const FILES = ['README.md', 'PRIVACY.md'];
// "A confirm box" is the page's own dialog, not a permission question.
const WRONG = /\b(allow|answer|approve|confirm(?! box))[^.'"`]{0,60}\b(on|in) the (panel|page)\b/i;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.(js|mjs|md)$/.test(e.name) ? [p] : [];
  });
}

test('approval and Bypass messages name the EditLens window, not the page or panel', () => {
  const all = [...DIRS.flatMap((d) => files(path.join(ROOT, d))), ...FILES.map((f) => path.join(ROOT, f))];
  const hits = [];
  for (const file of all) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (WRONG.test(line)) hits.push(`${path.relative(ROOT, file)}:${i + 1} ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepStrictEqual(hits, []);
});

test('the check finds the 0.24.44 message', () => {
  assert.ok(WRONG.test("'Bypass permissions needs a confirmation in the panel.'"));
  assert.ok(!WRONG.test("'Bypass permissions needs a confirmation in the EditLens window.'"));
});
