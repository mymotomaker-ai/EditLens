'use strict';
require('./isolate');
// The task tools' summary for Claude Code's chat (handoff 16.2): a plain layout-B block of at most
// three lines of 64 columns, sent first, then the data Claude got before, unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const s = require('../lib/tasksummary');

const cols = (l) => [...l].length;
// Every summary: 1 to 3 lines, each at most 64 columns, no ANSI or other control characters.
function checkBlock(text, label) {
  assert.strictEqual(typeof text, 'string', label);
  const lines = text.split('\n');
  assert.ok(lines.length >= 1 && lines.length <= 3, `${label}: ${lines.length} lines\n${text}`);
  for (const l of lines) {
    assert.ok(cols(l) <= 64, `${label}: ${cols(l)} columns: ${l}`);
    assert.ok(l.trim(), `${label}: an empty line`);
  }
  assert.ok(!/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text), `${label}: control characters`);
  assert.ok(!/\u001b\[/.test(text), `${label}: ANSI`);
  return lines;
}

const LONG = 'Write the four design essays for the handoff and check each one against the mockup before sending';

test('started: what happened and where, title ··· status, where the edits go', () => {
  const lines = checkBlock(s.started({ task: 'abc', computer: 'vps-123456', state: 'starting', prompt: 'Write the four design essays\nUse your agents.', workspace: { sentFrom: 'laptop', folder: '/x' } }, { slots: { running: 2, limit: 4 } }), 'started');
  assert.deepStrictEqual(lines, [
    '✦ Task started on ◆ vps-123456',
    'Write the four design essays ··· Starting · 2 of 4 running',
    'Edits go to ···················· a copy of this project',
  ]);
  // A long title is cut with "…" and the status still fits.
  const cut = checkBlock(s.started({ computer: 'vm', state: 'waiting', prompt: LONG, workspace: { name: 'editlens-task-1' }, note: 'Waiting · vm is running 1 task. It starts when it finishes.' }, { slots: { running: 1, limit: 1 } }), 'cut');
  assert.strictEqual(cut[0], '✦ Task waiting on ◆ vm');
  // D12 (the user's choice, option A): plain "Waiting" (shorter titles keep "1 of 1 running" beside it).
  assert.match(cut[1], /^Write the four design essays for the handoff and ch… ·+ Waiting$/, '"1 of 1 running" is left out first, then the title is cut');
  assert.strictEqual(cut[2], 'vm is running 1 task. It starts when it finishes.', 'why it waits, before where the edits go');
});

test('a task: counts only when known, line 3 only when needed', () => {
  const done = checkBlock(s.taskBlock({ computer: 'vm', state: 'idle', prompt: 'Tidy the FAQ', workspace: { sentFrom: 'x' }, filesEdited: ['a', 'b', 'c', 'd'] }, { files: { count: 4, added: 54, removed: 3 } }), 'done');
  assert.deepStrictEqual(done, ['✦ Task done on ◆ vm', 'Tidy the FAQ ··· Done · 4 files · +54 −3', 'Not in your files yet. Claude adds them next.']);
  const unknown = checkBlock(s.taskBlock({ computer: 'vm', state: 'idle', prompt: 'Tidy the FAQ', workspace: { name: 'w' }, filesEdited: ['a', 'b'] }), 'unknown counts');
  assert.deepStrictEqual(unknown, ['✦ Task done on ◆ vm', 'Tidy the FAQ ··· Done · 2 files', 'Not in its project yet. Claude merges them next.']);
  const nan = checkBlock(s.taskBlock({ computer: 'vm', state: 'idle', prompt: 'Tidy', workspace: { shared: true } }, { files: { count: 2, added: Number.NaN, removed: 1 } }), 'NaN');
  assert.deepStrictEqual(nan, ['✦ Task done on ◆ vm', 'Tidy ··· Done · 2 files'], 'no counts from NaN, no third line in its own project');
  const working = checkBlock(s.taskBlock({ computer: 'vm', state: 'working', prompt: 'Fix the header' }, { slots: { running: 2, limit: 4 } }), 'working');
  assert.deepStrictEqual(working, ['✦ Task working on ◆ vm', 'Fix the header ··· Working · 2 of 4 running']);
  const asks = checkBlock(s.taskBlock({ computer: 'vm', state: 'working', prompt: LONG, waitingForPermission: [{ tool: 'Bash' }] }), 'asks');
  assert.strictEqual(asks[0], '✦ Task needs your answer on ◆ vm');
  assert.match(asks[1], /… ·+ Needs your answer$/);
  assert.strictEqual(asks[2], 'Answer its question in the EditLens window on ◆ vm.');
  const failed = checkBlock(s.taskBlock({ computer: 'vm', state: 'failed', prompt: 'Fix', error: 'Claude Code stopped\u001b[31m with exit code 1\nand more' }), 'failed');
  assert.strictEqual(failed[2], 'Why: Claude Code stopped [31m with exit code 1 and more');
});

