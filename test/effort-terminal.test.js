'use strict';
require('./isolate');
// Effort in the terminal (handoff 11.2): the word on the line above the prompt, the Details row,
// the Settings rows, help, and /editlens effort [level] against a stand-in server (port 4338).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const PORT = 4338;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'editlens-effort-term-'));
const stateDir = path.join(base, 'state');
fs.mkdirSync(stateDir);
fs.writeFileSync(path.join(stateDir, `token-${PORT}`), 'tok');

let mod;
test.before(async () => { mod = await import('../hooks/mod.mjs'); });
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

const S = {
  control: 'page', state: 'idle', mode: 'auto', pages: [{ url: 'http://127.0.0.1:4678/' }], agents: [], permissions: 0, integrations: [],
  tokens: { percent: 20, context: 40000, window: 200000, main: 40000, subagents: 0 },
  effort: { level: 'xhigh', used: 'xhigh', supported: true, cap: null, source: 'page' },
  effortHere: { level: 'high', used: 'high', supported: true, cap: null, source: 'terminal' },
};
const words = (items) => items.filter((it) => it.parts).map((it) => it.parts.map((p) => p.text).join(''));

test('the line above the prompt: the level as one dim word after the state', () => {
  const items = mod.bandItems({ s: S, cols: 140 });
  const ids = items.map((it) => it.id);
  assert.strictEqual(ids[ids.indexOf('state') + 1], 'effort');
  const word = items.find((it) => it.id === 'effort');
  assert.deepStrictEqual(word.parts, [{ text: 'Extra high', dim: true }]);
  // The level used, after a cap; "Effort not used" for a model without effort; nothing when unknown.
  assert.ok(words(mod.bandItems({ s: { ...S, effort: { ...S.effort, level: 'max', used: 'high', cap: 'high' } }, cols: 140 })).includes('High'));
  assert.ok(words(mod.bandItems({ s: { ...S, effort: { ...S.effort, used: null, supported: false } }, cols: 140 })).includes('Effort not used'));
  assert.ok(!mod.bandItems({ s: { ...S, effort: null }, cols: 140 }).some((it) => it.id === 'effort'));
  assert.ok(!mod.bandItems({ s: { ...S, effort: { level: 'turbo' } }, cols: 140 }).some((it) => it.id === 'effort'));
  // Manual: the terminal's own level.
  assert.ok(words(mod.bandItems({ s: { ...S, control: 'manual', effort: S.effortHere }, cols: 140 })).includes('High'));
  // It is left out before Claude's state when the row is narrow.
  const narrow = mod.bandItems({ s: S, cols: 60 }).map((it) => it.id);
  assert.ok(!narrow.includes('effort') || narrow.includes('state'), narrow.join());
  for (const cols of [140, 80, 60, 40]) assert.ok(mod.cells(words(mod.bandItems({ s: S, cols })).join('   ')) <= cols);
});

test('Details: "Effort  Extra high · this terminal High  Change"; in Manual, set in Claude Code', () => {
  const text = mod.detailsText(S);
  assert.match(text, /^ {2}Effort {6}Extra high · this terminal High {2}Change$/m);
  const row = mod.detailsModel(S).rows.find((r) => r.key === 'effort');
  assert.deepStrictEqual(row.button, { key: 'effort', label: 'Change', word: 'effort' });
  const manual = mod.detailsModel({ ...S, control: 'manual', effort: S.effortHere }).rows.find((r) => r.key === 'effort');
  assert.strictEqual(manual.parts.map((p) => p.text).join(''), 'High · set in Claude Code');
  assert.deepStrictEqual(manual.button, { key: 'effort', label: 'Change', prompt: '/effort' }, 'Manual: Claude Code\'s own /effort');
  assert.ok(!mod.detailsModel({ ...S, effort: null }).rows.some((r) => r.key === 'effort'));
});

test('Settings: Effort in the Page control group; Effort here in the Claude Code group', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
  const field = manifest.userConfig.effort;
  assert.deepStrictEqual([field.title, field.options, field.default], ['Effort', ['Auto', 'Low', 'Medium', 'High', 'Extra high'], 'Auto']);
  assert.match(field.description, /^Claude's effort level for page messages and tasks it starts\. Auto: the level Claude Code uses by itself/);
  const sec = mod.settingSections(manifest.userConfig).find((s) => s.title === 'Page control');
  assert.ok(sec.rows.some((r) => r.key === 'effort' && r.label === 'Effort'));
  assert.deepStrictEqual(mod.HERE_ROW, { key: 'effort_here', label: 'Effort here', group: 'Claude Code', about: 'This terminal\'s own level. Opens /effort.' });
  assert.ok(mod.settingSections(manifest.userConfig).some((s) => s.title === mod.HERE_ROW.group));
  assert.match(mod.settingsText(manifest.userConfig, { effort: 'Extra high' }), /effort Extra high/);
  // The page may change it (the mod makes the change in Claude Code), as lib/settings.js says.
  assert.ok(mod.PAGE_EDITABLE.includes('effort') && require('../lib/settings').PAGE_EDITABLE.includes('effort'));
});

