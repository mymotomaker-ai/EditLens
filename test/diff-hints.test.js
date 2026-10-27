'use strict';
require('./isolate');
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffText, normalizeStructuredPatch, clampHunks, countStats } = require('../lib/diff');
const { buildHints } = require('../lib/hints');

test('diffText finds a one-line change with context', () => {
  const hunks = diffText('a\nb\nc\nd\ne\n', 'a\nb\nX\nd\ne\n');
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].newStart, 1);
  assert.deepEqual(hunks[0].lines, [' a', ' b', '-c', '+X', ' d', ' e']);
  assert.deepEqual(countStats(hunks), { added: 1, removed: 1 });
});

test('diffText handles create and delete', () => {
  assert.deepEqual(countStats(diffText('', 'x\ny')), { added: 2, removed: 0 });
  assert.deepEqual(countStats(diffText('x\ny', '')), { added: 0, removed: 2 });
  assert.deepEqual(diffText('same', 'same'), []);
});

test('diffText splits distant changes into separate hunks', () => {
  const a = Array.from({ length: 30 }, (_, i) => 'l' + i).join('\n');
  const b = a.replace('l2', 'L2').replace('l25', 'L25');
  const hunks = diffText(a, b);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[1].newStart, 24);
});

test('normalizeStructuredPatch rejects NaN line numbers', () => {
  assert.equal(normalizeStructuredPatch([{ oldStart: 'x', newStart: 1, lines: [] }]), null);
  assert.equal(normalizeStructuredPatch(null), null);
  const ok = normalizeStructuredPatch([{ oldStart: 3, newStart: 3, lines: [' a', '+b', 'junk'] }]);
  assert.deepEqual(ok, [{ oldStart: 3, newStart: 3, lines: [' a', '+b'] }]);
});

test('clampHunks caps huge writes', () => {
  const big = diffText('', Array.from({ length: 1000 }, (_, i) => 'x' + i).join('\n'));
  const { hunks, truncated } = clampHunks(big);
  assert.equal(truncated, true);
  assert.equal(hunks.reduce((n, h) => n + h.lines.length, 0), 400);
});

test('hints: markup ids, classes and text', () => {
  const hunks = diffText('', '<section id="pricing" class="plans grid">\n  <h2>Simple pricing for teams</h2>\n');
  const h = buildHints({ ext: '.html', hunks, fileText: null });
  assert.deepEqual(h.ids, ['pricing']);
  assert.deepEqual(h.classes, ['plans', 'grid']);
  assert.ok(h.texts.includes('Simple pricing for teams'));
});

test('hints: JSX className and string literals', () => {
  const hunks = diffText('', '<button className="cta" onClick={go}>{"Start your free trial"}</button>');
  const h = buildHints({ ext: '.tsx', hunks, fileText: null });
  assert.deepEqual(h.classes, ['cta']);
  assert.ok(h.texts.includes('Start your free trial'));
});

test('hints: CSS change maps to its enclosing selector, skipping @media', () => {
  const css = '.a { color: red; }\n@media (max-width: 600px) {\n  .hero-title,\n  .hero h1 {\n    font-size: 30px;\n  }\n}\n';
  const hunks = [{ oldStart: 5, newStart: 5, lines: ['+    font-size: 30px;'] }];
  const h = buildHints({ ext: '.css', hunks, fileText: css });
  assert.deepEqual(h.selectors, ['.hero-title', '.hero h1']);
});

test('hints: CSS change after a closed rule does not pick that rule', () => {
  const css = '.a {\n  color: red;\n}\n.b {\n  color: blue;\n}\n';
  const hunks = [{ oldStart: 5, newStart: 5, lines: ['+  color: blue;'] }];
  assert.deepEqual(buildHints({ ext: '.css', hunks, fileText: css }).selectors, ['.b']);
});