test('didn\'t start, follow-up, wait, list, apply, merge', () => {
  assert.deepStrictEqual(checkBlock(s.notStarted('Claude Code on vm is not signed in. Type claude there once and sign in.', { computer: 'vm', prompt: 'Update the README' }), 'not started'), [
    '✦ Task didn\'t start on ◆ vm',
    'Update the README ··· Didn\'t start',
    'Why: Claude Code on vm is not signed in. Type claude there once…',
  ]);
  assert.strictEqual(checkBlock(s.followUp({ computer: 'vm', state: 'working', prompt: 'Fix' }), 'follow-up')[0], '✦ Follow-up sent to ◆ vm');
  const one = checkBlock(s.waited([{ task: 'a', computer: 'vm', state: 'idle', prompt: 'Footer', kind: 'sent', files: { count: 3, added: 10, removed: 2 } }], [{ task: 'a', computer: 'vm', state: 'idle', prompt: 'Footer', kind: 'sent', files: { count: 3, added: 10, removed: 2 } }], { met: true }), 'waited one');
  assert.deepStrictEqual(one, ['✦ Task done on ◆ vm', 'Footer ··· Done · 3 files · +10 −2', 'Not in your files yet. Claude adds them next.']);
  const still = checkBlock(s.waited([{ task: 'a', computer: 'vm', state: 'waiting', prompt: 'Footer', note: 'Waiting · vm is running 1 task.' }], [], { met: false, slots: { running: 1, limit: 1 } }), 'still');
  assert.deepStrictEqual(still, ['✦ Still waiting on ◆ vm', 'Footer ··· Waiting · 1 of 1 running', 'vm is running 1 task.']);
  const many = checkBlock(s.waited([1, 2, 3].map((i) => ({ task: String(i), computer: 'vm', state: 'idle', prompt: `Task ${i}` })), null, { met: true }), 'many');
  assert.strictEqual(many[0], '✦ 3 tasks ready on ◆ vm');
  assert.match(many[2], /\(\+1 more\)$/);
  const listed = checkBlock(s.listed({ computer: 'vm', tasks: [{ task: 'a', state: 'idle', prompt: 'Tidy the FAQ' }, { task: 'b', state: 'working', prompt: 'Fix header' }] }), 'listed');
  assert.deepStrictEqual(listed, ['✦ 2 tasks on ◆ vm · 1 working', 'Fix header ····· Working', 'Tidy the FAQ ··· Done'], 'newest first, one column');
  assert.deepStrictEqual(checkBlock(s.listed({ computer: 'vm', tasks: [] }), 'none'), ['✦ No tasks on ◆ vm']);
  const applied = checkBlock(s.applied({ computer: 'vm', applied: ['a', 'b'], conflicts: [{ path: 'x.js', why: 'y' }] }, { prompt: 'Tidy' }), 'applied');
  assert.deepStrictEqual(applied, ['✦ Changes added to your files from ◆ vm', 'Tidy ··· 2 files added · 1 conflict', 'Changed here since it was sent: x.js']);
  assert.match(checkBlock(s.applied({ computer: 'vm', dryRun: true, wouldApply: ['a'] }), 'dry')[0], /nothing written/);
  assert.deepStrictEqual(checkBlock(s.merged({ applied: ['a'] }, { computer: 'vm', prompt: 'Fix' }), 'merged'), ['✦ Changes merged on ◆ vm', 'Fix ··· 1 file merged']);
});

