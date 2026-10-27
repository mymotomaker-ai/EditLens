'use strict';
require('./isolate');
// Smaller models sometimes send a list argument as JSON text, or one item without the list
// (Haiku sent highlight_on_page { "target": "{ \"marker\": 1 }" }). Those still count.
const test = require('node:test');
const assert = require('node:assert');
const { listArg } = require('../lib/listarg');

test('a list stays a list; JSON text of a list or of one item is read', () => {
  assert.deepStrictEqual(listArg([{ marker: 1 }]), [{ marker: 1 }]);
  assert.deepStrictEqual(listArg('[{"marker":1},{"text":"Buy"}]'), [{ marker: 1 }, { text: 'Buy' }]);
  assert.deepStrictEqual(listArg('{ "marker": 1 }'), [{ marker: 1 }]);
  assert.deepStrictEqual(listArg(' ["a.js", "b.js"] '), ['a.js', 'b.js']);
});

test('one item without the list is a list of one', () => {
  assert.deepStrictEqual(listArg({ marker: 2 }), [{ marker: 2 }]);
  assert.deepStrictEqual(listArg('src/App.jsx'), ['src/App.jsx']);
  assert.deepStrictEqual(listArg('[not json'), ['[not json']);
});

test('nothing given is null, so callers keep their own default', () => {
  for (const v of [undefined, null, '', '   ']) assert.strictEqual(listArg(v), null, JSON.stringify(v));
  assert.strictEqual(listArg('null'), null);
  assert.deepStrictEqual(listArg(3), [3]);
});
