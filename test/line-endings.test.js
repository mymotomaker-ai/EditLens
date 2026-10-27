'use strict';
require('./isolate');
// Text files keep LF line endings, also in a copy made on Windows: a script starting with
// "#!/usr/bin/env node" and CRLF fails on Linux and macOS ("node\r" is not found).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TEXT = /\.(js|mjs|jsx|ts|json|md|css|html|yml|sh)$/;

test('.gitattributes checks text files out with LF on every computer', () => {
  const lines = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split('\n').map((l) => l.trim());
  assert.ok(lines.includes('* text=auto eol=lf'), lines.join('\n'));
});

test('no text file in the plugin has CRLF line endings', () => {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && TEXT.test(e.name) && fs.readFileSync(p, 'utf8').includes('\r\n')) found.push(path.relative(ROOT, p));
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(found, []);
});
