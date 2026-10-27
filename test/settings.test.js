'use strict';
require('./isolate');
// EditLens settings: declared once (plugin.json userConfig), checked everywhere (no NaN, no
// blanks, no unknown values), reported to the live server by the hooks and the mod, and changed
// from the page only through Claude Code.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-state-'));
process.env.EDITLENS_STATE_DIR = stateDir;
process.env.EDITLENS_PORT = '4374';
const settings = require('../lib/settings');
const guard = require('../lib/guard');
const { devPorts } = require('../lib/connect');
const { ensureServer, stopServer, postJson, postEvent } = require('../lib/client');
const config = require('../lib/config');

const ROOT = path.join(__dirname, '..');

test('every setting has a default that fits it, and the manifest is the one place they are declared', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepStrictEqual(settings.KEYS, Object.keys(manifest.userConfig));
  for (const k of settings.KEYS) {
    const f = settings.SCHEMA[k];
    assert.ok(f.title && f.description, `${k} has a title and a description`);
    assert.strictEqual(settings.check(k, f.default), f.default, `${k}'s default fits`);
    if (f.options) for (const o of f.options) assert.ok(o.length >= 1 && o.length <= 64, `${k} option "${o}" is a plain label`);
  }
  // Bypass is never a choice.
  assert.ok(!settings.SCHEMA.permission_mode.options.some((o) => /bypass/i.test(o)));
  // The page can't change the safety check, auto connect or the port.
  for (const k of ['safety_check', 'auto_connect', 'remote_tasks', 'permission_mode', 'port']) assert.ok(!settings.PAGE_EDITABLE.includes(k), k);
  for (const k of settings.PAGE_EDITABLE) assert.ok(settings.KEYS.includes(k), k);
});

test('values that do not fit use the default: NaN, blanks, unknown options, out of range', () => {
  const d = settings.defaults();
  const v = settings.normalize({ port: 'NaN', theme: '  ', text_size: 'Huge', safety_check: 'maybe', wait: 'true', highlight: false, start: ' Connect and turn on page control ', extra: 1 });
  assert.strictEqual(v.port, d.port);
  assert.strictEqual(v.theme, d.theme);
  assert.strictEqual(v.text_size, d.text_size);
  assert.strictEqual(v.safety_check, true);
  assert.strictEqual(v.wait, true);
  assert.strictEqual(v.highlight, false);
  assert.strictEqual(v.start, 'Connect and turn on page control');
  assert.ok(!('extra' in v));
  for (const bad of [NaN, Infinity, 80, 70000, 4317.5, '', ' ', null, undefined, '43a']) assert.strictEqual(settings.check('port', bad), undefined, String(bad));
  assert.strictEqual(settings.check('port', '5000'), 5000);
  // Text numbers are digits only.
  for (const bad of ['1e3', '0x1100', '4705.0', '+4705', '4705x', ' 4 705', true, [4705]]) assert.strictEqual(settings.check('port', bad), undefined, String(bad));
  assert.strictEqual(settings.check('port', ' 4705 '), 4705);
  assert.deepStrictEqual(settings.normalize(null), d);
  assert.strictEqual(settings.check('nope', 1), undefined);
  assert.ok(Object.values(settings.normalize({ port: NaN })).every((x) => x !== undefined && x !== '' && !Number.isNaN(x)));
});

test('hooks read the settings Claude Code gives them; the mode never becomes Bypass', () => {
  const env = settings.fromEnv({ CLAUDE_PLUGIN_OPTION_THEME: 'Dark', CLAUDE_PLUGIN_OPTION_PORT: 'abc', CLAUDE_PLUGIN_OPTION_PERMISSION_MODE: 'Accept edits' });
  assert.strictEqual(env.set, true);
  assert.strictEqual(env.values.theme, 'Dark');
  assert.strictEqual(env.values.port, 4317);
  assert.strictEqual(settings.modeId(env.values), 'acceptEdits');
  assert.strictEqual(settings.modeId({ permission_mode: 'Bypass permissions' }), 'auto');
  assert.strictEqual(settings.fromEnv({}).set, false);
  assert.strictEqual(settings.startsControl({ start: 'Connect and turn on page control' }), true);
  assert.strictEqual(settings.startsControl(null), false);
});

