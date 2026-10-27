'use strict';
require('./isolate');
// CI (.github/workflows/test.yml) runs every browser script it can: each test/*-preview.js is either
// in the list the browser job runs (test/browser-ci.js) or named there with the reason it is not.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { run, notRun } = require('./browser-ci');

const WORKFLOW = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'test.yml'), 'utf8');

test('every browser script is run by CI or has a reason why not', () => {
  const scripts = fs.readdirSync(__dirname).filter((f) => /^(.+-)?preview\.js$/.test(f)).map((f) => f.replace(/\.js$/, '')).sort();
  const listed = [...run, ...Object.keys(notRun)];
  assert.deepStrictEqual(scripts.filter((s) => !listed.includes(s)), [], 'not in test/browser-ci.js');
  assert.deepStrictEqual(listed.filter((s) => !scripts.includes(s)), [], 'listed but not in the test folder');
  assert.deepStrictEqual(run.filter((s) => s in notRun), [], 'in both lists');
  assert.strictEqual(new Set(run).size, run.length, 'listed twice');
  for (const [name, why] of Object.entries(notRun)) assert.ok(typeof why === 'string' && why.length > 10, `${name}: the reason`);
  assert.ok(run.includes('pair-preview'));
});

test('the browser job runs the scripts in test/browser-ci.js', () => {
  const job = WORKFLOW.slice(WORKFLOW.indexOf('\n  browser:'));
  assert.match(job, /for t in \$\(node -p "require\('\.\/test\/browser-ci'\)\.run\.join\(' '\)"\); do/);
  assert.match(job, /node test\/\$t\.js /);
});

test('the upgrade tests need no git history: the repository may have one commit', () => {
  const src = fs.readFileSync(path.join(__dirname, 'control-restore.test.js'), 'utf8');
  assert.doesNotMatch(src, /spawnSync\('git'|cat-file|git archive/);
});

test('CI runs the mod tests (test/mod.test.ts) with Claude Code\'s test runner', () => {
  const job = WORKFLOW.slice(WORKFLOW.indexOf('\n  mod:'), WORKFLOW.indexOf('\n  browser:'));
  assert.match(job, /npm install -g @anthropic-ai\/claude-code@\d+\.\d+\.\d+\n/);
  assert.match(job, /- run: claude plugin test \.$/m);
});
