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

// Plugin catalogs score CI hygiene: actions pinned to a commit, read-only permissions, no saved
// git login after checkout, and Dependabot for actions and npm.
test('every workflow pins its actions, reads only, and keeps no git login', () => {
  const dir = path.join(__dirname, '..', '.github', 'workflows');
  const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
  assert.ok(files.length >= 2, 'the test and scan workflows');
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(text, /^permissions:\n {2}contents: read$/m, `${f}: permissions`);
    const uses = [...text.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.ok(uses.length >= 1, `${f}: uses actions`);
    assert.deepStrictEqual(uses.filter((u) => !/@[0-9a-f]{40}$/.test(u)), [], `${f}: actions pinned to a commit`);
    const checkouts = text.split(/\n(?= {6}- )/).filter((s) => /uses: actions\/checkout@/.test(s));
    assert.deepStrictEqual(checkouts.filter((s) => !/persist-credentials: false/.test(s)), [], `${f}: checkout keeps no login`);
  }
  const bot = fs.readFileSync(path.join(__dirname, '..', '.github', 'dependabot.yml'), 'utf8');
  assert.match(bot, /package-ecosystem: "github-actions"/);
  assert.match(bot, /package-ecosystem: "npm"/);
});
