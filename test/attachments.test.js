'use strict';
require('./isolate');
// What the user pointed at on the page: cleaned to known fields with whole numbers, and worded for
// Claude with the source location first.
const test = require('node:test');
const assert = require('node:assert');
const { clean, formatAttachments } = require('../lib/attachments');
const { formatMessages } = require('../lib/messages');

test('clean keeps known kinds and fields, removes NaN and junk', () => {
  const out = clean([
    { kind: 'element', n: 1, tag: 'button', classes: ['add', 7, 'primary'], selector: '#cart > button', text: '  Add\n to   cart ', box: { x: 10.4, y: '20', w: 120, h: 36 }, styles: { fontSize: '15px', 'bad key': 'x', color: 5 }, source: { file: 'src/Cart.jsx', line: '42', col: NaN, how: 'exact', components: ['Cart', 'App'] }, extra: 'dropped' },
    { kind: 'element', n: 'two', tag: 'div' },
    { kind: 'region', n: 2, box: { x: 0, y: 100, w: 400, h: NaN }, elements: [{ tag: 'h2', text: 'Menu' }, null] },
    { kind: 'code', n: 3, file: 'server.js', line: 11, endLine: 'x', text: 'const a = 1;' },
    { kind: 'code', n: 4, file: 'server.js', line: 0 },
    { kind: 'script', n: 5 },
  ]);
  assert.deepStrictEqual(out.map((a) => a.n), [1, 2, 3]);
  assert.deepStrictEqual(out[0].classes, ['add', 'primary']);
  assert.strictEqual(out[0].text, 'Add to cart');
  assert.deepStrictEqual(out[0].box, { x: 10, y: 20, w: 120, h: 36 });
  assert.deepStrictEqual(out[0].styles, { fontSize: '15px' });
  assert.deepStrictEqual([out[0].source.line, out[0].source.col], [42, null]);
  assert.strictEqual('extra' in out[0], false);
  assert.strictEqual(out[1].box, null, 'a box with NaN is removed, not sent as NaN');
  assert.deepStrictEqual([out[2].line, out[2].endLine], [11, 11]);
  assert.deepStrictEqual(clean('nope'), []);
  assert.strictEqual(clean(Array.from({ length: 30 }, (_, i) => ({ kind: 'code', n: i + 1, file: 'a.js', line: 1 }))).length, 12);
});

test('Claude gets the source line, the component, the selector and how to point back', () => {
  const text = formatMessages([{ text: 'Make this bigger', attachments: clean([
    { kind: 'element', n: 1, tag: 'button', classes: ['add'], selector: '#cart > button', text: 'Add to cart', source: { file: 'src/Cart.jsx', line: 42, how: 'exact', components: ['Cart', 'App'] } },
    { kind: 'element', n: 2, tag: 'span', source: { file: 'src/App.jsx', how: 'file', components: ['App'] } },
    { kind: 'code', n: 3, file: 'server.js', line: 11, endLine: 16, text: 'const menu = [];' },
  ]) }]);
  assert.match(text, /> Make this bigger/);
  assert.match(text, /\[1\] <button\.add> "Add to cart" — written at src\/Cart\.jsx:42 \(in Cart › App\)/);
  assert.match(text, /selector #cart > button/);
  assert.match(text, /\[2\] <span> — rendered by src\/App\.jsx \(line unknown\)/);
  assert.match(text, /\[3\] Lines 11-16 of server\.js:\n```\nconst menu = \[\];\n```/);
  assert.match(text, /highlight_on_page with a target like \{ "marker": 2 \}/);
  assert.strictEqual(formatAttachments([]), '');
});

test('a shifted React line is labelled as such', () => {
  const text = formatAttachments(clean([{ kind: 'element', n: 1, tag: 'div', source: { file: '/p/src/App.jsx', line: 28, how: 'approx', components: ['StatCard'] } }]));
  assert.match(text, /in \/p\/src\/App\.jsx \(React reports line 28, but Vite shifts it; find the element in the file\) \(in StatCard\)/);
});

test('notes from the box next to a pick: Claude is told a line starting with a number is about it', () => {
  const atts = clean([{ kind: 'element', n: 1, tag: 'h1', text: 'New coffee' }, { kind: 'element', n: 2, tag: 'button', text: 'Order' }]);
  const NOTE = /A line of the message that starts with one of these numbers is about that selection\./;
  assert.match(formatMessages([{ text: '1 Make the heading bolder\n2 Make it green', attachments: atts }]), NOTE);
  assert.match(formatAttachments(atts, 'Two changes:\n2 Make it green'), NOTE);
  assert.doesNotMatch(formatAttachments(atts, 'Make both bigger'), NOTE);
  assert.doesNotMatch(formatAttachments(atts, '3 more pixels'), NOTE, 'a number that is not a selection');
  assert.doesNotMatch(formatAttachments(atts), NOTE);
});
