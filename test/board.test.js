'use strict';
require('./isolate');
// The team board: identity from the hook, claims and clashes, findings, released claims when a
// subagent finishes, and the board kept after a restart.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Boards, callKey, stable } = require('../server/board');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-board-'));
const project = path.join(dir, 'proj');
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

function call(boards, tool, args, who) {
  const key = callKey(`mcp__plugin_editlens_live-page__${tool}`, args);
  if (who) boards.expect(key, { ...who, projectDir: project });
  return boards.act(tool, args, boards.identify(callKey(tool, args)), project);
}

test('the call key ignores key order and the tool prefix', () => {
  assert.strictEqual(stable({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  assert.strictEqual(callKey('mcp__plugin_x_live-page__post_note', { text: 'a', kind: 'note' }), callKey('post_note', { kind: 'note', text: 'a' }));
  assert.notStrictEqual(callKey('post_note', { text: 'a' }), callKey('post_note', { text: 'b' }));
});

test('entries include the agent the hook reported; unmatched calls are unknown', () => {
  const entries = [];
  const boards = new Boards({ dir: path.join(dir, 'b1'), onEntry: (b, e) => entries.push(e) });
  call(boards, 'post_note', { text: 'Main here' }, { agentId: null, agentType: null });
  call(boards, 'post_note', { text: 'Explorer here', kind: 'decision' }, { agentId: 'a42d292ab056160a0', agentType: 'Explore' });
  call(boards, 'post_note', { text: 'Who am I' }, null);
  assert.deepStrictEqual(entries.map((e) => e.author), ['Main', 'Explore 60a0', 'Unknown agent']);
  assert.strictEqual(entries[1].kind, 'decision');
  const read = call(boards, 'read_board', {}, { agentId: 'a42d292ab056160a0', agentType: 'Explore' });
  assert.match(read.text, /You are Explore 60a0/);
  assert.match(read.text, /#2 Explore 60a0 decision: Explorer here \(you\)/);
  assert.match(call(boards, 'read_board', { since: 2 }, null).text, /#3 Unknown agent note: Who am I/);
  assert.match(call(boards, 'read_board', { since: 3 }, null).text, /Nothing new since #3/);
});

test('claims clash on the same files, can be forced, and close once', () => {
  const boards = new Boards({ dir: path.join(dir, 'b2') });
  const a = { agentId: 'aaaa1111', agentType: 'general-purpose' };
  const b = { agentId: 'bbbb2222', agentType: 'general-purpose' };
  assert.match(call(boards, 'claim_task', { task: 'Header styles', files: ['src/Header.css', './src/Nav.jsx'] }, a).text, /Claimed as #1/);
  const clash = call(boards, 'claim_task', { task: 'Nav links', files: ['src\\Nav.jsx'] }, b);
  assert.match(clash.text, /Not claimed: general-purpose 1111 already claimed #1/);
  assert.match(call(boards, 'claim_task', { task: 'Nav links', files: ['src/Nav.jsx'], force: true }, b).text, /Claimed as #2/);
  assert.match(call(boards, 'complete_task', { id: 1, result: 'Bolder header' }, a).text, /Marked #1 done/);
  assert.match(call(boards, 'complete_task', { id: 1 }, a).text, /already closed/);
  assert.strictEqual(call(boards, 'complete_task', { id: 'x' }, a).isError, true);
  assert.deepStrictEqual(boards.board(project).openClaims().map((c) => c.id), [2]);
});

test('findings keep a clean relative path and whole line numbers (no NaN)', () => {
  const boards = new Boards({ dir: path.join(dir, 'b3') });
  const who = { agentId: 'cccc3333', agentType: 'Explore' };
  call(boards, 'share_finding', { file: path.join(project, 'src', 'App.jsx'), line: '4', end_line: 2, note: 'Page state' }, who);
  call(boards, 'share_finding', { file: 'src/api.js', line: 'abc', note: 'Fetch helper' }, who);
  const [f1, f2] = boards.board(project).entries;
  assert.deepStrictEqual([f1.file, f1.line, f1.endLine], ['src/App.jsx', 4, 4]);
  assert.deepStrictEqual([f2.line, f2.endLine], [null, null]);
  assert.strictEqual(call(boards, 'share_finding', { file: 'x.js' }, who).isError, true);
});

test('a finishing subagent releases its claims; the board survives a restart; clear empties it', () => {
  const where = path.join(dir, 'b4');
  const boards = new Boards({ dir: where });
  const who = { agentId: 'dddd4444', agentType: 'general-purpose' };
  boards.lifecycle(project, who, 'join');
  call(boards, 'claim_task', { task: 'Footer' }, who);
  boards.lifecycle(project, who, 'leave', 'Finished the footer.');
  const b = boards.board(project);
  assert.deepStrictEqual(b.entries.map((e) => e.kind), ['join', 'claim', 'leave', 'done']);
  assert.strictEqual(b.entries[3].status, 'released');
  assert.strictEqual(b.openClaims().length, 0);

  const again = new Boards({ dir: where });
  again.loadRecent();
  assert.strictEqual(again.all().length, 1);
  assert.strictEqual(again.board(project).entries.length, 4);
  assert.match(call(again, 'post_note', { text: 'after restart' }, who).text, /Posted #5/);
  again.clear(project);
  assert.strictEqual(new Boards({ dir: where }).board(project).entries.length, 0);
});

test('a subagent is named by its task description, also after a restart', () => {
  const where = path.join(dir, 'b5');
  const boards = new Boards({ dir: where });
  const who = { agentId: 'eeee5555', agentType: 'general-purpose' };
  boards.lifecycle(project, { ...who, name: 'Frontend: bold prices' }, 'join');
  call(boards, 'post_note', { text: 'hi' }, who);
  boards.lifecycle(project, who, 'leave', 'done');
  assert.deepStrictEqual(boards.board(project).entries.map((e) => e.author), Array(3).fill('Frontend: bold prices'));
  const again = new Boards({ dir: where });
  assert.match(call(again, 'post_note', { text: 'again' }, who).text, /as Frontend: bold prices/);
});