test('the Safety check setting turns the guard off; the driver passes its own setting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-guard-'));
  const file = path.join(dir, 'App.jsx');
  fs.writeFileSync(file, Array.from({ length: 20 }, (_, i) => `export const a${i} = ${i};`).join('\n'));
  const input = { file_path: file, content: 'export default 1;\n' };
  try {
    assert.ok(guard.check('Write', input, dir));
    assert.strictEqual(guard.check('Write', input, dir, { off: true }), null);
    process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK = 'false';
    assert.strictEqual(guard.check('Write', input, dir), null);
    process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK = 'true';
    assert.ok(guard.check('Write', input, dir));
  } finally {
    delete process.env.CLAUDE_PLUGIN_OPTION_SAFETY_CHECK;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the mod checks values the same way', async () => {
  const mod = await import(path.join(ROOT, 'hooks', 'mod.mjs'));
  const port = settings.SCHEMA.port;
  assert.strictEqual(mod.settingValue(port, NaN), 4317);
  assert.strictEqual(mod.settingValue(port, '5000'), 5000);
  assert.strictEqual(mod.settingValue(port, ''), 4317);
  assert.strictEqual(mod.settingValue(settings.SCHEMA.theme, 'Neon'), 'Auto');
  assert.strictEqual(mod.settingValue(settings.SCHEMA.wait, 'true'), true, 'the same true/false spellings as settings.check');
  assert.strictEqual(mod.settingValue(settings.SCHEMA.wait, 'maybe'), false);
  assert.deepStrictEqual(mod.settingsOf(settings.SCHEMA, {}), settings.defaults());
  assert.strictEqual(mod.nextValue(settings.SCHEMA.theme, 'Dark'), 'Auto');
  assert.strictEqual(mod.nextValue(settings.SCHEMA.wait, false), true);
  assert.strictEqual(mod.nextValue(port, 4317), undefined, 'the port is changed in /config only');
  assert.strictEqual(mod.shownValue(settings.SCHEMA.wait, true), 'On');
  assert.ok(!/NaN|undefined/.test(mod.settingsText(settings.SCHEMA, {})));
});

test('the dev server port comes from the dev script, then the framework', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-settings-ports-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'next dev -p 3005' }, dependencies: { next: '15' } }));
    assert.deepStrictEqual(devPorts(dir), [3005, 3000]);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
    assert.deepStrictEqual(devPorts(dir), [3000, 8080, 5000, 8000]);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { dev: 'PORT=4100 node server.js --port 4200' }, dependencies: { astro: '4' } }));
    assert.deepStrictEqual(devPorts(dir), [4200, 4100, 4321]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('/editlens: help, settings and an unknown word answer without connecting anything', () => {
  const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'start.js'), ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_OPTION_THEME: 'Dark' } });
  const help = run('help');
  assert.strictEqual(help.status, 0);
  assert.match(help.stdout, /\/editlens stop/);
  const s = run('settings');
  // A group too long for one row continues under its value (80 columns at most).
  assert.match(s.stdout, /On the page ·+ highlights on [^\n]*\n {4,}dictation On this device · follow on\n {4,}highlight when waiting on · colors Dark · text /);
  assert.match(s.stdout, /\/config/);
  assert.doesNotMatch(s.stdout, /NaN|undefined/);
  const bad = run('example.com');
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stdout, /isn't something \/editlens knows/);
});

