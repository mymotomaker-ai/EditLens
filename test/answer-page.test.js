'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5343';
// The answer window's own script: it must parse, and it must find the key at the start of its
// address when a paired computer's window is opened through the link (D11).
const test = require('node:test');
const assert = require('node:assert');
const vm = require('vm');
const { AnswerDesk } = require('../server/answer');

function scripts() {
  const { html } = AnswerDesk.prototype.page.call({}, 'EditLens');
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
}

test('the answer window\'s script parses', () => {
  const all = scripts();
  assert.ok(all.length >= 1);
  for (const src of all) assert.doesNotThrow(() => new vm.Script(src), src.slice(0, 200));
});

test('the answer window finds the key in its address, and none without it', () => {
  const line = scripts().join('\n').split('\n').find((l) => /var BASE =/.test(l));
  assert.ok(line, 'the page reads its key prefix');
  const base = (pathname) => vm.runInNewContext(`${line}; BASE`, { location: { pathname } });
  const gk = `/gk-${'a'.repeat(32)}`;
  assert.strictEqual(base(`${gk}/answer`), gk);
  assert.strictEqual(base('/answer'), '');
});
