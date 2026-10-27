'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '5530';
// Settings check 0.24.48 T1: a command Claude runs with its Bash tool (print mode, SDK sessions, a
// refused mod) gets no CLAUDE_PLUGIN_OPTION_* values, so it reads what Claude Code saved (read only),
// says which saved values are not valid, and names the port this session's server uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempInRun } = require('./isolate');

const ROOT = path.join(__dirname, '..');
const settings = require('../lib/settings');

const SAVED = { permission_mode: 'Plan', effort: 'High', highlight: false, theme: 'Dark', port: 6722, tasks_at_once: 9 };

// A Claude settings folder with this plugin's saved options, and a state folder.
function folders(options) {
  const dir = tempInRun('editlens-saved-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.mkdirSync(path.join(dir, 'state'));
  const data = { pluginConfigs: { 'editlens@editlens': { options } } };
  fs.writeFileSync(path.join(dir, 'config', 'settings.json'), JSON.stringify(data));
  return { config: path.join(dir, 'config'), state: path.join(dir, 'state') };
}

// The environment of a command Claude ran with its Bash tool: no plugin options, no EDITLENS_PORT.
function bashEnv(extra) {
  const env = { ...process.env, EDITLENS_SAY: '', EDITLENS_NO_START: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDE_PLUGIN_OPTION_')) delete env[k];
  delete env.EDITLENS_PORT;
  delete env.EDITLENS_GUARD;
  return { ...env, ...extra };
}

function settingsOut(env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), 'settings'], { encoding: 'utf8', env });
  assert.strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

test('/editlens settings with no plugin options: the saved values, the invalid one named, the port in use', () => {
  const f = folders(SAVED);
  const before = fs.readFileSync(path.join(f.config, 'settings.json'), 'utf8');
  // This session's server started on 5531, before the Port setting changed to 6722.
  fs.mkdirSync(path.join(f.state, 'session-ports'));
  fs.writeFileSync(path.join(f.state, 'session-ports', 'sess-t1'), '5531');
  const out = settingsOut(bashEnv({ CLAUDE_CONFIG_DIR: f.config, EDITLENS_STATE_DIR: f.state, CLAUDE_CODE_SESSION_ID: 'sess-t1' }));
  assert.match(out, /mode Plan/, out);
  assert.match(out, /effort High/, out);
  assert.match(out, /highlights off/, out);
  assert.match(out, /colors Dark/, out);
  assert.match(out, /port 6722/, out);
  assert.match(out, /Tasks at once: "9" is not a valid value, so the default is used\./, out);
  assert.match(out, /EditLens uses port 5531 until Claude Code restarts \(the Port setting is 6722\)\./, out);
  assert.strictEqual(fs.readFileSync(path.join(f.config, 'settings.json'), 'utf8'), before, 'the settings file is only read');

  // No port kept for the session: the server uses the Port setting, so no note.
  const plain = settingsOut(bashEnv({ CLAUDE_CONFIG_DIR: f.config, EDITLENS_STATE_DIR: f.state, CLAUDE_CODE_SESSION_ID: 'sess-other' }));
  assert.match(plain, /port 6722/, plain);
  assert.doesNotMatch(plain, /EditLens uses port/, plain);
});

test('/editlens settings with plugin options: those values, not the saved ones', () => {
  const f = folders(SAVED);
  const out = settingsOut(bashEnv({ CLAUDE_CONFIG_DIR: f.config, EDITLENS_STATE_DIR: f.state, CLAUDE_PLUGIN_OPTION_PERMISSION_MODE: 'Ask' }));
  assert.match(out, /mode Ask/, out);
  assert.doesNotMatch(out, /mode Plan/, out);
  assert.doesNotMatch(out, /"9" is not a valid value/, out);
});

test('settings.given(): the options Claude Code gave, else the saved ones, else the defaults', () => {
  const f = folders(SAVED);
  const saved = settings.given({ CLAUDE_CONFIG_DIR: f.config });
  assert.strictEqual(saved.from, 'saved');
  assert.strictEqual(saved.values.permission_mode, 'Plan');
  assert.strictEqual(saved.values.port, 6722);
  assert.strictEqual(saved.values.tasks_at_once, settings.defaults().tasks_at_once, 'an invalid saved value: the default');
  assert.strictEqual(saved.raw.tasks_at_once, '9', 'the invalid value as saved, for the note');
  const env = settings.given({ CLAUDE_CONFIG_DIR: f.config, CLAUDE_PLUGIN_OPTION_START: 'Connect the page' });
  assert.strictEqual(env.from, 'env');
  assert.strictEqual(env.values.start, 'Connect the page');
  assert.strictEqual(env.values.permission_mode, 'Auto', 'with options given, the saved file is not read');
  const none = settings.given({ CLAUDE_CONFIG_DIR: path.join(f.config, 'missing') });
  assert.strictEqual(none.from, 'defaults');
  assert.deepStrictEqual(none.values, settings.defaults());
  // The start setting (page control at /editlens) is read the same way.
  const start = settings.given({ CLAUDE_CONFIG_DIR: folders({ start: 'Connect the page' }).config });
  assert.strictEqual(settings.startsControlNow({ values: start.values, env: {} }), false);
});

test('commands read settings through settings.given(), never only from CLAUDE_PLUGIN_OPTION_*', () => {
  const bin = path.join(ROOT, 'bin');
  for (const name of fs.readdirSync(bin).filter((n) => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(bin, name), 'utf8');
    assert.doesNotMatch(src, /\bfromEnv\(/, `${name} reads only the plugin options; use settings.given()`);
    assert.doesNotMatch(src, /CLAUDE_PLUGIN_OPTION_/, `${name} reads the plugin options directly; use settings.given()`);
  }
});

// A server started by such a command (ensureServer gives no plugin options) starts from the saved
// values, not the defaults, until Claude Code reports its settings.
test('T1: a server started with no plugin options uses the saved settings', async () => {
  const f = folders({ tasks_at_once: 1, effort: 'Low', theme: 'Dark' });
  const env = bashEnv({ CLAUDE_CONFIG_DIR: f.config, EDITLENS_STATE_DIR: f.state, EDITLENS_PORT: '5532' });
  const { spawn } = require('child_process');
  const http = require('http');
  const server = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env, stdio: 'ignore' });
  const get = () => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 5532, path: '/settings', agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(res.statusCode === 200 ? JSON.parse(text) : null));
    });
    req.on('error', (err) => { if (err.code !== 'ECONNREFUSED') throw err; resolve(null); });
  });
  try {
    let s = null;
    for (let i = 0; i < 100 && !s; i++) {
      s = await get();
      if (!s) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(s, 'the server answered');
    assert.strictEqual(s.values.tasks_at_once, 1);
    assert.strictEqual(s.values.effort, 'Low');
    assert.strictEqual(s.values.theme, 'Dark');
  } finally {
    server.kill();
  }
});
