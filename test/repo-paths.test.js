'use strict';
require('./isolate');
// Every file in the repository has a name Windows can check out: no ':' (or < > " | ? *), no
// name ending in a dot or space. One such path stops `/plugin update` on Windows for everyone.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { execFileSync } = require('child_process');

test('tracked paths are valid on Windows', (t) => {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z'], { cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || typeof err.status === 'number')) return t.skip('not a git checkout');
    throw err;
  }
  const bad = out.split('\0').filter(Boolean).filter((p) => p.split('/').some((part) => /[<>:"|?*\\]/.test(part) || /[. ]$/.test(part)));
  assert.deepStrictEqual(bad, []);
});
