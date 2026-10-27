'use strict';
require('./isolate');
// The live-page MCP server answers malformed input with an error instead of exiting.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

test('JSON that is not a request object gets -32600, and the server keeps answering', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, EDITLENS_PORT: '4395' } });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
  });
  for (const bad of ['null', '1', '[]', '"x"', '{oops']) child.stdin.write(bad + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  const started = Date.now();
  while (lines.length < 6 && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(child.exitCode, null, 'still running');
  child.kill();
  assert.deepStrictEqual(lines.slice(0, 4).map((l) => l.error.code), [-32600, -32600, -32600, -32600]);
  assert.strictEqual(lines[4].error.code, -32700);
  assert.deepStrictEqual(lines[5], { jsonrpc: '2.0', id: 7, result: {} });
});

test('show_code opens only files inside the project, never secrets', async () => {
  const fs = require('fs');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-mcp-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const project = path.join(dir, 'site');
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.env'), 'KEY=1\n');
  fs.writeFileSync(path.join(dir, 'outside.txt'), 'no\n');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: project, env: { ...process.env, CLAUDE_PROJECT_DIR: project, EDITLENS_PORT: '4396' } });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
  });
  const call = (id, file) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'show_code', arguments: { file } } }) + '\n');
  call(1, '../outside.txt');
  call(2, '.env');
  call(3, path.join(dir, 'outside.txt'));
  const started = Date.now();
  while (lines.length < 3 && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.strictEqual(lines.length, 3);
  for (const l of lines) assert.strictEqual(l.result.isError, true, l.result.content[0].text);
  assert.match(lines[0].result.content[0].text, /outside this project/);
  assert.match(lines[1].result.content[0].text, /hidden/);
});

test('as the task account: no tools offered, and a call answers immediately without asking the server', async () => {
  const http = require('http');
  let asked = 0;
  const server = http.createServer((req, res) => {
    asked++;
    res.statusCode = 403;
    res.end('{"error":"forbidden"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, EDITLENS_PORT: String(server.address().port), EDITLENS_TASK_ACCOUNT: '1', EDITLENS_NO_START: '1' } });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_board', arguments: {} } }) + '\n');
  const started = Date.now();
  while (lines.length < 2 && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  server.close();
  assert.deepStrictEqual(lines[0].result, { tools: [] });
  assert.strictEqual(lines[1].result.isError, true);
  assert.match(lines[1].result.content[0].text, /not available here/);
  assert.strictEqual(asked, 0, 'nothing sent to the server');
});
