'use strict';
require('./isolate');
// The edit hooks never send the text of a key or credentials file (id_rsa, .env, *.pem, files in
// .ssh): the events say only that the file changed. A stand-in server records what the hooks post.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const HOOK = path.join(__dirname, '..', 'hooks', 'live-hook.js');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-hook-secrets-'));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));
const SECRET_TEXT = 'MADE-UP-SECRET-7f3a';

function recorder() {
  const posted = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'POST') posted.push({ url: req.url, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, posted, port: server.address().port })));
}

function hook(phase, input, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, phase], {
      env: { ...process.env, EDITLENS_PORT: String(port), EDITLENS_STATE_DIR: path.join(base, 'state'), EDITLENS_NO_START: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
}

test('edits of key and credentials files are posted without any of their text', async (t) => {
  const rec = await recorder();
  t.after(() => rec.server.close());
  const project = path.join(base, 'shop');
  fs.mkdirSync(path.join(project, 'keys'), { recursive: true });
  const outside = path.join(base, 'home', '.ssh');
  fs.mkdirSync(outside, { recursive: true });
  const files = [path.join(project, 'keys', 'id_rsa'), path.join(project, '.env'), path.join(project, 'cert.pem'), path.join(outside, 'config')];
  for (const file of files) fs.writeFileSync(file, `OLD=${SECRET_TEXT}\n`);
  const common = { session_id: 's1', cwd: project, tool_use_id: 'tu1' };
  for (const file of files) {
    const edit = { file_path: file, old_string: `OLD=${SECRET_TEXT}`, new_string: `NEW=${SECRET_TEXT}` };
    const response = { filePath: file, originalFile: `OLD=${SECRET_TEXT}\n`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-OLD=${SECRET_TEXT}`, `+NEW=${SECRET_TEXT}`] }] };
    assert.strictEqual((await hook('pending', { ...common, tool_name: 'Edit', tool_input: edit }, rec.port)).code, 0);
    fs.writeFileSync(file, `NEW=${SECRET_TEXT}\n`);
    assert.strictEqual((await hook('step', { ...common, tool_name: 'Edit', tool_input: edit, tool_response: response }, rec.port)).code, 0);
    const write = { file_path: file, content: `NEW=${SECRET_TEXT}\n` };
    assert.strictEqual((await hook('step', { ...common, tool_name: 'Write', tool_input: write, tool_response: { ...response, type: 'update' } }, rec.port)).code, 0);
    const multi = { file_path: file, edits: [edit] };
    assert.strictEqual((await hook('step', { ...common, tool_name: 'MultiEdit', tool_input: multi, tool_response: response }, rec.port)).code, 0);
    assert.strictEqual((await hook('ask', { ...common, tool_name: 'Write', tool_input: write }, rec.port)).code, 0);
  }
  const events = rec.posted.filter((p) => p.url === '/event').map((p) => JSON.parse(p.body));
  assert.strictEqual(events.length, files.length * 5, 'every hook posted its event');
  for (const ev of events) {
    assert.strictEqual(ev.secret, true, `${ev.type} ${ev.file || ev.input.file_path} is marked secret`);
    assert.ok(!JSON.stringify(ev).includes(SECRET_TEXT), `${ev.type} includes no file text`);
    for (const k of ['before', 'after', 'content']) assert.strictEqual(ev[k], undefined);
  }
  const change = events.find((e) => e.type === 'change');
  assert.deepStrictEqual(change.hunks, []);
  assert.strictEqual(change.intent, 'Changed the file');
  assert.strictEqual(events.find((e) => e.type === 'pending').existed, true);
  assert.deepStrictEqual(events.find((e) => e.type === 'ask').input, { file_path: files[0] });
});

// Sol H9: a plain name that is a link to a key file (or into a folder of keys) is a key file too.
test('a plain name that leads to a key file is posted without its text', async (t) => {
  const rec = await recorder();
  t.after(() => rec.server.close());
  const project = path.join(base, 'linked');
  fs.mkdirSync(project, { recursive: true });
  const keys = path.join(base, 'home2', '.aws');
  fs.mkdirSync(keys, { recursive: true });
  fs.writeFileSync(path.join(keys, 'config'), `OLD=${SECRET_TEXT}\n`);
  fs.writeFileSync(path.join(base, 'home2', 'id_ed25519'), `OLD=${SECRET_TEXT}\n`);
  fs.symlinkSync(path.join(base, 'home2', 'id_ed25519'), path.join(project, 'notes.txt'));
  fs.symlinkSync(keys, path.join(project, 'cfg'));
  const files = [path.join(project, 'notes.txt'), path.join(project, 'cfg', 'config'), path.join(project, 'cfg', 'new.txt')];
  const common = { session_id: 's1', cwd: project, tool_use_id: 'tu9' };
  for (const file of files) {
    const edit = { file_path: file, old_string: `OLD=${SECRET_TEXT}`, new_string: `NEW=${SECRET_TEXT}` };
    const response = { filePath: file, originalFile: `OLD=${SECRET_TEXT}\n`, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [`-OLD=${SECRET_TEXT}`, `+NEW=${SECRET_TEXT}`] }] };
    assert.strictEqual((await hook('pending', { ...common, tool_name: 'Edit', tool_input: edit }, rec.port)).code, 0);
    assert.strictEqual((await hook('step', { ...common, tool_name: 'Edit', tool_input: edit, tool_response: response }, rec.port)).code, 0);
    assert.strictEqual((await hook('ask', { ...common, tool_name: 'Write', tool_input: { file_path: file, content: `NEW=${SECRET_TEXT}\n` } }, rec.port)).code, 0);
  }
  const events = rec.posted.filter((p) => p.url === '/event').map((p) => JSON.parse(p.body));
  assert.strictEqual(events.length, files.length * 3);
  for (const ev of events) {
    assert.strictEqual(ev.secret, true, `${ev.type} ${ev.file || ev.input.file_path} is marked secret`);
    assert.ok(!JSON.stringify(ev).includes(SECRET_TEXT), `${ev.type} includes no file text`);
  }
});

// H8 (Sol scan of 0.24.43): the working folder is itself in a key folder, so the name relative to it
// (profile.txt) looks ordinary.
test('a file in a working folder that is inside a key folder is posted without its text', async (t) => {
  const { secretPath } = require('../lib/sendproject');
  const rec = await recorder();
  t.after(() => rec.server.close());
  const project = path.join(base, 'review', '.aws');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, 'profile.txt');
  fs.writeFileSync(file, `OLD=${SECRET_TEXT}\n`);
  assert.strictEqual(secretPath(project, file), true);
  assert.strictEqual(secretPath(project, 'profile.txt'), true);
  // A link to the key folder as the working folder: where it really is counts.
  fs.symlinkSync(project, path.join(base, 'review', 'work'));
  assert.strictEqual(secretPath(path.join(base, 'review', 'work'), 'profile.txt'), true);
  const edit = { file_path: file, old_string: `OLD=${SECRET_TEXT}`, new_string: `NEW=${SECRET_TEXT}` };
  assert.strictEqual((await hook('pending', { session_id: 's1', cwd: project, tool_use_id: 'tu8', tool_name: 'Edit', tool_input: edit }, rec.port)).code, 0);
  const ev = JSON.parse(rec.posted.find((p) => p.url === '/event').body);
  assert.strictEqual(ev.secret, true);
  assert.ok(!JSON.stringify(ev).includes(SECRET_TEXT));
});

test('an ordinary file still sends its text', async (t) => {
  const rec = await recorder();
  t.after(() => rec.server.close());
  const project = path.join(base, 'plain');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, '.env.example');
  fs.writeFileSync(file, 'A=1\n');
  const r = await hook('pending', { session_id: 's1', cwd: project, tool_use_id: 'tu2', tool_name: 'Edit', tool_input: { file_path: file, old_string: 'A=1', new_string: 'A=2' } }, rec.port);
  assert.strictEqual(r.code, 0);
  const ev = JSON.parse(rec.posted.find((p) => p.url === '/event').body);
  assert.strictEqual(ev.before, 'A=1\n');
  assert.strictEqual(ev.secret, undefined);
});

test('secretPath: the name, or where it really leads', () => {
  const { secretPath } = require('../lib/sendproject');
  const dir = path.join(base, 'sp');
  fs.mkdirSync(path.join(dir, 'p'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.ssh'));
  fs.writeFileSync(path.join(dir, '.ssh', 'k'), 'x');
  fs.writeFileSync(path.join(dir, 'p', 'a.js'), 'x');
  fs.symlinkSync(path.join(dir, '.ssh', 'k'), path.join(dir, 'p', 'plain.txt'));
  fs.symlinkSync(path.join(dir, 'p', 'a.js'), path.join(dir, 'p', 'b.js'));
  const p = path.join(dir, 'p');
  assert.strictEqual(secretPath(p, path.join(p, 'plain.txt')), true);
  assert.strictEqual(secretPath(p, 'plain.txt'), true, 'relative to the project');
  assert.strictEqual(secretPath(p, path.join(p, 'b.js')), false, 'a link to an ordinary file');
  assert.strictEqual(secretPath(p, path.join(p, 'missing.js')), false);
  assert.strictEqual(secretPath(p, path.join(p, '.env')), true, 'by its name, existing or not');
  assert.strictEqual(secretPath(p, ''), false);
  assert.strictEqual(secretPath(p, null), false);
});

test('secretFile: keys and credentials only, so excluded() keeps one rule', () => {
  const { secretFile, excluded } = require('../lib/sendproject');
  for (const p of ['id_rsa', 'a/b/.env', '.env.local', 'cert.pem', '.ssh/config', '/home/me/.aws/config', 'C:\\Users\\me\\.ssh\\known_hosts', 'api-token.json']) {
    assert.strictEqual(secretFile(p), true, p);
    assert.strictEqual(excluded(p.replace(/\\/g, '/')), true, p);
  }
  for (const p of ['.env.example', 'src/app.js', '.git/config', 'node_modules/x/index.js', '.claude/settings.json', '.mcp.json']) assert.strictEqual(secretFile(p), false, p);
  for (const p of ['.git/config', 'node_modules/x/index.js', '.claude/settings.json', '.mcp.json']) assert.strictEqual(excluded(p), true, p);
});

test('M9: EDITLENS_DEBUG=1 logs what each hook got, but no file text, prompt or command', async (t) => {
  const rec = await recorder();
  t.after(() => rec.server.close());
  const project = path.join(base, 'debug-shop');
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, '.env');
  fs.writeFileSync(file, `OLD=${SECRET_TEXT}\n`);
  const state = path.join(base, 'debug-state');
  const input = { session_id: 's9', cwd: project, tool_use_id: 'tu9', tool_name: 'Write', prompt: SECRET_TEXT, tool_input: { file_path: file, content: `NEW=${SECRET_TEXT}`, command: SECRET_TEXT } };
  const child = spawn(process.execPath, [HOOK, 'pending'], {
    env: { ...process.env, EDITLENS_PORT: String(rec.port), EDITLENS_STATE_DIR: state, EDITLENS_NO_START: '1', EDITLENS_DEBUG: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); child.stdin.end(JSON.stringify(input)); });
  assert.strictEqual(code, 0);
  const log = fs.readFileSync(path.join(state, 'hooks.log'), 'utf8');
  assert.match(log, /pending input: .*"tool_name":"Write"/);
  assert.match(log, /"file_path":"[^"]*\.env"/);
  assert.ok(!log.includes(SECRET_TEXT), log);
});
