'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4912';
// An Edit with replace_all and no structuredPatch from Claude Code: every replaced place is marked
// (on the page and in the code view), at its own line, not only the first one.
const test = require('node:test');
const assert = require('node:assert');
const { changeHunks } = require('../hooks/live-hook');

const before = ['const total = 1;', 'log(total);', '', 'function f() {', '  return total + 1;', '}', 'export { total };', ''].join('\n');
const after = before.split('total').join('sum');
// The snippet lines each hunk adds (or removes), with the line number each is on in the new (old) file.
const added = (hunks) => hunks.flatMap((h) => {
  let n = h.newStart;
  const out = [];
  for (const l of h.lines) {
    if (l[0] === '+') out.push(`${n}:${l.slice(1)}`);
    if (l[0] !== '-') n++;
  }
  return out;
});
const removedAt = (hunks) => hunks.flatMap((h) => {
  let n = h.oldStart;
  const out = [];
  for (const l of h.lines) {
    if (l[0] === '-') out.push(`${n}:${l.slice(1)}`);
    if (l[0] !== '+') n++;
  }
  return out;
});

test('replace_all marks every place, from the file now', () => {
  const input = { tool_name: 'Edit', tool_input: { file_path: '/p/a.js', old_string: 'total', new_string: 'sum', replace_all: true }, tool_response: {} };
  const hunks = changeHunks(input, after);
  assert.deepStrictEqual(added(hunks), ['1:sum', '2:sum', '5:sum', '7:sum']);
});

test('replace_all with the file before (originalFile): exact places, also when lines are added', () => {
  const grown = before.split('total').join('a\nb');
  const input = { tool_name: 'Edit', tool_input: { file_path: '/p/a.js', old_string: 'total', new_string: 'a\nb', replace_all: true }, tool_response: { originalFile: before } };
  const hunks = changeHunks(input, grown);
  assert.deepStrictEqual(removedAt(hunks), ['1:total', '2:total', '5:total', '7:total']);
  const lines = grown.split('\n');
  for (const a of added(hunks)) {
    const [n, text] = [Number(a.split(':')[0]), a.slice(a.indexOf(':') + 1)];
    assert.ok(lines[n - 1].includes(text), `line ${n} of the new file has what the hunk adds (${text})`);
  }
  assert.deepStrictEqual(added(hunks).map((a) => Number(a.split(':')[0])), [1, 2, 3, 4, 7, 8, 10, 11]);
});

test('without replace_all only the first place is marked, as before', () => {
  const input = { tool_name: 'Edit', tool_input: { file_path: '/p/a.js', old_string: 'log(total);', new_string: 'log(total, 2);' }, tool_response: {} };
  const hunks = changeHunks(input, before.replace('log(total);', 'log(total, 2);'));
  assert.deepStrictEqual(added(hunks), ['2:log(total, 2);']);
});

test('MultiEdit with replace_all marks every place of that edit', () => {
  const input = { tool_name: 'MultiEdit', tool_input: { file_path: '/p/a.js', edits: [{ old_string: 'total', new_string: 'sum', replace_all: true }, null] }, tool_response: {} };
  assert.strictEqual(added(changeHunks(input, after)).length, 4);
});
