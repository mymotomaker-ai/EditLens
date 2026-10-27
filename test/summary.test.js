'use strict';
require('./isolate');
process.env.EDITLENS_PORT = '4932';
// GET /summary for the details inside Claude Code (hooks/mod.mjs): status, pages, subagents and
// tokens of one session; page control shows its own session. Never NaN.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { summarize, agentsOf } = require('../server/summary');

const rootMatches = (a, b) => {
  const r = path.relative(a, b);
  const s = path.relative(b, a);
  return !r.startsWith('..') || !s.startsWith('..');
};
const history = [
  { type: 'chat', sessionId: 's1', role: 'agent-start', toolUseId: 't1', description: 'About page', agentType: 'general-purpose', ts: 1 },
  { type: 'chat', sessionId: 's1', role: 'agent-step', toolUseId: 't1', agentId: 'a1', model: 'claude-haiku-5-5', msgId: 'm1', ctx: 1000, out: 50, kind: 'text' },
  { type: 'chat', sessionId: 's1', role: 'agent-step', toolUseId: 't1', agentId: 'a1', model: 'claude-haiku-5-5', msgId: 'm1', ctx: 1000, out: 50, kind: 'tool' },
  { type: 'chat', sessionId: 's1', role: 'agent-step', toolUseId: 't1', agentId: 'a1', msgId: 'm2', ctx: 1500, out: 'x', kind: 'tool' },
  { type: 'chat', sessionId: 's1', role: 'agent-start', toolUseId: 't2', description: 'Header', agentType: 'Explore', ts: 2 },
  { type: 'chat', sessionId: 's1', role: 'agent-done', toolUseId: 't2', agentId: 'a2', status: 'completed', tokens: 9000, toolCount: 4, ts: 3 },
  { type: 'chat', sessionId: 'other', role: 'agent-start', toolUseId: 't3', description: 'Elsewhere' },
  { type: 'change', sessionId: 's1' },
];

test('subagents: status, model, tokens counted once per reply', () => {
  const a = agentsOf(history, 's1');
  assert.deepStrictEqual(a.map((x) => [x.key, x.status, x.tokens, x.tokensFinal, x.toolCalls]), [['t1', 'working', 1550, false, 2], ['t2', 'done', 9000, true, 4]]);
  assert.strictEqual(a[0].model, 'claude-haiku-5-5');
  assert.strictEqual(agentsOf(history, 'other').length, 1);
});

test('Manual: this session\'s state, mode, pages and tokens', () => {
  const s = summarize({
    sessionId: 's1', cwd: '/app', version: '1', claudeState: { state: 'working', sessionId: 's1' }, driver: { active: false }, mode: 'plan',
    usage: { model: 'claude-opus-5-5', context: { used: 50000, window: 200000, percent: 25 }, totals: { input: 10, cacheRead: 1000, cacheCreate: 100, output: 90, subagentTokens: 9000 }, costUSD: 0.5 },
    pages: [{ url: 'http://127.0.0.1:5173/', title: 'Demo', root: '/app' }, { url: 'http://x/', root: '/elsewhere' }], history, rootMatches,
  });
  assert.strictEqual(s.control, 'manual');
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.mode, 'plan');
  assert.deepStrictEqual(s.pages, [{ url: 'http://127.0.0.1:5173/', title: 'Demo' }]);
  assert.strictEqual(s.agentsRunning, 1);
  assert.deepStrictEqual(s.tokens, { context: 50000, window: 200000, windowSource: null, percent: 25, main: 1200, subagents: 10550, costUSD: 0.5 });
});

test('Page control: the copy the panel runs, its mode and questions', () => {
  const s = summarize({
    sessionId: 's0', cwd: '/app', claudeState: { state: 'idle', sessionId: 's0' }, rootMatches, history, pages: [],
    driver: { active: true, cwd: '/app', sessionId: 's1', phase: 'ready', working: true, mode: 'acceptEdits', model: 'claude-opus-5-5', permissions: [{}] },
  });
  assert.strictEqual(s.control, 'page');
  assert.strictEqual(s.sessionId, 's1');
  assert.strictEqual(s.state, 'working');
  assert.strictEqual(s.mode, 'acceptEdits');
  assert.strictEqual(s.permissions, 1);
  assert.strictEqual(s.agentCount, 2);
});

