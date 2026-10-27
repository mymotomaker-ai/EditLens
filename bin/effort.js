#!/usr/bin/env node
'use strict';
// /editlens effort [level]: Claude's effort level.
//   node bin/effort.js          show it for page control now, new tasks, this terminal (read only) and tasks
//   node bin/effort.js <level>  set the Effort setting, and page control now when it runs here
//   node bin/effort.js max      page control now only: Max is never saved (D24)
//   node bin/effort.js auto     the Effort setting follows Claude Code's own level (/effort)
// This terminal's level is set by Claude Code's /effort; EditLens only reads it.
const { getJson, postJson } = require('../lib/client');
const { plainError } = require('../lib/plainerr');
const { say } = require('../lib/say');
const effort = require('../lib/effort');

const CHOICES = '/editlens effort auto|low|medium|high|xhigh|max';

// "High", "Max · this session only", "Effort not used" for one effort shape (lib/effort.js).
function shown(e) {
  if (!e || !e.level) return '';
  if (e.supported === false) return 'Effort not used';
  const used = e.used || e.level;
  return effort.label(used) + (used === 'max' ? ' · this session only' : '');
}

// Page control's level now: "· this session" when it isn't the Effort setting's level (a level set
// for this session only), not when the organization's limit lowered it (the note says that limit).
// Auto: "· Claude Code's level" for the level Claude Code picked by itself (fromClaude).
function nowRow(page, setting, running) {
  if (!page || !page.level) return ['Page control now', running ? 'Claude Code\'s level' : 'not running here', '', { dim: true }];
  const used = page.used || page.level;
  const other = page.supported !== false && used === page.level && used !== 'max' && used !== setting;
  const note = page.fromClaude ? (page.supported !== false ? ' · Claude Code\'s level' : '') : other ? ' · this session' : '';
  return ['Page control now', shown(page) + note, page.cap ? `your organization allows up to ${effort.label(page.cap)}` : ''];
}

async function show(cwd, session) {
  const s = await getJson(`/effort?cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(session)}`);
  say.head(null, '', '', 'Effort');
  say.blank();
  // What runs now, and what new tasks use: the Effort setting (as the page's effort menu says).
  // A change the mod has not reported as saved yet (X2): the level asked for.
  const want = s.asked && typeof s.asked === 'object' ? s.asked : s;
  const setting = want.auto ? `Auto · ${effort.label(want.setting) || 'Claude Code\'s level'}` : effort.label(want.setting) || 'High';
  const note = want !== s ? 'waiting for Claude Code to confirm it' : want.auto ? 'follows /effort' : '';
  const rows = [nowRow(s.page, want.setting, s.pageRunning === true), ['New tasks', setting, note]];
  rows.push(['This terminal', s.here ? shown(s.here) + ' · set in Claude Code' : 'not reported yet', '', { dim: true }]);
  for (const t of Array.isArray(s.tasks) ? s.tasks : []) {
    if (t && t.effort && t.effort.level) rows.push([`◆ ${String(t.computer || 'paired')} task`, shown(t.effort)]);
  }
  rows.push(['Change', CHOICES, '', { cmd: true }]);
  rows.push(['Here', '/effort', '', { cmd: true }]);
  say.fields(rows);
}

async function set(raw, cwd) {
  if (String(raw).trim().toLowerCase() === 'auto') return setAuto(cwd);
  const level = effort.parse(raw);
  if (!level) {
    say.fail(`"${String(raw).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 30)}" isn't an effort level`, effort.BAD_LEVEL);
    say.fix('/editlens effort high');
    process.exitCode = 1;
    return;
  }
  const out = await postJson('/effort', { level, cwd }, { timeoutMs: 8000 });
  const page = out && out.page;
  if (!page && level === 'max') {
    say.head('warn', 'Nothing changed', 'Max is only for a running page control session, and none runs here', '');
    say.fix('/editlens control', 'turns it on; then /editlens effort max');
    return;
  }
  if (!page && !out.saved) {
    // Page control isn't running here, and without the EditLens mod the setting can't be saved.
    say.head('warn', 'Nothing changed', 'page control isn\'t running here', '');
    say.fix('/config', '(search "editlens") and change Effort', 'Open');
    return;
  }
  if (page && page.cap && page.used && effort.rank(page.used) < effort.rank(level)) {
    say.head('warn', `Effort set to ${effort.label(page.used)}, the highest your organization allows.`, '', '');
  } else if (page && page.supported === false) {
    say.head('ok', `Page control effort: ${effort.label(level)}`, 'this model doesn\'t use effort', '');
  } else {
    const notes = [page ? '' : 'for page control and tasks it starts', level === 'max' ? 'this session only' : page ? 'from Claude\'s next step' : ''];
    say.head('ok', `${page ? 'Page control effort' : 'Effort'}: ${effort.label(level)}`, notes.filter(Boolean).join(' · '), '');
  }
  // Without the EditLens mod the setting can't be saved from here. Max is never saved.
  if (!out.saved && level !== 'max') say.steps('To keep it for new sessions, set Effort in /config (search "editlens")', []);
}

// Auto: page control and new tasks use the level set in Claude Code (/effort).
async function setAuto(cwd) {
  const out = await postJson('/effort', { level: 'auto', cwd }, { timeoutMs: 8000 });
  if (!out.saved) {
    say.head('warn', 'Nothing changed', 'the setting can be saved only with the EditLens mod', '');
    say.fix('/config', '(search "editlens") and set Effort to Auto', 'Open');
    return;
  }
  const now = out.page && out.page.level ? ` · page control ${effort.label(out.page.used || out.page.level)} now` : '';
  say.head('ok', 'Effort: Auto', `the level set in Claude Code (/effort)${now}`, '');
}

(async () => {
  const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const args = process.argv.slice(2);
  if (args.length) return set(args.join(' '), cwd);
  return show(cwd, process.env.EDITLENS_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || '');
})().catch((err) => {
  if (!(err instanceof Error)) throw err;
  // The server's message (a refused level, page control not running) follows its status code.
  const m = /^server answered (?:400|409): (.*)$/s.exec(err.message);
  let said = null;
  if (m) {
    try {
      said = JSON.parse(m[1]).error || null;
    } catch (parseErr) {
      if (!(parseErr instanceof SyntaxError)) throw parseErr;
    }
  }
  say.fail(process.argv.length > 2 ? 'Couldn\'t change the effort' : 'Couldn\'t read the effort', typeof said === 'string' ? said : plainError(err));
  if (said) say.fix('/editlens effort', 'shows what is set now');
  else say.fix('/editlens', 'starts EditLens, then try again');
  process.exitCode = 1;
});
