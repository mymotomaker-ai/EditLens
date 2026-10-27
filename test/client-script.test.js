'use strict';
require('./isolate');
// The page script is kept as parts in client/src (the plugin directory refuses files over 256 KiB).
// Joined, they are one valid script, with the same version as the plugin.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');
const { clientScript, partFiles } = require('../lib/client-script');
const pkg = require('../package.json');

test('every part is under the directory size limit', () => {
  const parts = partFiles();
  assert.ok(parts.length >= 2);
  for (const f of parts) assert.ok(fs.statSync(f).size < 256 * 1024, `${f}: ${fs.statSync(f).size} bytes`);
});

test('the joined parts are one script with no name defined twice', () => {
  const js = clientScript();
  assert.doesNotThrow(() => new vm.Script(js, { filename: 'live.js' }));
  assert.match(js, /^\/\*[\s\S]*\(function \(\) \{/);
  assert.match(js, /\}\)\(\);\s*$/);
  const names = js.match(/^ {2}(?:function|var) \w+/gm).map((l) => l.trim());
  const twice = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepStrictEqual(twice, []);
  assert.strictEqual((/var VERSION = '([^']+)'/.exec(js) || [])[1], pkg.version);
});
