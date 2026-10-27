'use strict';
require('./isolate');
// Settings check S18 and S19: the setting texts say which computer and which place they mean. The
// refusals name /config (the command that changes a setting), and the computer by name where "there"
// could mean this one; the descriptions say what the panel's mode menu changes and stay short.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const SCHEMA = JSON.parse(read('.claude-plugin/plugin.json')).userConfig;

test('refusals about another computer\'s settings name /config and the computer (S19)', () => {
  // Template literals: only a quoted script path counts as one this file runs (test/ports.test.js).
  const files = [`server/server.js`, `server/pair-host.js`, 'client/src/2-page.js'];
  for (const rel of files) {
    const src = read(rel);
    assert.doesNotMatch(src, /\/editlens settings there/, `${rel}: /editlens settings only shows them`);
    assert.doesNotMatch(src, /in \/config there/, `${rel}: "there" is this computer on the host's own task card`);
  }
  // One text for every refusal of a paired computer's work here (tasks.runsOff, used by server.js too).
  // A computer's name has ◆ before it, as on the page (A49-1).
  assert.match(read(`server/tasks.js`), /turned off on ◆ \$\{this\.host\} \("Paired computers can run Claude here" in \/config on ◆ \$\{this\.host\}/);
  assert.match(read(`server/server.js`), /tasks\.runsOff\(\)/);
  assert.match(read(`server/pair-host.js`), /turned off on ◆ \$\{this\.name\} \("Paired computers can run Claude here" in \/config on ◆ \$\{this\.name\}/);
  assert.match(read(`server/server.js`), /const PAIR_ANSWER_OFF = '[^']*"Paired computers can answer questions here" in \/config on that computer\./);
  assert.match(read('client/src/2-page.js'), /"Paired computers can answer questions here" in \/config on ◆ ' \+ state\.via/);
});

test('the setting descriptions are short and say which computer and which mode (S18, S19)', () => {
  // start: two short sentences, no parenthesis inside a parenthesis.
  const start = SCHEMA.start.description;
  assert.doesNotMatch(start, /\([^)]*\(/, start);
  assert.ok(start.split(/\.\s/).length <= 2 && start.split(/\.\s/).every((s) => s.length <= 150), start);
  // task_account: the EditLens window of this computer, not "there".
  assert.doesNotMatch(SCHEMA.task_account.description, /window there/);
  assert.match(SCHEMA.task_account.description, /this computer's EditLens window/);
  // permission_mode: the saved setting is the mode page control starts in; the panel's menu changes
  // only the page control that runs (the card says "change in /config" for the saved one).
  assert.match(SCHEMA.permission_mode.description, /starts in/);
  assert.match(SCHEMA.permission_mode.description, /message box changes it for the page control that runs now/);
});
