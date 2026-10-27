'use strict';
require('./isolate');
// Every live-page tool says what it does to the user's files and computers (MCP tool annotations),
// as the plugin directory asks. Tools that only read say so; tools that write files say they can.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');

const READS = /^(read_board|list_|get_|check_|search_|wait_for_)/;
const WRITES_FILES = ['merge_computer_task', 'undo_computer_task_merge', 'apply_computer_task', 'undo_computer_task_apply', 'copy_from_computer', 'stop_computer_task'];

test('each tool has a title and read-only, destructive, idempotent and open-world hints', async () => {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, EDITLENS_PORT: '5381' } });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    lines.push(...parts.filter(Boolean).map((l) => JSON.parse(l)));
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const started = Date.now();
  while (!lines.length && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 50));
  child.kill();
  const tools = lines[0].result.tools;
  assert.strictEqual(tools.length, 26);
  for (const t of tools) {
    const a = t.annotations;
    assert.ok(a, `${t.name} has annotations`);
    assert.ok(typeof a.title === 'string' && a.title.length > 3 && a.title.length < 40, `${t.name} title`);
    for (const k of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      assert.strictEqual(typeof a[k], 'boolean', `${t.name} ${k}`);
    }
    assert.strictEqual(a.readOnlyHint, READS.test(t.name), `${t.name} readOnlyHint`);
    assert.strictEqual(a.destructiveHint, WRITES_FILES.includes(t.name), `${t.name} destructiveHint`);
    if (a.readOnlyHint) assert.strictEqual(a.idempotentHint, true, `${t.name} reads, so it is idempotent`);
  }
  assert.strictEqual(new Set(tools.map((t) => t.annotations.title)).size, tools.length, 'titles differ');
});
