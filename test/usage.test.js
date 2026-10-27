'use strict';
require('./isolate');
// Token usage from a transcript: context fill, totals counted once per response, window size
// only from real evidence, and Claude Code's status line numbers taking precedence.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { UsageTracker, scanFile, num, resetSharedLimits } = require('../server/usage');

function assistant(id, usage, content, extra) {
  return { type: 'assistant', timestamp: '2026-10-07T10:00:00.000Z', message: { id, model: 'claude-opus-5-5', usage, content: content || [] }, ...extra };
}

const U1 = { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500, output_tokens: 40 };
const U1_FINAL = { ...U1, output_tokens: 90 };
const U2 = { input_tokens: 5, cache_read_input_tokens: 1500, cache_creation_input_tokens: 200, output_tokens: 30 };

test('num rejects NaN, infinities, negatives and junk', () => {
  for (const bad of [NaN, Infinity, -1, 'abc', null, undefined, {}, '']) assert.strictEqual(num(bad), null);
  assert.strictEqual(num('12'), 12);
  assert.strictEqual(num(0), 0);
});

test('a response written over several lines counts once, with its final numbers', () => {
  const t = new UsageTracker();
  t.ingest({ type: 'user', timestamp: '2026-10-07T09:59:00.000Z', message: { content: 'Make the header sticky' } });
  t.ingest(assistant('m1', U1, [{ type: 'text', text: 'Sure.' }]));
  t.ingest(assistant('m1', U1_FINAL, [{ type: 'tool_use', name: 'Edit', id: 't1' }]));
  t.ingest({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } });
  t.ingest(assistant('m2', U2, [{ type: 'tool_use', name: 'Agent', id: 't2' }]));
  const s = t.snapshot();
  assert.deepStrictEqual(s.totals, { input: 15, cacheRead: 2500, cacheCreate: 700, output: 120, responses: 2, subagentTokens: 0 });
  assert.strictEqual(s.context.used, 5 + 1500 + 200, 'context is the latest response, input only');
  assert.strictEqual(s.turns, 1, 'tool results are not turns');
  assert.strictEqual(s.toolCalls, 2);
  assert.strictEqual(s.subagents, 1);
  assert.strictEqual(s.context.window, null, 'no window is made up (no 200k guess)');
  assert.strictEqual(s.context.windowSource, null);
  assert.strictEqual(s.context.percent, null);
  assert.strictEqual(s.costUSD, null, 'no cost is made up');
  assert.strictEqual(s.limits, null, 'no limits are made up');
});

test('window size comes from evidence: the model record, then observed use', () => {
  const a = new UsageTracker();
  a.ingest(assistant('m1', U1));
  a.ingest({ type: 'cost-state', totalCostUSD: 1.5, totalDuration: 60000, modelUsage: { 'claude-opus-5-5[1m]': {}, 'claude-haiku-4-5': {} } });
  assert.strictEqual(a.snapshot().context.window, 1000000);
  assert.strictEqual(a.snapshot().context.windowSource, 'model');
  assert.strictEqual(a.snapshot().costUSD, 1.5);
  assert.strictEqual(a.snapshot().costSource, 'transcript');

  const b = new UsageTracker();
  b.ingest(assistant('m1', { input_tokens: 2, cache_read_input_tokens: 250000, cache_creation_input_tokens: 0, output_tokens: 1 }));
  assert.strictEqual(b.snapshot().context.window, 1000000);
  assert.strictEqual(b.snapshot().context.windowSource, 'observed');
  assert.strictEqual(b.snapshot().context.percent, 25.0002);
});

test('a 1M window is known from the first reply: the model as chosen in Claude Code', () => {
  const a = new UsageTracker();
  a.ingest({ type: 'attachment', attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } } });
  a.ingest(assistant('m1', U1));
  let s = a.snapshot();
  assert.strictEqual(s.context.window, 1000000);
  assert.strictEqual(s.context.windowSource, 'model');
  assert.strictEqual(s.model, 'claude-opus-5-5[1m]');
  assert.ok(Number.isFinite(s.context.percent));
  // Switched to a model without [1m]: its window is not known (no 200k guess).
  a.ingest(assistant('m2', U2, null, { requestedModel: 'claude-sonnet-5-5' }));
  s = a.snapshot();
  assert.strictEqual(s.context.window, null);
  assert.strictEqual(s.context.windowSource, null);
  // A subagent's model never changes the main window.
  a.ingest(assistant('m3', U2, null, { requestedModel: 'claude-haiku-5-5[1m]', isSidechain: true }));
  assert.strictEqual(a.snapshot().context.window, null);
});