function request(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: config.port, path: urlPath, method, headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text || 'null');
        } catch (err) {
          if (!(err instanceof SyntaxError)) throw err;
          json = { text };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

test('the server: hooks and the mod report the settings, a page asks for changes through Claude Code', async (t) => {
  await ensureServer();
  const events = new AbortController();
  t.after(async () => {
    events.abort();
    await stopServer();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });
  // A page with the panel open.
  const frames = [];
  const res = await fetch(`${config.baseUrl}/events?page=pg1&root=${encodeURIComponent(path.join(stateDir, 'site'))}&url=${encodeURIComponent('http://127.0.0.1:5173/')}`, { signal: events.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) frames.push(JSON.parse(line.slice(6)));
      }
    }
  })().catch((err) => {
    if (err.name !== 'AbortError') throw err;
  });
  await new Promise((r) => setTimeout(r, 300));
  const first = frames.find((f) => f.type === 'settings');
  assert.ok(first, 'a page gets the settings when it connects');
  assert.strictEqual(first.canChange, false);
  assert.deepStrictEqual(first.values, settings.defaults());

  // A hook reports what Claude Code gave it; the page gets it, and the event itself has no settings.
  await postEvent({ type: 'session', sessionId: 's1', cwd: stateDir, ts: Date.now(), settings: { theme: 'Dark', port: 'NaN' } });
  await new Promise((r) => setTimeout(r, 200));
  const after = frames.filter((f) => f.type === 'settings').pop();
  assert.strictEqual(after.values.theme, 'Dark');
  assert.strictEqual(after.values.port, 4317);
  assert.ok(!frames.some((f) => f.type === 'session' && 'settings' in f));

  // Without the mod, a page's change stays on the page.
  let r = await request('POST', '/settings', { page: 'pg1', key: 'theme', value: 'Light' }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error, 'local');
  // Not a page the server knows, a setting the page can't change, a value that doesn't fit.
  r = await request('POST', '/settings', { page: 'nope', key: 'theme', value: 'Light' }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 403);
  r = await request('POST', '/settings', { page: 'pg1', key: 'safety_check', value: false }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 403);
  r = await request('POST', '/settings', { page: 'pg1', key: 'text_size', value: 'Huge' }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 400);
  r = await request('POST', '/settings', { page: 'pg1', key: 'theme', value: 'Light' }, { Origin: 'http://evil.example' });
  assert.strictEqual(r.status, 403);

  // The mod polls (no Origin: a page can't pretend to be it), then a page's change waits for it.
  r = await request('GET', `/summary?cwd=${encodeURIComponent(stateDir)}&mod=1`, undefined, { Origin: 'http://127.0.0.1:5173' });
  r = await request('POST', '/settings', { page: 'pg1', key: 'theme', value: 'Light' }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 409, 'a page asking for the summary with mod=1 is not the mod');
  // Nor is another local program without the server's key.
  r = await request('GET', `/summary?cwd=${encodeURIComponent(stateDir)}&mod=1`);
  r = await request('POST', '/settings', { page: 'pg1', key: 'theme', value: 'Light' }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 409, 'mod=1 without the key is not the mod');
  const modKey = { 'x-editlens-token': fs.readFileSync(config.tokenFile, 'utf8').trim() };
  r = await request('GET', `/summary?cwd=${encodeURIComponent(stateDir)}&mod=1`, undefined, modKey);
  assert.deepStrictEqual(r.json.settingsPending, []);
  r = await request('POST', '/settings', { page: 'pg1', key: 'theme', value: 'Light' }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.values.theme, 'Light');
  r = await request('GET', `/summary?cwd=${encodeURIComponent(stateDir)}&mod=1`, undefined, modKey);
  assert.deepStrictEqual(r.json.settingsPending.map((p) => [p.key, p.value]), [['theme', 'Light']]);
  // Reset asks for every setting the page may change.
  r = await request('POST', '/settings', { page: 'pg1', reset: true }, { Origin: 'http://127.0.0.1:5173' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.values.theme, 'Auto');

  // The mod made the change in Claude Code and reports it: nothing is left waiting.
  r = await request('POST', '/settings/report', { values: { theme: 'Auto' }, from: 'mod' });
  assert.strictEqual(r.status, 401, 'reports need the key');
  const out = await postJson('/settings/report', { values: { ...settings.defaults(), theme: 'Auto' }, from: 'mod' });
  assert.strictEqual(out.values.theme, 'Auto');
  r = await request('GET', `/summary?cwd=${encodeURIComponent(stateDir)}&mod=1`, undefined, modKey);
  assert.deepStrictEqual(r.json.settingsPending, []);
  const last = frames.filter((f) => f.type === 'settings').pop();
  assert.strictEqual(last.canChange, true);
  assert.strictEqual(last.values.theme, 'Auto');
  assert.ok(last.fields.every((f) => typeof f.title === 'string' && f.value !== undefined));
});
