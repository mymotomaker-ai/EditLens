'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5257';
// Sol L1: "the chat is too long" names the command that starts a new chat (/editlens new makes a
// starter page, it does not start a chat); a task says to start a new task.
const test = require('node:test');
const assert = require('node:assert');
const { plainSdk } = require('../lib/sdkerr');

test('too long: page control says /editlens control new, a task says to start a new task', () => {
  for (const raw of ['prompt is too long: 210000 tokens > 200000 maximum', 'context length exceeded for this model']) {
    const page = plainSdk(raw).text;
    assert.match(page, /\/editlens control new\.$/);
    assert.doesNotMatch(page, /\/editlens new\b/);
    assert.strictEqual(plainSdk(raw, undefined, { task: true }).text, 'The chat is too long for Claude. Start a new task.');
  }
  assert.strictEqual(plainSdk('credit balance is too low', undefined, { task: true }).text, 'Your Anthropic account has no credit left.');
});