test('the auto-compact window (/autocompact) is the window: the lower of it and the model\'s', () => {
  const a = new UsageTracker();
  const asked = [];
  a.compactLimit = (model) => {
    asked.push(model);
    return 400000;
  };
  a.ingest(assistant('m1', U1));
  let s = a.snapshot();
  assert.deepStrictEqual([s.context.window, s.context.windowSource], [400000, 'autocompact']);
  assert.ok(s.context.used > 0);
  assert.strictEqual(s.context.percent, (s.context.used / 400000) * 100);
  assert.ok(asked.length && asked.every((m) => typeof m === 'string' && m), 'asked with the model');
  // Claude Code's own percentage is against the model's window: not used here.
  a.merge({ context_window: { context_window_size: 1000000, used_percentage: 0.2, total_input_tokens: 2000 } });
  s = a.snapshot();
  assert.deepStrictEqual([s.context.window, s.context.windowSource, s.context.percent], [400000, 'autocompact', 0.5]);
  // A model window smaller than the setting: the model's (Claude Code compacts there).
  a.merge({ context_window: { context_window_size: 200000, total_input_tokens: 2000 } });
  assert.strictEqual(a.snapshot().context.window, 200000);
  // No setting: Claude Code's number.
  a.compactLimit = () => null;
  assert.deepStrictEqual([a.snapshot().context.window, a.snapshot().context.windowSource], [200000, 'claude-code']);
});

test('compaction clears the context until the next response; NaN usage becomes 0', () => {
  const t = new UsageTracker();
  t.ingest(assistant('m1', U1));
  t.ingest({ type: 'system', subtype: 'compact_boundary' });
  assert.strictEqual(t.snapshot().context.used, null);
  assert.strictEqual(t.snapshot().context.percent, null);
  t.ingest(assistant('m2', { input_tokens: 'x', cache_read_input_tokens: NaN, cache_creation_input_tokens: 50, output_tokens: -3 }));
  const s = t.snapshot();
  assert.strictEqual(s.context.used, 50);
  assert.strictEqual(s.compactions, 1);
  assert.ok(Object.values(s.totals).every(Number.isFinite));
});

test("Claude Code's status line numbers win; expired limits are removed", () => {
  const t = new UsageTracker();
  t.ingest(assistant('m1', U1));
  const future = Math.floor(Date.now() / 1000) + 3600;
  t.merge({
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    context_window: { context_window_size: 1000000, used_percentage: 12.5 },
    cost: { total_cost_usd: 2.25, total_duration_ms: 90000 },
    rate_limits: { five_hour: { used_percentage: 41, resets_at: future }, seven_day: { used_percentage: 9, resets_at: 1000 }, spend_limit: { used_percentage: 'NaN' } },
  });
  const s = t.snapshot();
  assert.strictEqual(s.context.window, 1000000);
  assert.strictEqual(s.context.windowSource, 'claude-code');
  assert.strictEqual(s.context.percent, 12.5);
  assert.strictEqual(s.costUSD, 2.25);
  assert.strictEqual(s.costSource, 'claude-code');
  assert.strictEqual(s.durationMs, 90000);
  assert.strictEqual(s.modelName, 'Opus 5.5');
  assert.deepStrictEqual(Object.keys(s.limits), ['five_hour']);
  assert.strictEqual(s.limits.five_hour.resetsAt, future * 1000);
});

test('plan limits from one session\'s status line show for every session (they are the account\'s)', () => {
  resetSharedLimits();
  const sdk = new UsageTracker(); // page control: no status line
  sdk.ingest(assistant('x1', U1));
  assert.strictEqual(sdk.snapshot().limits, null);
  const term = new UsageTracker();
  const now = Math.floor(Date.now() / 1000);
  term.merge({ rate_limits: { five_hour: { used_percentage: 41, resets_at: now + 3600 }, seven_day: { used_percentage: NaN, resets_at: now + 86400 } } });
  const s = sdk.snapshot();
  assert.strictEqual(s.limits.five_hour.percent, 41);
  assert.strictEqual(s.limits.seven_day, undefined, 'NaN is removed');
  assert.strictEqual(s.limitsFrom, 'other-session');
  assert.strictEqual(term.snapshot().limitsFrom, 'this-session');
  resetSharedLimits();
});

test('scanFile reads a whole transcript, skipping broken lines', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-usage-'));
  test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 't.jsonl');
  fs.writeFileSync(file, [JSON.stringify(assistant('m1', U1)), '{not json', JSON.stringify(assistant('m2', U2)), ''].join('\n'));
  const t = new UsageTracker();
  await scanFile(file, fs.statSync(file).size, t);
  assert.strictEqual(t.snapshot().totals.responses, 2);
  await scanFile(path.join(dir, 'missing.jsonl'), 100, new UsageTracker());
  fs.rmSync(dir, { recursive: true, force: true });
});