test('help and the /editlens argument hint name effort', () => {
  const help = require('../lib/help');
  assert.ok(help.GROUPS[0][1].some(([cmd]) => cmd === '/editlens effort'));
  assert.match(help.MORE.effort, /low\|medium\|high\|xhigh\|max/);
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'mod.mjs'), 'utf8').includes('| task-user | effort [level] | settings |'));
});

// --- /editlens effort against a stand-in server -------------------------------------------------

function server(answers) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, token: req.headers['x-editlens-token'], body: body ? JSON.parse(body) : null });
      const [status, out] = answers(req.method + ' ' + req.url.split('?')[0], body ? JSON.parse(body) : null);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  return new Promise((r) => srv.listen(PORT, '127.0.0.1', () => r({ srv, seen })));
}
function run(args) {
  const env = { ...process.env, EDITLENS_PORT: String(PORT), EDITLENS_STATE_DIR: stateDir, EDITLENS_NO_START: '1', CLAUDE_PROJECT_DIR: base, EDITLENS_SESSION_ID: 's-term' };
  delete env.EDITLENS_SAY;
  return new Promise((resolve) => execFile(process.execPath, [path.join(__dirname, '..', 'bin', 'start.js'), 'effort', ...args], { env, encoding: 'utf8' },
    (err, stdout) => resolve({ out: stdout, code: err ? err.code : 0 })));
}
const shape = (level, extra) => ({ level, used: level, supported: true, cap: null, source: 'page', ...extra });

test('/editlens effort: page control now, new tasks, this terminal (dim, read only), each task, then how to change', async () => {
  const { srv, seen } = await server(() => [200, { setting: 'high', page: shape('xhigh'), here: shape('medium', { source: 'terminal' }),
    tasks: [{ task: 'aaaaaaaaaaaa', computer: 'laptop-1', where: 'there', state: 'working', effort: shape('low') }] }]);
  try {
    const { out, code } = await run([]);
    assert.strictEqual(code, 0, out);
    const lines = out.trimEnd().split('\n');
    assert.strictEqual(lines[0], '✦ Effort');
    // What runs now and what new tasks use (D25 B: "New tasks use the Effort setting").
    assert.match(out, /^Page control now ·+ Extra high · this session$/m);
    assert.match(out, /^New tasks ·+ High$/m);
    assert.match(out, /^This terminal ·+ Medium · set in Claude Code$/m);
    assert.match(out, /^◆ laptop-1 task ·+ Low$/m);
    assert.match(out, /^Change ·+ \/editlens effort auto\|low\|medium\|high\|xhigh\|max$/m);
    assert.match(out, /^Here ·+ \/effort$/m);
    // Every value in one column.
    const at = lines.slice(2).map((l) => l.search(/(?<=· )\S/));
    assert.strictEqual(new Set(at).size, 1, out);
    assert.ok(seen[0].url.includes('session=s-term') && seen[0].token === 'tok', JSON.stringify(seen[0]));
  } finally {
    srv.close();
  }
});

test('/editlens effort <level>: Max for this session only; clamped says the limit; a bad level is refused here', async () => {
  let page = shape('max');
  // Max is never saved (D24): the server says saved: false, and nothing says how to keep it.
  const { srv, seen } = await server((route, body) => (route === 'POST /effort' ? [200, { ok: true, level: body.level, page, saved: body.level !== 'max' }] : [404, {}]));
  try {
    let r = await run(['max']);
    assert.strictEqual(r.out.trim(), '✦ ✓ Page control effort: Max  · this session only');
    assert.deepStrictEqual(seen.pop().body, { level: 'max', cwd: base });
    page = shape('max', { used: 'high', cap: 'high' });
    r = await run(['MAX']);
    assert.strictEqual(r.out.trim(), '✦ ! Effort set to High, the highest your organization allows.');
    page = null;
    r = await run(['Extra', 'high']);
    assert.strictEqual(r.out.trim(), '✦ ✓ Effort: Extra high  · for page control and tasks it starts');
    assert.strictEqual(seen.pop().body.level, 'xhigh', 'labels are read too');
    const before = seen.length;
    r = await run(['turbo']);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /^✕ "turbo" isn't an effort level: Effort must be one of: low, medium, high, xhigh, max\.\n! Fix {2}› \/editlens effort high$/m);
    assert.strictEqual(seen.length, before, 'nothing sent');
  } finally {
    srv.close();
  }
});

