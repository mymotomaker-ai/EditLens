'use strict';
require('./isolate');
// The line above the prompt: always one row, fitted to the width by priority, narrow glyphs only.
const test = require('node:test');
const assert = require('node:assert');

const S = {
  control: 'page', state: 'working', mode: 'auto', pages: [{ url: 'http://127.0.0.1:4678/' }],
  paired: { joined: [{ name: 'vps-123456', state: 'connected' }] },
  agentsRunning: 1, agents: [{ status: 'working', name: 'a' }],
  tokens: { percent: 20, context: 40000, window: 200000, main: 40000, subagents: 0 }, permissions: 0, integrations: [],
};

let mod;
test.before(async () => { mod = await import('../hooks/mod.mjs'); });

// The row as text, as the terminal draws it: ✦, then the parts with their gaps.
function line(items) {
  return '✦ ' + items.map((it, i) => (i ? (it.button && items[i - 1].button ? '  ' : '   ') : '') + (it.button ? it.button.label : it.parts.map((p) => p.text).join(''))).join('');
}
const ids = (items) => items.map((it) => it.id);

test('wide: everything, in order, within the width', () => {
  const items = mod.bandItems({ s: S, cols: 140 });
  const text = line(items);
  assert.strictEqual(text, '✦ ● Page control · Auto   ◆ vps-123456   Working   1 agent   context ━━──────── 20%   40k tokens   Open  Manual  Details');
  assert.ok(mod.cells(text) <= 140);
});

test('96 and 58 columns: least important parts are removed first, never wraps', () => {
  for (const cols of [96, 80, 58, 40, 30]) {
    const items = mod.bandItems({ s: S, cols });
    const text = line(items);
    assert.ok(mod.cells(text) <= cols || ids(items).length <= 3, cols + ': ' + text);
    assert.ok(ids(items).includes('mode') && ids(items).includes('more'), cols + ': ' + text);
  }
  assert.strictEqual(line(mod.bandItems({ s: S, cols: 96 })), '✦ ● Page control · Auto   ◆ vps-123456   Working   20%   Open  Manual  Details');
  assert.strictEqual(line(mod.bandItems({ s: S, cols: 58 })), '✦ ● Page control   Working   20%   Open  Manual  Details');
  assert.strictEqual(line(mod.bandItems({ s: S, cols: 40 })), '✦ ● Page control   Open  Manual  Details');
});

test('states: needs you, Manual idle, no page, starting, not running, busy, context almost full', () => {
  assert.strictEqual(line(mod.bandItems({ s: { ...S, permissions: 1, paired: null, agentsRunning: 0, tokens: {} }, cols: 96 })), '✦  ! 1 question  waiting on your page   ● Page control · Auto   Working   Open  Manual  Details');
  assert.strictEqual(line(mod.bandItems({ s: { ...S, permissions: 1 }, cols: 58 })).startsWith('✦  ! 1 question  on your page'), true);
  const manual = { ...S, control: 'manual', state: 'idle', paired: null, agentsRunning: 0, tokens: { percent: 41 } };
  assert.strictEqual(line(mod.bandItems({ s: manual, cols: 96 })), '✦ ○ Manual   Idle   context ━━━━────── 41%   Open  Page control  Details');
  assert.strictEqual(line(mod.bandItems({ s: { ...manual, pages: [], connectHint: 'http://localhost:5173' }, cols: 96 })), '✦ No page connected   Connect localhost:5173  Details');
  assert.strictEqual(line(mod.bandItems({ off: true, booting: 'starting', cols: 96 })), '✦ Starting…');
  assert.strictEqual(line(mod.bandItems({ off: true, booting: 'port 4317 in use', cols: 96 })), '✦ ✕ Not running · port 4317 in use   Start  Details');
  assert.strictEqual(line(mod.bandItems({ off: true, booting: 'x'.repeat(200), cols: 58 })), '✦ ✕ Not running   Start  Details');
  // What is downloaded: the package, who makes it and where from; shorter when the row is narrower.
  assert.strictEqual(line(mod.bandItems({ s: S, busy: 'control', cols: 160 })), '✦ Starting page control… · the first time downloads @anthropic-ai/claude-agent-sdk (made by Anthropic) from registry.npmjs.org, about 30 MB');
  assert.strictEqual(line(mod.bandItems({ s: S, busy: 'control', cols: 96 })), '✦ Starting page control… · the first time downloads @anthropic-ai/claude-agent-sdk, about 30 MB');
  assert.strictEqual(line(mod.bandItems({ s: S, busy: 'control', cols: 40 })), '✦ Starting page control…');
  const hot = mod.bandItems({ s: { ...S, paired: null, agentsRunning: 0, tokens: { percent: 88 } }, cols: 96 });
  assert.strictEqual(line(hot), '✦ ● Page control · Auto   Working   context ━━━━━━━━━─ 88% · /compact   Open  Manual  Details');
  assert.strictEqual(hot.find((it) => it.id === 'ctx').parts[1].color, 'error');
});

test('only narrow glyphs, no NaN, sign-in and stopped page control show', () => {
  const all = [
    mod.bandItems({ s: S, cols: 200 }),
    mod.bandItems({ s: { ...S, tokens: { percent: NaN, main: NaN }, agentsRunning: NaN, permissions: NaN }, cols: 200 }),
    mod.bandItems({ s: { ...S, control: 'manual', pageControl: { installed: true, signedIn: false }, integrations: [{ rel: 'vite.config.js' }] }, cols: 200 }),
    mod.bandItems({ s: { ...S, pageControlError: 'it crashed' }, cols: 200 }),
  ];
  for (const items of all) {
    const text = line(items);
    assert.doesNotMatch(text, /[⚡⚠▰▱◐↳]|NaN|undefined/, text);
  }
  assert.match(line(all[2]), /! Page control needs sign-in/);
  assert.match(line(all[2]), /! in vite\.config\.js/);
  assert.match(line(all[3]), /✕ Page control stopped/);
  assert.deepStrictEqual(mod.meter(NaN), ['', '──────────']);
  assert.deepStrictEqual(mod.meter(250), ['━━━━━━━━━━', '']);
});

test('the runner skill is told apart from the mod\'s own /editlens', () => {
  const fs = require('fs');
  const path = require('path');
  const skill = fs.readFileSync(path.join(__dirname, '..', 'skills', 'editlens', 'SKILL.md'), 'utf8');
  const description = /\ndescription: (.*)\n/.exec(skill)[1];
  assert.ok(mod.isRunnerSkill({ command: 'editlens:editlens', description }));
  assert.ok(mod.isRunnerSkill({ command: 'editlens', description }));
  assert.ok(!mod.isRunnerSkill({ command: 'editlens', description: 'EditLens: connect your page, stop, control, manual, settings, status' }));
  assert.ok(!mod.isRunnerSkill({ command: 'editlens-guide', description }));
});
