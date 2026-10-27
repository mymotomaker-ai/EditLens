'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4911';
// The rename to EditLens: what the plugin kept under its old name moves to the new state folder,
// lines marked with the old markers are still found and removed, and /editlens is the only
// command (the old words are gone).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { migrateState } = require('../lib/migrate');
const { removeMarked, findIntegrations } = require('../lib/connect');

const BIN = path.join(__dirname, '..', 'bin');

test('the old state folder moves to the new one, keeping what is already there', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-migrate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const from = path.join(home, '.claude', 'claude-live-mode');
  const to = path.join(home, '.claude', 'editlens');
  fs.mkdirSync(path.join(from, 'sdk', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(from, 'sdk', 'node_modules', 'x.js'), 'sdk');
  fs.writeFileSync(path.join(from, 'statusline.js'), 'old script');
  fs.writeFileSync(path.join(from, 'hooks.log'), 'old log');
  fs.mkdirSync(to, { recursive: true });
  fs.writeFileSync(path.join(to, 'statusline.js'), 'new script');
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: `node "${from.replace(/\\/g, '/')}/statusline.js"` } }));

  const out = migrateState(from, to);
  assert.deepStrictEqual(out.moved.sort(), ['hooks.log', 'sdk']);
  assert.strictEqual(fs.readFileSync(path.join(to, 'sdk', 'node_modules', 'x.js'), 'utf8'), 'sdk');
  assert.strictEqual(fs.readFileSync(path.join(to, 'statusline.js'), 'utf8'), 'new script', 'the new copy is kept');
  // The status line in the user's settings still points at the old folder: a stub there runs the
  // new script, and the settings file is not changed.
  const stub = fs.readFileSync(path.join(from, 'statusline.js'), 'utf8');
  assert.match(stub, /require\(/);
  assert.ok(stub.includes(JSON.stringify(path.join(to, 'statusline.js'))));
  assert.deepStrictEqual(fs.readdirSync(from), ['statusline.js']);
  assert.match(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), /claude-live-mode/);

  // Nothing to move the second time; no settings that name the old script: the old folder is removed.
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
  fs.rmSync(path.join(from, 'statusline.js'));
  assert.deepStrictEqual(migrateState(from, to).moved, []);
  assert.strictEqual(fs.existsSync(from), false);
  assert.deepStrictEqual(migrateState(path.join(home, 'none'), to), { moved: [] });
});

test('lines marked before the rename are still found and taken out', (t) => {
  const old = 'import x from "y";\n// live-edits:start\nimport claudeLive from "/p/integrations/vite.mjs";\n// live-edits:end\nexport default 1;\n';
  assert.deepStrictEqual(removeMarked(old), { text: 'import x from "y";\nexport default 1;\n', removed: 3 });
  const both = 'a\n// editlens:start\nb\n// editlens:end\nc\n<!-- live-edits:start -->\nd\n<!-- live-edits:end -->\n';
  assert.strictEqual(removeMarked(both).text, 'a\nc\n');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-marks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'vite.config.js'), old);
  const found = findIntegrations(dir);
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].marked, true);
});

test('/editlens is the one command: usage shows the status line, old words are gone', (t) => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-cmdwords-'));
  t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const env = { ...process.env, EDITLENS_STATE_DIR: stateDir, EDITLENS_PORT: '4397' };
  const usage = execFileSync(process.execPath, [path.join(BIN, 'start.js'), 'usage'], { env, encoding: 'utf8' });
  assert.ok(usage.includes(JSON.stringify(`node "${path.join(stateDir, 'statusline.js').split(path.sep).join('/')}"`)), usage);
  assert.match(usage, /"statusLine"/);
  for (const word of ['drive', 'disconnect', 'off', 'on', 'connect', 'config', '?']) {
    const out = spawnSync(process.execPath, [path.join(BIN, 'start.js'), word], { env, encoding: 'utf8' });
    assert.strictEqual(out.status, 1, word);
    assert.match(out.stdout, /isn't something \/editlens knows/, word);
  }
  assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'commands')), false, 'no plugin command files');
});