test('/editlens effort <level> without the mod and without page control: nothing changed, and where to change it', async () => {
  const { srv } = await server(() => [200, { ok: true, level: 'low', page: null, saved: false }]);
  try {
    const r = await run(['low']);
    assert.match(r.out, /^✦ ! Nothing changed {2}· page control isn't running here\n! Fix {2}Open › \/config \(search "editlens"\) and change Effort$/m);
  } finally {
    srv.close();
  }
});

test('/editlens effort max without page control: nothing changed, Max is for a running session only (D24)', async () => {
  const { srv } = await server(() => [200, { ok: true, level: 'max', page: null, saved: false }]);
  try {
    const r = await run(['max']);
    assert.strictEqual(r.out.trim(), "✦ ! Nothing changed  · Max is only for a running page control session, and none runs here\n"
      + '! Fix  › /editlens control turns it on; then /editlens effort max');
  } finally {
    srv.close();
  }
});

test('/editlens effort <level> refused by page control: the server\'s words, and a fix', async () => {
  const { srv } = await server(() => [409, { error: 'Claude is not running here.' }]);
  try {
    const r = await run(['low']);
    assert.strictEqual(r.code, 1);
    assert.match(r.out, /^✕ Couldn't change the effort: Claude is not running here\.\n! Fix {2}› \/editlens effort shows what is set now$/m);
  } finally {
    srv.close();
  }
});

test('/editlens effort with Auto: shown as Auto and the level Claude Code gives; "auto" sets it', async () => {
  let answer = { setting: 'medium', auto: true, page: null, here: null, tasks: [] };
  const { srv, seen } = await server((route, body) => (route === 'POST /effort' ? [200, { ok: true, level: null, auto: true, page: shape('medium'), saved: true }] : [200, answer]));
  try {
    let r = await run([]);
    assert.match(r.out, /^Page control now ·+ not running here$/m, r.out);
    assert.match(r.out, /^New tasks ·+ Auto · Medium {2,}follows \/effort$/m, r.out);
    answer = { ...answer, setting: null };
    r = await run([]);
    assert.match(r.out, /^New tasks ·+ Auto · Claude Code's level {2,}follows \/effort$/m, r.out);
    r = await run(['Auto']);
    assert.strictEqual(r.out.trim(), '✦ ✓ Effort: Auto  · the level set in Claude Code (/effort) · page control Medium now');
    assert.deepStrictEqual(seen.pop().body, { level: 'auto', cwd: base });
  } finally {
    srv.close();
  }
});

test('/editlens effort: "· this session" only when page control runs at another level than the setting', async () => {
  let answer = { setting: 'high', page: shape('high'), here: null, tasks: [] };
  const { srv } = await server(() => [200, answer]);
  try {
    let r = await run([]);
    assert.match(r.out, /^Page control now ·+ High$/m, r.out);
    assert.match(r.out, /^New tasks ·+ High$/m, r.out);
    answer = { ...answer, setting: 'medium', auto: true, page: shape('medium') };
    r = await run([]);
    assert.match(r.out, /^Page control now ·+ Medium$/m, r.out);
    assert.match(r.out, /^New tasks ·+ Auto · Medium {2,}follows \/effort$/m, r.out);
    // Auto with no level set in Claude Code: a level page control runs at was set for this session.
    answer = { ...answer, setting: null };
    r = await run([]);
    assert.match(r.out, /^Page control now ·+ Medium · this session$/m, r.out);
    // The level Claude Code picked by itself (no one set one): said so, not "· this session" (F3).
    answer = { ...answer, page: shape('high', { fromClaude: true }) };
    r = await run([]);
    assert.match(r.out, /^Page control now ·+ High · Claude Code's level$/m, r.out);
    // Running with no level of its own: Claude Code picks it, so it is not "not running".
    answer = { ...answer, page: null, pageRunning: true };
    r = await run([]);
    assert.match(r.out, /^Page control now ·+ Claude Code's level$/m, r.out);
    answer = { ...answer, page: shape('medium'), pageRunning: true };
    // Max is never saved (D24), so it lasts for this session only.
    answer = { ...answer, page: shape('max') };
    r = await run([]);
    assert.match(r.out, /^Page control now ·+ Max · this session only$/m, r.out);
    // Lower than the setting because of the organization's limit: that is said instead.
    answer = { setting: 'xhigh', page: shape('xhigh', { used: 'high', cap: 'high' }), here: null, tasks: [] };
    r = await run([]);
    assert.match(r.out, /^Page control now ·+ High {2,}your organization allows up to High$/m, r.out);
    assert.match(r.out, /^New tasks ·+ Extra high$/m, r.out);
    // X2: a change Claude Code hasn't saved yet: the level asked for, and that it waits.
    answer = { setting: 'low', asked: { setting: 'high', auto: false }, page: shape('high'), here: null, tasks: [] };
    r = await run([]);
    assert.match(r.out, /^Page control now ·+ High$/m, r.out);
    assert.match(r.out, /^New tasks ·+ High {2,}waiting for Claude Code to confirm it$/m, r.out);
  } finally {
    srv.close();
  }
});