test('odd input never breaks the 64 columns', () => {
  const weird = ['', null, 42, '\u001b[1mBold\u001b[0m', 'x'.repeat(500), '◆'.repeat(80), '[EditLens: sent]\nReal title'];
  for (const p of weird) {
    for (const st of ['waiting', 'starting', 'working', 'idle', 'stopped', 'failed', 'refused', 'odd', undefined]) {
      checkBlock(s.taskBlock({ computer: 'c'.repeat(90), state: st, prompt: p, error: p, note: p, waitingForPermission: st === 'working' ? [{}] : undefined }, { files: { count: 7, added: 1e9, removed: 2 }, slots: { running: 3, limit: 8 } }), `${st} ${String(p).slice(0, 10)}`);
    }
  }
  assert.strictEqual(s.titleOf('[EditLens: sent]\nReal title'), 'Real title');
});

// The MCP server against a stand-in live server: each task tool answers two text items, and the
// second is exactly the data it answered before.
test('the task tools send the summary first, then the same data as before', async (t) => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-tsum-'));
  t.after(() => fs.rmSync(project, { recursive: true, force: true }));
  const seen = [];
  const report = { task: 'aaaaaaaaaaaa', computer: 'vm', state: 'idle', prompt: 'Tidy the FAQ\nAnd the footer.', replyCount: 2, activityCount: 5, filesEdited: ['faq.md', 'footer.md'], workspace: { name: 'editlens-task-aaaa', folder: '/srv/w' }, lastReply: 'Done: Tidy the FAQ', stats: { turns: 2, seconds: 9 } };
  const listed = { computer: 'vm', tasks: [{ task: 'aaaaaaaaaaaa', state: 'idle', prompt: 'Tidy the FAQ' }, { task: 'bbbbbbbbbbbb', state: 'working', prompt: 'Fix the header' }] };
  const merged = { applied: ['faq.md'], conflicts: [] };
  const summary = { task: 'aaaaaaaaaaaa', computer: 'vm', state: 'idle', seq: 4, waiting: 0, replyCount: 2, activityCount: 5, editCount: 2, prompt: 'Tidy the FAQ', kind: 'copy', files: { count: 2, added: 7, removed: 1 } };
  const answers = {
    start: { ...report, state: 'starting', replyCount: 0, filesEdited: [] },
    check: report,
    send: { ...report, state: 'working' },
    stop: { ...report, state: 'stopped' },
    list: listed,
    merge: merged,
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : null;
      seen.push({ url: req.url, body: json });
      let out = {};
      if (req.url === '/remote/task') out = json.computer === 'down' ? { error: 'vm is not paired.' } : answers[json.op] || {};
      else if (req.url.startsWith('/remote/tasks')) out = { seq: 4, tasks: [summary], slots: { vm: { running: 1, limit: 4 } } };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const mcp = spawn(process.execPath, [path.join(__dirname, '..', 'mcp', 'live-page.js')], { stdio: ['pipe', 'pipe', 'pipe'], cwd: project,
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, EDITLENS_PORT: String(server.address().port), EDITLENS_STATE_DIR: path.join(project, 'state') } });
  t.after(() => mcp.kill());
  const replies = new Map();
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    const parts = buf.split('\n');
    buf = parts.pop();
    for (const l of parts.filter(Boolean)) {
      const m = JSON.parse(l);
      replies.set(m.id, m);
    }
  });
  let n = 0;
  const call = async (name, args) => {
    const id = ++n;
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    const until = Date.now() + 15000;
    while (!replies.has(id) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(replies.has(id), `${name} answered`);
    return replies.get(id).result;
  };
  // Two items: the summary, then the data. The data parses to every field the stand-in sent.
  const two = (r, label, data) => {
    assert.strictEqual(r.isError, false, label);
    assert.strictEqual(r.content.length, 2, `${label}: ${JSON.stringify(r.content)}`);
    assert.ok(r.content.every((c) => c.type === 'text'));
    const lines = checkBlock(r.content[0].text, label);
    assert.match(lines[0], /^✦ /, label);
    if (data !== undefined) assert.deepStrictEqual(JSON.parse(r.content[1].text), data, `${label}: the data is unchanged`);
    return lines;
  };

  const started = await call('start_task_on_computer', { computer: 'vm', prompt: 'Tidy the FAQ\nAnd the footer.', workspace: 'theirs' });
  const startData = { ...answers.start };
  delete startData.filesEdited; // an empty list was never sent (prune)
  assert.deepStrictEqual(two(started, 'start', startData), ['✦ Task started on ◆ vm', 'Tidy the FAQ ··· Starting · 1 of 4 running', 'Edits go to ···· a copy of its project']);

  assert.deepStrictEqual(two(await call('check_computer_task', { computer: 'vm', task: 'aaaaaaaaaaaa' }), 'check', report),
    ['✦ Task done on ◆ vm', 'Tidy the FAQ ··· Done · 2 files · +7 −1', 'Not in its project yet. Claude merges them next.']);
  assert.strictEqual(two(await call('message_computer_task', { computer: 'vm', task: 'aaaaaaaaaaaa', text: 'more' }), 'send', answers.send)[0], '✦ Follow-up sent to ◆ vm');
  assert.strictEqual(two(await call('stop_computer_task', { computer: 'vm', task: 'aaaaaaaaaaaa' }), 'stop', answers.stop)[0], '✦ Task stopped on ◆ vm');
  assert.strictEqual(two(await call('list_computer_tasks', { computer: 'vm' }), 'list', listed)[0], '✦ 2 tasks on ◆ vm · 1 working');
  assert.deepStrictEqual(two(await call('merge_computer_task', { computer: 'vm', task: 'aaaaaaaaaaaa' }), 'merge', { applied: ['faq.md'] }), ['✦ Changes merged on ◆ vm', 'Tidy the FAQ ··· 1 file merged']);
  const note = seen.find((x) => x.url === '/remote/task-applied');
  assert.ok(note, 'the page is told about the merge');
  assert.deepStrictEqual({ ...note.body, dir: undefined }, { dir: undefined, task: 'aaaaaaaaaaaa', computer: 'vm', how: 'merge', count: 1 });

  // wait_for_computer_tasks: the text it gave before, line for line, after the summary.
  const waited = await call('wait_for_computer_tasks', { computer: 'vm', tasks: ['aaaaaaaaaaaa'], until: 'turn_done', wait_seconds: 1 });
  two(waited, 'wait');
  assert.strictEqual(waited.content[1].text, 'Ready: aaaaaaaaaaaa (turn_done).\naaaaaaaaaaaa on vm: idle, 2 replies, 5 steps, 2 edits (Tidy the FAQ)');
  assert.strictEqual(waited.content[0].text, '✦ Task done on ◆ vm\nTidy the FAQ ··· Done · 2 files · +7 −1\nNot in its project yet. Claude merges them next.');

  // Errors stay one item, except a start that failed: the user sees it didn't start, and why.
  const down = await call('check_computer_task', { computer: 'down', task: 'aaaaaaaaaaaa' });
  assert.deepStrictEqual(down, { content: [{ type: 'text', text: 'vm is not paired.' }], isError: true });
  const failed = await call('start_task_on_computer', { computer: 'down', prompt: 'Update the README', workspace: 'theirs' });
  assert.strictEqual(failed.isError, true);
  assert.strictEqual(failed.content.length, 2);
  assert.deepStrictEqual(checkBlock(failed.content[0].text, 'failed start'), ['✦ Task didn\'t start on ◆ down', 'Update the README ··· Didn\'t start', 'Why: vm is not paired.']);
  assert.strictEqual(failed.content[1].text, 'vm is not paired.');
  const bad = await call('start_task_on_computer', { computer: 'vm', prompt: 'x', workspace: 'theirs', effort: 'huge' });
  assert.strictEqual(bad.content[1].text, 'effort must be one of: low, medium, high, xhigh, max.', 'a refused start: the same text after the summary');
  assert.match(bad.content[0].text, /^✦ Task didn't start on ◆ vm\n/);
  const unknown = await call('wait_for_computer_tasks', { computer: 'vm', tasks: ['000000000000'], wait_seconds: 1 });
  assert.strictEqual(unknown.content.length, 1, 'a wait for unknown ids: one item');
});

// The terminal's Details: a task that waits or didn't start names its title, as its card does,
// not its whole prompt.
test('Details: a task notice shows the title, not the whole prompt', async () => {
  const mod = await import('../hooks/mod.mjs');
  const m = mod.detailsModel({ taskNotices: [{ state: 'waiting', text: 'Waiting · vm is running 4 tasks.', prompt: 'Fix the header\nAnd keep the logo where it is.' }] }, { cols: 160 });
  const rows = m.rows.filter((r) => r.label === 'Tasks').map((r) => r.parts.map((p) => p.text).join(''));
  assert.deepStrictEqual(rows, ['! Waiting · vm is running 4 tasks. · Fix the header']);
});