test('nothing known: nulls, never NaN', () => {
  const s = summarize({ sessionId: null, cwd: null, rootMatches, history: [], pages: [], driver: { active: false }, usage: { context: { used: NaN }, totals: { input: 'x' } } });
  assert.ok(!/NaN/.test(JSON.stringify(s)));
  assert.deepStrictEqual(s.tokens, { context: null, window: null, windowSource: null, percent: null, main: null, subagents: null, costUSD: null });
  assert.strictEqual(s.state, 'unknown');
});

test('page control readiness: unknown, not set up, signed out, running', () => {
  const base = { sessionId: 's1', cwd: '/w', history: [], pages: [], rootMatches };
  assert.strictEqual(summarize(base).pageControl, null);
  assert.deepStrictEqual(summarize({ ...base, pageControl: { installed: false, signedIn: null } }).pageControl, { installed: false, signedIn: null });
  assert.deepStrictEqual(summarize({ ...base, pageControl: { installed: true, signedIn: false } }).pageControl, { installed: true, signedIn: false });
  assert.deepStrictEqual(summarize({ ...base, pageControl: { installed: true, signedIn: 'x' } }).pageControl, { installed: true, signedIn: null });
  const driver = { active: true, cwd: '/w', sessionId: 'd1', phase: 'signin', working: false, permissions: [] };
  assert.deepStrictEqual(summarize({ ...base, driver, pageControl: { installed: false, signedIn: null } }).pageControl, { installed: true, signedIn: false });
});

test('where the line above the prompt is drawn, as the mod reported it', () => {
  const base = { sessionId: 's1', cwd: '/w', history: [], pages: [], rootMatches };
  assert.strictEqual(summarize(base).display, null);
  assert.deepStrictEqual(summarize({ ...base, display: { surfaces: ['desktop'], drawn: [], at: 5 } }).display, { surfaces: ['desktop'], drawn: [], at: 5 });
});

test('the editlens-guide skill covers every /editlens command and remote-task tool', async () => {
  const fs = require('fs');
  const path = require('path');
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'editlens-guide', 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\nname: editlens-guide\ndescription: .+\n---\n/);
  const { GROUPS } = require('../lib/help');
  for (const [, items] of GROUPS) {
    for (const item of items) {
      const word = typeof item === 'string' ? item : (item[0].split(' ')[1] || '');
      if (word && !/^\d/.test(word)) assert.ok(skill.includes(`/editlens ${word}`), word);
    }
  }
  const mcp = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'live-page.js'), 'utf8');
  for (const name of mcp.match(/name: '([a-z_]+_computers?(_tasks?)?|[a-z]+_computer_task|start_task_on_computer)'/g) || []) {
    assert.ok(skill.includes(name.slice(7, -1)), name);
  }
});

test('a [1m] model gets the 1M window before Claude Code reports its own', () => {
  const base = { sessionId: 's1', cwd: '/app', version: '1', claudeState: null, mode: null, pages: [], history: [], rootMatches };
  const page = summarize({ ...base, driver: { active: true, cwd: '/app', sessionId: 'p1', model: 'claude-opus-5-5[1m]', phase: 'ready' },
    usage: { model: 'claude-opus-5-5', context: { used: 410000, window: null, windowSource: null, percent: null } } });
  assert.strictEqual(page.tokens.window, 1000000);
  assert.strictEqual(page.tokens.windowSource, 'model');
  assert.strictEqual(page.tokens.percent, 41);
  // Before any reply: the window is still known from the chosen model.
  const fresh = summarize({ ...base, driver: { active: true, cwd: '/app', sessionId: 'p1', model: 'claude-opus-5-5[1m]', phase: 'ready' }, usage: null });
  assert.deepStrictEqual([fresh.tokens.window, fresh.tokens.context, fresh.tokens.percent], [1000000, null, null]);
  // What Claude Code reported takes precedence.
  const reported = summarize({ ...base, driver: { active: false }, usage: { model: 'claude-opus-5-5[1m]', context: { used: 1000, window: 200000, windowSource: 'claude-code', percent: 0.5 } } });
  assert.deepStrictEqual([reported.tokens.window, reported.tokens.percent], [200000, 0.5]);
});