// Sol M3: after a compaction, the status line's count from before it is not shown as the context.
test('compaction: the status line count from before it is not used until the next report', () => {
  const t = new UsageTracker();
  t.merge({ context_window: { context_window_size: 200000, used_percentage: 90, total_input_tokens: 180000 } });
  assert.strictEqual(t.snapshot().context.used, 180000);
  t.status.at = Date.now() - 2000;
  t.ingest({ type: 'system', subtype: 'compact_boundary', timestamp: new Date(Date.now() - 1000).toISOString() });
  assert.deepStrictEqual([t.snapshot().context.used, t.snapshot().context.percent], [null, null]);
  assert.strictEqual(t.snapshot().context.window, 200000, 'the window size still comes from the status line');
  // A response after the compaction: its own count.
  t.ingest(assistant('m9', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000, output_tokens: 5 }));
  assert.strictEqual(t.snapshot().context.used, 20010);
  // A status report after the compaction counts again.
  t.merge({ context_window: { context_window_size: 200000, used_percentage: 11, total_input_tokens: 22000 } });
  assert.deepStrictEqual([t.snapshot().context.used, t.snapshot().context.percent], [22000, 11]);
  // A compaction read from an old transcript (before the report) changes nothing.
  t.ingest({ type: 'system', subtype: 'compact_boundary', timestamp: '2020-01-01T00:00:00Z' });
  assert.strictEqual(t.snapshot().context.used, 22000);
});

test('Sol L1: a line written twice counts its tool calls once', () => {
  const t = new UsageTracker();
  const line = assistant('m1', U1, [{ type: 'tool_use', name: 'Edit', id: 't1' }, { type: 'tool_use', name: 'Agent', id: 't2' }]);
  t.ingest(line);
  t.ingest(line);
  t.ingest(assistant('m2', U2, [{ type: 'tool_use', name: 'Read' }])); // no id: counted as before
  const s = t.snapshot();
  assert.strictEqual(s.toolCalls, 3);
  assert.strictEqual(s.subagents, 1);
});

// Sol 0.24.43 L2: a model change in the transcript after the latest status report clears its model
// and window.
test('Sol L2: a later model change in the transcript replaces the status line model and window', () => {
  const t = new UsageTracker();
  t.ingest({ type: 'attachment', timestamp: new Date(Date.now() - 5000).toISOString(), attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } } });
  t.merge({
    model: { id: 'claude-opus-5-5[1m]', display_name: 'Opus 5.5 (1M context)' },
    context_window: { context_window_size: 1000000, used_percentage: 30, total_input_tokens: 300000 },
  });
  t.status.at = Date.now() - 2000;
  assert.strictEqual(t.snapshot().context.window, 1000000);
  // The same model again: the report still counts.
  t.ingest({ type: 'attachment', timestamp: new Date(Date.now() - 1500).toISOString(), attachment: { type: 'model', identity: { modelId: 'claude-opus-5-5[1m]' } } });
  assert.strictEqual(t.snapshot().model, 'claude-opus-5-5[1m]');
  assert.strictEqual(t.snapshot().context.window, 1000000);
  t.ingest({ type: 'attachment', timestamp: new Date(Date.now() - 1000).toISOString(), attachment: { type: 'model', identity: { modelId: 'claude-sonnet-5' } } });
  let s = t.snapshot();
  assert.strictEqual(s.model, 'claude-sonnet-5');
  assert.strictEqual(s.modelName, null);
  assert.strictEqual(s.context.window, null, 'no 1M window from the old model');
  assert.strictEqual(s.context.percent, null);
  // The next status report counts again.
  t.merge({ model: { id: 'claude-sonnet-5', display_name: 'Sonnet 5' }, context_window: { context_window_size: 200000, used_percentage: 5, total_input_tokens: 10000 } });
  s = t.snapshot();
  assert.deepStrictEqual([s.model, s.modelName, s.context.window, s.context.percent], ['claude-sonnet-5', 'Sonnet 5', 200000, 5]);
  // A model line read from an old transcript (before the report) changes nothing.
  t.ingest({ type: 'attachment', timestamp: '2020-01-01T00:00:00Z', attachment: { type: 'model', identity: { modelId: 'claude-haiku-5' } } });
  assert.strictEqual(t.snapshot().modelName, 'Sonnet 5');
});

// Sol 0.24.43 L3: plan limits come from the newest report, this session's or another's.
test('Sol L3: a newer account-wide limits report takes precedence over an older one from this session', () => {
  resetSharedLimits();
  const now = Math.floor(Date.now() / 1000);
  const old = new UsageTracker();
  old.merge({ rate_limits: { five_hour: { used_percentage: 10, resets_at: now + 3600 } } });
  old.status.at = Date.now() - 60000;
  const other = new UsageTracker();
  other.merge({ rate_limits: { five_hour: { used_percentage: 70, resets_at: now + 3600 } } });
  let s = old.snapshot();
  assert.strictEqual(s.limits.five_hour.percent, 70);
  assert.strictEqual(s.limitsFrom, 'other-session');
  assert.strictEqual(other.snapshot().limitsFrom, 'this-session');
  // This session reports again: its own report is now the newest.
  old.merge({ rate_limits: { five_hour: { used_percentage: 72, resets_at: now + 3600 } } });
  s = old.snapshot();
  assert.deepStrictEqual([s.limits.five_hour.percent, s.limitsFrom], [72, 'this-session']);
  resetSharedLimits();
});
